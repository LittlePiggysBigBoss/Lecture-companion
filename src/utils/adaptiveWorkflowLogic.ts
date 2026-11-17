import type {
  BatchExecutionState,
  ConsolidatedRequirementItem,
  ConsolidatedRequirementState,
  DepthPreset,
  DocMode,
  ExpandedPlan,
  GeneratedVolumeArtifact,
  OutputVolumeSpec,
  PipelineJob,
  RequirementCategory,
  ScannedLinkResult,
  SupplementalDirective,
  TaskBatchSpec,
  VolumeRole,
  VolumeSplitMode,
} from '../types';
import {
  extractAcademicHeadingAndSymbolLedger,
  windowLongMarkdownContext,
} from './linkAndMemoryLogic';
import { countAcademicMetrics, normalizePdfFileName } from './pipelineLogic';

/**
 * Single-call coherent academic output target (in Chinese chars / English words)
 * calibrated to push Gemini 4 Carbon's single-call output limit efficiently without
 * tiny fragmented calls, while letting total round count scale freely (1..N rounds).
 */
export const SINGLE_CALL_TARGET_WORDS_BY_DEPTH: Record<DepthPreset, number> = {
  standard: 8500,
  comprehensive: 11500,
  exhaustive: 14000,
};

export interface MultiVolumeIntentDetection {
  shouldSplitVolumes: boolean;
  splitPattern:
    | 'none'
    | 'content_and_solutions'
    | 'by_chapter_modules'
    | 'explicit_volumes';
  detectedModules: string[];
  hasSeparateSolutions: boolean;
  reasonSummary: string;
}

const SEPARATE_SOLUTIONS_REGEX =
  /(?:答案|解析|题解|解答|参考答案|评分标准)[^。\n；;，,]{0,16}(?:另外一份|另一份|单独一份|单独成册|独立文件|独立一册|分册|分开|分离|单独输出|另附文件)|(?:separate\s+(?:file|pdf|volume|booklet)\s+for\s+(?:answers?|solutions?)|(?:answers?|solutions?)\s+in\s+a?\s*separate\s+(?:file|pdf|volume))/i;

const CHAPTER_MODULE_SPLIT_REGEX =
  /(?:按章节|分章节|按模块|分模块|按专题|分专题|每个章节|每一章|各章节)[^。\n；;]{0,18}(?:拆分|分册|分别生成|独立文件|单独一份|多份文件|各自生成)|拆分成([^。\n；;]{2,60}?)(?:等?(?:几个|多份|独立)?(?:章节|部分|模块|分册|文件|讲义|PDF))?/i;

const EXPLICIT_MULTI_VOLUME_REGEX =
  /(?:分册输出|分卷输出|多份独立文件|输出多份文件|拆成多份|(?:拆分?[为成]|分为|分成)\s*[两二三四五六七八九十2-9]\s*(?:份|册|卷)|分[上中下二三四五六1-9一二三四五]册|上册.{0,12}下册|第一册.{0,16}第二册|multi-?volume|multiple\s+independent\s+(?:files|pdfs))/i;

const SINGLE_FILE_OVERRIDE_REGEX =
  /(?:合并为一份|合成一份文件|不要分册|取消分册|单文件输出|合编为一册|single\s+pdf\s+only)/i;

function parseModuleListFromClause(rawClause: string): string[] {
  if (!rawClause) return [];
  // Stop cleanly before trailing quantifiers ("两份独立分册...") or conjunction clauses ("，并且..." / "，同时...")
  const truncated = rawClause
    .split(
      /(?:[，,；;]\s*(?:并且|同时|而且|另外|此外|所有|全部|要求|不要|且|并)|[两二三四五六七八九十\d]+\s*(?:份|册|卷|个)(?:独立|单独)?(?:分册|文件|讲义|题册|PDF)?|(?:独立|单独|多份|分别|各自)(?:分册|文件|输出|生成))/i
    )[0]
    .replace(/(?:讲义|练习题册|题册|分册|独立文件|文件|章节|模块|部分|内容|输出|制作|升级)$/g, '')
    .trim();

  if (!truncated) return [];

  // Prefer explicit list delimiters (、 ， , /) so compound titles like "数学基础与运动学、牛顿动力学与守恒律" keep their internal "与" intact!
  const hasPrimaryListDelim = /[、，,\/]/.test(truncated);
  const rawParts = hasPrimaryListDelim
    ? truncated.split(/[、，,\/]+/)
    : truncated.split(/[与和及以及]+/);

  const parts = rawParts
    .map((s) =>
      s
        .replace(/^(?:第[一二三四五六七八九十\d]+[章册部分节]\s*)/, '')
        .replace(/(?:章节|模块|分册|部分)$/g, '')
        .trim()
    )
    .filter(
      (s) =>
        s.length >= 2 &&
        s.length <= 28 &&
        !/^(?:两份|三份|四份|多份|独立|文件|讲义|题册)$/.test(s)
    );
  return Array.from(new Set(parts)).slice(0, 12);
}

/**
 * Automatically scans initial user prompt + all live supplemental directives to detect
 * whether the user wants multiple independent output files / volumes (e.g., separate
 * Answer & Solutions PDF, chapter-by-chapter volumes, Vol. I / Vol. II).
 * Latest supplemental directives can dynamically turn multi-volume split ON or OFF!
 */
