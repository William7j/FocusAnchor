const { contextBridge, ipcRenderer } = require('electron');

const CAPTURE_ATTRIBUTE = 'data-focus-reader-canvas-id';
const CAPTURE_KEY = `__focus_reader_canvas_${Math.random().toString(36).slice(2)}`;
const MAX_CAPTURED_DRAWS = 8000;
const MAX_SENTENCES = 5000;

// Sandboxed preloads cannot require local modules. Keep the tested projection
// algorithm in this file at runtime; electron/weread-canvas.cjs is its testable twin.
function canvasFinite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function canvasFontSize(font) {
  const match = /(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|\/|$)/i.exec(String(font || ''));
  return match ? canvasFinite(match[1], 16) : 16;
}

function canvasTransformPoint(x, y, matrix) {
  const [a, b, c, d, e, f] = Array.isArray(matrix) && matrix.length === 6
    ? matrix.map((value, index) => canvasFinite(value, index === 0 || index === 3 ? 1 : 0))
    : [1, 0, 0, 1, 0, 0];
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function projectCanvasDraw(draw, canvas) {
  if (!draw || !canvas || !String(draw.text || '')) return null;
  const bitmapWidth = Math.max(1, canvasFinite(canvas.bitmapWidth, 1));
  const bitmapHeight = Math.max(1, canvasFinite(canvas.bitmapHeight, 1));
  const cssWidth = Math.max(1, canvasFinite(canvas.cssWidth, bitmapWidth));
  const cssHeight = Math.max(1, canvasFinite(canvas.cssHeight, bitmapHeight));
  const scaleX = cssWidth / bitmapWidth;
  const scaleY = cssHeight / bitmapHeight;
  const fontSize = canvasFontSize(draw.font);
  const metrics = draw.metrics || {};
  const leftMetric = Math.max(0, canvasFinite(metrics.actualBoundingBoxLeft, 0));
  const rightMetric = Math.max(0, canvasFinite(metrics.actualBoundingBoxRight, canvasFinite(metrics.width, fontSize)));
  const ascent = Math.max(1, canvasFinite(metrics.actualBoundingBoxAscent, fontSize * 0.82));
  const descent = Math.max(1, canvasFinite(metrics.actualBoundingBoxDescent, fontSize * 0.18));
  const x = canvasFinite(draw.x);
  const y = canvasFinite(draw.y);
  const corners = [
    canvasTransformPoint(x - leftMetric, y - ascent, draw.transform),
    canvasTransformPoint(x + rightMetric, y - ascent, draw.transform),
    canvasTransformPoint(x + rightMetric, y + descent, draw.transform),
    canvasTransformPoint(x - leftMetric, y + descent, draw.transform),
  ];
  const baseline = canvasTransformPoint(x, y, draw.transform);
  const xs = corners.map((point) => point.x * scaleX);
  const ys = corners.map((point) => point.y * scaleY);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    canvasId: String(draw.canvasId || canvas.canvasId || ''),
    text: String(draw.text || ''),
    order: Math.max(0, Math.trunc(canvasFinite(draw.order))),
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
  const leftRight = canvasFinite(left.left) + Math.max(0, canvasFinite(left.width));
  const leftBottom = canvasFinite(left.top) + Math.max(0, canvasFinite(left.height));
  const rightRight = canvasFinite(right.left) + Math.max(0, canvasFinite(right.width));
  const rightBottom = canvasFinite(right.top) + Math.max(0, canvasFinite(right.height));
  return canvasFinite(left.left) < rightRight
    && leftRight > canvasFinite(right.left)
    && canvasFinite(left.top) < rightBottom
    && leftBottom > canvasFinite(right.top);
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
  return maximum.some((value, channel) => value - minimum[channel] >= 32);
}

function canvasGlyphOnLine(line, glyph) {
  const tolerance = Math.max(2, Math.min(line.height, glyph.height) * 0.38);
  const overlap = Math.max(0, Math.min(line.bottom, glyph.top + glyph.height) - Math.max(line.top, glyph.top));
  return Math.abs(line.baselineY - glyph.baselineY) <= tolerance || overlap >= Math.min(line.height, glyph.height) * 0.62;
}

function groupCanvasLines(glyphs) {
  const lines = [];
  const ordered = [...glyphs].filter((glyph) => glyph?.text && Number.isFinite(glyph.top)).sort((left, right) => left.top - right.top || left.left - right.left || left.order - right.order);
  for (const glyph of ordered) {
    let line = lines.find((candidate) => canvasGlyphOnLine(candidate, glyph));
    if (!line) {
      line = { glyphs: [], baselineY: glyph.baselineY, top: glyph.top, bottom: glyph.top + glyph.height, height: glyph.height };
      lines.push(line);
    }
    line.glyphs.push(glyph);
    const weight = line.glyphs.length;
    line.baselineY = ((line.baselineY * (weight - 1)) + glyph.baselineY) / weight;
    line.top = Math.min(line.top, glyph.top);
    line.bottom = Math.max(line.bottom, glyph.top + glyph.height);
    line.height = line.bottom - line.top;
  }
  return lines.sort((left, right) => left.top - right.top || left.baselineY - right.baselineY).map((line, index) => ({
    ...line,
    index,
    glyphs: line.glyphs.sort((left, right) => left.left - right.left || left.order - right.order),
  }));
}

function canvasSentenceSegments(text) {
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter('zh-CN', { granularity: 'sentence' }).segment(text)].map((part) => ({ index: part.index, segment: part.segment }));
  return fallbackSentenceSegments(text);
}

function canvasRectsAreAdjacent(left, right) {
  const gap = right.left - (left.left + left.width);
  // Keep intentional punctuation spacing, but never bridge a distant stale draw.
  const maxGap = Math.max(12, Math.min(96, Math.max(left.height, right.height) * 1.5));
  return gap <= maxGap;
}

