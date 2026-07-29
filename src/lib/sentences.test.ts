// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectSentenceItems, SentenceHighlighter, sentenceHighlightGroups } from './sentences';

describe('本地按句分块', () => {
  it('在同一段落的嵌套节点间保持句子范围', () => {
    const block = document.createElement('article');
    block.innerHTML = '第一句。<strong>第二</strong>句！第三句？';
    document.body.append(block);

    expect(collectSentenceItems([block]).map((item) => item.text)).toEqual(['第一句。', '第二句！', '第三句？']);
    block.remove();
  });

  it('忽略仅包含空白的文本节点', () => {
    const block = document.createElement('p');
    block.textContent = '  需要保留。  继续阅读。 ';
    document.body.append(block);

    expect(collectSentenceItems([block]).map((item) => item.text)).toEqual(['需要保留。', '继续阅读。']);
    block.remove();
  });

  it('只保留上一句、当前句和下一句', () => {
    expect(sentenceHighlightGroups(12, 6)).toEqual({
      previous: [5],
      active: [6],
      next: [7],
    });
  });

  it('在章节边界裁掉不存在的相邻句', () => {
    expect(sentenceHighlightGroups(4, 0)).toEqual({
      previous: [],
      active: [0],
      next: [1],
    });
    expect(sentenceHighlightGroups(4, 3)).toEqual({ previous: [2], active: [3], next: [] });
    expect(sentenceHighlightGroups(0, -1)).toEqual({ previous: [], active: [], next: [] });
  });

  it('主句移动在当前章节首尾停住', () => {
    const block = document.createElement('p');
    block.textContent = '第一句。第二句。';
    document.body.append(block);
    const highlighter = new SentenceHighlighter(document, () => undefined);
    try {
      highlighter.rebuild([block]);
      expect(highlighter.move(-1)).toBe(false);
      expect(highlighter.state.activeIndex).toBe(0);
      highlighter.activate(1);
      expect(highlighter.move(1)).toBe(false);
      expect(highlighter.state.activeIndex).toBe(1);
    } finally {
      highlighter.destroy();
      block.remove();
    }
  });

  it('首次进入章节时从开头第一句开始，而不是按视口中心选择', () => {
    const block = document.createElement('p');
    block.textContent = '章节第一句。章节第二句。章节第三句。';
    document.body.append(block);
    const highlighter = new SentenceHighlighter(document, () => undefined);
    try {
      highlighter.rebuild([block]);
      expect(highlighter.state).toEqual({ count: 3, activeIndex: 0 });
    } finally {
      highlighter.destroy();
      block.remove();
    }
  });

  it('非当前章节保留索引但清空全部句子色块', () => {
    const cssDescriptor = Object.getOwnPropertyDescriptor(window, 'CSS');
    const highlightDescriptor = Object.getOwnPropertyDescriptor(window, 'Highlight');
    const highlights = new Map<string, FakeHighlight>();
    class FakeHighlight {
      constructor(readonly ranges: Range[]) {}
    }
    Object.defineProperty(window, 'CSS', { configurable: true, value: { highlights } });
    Object.defineProperty(window, 'Highlight', {
      configurable: true,
      value: class {
        ranges: Range[];
        constructor(...ranges: Range[]) { this.ranges = ranges; }
      },
    });

    const block = document.createElement('p');
    block.textContent = '一。二。三。四。五。六。七。';
    document.body.append(block);
    const highlighter = new SentenceHighlighter(document, () => undefined);
    try {
      highlighter.rebuild([block]);
      highlighter.activate(3);
      expect([...highlights.values()].map((highlight) => highlight.ranges.length).sort()).toEqual([1, 1, 1]);

      highlighter.setVisible(false);
      expect(highlights.size).toBe(0);
      expect(highlighter.state).toEqual({ count: 7, activeIndex: 3 });

      highlighter.setVisible(true);
      expect([...highlights.values()].map((highlight) => highlight.ranges.length).sort()).toEqual([1, 1, 1]);
    } finally {
      highlighter.destroy();
      block.remove();
      if (cssDescriptor) Object.defineProperty(window, 'CSS', cssDescriptor);
      else delete (window as unknown as { CSS?: unknown }).CSS;
      if (highlightDescriptor) Object.defineProperty(window, 'Highlight', highlightDescriptor);
      else delete (window as unknown as { Highlight?: unknown }).Highlight;
    }
  });
});
