const MODES = new Set(['off', 'ruler', 'paragraph']);

const defaultWeReadAssistSettings = Object.freeze({
  mode: 'off',
  dimming: 0.52,
  bandHeight: 150,
  followPointer: true,
  showGuideLine: true,
  sentenceHighlight: true,
});

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function sanitizeWeReadAssistSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    mode: MODES.has(input.mode) ? input.mode : defaultWeReadAssistSettings.mode,
    dimming: clampNumber(input.dimming, 0.2, 0.82, defaultWeReadAssistSettings.dimming),
    bandHeight: Math.round(clampNumber(input.bandHeight, 64, 360, defaultWeReadAssistSettings.bandHeight)),
    followPointer: input.followPointer !== false,
    showGuideLine: input.showGuideLine !== false,
    sentenceHighlight: input.sentenceHighlight !== false,
  };
}

function sanitizeWeReadAssistAction(value) {
  if (!value || typeof value !== 'object') throw new Error('专注辅助操作无效。');
  if (value.type === 'recenter') return { type: 'recenter' };
  if (value.type === 'move') {
    const direction = Number(value.direction);
    if (direction !== -1 && direction !== 1) throw new Error('段落移动方向无效。');
    return { type: 'move', direction };
  }
  if (value.type === 'move-sentence') {
    const direction = Number(value.direction);
    if (direction !== -1 && direction !== 1) throw new Error('句子移动方向无效。');
    return { type: 'move-sentence', direction };
  }
  if (value.type === 'auto-scroll') {
    return {
      type: 'auto-scroll',
      active: Boolean(value.active),
      speed: Math.round(clampNumber(value.speed, 12, 160, 42)),
    };
  }
  throw new Error('不支持的专注辅助操作。');
}

module.exports = {
  defaultWeReadAssistSettings,
  sanitizeWeReadAssistAction,
  sanitizeWeReadAssistSettings,
};