export function detectMultiVolumeIntent(params: {
  rawPrompt: string;
  directives?: SupplementalDirective[];
  explicitMode?: VolumeSplitMode;
}): MultiVolumeIntentDetection {
  const { rawPrompt, directives = [], explicitMode = 'auto' } = params;

  if (explicitMode === 'single_file') {
    return {
      shouldSplitVolumes: false,
      splitPattern: 'none',
      detectedModules: [],
      hasSeparateSolutions: false,
      reasonSummary: '已指定合并为单份完整 PDF 输出',
    };
  }

  const orderedTexts = [
    rawPrompt || '',
    ...directives.map((d) => d.text || '').filter(Boolean),
  ];
  const combinedChronological = orderedTexts.join('\n');

  // Check if a later directive explicitly cancelled multi-volume splitting
  const latestText = orderedTexts[orderedTexts.length - 1] || '';
  if (explicitMode === 'auto' && directives.length > 0 && SINGLE_FILE_OVERRIDE_REGEX.test(latestText)) {
    return {
      shouldSplitVolumes: false,
      splitPattern: 'none',
      detectedModules: [],
      hasSeparateSolutions: false,
      reasonSummary: '已跟进最新补充指令：改为合并输出单份完整 PDF 文件',
    };
  }

  const hasSeparateSolutions = SEPARATE_SOLUTIONS_REGEX.test(combinedChronological);
  const chapterMatch = combinedChronological.match(CHAPTER_MODULE_SPLIT_REGEX);
  const hasExplicitMultiVol = EXPLICIT_MULTI_VOLUME_REGEX.test(combinedChronological);

  let detectedModules: string[] = [];
  const splitClauseMatch = combinedChronological.match(
    /(?:拆分成|拆分为|分为|分成|拆为)\s*([^。.！!\n；;]{4,80})/
  );
  if (splitClauseMatch?.[1]) {
    const candidates = parseModuleListFromClause(splitClauseMatch[1]);
    if (candidates.length >= 2) {
      detectedModules = candidates;
    }
  }
  if (detectedModules.length === 0 && chapterMatch && chapterMatch[1]) {
    detectedModules = parseModuleListFromClause(chapterMatch[1]);
  }

  // Only treat "按章节拆分成..." as multi-file split if user explicitly mentioned 分册/独立文件/分别/多份 OR explicitMode === 'multi_volume' OR >=2 modules with 拆分
  const chapterImpliesSeparateFiles =
    Boolean(chapterMatch) &&
    (detectedModules.length >= 2 ||
      /分册|独立|分别|各自|多份|单独|文件/.test(combinedChronological));

  if (
    explicitMode === 'multi_volume' ||
    hasSeparateSolutions ||
    chapterImpliesSeparateFiles ||
    hasExplicitMultiVol
  ) {
    if (chapterImpliesSeparateFiles && detectedModules.length >= 2) {
      const moduleDesc = detectedModules.slice(0, 5).join('、');
      const extraSol = hasSeparateSolutions ? ' + 独立《答案与详解册》' : '';
      return {
        shouldSplitVolumes: true,
        splitPattern: 'by_chapter_modules',
        detectedModules,
        hasSeparateSolutions,
        reasonSummary: `已自动识别按模块分册需求：将拆分为「${moduleDesc}」${extraSol}共 ${
          detectedModules.length + (hasSeparateSolutions ? 1 : 0)
        } 份独立 PDF 文件输出`,
      };
    }

    if (hasSeparateSolutions) {
      return {
        shouldSplitVolumes: true,
        splitPattern: 'content_and_solutions',
        detectedModules,
        hasSeparateSolutions: true,
        reasonSummary:
          '已自动识别正题与解析分离需求：将独立输出《第1分册：讲义/题本正文》与《第2分册：例题/习题全解与评分标准》2 份独立 PDF',
      };
    }

    return {
      shouldSplitVolumes: true,
      splitPattern: 'explicit_volumes',
      detectedModules,
      hasSeparateSolutions,
      reasonSummary:
        explicitMode === 'multi_volume'
          ? '已开启多份独立分册输出模式：将按知识体系自动拆分为多份独立 PDF 文件'
          : '已自动识别分册输出需求：将按章节体量自动生成多份独立 PDF 文件',
    };
  }

  return {
    shouldSplitVolumes: false,
    splitPattern: 'none',
    detectedModules: [],
    hasSeparateSolutions: false,
    reasonSummary: '默认合编为单份完整 A4 学术 PDF（若需分册可在输入中注明或切换为分册模式）',
  };
}

function classifyClauseCategory(clause: string): RequirementCategory {
  if (
    SEPARATE_SOLUTIONS_REGEX.test(clause) ||
    EXPLICIT_MULTI_VOLUME_REGEX.test(clause) ||
    SINGLE_FILE_OVERRIDE_REGEX.test(clause) ||
    /分册|拆分|独立文件|另外一份/.test(clause)
  ) {
    return 'volume_split';
  }
  if (/更正|修正|改为|改成|不要|取消|替换|删去|避免|切勿|严禁/.test(clause)) {
    return 'correction';
  }
  if (/真题|原创题|压轴|基础题|选择题|计算题|证明题|题量|难度|答案|解析|评分/.test(clause)) {
    return 'problem_design';
  }
  if (/英文|中文|双语|符号|公式|LaTeX|图文|表格|排版|风格|语气/i.test(clause)) {
    return 'style_notation';
  }
  return 'scope';
}

