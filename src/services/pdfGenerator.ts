import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import type { GeneratedVolumeArtifact, PipelineJob } from '../types';
import { renderAcademicMarkdown } from '../utils/markdownMathRenderer';
import {
  normalizePdfFileName,
  splitMarkdownIntoSemanticBlocks,
} from '../utils/pipelineLogic';

// Exact A4 proportions at 96 DPI: 794px x 1123px (210mm x 297mm)
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;
const PAGE_PAD_X = 56;
const PAGE_PAD_TOP = 54;
const PAGE_PAD_BOTTOM = 58;
const MAX_CONTENT_HEIGHT_PX = A4_HEIGHT_PX - PAGE_PAD_TOP - PAGE_PAD_BOTTOM;

function createPageShell(params: {
  title: string;
  courseCode: string;
  modeLabel: string;
  pageNumber: number;
  totalPages: number;
  isFirstPage: boolean;
  subtitle?: string;
  subjectCategory?: string;
  dateStr: string;
}): { pageEl: HTMLDivElement; bodyEl: HTMLDivElement } {
  const pageEl = document.createElement('div');
  pageEl.style.width = `${A4_WIDTH_PX}px`;
  pageEl.style.height = `${A4_HEIGHT_PX}px`;
  pageEl.style.boxSizing = 'border-box';
  pageEl.style.backgroundColor = '#ffffff';
  pageEl.style.color = '#0f172a';
  pageEl.style.padding = `${PAGE_PAD_TOP}px ${PAGE_PAD_X}px ${PAGE_PAD_BOTTOM}px ${PAGE_PAD_X}px`;
  pageEl.style.display = 'flex';
  pageEl.style.flexDirection = 'column';
  pageEl.style.justifyContent = 'space-between';
  pageEl.style.fontFamily = '"Plus Jakarta Sans", "Noto Sans SC", sans-serif';
  pageEl.style.position = 'relative';
  pageEl.style.overflow = 'hidden';

  const topWrap = document.createElement('div');
  topWrap.style.flex = '1 1 auto';
  topWrap.style.overflow = 'hidden';

  // Running header
  const runningHeader = document.createElement('div');
  runningHeader.style.display = 'flex';
  runningHeader.style.justifyContent = 'space-between';
  runningHeader.style.alignItems = 'center';
  runningHeader.style.fontSize = '10.5px';
  runningHeader.style.color = '#64748b';
  runningHeader.style.borderBottom = '1px solid #e2e8f0';
  runningHeader.style.paddingBottom = '8px';
  runningHeader.style.marginBottom = params.isFirstPage ? '20px' : '16px';
  runningHeader.innerHTML = `
    <span style="font-weight: 600; color: #334155;">${escapeHtml(params.courseCode)} · ${escapeHtml(params.modeLabel)}</span>
    <span>${escapeHtml(params.title)}</span>
  `;
  topWrap.appendChild(runningHeader);

  // Academic Title Banner on Page 1
  if (params.isFirstPage) {
    const coverBox = document.createElement('div');
    coverBox.style.padding = '18px 20px';
    coverBox.style.marginBottom = '20px';
    coverBox.style.backgroundColor = '#f8fafc';
    coverBox.style.border = '1px solid #cbd5e1';
    coverBox.style.borderRadius = '8px';
    coverBox.innerHTML = `
      <div style="font-size: 11px; color: #475569; margin-bottom: 6px; font-weight: 500;">
        ${escapeHtml(params.subjectCategory || '学术专篇')} · ${escapeHtml(params.modeLabel)} · ${escapeHtml(params.dateStr)}
      </div>
      <div style="font-size: 22px; font-weight: 700; color: #0f172a; line-height: 1.3; margin-bottom: 6px;">
        ${escapeHtml(params.title)}
      </div>
      ${
        params.subtitle
          ? `<div style="font-size: 13px; color: #475569; line-height: 1.5;">${escapeHtml(params.subtitle)}</div>`
          : ''
      }
    `;
    topWrap.appendChild(coverBox);
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'academic-prose';
  topWrap.appendChild(bodyEl);

  // Running footer with tabular page numbers
  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.justifyContent = 'space-between';
  footer.style.alignItems = 'center';
  footer.style.fontSize = '10.5px';
  footer.style.color = '#64748b';
  footer.style.borderTop = '1px solid #e2e8f0';
  footer.style.paddingTop = '8px';
  footer.style.marginTop = '12px';
  footer.innerHTML = `
    <span>Carbon 学术讲义与题册工坊</span>
    <span style="font-family: 'JetBrains Mono', monospace;">Page ${params.pageNumber} / ${params.totalPages}</span>
  `;

  pageEl.appendChild(topWrap);
  pageEl.appendChild(footer);

  return { pageEl, bodyEl };
}

function escapeHtml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Compiles a PipelineJob's academic Markdown + KaTeX equations into a crisp,
 * multi-page A4 PDF binary Blob with smart block pagination (preventing cut-off equations).
 */
export async function compileAcademicPdfBlob(
  job: PipelineJob,
  onProgress?: (currentPage: number, totalPages: number) => void,
  targetVolume?: GeneratedVolumeArtifact
): Promise<{ blob: Blob; fileName: string; pageCount: number }> {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const totalVolumes = job.outputVolumes?.length || job.plan?.volumes?.length || 1;
  const title = targetVolume?.volumeTitle || job.plan?.documentTitle || '学术课程讲义';
  const subtitle = targetVolume?.subtitle || job.plan?.subtitle || '';
  const courseCode = job.plan?.courseCode || 'ACAD-101';
  const subjectCategory = job.plan?.subjectCategory || '综合课程';
  const baseModeLabel =
    targetVolume?.role === 'solutions_manual'
      ? '例题与习题完整解析专册'
      : targetVolume?.role === 'workbook' || job.mode === 'workbook'
        ? '精编练习题册'
        : '深度扩展课程讲义';
  const modeLabel =
    targetVolume && totalVolumes > 1
      ? `第 ${targetVolume.volumeIndex}/${totalVolumes} 分册 · ${baseModeLabel}`
      : baseModeLabel;
  const dateStr = new Date(job.createdAt).toLocaleDateString('zh-CN');
  const fileName = normalizePdfFileName(
    targetVolume?.fileName || job.plan?.suggestedFileName || `${title}.pdf`,
    targetVolume?.role === 'workbook' || targetVolume?.role === 'solutions_manual'
      ? 'workbook'
      : job.mode
  );

  const sourceMarkdown = targetVolume ? targetVolume.compiledMarkdown : job.compiledMarkdown;
  const blocks = splitMarkdownIntoSemanticBlocks(sourceMarkdown);
  const blockHtmlList = blocks.map((b) => renderAcademicMarkdown(b));

  // Offscreen measurement stage matching exact A4 content width
  const stage = document.createElement('div');
  stage.style.position = 'fixed';
  stage.style.left = '-10000px';
  stage.style.top = '0';
  stage.style.width = `${A4_WIDTH_PX}px`;
  stage.style.zIndex = '-1';
  stage.style.pointerEvents = 'none';
  stage.style.backgroundColor = '#ffffff';
  document.body.appendChild(stage);

  try {
    const contentWidth = A4_WIDTH_PX - PAGE_PAD_X * 2;
    const measureContainer = document.createElement('div');
    measureContainer.className = 'academic-prose';
    measureContainer.style.width = `${contentWidth}px`;
    stage.appendChild(measureContainer);

    // Measure first-page header overhead vs subsequent pages
    const firstPageOverhead = subtitle ? 168 : 142;
    const regularPageOverhead = 56;

    const pagesHtmlGroups: string[][] = [];
    let currentGroup: string[] = [];
    let currentHeight = firstPageOverhead;
    let isFirst = true;

    for (const htmlChunk of blockHtmlList) {
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '10px';
      wrapper.innerHTML = htmlChunk;
      measureContainer.appendChild(wrapper);
      const h = wrapper.getBoundingClientRect().height + 10;
      measureContainer.removeChild(wrapper);

      if (currentGroup.length > 0 && currentHeight + h > MAX_CONTENT_HEIGHT_PX) {
        pagesHtmlGroups.push(currentGroup);
        currentGroup = [htmlChunk];
        isFirst = false;
        currentHeight = regularPageOverhead + h;
      } else {
        currentGroup.push(htmlChunk);
        currentHeight += h;
      }
    }

    if (currentGroup.length > 0 || pagesHtmlGroups.length === 0) {
      pagesHtmlGroups.push(currentGroup);
    }

    stage.removeChild(measureContainer);

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const totalPages = pagesHtmlGroups.length;

    for (let idx = 0; idx < totalPages; idx++) {
      onProgress?.(idx + 1, totalPages);

      const { pageEl, bodyEl } = createPageShell({
        title,
        subtitle,
        courseCode,
        subjectCategory,
        modeLabel,
        pageNumber: idx + 1,
        totalPages,
        isFirstPage: idx === 0,
        dateStr,
      });

      bodyEl.innerHTML = pagesHtmlGroups[idx]
        .map((chunk) => `<div style="margin-bottom: 10px;">${chunk}</div>`)
        .join('');

      stage.appendChild(pageEl);

      const canvas = await html2canvas(pageEl, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        logging: false,
        width: A4_WIDTH_PX,
        height: A4_HEIGHT_PX,
        windowWidth: A4_WIDTH_PX,
        ignoreElements: (el) => el.tagName === 'IFRAME' || el.tagName === 'SCRIPT',
      });

      stage.removeChild(pageEl);

      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      if (idx > 0) {
        pdf.addPage('a4', 'portrait');
      }
      pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
    }

    const blob = pdf.output('blob');
    return {
      blob,
      fileName,
      pageCount: totalPages,
    };
  } finally {
    if (stage.parentNode) {
      stage.parentNode.removeChild(stage);
    }
  }
}

export function triggerPdfDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
