// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFlowSelection } from './selection';

describe('可重排文本定位', () => {
  it('以段落和字符偏移保存单段选区', () => {
    const host = document.createElement('div');
    host.innerHTML = '<article data-block-id="block-4">阅读 <strong>需要</strong> 留白</article>';
    document.body.append(host);
    const text = host.querySelector('strong')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(readFlowSelection(host)).toEqual({
      quote: '需要',
      locator: { kind: 'flow', blockId: 'block-4', start: 3, end: 5 },
    });
    host.remove();
  });
});