function detectConflictAxis(clause: string): string | null {
  if (/全英文|英文讲义|英文版|用英文|in\s+english/i.test(clause)) return 'lang:en';
  if (/全中文|中文讲义|中文版|改为中文|用中文/.test(clause)) return 'lang:zh';
  if (/双语|中英对照/.test(clause)) return 'lang:bi';
  if (SINGLE_FILE_OVERRIDE_REGEX.test(clause)) return 'split:single';
  if (
    SEPARATE_SOLUTIONS_REGEX.test(clause) ||
    EXPLICIT_MULTI_VOLUME_REGEX.test(clause)
  ) {
    return 'split:multi';
  }
  if (/不要答案|不附答案|不含解析/.test(clause)) return 'ans:none';
  if (/附完整答案|包含答案|详尽解析|分步解答/.test(clause)) return 'ans:full';
  return null;
}

function splitIntoAtomicClauses(rawText: string): string[] {
  const withoutUrls = rawText
    .replace(/https?:\/\/[^\s"'<>`|\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]+/gi, ' ')
    .trim();
  if (!withoutUrls) return [];

  return withoutUrls
    .split(/[\n；;。！!]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 3);
}

/**
 * Consolidates initial prompt + all chronological text/voice/file/link supplements into a
 * single deduplicated, conflict-resolved specification (`ConsolidatedRequirementState`),
 * tracking superseded instructions and dramatically cutting redundant prompt tokens!
 */
export function consolidateRequirementsPure(params: {
  rawUserPrompt: string;
  directives?: SupplementalDirective[];
  scannedLinks?: ScannedLinkResult[];
  volumeSplitMode?: VolumeSplitMode;
  previousVersion?: number;
}): ConsolidatedRequirementState {
  const {
    rawUserPrompt,
    directives = [],
    scannedLinks = [],
    volumeSplitMode = 'auto',
    previousVersion = 0,
  } = params;

  const nowIso = new Date().toISOString();
  const items: ConsolidatedRequirementItem[] = [];
  const changeLog: string[] = [];
  const axisWinnerIdx = new Map<string, number>();
  const normalizedSeen = new Map<string, number>();

  const ingestSource = (text: string, sourceLabel: string, isSupplement: boolean) => {
    const clauses = splitIntoAtomicClauses(text);
    for (const clause of clauses) {
      const fingerprint = clause
        .toLowerCase()
        .replace(/[，,、：:\s]/g, '')
        .slice(0, 60);
      if (!fingerprint) continue;

      // Exact/near-exact deduplication
      if (normalizedSeen.has(fingerprint)) {
        continue;
      }

      const category = classifyClauseCategory(clause);
      const axis = detectConflictAxis(clause);
      const axisPrefix = axis ? axis.split(':')[0] : null;

      const newItem: ConsolidatedRequirementItem = {
        id: `req-${items.length + 1}`,
        category,
        summary: clause.slice(0, 220),
        sourceLabel,
        status: 'active',
      };

      // Resolve conflicts on the same semantic axis (e.g., language changed from EN -> ZH, or single -> multi-volume)
      if (axisPrefix) {
        for (let idx = 0; idx < items.length; idx++) {
          const prev = items[idx];
          if (prev.status !== 'active') continue;
          const prevAxis = detectConflictAxis(prev.summary);
          if (prevAxis && prevAxis.startsWith(`${axisPrefix}:`) && prevAxis !== axis) {
            prev.status = 'superseded';
            prev.supersededBy = `${sourceLabel}：${clause.slice(0, 48)}`;
            changeLog.push(
              `[${sourceLabel}] 覆盖旧规则「${prev.summary.slice(0, 32)}」 -> 新规则「${clause.slice(0, 42)}」`
            );
          }
        }
        axisWinnerIdx.set(axisPrefix, items.length);
      } else if (isSupplement && category === 'correction') {
        changeLog.push(`[${sourceLabel}] 新增修正约束：${clause.slice(0, 64)}`);
      } else if (isSupplement) {
        changeLog.push(`[${sourceLabel}] 动态增补要求：${clause.slice(0, 64)}`);
      }

      normalizedSeen.set(fingerprint, items.length);
      items.push(newItem);
    }
  };

  ingestSource(rawUserPrompt, '初始需求', false);

  directives.forEach((dir, idx) => {
    const label = `第 ${idx + 1} 次${dir.source === 'voice' ? '语音' : '补充'}指令`;
    if (dir.text.trim()) {
      ingestSource(dir.text, label, true);
    }
    if (dir.attachmentsMeta.length > 0) {
      const attSummary = `融合补充参考资料：${dir.attachmentsMeta.map((a) => a.name).join('、')}`;
      items.push({
        id: `req-${items.length + 1}`,
        category: 'scope',
        summary: attSummary,
        sourceLabel: label,
        status: 'active',
      });
      changeLog.push(`[${label}] ${attSummary}`);
    }
  });

  const readyLinks = scannedLinks.filter((l) => l.status === 'ready');
  if (readyLinks.length > 0) {
    items.push({
      id: `req-${items.length + 1}`,
      category: 'scope',
      summary: `结合已自动抓取解析的 ${readyLinks.length} 份链接资料（${readyLinks
        .map((l) => l.title)
        .slice(0, 4)
        .join('、')}）提炼结构与例题`,
      sourceLabel: '链接自动扫描',
      status: 'active',
    });
  }

  const splitIntent = detectMultiVolumeIntent({
    rawPrompt: rawUserPrompt,
    directives,
    explicitMode: volumeSplitMode,
  });

  if (splitIntent.shouldSplitVolumes) {
    const alreadyHasSplitRule = items.some(
      (i) => i.status === 'active' && i.category === 'volume_split'
    );
    if (!alreadyHasSplitRule) {
      items.push({
        id: `req-${items.length + 1}`,
        category: 'volume_split',
        summary: splitIntent.reasonSummary,
        sourceLabel: '分册识别引擎',
        status: 'active',
      });
    }
  }

  const activeItems = items.filter((i) => i.status === 'active');
  const groupedBriefLines: string[] = [];

  const byCat: Array<{ cat: RequirementCategory; title: string }> = [
    { cat: 'scope', title: '核心范围与章节目标' },
    { cat: 'volume_split', title: '分册与多文件独立输出规则' },
    { cat: 'problem_design', title: '例题/习题梯度与解析要求' },
    { cat: 'style_notation', title: '语言、符号与排版体例' },
    { cat: 'correction', title: '最新修正与硬性边界约束' },
  ];

  for (const { cat, title } of byCat) {
    const matching = activeItems.filter((i) => i.category === cat);
    if (matching.length > 0) {
      groupedBriefLines.push(
        `- 【${title}】：${matching.map((m) => m.summary).join('；')}`
      );
    }
  }

  const synthesizedMasterBrief =
    groupedBriefLines.join('\n') ||
    `- 【核心目标】：${rawUserPrompt.trim() || '基于参考附件系统编纂高水准学术文档'}`;

  // Calculate raw verbose prompt footprint (repeated across passes) vs consolidated footprint
  const rawAccumulatedChars =
    rawUserPrompt.length +
    directives.reduce((acc, d) => acc + d.text.length + 140, 0) +
    readyLinks.reduce((acc, l) => acc + (l.extractedPreview?.length || 0) + 120, 0);
  const compressedContextChars = Math.max(120, synthesizedMasterBrief.length);
  const tokenSavingsEstimatePct =
    rawAccumulatedChars > compressedContextChars
      ? Math.min(
          85,
          Math.max(
            18,
            Math.round(((rawAccumulatedChars - compressedContextChars) / rawAccumulatedChars) * 100)
          )
        )
      : directives.length > 0
        ? 25
        : 0;

  return {
    version: previousVersion + 1,
    lastConsolidatedAt: nowIso,
    synthesizedMasterBrief,
    activeRules: items,
    changeLog: changeLog.slice(-16),
    rawAccumulatedChars,
    compressedContextChars,
    tokenSavingsEstimatePct,
  };
}

/**
 * Normalizes Gemini's structured JSON plan into a clean, unbounded adaptive multi-round
 * and multi-volume execution plan (`ExpandedPlan`), ensuring:
 * 1. Zero artificial 1–4 round caps: preserves all needed high-density rounds (1..N).
 * 2. Every volume has a distinct `volumeId`, clean PDF filename, and at least one batch.
 * 3. If `multiVolumeDetection.shouldSplitVolumes` is true (e.g. separate Answer/Solutions file
 *    or chapter-by-chapter files), enforces independent `OutputVolumeSpec` entries even if the
 *    raw JSON omitted `volumes`.
 */
export function normalizeAdaptivePlanAndVolumes(params: {
  rawParsed: Record<string, unknown>;
  mode: DocMode;
  depth: DepthPreset;
  customRootFolder: string;
  rawUserPrompt: string;
  multiVolumeDetection: MultiVolumeIntentDetection;
}): ExpandedPlan {
  const {
    rawParsed,
    mode,
    depth,
    customRootFolder,
    rawUserPrompt,
    multiVolumeDetection,
  } = params;

  const singleCallTargetWords = SINGLE_CALL_TARGET_WORDS_BY_DEPTH[depth];
  const docTitle = String(rawParsed.documentTitle || '深度学术讲义与研究专篇');
  const subtitle = String(rawParsed.subtitle || '基于 Gemini 4 Carbon 自适应极限工作流编纂');
  const subjectCategory = String(rawParsed.subjectCategory || '综合学术研究');
  const courseCode = String(rawParsed.courseCode || 'CARBON-101');
  const suggestedFileName = normalizePdfFileName(
    String(rawParsed.suggestedFileName || `${docTitle}.pdf`),
    mode
  );

  // 1. Parse raw volumes if present
  const rawVolumes = Array.isArray(rawParsed.volumes)
    ? (rawParsed.volumes as Array<Record<string, unknown>>)
    : [];

  let volumes: OutputVolumeSpec[] = rawVolumes
    .filter((v) => v && typeof v === 'object')
    .map((v, idx) => {
      const volIndex = idx + 1;
      const volId = String(v.volumeId || `vol-${volIndex}`);
      const vTitle = String(v.volumeTitle || `${docTitle}（第 ${volIndex} 分册）`);
      const rawRole = String(v.role || '');
      const validRole: VolumeRole =
        rawRole === 'main_lecture' ||
        rawRole === 'workbook' ||
        rawRole === 'solutions_manual' ||
        rawRole === 'chapter_volume' ||
        rawRole === 'supplement_volume'
          ? rawRole
          : mode === 'workbook'
            ? 'workbook'
            : 'main_lecture';

      return {
        volumeId: volId,
        volumeIndex: volIndex,
        volumeTitle: vTitle,
        subtitle: String(v.subtitle || subtitle),
        suggestedFileName: normalizePdfFileName(
          String(v.suggestedFileName || `${docTitle}_第${volIndex}分册_${vTitle}.pdf`),
          validRole === 'workbook' || validRole === 'solutions_manual' ? 'workbook' : mode
        ),
        role: validRole,
        scopeSummary: String(v.scopeSummary || ''),
      };
    });

  // 2. Fallback / enforcement if multiVolumeDetection requires independent files
  if (multiVolumeDetection.shouldSplitVolumes && volumes.length < 2) {
    if (
      multiVolumeDetection.splitPattern === 'by_chapter_modules' &&
      multiVolumeDetection.detectedModules.length >= 2
    ) {
      volumes = multiVolumeDetection.detectedModules.map((modName, idx) => ({
        volumeId: `vol-${idx + 1}`,
        volumeIndex: idx + 1,
        volumeTitle: `${docTitle} · 第 ${idx + 1} 分册：${modName}`,
        subtitle: `${modName}独立专题分册`,
        suggestedFileName: normalizePdfFileName(
          `${courseCode}_第${idx + 1}分册_${modName}.pdf`,
          mode
        ),
        role: 'chapter_volume' as const,
        scopeSummary: `独立成册完整覆盖「${modName}」全部核心理论推导、图示总结与典型例题`,
      }));
      if (multiVolumeDetection.hasSeparateSolutions) {
        const solIdx = volumes.length + 1;
        volumes.push({
          volumeId: `vol-${solIdx}`,
          volumeIndex: solIdx,
          volumeTitle: `${docTitle} · 第 ${solIdx} 分册：全册例题与习题详解答案册`,
          subtitle: '配套独立分步解答与评分标准专册',
          suggestedFileName: normalizePdfFileName(
            `${courseCode}_第${solIdx}分册_答案与解析全册.pdf`,
            'workbook'
          ),
          role: 'solutions_manual',
          scopeSummary: '独立汇总各章节分册所有例题与训练题的完整分步推导、多解对比与评分要点',
        });
      }
    } else if (multiVolumeDetection.hasSeparateSolutions) {
      volumes = [
        {
          volumeId: 'vol-1',
          volumeIndex: 1,
          volumeTitle: `${docTitle} · 第 1 分册：${
            mode === 'workbook' ? '分级精编题本（学生卷）' : '核心理论讲义与精选例题册'
          }`,
          subtitle: '正文与题干分册（不含剧透解析，便于课堂讲授与限时自测）',
          suggestedFileName: normalizePdfFileName(`${docTitle}_第1分册_正文讲义与题本.pdf`, mode),
          role: mode === 'workbook' ? 'workbook' : 'main_lecture',
          scopeSummary: '完整编纂核心知识推导、结构化图表与精选例题/训练题题干（答案独立成册）',
        },
        {
          volumeId: 'vol-2',
          volumeIndex: 2,
          volumeTitle: `${docTitle} · 第 2 分册：例题与习题完整答案解析册`,
          subtitle: '逐题严密分步推导、易错陷阱剖析与评分标准（独立文件）',
          suggestedFileName: normalizePdfFileName(
            `${docTitle}_第2分册_答案与详细解析.pdf`,
            'workbook'
          ),
          role: 'solutions_manual',
          scopeSummary: '严格对应第 1 分册全部例题与习题编号，提供100%无跳步的完整解析与评分细则',
        },
      ];
    } else {
      volumes = [
        {
          volumeId: 'vol-1',
          volumeIndex: 1,
          volumeTitle: `${docTitle}（上册：基础与核心理论篇）`,
          subtitle,
          suggestedFileName: normalizePdfFileName(`${docTitle}_上册.pdf`, mode),
          role: mode === 'workbook' ? 'workbook' : 'main_lecture',
          scopeSummary: '覆盖上半部分基础理论体系、核心定理证明与典型例题',
        },
        {
          volumeId: 'vol-2',
          volumeIndex: 2,
          volumeTitle: `${docTitle}（下册：进阶专题与综合拔高篇）`,
          subtitle,
          suggestedFileName: normalizePdfFileName(`${docTitle}_下册.pdf`, mode),
          role: mode === 'workbook' ? 'workbook' : 'main_lecture',
          scopeSummary: '覆盖下半部分高阶综合专题、跨章节建模与压轴训练解析',
        },
      ];
    }
  }

  if (volumes.length === 0) {
    volumes = [
      {
        volumeId: 'vol-1',
        volumeIndex: 1,
        volumeTitle: docTitle,
        subtitle,
        suggestedFileName,
        role: mode === 'workbook' ? 'workbook' : 'main_lecture',
        scopeSummary: String(rawParsed.expandedPrompt || rawUserPrompt),
      },
    ];
  }

  // Re-index volumeIndex 1..K cleanly
  volumes = volumes.map((v, idx) => ({
    ...v,
    volumeIndex: idx + 1,
    volumeId: v.volumeId || `vol-${idx + 1}`,
  }));
  const volumeById = new Map(volumes.map((v) => [v.volumeId, v]));

  // 3. Parse dynamic unbounded rounds (`batches`)
  const rawBatches = Array.isArray(rawParsed.batches)
    ? (rawParsed.batches as Array<Record<string, unknown>>)
    : [];

  let normalizedBatches: TaskBatchSpec[] =
    rawBatches.length > 0
      ? rawBatches.map((b, idx) => {
          const requestedVolId = b.volumeId ? String(b.volumeId) : '';
          const requestedVolIdx = Number(b.volumeIndex) || 0;
          const matchedVol =
            volumeById.get(requestedVolId) ||
            volumes.find((v) => v.volumeIndex === requestedVolIdx) ||
            volumes[Math.min(volumes.length - 1, Math.floor((idx * volumes.length) / Math.max(1, rawBatches.length)))];

          const targetWords = Math.max(
            3500,
            Number(b.targetWords) || singleCallTargetWords
          );
          const estPages = Math.max(
            4,
            Number(b.estimatedPages) || Math.ceil(targetWords / 800)
          );

          const defaultIncludeAns =
            matchedVol.role === 'solutions_manual'
              ? true
              : multiVolumeDetection.hasSeparateSolutions && matchedVol.volumeIndex === 1
                ? false
                : Boolean(b.includeAnswerKey ?? (mode === 'workbook'));

          return {
            batchIndex: idx + 1,
            title: String(b.title || `第 ${idx + 1} 轮极限生成模块`),
            scopeSummary: String(b.scopeSummary || matchedVol.scopeSummary),
            sections:
              Array.isArray(b.sections) && b.sections.length > 0
                ? b.sections.map(String)
                : [`${matchedVol.volumeTitle} 核心内容展开`],
            estimatedPages: estPages,
            targetWords,
            includeAnswerKey: defaultIncludeAns,
            volumeId: matchedVol.volumeId,
            volumeIndex: matchedVol.volumeIndex,
          };
        })
      : [];

  // Ensure EVERY volume has at least one dedicated round so no independent output file is ever empty!
  for (const vol of volumes) {
    const hasBatchForVol = normalizedBatches.some((b) => b.volumeId === vol.volumeId);
    if (!hasBatchForVol) {
      normalizedBatches.push({
        batchIndex: normalizedBatches.length + 1,
        title: `${vol.volumeTitle} · 满载编纂专轮`,
        scopeSummary:
          vol.scopeSummary ||
          (vol.role === 'solutions_manual'
            ? '逐题完整撰写前序分册全部例题与练习题的严密分步解析、多解对比与评分标准'
            : `完整编纂《${vol.volumeTitle}》核心定义、定理推导与典型例题`),
        sections:
          vol.role === 'solutions_manual'
            ? ['例题全解与推导细节', '分级习题逐题完整解答与评分采分点', '常见易错陷阱总结']
            : ['核心概念与公理定义', '关键定理严密证明与直觉', '典型例题与进阶应用'],
        estimatedPages: Math.ceil(singleCallTargetWords / 800),
        targetWords: singleCallTargetWords,
        includeAnswerKey: vol.role === 'solutions_manual' || mode === 'workbook',
        volumeId: vol.volumeId,
        volumeIndex: vol.volumeIndex,
      });
    }
  }

  // Sort batches by volumeIndex ascending so Volume 1 completes cleanly before Volume 2 (especially vital when Volume 2 is Solutions Manual for Volume 1!)
  normalizedBatches = normalizedBatches
    .sort((a, b) => (a.volumeIndex || 1) - (b.volumeIndex || 1) || a.batchIndex - b.batchIndex)
    .map((b, idx) => ({
      ...b,
      batchIndex: idx + 1,
    }));

  const isMultiVolume = volumes.length > 1;
  const adaptiveStrategyNote =
    String(rawParsed.adaptiveStrategyNote || '').trim() ||
    (isMultiVolume
      ? `自适应拆分为 ${volumes.length} 份独立 PDF 分册，共编排 ${normalizedBatches.length} 轮单次调用满载生成（每轮目标 ~${singleCallTargetWords.toLocaleString()} 字）`
      : `单次调用极限自适应排程：按内容真实体量动态拆分为 ${normalizedBatches.length} 轮满载生成（每轮目标 ~${singleCallTargetWords.toLocaleString()} 字，无固定轮次上限）`);

  return {
    documentTitle: docTitle,
    subtitle,
    subjectCategory,
    courseCode,
    archiveRootFolder: customRootFolder || 'Carbon 学术归档',
    archiveSubjectFolder: subjectCategory,
    suggestedFileName,
    expandedPrompt: String(rawParsed.expandedPrompt || rawUserPrompt),
    pedagogicalGoals: Array.isArray(rawParsed.pedagogicalGoals)
      ? rawParsed.pedagogicalGoals.map(String)
      : [],
    isMultiVolume,
    volumes,
    singleCallTargetWords,
    adaptiveStrategyNote,
    batches: normalizedBatches,
  };
}

/**
 * Purely derives the up-to-date `GeneratedVolumeArtifact[]` array from `plan.volumes`
 * and `batches`, preserving per-volume cloud archive metadata (`driveFileId`, `driveWebViewLink`)
 * when content is unchanged.
 */
export function computeVolumeArtifactsFromBatches(params: {
  plan: ExpandedPlan | null;
  batches: BatchExecutionState[];
  existingVolumes?: GeneratedVolumeArtifact[];
  defaultMode: DocMode;
  jobStage?: PipelineJob['stage'];
}): GeneratedVolumeArtifact[] {
  const { plan, batches, existingVolumes = [], defaultMode, jobStage } = params;
  if (!plan || !plan.volumes || plan.volumes.length === 0) {
    return existingVolumes;
  }

  const prevById = new Map(existingVolumes.map((v) => [v.volumeId, v]));

  return plan.volumes.map((spec, idx) => {
    const volId = spec.volumeId || `vol-${idx + 1}`;
    const prev = prevById.get(volId);

    const matchingBatches = batches.filter((b, bIdx) => {
      const planSpec = plan.batches[bIdx];
      const resolvedVolId = b.volumeId || planSpec?.volumeId || plan.volumes![0].volumeId;
      return resolvedVolId === volId;
    });

    const volMarkdown = matchingBatches
      .map((b) => b.markdownContent.trim())
      .filter(Boolean)
      .join('\n\n');

    const metrics = countAcademicMetrics(volMarkdown);
    const allDone =
      matchingBatches.length > 0 && matchingBatches.every((b) => b.status === 'completed');
    const anyError = matchingBatches.some((b) => b.status === 'error');
    const anyRunning = matchingBatches.some(
      (b) => b.status === 'running' || b.status === 'continuing'
    );

    let status: GeneratedVolumeArtifact['status'] = 'pending';
    if (anyError) {
      status = 'error';
    } else if (anyRunning) {
      status = 'generating';
    } else if (allDone) {
      if (jobStage === 'compiling_pdf' && !prev?.serverPdfReady) {
        status = 'compiling_pdf';
      } else if (jobStage === 'uploading_drive' && !prev?.driveFileId) {
        status = 'uploading_drive';
      } else {
        status = 'completed';
      }
    } else if (volMarkdown.length > 0) {
      status = 'generating';
    }

    const contentChanged = prev ? prev.compiledMarkdown.length !== volMarkdown.length : true;

    return {
      volumeId: volId,
      volumeIndex: spec.volumeIndex || idx + 1,
      volumeTitle: spec.volumeTitle,
      subtitle: spec.subtitle,
      fileName: normalizePdfFileName(
        spec.suggestedFileName || `${spec.volumeTitle}.pdf`,
        spec.role === 'workbook' || spec.role === 'solutions_manual' ? 'workbook' : defaultMode
      ),
      role: spec.role,
      status,
      compiledMarkdown: volMarkdown,
      charCount: metrics.charCount,
      formulaCount: metrics.formulaCount,
      estimatedPages: volMarkdown ? metrics.estimatedPages : 0,
      serverPdfReady: contentChanged && anyRunning ? false : Boolean(prev?.serverPdfReady),
      driveFileId: prev?.driveFileId,
      driveWebViewLink: prev?.driveWebViewLink,
      draftFileId: prev?.draftFileId,
      draftWebViewLink: prev?.draftWebViewLink,
      gcsObjectUri: prev?.gcsObjectUri,
      gcsWebLink: prev?.gcsWebLink,
    };
  });
}

/**
 * Token-Efficient Context Builder for Batch Execution & Intra-Batch Continuations.
 *
 * Key optimizations over naive full-dump prompting:
 * 1. Injects the deduplicated, conflict-resolved `ConsolidatedRequirementState` instead of
 *    repeating raw chronological directive logs on every pass.
 * 2. On Intra-Batch Continuations (`isContinuation = true`), omits heavy cross-job reference
 *    markdown and omits bulk verbatim text of older completed batches — keeping ONLY the
 *    exact global heading/numbering/symbol ledger (~2k chars) + current batch's trailing
 *    16,000 chars + exact 480-char anchor. Cuts continuation input tokens by ~70%+!
 * 3. For Multi-Volume Solutions Manuals (`role === 'solutions_manual'`), prioritizes the
 *    problem/example ledger & text of Volume 1 so every problem number matches 1-to-1!
 */
export function buildTokenEfficientExecutionContext(params: {
  isContinuation: boolean;
  job: Pick<
    PipelineJob,
    | 'id'
    | 'parentJobId'
    | 'sourceContextJobIds'
    | 'enableHistoricalMemory'
    | 'scannedLinks'
    | 'mode'
    | 'rawUserPrompt'
    | 'supplementalDirectives'
    | 'consolidatedRequirements'
  >;
  currentVolume?: OutputVolumeSpec;
  completedEarlierBatchTexts: string[];
  allUserJobs?: PipelineJob[];
}): {
  consolidatedBriefBlock: string;
  memoryContextBlock: string;
} {
  const {
    isContinuation,
    job,
    currentVolume,
    completedEarlierBatchTexts,
    allUserJobs = [],
  } = params;

  const consolidated =
    job.consolidatedRequirements ||
    consolidateRequirementsPure({
      rawUserPrompt: job.rawUserPrompt,
      directives: job.supplementalDirectives,
      scannedLinks: job.scannedLinks,
    });

  const volumeHeader = currentVolume
    ? `\n[当前正在撰写的独立输出分册]: 第 ${currentVolume.volumeIndex} 分册《${currentVolume.volumeTitle}》（文件：${currentVolume.suggestedFileName} · 角色：${currentVolume.role}）\n- 本分册定位：${currentVolume.scopeSummary}`
    : '';

  const consolidatedBriefBlock = `[自动整合后的全局最新执行规范 (v${consolidated.version} · 已自动消解冲突并合并补充要求)]:
${consolidated.synthesizedMasterBrief}${volumeHeader}`;

  const sections: string[] = [];
  const earlierNonEmpty = completedEarlierBatchTexts.filter((t) => t.trim().length > 0);
  const combinedEarlier = earlierNonEmpty.join('\n\n');

  // Always include compact Global Structure + Numbering + LaTeX Symbol Ledger (~1.5k–2.5k chars)
  if (combinedEarlier.length > 0) {
    const ledger = extractAcademicHeadingAndSymbolLedger(combinedEarlier);
    if (isContinuation) {
      // Ultra-lean ledger for intra-batch continuation: zero bulk text duplication!
      sections.push(
        `[前序已完成章节与符号一致性速查账本（供续写对齐编号与记号）]:
- 已完成章节骨架：${ledger.headings.slice(-30).join(' | ') || '见前文'}
- 最近定义/定理/例题/习题编号锚点：${ledger.lastNumberedAnchors.slice(-14).join(' ； ') || '顺延编号'}
- 全局数学物理符号约定：${ledger.symbolHints.join(', ') || '标准 LaTeX 符号'}`
      );
      return {
        consolidatedBriefBlock,
        memoryContextBlock: sections.join('\n\n'),
      };
    }

    // Initial pass of a new round:
    // If writing a separate Solutions Manual volume, provide larger window (75k chars) so every problem statement from Vol. 1 is visible!
    // Otherwise provide compact ledger + trailing 16k chars of immediately preceding round for seamless transition!
    const intraBudget = currentVolume?.role === 'solutions_manual' ? 75_000 : 18_000;
    const windowedIntra =
      currentVolume?.role === 'solutions_manual'
        ? windowLongMarkdownContext(combinedEarlier, intraBudget)
        : combinedEarlier.length <= intraBudget
          ? combinedEarlier
          : `...[前序批次完整骨架与编号已收录于上方总账，以下保留紧邻前文末尾 ${intraBudget.toLocaleString()} 字符以保障推导无缝衔接]...\n\n${combinedEarlier.slice(-intraBudget)}`;

    sections.push(
      `[本任务已完成前序轮次记忆账本（共 ${combinedEarlier.length.toLocaleString()} 字符 · 严禁重复已写章节，严格顺延编号与符号）]:
- 已完成全书标题总账：${ledger.headings.join(' | ')}
- 末尾定理/例题/题目编号锚点：${ledger.lastNumberedAnchors.slice(-16).join(' ； ') || '顺延前文'}
- 已采用核心符号：${ledger.symbolHints.join(', ') || '保持一致'}
--- 前序轮次关键衔接正文开始 ---
${windowedIntra}
--- 前序轮次关键衔接正文结束 ---`
    );
  }

  if (!isContinuation) {
    // Scanned Link compact previews (avoid repeating if already attached via serverFileId multimodal part)
    const textPreviewLinks = (job.scannedLinks || []).filter(
      (l) => l.status === 'ready' && l.extractedPreview && !l.serverFileId
    );
    if (textPreviewLinks.length > 0) {
      sections.push(
        `[链接抓取摘要]:\n${textPreviewLinks
          .map((l, idx) => `${idx + 1}. 《${l.title}》(${l.url}):\n${l.extractedPreview!.slice(0, 3500)}`)
          .join('\n')}`
      );
    }

    // Bound Parent / Reference Jobs (budgeted cleanly to 55,000 chars total to keep token efficiency high while preserving full structure)
    const explicitIds = new Set<string>(
      [job.parentJobId, ...(job.sourceContextJobIds || [])].filter((id): id is string =>
        Boolean(id && id !== job.id)
      )
    );
    const explicitRefJobs = allUserJobs.filter(
      (j) => explicitIds.has(j.id) && j.compiledMarkdown.trim().length > 0
    );
    if (explicitRefJobs.length > 0) {
      const perRefBudget = Math.max(20_000, Math.floor(60_000 / explicitRefJobs.length));
      const refBlocks = explicitRefJobs.map((rj) => {
        const ledger = extractAcademicHeadingAndSymbolLedger(rj.compiledMarkdown);
        return `=== 绑定基准文档《${rj.plan?.documentTitle || rj.rawUserPrompt.slice(0, 40)}》(${rj.charCount.toLocaleString()} 字) ===
- 结构总账：${ledger.headings.join(' | ')}
- 末尾编号：${ledger.lastNumberedAnchors.slice(-10).join(' ； ')}
- 符号体系：${ledger.symbolHints.join(', ')}
--- 基准文档核心窗口开始 ---
${windowLongMarkdownContext(rj.compiledMarkdown, perRefBudget)}
--- 基准文档核心窗口结束 ---`;
      });
      sections.push(`[关联前序基准长上下文]:\n${refBlocks.join('\n\n')}`);
    }

    // Compact Cross-Task Account Style & Preference Ledger (~1.2k chars max)
    if (job.enableHistoricalMemory !== false && allUserJobs.length > 0) {
      const others = allUserJobs
        .filter(
          (j) =>
            j.id !== job.id &&
            !explicitIds.has(j.id) &&
            j.compiledMarkdown.trim().length > 800
        )
        .slice(0, 5);
      if (others.length > 0) {
        const lines = others.map((hj) => {
          const ledger = extractAcademicHeadingAndSymbolLedger(hj.compiledMarkdown);
          return `- 《${hj.plan?.documentTitle || hj.rawUserPrompt.slice(0, 32)}》(${hj.plan?.courseCode || 'ACAD'}): 常用符号 [${ledger.symbolHints.slice(0, 8).join(', ')}] · 偏好摘要：${hj.rawUserPrompt.slice(0, 100)}`;
        });
        sections.push(`[用户历史任务风格与符号偏好记忆]:\n${lines.join('\n')}`);
      }
    }
  }

  return {
    consolidatedBriefBlock,
    memoryContextBlock: sections.join('\n\n'),
  };
}
