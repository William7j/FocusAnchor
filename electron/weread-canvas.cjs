const DEFAULT_FONT_SIZE = 16;
const ACTIVE_SENTENCE = 'active';
const PREVIOUS_SENTENCE = 'previous';
const NEXT_SENTENCE = 'next';

/**
 * Returns the visual role for one sentence around the active sentence.
 * `active` is deliberately distinct from context level 0 so renderers can
 * give the primary sentence its own color. Only the immediately previous and
 * next sentence are included; -1 means the sentence is outside this trio.
 */
function sentenceContextLevel(sentenceIndex, activeIndex) {
  const index = Number(sentenceIndex);
  const active = Number(activeIndex);
  if (!Number.isInteger(index) || !Number.isInteger(active) || index < 0 || active < 0) return -1;
  if (index === active) return ACTIVE_SENTENCE;
  if (index === active - 1) return PREVIOUS_SENTENCE;
  if (index === active + 1) return NEXT_SENTENCE;
  return -1;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function calibrateCanvasHighlightBounds(rect) {
  const left = finiteNumber(rect?.left);
  const top = finiteNumber(rect?.top);
  const width = Math.max(1, finiteNumber(rect?.width, 1));
  const height = Math.max(1, finiteNumber(rect?.height, 1));
  const horizontalPadding = Math.max(1, Math.min(3, Math.ceil(height * 0.05)));
  // Fragments are real ink bounds rather than font line boxes. Keep the
  // breathing room symmetric so CJK text sits in the optical center of the
  // color block. A 2-4px margin still preserves descenders in mixed text.
  const verticalPadding = Math.max(2, Math.min(4, Math.ceil(height * 0.08)));
  return {
    left: Math.max(0, left - horizontalPadding),
    top: top - verticalPadding,
    width: Math.max(2, width + horizontalPadding * 2),
    height: Math.max(2, height + verticalPadding * 2),
  };
}

function canvasRectsAreAdjacent(left, right) {
  const gap = right.left - (left.left + left.width);
  // Keep intentional punctuation spacing, but never bridge a distant stale draw.
  const maxGap = Math.max(12, Math.min(96, Math.max(left.height, right.height) * 1.5));
  return gap <= maxGap;
}

function canvasHighlightFragments(sentences, activeIndex) {
  const result = [];
  (sentences || []).forEach((sentence, sentenceIndex) => {
    const role = sentenceContextLevel(sentenceIndex, activeIndex);
    if (role === -1) return;
    (sentence.fragments || []).forEach((fragment) => {
      const bounds = calibrateCanvasHighlightBounds(fragment);
      result.push({
        sentenceIndex,
        role,
        canvasId: fragment.canvasId || '',
        lineIndex: Number(fragment.lineIndex) || 0,
        ...bounds,
      });
    });
  });
  return result;
}

function fontSizeFromCss(font) {
  const match = /(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|\/|$)/i.exec(String(font || ''));
  return match ? finiteNumber(match[1], DEFAULT_FONT_SIZE) : DEFAULT_FONT_SIZE;
}

function transformPoint(x, y, matrix) {
  const [a, b, c, d, e, f] = Array.isArray(matrix) && matrix.length === 6
    ? matrix.map((value, index) => finiteNumber(value, index === 0 || index === 3 ? 1 : 0))
    : [1, 0, 0, 1, 0, 0];
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function projectCanvasDraw(draw, canvas) {
  if (!draw || !canvas || !String(draw.text || '')) return null;
  const bitmapWidth = Math.max(1, finiteNumber(canvas.bitmapWidth, 1));
  const bitmapHeight = Math.max(1, finiteNumber(canvas.bitmapHeight, 1));
  const cssWidth = Math.max(1, finiteNumber(canvas.cssWidth, bitmapWidth));
  const cssHeight = Math.max(1, finiteNumber(canvas.cssHeight, bitmapHeight));
  const scaleX = cssWidth / bitmapWidth;
  const scaleY = cssHeight / bitmapHeight;
  const fontSize = fontSizeFromCss(draw.font);
  const metrics = draw.metrics || {};
  const leftMetric = Math.max(0, finiteNumber(metrics.actualBoundingBoxLeft, 0));
  const rightMetric = Math.max(0, finiteNumber(metrics.actualBoundingBoxRight, finiteNumber(metrics.width, fontSize)));
  const ascent = Math.max(1, finiteNumber(metrics.actualBoundingBoxAscent, fontSize * 0.82));
  const descent = Math.max(1, finiteNumber(metrics.actualBoundingBoxDescent, fontSize * 0.18));
  const x = finiteNumber(draw.x);
  const y = finiteNumber(draw.y);
  const corners = [
    transformPoint(x - leftMetric, y - ascent, draw.transform),
    transformPoint(x + rightMetric, y - ascent, draw.transform),
    transformPoint(x + rightMetric, y + descent, draw.transform),
    transformPoint(x - leftMetric, y + descent, draw.transform),
  ];
  const baseline = transformPoint(x, y, draw.transform);
  const xs = corners.map((point) => point.x * scaleX);
  const ys = corners.map((point) => point.y * scaleY);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    canvasId: String(draw.canvasId || canvas.canvasId || ''),
    text: String(draw.text || ''),
    order: Math.max(0, Math.trunc(finiteNumber(draw.order))),
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    baselineY: baseline.y * scaleY,
  };
}

function canvasDrawBitmapBounds(draw) {
  return projectCanvasDraw(draw, {
    canvasId: String(draw?.canvasId || ''),
    bitmapWidth: 1,
    bitmapHeight: 1,
    cssWidth: 1,
    cssHeight: 1,
  });
}

function canvasRectsOverlap(left, right) {
  if (!left || !right) return false;
  const leftRight = finiteNumber(left.left) + Math.max(0, finiteNumber(left.width));
  const leftBottom = finiteNumber(left.top) + Math.max(0, finiteNumber(left.height));
  const rightRight = finiteNumber(right.left) + Math.max(0, finiteNumber(right.width));
  const rightBottom = finiteNumber(right.top) + Math.max(0, finiteNumber(right.height));
  return finiteNumber(left.left) < rightRight
    && leftRight > finiteNumber(right.left)
    && finiteNumber(left.top) < rightBottom
    && leftBottom > finiteNumber(right.top);
}

// Canvas renderers frequently redraw only a line or a paragraph instead of
// clearing the whole bitmap. Those erased glyph records are no longer valid,
// even when a later pixel probe happens to find unrelated ink in the same box.
function discardErasedCanvasDraws(draws, erase) {
  if (!erase || !Number.isFinite(Number(erase.width)) || !Number.isFinite(Number(erase.height))) return [...(draws || [])];
  return (draws || []).filter((draw) => !canvasRectsOverlap(canvasDrawBitmapBounds(draw), erase));
}

function canvasGlyphHasInk(glyph, pixels, bitmapWidth, bitmapHeight, cssWidth, cssHeight) {
  if (!glyph || !pixels || !bitmapWidth || !bitmapHeight || !cssWidth || !cssHeight) return true;
  const scaleX = bitmapWidth / cssWidth;
  const scaleY = bitmapHeight / cssHeight;
  const left = Math.max(0, Math.floor(glyph.left * scaleX) - 1);
  const top = Math.max(0, Math.floor(glyph.top * scaleY) - 1);
  const right = Math.min(bitmapWidth, Math.ceil((glyph.left + glyph.width) * scaleX) + 1);
  const bottom = Math.min(bitmapHeight, Math.ceil((glyph.top + glyph.height) * scaleY) + 1);
  if (right <= left || bottom <= top) return true;

  const area = (right - left) * (bottom - top);
  const step = Math.max(1, Math.ceil(Math.sqrt(area / 12000)));
  const minimum = [255, 255, 255, 255];
  const maximum = [0, 0, 0, 0];
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const offset = (y * bitmapWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        minimum[channel] = Math.min(minimum[channel], pixels[offset + channel]);
        maximum[channel] = Math.max(maximum[channel], pixels[offset + channel]);
      }
    }
  }
  // Real text has a clear contrast against either an opaque page or a
  // transparent canvas. A stale draw points to a uniform, already-cleared area.
  return maximum.some((value, channel) => value - minimum[channel] >= 32);
}

