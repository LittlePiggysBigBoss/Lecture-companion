import html2canvas from 'html2canvas-pro';
import { jsPDF } from 'jspdf';
import type { ColorPaletteTheme, GeneratedVolumeArtifact, PipelineJob } from '../types';
import { renderAcademicMarkdown } from '../utils/markdownMathRenderer';
import { resolveColorPaletteSpec } from '../utils/modelRegistryAndRouter';
import {
  normalizePdfFileName,
  splitMarkdownIntoSemanticBlocks,
} from '../utils/pipelineLogic';
import { detectResolvedPageOrientation } from '../utils/pdfServerHelpers';

// Exact A4 proportions at 96 DPI: 794px x 1123px (210mm x 297mm) or Landscape 1123px x 794px (297mm x 210mm)
const A4_PORTRAIT_WIDTH_PX = 794;
const A4_PORTRAIT_HEIGHT_PX = 1123;
const PAGE_PAD_X = 56;
const PAGE_PAD_TOP = 50;
const PAGE_PAD_BOTTOM = 54;

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
  colorTheme?: ColorPaletteTheme;
  pageWidthPx: number;
  pageHeightPx: number;
  isLandscape: boolean;
}): { pageEl: HTMLDivElement; bodyEl: HTMLDivElement } {
  const palette = resolveColorPaletteSpec(params.colorTheme);
  const pageEl = document.createElement('div');
  pageEl.style.width = `${params.pageWidthPx}px`;
  pageEl.style.height = `${params.pageHeightPx}px`;
  pageEl.style.boxSizing = 'border-box';
  pageEl.style.backgroundColor = '#ffffff';
  pageEl.style.color = '#0f172a';
  pageEl.style.padding = `${PAGE_PAD_TOP}px ${PAGE_PAD_X}px ${PAGE_PAD_BOTTOM}px ${PAGE_PAD_X}px`;
  pageEl.style.display = 'flex';
  pageEl.style.flexDirection = 'column';
  pageEl.style.justifyContent = 'space-between';
  pageEl.style.fontFamily = '"Plus Jakarta Sans", "Noto Sans SC", sans-serif';
  pageEl.style.fontSize = params.isLandscape ? '15px' : '13.5px';
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
  runningHeader.style.borderBottom = `1px solid ${palette.h1BorderHex}`;
  runningHeader.style.paddingBottom = '8px';
  runningHeader.style.marginBottom = params.isFirstPage ? '18px' : '14px';
  runningHeader.innerHTML = `
    <span style="font-weight: 600; color: ${palette.accentHex};">${escapeHtml(params.courseCode)} · ${escapeHtml(params.modeLabel)}</span>
    <span>${escapeHtml(params.title)}</span>
  `;
  topWrap.appendChild(runningHeader);

  // Academic Title Banner on Page 1
  if (params.isFirstPage) {
    const coverBox = document.createElement('div');
    coverBox.style.padding = '16px 20px';
    coverBox.style.marginBottom = '18px';
    coverBox.style.backgroundColor = palette.coverBgHex;
    coverBox.style.border = `1px solid ${palette.coverBorderHex}`;
    coverBox.style.borderRadius = '8px';
    coverBox.innerHTML = `
      <div style="font-size: 11px; color: ${palette.accentHex}; margin-bottom: 6px; font-weight: 600;">
        ${escapeHtml(params.subjectCategory || '学术专篇')} · ${escapeHtml(params.modeLabel)} · ${escapeHtml(params.dateStr)}
      </div>
      <div style="font-size: ${params.isLandscape ? '24px' : '22px'}; font-weight: 700; color: ${palette.coverTitleHex}; line-height: 1.3; margin-bottom: 6px;">
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
  footer.style.marginTop = '10px';
  footer.innerHTML = `
    <span>Carbon 多模型协同出版工坊</span>
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
 * multi-page A4 PDF binary Blob (Portrait or Landscape PPT-ready) with smart block pagination.
 */
export async function compileAcademicPdfBlob(
  job: PipelineJob,
  onProgress?: (currentPage: number, totalPages: number) => void,
  targetVolume?: GeneratedVolumeArtifact
): Promise<{ blob: Blob; fileName: string; pageCount: number }> {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  const resolvedOrientation = detectResolvedPageOrientation({
    explicitOrientation: job.pageOrientation,
    planOrientation: job.plan?.pageOrientation,
    rawPrompt: job.rawUserPrompt,
    directivesTexts: (job.supplementalDirectives || []).map((d) => d.text),
  });
  const isLandscape = resolvedOrientation === 'landscape';
  const pageWidthPx = isLandscape ? A4_PORTRAIT_HEIGHT_PX : A4_PORTRAIT_WIDTH_PX;
  const pageHeightPx = isLandscape ? A4_PORTRAIT_WIDTH_PX : A4_PORTRAIT_HEIGHT_PX;
  const maxContentHeightPx = pageHeightPx - PAGE_PAD_TOP - PAGE_PAD_BOTTOM;

  const colorTheme = job.colorTheme || job.plan?.colorTheme || 'academic_blue';
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
        : isLandscape
          ? '横版演示讲义 (PPT-Ready)'
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
  const blockHtmlList = blocks.map((b) => renderAcademicMarkdown(b, colorTheme));

  // Offscreen measurement stage matching exact A4 content width
  const stage = document.createElement('div');
  stage.style.position = 'fixed';
  stage.style.left = '-10000px';
  stage.style.top = '0';
  stage.style.width = `${pageWidthPx}px`;
  stage.style.zIndex = '-1';
  stage.style.pointerEvents = 'none';
  stage.style.backgroundColor = '#ffffff';
  document.body.appendChild(stage);

  try {
    const contentWidth = pageWidthPx - PAGE_PAD_X * 2;
    const measureContainer = document.createElement('div');
    measureContainer.className = 'academic-prose';
    measureContainer.style.width = `${contentWidth}px`;
    measureContainer.style.fontSize = isLandscape ? '15px' : '13.5px';
    stage.appendChild(measureContainer);

    const firstPageOverhead = subtitle ? 162 : 136;
    const regularPageOverhead = 52;

    const pagesHtmlGroups: string[][] = [];
    let currentGroup: string[] = [];
    let currentHeight = firstPageOverhead;

    for (const htmlChunk of blockHtmlList) {
      const wrapper = document.createElement('div');
      wrapper.style.marginBottom = '10px';
      wrapper.innerHTML = htmlChunk;
      measureContainer.appendChild(wrapper);
      const h = wrapper.getBoundingClientRect().height + 10;
      measureContainer.removeChild(wrapper);

      if (currentGroup.length > 0 && currentHeight + h > maxContentHeightPx) {
        pagesHtmlGroups.push(currentGroup);
        currentGroup = [htmlChunk];
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
      orientation: resolvedOrientation,
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const totalPages = pagesHtmlGroups.length;
    const mmW = isLandscape ? 297 : 210;
    const mmH = isLandscape ? 210 : 297;

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
        colorTheme,
        pageWidthPx,
        pageHeightPx,
        isLandscape,
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
        width: pageWidthPx,
        height: pageHeightPx,
        windowWidth: pageWidthPx,
        ignoreElements: (el) => el.tagName === 'IFRAME' || el.tagName === 'SCRIPT',
      });

      stage.removeChild(pageEl);

      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      if (idx > 0) {
        pdf.addPage('a4', resolvedOrientation);
      }
      pdf.addImage(imgData, 'JPEG', 0, 0, mmW, mmH, undefined, 'FAST');
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