function mergeCanvasGlyphRects(entries) {
  const fragments = [];
  for (const entry of entries) {
    const glyph = entry.glyph;
    const rect = {
      ...glyph,
      // TextMetrics already gives the visible ink bounds for this draw. Do
      // not replace them with the whole line box: another glyph on the line
      // can have a much larger descent, which leaves the sentence color block
      // visibly heavy below its text.
      top: glyph.top,
      height: glyph.height,
    };
    const previous = fragments[fragments.length - 1];
    // Entries belong to one sentence already. Collapse every run on the same
    // visual line so punctuation metrics and letter spacing cannot split a
    // sentence into separate color blocks.
    if (previous && previous.lineIndex === entry.lineIndex && canvasRectsAreAdjacent(previous, rect)) {
      const right = Math.max(previous.left + previous.width, rect.left + rect.width);
      const bottom = Math.max(previous.top + previous.height, rect.top + rect.height);
      previous.left = Math.min(previous.left, rect.left);
      previous.top = Math.min(previous.top, rect.top);
      previous.width = right - previous.left;
      previous.height = bottom - previous.top;
    } else {
      fragments.push({ canvasId: rect.canvasId, lineIndex: entry.lineIndex, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
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
  for (const part of canvasSentenceSegments(text)) {
    let start = Math.max(0, Number(part.index) || 0);
    let end = start + String(part.segment || '').length;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end - start < 2) continue;
    const entries = tokens.filter((token) => token.end > start && token.start < end);
    if (!entries.length) continue;
    const fragments = mergeCanvasGlyphRects(entries);
    if (!fragments.length) continue;
    sentences.push({ text: text.slice(start, end), fragments, firstOrder: Math.min(...entries.map((entry) => entry.glyph.order)) });
  }
  return sentences;
}

function installCanvasCapture(captureKey, captureAttribute) {
  if (window[captureKey]?.pull) return { installed: true };
  const prototype = globalThis.CanvasRenderingContext2D?.prototype;
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'fillText');
  if (!prototype || !descriptor || typeof descriptor.value !== 'function') return { installed: false, reason: 'canvas-2d-unavailable' };

  const finiteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };

  const originalFillText = descriptor.value;
  const originalClearRect = prototype.clearRect;
  const originalFillRect = prototype.fillRect;
  const originalReset = prototype.reset;
  const queue = [];
  const canvases = new WeakMap();
  let nextCanvasId = 1;
  let nextOrder = 1;
  let dropped = 0;

  function push(record) {
    if (queue.length >= 12000) {
      queue.splice(0, 2000);
      dropped += 2000;
    }
    queue.push(record);
  }

  function canvasState(canvas) {
    let value = canvases.get(canvas);
    if (value) return value;
    const existing = String(canvas.getAttribute(captureAttribute) || '');
    const id = /^focus-canvas-\d+$/.test(existing) ? existing : `focus-canvas-${nextCanvasId++}`;
    if (existing !== id) canvas.setAttribute(captureAttribute, id);
    value = { id, count: 0, generation: 0, paint: 0, lastGlyphAt: 0 };
    canvases.set(canvas, value);
    return value;
  }

  function shouldCapture(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    if (canvas.closest('.readerChapterContent,.wr_canvasContainer')) return true;
    return canvas.width >= 400 && canvas.height >= 400;
  }

  function clearCoversCanvas(context, canvas, args) {
    const [x, y, width, height] = args.map(Number);
    if (![x, y, width, height].every(Number.isFinite) || !width || !height) return false;
    const matrix = context.getTransform();
    const points = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ].map(([pointX, pointY]) => ({
      x: matrix.a * pointX + matrix.c * pointY + matrix.e,
      y: matrix.b * pointX + matrix.d * pointY + matrix.f,
    }));
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));
    const toleranceX = Math.max(2, canvas.width * 0.02);
    const toleranceY = Math.max(2, canvas.height * 0.02);
    return left <= toleranceX
      && top <= toleranceY
      && right >= canvas.width - toleranceX
      && bottom >= canvas.height - toleranceY;
  }

  function transformedCanvasRect(context, args) {
    const [x, y, width, height] = args.map(Number);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const matrix = context.getTransform();
    const points = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ].map(([pointX, pointY]) => ({
      x: matrix.a * pointX + matrix.c * pointY + matrix.e,
      y: matrix.b * pointX + matrix.d * pointY + matrix.f,
    }));
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));
    return { left, top, width: right - left, height: bottom - top };
  }

  function eraseCapturedRegion(context, canvas, args) {
    const canvasInfo = canvasState(canvas);
    const rect = transformedCanvasRect(context, args);
    if (!rect) return;
    push({
      kind: 'erase',
      canvasId: canvasInfo.id,
      generation: canvasInfo.generation,
      paint: canvasInfo.paint,
      order: nextOrder++,
      ...rect,
    });
  }

  function beginPaint(canvasInfo) {
    const now = performance.now();
    // Canvas text for one page is drawn synchronously. A longer idle gap is
    // a new paint pass, even when the renderer did not issue a full clear.
    if (canvasInfo.lastGlyphAt && now - canvasInfo.lastGlyphAt > 420) canvasInfo.paint += 1;
    canvasInfo.lastGlyphAt = now;
  }

  // A page canvas can be cleared by assigning canvas.width/height instead of
  // calling clearRect(). Keep a monotonically increasing generation on every
  // tracked canvas so a delayed or trimmed reset record cannot mix text from
  // two page paints in the preload-side sentence builder.
  function resetCanvasCapture(canvas) {
    const canvasInfo = canvases.get(canvas);
    if (!canvasInfo) return;
    canvasInfo.generation += 1;
    push({ kind: 'reset', canvasId: canvasInfo.id, generation: canvasInfo.generation, order: nextOrder++ });
    canvasInfo.count = 0;
  }

  function fullCanvasFillReplacesPixels(context, canvas, args) {
    if (!clearCoversCanvas(context, canvas, args)) return false;
    const operation = String(context.globalCompositeOperation || 'source-over');
    if (operation === 'copy') return true;
    if (operation !== 'source-over' || finiteNumber(context.globalAlpha, 1) < .999) return false;
    if (String(context.filter || 'none') !== 'none') return false;
    const fillStyle = context.fillStyle;
    if (typeof fillStyle !== 'string' || fillStyle.toLowerCase() === 'transparent') return false;
    const alpha = /^rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\s*\)$/i.exec(fillStyle.trim());
    return !alpha || finiteNumber(alpha[1], 1) >= .999;
  }

  Object.defineProperty(prototype, 'fillText', {
    ...descriptor,
    value: function fillText(...args) {
      const result = Reflect.apply(originalFillText, this, args);
      const canvas = this.canvas;
      const text = String(args[0] ?? '').slice(0, 128);
      if (!text.trim() || finiteNumber(this.globalAlpha, 1) <= .01 || !shouldCapture(canvas)) return result;
      try {
        const canvasInfo = canvasState(canvas);
        beginPaint(canvasInfo);
        const metrics = this.measureText(text);
        const matrix = this.getTransform();
        push({
          kind: 'glyph',
          canvasId: canvasInfo.id,
          generation: canvasInfo.generation,
          paint: canvasInfo.paint,
          order: nextOrder++,
          text,
          x: Number(args[1]) || 0,
          y: Number(args[2]) || 0,
          font: String(this.font || ''),
          transform: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
          metrics: {
            width: metrics.width,
            actualBoundingBoxLeft: metrics.actualBoundingBoxLeft,
            actualBoundingBoxRight: metrics.actualBoundingBoxRight,
            actualBoundingBoxAscent: metrics.actualBoundingBoxAscent,
            actualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
          },
        });
        canvasInfo.count += 1;
      } catch {
        // The official draw must never fail because accessibility capture failed.
      }
      return result;
    },
  });

  if (typeof originalClearRect === 'function') {
    prototype.clearRect = function clearRect(...args) {
      const result = Reflect.apply(originalClearRect, this, args);
      const canvas = this.canvas;
      if (shouldCapture(canvas)) {
        if (clearCoversCanvas(this, canvas, args)) resetCanvasCapture(canvas);
        else eraseCapturedRegion(this, canvas, args);
      }
      return result;
    };
  }

  if (typeof originalFillRect === 'function') {
    prototype.fillRect = function fillRect(...args) {
      const result = Reflect.apply(originalFillRect, this, args);
      const canvas = this.canvas;
      if (shouldCapture(canvas)) {
        if (fullCanvasFillReplacesPixels(this, canvas, args)) {
          resetCanvasCapture(canvas);
        } else {
          const operation = String(this.globalCompositeOperation || 'source-over');
          const opaque = operation === 'copy'
            || (operation === 'source-over' && finiteNumber(this.globalAlpha, 1) >= .999 && String(this.fillStyle || '').toLowerCase() !== 'transparent');
          if (opaque) eraseCapturedRegion(this, canvas, args);
        }
      }
      return result;
    };
  }

  if (typeof originalReset === 'function') {
    prototype.reset = function reset(...args) {
      const result = Reflect.apply(originalReset, this, args);
      const canvas = this.canvas;
      if (shouldCapture(canvas)) resetCanvasCapture(canvas);
      return result;
    };
  }

  function observeCanvasDimension(property) {
    const canvasPrototype = globalThis.HTMLCanvasElement?.prototype;
    const descriptor = canvasPrototype && Object.getOwnPropertyDescriptor(canvasPrototype, property);
    if (!descriptor?.set || !descriptor.configurable) return;
    try {
      Object.defineProperty(canvasPrototype, property, {
        ...descriptor,
        set(value) {
          const result = Reflect.apply(descriptor.set, this, [value]);
          if (shouldCapture(this)) resetCanvasCapture(this);
          return result;
        },
      });
    } catch {
      // Canvas dimension observation is an enhancement; capture can still
      // fall back to clearRect reset detection on locked-down pages.
    }
  }

  observeCanvasDimension('width');
  observeCanvasDimension('height');

  const bridge = Object.freeze({
    pull(limit = 3000) {
      const count = Math.max(1, Math.min(3000, Math.trunc(Number(limit) || 3000)));
      return { installed: true, records: queue.splice(0, count), dropped };
    },
  });
  Object.defineProperty(window, captureKey, { value: bridge, configurable: false, enumerable: false, writable: false });
  return { installed: true };
}