function sameLine(line, glyph) {
  const tolerance = Math.max(2, Math.min(line.height, glyph.height) * 0.38);
  const top = Math.max(line.top, glyph.top);
  const bottom = Math.min(line.bottom, glyph.top + glyph.height);
  const overlap = Math.max(0, bottom - top);
  return Math.abs(line.baselineY - glyph.baselineY) <= tolerance
    || overlap >= Math.min(line.height, glyph.height) * 0.62;
}

function groupCanvasLines(glyphs) {
  const lines = [];
  const ordered = [...glyphs]
    .filter((glyph) => glyph && glyph.text && Number.isFinite(glyph.top))
    .sort((left, right) => left.top - right.top || left.left - right.left || left.order - right.order);
  for (const glyph of ordered) {
    let line = lines.find((candidate) => sameLine(candidate, glyph));
    if (!line) {
      line = {
        canvasId: glyph.canvasId,
        glyphs: [],
        baselineY: glyph.baselineY,
        top: glyph.top,
        bottom: glyph.top + glyph.height,
        height: glyph.height,
      };
      lines.push(line);
    }
    line.glyphs.push(glyph);
    const weight = line.glyphs.length;
    line.baselineY = ((line.baselineY * (weight - 1)) + glyph.baselineY) / weight;
    line.top = Math.min(line.top, glyph.top);
    line.bottom = Math.max(line.bottom, glyph.top + glyph.height);
    line.height = line.bottom - line.top;
  }
  return lines
    .sort((left, right) => left.top - right.top || left.baselineY - right.baselineY)
    .map((line, index) => ({
      ...line,
      index,
      glyphs: line.glyphs.sort((left, right) => left.left - right.left || left.order - right.order),
    }));
}

