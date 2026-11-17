import type {
  BatchExecutionState,
  DocMode,
  PipelineJob,
  PipelineStage,
  ResumeStrategy,
} from '../types.ts';

export const BATCH_COMPLETE_MARKER = '[[BATCH_COMPLETE]]';

/**
 * Sanitizes a Google Drive folder or file name segment while preserving
 * Chinese/Unicode characters, spaces, letters, numbers, hyphens, and underscores.
 */
export function sanitizeFolderSegment(raw: string, fallback = '未分类学科'): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.slice(0, 60);
}

/**
 * Builds the deterministic 3-level Google Drive archive folder path:
 * Root Folder / Subject Category / Document Type Folder
 */
export function buildDriveArchivePath(params: {
  rootFolder?: string;
  subjectCategory?: string;
  mode: DocMode;
}): {
  root: string;
  subject: string;
  category: string;
  fullPath: string;
} {
  const root = sanitizeFolderSegment(params.rootFolder || 'Carbon 学术归档', 'Carbon 学术归档');
  const subject = sanitizeFolderSegment(params.subjectCategory || '综合课程研究', '综合课程研究');
  const category = params.mode === 'workbook' ? '练习题册 (Workbooks)' : '课程讲义 (Lecture Notes)';
  return {
    root,
    subject,
    category,
    fullPath: `${root} / ${subject} / ${category}`,
  };
}

/**
 * Ensures the downloadable PDF filename ends with .pdf and contains no illegal characters.
 */
export function normalizePdfFileName(rawName: string, mode: DocMode): string {
  const base = sanitizeFolderSegment(
    rawName.replace(/\.pdf$/i, ''),
    mode === 'workbook' ? '精编练习题册' : '深度课程讲义'
  );
  return `${base}.pdf`;
}

/**
 * Determines whether a generated batch needs an automatic zero-intervention continuation call.
 * Triggers continuation when finishReason indicates token limit truncation OR when the model
 * stopped mid-output without emitting the [[BATCH_COMPLETE]] sentinel on a substantial chunk.
 */
export const DEFAULT_MAX_CONTINUATIONS = 12;

