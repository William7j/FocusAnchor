import DOMPurify from 'dompurify';
import katex from 'katex';
import mammoth from 'mammoth';
import { marked } from 'marked';
import type { DocumentRecord, FlowBlock } from '../types';

interface MarkdownMathToken {
  source: string;
  latex: string;
  display: boolean;
}

const MATH_TOKEN_PREFIX = '\uE000focus-reader-math-';
const MATH_TOKEN_SUFFIX = '\uE001';

export function assetUrl(assetId: string) {
  return `reader://document/${encodeURIComponent(assetId)}`;
}

function escapeHtml(value: string) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}

function isEscaped(value: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findUnescapedDelimiter(value: string, delimiter: string, from: number) {
  let cursor = value.indexOf(delimiter, from);
  while (cursor >= 0) {
    if (!isEscaped(value, cursor)) return cursor;
    cursor = value.indexOf(delimiter, cursor + delimiter.length);
  }
  return -1;
}

function fencedCodeEnd(value: string, start: number) {
  const lineEnd = value.indexOf('\n', start);
  const openingLine = value.slice(start, lineEnd < 0 ? value.length : lineEnd).replace(/\r$/, '');
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(openingLine);
  if (!opening) return -1;
  const marker = opening[1];
  const closePattern = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
  let cursor = lineEnd < 0 ? value.length : lineEnd + 1;
  while (cursor < value.length) {
    const nextLineEnd = value.indexOf('\n', cursor);
    const line = value.slice(cursor, nextLineEnd < 0 ? value.length : nextLineEnd).replace(/\r$/, '');
    if (closePattern.test(line)) return nextLineEnd < 0 ? value.length : nextLineEnd + 1;
    cursor = nextLineEnd < 0 ? value.length : nextLineEnd + 1;
  }
  return value.length;
}

function inlineCodeEnd(value: string, start: number) {
  const marker = /^`+/.exec(value.slice(start))?.[0] || '`';
  const closing = value.indexOf(marker, start + marker.length);
  return closing < 0 ? start + marker.length : closing + marker.length;
}

function canRenderInlineMath(latex: string) {
  return Boolean(latex.trim()) && !/[\r\n]/.test(latex) && !/^\s|\s$/.test(latex);
}

function mathPlaceholder(index: number) {
  return `${MATH_TOKEN_PREFIX}${index}${MATH_TOKEN_SUFFIX}`;
}

function protectMarkdownMath(markdown: string) {
  const tokens: MarkdownMathToken[] = [];
  let protectedMarkdown = '';
  let cursor = 0;

  const appendToken = (source: string, latex: string, display: boolean) => {
    tokens.push({ source, latex: latex.trim(), display });
    protectedMarkdown += mathPlaceholder(tokens.length - 1);
  };

  while (cursor < markdown.length) {
    if (cursor === 0 || markdown[cursor - 1] === '\n') {
      const fenceEnd = fencedCodeEnd(markdown, cursor);
      if (fenceEnd >= 0) {
        protectedMarkdown += markdown.slice(cursor, fenceEnd);
        cursor = fenceEnd;
        continue;
      }
    }

    if (markdown[cursor] === '`') {
      const end = inlineCodeEnd(markdown, cursor);
      protectedMarkdown += markdown.slice(cursor, end);
      cursor = end;
      continue;
    }

    const candidates: Array<{ opening: string; closing: string; display: boolean }> = [
      { opening: '$$', closing: '$$', display: true },
      { opening: '\\[', closing: '\\]', display: true },
      { opening: '$', closing: '$', display: false },
      { opening: '\\(', closing: '\\)', display: false },
    ];
    const candidate = candidates.find(({ opening }) => markdown.startsWith(opening, cursor) && !isEscaped(markdown, cursor));
    if (candidate) {
      const contentStart = cursor + candidate.opening.length;
      const end = findUnescapedDelimiter(markdown, candidate.closing, contentStart);
      if (end >= 0) {
        const latex = markdown.slice(contentStart, end);
        if (candidate.display ? Boolean(latex.trim()) : canRenderInlineMath(latex)) {
          appendToken(markdown.slice(cursor, end + candidate.closing.length), latex, candidate.display);
          cursor = end + candidate.closing.length;
          continue;
        }
      }
    }

    protectedMarkdown += markdown[cursor];
    cursor += 1;
  }
  return { protectedMarkdown, tokens };
}

function isCodeTextNode(node: Text) {
  return Boolean(node.parentElement?.closest('code, pre'));
}

function renderMarkdownMath(html: string, tokens: readonly MarkdownMathToken[]) {
  if (!tokens.length) return html;
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(html, 'text/html');
  const textNodes: Text[] = [];
  const walker = documentNode.createTreeWalker(documentNode.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) textNodes.push(node);
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const text = textNode.data;
    const matches = [...text.matchAll(new RegExp(`${MATH_TOKEN_PREFIX}(\\d+)${MATH_TOKEN_SUFFIX}`, 'g'))];
    if (!matches.length || !textNode.parentNode) continue;
    const replacement = documentNode.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      const matchIndex = match.index ?? 0;
      replacement.append(documentNode.createTextNode(text.slice(offset, matchIndex)));
      const token = tokens[Number(match[1])];
      if (!token) {
        replacement.append(documentNode.createTextNode(match[0]));
      } else if (isCodeTextNode(textNode)) {
        replacement.append(documentNode.createTextNode(token.source));
      } else {
        try {
          const template = documentNode.createElement('template');
          template.innerHTML = katex.renderToString(token.latex, {
            displayMode: token.display,
            output: 'html',
            throwOnError: false,
            trust: false,
            strict: 'ignore',
          });
          replacement.append(template.content);
        } catch {
          replacement.append(documentNode.createTextNode(token.source));
        }
      }
      offset = matchIndex + match[0].length;
    }
    replacement.append(documentNode.createTextNode(text.slice(offset)));
    textNode.parentNode.replaceChild(replacement, textNode);
  }
  return documentNode.body.innerHTML;
}

