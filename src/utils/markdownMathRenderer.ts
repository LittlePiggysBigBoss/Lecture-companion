import katex from 'katex';
import { marked } from 'marked';
import { BATCH_COMPLETE_MARKER } from './pipelineLogic.ts';

marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Protects LaTeX display ($$...$$) and inline ($...$) math expressions prior to Markdown parsing,
 * renders them with KaTeX (throwOnError: false), and restores them cleanly into HTML.
 */
export function renderAcademicMarkdown(rawMarkdown: string): string {
  const cleaned = rawMarkdown.replaceAll(BATCH_COMPLETE_MARKER, '').trim();
  if (!cleaned) return '';

  const mathTokens: string[] = [];

  // 1. Protect fenced code blocks first so '$' inside code is never treated as LaTeX
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

  // 3. Render display math $$...$$ and \[...\]
  working = working.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_m, expr1, expr2) => {
    const latex = String(expr1 ?? expr2 ?? '').trim();
    const html = katex.renderToString(latex, {
      displayMode: true,
      throwOnError: false,
      strict: false,
    });
    const idx = mathTokens.length;
    mathTokens.push(`<div class="my-3 overflow-x-auto">${html}</div>`);
    return `\n\n@@MATHTOKEN_${idx}@@\n\n`;
  });

  // 4. Render inline math $...$ and \(...\)
  working = working.replace(
    /\\\(([\s\S]+?)\\\)|(?<!\$)\$(?!\$)([^\$\n]+?)(?<!\$)\$(?!\$)/g,
    (_m, parenExpr, dollarExpr) => {
      const latex = String(parenExpr ?? dollarExpr ?? '').trim();
      if (!latex) return _m;
      const html = katex.renderToString(latex, {
        displayMode: false,
        throwOnError: false,
        strict: false,
      });
      const idx = mathTokens.length;
      mathTokens.push(html);
      return `@@MATHTOKEN_${idx}@@`;
    }
  );

  // 5. Restore inline code & fenced code blocks before marked.parse
  working = working.replace(/@@INLINECODE_(\d+)@@/g, (_m, idxStr) => {
    return inlineCodes[Number(idxStr)] ?? '';
  });
  working = working.replace(/@@CODEBLOCK_(\d+)@@/g, (_m, idxStr) => {
    return codeBlocks[Number(idxStr)] ?? '';
  });

  // 6. Parse Markdown to HTML
  let parsedHtml = marked.parse(working, { async: false }) as string;

  // 7. Restore KaTeX HTML tokens (unwrapping <p> around display math if present)
  parsedHtml = parsedHtml.replace(/<p>\s*@@MATHTOKEN_(\d+)@@\s*<\/p>/g, (_m, idxStr) => {
    return mathTokens[Number(idxStr)] ?? '';
  });
  parsedHtml = parsedHtml.replace(/@@MATHTOKEN_(\d+)@@/g, (_m, idxStr) => {
    return mathTokens[Number(idxStr)] ?? '';
  });

  // 8. Normalize inline <svg> tags where LLM-authored diagrams use invalid XML length attributes like height="auto" / width="auto"
  parsedHtml = parsedHtml.replace(/<svg\b([^>]*)>/gi, (_full, attrs: string) => {
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

  return parsedHtml;
}