let canvasCaptureSupported = false;
let canvasCaptureError = '';
try {
  const result = contextBridge.executeInMainWorld({ func: installCanvasCapture, args: [CAPTURE_KEY, CAPTURE_ATTRIBUTE] });
  canvasCaptureSupported = Boolean(result?.installed);
  canvasCaptureError = result?.reason || '';
} catch {
  canvasCaptureError = 'main-world-capture-failed';
}

const state = {
  settings: {
    mode: 'off',
    dimming: 0.52,
    bandHeight: 150,
    followPointer: true,
    showGuideLine: true,
    sentenceHighlight: true,
  },
  pointerX: 0,
  pointerY: 0,
  activeBlock: null,
  host: null,
  frame: null,
  line: null,
  highlightLayer: null,
  canvasUnderlays: new Map(),
  canvasUnderlayStyle: null,
  scrollContainer: null,
  autoScroll: false,
  autoScrollSpeed: 42,
  animationFrame: 0,
  lastFrameAt: 0,
  sentenceRanges: [],
  canvasDraws: new Map(),
  canvasDrawGenerations: new Map(),
  canvasDrawPaints: new Map(),
  canvasSentences: [],
  canvasFirstSeenAt: 0,
  canvasDropped: 0,
  canvasSignature: '',
  sentenceSource: 'none',
  activeSentence: -1,
  sentenceStyle: null,
  sentenceObserver: null,
  documentObserver: null,
  sentenceRebuildTimer: 0,
  readerRoot: null,
  activeSentenceAnchor: null,
  pendingSentenceDirection: 0,
  pendingSentenceTimer: 0,
  capturePollTimer: 0,
  lastDiagnostics: '',
};

const BLOCK_SELECTOR = ['p', 'blockquote', 'li', 'h1', 'h2', 'h3', '[role="article"] > div', 'article > div'].join(',');
const PREVIOUS_SENTENCE_HIGHLIGHT = 'focus-reader-sentence-previous';
const NEXT_SENTENCE_HIGHLIGHT = 'focus-reader-sentence-next';
const PREVIOUS_SENTENCE_COLOR = 'rgba(255, 118, 118, .30)';
const NEXT_SENTENCE_COLOR = 'rgba(255, 210, 92, .34)';
const ACTIVE_SENTENCE = 'active';
const PREVIOUS_SENTENCE = 'previous';
const NEXT_SENTENCE = 'next';
const ACTIVE_SENTENCE_COLOR = 'rgba(10, 132, 255, .72)';
const READER_ROOT_SELECTOR = ['.readerChapterContent', '[class*="readerchaptercontent" i]', '[class*="chaptercontent" i]', '[class*="reader-content" i]', '[class*="readercontent" i]', '[role="main"]', 'main', 'article'].join(',');
const EXCLUDED_CONTEXT = 'button,input,textarea,select,script,style,nav,header,footer,aside,a,[role="navigation"],[role="button"],[role="toolbar"],[role="banner"],[contenteditable="true"]';
const EXCLUDED_CLASS = /(toolbar|menu|catalog|comment|review|recommend|share|avatar|profile|action|control|button|header|navbar|nav)/;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sentenceContextLevel(sentenceIndex, activeIndex) {
  const index = Number(sentenceIndex);
  const active = Number(activeIndex);
  if (!Number.isInteger(index) || !Number.isInteger(active) || index < 0 || active < 0) return -1;
  if (index === active) return ACTIVE_SENTENCE;
  if (index === active - 1) return PREVIOUS_SENTENCE;
  if (index === active + 1) return NEXT_SENTENCE;
  return -1;
}

function sentenceHighlightColor(role) {
  if (role === ACTIVE_SENTENCE) return ACTIVE_SENTENCE_COLOR;
  if (role === PREVIOUS_SENTENCE) return PREVIOUS_SENTENCE_COLOR;
  return NEXT_SENTENCE_COLOR;
}

function focusOverlayEnabled() {
  return !state.settings.sentenceHighlight && state.settings.mode !== 'off';
}

function diagnostic(status, source, sentences = 0, blocks = 0, reason = '') {
  const value = {
    status,
    source,
    detected: status === 'ready',
    sentences: Math.max(0, Math.min(MAX_SENTENCES, Math.round(sentences))),
    blocks: Math.max(0, Math.min(1000, Math.round(blocks))),
    reason,
  };
  const signature = JSON.stringify(value);
  if (signature === state.lastDiagnostics) return;
  state.lastDiagnostics = signature;
  ipcRenderer.send('weread-assist:diagnostics', value);
}

function hasExcludedContext(element) {
  let current = element;
  while (current instanceof HTMLElement) {
    if (current.matches(EXCLUDED_CONTEXT) || current.getAttribute('aria-hidden') === 'true') return true;
    const classText = `${current.id || ''} ${current.className || ''} ${current.getAttribute('role') || ''}`.toLowerCase();
    if (EXCLUDED_CLASS.test(classText)) return true;
    if (current.classList.contains('readerChapterContent')) break;
    current = current.parentElement;
  }
  return false;
}

function ensureSentenceStyle() {
  if (state.sentenceStyle?.isConnected) return;
  const style = document.createElement('style');
  style.id = 'focus-reader-sentence-style';
  style.textContent = `::highlight(${PREVIOUS_SENTENCE_HIGHLIGHT}) { background-color: ${PREVIOUS_SENTENCE_COLOR}; color: inherit; }
    ::highlight(focus-reader-sentence-active) { background-color: ${ACTIVE_SENTENCE_COLOR}; color: inherit; text-decoration: underline; text-decoration-color: rgba(37, 112, 190, .72); text-decoration-thickness: 2px; text-underline-offset: 3px; }
    ::highlight(${NEXT_SENTENCE_HIGHLIGHT}) { background-color: ${NEXT_SENTENCE_COLOR}; color: inherit; }`;
  document.documentElement.append(style);
  state.sentenceStyle = style;
}

function clearDomHighlights() {
  if (!globalThis.CSS?.highlights) return;
  CSS.highlights.delete(PREVIOUS_SENTENCE_HIGHLIGHT);
  CSS.highlights.delete('focus-reader-sentence-active');
  CSS.highlights.delete(NEXT_SENTENCE_HIGHLIGHT);
}

function ensureCanvasUnderlayStyle() {
  if (state.canvasUnderlayStyle?.isConnected || !document.documentElement) return;
  const style = document.createElement('style');
  style.id = 'focus-reader-canvas-underlay-style';
  style.textContent = `
    .focus-reader-canvas-underlay { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
    .focus-reader-canvas-underlay > .focus-reader-sentence-fragment { position: absolute; box-sizing: border-box; border-radius: 0; }
    .focus-reader-canvas-underlay > .focus-reader-sentence-fragment.is-active { border-bottom: 2px solid rgba(37, 112, 190, .72); box-shadow: 0 0 0 1px rgba(54, 132, 210, .18); }
  `;
  document.documentElement.append(style);
  state.canvasUnderlayStyle = style;
}

function canvasHasTransparentBackground(canvas) {
  try {
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) return false;
    const points = [
      [1, 1],
      [Math.max(0, Math.floor(canvas.width / 2)), 1],
      [1, Math.max(0, Math.floor(canvas.height / 2))],
      [Math.max(0, canvas.width - 2), Math.max(0, canvas.height - 2)],
    ];
    return points.some(([x, y]) => context.getImageData(x, y, 1, 1).data[3] < 254);
  } catch {
    return false;
  }
}

function releaseCanvasUnderlay(canvas, entry) {
  entry.layer?.remove();
  if (entry.changedCanvasPosition) canvas.style.position = entry.canvasPosition;
  if (entry.changedCanvasZIndex) canvas.style.zIndex = entry.canvasZIndex;
  if (entry.changedContainerPosition && entry.container?.isConnected) entry.container.style.position = entry.containerPosition;
}

