import katex from 'katex';
import { marked } from 'marked';
import type { ColorPaletteTheme } from '../types.ts';
import { resolveColorPaletteSpec } from './modelRegistryAndRouter.ts';
import { BATCH_COMPLETE_MARKER } from './pipelineLogic.ts';

marked.setOptions({
  gfm: true,
  breaks: false,
});

type SemanticCalloutKey = 'theorem' | 'definition' | 'example' | 'warning' | 'summary';

function mapRawTagToCalloutKey(rawTag: string): SemanticCalloutKey {
  const lower = rawTag.toLowerCase();
  if (lower === 'theorem' || lower === 'proof') return 'theorem';
  if (lower === 'definition') return 'definition';
  if (lower === 'example') return 'example';
  if (lower === 'warning') return 'warning';
  return 'summary';
}

function detectBlockquoteCalloutKey(innerHtml: string): SemanticCalloutKey | null {
  const textSample = innerHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);

  if (/^(?:定义|严格定义|公理|概念|Definition|Axiom)\b/i.test(textSample)) {
    return 'definition';
  }
  if (/^(?:定理|引理|命题|推论|定律|Theorem|Lemma|Proposition|Corollary)\b/i.test(textSample)) {
    return 'theorem';
  }
  if (
    /^(?:例题?|算例|分步解析|标准解答|解答|证明要点|评分标准|Example|Solution)\b/i.test(textSample)
  ) {
    return 'example';
  }
  if (/^(?:注意|易错|警示|陷阱|反例|重要提示|Warning|Caution|Note)\b/i.test(textSample)) {
    return 'warning';
  }
  if (/^(?:总结|方法总结|小结|速记|归纳|Summary|Key\s+Takeaway)\b/i.test(textSample)) {
    return 'summary';
  }
  return null;
}

