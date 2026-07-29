// @vitest-environment node
import { describe, expect, it } from 'vitest';
import canvasAssist from '../electron/weread-canvas.cjs';

const { ACTIVE_SENTENCE, NEXT_SENTENCE, PREVIOUS_SENTENCE, buildCanvasSentences, calibrateCanvasHighlightBounds, canvasDrawBitmapBounds, canvasGlyphHasInk, canvasHighlightFragments, canvasRectsOverlap, discardErasedCanvasDraws, groupCanvasLines, projectCanvasDraw, sentenceContextLevel } = canvasAssist;

const canvas = { canvasId: 'chapter', bitmapWidth: 600, bitmapHeight: 1200, cssWidth: 200, cssHeight: 400 };

function draw(text: string, x: number, y: number, order: number) {
  return {
    canvasId: 'chapter',
    text,
    x,
    y,
    order,
    font: '48px sans-serif',
    transform: [3, 0, 0, 3, 0, 15],
    metrics: { width: 48, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 48, actualBoundingBoxAscent: 39, actualBoundingBoxDescent: 9 },
  };
}

describe('微信读书 Canvas 正文定位', () => {
  it('只选择上一句、主句和下一句', () => {
    const roles = Array.from({ length: 9 }, (_, index) => sentenceContextLevel(index, 4));
    expect(roles).toEqual([-1, -1, -1, PREVIOUS_SENTENCE, ACTIVE_SENTENCE, NEXT_SENTENCE, -1, -1, -1]);
  });

  it('将活动句与未选择句明确区分，并拒绝无效索引', () => {
    expect(sentenceContextLevel(0, 0)).toBe(ACTIVE_SENTENCE);
    expect(sentenceContextLevel(1, 0)).toBe(NEXT_SENTENCE);
    expect(sentenceContextLevel(3, 0)).toBe(-1);
    expect(sentenceContextLevel(-1, 0)).toBe(-1);
    expect(sentenceContextLevel(0, -1)).toBe(-1);
    expect(sentenceContextLevel(1.5, 0)).toBe(-1);
  });

  it('应用 CTM 与 bitmap/CSS 缩放投影字形', () => {
    const glyph = projectCanvasDraw(draw('你', 10, 30, 1), canvas);
    expect(glyph).toMatchObject({ canvasId: 'chapter', text: '你', left: 10, width: 48, height: 48 });
    expect(glyph.top).toBeCloseTo(-4);
    expect(glyph.baselineY).toBeCloseTo(35);
  });

  it('丢弃已从 Canvas 擦除的旧字形记录', () => {
    const bitmapWidth = 30;
    const bitmapHeight = 30;
    const pixels = new Uint8ClampedArray(bitmapWidth * bitmapHeight * 4);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 255;
      pixels[index + 1] = 255;
      pixels[index + 2] = 255;
      pixels[index + 3] = 255;
    }
    const glyph = { left: 8, top: 8, width: 12, height: 12 };
    expect(canvasGlyphHasInk(glyph, pixels, bitmapWidth, bitmapHeight, bitmapWidth, bitmapHeight)).toBe(false);

    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = 0;
    }
    expect(canvasGlyphHasInk(glyph, pixels, bitmapWidth, bitmapHeight, bitmapWidth, bitmapHeight)).toBe(false);

    for (let y = 10; y < 18; y += 1) {
      for (let x = 10; x < 18; x += 1) {
        const offset = (y * bitmapWidth + x) * 4;
        pixels[offset] = 232;
        pixels[offset + 1] = 232;
        pixels[offset + 2] = 232;
      }
    }
    expect(canvasGlyphHasInk(glyph, pixels, bitmapWidth, bitmapHeight, bitmapWidth, bitmapHeight)).toBe(true);
  });

  it('局部擦除时剔除被覆盖的旧绘制，而不是保留空白色块', () => {
    const oldLine = draw('旧文字。', 30, 70, 1);
    const currentLine = draw('新文字。', 30, 150, 2);
    const erase = { left: 0, top: 0, width: 300, height: 300 };

    expect(canvasDrawBitmapBounds(oldLine)).toMatchObject({ left: 90, top: 108 });
    expect(canvasRectsOverlap(canvasDrawBitmapBounds(oldLine), erase)).toBe(true);
    expect(discardErasedCanvasDraws([oldLine, currentLine], erase)).toEqual([currentLine]);
  });

  it('擦除区域未触及文字时保留现有绘制', () => {
    const currentLine = draw('当前文字。', 30, 150, 1);
    const erase = { left: 500, top: 500, width: 80, height: 80 };
    expect(discardErasedCanvasDraws([currentLine], erase)).toEqual([currentLine]);
  });

  it('为 Canvas 色块保留上下对称的光学留白', () => {
    const source = { left: 20, top: 30, width: 120, height: 40 };
    const calibrated = calibrateCanvasHighlightBounds(source);
    expect(calibrated).toEqual({ left: 18, top: 26, width: 124, height: 48 });
    const sourceBottom = source.top + source.height;
    const calibratedBottom = calibrated.top + calibrated.height;
    expect(calibrated.top).toBeLessThan(source.top);
    expect(calibratedBottom).toBeGreaterThan(sourceBottom);
    expect(calibratedBottom - sourceBottom).toBe(4);
    expect(source.top - calibrated.top).toBe(4);
  });

  it('保留相邻三句各自的真实文本边界', () => {
    const fragments = canvasHighlightFragments([
      { fragments: [{ canvasId: 'chapter', lineIndex: 0, left: 10, top: 30, width: 20, height: 40 }] },
      { fragments: [{ canvasId: 'chapter', lineIndex: 0, left: 42, top: 32, width: 20, height: 36 }] },
      { fragments: [{ canvasId: 'chapter', lineIndex: 0, left: 74, top: 31, width: 20, height: 38 }] },
    ], 1);
    expect(fragments.map((item: { role: string }) => item.role)).toEqual([PREVIOUS_SENTENCE, ACTIVE_SENTENCE, NEXT_SENTENCE]);
    expect(fragments).toMatchObject([
      { left: 8, top: 26, width: 24, height: 48 },
      { left: 40, top: 29, width: 24, height: 42 },
      { left: 72, top: 27, width: 24, height: 46 },
    ]);
    expect(fragments[0].left + fragments[0].width).toBeLessThan(fragments[1].left);
    expect(fragments[1].left + fragments[1].width).toBeLessThan(fragments[2].left);
  });

  it('不把同一行中相距很远的错误片段补成横条', () => {
    const fragments = canvasHighlightFragments([
      { fragments: [{ canvasId: 'chapter', lineIndex: 0, left: 10, top: 30, width: 20, height: 40 }] },
      { fragments: [{ canvasId: 'chapter', lineIndex: 0, left: 420, top: 34, width: 20, height: 36 }] },
    ], 1);

    expect(fragments).toHaveLength(2);
    expect(fragments[0]).toMatchObject({ left: 8, top: 26, width: 24, height: 48 });
    expect(fragments[1]).toMatchObject({ left: 418, top: 31, width: 24, height: 42 });
    expect(fragments[0].left + fragments[0].width).toBeLessThan(fragments[1].left);
  });

  it('让连续视觉行分别保持每一句的色块边界', () => {
    const fragments = canvasHighlightFragments([
      { fragments: [{ canvasId: 'chapter', lineIndex: 0, left: 10, top: 30, width: 20, height: 40 }] },
      { fragments: [
        { canvasId: 'chapter', lineIndex: 0, left: 42, top: 32, width: 20, height: 36 },
        { canvasId: 'chapter', lineIndex: 1, left: 10, top: 102, width: 20, height: 38 },
      ] },
      { fragments: [{ canvasId: 'chapter', lineIndex: 1, left: 42, top: 100, width: 20, height: 40 }] },
    ], 1);
    const firstLine = fragments.filter((item: { lineIndex: number }) => item.lineIndex === 0);
    const secondLine = fragments.filter((item: { lineIndex: number }) => item.lineIndex === 1);

    expect(firstLine).toHaveLength(2);
    expect(secondLine).toHaveLength(2);
    expect(firstLine[0].top).not.toBe(firstLine[1].top);
    expect(firstLine[0].height).not.toBe(firstLine[1].height);
    expect(secondLine[0].top).not.toBe(secondLine[1].top);
    expect(secondLine[0].height).not.toBe(secondLine[1].height);
    expect(firstLine[0].left + firstLine[0].width).toBeLessThan(firstLine[1].left);
    expect(secondLine[0].left + secondLine[0].width).toBeLessThan(secondLine[1].left);
    const firstBottom = firstLine[0].top + firstLine[0].height;
    const secondTop = secondLine[0].top;
    expect(fragments).toHaveLength(4);
    expect(secondTop).toBeGreaterThan(firstBottom);
  });

  it('按基线分行并按横向位置恢复绘制顺序', () => {
    const glyphs = [
      projectCanvasDraw(draw('界', 58, 30, 2), canvas),
      projectCanvasDraw(draw('下', 10, 90, 3), canvas),
      projectCanvasDraw(draw('你', 10, 30, 1), canvas),
    ];
    const lines = groupCanvasLines(glyphs);
    expect(lines).toHaveLength(2);
    expect(lines[0].glyphs.map((item: { text: string }) => item.text).join('')).toBe('你界');
    expect(lines[1].glyphs.map((item: { text: string }) => item.text).join('')).toBe('下');
  });

  it('跨行分句并生成每行独立的色块片段', () => {
    const records = [
      draw('第', 10, 30, 1), draw('一', 58, 30, 2), draw('句', 106, 30, 3), draw('。', 154, 30, 4),
      draw('第', 10, 90, 5), draw('二', 58, 90, 6), draw('句', 106, 90, 7),
      draw('跨', 10, 150, 8), draw('行', 58, 150, 9), draw('！', 106, 150, 10),
    ];
    const sentences = buildCanvasSentences(records, canvas);
    expect(sentences.map((item: { text: string }) => item.text)).toEqual(['第一句。', '第二句跨行！']);
    expect(sentences[0].fragments).toHaveLength(1);
    expect(sentences[1].fragments).toHaveLength(2);
    expect(sentences[1].fragments[1].top).toBeGreaterThan(sentences[1].fragments[0].top);
  });

  it('同一行将整句、标点与字距合并为连续色块', () => {
    const punctuation = {
      ...draw('。', 166, 30, 3),
      metrics: { width: 24, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 24, actualBoundingBoxAscent: 18, actualBoundingBoxDescent: 4 },
    };
    const sentences = buildCanvasSentences([draw('短', 10, 30, 1), draw('句', 58, 30, 2), punctuation], canvas);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].fragments).toHaveLength(1);
    expect(sentences[0].fragments[0].height).toBeCloseTo(48);
  });

  it('不将同一句中的远距离陈旧绘制合并成色块', () => {
    const sentences = buildCanvasSentences([
      draw('甲', 10, 30, 1),
      draw('乙。', 400, 30, 2),
    ], canvas);

    expect(sentences).toHaveLength(1);
    expect(sentences[0].fragments).toHaveLength(2);
    expect(sentences[0].fragments[0].left + sentences[0].fragments[0].width).toBeLessThan(sentences[0].fragments[1].left);
  });

  it('不让同一视觉行中另一句的下探字形撑大当前句的色块', () => {
    const deepDescender = {
      ...draw('下', 178, 30, 4),
      metrics: { width: 48, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 48, actualBoundingBoxAscent: 39, actualBoundingBoxDescent: 30 },
    };
    const sentences = buildCanvasSentences([
      draw('短', 10, 30, 1),
      draw('句', 58, 30, 2),
      draw('。', 106, 30, 3),
      deepDescender,
      draw('。', 226, 30, 5),
    ], canvas);
    expect(sentences.map((item: { text: string }) => item.text)).toEqual(['短句。', '下。']);
    expect(sentences[0].fragments[0].height).toBeCloseTo(48);
    expect(sentences[1].fragments[0].height).toBeCloseTo(69);
  });
});