function ensureCanvasUnderlay(canvas) {
  const existing = state.canvasUnderlays.get(canvas);
  if (existing) return existing.layer || null;

  const container = canvas.parentElement;
  const entry = {
    layer: null,
    container,
    canvasPosition: canvas.style.position,
    canvasZIndex: canvas.style.zIndex,
    containerPosition: container?.style.position || '',
    changedCanvasPosition: false,
    changedCanvasZIndex: false,
    changedContainerPosition: false,
  };
  state.canvasUnderlays.set(canvas, entry);
  if (!(container instanceof HTMLElement) || !canvasHasTransparentBackground(canvas)) return null;

  ensureCanvasUnderlayStyle();
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
    entry.changedContainerPosition = true;
  }
  if (getComputedStyle(canvas).position === 'static') {
    canvas.style.position = 'relative';
    entry.changedCanvasPosition = true;
  }
  if (getComputedStyle(canvas).zIndex === 'auto') {
    canvas.style.zIndex = '1';
    entry.changedCanvasZIndex = true;
  }
  const layer = document.createElement('div');
  layer.className = 'focus-reader-canvas-underlay';
  layer.setAttribute('aria-hidden', 'true');
  canvas.before(layer);
  entry.layer = layer;
  return layer;
}

function clearCanvasHighlights(removeLayers = false) {
  state.highlightLayer?.replaceChildren();
  for (const [canvas, entry] of state.canvasUnderlays) {
    entry.layer?.replaceChildren();
    if (!removeLayers && canvas.isConnected) continue;
    releaseCanvasUnderlay(canvas, entry);
    state.canvasUnderlays.delete(canvas);
  }
  if (removeLayers && state.canvasUnderlayStyle) {
    state.canvasUnderlayStyle.remove();
    state.canvasUnderlayStyle = null;
  }
}

function renderDomSentenceHighlights() {
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== 'function') return;
  clearDomHighlights();
  if (!state.settings.sentenceHighlight || state.activeSentence < 0) return;
  const active = state.sentenceRanges[state.activeSentence];
  if (active?.range) CSS.highlights.set('focus-reader-sentence-active', new Highlight(active.range));
  const previous = state.sentenceRanges[state.activeSentence - 1];
  if (previous?.range) CSS.highlights.set(PREVIOUS_SENTENCE_HIGHLIGHT, new Highlight(previous.range));
  const next = state.sentenceRanges[state.activeSentence + 1];
  if (next?.range) CSS.highlights.set(NEXT_SENTENCE_HIGHLIGHT, new Highlight(next.range));
}

function isVisibleTextElement(element, requireViewport = true) {
  if (!(element instanceof HTMLElement) || element.closest('#focus-reader-assist-root') || hasExcludedContext(element)) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width >= 160 && rect.height >= 16 && (!requireViewport || (rect.bottom > 0 && rect.top < window.innerHeight));
}

function textNodeIsReadable(node) {
  const parent = node.parentElement;
  if (!node.nodeValue?.trim() || !parent || parent.closest('#focus-reader-assist-root') || hasExcludedContext(parent)) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  return [...range.getClientRects()].some((rect) => rect.width > 1 && rect.height > 1);
}

function rootStats(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => textNodeIsReadable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  let chinese = 0;
  let punctuation = 0;
  let nodes = 0;
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue || '';
    chinese += (value.match(/[\u3400-\u9fff]/g) || []).length;
    punctuation += (value.match(/[。！？!?]/g) || []).length;
    nodes += 1;
  }
  return { chinese, punctuation, nodes };
}

function readingRoot() {
  const { width, height } = viewportSize();
  const roots = [...document.querySelectorAll(READER_ROOT_SELECTOR)];
  const candidates = roots.map((element) => {
    if (!isVisibleTextElement(element)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < width * 0.3 || rect.height < height * 0.1) return null;
    const stats = rootStats(element);
    if (stats.chinese < 12 || stats.nodes < 1) return null;
    const classText = `${element.id || ''} ${element.className || ''}`.toLowerCase();
    const hint = /(reader|chapter|content|article|main)/.test(classText) ? 700 : 0;
    return { element, score: stats.chinese + stats.punctuation * 40 + stats.nodes * 20 + hint };
  }).filter(Boolean);
  return candidates.sort((left, right) => right.score - left.score)[0]?.element || null;
}

function nearestTextBlock(node, root) {
  let element = node.parentElement;
  while (element instanceof HTMLElement && element !== root) {
    const display = getComputedStyle(element).display;
    if (['P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4'].includes(element.tagName) && /(block|list-item|flow-root|table-cell)/.test(display)) return element;
    element = element.parentElement;
  }
  return root;
}

function readableSentenceBlocks() {
  const root = readingRoot();
  if (!root) return { root: null, blocks: [] };
  const groups = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => textNodeIsReadable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  let node;
  while ((node = walker.nextNode())) {
    const block = nearestTextBlock(node, root);
    if (!isVisibleTextElement(block, false)) continue;
    const nodes = groups.get(block) || [];
    nodes.push(node);
    groups.set(block, nodes);
  }
  const blocks = [...groups.entries()]
    .map(([element, nodes]) => ({ element, nodes, value: nodes.map((item) => item.nodeValue || '').join('') }))
    .filter((block) => block.value.replace(/\s+/g, '').length >= 8 && (block.value.match(/[\u3400-\u9fff]/g) || []).length >= 4);
  return { root, blocks };
}

function rangePoint(nodes, offset, end = false) {
  let cursor = 0;
  for (const node of nodes) {
    const length = node.nodeValue?.length || 0;
    if (offset < cursor + length || (end && offset === cursor + length)) return { node, offset: Math.max(0, Math.min(length, offset - cursor)) };
    cursor += length;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last?.nodeValue?.length || 0 };
}

function fallbackSentenceSegments(text) {
  const result = [];
  const matcher = /[^。！？!?]+[。！？!?]?/g;
  let match;
  while ((match = matcher.exec(text))) result.push({ index: match.index, segment: match[0] });
  return result.length ? result : [{ index: 0, segment: text }];
}

function canvasElements() {
  return [...document.querySelectorAll(`.wr_canvasContainer canvas[${CAPTURE_ATTRIBUTE}],.readerChapterContent canvas[${CAPTURE_ATTRIBUTE}]`)]
    .filter((canvas) => canvas instanceof HTMLCanvasElement && canvas.isConnected && canvas.getBoundingClientRect().width > 20);
}

function readingCanvasElements() {
  const canvases = canvasElements();
  const visible = canvases.filter((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return rect.height > 20
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < window.innerWidth
      && rect.top < window.innerHeight;
  });
  return visible.length ? visible : canvases;
}

function normalizedCaptureRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const canvasId = String(record.canvasId || '').slice(0, 64);
  if (!/^focus-canvas-\d+$/.test(canvasId)) return null;
  const generation = Math.max(0, Math.min(2147483647, Math.trunc(finite(record.generation))));
  if (record.kind === 'reset') return { kind: 'reset', canvasId, generation };
  const paint = Math.max(0, Math.min(2147483647, Math.trunc(finite(record.paint))));
  if (record.kind === 'erase') {
    const left = finite(record.left);
    const top = finite(record.top);
    const width = Math.max(0, Math.min(100000, finite(record.width)));
    const height = Math.max(0, Math.min(100000, finite(record.height)));
    if (!width || !height) return null;
    return { kind: 'erase', canvasId, generation, paint, order: Math.max(0, Math.trunc(finite(record.order))), left, top, width, height };
  }
  if (record.kind !== 'glyph') return null;
  const text = String(record.text || '').slice(0, 128);
  if (!text) return null;
  const transform = Array.isArray(record.transform) && record.transform.length === 6 ? record.transform.map((value) => finite(value)) : [1, 0, 0, 1, 0, 0];
  const metrics = record.metrics && typeof record.metrics === 'object' ? record.metrics : {};
  return {
    kind: 'glyph',
    canvasId,
    generation,
    paint,
    order: Math.max(0, Math.trunc(finite(record.order))),
    text,
    x: finite(record.x),
    y: finite(record.y),
    font: String(record.font || '').slice(0, 160),
    transform,
    metrics: {
      width: finite(metrics.width),
      actualBoundingBoxLeft: finite(metrics.actualBoundingBoxLeft),
      actualBoundingBoxRight: finite(metrics.actualBoundingBoxRight),
      actualBoundingBoxAscent: finite(metrics.actualBoundingBoxAscent),
      actualBoundingBoxDescent: finite(metrics.actualBoundingBoxDescent),
    },
  };
}

