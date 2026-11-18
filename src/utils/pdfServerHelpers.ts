/**
 * Pure helper utilities for server-side Headless Chromium A4 PDF compilation.
 * Decoupled for deterministic unit testing and resilient large-document handling.
 */

import type { PageOrientationMode } from '../types.ts';

export function rewriteKatexCssLocalFonts(
  rawKatexCss: string,
  absoluteFontsDir: string
): string {
  if (!rawKatexCss) return '';
  const cleanDir = absoluteFontsDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return rawKatexCss.replace(
    /url\((['"]?)fonts\//g,
    (_match, quote: string) => `url(${quote}file://${cleanDir}/`
  );
}

/**
 * Scales Headless Chromium `--print-to-pdf` timeout dynamically with rendered HTML size.
 * A 20 MB KaTeX HTML document (~250 pages) takes ~66s on CPU-only Chromium; scaling up to
 * 300s–420s prevents premature 55s kills on large textbooks and multi-chapter workbooks.
 */
export function computeHeadlessPdfTimeoutMs(htmlByteLength: number): number {
  const safeBytes = Math.max(0, Number(htmlByteLength) || 0);
  const megabytes = safeBytes / (1024 * 1024);
  const computed = 120_000 + Math.ceil(megabytes * 9_000);
  return Math.min(420_000, Math.max(120_000, computed));
}

/**
 * Determines whether remote Google Fonts (`fonts.googleapis.com`) should be linked in the
 * standalone print HTML. Very large documents (>180k chars) touch thousands of CJK codepoints,
 * triggering 100+ WOFF2 network requests that can stall `file://` print jobs; offline mode
 * skips remote font stylesheets for deterministic local rendering.
 */
export function shouldUseRemoteGoogleFontsInPdf(
  markdownCharLength: number,
  forceOffline = false
): boolean {
  if (forceOffline) return false;
  return markdownCharLength <= 180_000;
}

/**
 * Verifies that a generated PDF buffer has a valid `%PDF-` header and non-trivial payload.
 */
export function isValidPdfBuffer(buf: Buffer | null | undefined): buf is Buffer {
  if (!Buffer.isBuffer(buf) || buf.length < 512) return false;
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Multi-volume jobs (>1 independent volumes) already compile, cache, archive to Google Drive,
 * and download each volume independently. Skipping redundant merged `_full_` compilation in
 * background Phase 3 avoids unnecessary 250+ page combined print jobs.
 */
export function shouldCompileMergedFullPdfInWorker(outputVolumesCount: number): boolean {
  return (Number(outputVolumesCount) || 0) <= 1;
}

const LANDSCAPE_PPT_INTENT_REGEX =
  /(?:横版|横向|宽屏演示|幻灯片版式|当成\s*ppt|做成\s*ppt|作为\s*ppt|ppt\s*版式|ppt\s*演示|ppt\s*使用|16\s*[:：]\s*9\s*(?:版式|pdf|讲义)|landscape\s*(?:pdf|mode|layout|slides?)|slide\s*deck)/i;

const PORTRAIT_OVERRIDE_INTENT_REGEX =
  /(?:改为竖版|改成竖版|恢复竖版|纵向\s*a4|标准竖版|portrait\s*(?:pdf|mode|layout))/i;

/**
 * Resolves whether the output PDF and live preview canvas should use standard A4 Portrait
 * or Presentation-Ready A4 Landscape (`横版 PDF / PPT 演示版式`).
 */
export function detectResolvedPageOrientation(params: {
  explicitOrientation?: PageOrientationMode;
  planOrientation?: PageOrientationMode;
  rawPrompt?: string;
  directivesTexts?: string[];
}): 'portrait' | 'landscape' {
  if (params.explicitOrientation === 'landscape') return 'landscape';
  if (params.explicitOrientation === 'portrait') return 'portrait';

  let resolved: 'portrait' | 'landscape' =
    params.planOrientation === 'landscape' ? 'landscape' : 'portrait';

  const chronologicalTexts = [
    params.rawPrompt || '',
    ...(params.directivesTexts || []),
  ].filter(Boolean);

  for (const text of chronologicalTexts) {
    if (PORTRAIT_OVERRIDE_INTENT_REGEX.test(text)) {
      resolved = 'portrait';
    }
    if (LANDSCAPE_PPT_INTENT_REGEX.test(text)) {
      resolved = 'landscape';
    }
  }

  return resolved;
}

/**
 * Identifies whether a pipeline job failure can be healed automatically by the background
 * autonomous watchdog without requiring manual human intervention.
 * Excludes fatal API key / permission configuration errors.
 */
export function isRecoverablePipelineError(errorMessage?: string | null): boolean {
  const raw = (errorMessage || '').trim();
  if (!raw) return true;
  if (
    raw.includes('PERMISSION_DENIED') ||
    raw.includes('API_KEY_INVALID') ||
    raw.includes('未检测到 GEMINI_API_KEY') ||
    raw.includes('密钥权限不足或无效')
  ) {
    return false;
  }
  return true;
}

