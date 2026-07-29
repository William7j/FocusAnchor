// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { adjacentFlowChapter, flowCatalog, flowChapterBlocks } from './FlowReader';
import type { FlowBlock } from '../types';

const blocks: FlowBlock[] = [
  { id: 'title', type: 'h1', text: '第一章', html: '第一章' },
  { id: 'one-a', type: 'p', text: '第一章第一句。', html: '第一章第一句。' },
  { id: 'part', type: 'h2', text: '第一节', html: '第一节' },
  { id: 'one-b', type: 'p', text: '第一节第一句。', html: '第一节第一句。' },
  { id: 'two', type: 'h1', text: '第二章', html: '第二章' },
  { id: 'two-a', type: 'p', text: '第二章第一句。', html: '第二章第一句。' },
];

describe('文本阅读目录与章节范围', () => {
  it('保留标题层级，并以同级标题界定章节', () => {
    const catalog = flowCatalog(blocks);
    expect(catalog.map((item) => [item.id, item.level])).toEqual([
      ['title', 0],
      ['part', 1],
      ['two', 0],
    ]);
    expect(flowChapterBlocks(blocks, catalog, 'title').map((block) => block.id)).toEqual(['title', 'one-a', 'part', 'one-b']);
    expect(flowChapterBlocks(blocks, catalog, 'part').map((block) => block.id)).toEqual(['part', 'one-b']);
    expect(flowChapterBlocks(blocks, catalog, 'two').map((block) => block.id)).toEqual(['two', 'two-a']);
  });

  it('将无标题的文档作为一个不能跨越的阅读范围', () => {
    const plain: FlowBlock[] = [
      { id: 'a', type: 'p', text: '第一句。', html: '第一句。' },
      { id: 'b', type: 'p', text: '第二句。', html: '第二句。' },
    ];
    const catalog = flowCatalog(plain);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ id: 'a', label: '全文', level: 0 });
    expect(flowChapterBlocks(plain, catalog, catalog[0].id)).toEqual(plain);
  });

  it('逐句导航从未知初始章节开始时不会越过首章，并在边界停止', () => {
    const catalog = flowCatalog(blocks);

    expect(adjacentFlowChapter(catalog, '', 1)?.id).toBe('title');
    expect(adjacentFlowChapter(catalog, '', -1)?.id).toBe('two');
    expect(adjacentFlowChapter(catalog, 'title', -1)).toBeUndefined();
    expect(adjacentFlowChapter(catalog, 'two', 1)).toBeUndefined();
  });
});