function pullCanvasCapture() {
  if (!canvasCaptureSupported) return;
  let batch;
  try {
    batch = contextBridge.executeInMainWorld({
      func: (captureKey) => window[captureKey]?.pull?.(3000) || { installed: false, records: [] },
      args: [CAPTURE_KEY],
    });
  } catch {
    canvasCaptureSupported = false;
    canvasCaptureError = 'capture-pull-failed';
    scheduleSentenceRebuild();
    return;
  }
  if (!batch?.installed || !Array.isArray(batch.records)) return;
  state.canvasDropped = Math.max(0, Math.trunc(finite(batch.dropped)));
  let changed = false;
  for (const sourceRecord of batch.records.slice(0, 3000)) {
    const record = normalizedCaptureRecord(sourceRecord);
    if (!record) continue;
    const currentGeneration = state.canvasDrawGenerations.get(record.canvasId) ?? -1;
    if (record.generation < currentGeneration) continue;
    if (record.kind === 'reset') {
      state.canvasDrawGenerations.set(record.canvasId, record.generation);
      state.canvasDrawPaints.delete(record.canvasId);
      state.canvasDraws.set(record.canvasId, []);
      changed = true;
      continue;
    }
    if (record.generation > currentGeneration) {
      state.canvasDrawGenerations.set(record.canvasId, record.generation);
      state.canvasDrawPaints.delete(record.canvasId);
      state.canvasDraws.set(record.canvasId, []);
    }
    const currentPaint = state.canvasDrawPaints.get(record.canvasId) ?? -1;
    if (record.paint < currentPaint) continue;
    if (record.paint > currentPaint) {
      state.canvasDrawPaints.set(record.canvasId, record.paint);
      state.canvasDraws.set(record.canvasId, []);
    }
    const records = state.canvasDraws.get(record.canvasId) || [];
    if (record.kind === 'erase') {
      state.canvasDraws.set(record.canvasId, records.filter((draw) => !canvasRectsOverlap(canvasDrawBitmapBounds(draw), record)));
      changed = true;
      continue;
    }
    records.push(record);
    if (records.length > MAX_CAPTURED_DRAWS) records.splice(0, records.length - MAX_CAPTURED_DRAWS);
    state.canvasDraws.set(record.canvasId, records);
    changed = true;
  }
  if (changed) scheduleSentenceRebuild(90);
  refreshCanvasSignature();
}

function refreshCanvasSignature() {
  const canvases = canvasElements();
  const signature = canvases.map((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return `${canvas.getAttribute(CAPTURE_ATTRIBUTE)}:${canvas.width}x${canvas.height}:${Math.round(rect.width)}x${Math.round(rect.height)}`;
  }).join('|');
  if (signature === state.canvasSignature) return;
  state.canvasSignature = signature;
  scheduleSentenceRebuild(100);
}

function deduplicatedDraws(records) {
  const values = new Map();
  for (const record of records) {
    const matrix = record.transform.map((value) => Math.round(value * 100) / 100).join(',');
    const key = `${record.text}\u0000${Math.round(record.x * 10)}:${Math.round(record.y * 10)}:${record.font}:${matrix}`;
    values.set(key, record);
  }
  return [...values.values()].sort((left, right) => left.order - right.order);
}

function currentlyVisibleCanvasDraws(draws, canvas, rect) {
  const pixelCount = canvas.width * canvas.height;
  if (!pixelCount) return draws;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const projection = {
      canvasId: canvas.getAttribute(CAPTURE_ATTRIBUTE) || '',
      bitmapWidth: canvas.width,
      bitmapHeight: canvas.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
    };
    if (pixelCount > 12000000) {
      return draws.filter((draw) => {
        const glyph = projectCanvasDraw(draw, projection);
        return !glyph || canvasRegionHasInk(context, glyph, canvas.width, canvas.height, rect.width, rect.height);
      });
    }
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return draws;
    return draws.filter((draw) => {
      const glyph = projectCanvasDraw(draw, projection);
      return !glyph || canvasGlyphHasInk(glyph, pixels, canvas.width, canvas.height, rect.width, rect.height);
    });
  } catch {
    return draws;
  }
}

function canvasRegionHasInk(context, rect, bitmapWidth, bitmapHeight, cssWidth, cssHeight) {
  if (!context || !rect || !bitmapWidth || !bitmapHeight || !cssWidth || !cssHeight) return true;
  const scaleX = bitmapWidth / cssWidth;
  const scaleY = bitmapHeight / cssHeight;
  const left = Math.max(0, Math.floor(rect.left * scaleX) - 1);
  const top = Math.max(0, Math.floor(rect.top * scaleY) - 1);
  const right = Math.min(bitmapWidth, Math.ceil((rect.left + rect.width) * scaleX) + 1);
  const bottom = Math.min(bitmapHeight, Math.ceil((rect.top + rect.height) * scaleY) + 1);
  if (right <= left || bottom <= top) return true;
  try {
    const width = right - left;
    const height = bottom - top;
    const pixels = context.getImageData(left, top, width, height).data;
    return canvasGlyphHasInk({ left: 0, top: 0, width, height }, pixels, width, height, width, height);
  } catch {
    return true;
  }
}

function buildCapturedCanvasSentences() {
  const canvases = readingCanvasElements();
  if (!canvases.length) {
    state.canvasFirstSeenAt = 0;
    return { canvases: 0, sentences: [] };
  }
  if (!state.canvasFirstSeenAt) state.canvasFirstSeenAt = Date.now();
  const sentences = [];
  canvases.forEach((canvas, canvasIndex) => {
    const canvasId = canvas.getAttribute(CAPTURE_ATTRIBUTE) || '';
    const rect = canvas.getBoundingClientRect();
    const capturedDraws = deduplicatedDraws(state.canvasDraws.get(canvasId) || []);
    const draws = currentlyVisibleCanvasDraws(capturedDraws, canvas, rect);
    const built = buildCanvasSentences(draws, {
      canvasId,
      bitmapWidth: canvas.width,
      bitmapHeight: canvas.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
    });
    built.forEach((sentence) => sentences.push({ ...sentence, canvas, canvasId, canvasIndex }));
  });
  sentences.sort((left, right) => left.canvasIndex - right.canvasIndex || left.fragments[0].top - right.fragments[0].top || left.firstOrder - right.firstOrder);
  return { canvases: canvases.length, sentences: sentences.slice(0, MAX_SENTENCES) };
}

function restoreActiveIndex(items, previousAnchor) {
  if (!items.length) return -1;
  if (state.pendingSentenceDirection) {
    const index = state.pendingSentenceDirection > 0 ? 0 : items.length - 1;
    state.pendingSentenceDirection = 0;
    window.clearTimeout(state.pendingSentenceTimer);
    return index;
  }
  if (previousAnchor) {
    const matches = items.map((item, index) => ({ item, index })).filter(({ item }) => item.text === previousAnchor.text);
    if (matches.length) return matches.reduce((best, current) => {
      const top = current.item.fragments?.[0]?.top ?? current.item.range?.getBoundingClientRect().top ?? 0;
      const bestTop = best.item.fragments?.[0]?.top ?? best.item.range?.getBoundingClientRect().top ?? 0;
      return Math.abs(top - previousAnchor.top) < Math.abs(bestTop - previousAnchor.top) ? current : best;
    }).index;
  }
  // A new chapter has no matching active sentence. Start its focus sequence
  // from the chapter opening instead of choosing whichever sentence is central.
  return 0;
}