function sentenceSegments(text) {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter('zh-CN', { granularity: 'sentence' }).segment(text)]
      .map((part) => ({ index: part.index, segment: part.segment }));
  }
  const result = [];
  const matcher = /[^。！？!?]+[。！？!?]?/g;
  let match;
  while ((match = matcher.exec(text))) result.push({ index: match.index, segment: match[0] });
  return result.length ? result : [{ index: 0, segment: text }];
}

function mergeGlyphRects(entries) {
  const fragments = [];
  for (const entry of entries) {
    const glyph = entry.glyph;
    const rect = {
      ...glyph,
      // Keep the current sentence's real ink bounds. Applying the full
      // line's box here pulls an unrelated large descent into every color
      // block on that line.
      top: glyph.top,
      height: glyph.height,
    };
    const previous = fragments[fragments.length - 1];
    if (previous && previous.lineIndex === entry.lineIndex && canvasRectsAreAdjacent(previous, rect)) {
      const right = Math.max(previous.left + previous.width, rect.left + rect.width);
      const bottom = Math.max(previous.top + previous.height, rect.top + rect.height);
      previous.left = Math.min(previous.left, rect.left);
      previous.top = Math.min(previous.top, rect.top);
      previous.width = right - previous.left;
      previous.height = bottom - previous.top;
    } else {
      fragments.push({
        canvasId: rect.canvasId,
        lineIndex: entry.lineIndex,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  return fragments;
}

function buildCanvasSentences(draws, canvas) {
  const glyphs = draws.map((draw) => projectCanvasDraw(draw, canvas)).filter(Boolean);
  const lines = groupCanvasLines(glyphs);
  const tokens = [];
  let text = '';
  lines.forEach((line, lineIndex) => {
    for (const glyph of line.glyphs) {
      const start = text.length;
      text += glyph.text;
      tokens.push({ start, end: text.length, glyph, lineIndex, lineTop: line.top, lineHeight: line.height });
    }
  });

  const sentences = [];
  for (const part of sentenceSegments(text)) {
    let start = Math.max(0, Number(part.index) || 0);
    let end = start + String(part.segment || '').length;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end - start < 2) continue;
    const entries = tokens.filter((token) => token.end > start && token.start < end);
    if (!entries.length) continue;
    const fragments = mergeGlyphRects(entries);
    if (!fragments.length) continue;
    sentences.push({
      text: text.slice(start, end),
      fragments,
      firstOrder: Math.min(...entries.map((entry) => entry.glyph.order)),
    });
  }
  return sentences;
}

module.exports = {
  ACTIVE_SENTENCE,
  NEXT_SENTENCE,
  PREVIOUS_SENTENCE,
  buildCanvasSentences,
  canvasGlyphHasInk,
  calibrateCanvasHighlightBounds,
  canvasHighlightFragments,
  canvasDrawBitmapBounds,
  groupCanvasLines,
  canvasGlyphHasInk,
  canvasRectsOverlap,
  discardErasedCanvasDraws,
  projectCanvasDraw,
  sentenceContextLevel,
  transformPoint,
};
