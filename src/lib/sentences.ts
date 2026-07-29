export interface SentenceItem {
  block: HTMLElement;
  range: Range;
  text: string;
}

export interface SentenceState {
  count: number;
  activeIndex: number;
}

export interface SentenceMoveOptions {
  scrollContainer?: HTMLElement | null;
  behavior?: ScrollBehavior;
}

const previousSentenceColor = 'rgba(255, 118, 118, .30)';
const activeSentenceColor = 'rgba(10, 132, 255, .72)';
const nextSentenceColor = 'rgba(255, 210, 92, .34)';

let highlighterSequence = 0;

function segmentText(text: string) {
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter('zh-CN', { granularity: 'sentence' }).segment(text)];
  const result: Array<{ index: number; segment: string }> = [];
  const matcher = /[^。！？!?]+[。！？!?]?/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text))) result.push({ index: match.index, segment: match[0] });
  return result.length ? result : [{ index: 0, segment: text }];
}

function pointAt(nodes: Text[], offset: number, end: boolean) {
  let cursor = 0;
  for (const node of nodes) {
    const length = node.data.length;
    if (offset < cursor + length || (end && offset === cursor + length)) return { node, offset: Math.max(0, Math.min(length, offset - cursor)) };
    cursor += length;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last?.data.length || 0 };
}