function rebuildCanvasHighlights(previousAnchor) {
  const capture = buildCapturedCanvasSentences();
  if (!capture.canvases) {
    const retainedCanvas = state.canvasSentences.find((item) => item.canvas?.isConnected);
    if (state.sentenceSource === 'canvas' && retainedCanvas) {
      state.activeSentence = restoreActiveIndex(state.canvasSentences, previousAnchor);
      return true;
    }
    return false;
  }
  clearDomHighlights();
  state.sentenceRanges = [];
  state.readerRoot = document.querySelector('.readerChapterContent');
  if (!canvasCaptureSupported) {
    state.canvasSentences = [];
    state.sentenceSource = 'canvas';
    clearCanvasHighlights();
    diagnostic('unsupported', 'canvas', 0, capture.canvases, canvasCaptureError || 'canvas-capture-unavailable');
    return true;
  }
  if (!capture.sentences.length) {
    state.canvasSentences = [];
    state.sentenceSource = 'canvas';
    clearCanvasHighlights();
    const elapsed = state.canvasFirstSeenAt ? Date.now() - state.canvasFirstSeenAt : 0;
    diagnostic(elapsed > 6000 ? 'error' : 'scanning', 'canvas', 0, capture.canvases, elapsed > 6000 ? 'canvas-text-not-captured' : 'waiting-canvas-text');
    return true;
  }
  state.canvasSentences = capture.sentences;
  state.sentenceSource = 'canvas';
  state.activeSentence = restoreActiveIndex(state.canvasSentences, previousAnchor);
  renderCanvasHighlights();
  renderOverlay(false);
  diagnostic('ready', 'canvas', state.canvasSentences.length, capture.canvases, state.canvasDropped ? 'capture-buffer-trimmed' : '');
  return true;
}

function rebuildDomHighlights(previousAnchor) {
  state.canvasSentences = [];
  clearCanvasHighlights(true);
  clearDomHighlights();
  state.sentenceRanges = [];
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== 'function') {
    state.sentenceSource = 'dom';
    diagnostic('unsupported', 'dom', 0, 0, 'custom-highlight-unavailable');
    return;
  }
  ensureSentenceStyle();
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh-CN', { granularity: 'sentence' }) : null;
  const source = readableSentenceBlocks();
  observeReaderRoot(source.root);
  for (const block of source.blocks) {
    const { element, nodes, value: text } = block;
    const segments = segmenter ? [...segmenter.segment(text)] : fallbackSentenceSegments(text);
    for (const part of segments) {
      let start = Number(part.index) || 0;
      let end = start + String(part.segment || '').length;
      while (start < end && /\s/.test(text[start])) start += 1;
      while (end > start && /\s/.test(text[end - 1])) end -= 1;
      if (end - start < 2) continue;
      const from = rangePoint(nodes, start);
      const to = rangePoint(nodes, end, true);
      if (!from.node || !to.node) continue;
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      const item = { range, element, text: range.toString() };
      state.sentenceRanges.push(item);
      if (state.sentenceRanges.length >= MAX_SENTENCES) break;
    }
    if (state.sentenceRanges.length >= MAX_SENTENCES) break;
  }
  state.sentenceSource = 'dom';
  if (!state.sentenceRanges.length) {
    state.activeSentence = -1;
    diagnostic('scanning', 'dom', 0, source.blocks.length, 'waiting-readable-text');
    return;
  }
  state.activeSentence = restoreActiveIndex(state.sentenceRanges, previousAnchor);
  activateSentence(state.activeSentence, false);
  diagnostic('ready', 'dom', state.sentenceRanges.length, source.blocks.length);
}

function rebuildSentenceHighlights() {
  const previous = currentSentence();
  const previousAnchor = previous ? sentenceAnchor(previous) : state.activeSentenceAnchor;
  state.activeSentence = -1;
  if (!state.settings.sentenceHighlight) {
    state.sentenceSource = 'none';
    state.sentenceRanges = [];
    state.canvasSentences = [];
    clearDomHighlights();
    clearCanvasHighlights(true);
    diagnostic('scanning', 'none', 0, 0, 'disabled');
    renderOverlay(false);
    return;
  }
  try {
    if (rebuildCanvasHighlights(previousAnchor)) return;
    rebuildDomHighlights(previousAnchor);
  } catch {
    state.sentenceRanges = [];
    state.canvasSentences = [];
    clearDomHighlights();
    clearCanvasHighlights(true);
    diagnostic('error', state.sentenceSource === 'canvas' ? 'canvas' : 'dom', 0, 0, 'rebuild-failed');
  }
}

function scheduleSentenceRebuild(delay = 380) {
  window.clearTimeout(state.sentenceRebuildTimer);
  state.sentenceRebuildTimer = window.setTimeout(rebuildSentenceHighlights, delay);
}

function observeReaderRoot(root) {
  if (root === state.readerRoot && state.sentenceObserver) return;
  state.sentenceObserver?.disconnect();
  state.readerRoot = root;
  state.sentenceObserver = null;
  if (!root) return;
  state.sentenceObserver = new MutationObserver(() => scheduleSentenceRebuild());
  state.sentenceObserver.observe(root, { childList: true, subtree: true, characterData: true });
}

function currentSentence() {
  if (state.sentenceSource === 'canvas') return state.canvasSentences[state.activeSentence];
  if (state.sentenceSource === 'dom') return state.sentenceRanges[state.activeSentence];
  return null;
}

function canvasFragmentScreenRect(item, fragment) {
  const canvasRect = item.canvas.getBoundingClientRect();
  return {
    left: canvasRect.left + fragment.left,
    top: canvasRect.top + fragment.top,
    width: fragment.width,
    height: fragment.height,
    right: canvasRect.left + fragment.left + fragment.width,
    bottom: canvasRect.top + fragment.top + fragment.height,
  };
}

function itemScreenFragments(item) {
  if (!item) return [];
  if (item.fragments && item.canvas?.isConnected) return item.fragments.map((fragment) => canvasFragmentScreenRect(item, fragment));
  if (item.range) return [...item.range.getClientRects()].map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }));
  return [];
}