function blockText(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.textContent?.replace(/\s+/g, ' ').trim() || '';
}

function blockFromElement(element: Element, index: number, mathTokens: readonly MarkdownMathToken[] = []): FlowBlock | null {
  const safeHtml = DOMPurify.sanitize(element.innerHTML, {
    ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'span', 'strong', 'sub', 'sup', 'ul'],
    ALLOWED_ATTR: ['alt', 'class', 'href', 'src', 'title'],
  });
  // KaTeX is generated only after user-authored HTML has been sanitized, so
  // its internal span styles remain intact without broadening Markdown HTML.
  const html = renderMarkdownMath(safeHtml, mathTokens);
  const text = blockText(html);
  if (!text && !html.includes('<img')) return null;
  return { id: `block-${index}`, html, text, type: element.tagName.toLowerCase() };
}

export function htmlToBlocks(rawHtml: string, mathTokens: readonly MarkdownMathToken[] = []): FlowBlock[] {
  const clean = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['src', 'alt', 'title'],
  });
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(clean, 'text/html');
  const blocks: FlowBlock[] = [];
  let index = 0;
  for (const child of Array.from(documentNode.body.children)) {
    if (child.matches('ul, ol')) {
      for (const item of Array.from(child.children)) {
        const block = blockFromElement(item, index++, mathTokens);
        if (block) blocks.push(block);
      }
      continue;
    }
    const block = blockFromElement(child, index++, mathTokens);
    if (block) blocks.push(block);
  }
  if (!blocks.length && documentNode.body.textContent?.trim()) {
    return documentNode.body.textContent.split(/\n{2,}/).map((text, blockIndex) => ({
      id: `block-${blockIndex}`,
      html: escapeHtml(text.trim()),
      text: text.trim(),
      type: 'p',
    })).filter((block) => block.text);
  }
  return blocks;
}

export async function markdownToBlocks(markdown: string): Promise<FlowBlock[]> {
  const { protectedMarkdown, tokens } = protectMarkdownMath(markdown);
  return htmlToBlocks(await marked.parse(protectedMarkdown), tokens);
}

function plainTextBlocks(text: string): FlowBlock[] {
  return text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((paragraph, index) => {
    const normalized = paragraph.trim();
    return { id: `block-${index}`, html: escapeHtml(normalized).replace(/\n/g, '<br>'), text: normalized, type: 'p' };
  }).filter((block) => block.text);
}

export async function loadFlowBlocks(documentRecord: DocumentRecord): Promise<FlowBlock[]> {
  const response = await fetch(assetUrl(documentRecord.assetId));
  if (!response.ok) throw new Error('无法打开本地文档。');
  if (documentRecord.kind === 'text') return plainTextBlocks(await response.text());
  if (documentRecord.kind === 'markdown') return markdownToBlocks(await response.text());
  if (documentRecord.kind === 'docx') {
    const arrayBuffer = await response.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    return htmlToBlocks(result.value);
  }
  throw new Error('该文档不是可重排文本。');
}
