import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHeadlessPdfTimeoutMs,
  detectResolvedPageOrientation,
  isRecoverablePipelineError,
  isValidPdfBuffer,
  rewriteKatexCssLocalFonts,
  shouldCompileMergedFullPdfInWorker,
  shouldUseRemoteGoogleFontsInPdf,
} from './pdfServerHelpers';
import {
  normalizeLatexForSafeKatex,
  renderAcademicMarkdown,
  safeRenderKatex,
} from './markdownMathRenderer';

test('rewriteKatexCssLocalFonts rewrites unquoted, single-quoted, and double-quoted font URLs to file://', () => {
  const sampleCss =
    '@font-face{src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url("fonts/KaTeX_Main-Regular.woff") format("woff"),url(\'fonts/KaTeX_Main-Regular.ttf\') format("truetype")}';
  const rewritten = rewriteKatexCssLocalFonts(
    sampleCss,
    '/app/applet/node_modules/katex/dist/fonts/'
  );
  assert.ok(
    rewritten.includes('url(file:///app/applet/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2)')
  );
  assert.ok(
    rewritten.includes('url("file:///app/applet/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff")')
  );
  assert.ok(
    rewritten.includes("url('file:///app/applet/node_modules/katex/dist/fonts/KaTeX_Main-Regular.ttf')")
  );
});

test('computeHeadlessPdfTimeoutMs scales generously above 55s for large 20MB KaTeX documents', () => {
  assert.ok(computeHeadlessPdfTimeoutMs(200 * 1024) >= 120_000);
  const twentyMbTimeout = computeHeadlessPdfTimeoutMs(20 * 1024 * 1024);
  assert.equal(twentyMbTimeout, 300_000);
  assert.equal(computeHeadlessPdfTimeoutMs(100 * 1024 * 1024), 420_000);
});

test('shouldUseRemoteGoogleFontsInPdf disables remote webfont blocking on >180k char docs or offline retry', () => {
  assert.equal(shouldUseRemoteGoogleFontsInPdf(45_000, false), true);
  assert.equal(shouldUseRemoteGoogleFontsInPdf(45_000, true), false);
  assert.equal(shouldUseRemoteGoogleFontsInPdf(250_000, false), false);
});

test('isValidPdfBuffer validates %PDF- magic header and minimum payload size', () => {
  assert.equal(isValidPdfBuffer(null), false);
  assert.equal(isValidPdfBuffer(Buffer.from('%PDF-1.7 short')), false);
  const validBuf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600, 0x20)]);
  assert.equal(isValidPdfBuffer(validBuf), true);
});

test('shouldCompileMergedFullPdfInWorker skips redundant merged PDF when job has multiple volumes', () => {
  assert.equal(shouldCompileMergedFullPdfInWorker(0), true);
  assert.equal(shouldCompileMergedFullPdfInWorker(1), true);
  assert.equal(shouldCompileMergedFullPdfInWorker(2), false);
  assert.equal(shouldCompileMergedFullPdfInWorker(8), false);
});

test('detectResolvedPageOrientation detects landscape PPT-ready PDF prompts and explicit overrides', () => {
  assert.equal(
    detectResolvedPageOrientation({
      explicitOrientation: 'auto',
      rawPrompt: '请把讲义调整成横版pdf可以当成ppt使用的版式，字体大小适合展示呈现',
    }),
    'landscape'
  );
  assert.equal(
    detectResolvedPageOrientation({
      explicitOrientation: 'portrait',
      rawPrompt: '横版PPT讲义',
    }),
    'portrait'
  );
  assert.equal(
    detectResolvedPageOrientation({
      explicitOrientation: 'auto',
      rawPrompt: '普通大学物理力学讲义',
      directivesTexts: ['补充要求：改成横版PDF用于课堂投影'],
    }),
    'landscape'
  );
});

test('isRecoverablePipelineError allows self-healing for transient and KaTeX errors but blocks invalid API key', () => {
  assert.equal(
    isRecoverablePipelineError('执行异常: Font metrics not found for font: Typewriter-Bold.'),
    true
  );
  assert.equal(isRecoverablePipelineError('执行异常: 503 UNAVAILABLE'), true);
  assert.equal(
    isRecoverablePipelineError('Gemini API 密钥权限不足或无效 (403/400) API_KEY_INVALID'),
    false
  );
});

test('safeRenderKatex and renderAcademicMarkdown never throw on nested Typewriter-Bold combinations', () => {
  const tricky = '\\textbf{\\texttt{TypewriterBold}} + \\mathbf{\\mathtt{v_0}} + \\mathtt{\\mathbf{A}}';
  const normalized = normalizeLatexForSafeKatex(tricky);
  assert.equal(normalized.includes('\\textbf{\\texttt'), false);
  assert.equal(normalized.includes('\\mathbf{\\mathtt'), false);

  const html = safeRenderKatex(tricky, true);
  assert.ok(html.includes('katex'));

  const docHtml = renderAcademicMarkdown(
    `# 物理测试\n行内公式 $\\textbf{\\texttt{mode\\_1}}$ 与块公式：\n\n$$\n\\mathbf{\\mathtt{STATE}} = \\texttt{\\textbf{OK}}\n$$`
  );
  assert.ok(docHtml.includes('mode'));
  assert.ok(docHtml.includes('STATE'));
});

test('renderAcademicMarkdown repairs mid-number line wraps inside inline SVG attributes', () => {
  const brokenSvgMd =
    '## 实验示意图\n\n<svg viewBox="0 0 400 200"><line x1="10" y1="20" x2="39\n0" y2="18\n5" stroke="#1e3a8a" /></svg>';
  const html = renderAcademicMarkdown(brokenSvgMd);
  assert.ok(html.includes('x2="390"'));
  assert.ok(html.includes('y2="185"'));
  assert.equal(html.includes('39\n0'), false);
});