function itemScreenBounds(item) {
  const rects = itemScreenFragments(item);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function calibrateCanvasHighlightBounds(rect) {
  const left = finite(rect?.left);
  const top = finite(rect?.top);
  const width = Math.max(1, finite(rect?.width, 1));
  const height = Math.max(1, finite(rect?.height, 1));
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

function canvasHighlightFragments(sentences, activeIndex) {
  const result = [];
  (sentences || []).forEach((sentence, sentenceIndex) => {
    const role = sentenceContextLevel(sentenceIndex, activeIndex);
    if (role === -1) return;
    (sentence.fragments || []).forEach((fragment) => {
      const bounds = calibrateCanvasHighlightBounds(fragment);
      result.push({ sentenceIndex, role, canvasId: fragment.canvasId || '', lineIndex: Number(fragment.lineIndex) || 0, ...bounds });
    });
  });
  return result;
}

function sentenceAnchor(item) {
  const rect = itemScreenBounds(item);
  return { text: item?.text || item?.range?.toString() || '', top: item?.fragments?.[0]?.top ?? rect?.top ?? 0, left: item?.fragments?.[0]?.left ?? rect?.left ?? 0 };
}

function renderCanvasHighlights() {
  ensureOverlay();
  if (!state.highlightLayer) return;
  if (!state.settings.sentenceHighlight) {
    clearCanvasHighlights(true);
    return;
  }
  clearCanvasHighlights();
  const fallbackFragment = document.createDocumentFragment();
  const underlayFragments = new Map();
  const canvasContexts = new Map();
  const canvasOffsets = new Map();
  canvasHighlightFragments(state.canvasSentences, state.activeSentence).forEach((entry) => {
    const sentence = state.canvasSentences[entry.sentenceIndex];
    if (!sentence) return;
    const canvas = sentence.canvas;
    const canvasRect = canvas?.getBoundingClientRect();
    if (canvas && canvasRect?.width && canvasRect.height) {
      let context = canvasContexts.get(canvas);
      if (context === undefined) {
        try { context = canvas.getContext('2d', { willReadFrequently: true }); } catch { context = null; }
        canvasContexts.set(canvas, context);
      }
      if (context && !canvasRegionHasInk(context, entry, canvas.width, canvas.height, canvasRect.width, canvasRect.height)) return;
    }
    const active = entry.role === ACTIVE_SENTENCE;
    const color = sentenceHighlightColor(entry.role);
    const underlay = ensureCanvasUnderlay(sentence.canvas);
    if (underlay) {
      let offset = canvasOffsets.get(sentence.canvas);
      if (!offset) {
        const container = sentence.canvas.parentElement;
        const canvasRect = sentence.canvas.getBoundingClientRect();
        const containerRect = container?.getBoundingClientRect();
        offset = {
          left: containerRect ? canvasRect.left - containerRect.left : 0,
          top: containerRect ? canvasRect.top - containerRect.top : 0,
        };
        canvasOffsets.set(sentence.canvas, offset);
      }
      const fragment = underlayFragments.get(underlay) || document.createDocumentFragment();
      const block = document.createElement('span');
      block.className = active ? 'focus-reader-sentence-fragment is-active' : 'focus-reader-sentence-fragment';
      block.style.left = `${entry.left + offset.left}px`;
      block.style.top = `${entry.top + offset.top}px`;
      block.style.width = `${entry.width}px`;
      block.style.height = `${entry.height}px`;
      block.style.background = color;
      fragment.append(block);
      underlayFragments.set(underlay, fragment);
      return;
    }
    const fallbackCanvasRect = sentence.canvas?.getBoundingClientRect();
    const left = (fallbackCanvasRect?.left || 0) + entry.left;
    const top = (fallbackCanvasRect?.top || 0) + entry.top;
    if (top + entry.height < -20 || top > window.innerHeight + 20 || left + entry.width < 0 || left > window.innerWidth) return;
    const block = document.createElement('span');
    block.className = active ? 'sentence-fragment is-active' : 'sentence-fragment';
    block.style.left = `${left}px`;
    block.style.top = `${top}px`;
    block.style.width = `${entry.width}px`;
    block.style.height = `${entry.height}px`;
    block.style.background = color;
    fallbackFragment.append(block);
  });
  underlayFragments.forEach((fragment, layer) => layer.replaceChildren(fragment));
  state.highlightLayer.replaceChildren(fallbackFragment);
}

function activateSentence(index, scroll = true) {
  const items = state.sentenceSource === 'canvas' ? state.canvasSentences : state.sentenceRanges;
  if (!items.length) return;
  state.activeSentence = Math.max(0, Math.min(items.length - 1, index));
  const item = items[state.activeSentence];
  state.activeSentenceAnchor = sentenceAnchor(item);
  if (state.sentenceSource === 'canvas') {
    renderCanvasHighlights();
  } else if (globalThis.CSS?.highlights) {
    renderDomSentenceHighlights();
  }
  if (scroll) scrollSentenceIntoView(item);
  if (state.settings.mode === 'paragraph') window.setTimeout(() => renderOverlay(false), scroll ? 220 : 0);
}

function sentenceAtPoint(x, y) {
  if (state.sentenceSource === 'canvas') return state.canvasSentences.findIndex((item) => itemScreenFragments(item).some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom));
  const position = document.caretPositionFromPoint?.(x, y);
  const node = position?.offsetNode;
  const offset = position?.offset;
  if (node && typeof offset === 'number') return state.sentenceRanges.findIndex((item) => {
    try { return item.range.isPointInRange(node, offset); } catch { return false; }
  });
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range) return -1;
  return state.sentenceRanges.findIndex((item) => {
    try { return item.range.isPointInRange(range.startContainer, range.startOffset); } catch { return false; }
  });
}

function moveSentence(direction) {
  const items = state.sentenceSource === 'canvas' ? state.canvasSentences : state.sentenceRanges;
  if (!items.length) rebuildSentenceHighlights();
  const refreshed = state.sentenceSource === 'canvas' ? state.canvasSentences : state.sentenceRanges;
  if (!refreshed.length) return;
  const index = state.activeSentence < 0 ? 0 : state.activeSentence;
  const nextIndex = index + direction;
  const next = refreshed[nextIndex];
  if (!next) {
    if (isHorizontalReader()) requestReaderPage(direction);
    return;
  }
  if (isHorizontalReader() && !sentenceIsOnScreen(next)) {
    requestReaderPage(direction);
    return;
  }
  activateSentence(nextIndex);
}

function sentenceIsOnScreen(item) {
  return itemScreenFragments(item).some((rect) => rect.right > 1 && rect.left < window.innerWidth - 1 && rect.bottom > 1 && rect.top < window.innerHeight - 1);
}

function isHorizontalReader() {
  return Boolean(state.readerRoot?.closest?.('.wr_horizontalReader') || document.querySelector('.wr_horizontalReader'));
}

function requestReaderPage(direction) {
  state.pendingSentenceDirection = direction;
  window.clearTimeout(state.pendingSentenceTimer);
  state.pendingSentenceTimer = window.setTimeout(() => { state.pendingSentenceDirection = 0; }, 1800);
  ipcRenderer.send('weread-assist:page', { direction });
}

