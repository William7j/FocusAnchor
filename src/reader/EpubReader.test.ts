// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEpubContentPreferences, displayInitialEpubLocation, hasRenderableEpubBody, resizeEpubRenditionWithFallback } from './EpubReader';
import { defaultPreferences } from '../db';

afterEach(() => vi.unstubAllGlobals());

describe('EPUB 恢复与排版', () => {
  it('旧 CFI 静默落到空章节时回退到可读起点', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    const blank = document.implementation.createHTMLDocument('blank');
    const readable = document.implementation.createHTMLDocument('readable');
    readable.body.innerHTML = '<p>恢复后的正文</p>';
    let current = blank;
    const display = vi.fn(async (target?: string | number) => {
      current = target === 'stale-cfi' ? blank : readable;
    });
    const rendition = { display, getContents: () => [{ document: current }] };

    await displayInitialEpubLocation(rendition, 'stale-cfi');

    expect(display).toHaveBeenNthCalledWith(1, 'stale-cfi');
    expect(display).toHaveBeenNthCalledWith(2);
    expect(hasRenderableEpubBody(readable)).toBe(true);
  });

  it('将字号和行距写入章节正文，覆盖 EPUB 自带的段落字号', () => {
    const chapter = document.implementation.createHTMLDocument('chapter');
    chapter.body.innerHTML = '<p>正文</p>';

    applyEpubContentPreferences({ document: chapter }, { ...defaultPreferences, fontSize: 26, lineHeight: 2.2 });

    expect(chapter.getElementById('focus-reader-epub-preferences')?.textContent).toContain('font-size: 26px');
    expect(chapter.getElementById('focus-reader-epub-preferences')?.textContent).toContain('line-height: 2.2');
    expect(chapter.getElementById('focus-reader-epub-preferences')?.textContent).toContain('body p');
  });

  it('重排清空视图后，旧 CFI 失效时回退到原章节', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    const blank = document.implementation.createHTMLDocument('blank');
    const readable = document.implementation.createHTMLDocument('readable');
    readable.body.innerHTML = '<p>当前章节正文</p>';
    let current = readable;
    const display = vi.fn(async (target?: string | number) => {
      current = target === 3 ? readable : blank;
    });
    const rendition = {
      location: { start: { cfi: 'stale-cfi' } },
      currentLocation: () => ({ start: { cfi: 'stale-cfi' } }),
      getContents: () => [{ document: current, sectionIndex: 3 }],
      resize: vi.fn(() => { current = blank; }),
      display,
    };

    await resizeEpubRenditionWithFallback(rendition, 720, 640);

    expect(rendition.resize).toHaveBeenCalledWith(720, 640, 'stale-cfi');
    expect(display).toHaveBeenCalledWith('stale-cfi');
    expect(display).toHaveBeenCalledWith(3);
    expect(hasRenderableEpubBody(readable)).toBe(true);
  });
});
