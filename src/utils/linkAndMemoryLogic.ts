import type {
  PipelineJob,
  RecognizedLinkKind,
  ScannedLinkResult,
} from '../types';

export interface RecognizedLinkDescriptor {
  url: string;
  normalizedFetchUrl: string;
  kind: RecognizedLinkKind;
  resourceId?: string;
  displayLabel: string;
}

/**
 * Matches HTTP/HTTPS URLs while cleanly stopping before:
 * - whitespace
 * - quotes / angle brackets / markdown delimiters
 * - CJK characters & full-width punctuation (\u2e80-\u9fff, \u3000-\u303f, \uff00-\uffef)
 *   so inputs like `https://drive.google.com/file/d/1GO5.../view?usp=sharing继续撰写完善讲义`
 *   never swallow the Chinese text glued directly onto the end of a pasted link!
 */
const RAW_URL_PATTERN =
  /https?:\/\/[^\s"'<>`|\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]+/gi;

function stripTrailingAsciiPunctuation(rawUrl: string): string {
  let cleaned = rawUrl.trim();
  // Balance parentheses (e.g., Wikipedia links with parentheses vs Markdown `[label](url)`)
  while (cleaned.length > 0) {
    const last = cleaned[cleaned.length - 1];
    if (last === ')' && (cleaned.match(/\(/g)?.length || 0) < (cleaned.match(/\)/g)?.length || 0)) {
      cleaned = cleaned.slice(0, -1);
      continue;
    }
    if (last === ']' && (cleaned.match(/\[/g)?.length || 0) < (cleaned.match(/\]/g)?.length || 0)) {
      cleaned = cleaned.slice(0, -1);
      continue;
    }
    if (/[.,;:!?'"}\\]/.test(last)) {
      cleaned = cleaned.slice(0, -1);
      continue;
    }
    break;
  }
  return cleaned;
}

export function classifyUrl(cleanUrl: string): RecognizedLinkDescriptor {
  let parsed: URL | null = null;
  try {
    parsed = new URL(cleanUrl);
  } catch {
    return {
      url: cleanUrl,
      normalizedFetchUrl: cleanUrl,
      kind: 'web_page',
      displayLabel: cleanUrl.slice(0, 64),
    };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  // 1. Google Drive Folder: /drive/folders/<ID> or /drive/u/0/folders/<ID>
  if (host === 'drive.google.com') {
    const folderMatch = pathname.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
    if (folderMatch) {
      const folderId = folderMatch[1];
      return {
        url: cleanUrl,
        normalizedFetchUrl: `https://drive.google.com/embeddedfolderview?id=${folderId}#list`,
        kind: 'google_drive_folder',
        resourceId: folderId,
        displayLabel: `Google Drive 云盘文件夹 (${folderId.slice(0, 10)}...)`,
      };
    }

    // Google Drive File: /file/d/<ID>, /open?id=<ID>, /uc?id=<ID>
    const filePathMatch = pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
    const queryId = parsed.searchParams.get('id');
    const fileId = filePathMatch?.[1] || (queryId && /^[a-zA-Z0-9_-]{10,}$/.test(queryId) ? queryId : undefined);
    if (fileId) {
      return {
        url: cleanUrl,
        normalizedFetchUrl: `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
        kind: 'google_drive_file',
        resourceId: fileId,
        displayLabel: `Google Drive 云盘文件 (${fileId.slice(0, 10)}...)`,
      };
    }
  }

  if (host === 'drive.usercontent.google.com') {
    const queryId = parsed.searchParams.get('id');
    if (queryId && /^[a-zA-Z0-9_-]{10,}$/.test(queryId)) {
      return {
        url: cleanUrl,
        normalizedFetchUrl: `https://drive.usercontent.google.com/download?id=${queryId}&export=download&confirm=t`,
        kind: 'google_drive_file',
        resourceId: queryId,
        displayLabel: `Google Drive 直链文件 (${queryId.slice(0, 10)}...)`,
      };
    }
  }

  // 2. Google Docs / Slides / Sheets
  if (host === 'docs.google.com') {
    const docMatch = pathname.match(/\/document\/d\/([a-zA-Z0-9_-]{10,})/);
    if (docMatch) {
      const docId = docMatch[1];
      return {
        url: cleanUrl,
        normalizedFetchUrl: `https://docs.google.com/document/d/${docId}/export?format=pdf`,
        kind: 'google_doc',
        resourceId: docId,
        displayLabel: `Google Docs 在线文档 (${docId.slice(0, 10)}...)`,
      };
    }

    const slideMatch = pathname.match(/\/presentation\/d\/([a-zA-Z0-9_-]{10,})/);
    if (slideMatch) {
      const slideId = slideMatch[1];
      return {
        url: cleanUrl,
        normalizedFetchUrl: `https://docs.google.com/presentation/d/${slideId}/export/pdf`,
        kind: 'google_slides',
        resourceId: slideId,
        displayLabel: `Google Slides 演示课件 (${slideId.slice(0, 10)}...)`,
      };
    }

    const sheetMatch = pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/);
    if (sheetMatch) {
      const sheetId = sheetMatch[1];
      return {
        url: cleanUrl,
        normalizedFetchUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`,
        kind: 'google_sheets',
        resourceId: sheetId,
        displayLabel: `Google Sheets 数据表格 (${sheetId.slice(0, 10)}...)`,
      };
    }
  }

  // 3. arXiv Paper (/abs/<id> or /pdf/<id>)
  if (host === 'arxiv.org' || host.endsWith('.arxiv.org')) {
    const arxivMatch = pathname.match(/\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+\/[0-9]{7})/i);
    if (arxivMatch) {
      const paperId = arxivMatch[1].replace(/\.pdf$/i, '');
      return {
        url: cleanUrl,
        normalizedFetchUrl: `https://arxiv.org/pdf/${paperId}.pdf`,
        kind: 'arxiv_paper',
        resourceId: paperId,
        displayLabel: `arXiv 学术论文 (${paperId})`,
      };
    }
  }

  // 4. GitHub blob URL -> raw URL
  if (host === 'github.com') {
    const ghBlob = pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (ghBlob) {
      const [, owner, repo, rest] = ghBlob;
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
      return {
        url: cleanUrl,
        normalizedFetchUrl: rawUrl,
        kind: 'direct_document',
        displayLabel: `GitHub 仓库文件 (${repo}/${rest.split('/').pop()})`,
      };
    }
  }

  // 5. Direct document / image / LaTeX / Markdown / DOCX / PDF URL
  const lowerPath = pathname.toLowerCase();
  if (/\.(pdf|docx|md|markdown|tex|txt|csv|tsv|json|png|jpe?g|webp)$/.test(lowerPath)) {
    const fileName = decodeURIComponent(pathname.split('/').pop() || 'document');
    return {
      url: cleanUrl,
      normalizedFetchUrl: cleanUrl,
      kind: 'direct_document',
      displayLabel: `直链文档 (${fileName.slice(0, 42)})`,
    };
  }

  return {
    url: cleanUrl,
    normalizedFetchUrl: cleanUrl,
    kind: 'web_page',
    displayLabel: `${host}${pathname === '/' ? '' : pathname.slice(0, 34)}`,
  };
}

/**
 * Extracts and deduplicates all cloud Drive / Docs / arXiv / direct file / web links
 * embedded anywhere inside a user prompt or supplemental directive.
 */
export function extractRecognizedLinks(text: string): RecognizedLinkDescriptor[] {
  if (!text || !text.includes('http')) return [];
  const matches = text.match(RAW_URL_PATTERN) || [];
  const seen = new Set<string>();
  const results: RecognizedLinkDescriptor[] = [];

  for (const raw of matches) {
    const cleaned = stripTrailingAsciiPunctuation(raw);
    if (!cleaned || cleaned.length < 10) continue;
    const classified = classifyUrl(cleaned);
    // Deduplicate by resourceId when Google Drive/Docs/arXiv, otherwise by cleaned URL
    const dedupeKey = classified.resourceId
      ? `${classified.kind}:${classified.resourceId}`
      : classified.normalizedFetchUrl;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push(classified);
  }

  return results;
}

/**
 * Smartly windows ultra-long Markdown (e.g., 300k–700k+ chars) while preserving:
 * 1. Complete structural TOC & theorem/problem numbering ledger across 100% of the text
 * 2. Massive head + middle + tail verbatim Markdown segments so numbering, notation,
 *    and ending derivations remain 100% exact without blowing past API token limits.
 */
export function extractAcademicHeadingAndSymbolLedger(markdown: string): {
  headings: string[];
  lastNumberedAnchors: string[];
  symbolHints: string[];
} {
  if (!markdown.trim()) {
    return { headings: [], lastNumberedAnchors: [], symbolHints: [] };
  }

  const lines = markdown.split('\n');
  const headings: string[] = [];
  const numberedAnchors: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,3}\s+/.test(line)) {
      headings.push(line.slice(0, 120));
    } else if (
      /^(?:\*\*|>\s*\*\*)?(?:定义|定理|引理|推论|命题|例题?|题|Problem|Theorem|Lemma|Definition|Example|Exercise|Chapter|Section)\s*[0-9A-Za-z.-]+/i.test(
        line
      )
    ) {
      numberedAnchors.push(line.replace(/\*\*/g, '').slice(0, 110));
    }
  }

  // Sample distinctive LaTeX macros/symbols used so far (e.g. \mathbf{F}, \mathcal{L}, \hat{H}, \vec{r})
  const macroMatches = markdown.match(/\\(?:mathbf|mathcal|mathbb|hat|vec|tilde|bar|boldsymbol)\{[A-Za-z0-9\\]+\}/g) || [];
  const uniqueMacros = Array.from(new Set(macroMatches)).slice(0, 28);

  return {
    headings: headings.slice(0, 90),
    lastNumberedAnchors: numberedAnchors.slice(-24),
    symbolHints: uniqueMacros,
  };
}