function ensureOverlay() {
  if (state.host?.isConnected || !document.documentElement) return;
  const host = document.createElement('div');
  host.id = 'focus-reader-assist-root';
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .highlights { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
    .sentence-fragment { position: fixed; border-radius: 0; mix-blend-mode: multiply; box-sizing: border-box; }
    .sentence-fragment.is-active { border-bottom: 2px solid rgba(37, 112, 190, .72); box-shadow: 0 0 0 1px rgba(54, 132, 210, .18); }
    .frame { position: fixed; border: 1px solid rgba(24, 126, 100, .72); border-radius: 5px; box-shadow: 0 0 0 200vmax rgba(17, 25, 21, var(--focus-dimming)); transition: top 90ms ease-out, left 90ms ease-out, width 90ms ease-out, height 90ms ease-out, opacity 120ms ease; pointer-events: none; }
    .frame.no-motion { transition: opacity 120ms ease; }
    .guide { position: fixed; height: 2px; background: rgba(225, 124, 54, .92); box-shadow: 0 1px 5px rgba(100, 51, 20, .22); pointer-events: none; }
  `;
  const highlights = document.createElement('div');
  highlights.className = 'highlights';
  const frame = document.createElement('div');
  frame.className = 'frame';
  const line = document.createElement('div');
  line.className = 'guide';
  shadow.append(style, highlights, frame, line);
  document.documentElement.append(host);
  state.host = host;
  state.highlightLayer = highlights;
  state.frame = frame;
  state.line = line;
}

function viewportSize() {
  return { width: Math.max(1, document.documentElement?.clientWidth || window.innerWidth), height: Math.max(1, document.documentElement?.clientHeight || window.innerHeight) };
}

function setFrame(rect, motion = true) {
  ensureOverlay();
  if (!state.frame || !state.line) return;
  const { width: viewportWidth, height: viewportHeight } = viewportSize();
  const left = Math.max(0, Math.min(viewportWidth - 1, rect.left));
  const top = Math.max(0, Math.min(viewportHeight - 1, rect.top));
  const width = Math.max(1, Math.min(viewportWidth - left, rect.width));
  const height = Math.max(1, Math.min(viewportHeight - top, rect.height));
  state.frame.classList.toggle('no-motion', !motion);
  state.frame.style.setProperty('--focus-dimming', String(state.settings.dimming));
  state.frame.style.left = `${left}px`;
  state.frame.style.top = `${top}px`;
  state.frame.style.width = `${width}px`;
  state.frame.style.height = `${height}px`;
  state.frame.style.opacity = focusOverlayEnabled() ? '1' : '0';
  state.line.style.display = focusOverlayEnabled() && state.settings.showGuideLine ? 'block' : 'none';
  state.line.style.left = `${left}px`;
  state.line.style.top = `${Math.min(viewportHeight - 2, top + height)}px`;
  state.line.style.width = `${width}px`;
}

function blockAtPoint(x, y) {
  const target = document.elementFromPoint(x, y);
  if (!(target instanceof Element) || target.closest('.wr_canvasContainer')) return null;
  if (target.closest('button,input,textarea,select,[role="button"],nav,header')) return null;
  const block = target.closest(BLOCK_SELECTOR);
  if (!(block instanceof HTMLElement)) return null;
  const rect = block.getBoundingClientRect();
  if (rect.width < 180 || rect.height < 18 || rect.height > window.innerHeight * 0.55 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
  return block;
}

function renderOverlay(motion = true) {
  const { width, height } = viewportSize();
  if (!focusOverlayEnabled()) {
    setFrame({ left: 0, top: height / 2, width, height: 1 }, motion);
    return;
  }
  if (state.settings.mode === 'paragraph') {
    const activeBounds = itemScreenBounds(currentSentence());
    if (activeBounds && activeBounds.height <= height * 0.42) {
      setFrame({
        left: Math.max(10, activeBounds.left - 12),
        top: Math.max(6, activeBounds.top - 8),
        width: Math.min(width - 20, activeBounds.width + 24),
        height: Math.min(height * 0.42, activeBounds.height + 16),
      }, motion);
      return;
    }
    if (state.activeBlock?.isConnected) {
      const rect = state.activeBlock.getBoundingClientRect();
      if (rect.bottom >= 0 && rect.top <= height && rect.width >= 180 && rect.height <= height * 0.55) {
        setFrame({ left: Math.max(10, rect.left - 12), top: Math.max(6, rect.top - 8), width: Math.min(width - 20, rect.width + 24), height: Math.min(height * 0.55, rect.height + 16) }, motion);
        return;
      }
    }
  }
  const center = state.pointerY || height * 0.48;
  const bandHeight = Math.min(height - 20, state.settings.bandHeight);
  setFrame({ left: 12, top: center - bandHeight / 2, width: width - 24, height: bandHeight }, motion);
}

function selectBlockAt(x, y) {
  const block = blockAtPoint(x, y);
  if (block) state.activeBlock = block;
  renderOverlay();
}

function collectReadableBlocks() {
  return readableSentenceBlocks().blocks.map((block) => block.element);
}

function moveBlock(direction) {
  if (state.sentenceSource === 'canvas' && state.canvasSentences.length) {
    moveSentence(direction);
    return;
  }
  const blocks = collectReadableBlocks();
  if (!blocks.length) return;
  let index = state.activeBlock ? blocks.indexOf(state.activeBlock) : -1;
  if (index < 0) {
    const center = window.innerHeight * 0.48;
    index = blocks.findIndex((block) => block.getBoundingClientRect().bottom >= center);
    if (index < 0) index = blocks.length - 1;
  } else {
    index = Math.max(0, Math.min(blocks.length - 1, index + direction));
  }
  state.activeBlock = blocks[index];
  state.activeBlock.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => renderOverlay(false), 220);
}

function findScrollContainer(startElement) {
  let element = startElement || state.activeBlock || document.elementFromPoint(state.pointerX || window.innerWidth / 2, state.pointerY || window.innerHeight / 2);
  while (element instanceof HTMLElement && element !== document.body) {
    const style = getComputedStyle(element);
    if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20) return element;
    element = element.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function scrollSentenceIntoView(item) {
  const rect = itemScreenBounds(item);
  const start = item?.canvas || item?.element;
  const container = findScrollContainer(start);
  if (!rect || !container) return;
  if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
    window.scrollBy({ top: rect.top + rect.height / 2 - window.innerHeight * 0.5, behavior: 'smooth' });
    return;
  }
  const containerRect = container.getBoundingClientRect();
  container.scrollBy({ top: rect.top + rect.height / 2 - (containerRect.top + container.clientHeight * 0.5), behavior: 'smooth' });
}

function autoScrollFrame(now) {
  if (!state.autoScroll) return;
  const elapsed = state.lastFrameAt ? Math.min(60, now - state.lastFrameAt) : 0;
  state.lastFrameAt = now;
  const container = state.scrollContainer || findScrollContainer();
  state.scrollContainer = container;
  if (container) container.scrollTop += state.autoScrollSpeed * elapsed / 1000;
  renderCanvasHighlights();
  renderOverlay(false);
  state.animationFrame = window.requestAnimationFrame(autoScrollFrame);
}

function setAutoScroll(active, speed) {
  state.autoScroll = active;
  state.autoScrollSpeed = speed;
  state.scrollContainer = findScrollContainer();
  state.lastFrameAt = 0;
  window.cancelAnimationFrame(state.animationFrame);
  if (active) state.animationFrame = window.requestAnimationFrame(autoScrollFrame);
}

function applySettings(settings) {
  state.settings = { ...state.settings, ...settings };
  ensureOverlay();
  if (!state.settings.sentenceHighlight) {
    clearDomHighlights();
    clearCanvasHighlights(true);
  }
  if (state.settings.mode === 'paragraph' && !state.activeBlock && state.sentenceSource !== 'canvas') state.activeBlock = blockAtPoint(window.innerWidth / 2, window.innerHeight * 0.48);
  renderOverlay(false);
  scheduleSentenceRebuild(80);
}

function mutationTouchesReader(mutations) {
  if (state.readerRoot && !state.readerRoot.isConnected) return true;
  return mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node instanceof Element && (node.matches?.('.readerChapterContent,.wr_canvasContainer,canvas') || node.querySelector?.('.readerChapterContent,.wr_canvasContainer,canvas'))));
}

function install() {
  ensureOverlay();
  state.pointerX = window.innerWidth / 2;
  state.pointerY = window.innerHeight * 0.48;
  diagnostic('scanning', 'none', 0, 0, 'waiting-reader');
  document.addEventListener('mousemove', (event) => {
    state.pointerX = event.clientX;
    state.pointerY = event.clientY;
    if (!focusOverlayEnabled() || !state.settings.followPointer) return;
    if (state.settings.mode === 'paragraph') selectBlockAt(event.clientX, event.clientY);
    else renderOverlay();
  }, { passive: true, capture: true });
  document.addEventListener('click', (event) => {
    if (state.settings.sentenceHighlight) {
      const sentenceIndex = sentenceAtPoint(event.clientX, event.clientY);
      if (sentenceIndex >= 0 && sentenceIndex !== state.activeSentence) activateSentence(sentenceIndex, false);
      return;
    }
    if (focusOverlayEnabled() && state.settings.mode === 'paragraph') selectBlockAt(event.clientX, event.clientY);
  }, { passive: true, capture: true });
  document.addEventListener('keydown', (event) => {
    if (!state.settings.sentenceHighlight || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input,textarea,select,[contenteditable="true"]')) return;
    const items = state.sentenceSource === 'canvas' ? state.canvasSentences : state.sentenceRanges;
    if (!items.length) rebuildSentenceHighlights();
    const refreshed = state.sentenceSource === 'canvas' ? state.canvasSentences : state.sentenceRanges;
    if (!refreshed.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    moveSentence(event.key === 'ArrowDown' ? 1 : -1);
  }, { capture: true });
  window.addEventListener('scroll', () => {
    if (state.sentenceSource === 'canvas') renderCanvasHighlights();
    renderOverlay(false);
  }, { passive: true, capture: true });
  window.addEventListener('resize', () => {
    refreshCanvasSignature();
    if (state.sentenceSource === 'canvas') renderCanvasHighlights();
    renderOverlay(false);
  }, { passive: true });
  window.addEventListener('popstate', () => scheduleSentenceRebuild(120));
  window.addEventListener('hashchange', () => scheduleSentenceRebuild(120));
  state.documentObserver = new MutationObserver((mutations) => {
    if (mutationTouchesReader(mutations)) scheduleSentenceRebuild(160);
  });
  state.documentObserver.observe(document.documentElement, { childList: true, subtree: true });
  state.capturePollTimer = window.setInterval(pullCanvasCapture, 220);
  pullCanvasCapture();
  scheduleSentenceRebuild(180);
  renderOverlay(false);
}

ipcRenderer.on('weread-assist:settings', (_event, settings) => applySettings(settings));
ipcRenderer.on('weread-assist:action', (_event, action) => {
  if (action.type === 'recenter') {
    state.pointerY = window.innerHeight * 0.48;
    state.activeBlock = blockAtPoint(window.innerWidth / 2, state.pointerY);
    renderOverlay();
  } else if (action.type === 'move') {
    moveBlock(action.direction);
  } else if (action.type === 'move-sentence') {
    moveSentence(action.direction);
  } else if (action.type === 'auto-scroll') {
    setAutoScroll(action.active, action.speed);
  }
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
