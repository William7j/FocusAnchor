// @vitest-environment node
import { describe, expect, it } from 'vitest';
import assist from '../electron/weread-assist.cjs';

const { sanitizeWeReadAssistAction, sanitizeWeReadAssistSettings } = assist;

describe('微信读书专注辅助参数', () => {
  it('限制遮罩强度与阅读窗尺寸', () => {
    expect(sanitizeWeReadAssistSettings({
      mode: 'paragraph',
      dimming: 4,
      bandHeight: -20,
      followPointer: false,
      showGuideLine: true,
      sentenceHighlight: true,
    })).toEqual({
      mode: 'paragraph',
      dimming: 0.82,
      bandHeight: 64,
      followPointer: false,
      showGuideLine: true,
      sentenceHighlight: true,
    });
  });

  it('拒绝非法操作并限制自动滚动速度', () => {
    expect(sanitizeWeReadAssistAction({ type: 'auto-scroll', active: true, speed: 999 })).toEqual({
      type: 'auto-scroll',
      active: true,
      speed: 160,
    });
    expect(() => sanitizeWeReadAssistAction({ type: 'move', direction: 8 })).toThrow('段落移动方向无效');
    expect(sanitizeWeReadAssistAction({ type: 'move-sentence', direction: 1 })).toEqual({ type: 'move-sentence', direction: 1 });
  });
});