export function windowLongMarkdownContext(markdown: string, maxChars: number): string {
  const clean = markdown.trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  // Keep 35% from beginning (definitions & conventions) + 65% from end (most recent chapters/problems)
  const headBudget = Math.floor(maxChars * 0.35);
  const tailBudget = maxChars - headBudget - 120;
  return `${clean.slice(0, headBudget)}\n\n...[中间部分已纳入上方全书章节与编号总账，此处省略 ${
    clean.length - headBudget - tailBudget
  } 字符以聚焦首尾精确衔接]...\n\n${clean.slice(-tailBudget)}`;
}

/**
 * Builds the comprehensive Strong Historical Memory & Long-Context Understanding prompt block
 * injected into Gemini 4 Carbon during Planning, Batch Execution, Continuation, and Post-Completion Expansion.
 */
export function buildLongContextMemoryPrompt(params: {
  currentJob: Pick<
    PipelineJob,
    | 'id'
    | 'parentJobId'
    | 'sourceContextJobIds'
    | 'enableHistoricalMemory'
    | 'scannedLinks'
    | 'mode'
    | 'rawUserPrompt'
  >;
  completedEarlierBatchTexts?: string[];
  allUserJobs?: PipelineJob[];
  maxReferenceChars?: number;
  maxIntraJobChars?: number;
}): string {
  const sections: string[] = [];
  const maxReferenceChars = params.maxReferenceChars ?? 200_000;
  const maxIntraJobChars = params.maxIntraJobChars ?? 160_000;
  const allJobs = params.allUserJobs || [];

  // 1. Scanned Cloud Drive / Web Link Metadata Ledger
  const readyLinks = (params.currentJob.scannedLinks || []).filter(
    (l: ScannedLinkResult) => l.status === 'ready' || l.extractedPreview
  );
  if (readyLinks.length > 0) {
    const linkLines = readyLinks.map((item, idx) => {
      const sizePart = item.size ? ` · ${(item.size / 1024).toFixed(1)} KB` : '';
      const previewPart = item.extractedPreview
        ? `\n   抓取摘要/正文片段：\n   ${item.extractedPreview.slice(0, 6000)}`
        : '（已作为完整多模态文件挂载至本次请求上下文，请逐页深度扫描识别其中的文字、公式与图表）';
      return `${idx + 1}. [${item.kind}] 《${item.title}》 (${item.url}${sizePart})${previewPart}`;
    });
    sections.push(
      `[输入链接自动识别与云端抓取扫描结果（共 ${readyLinks.length} 项，请深度结合其完整内容编纂）]:\n${linkLines.join('\n')}`
    );
  }

  // 2. Explicit Parent / Bound Long-Context Source Jobs (e.g. Post-Completion Expansion or Companion Workbook)
  const explicitIds = new Set<string>(
    [
      params.currentJob.parentJobId,
      ...(params.currentJob.sourceContextJobIds || []),
    ].filter((id): id is string => Boolean(id && id !== params.currentJob.id))
  );

  const explicitRefJobs = allJobs.filter(
    (j) => explicitIds.has(j.id) && j.compiledMarkdown.trim().length > 0
  );

  if (explicitRefJobs.length > 0) {
    const perJobBudget = Math.max(
      45_000,
      Math.floor(maxReferenceChars / explicitRefJobs.length)
    );
    const refBlocks = explicitRefJobs.map((refJob, idx) => {
      const ledger = extractAcademicHeadingAndSymbolLedger(refJob.compiledMarkdown);
      const windowedMd = windowLongMarkdownContext(refJob.compiledMarkdown, perJobBudget);
      return `=== 强关联前序基准任务 #${idx + 1}: 《${
        refJob.plan?.documentTitle || refJob.rawUserPrompt.slice(0, 48)
      }》 (${refJob.mode === 'workbook' ? '练习题册' : '课程讲义'} · 共 ${refJob.charCount.toLocaleString()} 字) ===
- 学科与课程代码：${refJob.plan?.subjectCategory || '未分类'} / ${refJob.plan?.courseCode || 'CARBON'}
- 原编纂总纲：${refJob.plan?.expandedPrompt || refJob.rawUserPrompt}
- 全文结构目录：${ledger.headings.join(' | ') || '（无显式标题）'}
- 末尾定理/例题/题目编号锚点：${ledger.lastNumberedAnchors.slice(-10).join(' ； ') || '（无）'}
- 核心数学物理符号约定：${ledger.symbolHints.join(', ') || '保持标准学术记号'}
--- 前序基准任务长上下文正文开始 ---
${windowedMd}
--- 前序基准任务长上下文正文结束 ---`;
    });

    sections.push(
      `[长上下文关联基准文档记忆库（最高一致性约束：必须严格继承其符号体系、术语定义、难度标定与章节脉络，继续深入扩展或配套命题，严禁出现符号冲突或低水平重复）]:\n${refBlocks.join('\n\n')}`
    );
  }

  // 3. Cross-Task Account-Level Strong Historical Memory Ledger (other completed/substantial tasks by this user)
  if (params.currentJob.enableHistoricalMemory !== false && allJobs.length > 0) {
    const otherHistoricalJobs = allJobs
      .filter(
        (j) =>
          j.id !== params.currentJob.id &&
          !explicitIds.has(j.id) &&
          j.compiledMarkdown.trim().length > 800
      )
      .slice(0, 8);

    if (otherHistoricalJobs.length > 0) {
      const histSummaries = otherHistoricalJobs.map((hj, idx) => {
        const ledger = extractAcademicHeadingAndSymbolLedger(hj.compiledMarkdown);
        const suppNotes = (hj.supplementalDirectives || [])
          .map((d) => d.text)
          .filter(Boolean)
          .slice(-3)
          .join('；');
        return `${idx + 1}. 《${hj.plan?.documentTitle || hj.rawUserPrompt.slice(0, 42)}》 [${
          hj.mode === 'workbook' ? '练习题册' : '讲义'
        } · ${hj.plan?.courseCode || 'ACAD'} · ${hj.charCount.toLocaleString()} 字]
   - 用户原始偏好与要求：${hj.rawUserPrompt.slice(0, 200)}${suppNotes ? `（历史补充偏好：${suppNotes.slice(0, 160)}）` : ''}
   - 已覆盖章节骨架：${ledger.headings.slice(0, 16).join(' / ') || '综合内容'}
   - 常用符号风格：${ledger.symbolHints.slice(0, 12).join(', ') || '标准 LaTeX 符号'}`;
      });

      sections.push(
        `[用户跨任务强历史记忆档案（用于长期理解用户的教学体系、竞赛考纲偏好、图文排版习惯与符号一致性）]:\n${histSummaries.join('\n')}`
      );
    }
  }

  // 4. Intra-Job Full Long-Context Earlier Batches (replaces shallow 1-line outline!)
  const earlierTexts = (params.completedEarlierBatchTexts || []).filter((t) => t.trim().length > 0);
  if (earlierTexts.length > 0) {
    const combinedEarlier = earlierTexts.join('\n\n');
    const ledger = extractAcademicHeadingAndSymbolLedger(combinedEarlier);
    const windowedEarlier = windowLongMarkdownContext(combinedEarlier, maxIntraJobChars);

    sections.push(
      `[本任务已完成前序批次全量长上下文记忆（共 ${combinedEarlier.length.toLocaleString()} 字符 —— 请严格延续前文章节号、定义/定理/例题/习题编号与数学符号，绝不重复已写推导，实现整本出版物级无缝贯通）]:
- 已完成章节总览：${ledger.headings.join(' | ')}
- 最近定理/例题/题目编号尾部锚点：${ledger.lastNumberedAnchors.slice(-12).join(' ； ') || '按前文顺延'}
- 已采用核心符号：${ledger.symbolHints.join(', ') || '与前文一致'}
--- 前序已完成批次长上下文全文参考开始 ---
${windowedEarlier}
--- 前序已完成批次长上下文全文参考结束 ---`
    );
  }

  return sections.join('\n\n');
}