function textNodes(block: HTMLElement) {
  const nodes: Text[] = [];
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.nodeValue?.trim() || parent?.closest('script,style,textarea,select,button,[data-sentence-ignore="true"]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  return nodes;
}

export function collectSentenceItems(blocks: HTMLElement[]) {
  const items: SentenceItem[] = [];
  for (const block of blocks) {
    const nodes = textNodes(block);
    if (!nodes.length) continue;
    const text = nodes.map((node) => node.data).join('');
    for (const segment of segmentText(text)) {
      let start = Number(segment.index) || 0;
      let end = start + String(segment.segment || '').length;
      while (start < end && /\s/.test(text[start])) start += 1;
      while (end > start && /\s/.test(text[end - 1])) end -= 1;
      if (end - start < 2) continue;
      const from = pointAt(nodes, start, false);
      const to = pointAt(nodes, end, true);
      if (!from.node || !to.node) continue;
      const range = block.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      items.push({ block, range, text: range.toString() });
    }
  }
  return items;
}

export function sentenceHighlightGroups(count: number, activeIndex: number) {
  if (count <= 0 || activeIndex < 0 || activeIndex >= count) {
    return { previous: [] as number[], active: [] as number[], next: [] as number[] };
  }
  return {
    previous: activeIndex > 0 ? [activeIndex - 1] : [],
    active: [activeIndex],
    next: activeIndex + 1 < count ? [activeIndex + 1] : [],
  };
}

function highlightApi(document: Document) {
  const view = document.defaultView as (Window & { Highlight?: new (...ranges: Range[]) => unknown; CSS?: { highlights?: Map<string, unknown> } }) | null;
  const HighlightConstructor = view?.Highlight || (globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const highlights = view?.CSS?.highlights || (globalThis as typeof globalThis & { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  return HighlightConstructor && highlights ? { HighlightConstructor, highlights } : null;
}

function distanceToRect(x: number, y: number, rect: DOMRect) {
  const horizontal = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const vertical = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return horizontal * horizontal + vertical * vertical;
}

function nearestSentenceIndex(items: SentenceItem[], x: number, y: number) {
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    const rects = Array.from(item.range.getClientRects());
    const candidates = rects.length ? rects : [item.block.getBoundingClientRect()];
    for (const rect of candidates) {
      if (!rect.width && !rect.height) continue;
      const distance = distanceToRect(x, y, rect);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    }
  });
  return nearest;
}

export class SentenceHighlighter {
  private readonly previousName: string;
  private readonly activeName: string;
  private readonly nextName: string;
  private readonly style: HTMLStyleElement;
  private items: SentenceItem[] = [];
  private activeIndex = -1;
  private visible = true;

  constructor(private readonly document: Document, private readonly onChange: (state: SentenceState) => void) {
    const id = `focus-local-sentence-${++highlighterSequence}`;
    this.previousName = `${id}-previous`;
    this.activeName = `${id}-active`;
    this.nextName = `${id}-next`;
    this.style = document.createElement('style');
    this.style.dataset.sentenceHighlighter = id;
    this.style.textContent = `::highlight(${this.previousName}) { background-color: ${previousSentenceColor}; color: inherit; }
      ::highlight(${this.activeName}) { background-color: ${activeSentenceColor}; color: inherit; text-decoration: underline; text-decoration-color: rgba(37, 112, 190, .72); text-decoration-thickness: 2px; text-underline-offset: 3px; }
      ::highlight(${this.nextName}) { background-color: ${nextSentenceColor}; color: inherit; }`;
    (document.head || document.documentElement).append(this.style);
  }

  rebuild(blocks: HTMLElement[]) {
    const previous = this.items[this.activeIndex];
    this.clearHighlights();
    this.items = collectSentenceItems(blocks);
    const restored = previous ? this.items.findIndex((item) => item.block === previous.block && item.text === previous.text) : -1;
    // New local documents and chapter iframes always begin at their first
    // sentence. Existing text keeps its active sentence across a rebuild.
    this.activeIndex = restored >= 0 ? restored : this.items.length ? 0 : -1;
    this.applyActive();
  }

  clear() {
    this.clearHighlights();
    this.items = [];
    this.activeIndex = -1;
    this.emit();
  }

  destroy() {
    this.clear();
    this.style.remove();
  }

  move(direction: -1 | 1, options?: SentenceMoveOptions) {
    if (!this.items.length) return false;
    const next = Math.max(0, Math.min(this.items.length - 1, this.activeIndex + direction));
    if (next === this.activeIndex) return false;
    this.activeIndex = next;
    this.applyActive();
    if (options?.scrollContainer) this.scrollActive(options.scrollContainer, options.behavior);
    return true;
  }

  activate(index: number, options?: SentenceMoveOptions) {
    if (!this.items.length || !Number.isFinite(index)) return false;
    const next = Math.max(0, Math.min(this.items.length - 1, Math.trunc(index)));
    const changed = next !== this.activeIndex;
    this.activeIndex = next;
    this.applyActive();
    if (options?.scrollContainer) this.scrollActive(options.scrollContainer, options.behavior);
    return changed;
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.applyActive();
    else this.clearHighlights();
  }

  activateAtPoint(x: number, y: number) {
    const position = this.document.caretPositionFromPoint?.(x, y);
    const range = position ? undefined : this.document.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode || range?.startContainer;
    const offset = position?.offset ?? range?.startOffset;
    const directIndex = node && typeof offset === 'number'
      ? this.items.findIndex((item) => item.range.isPointInRange(node, offset))
      : -1;
    const index = directIndex >= 0 ? directIndex : nearestSentenceIndex(this.items, x, y);
    if (index < 0) return false;
    this.activeIndex = index;
    this.applyActive();
    return true;
  }

  get state(): SentenceState {
    return { count: this.items.length, activeIndex: this.activeIndex };
  }

  private scrollActive(container: HTMLElement, behavior: ScrollBehavior = 'smooth') {
    const item = this.items[this.activeIndex];
    if (!item) return;
    const rect = item.range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    container.scrollBy({ top: rect.top + rect.height / 2 - (containerRect.top + container.clientHeight * .5), behavior });
  }

  private applyActive() {
    const api = highlightApi(this.document);
    if (api) {
      api.highlights.delete(this.previousName);
      api.highlights.delete(this.activeName);
      api.highlights.delete(this.nextName);
      if (this.visible) {
        const groups = sentenceHighlightGroups(this.items.length, this.activeIndex);
        for (const index of groups.previous) api.highlights.set(this.previousName, new api.HighlightConstructor(this.items[index].range));
        for (const index of groups.active) api.highlights.set(this.activeName, new api.HighlightConstructor(this.items[index].range));
        for (const index of groups.next) api.highlights.set(this.nextName, new api.HighlightConstructor(this.items[index].range));
      }
    }
    this.emit();
  }

  private clearHighlights() {
    const api = highlightApi(this.document);
    if (!api) return;
    api.highlights.delete(this.previousName);
    api.highlights.delete(this.activeName);
    api.highlights.delete(this.nextName);
  }

  private emit() {
    this.onChange({ count: this.items.length, activeIndex: this.activeIndex });
  }
}
