// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markdownToBlocks } from './content';

function renderedRoot(blocks: Awaited<ReturnType<typeof markdownToBlocks>>) {
  const root = document.createElement('div');
  root.innerHTML = blocks.map((block) => block.html).join('');
  return root;
}

describe('Markdown 公式渲染', () => {
  it('渲染四种常见分隔符，并保留显示公式布局', async () => {
    const blocks = await markdownToBlocks([
      '行内 $O(n)$ 和 \\(n_0\\) 都会显示为公式。',
      '',
      '$$',
      '\\sum_{i=1}^{n} i',
      '$$',
      '',
      '\\[',
      'x^2 + y^2',
      '\\]',
    ].join('\n'));
    const root = renderedRoot(blocks);

    expect(root.querySelectorAll('.katex')).toHaveLength(4);
    expect(root.querySelectorAll('.katex-display')).toHaveLength(2);
    expect(root.textContent).toContain('行内');
    expect(root.textContent).toContain('都会显示为公式。');
  });

  it('不处理行内代码、围栏代码块和转义的美元符号', async () => {
    const blocks = await markdownToBlocks([
      '正常公式 $x^2$。行内代码 `$inline$` 保持原样，价格是 \\$5$。',
      '',
      '```ts',
      'const formula = "$fenced$";',
      '```',
      '',
      '    const indented = "$indented$";',
    ].join('\n'));
    const root = renderedRoot(blocks);
    const code = Array.from(root.querySelectorAll('code')).map((element) => element.textContent);

    expect(root.querySelectorAll('.katex')).toHaveLength(1);
    expect(code).toContain('$inline$');
    expect(code.some((value) => value?.includes('$fenced$'))).toBe(true);
    expect(code.some((value) => value?.includes('$indented$'))).toBe(true);
    expect(root.textContent).toContain('$5$');
  });
});