export function evaluateBatchContinuation(
  accumulatedRawText: string,
  finishReason?: string,
  continuationCount = 0,
  maxContinuations = DEFAULT_MAX_CONTINUATIONS
): {
  shouldContinue: boolean;
  cleanText: string;
  tailAnchor: string;
} {
  const hasCompleteMarker = accumulatedRawText.includes(BATCH_COMPLETE_MARKER);
  const cleanText = accumulatedRawText
    .replaceAll(BATCH_COMPLETE_MARKER, '')
    .trimEnd();

  if (continuationCount >= maxContinuations) {
    return {
      shouldContinue: false,
      cleanText,
      tailAnchor: '',
    };
  }

  const normalizedReason = (finishReason || '').toUpperCase();
  const hitTokenLimit =
    normalizedReason.includes('MAX_TOKENS') || normalizedReason.includes('LENGTH');

  // Check if an unclosed code fence or display math block remained open at the end
  const codeFenceCount = (cleanText.match(/```/g) || []).length;
  const displayMathCount = (cleanText.match(/\$\$/g) || []).length;
  const hasUnclosedBlock = codeFenceCount % 2 !== 0 || displayMathCount % 2 !== 0;

  const shouldContinue =
    !hasCompleteMarker &&
    cleanText.length > 0 &&
    (hitTokenLimit || hasUnclosedBlock);

  const tailAnchor = cleanText.slice(-360);

  return {
    shouldContinue,
    cleanText,
    tailAnchor,
  };
}

/**
 * Merges a continuation stream chunk onto existing batch markdown,
 * stripping duplicate overlap if the model repeated the trailing anchor line.
 */
export function mergeContinuationMarkdown(existing: string, incomingRaw: string): string {
  const base = existing.replaceAll(BATCH_COMPLETE_MARKER, '').trimEnd();
  let next = incomingRaw.replaceAll(BATCH_COMPLETE_MARKER, '');

  if (!base) return next.trimStart();
  if (!next.trim()) return base;

  const trimmedNext = next.trimStart();
  // Check if the model repeated up to 200 chars of the tail verbatim (supports concise CJK clauses >= 8 chars)
  const maxOverlapCheck = Math.min(200, base.length, trimmedNext.length);
  for (let len = maxOverlapCheck; len >= 8; len--) {
    const suffix = base.slice(base.length - len);
    if (trimmedNext.startsWith(suffix)) {
      next = trimmedNext.slice(len);
      return `${base}${next}`;
    }
  }

  const needsNewline = !base.endsWith('\n') && !next.startsWith('\n');
  return needsNewline ? `${base}\n${next}` : `${base}${next}`;
}

/**
 * Computes accurate overall job completion percentage and summary counters.
 */
export function calculateJobProgress(params: {
  stage: PipelineStage;
  batches: Pick<BatchExecutionState, 'status' | 'continuationCount' | 'markdownContent'>[];
}): {
  percent: number;
  completedBatches: number;
  totalBatches: number;
  activeBatchIndex: number;
  totalContinuations: number;
} {
  const totalBatches = params.batches.length;
  const completedBatches = params.batches.filter((b) => b.status === 'completed').length;
  const runningIdx = params.batches.findIndex(
    (b) => b.status === 'running' || b.status === 'continuing'
  );
  const totalContinuations = params.batches.reduce(
    (sum, b) => sum + (b.continuationCount || 0),
    0
  );

  if (params.stage === 'completed') {
    return {
      percent: 100,
      completedBatches: totalBatches,
      totalBatches,
      activeBatchIndex: -1,
      totalContinuations,
    };
  }

  if (params.stage === 'planning') {
    return {
      percent: 8,
      completedBatches: 0,
      totalBatches,
      activeBatchIndex: -1,
      totalContinuations: 0,
    };
  }

  if (params.stage === 'compiling_pdf') {
    return {
      percent: 90,
      completedBatches,
      totalBatches,
      activeBatchIndex: -1,
      totalContinuations,
    };
  }

  if (params.stage === 'uploading_drive') {
    return {
      percent: 96,
      completedBatches,
      totalBatches,
      activeBatchIndex: -1,
      totalContinuations,
    };
  }

  // Executing batches spans 12% -> 86%
  if (totalBatches === 0) {
    return {
      percent: params.stage === 'executing' ? 15 : 0,
      completedBatches: 0,
      totalBatches: 0,
      activeBatchIndex: -1,
      totalContinuations,
    };
  }

  const activePartial =
    runningIdx >= 0
      ? Math.min(
          0.85,
          0.2 + Math.min(0.65, (params.batches[runningIdx].markdownContent?.length || 0) / 4500)
        )
      : 0;

  const fraction = Math.min(1, (completedBatches + activePartial) / totalBatches);
  const percent = Math.round(12 + fraction * 74);

  return {
    percent,
    completedBatches,
    totalBatches,
    activeBatchIndex: runningIdx,
    totalContinuations,
  };
}

/**
 * Splits academic Markdown into pagination-friendly semantic blocks so that
 * code fences, display math ($$...$$), tables, and headings stay intact across A4 page breaks.
 */
export function splitMarkdownIntoSemanticBlocks(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const rawBlocks: string[] = [];
  let buffer: string[] = [];
  let inCodeFence = false;
  let inMathBlock = false;
  let inTable = false;

  const flush = () => {
    const joined = buffer.join('\n').trim();
    if (joined) {
      rawBlocks.push(joined);
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      buffer.push(line);
      if (!inCodeFence) {
        flush();
      }
      continue;
    }

    if (inCodeFence) {
      buffer.push(line);
      continue;
    }

    if (trimmed === '$$' || (trimmed.startsWith('$$') && !trimmed.slice(2).includes('$$'))) {
      inMathBlock = !inMathBlock;
      buffer.push(line);
      if (!inMathBlock) {
        flush();
      }
      continue;
    }

    if (inMathBlock) {
      buffer.push(line);
      continue;
    }

    const looksLikeTableLine = trimmed.startsWith('|') && trimmed.endsWith('|');
    if (looksLikeTableLine) {
      if (!inTable && buffer.length > 0) {
        flush();
      }
      inTable = true;
      buffer.push(line);
      continue;
    } else if (inTable) {
      inTable = false;
      flush();
    }

    if (trimmed === '') {
      flush();
      continue;
    }

    if (/^#{1,3}\s+/.test(trimmed) && buffer.length > 0) {
      flush();
    }

    buffer.push(line);
  }

  flush();

  // Pair isolated headings with the immediately following block so headings never orphan at page bottom
  const pairedBlocks: string[] = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const current = rawBlocks[i];
    const isSingleLineHeading = /^#{1,3}\s+[^\n]+$/.test(current.trim());
    if (isSingleLineHeading && i + 1 < rawBlocks.length && rawBlocks[i + 1].length < 900) {
      pairedBlocks.push(`${current}\n\n${rawBlocks[i + 1]}`);
      i += 1;
    } else {
      pairedBlocks.push(current);
    }
  }

  return pairedBlocks;
}

/**
 * Calculates character/word volume, math formula count, and realistic A4 page estimate.
 */
export function countAcademicMetrics(markdown: string): {
  charCount: number;
  formulaCount: number;
  sectionCount: number;
  estimatedPages: number;
} {
  const clean = markdown.replaceAll(BATCH_COMPLETE_MARKER, '').trim();
  if (!clean) {
    return { charCount: 0, formulaCount: 0, sectionCount: 0, estimatedPages: 0 };
  }

  const cjkChars = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = (
    clean
      .replace(/[\u4e00-\u9fff]/g, ' ')
      .match(/[A-Za-z0-9_]+/g) || []
  ).length;
  const charCount = cjkChars + latinWords;

  const displayFormulas = (clean.match(/\$\$[\s\S]*?\$\$/g) || []).length;
  const withoutDisplay = clean.replace(/\$\$[\s\S]*?\$\$/g, '');
  const inlineFormulas = (withoutDisplay.match(/\$[^\$\n]+\$/g) || []).length;
  const formulaCount = displayFormulas + inlineFormulas;

  const sectionCount = (clean.match(/^#{1,3}\s+/gm) || []).length;
  const estimatedPages = Math.max(1, Math.ceil((charCount + displayFormulas * 65) / 850));

  return {
    charCount,
    formulaCount,
    sectionCount,
    estimatedPages,
  };
}

export function isJobActiveStage(stage: PipelineStage): boolean {
  return (
    stage === 'planning' ||
    stage === 'executing' ||
    stage === 'compiling_pdf' ||
    stage === 'uploading_drive'
  );
}

export function isJobResumable(job: PipelineJob): boolean {
  if (job.stage === 'error' || job.stage === 'cancelled') {
    return true;
  }
  if (job.stage === 'completed' && job.driveArchive.status === 'error') {
    return true;
  }
  return false;
}

/**
 * Computes the exact checkpoint recovery plan for a failed, cancelled, or interrupted job
 * so completed batches (and optionally partial mid-batch output) are never wasted.
 */
export function computeResumeDescriptor(
  job: PipelineJob,
  strategy: ResumeStrategy,
  targetBatchIndex?: number
): {
  resumePhase: 'planning' | 'executing' | 'archiving';
  startBatchIdx: number;
  continuePartialBatch: boolean;
  updatedBatches: BatchExecutionState[];
  combinedMarkdownBeforeResume: string;
} {
  if (!job.plan || !Array.isArray(job.plan.batches) || job.plan.batches.length === 0) {
    return {
      resumePhase: 'planning',
      startBatchIdx: 0,
      continuePartialBatch: false,
      updatedBatches: [],
      combinedMarkdownBeforeResume: '',
    };
  }

  // Ensure batches array aligns with plan.batches
  const alignedBatches: BatchExecutionState[] = job.plan.batches.map((spec, idx) => {
    const existing = job.batches[idx];
    if (existing) {
      return {
        ...existing,
        batchIndex: spec.batchIndex,
        title: spec.title,
        volumeId: existing.volumeId || spec.volumeId,
        volumeIndex: existing.volumeIndex || spec.volumeIndex,
      };
    }
    return {
      batchIndex: spec.batchIndex,
      title: spec.title,
      volumeId: spec.volumeId,
      volumeIndex: spec.volumeIndex,
      status: 'pending',
      continuationCount: 0,
      markdownContent: '',
    };
  });

  // Explicit single-batch target or automatic first incomplete batch
  const firstIncompleteIdx = alignedBatches.findIndex(
    (b) => b.status !== 'completed' || !b.markdownContent.trim()
  );

  if (targetBatchIndex === undefined && firstIncompleteIdx === -1) {
    const fullMd = alignedBatches
      .map((b) => b.markdownContent.trim())
      .filter(Boolean)
      .join('\n\n');
    return {
      resumePhase: 'archiving',
      startBatchIdx: alignedBatches.length,
      continuePartialBatch: false,
      updatedBatches: alignedBatches,
      combinedMarkdownBeforeResume: fullMd || job.compiledMarkdown,
    };
  }

  const startIdx =
    targetBatchIndex !== undefined
      ? Math.max(0, Math.min(alignedBatches.length - 1, targetBatchIndex))
      : Math.max(0, firstIncompleteIdx);

  const targetBatch = alignedBatches[startIdx];
  const hasPartialText = Boolean(targetBatch?.markdownContent?.trim());
  const continuePartialBatch = strategy === 'continue' && hasPartialText;

  const updatedBatches = alignedBatches.map((b, idx) => {
    if (idx < startIdx && b.status === 'completed' && b.markdownContent.trim()) {
      return b;
    }
    if (idx === startIdx) {
      return {
        ...b,
        status: 'pending' as const,
        markdownContent: continuePartialBatch ? b.markdownContent : '',
        continuationCount: continuePartialBatch ? b.continuationCount : 0,
        errorMessage: undefined,
      };
    }
    // Keep later batches intact ONLY if targetBatchIndex was explicitly chosen and those batches were already completed;
    // otherwise mark later incomplete batches as pending
    if (targetBatchIndex !== undefined && b.status === 'completed' && b.markdownContent.trim()) {
      return b;
    }
    return {
      ...b,
      status: b.status === 'completed' && b.markdownContent.trim() ? ('completed' as const) : ('pending' as const),
      errorMessage: undefined,
    };
  });

  const combinedMarkdownBeforeResume = updatedBatches
    .map((b) => b.markdownContent.trim())
    .filter(Boolean)
    .join('\n\n');

  return {
    resumePhase: 'executing',
    startBatchIdx: startIdx,
    continuePartialBatch,
    updatedBatches,
    combinedMarkdownBeforeResume,
  };
}

/**
 * Reconciles browser localStorage jobs with server-hosted jobs.
 * Any orphaned local-only job stuck in an active stage (from a broken client connection)
 * is safely transitioned to 'error' so the user can immediately Resume or Retry it.
 */
export function reconcileJobsWithServer(
  localJobs: PipelineJob[],
  serverJobs: PipelineJob[],
  activeServerIds: string[] = []
): PipelineJob[] {
  const activeSet = new Set(activeServerIds);
  const serverMap = new Map<string, PipelineJob>();
  for (const sj of serverJobs) {
    serverMap.set(sj.id, sj);
  }

  const mergedMap = new Map<string, PipelineJob>();

  for (const sj of serverJobs) {
    mergedMap.set(sj.id, sj);
  }

  for (const lj of localJobs) {
    const sj = serverMap.get(lj.id);
    if (sj) {
      // Prefer active server job or newer timestamp
      if (activeSet.has(sj.id) || sj.updatedAt >= lj.updatedAt) {
        mergedMap.set(lj.id, sj);
      } else {
        mergedMap.set(lj.id, lj);
      }
    } else {
      // Local-only job: check if it was stranded in an active stage with no server worker
      if (isJobActiveStage(lj.stage)) {
        mergedMap.set(lj.id, {
          ...lj,
          stage: 'error',
          failedStage: lj.stage,
          errorMessage:
            lj.errorMessage ||
            '检测到上次连接中断，已生成的章节均已安全保留。点击「断点继续生成」或「重跑失败步骤」即可在云端后台恢复执行。',
        });
      } else {
        mergedMap.set(lj.id, lj);
      }
    }
  }

  return Array.from(mergedMap.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