function escapeHtmlAttr(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Normalizes LaTeX font command combinations that trigger non-ParseError exceptions in KaTeX
 * (such as `Error: Font metrics not found for font: Typewriter-Bold.` when nesting `\mathbf` /
 * `\textbf` / `\boldsymbol` with `\mathtt` / `\texttt`).
 */
export function normalizeLatexForSafeKatex(rawLatex: string): string {
  let out = rawLatex;
  // Iteratively flatten nested bold + typewriter / sans-serif combinations (handles 2-level nesting)
  for (let pass = 0; pass < 3; pass++) {
    const prev = out;
    out = out
      .replace(
        /\\(?:mathbf|textbf|boldsymbol|pmb|bm)\s*\{\s*\\(mathtt|texttt)\s*\{([^{}]*)\}\s*\}/g,
        '\\$1{$2}'
      )
      .replace(
        /\\(mathtt|texttt)\s*\{\s*\\(?:mathbf|textbf|boldsymbol|pmb|bm)\s*\{([^{}]*)\}\s*\}/g,
        '\\$1{$2}'
      )
      .replace(
        /\\(?:mathit|textit)\s*\{\s*\\(mathtt|texttt)\s*\{([^{}]*)\}\s*\}/g,
        '\\$1{$2}'
      )
      .replace(
        /\\(mathtt|texttt)\s*\{\s*\\(?:mathit|textit)\s*\{([^{}]*)\}\s*\}/g,
        '\\$1{$2}'
      )
      .replace(/\\bf\s+\\tt\b/g, '\\tt ')
      .replace(/\\tt\s+\\bf\b/g, '\\tt ');
    if (out === prev) break;
  }
  return out;
}

/**
 * Guaranteed non-throwing KaTeX wrapper:
 * KaTeX's `throwOnError: false` only catches `ParseError`, NOT plain internal `Error`s like
 * `Font metrics not found for font: Typewriter-Bold.`. This wrapper pre-normalizes nested font
 * macros, retries with stripped font wrappers if any internal Error escapes, and falls back to
 * clean HTML-escaped math code as a last resort so rendering never crashes.
 */
export function safeRenderKatex(latex: string, displayMode: boolean): string {
  const normalized = normalizeLatexForSafeKatex(latex);
  try {
    return katex.renderToString(normalized, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    try {
      const strippedFonts = normalized.replace(
        /\\(?:mathtt|texttt|mathbf|textbf|mathsf|textsf|boldsymbol|pmb|bm)\s*\{([^{}]*)\}/g,
        '{$1}'
      );
      return katex.renderToString(strippedFonts, {
        displayMode,
        throwOnError: false,
        strict: false,
      });
    } catch {
      const escaped = escapeHtmlAttr(latex);
      return displayMode
        ? `<pre class="katex-fallback-block" style="font-family:'JetBrains Mono',monospace;font-size:13px;padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;overflow-x:auto;">${escaped}</pre>`
        : `<code class="katex-fallback-inline" style="font-family:'JetBrains Mono',monospace;font-size:0.92em;padding:1px 4px;background:#f1f5f9;border-radius:4px;">${escaped}</code>`;
    }
  }
}

/**
 * Protects LaTeX display ($$...$$) and inline ($...$) math expressions prior to Markdown parsing,
 * renders them with crash-proof `safeRenderKatex`, upgrades fenced `:::theorem ... :::` and semantic
 * academic blockquotes into color-filled publication boxes (`填色排版` with full 1px border, never
 * `border-l-4`), and formats embedded Nano Banana `<figure>` diagrams cleanly.
 */
export function renderAcademicMarkdown(
  rawMarkdown: string,
  colorTheme: ColorPaletteTheme = 'academic_blue'
): string {
  const cleaned = rawMarkdown.replaceAll(BATCH_COMPLETE_MARKER, '').trim();
  if (!cleaned) return '';

  const palette = resolveColorPaletteSpec(colorTheme);
  const mathTokens: string[] = [];

  // 1. Protect fenced code blocks first so '$' or ':::' inside code is never treated as LaTeX/callout
  const codeBlocks: string[] = [];
  let working = cleaned.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `@@CODEBLOCK_${idx}@@`;
  });

  // 2. Protect inline code `...`
  const inlineCodes: string[] = [];
  working = working.replace(/`[^`\n]+`/g, (match) => {
    const idx = inlineCodes.length;
    inlineCodes.push(match);
    return `@@INLINECODE_${idx}@@`;
  });

  // 3. Extract fenced semantic color callout blocks `:::theorem [Title]\n...\n:::` so we can render
  //    their inner Markdown + LaTeX recursively into crisp color-filled publication boxes!
  const calloutTokens: string[] = [];
  working = working.replace(
    /^:::(theorem|definition|example|warning|summary|proof|insight|callout)(?:[ \t]+([^\n]*))?\n([\s\S]*?)^:::\s*$/gim,
    (_m, rawType: string, customTitle: string | undefined, innerBody: string) => {
      const key = mapRawTagToCalloutKey(rawType);
      const spec = palette.callouts[key];
      const headerTitle = (customTitle || '').trim() || spec.label;
      const renderedInner = renderAcademicMarkdown(innerBody.trim(), colorTheme);
      const boxHtml = `<div class="academic-callout" style="margin:14px 0;border:1px solid ${spec.border};background-color:${spec.bodyBg};border-radius:8px;overflow:hidden;page-break-inside:avoid;">
  <div class="academic-callout-header" style="padding:7px 14px;background-color:${spec.headerBg};border-bottom:1px solid ${spec.border};color:${spec.titleColor};font-size:12.5px;font-weight:700;letter-spacing:0.01em;">${escapeHtmlAttr(headerTitle)}</div>
  <div class="academic-callout-body" style="padding:11px 15px;">${renderedInner}</div>
</div>`;
      const idx = calloutTokens.length;
      calloutTokens.push(boxHtml);
      return `\n\n@@CALLOUTTOKEN_${idx}@@\n\n`;
    }
  );

  // 4. Render display math $$...$$ and \[...\] via crash-proof safeRenderKatex
  working = working.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_m, expr1, expr2) => {
    const latex = String(expr1 ?? expr2 ?? '').trim();
    const html = safeRenderKatex(latex, true);
    const idx = mathTokens.length;
    mathTokens.push(`<div class="my-3 overflow-x-auto">${html}</div>`);
    return `\n\n@@MATHTOKEN_${idx}@@\n\n`;
  });

  // 5. Render inline math $...$ and \(...\) via crash-proof safeRenderKatex
  working = working.replace(
    /\\\(([\s\S]+?)\\\)|(?<!\$)\$(?!\$)([^\$\n]+?)(?<!\$)\$(?!\$)/g,
    (_m, parenExpr, dollarExpr) => {
      const latex = String(parenExpr ?? dollarExpr ?? '').trim();
      if (!latex) return _m;
      const html = safeRenderKatex(latex, false);
      const idx = mathTokens.length;
      mathTokens.push(html);
      return `@@MATHTOKEN_${idx}@@`;
    }
  );

  // 6. Restore inline code & fenced code blocks before marked.parse
  working = working.replace(/@@INLINECODE_(\d+)@@/g, (_m, idxStr) => {
    return inlineCodes[Number(idxStr)] ?? '';
  });
  working = working.replace(/@@CODEBLOCK_(\d+)@@/g, (_m, idxStr) => {
    return codeBlocks[Number(idxStr)] ?? '';
  });

  // 7. Parse Markdown to HTML
  let parsedHtml = marked.parse(working, { async: false }) as string;

  // 8. Normalize raw LLM-authored <svg>...</svg> diagrams BEFORE restoring KaTeX tokens
  //    - Joins accidental mid-number line wraps inside quoted attributes (e.g. x2="39\n0" -> x2="390")
  //    - Collapses any remaining attribute-internal newlines to spaces
  //    - Skips KaTeX internal <svg width="400em"> radical/accent SVGs
  parsedHtml = parsedHtml.replace(/<svg\b([\s\S]*?)<\/svg>/gi, (fullSvgBlock, innerWithAttrs: string) => {
    const firstTagEnd = innerWithAttrs.indexOf('>');
    if (firstTagEnd === -1) return fullSvgBlock;
    const rootAttrs = innerWithAttrs.slice(0, firstTagEnd);
    if (rootAttrs.includes('400000') || rootAttrs.includes('400em')) {
      return fullSvgBlock;
    }

    const sanitizedSvg = fullSvgBlock.replace(
      /(\s[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*)(["'])([\s\S]*?)\2/g,
      (_attrMatch, prefix: string, quote: string, val: string) => {
        if (!val.includes('\n') && !val.includes('\r')) return _attrMatch;
        const repairedVal = val
          .replace(/(\d)\s*[\r\n]+\s*(\d)/g, '$1$2')
          .replace(/\s*[\r\n]+\s*/g, ' ')
          .trim();
        return `${prefix}${quote}${repairedVal}${quote}`;
      }
    );

    return sanitizedSvg.replace(/^<svg\b([^>]*)>/i, (_openTag, attrs: string) => {
      let cleanedAttrs = attrs
        .replace(/\s+height\s*=\s*["']auto["']/gi, '')
        .replace(/\s+width\s*=\s*["']auto["']/gi, '');
      if (/style\s*=\s*["']/i.test(cleanedAttrs)) {
        cleanedAttrs = cleanedAttrs.replace(
          /style\s*=\s*(["'])([\s\S]*?)\1/i,
          (_sm, quote, styleBody) => `style=${quote}max-width:100%;height:auto;${styleBody}${quote}`
        );
      } else {
        cleanedAttrs += ' style="max-width:100%;height:auto;"';
      }
      return `<svg${cleanedAttrs}>`;
    });
  });

  // 9. Restore KaTeX HTML tokens & semantic callout tokens now so math inside blockquotes is intact
  parsedHtml = parsedHtml.replace(/<p>\s*@@MATHTOKEN_(\d+)@@\s*<\/p>/g, (_m, idxStr) => {
    return mathTokens[Number(idxStr)] ?? '';
  });
  parsedHtml = parsedHtml.replace(/@@MATHTOKEN_(\d+)@@/g, (_m, idxStr) => {
    return mathTokens[Number(idxStr)] ?? '';
  });
  parsedHtml = parsedHtml.replace(/<p>\s*@@CALLOUTTOKEN_(\d+)@@\s*<\/p>/g, (_m, idxStr) => {
    return calloutTokens[Number(idxStr)] ?? '';
  });
  parsedHtml = parsedHtml.replace(/@@CALLOUTTOKEN_(\d+)@@/g, (_m, idxStr) => {
    return calloutTokens[Number(idxStr)] ?? '';
  });

  // 10. Upgrade semantic academic <blockquote> blocks into themed color-filled academic boxes
  parsedHtml = parsedHtml.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (full, inner: string) => {
    const detectedKey = detectBlockquoteCalloutKey(inner);
    if (!detectedKey) return full;
    const spec = palette.callouts[detectedKey];
    return `<div class="academic-callout" style="margin:14px 0;border:1px solid ${spec.border};background-color:${spec.bodyBg};border-radius:8px;overflow:hidden;page-break-inside:avoid;">
  <div class="academic-callout-header" style="padding:6px 14px;background-color:${spec.headerBg};border-bottom:1px solid ${spec.border};color:${spec.titleColor};font-size:12px;font-weight:700;">${escapeHtmlAttr(spec.label)}</div>
  <div class="academic-callout-body" style="padding:11px 15px;">${inner}</div>
</div>`;
  });

  // 11. Color-tint table headers (`<th>`) to match the selected publication theme
  parsedHtml = parsedHtml.replace(
    /<th(\s[^>]*)?>/gi,
    (_m, attrs: string | undefined) =>
      `<th${attrs || ''} style="background-color:${palette.tableHeaderBgHex};color:${palette.tableHeaderTextHex};">`
  );

  // 12. Ensure all rendered <img> figures carry referrerpolicy="no-referrer" and crisp framing
  parsedHtml = parsedHtml.replace(/<img\b([^>]*)>/gi, (_full, attrs: string) => {
    let nextAttrs = attrs;
    if (!/referrerpolicy\s*=/i.test(nextAttrs)) {
      nextAttrs += ' referrerpolicy="no-referrer"';
    }
    if (!/style\s*=/i.test(nextAttrs)) {
      nextAttrs +=
        ' style="max-width:100%;max-height:360px;width:auto;height:auto;display:block;margin:12px auto 6px auto;border-radius:8px;border:1px solid #cbd5e1;background:#ffffff;"';
    }
    return `<img${nextAttrs}>`;
  });

  return parsedHtml;
}
