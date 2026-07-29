import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import Mark from 'mark.js';
import { loadFlowBlocks } from '../lib/content';
import { readFlowSelection } from '../lib/selection';
import { collectSentenceItems, SentenceHighlighter } from '../lib/sentences';
import type { AnnotationRecord, DocumentRecord, FlowBlock, LocalSentenceState, ReaderCatalogItem, ReaderPreferences, ReadingPosition, SelectionDraft } from '../types';

interface FlowReaderProps {
  documentRecord: DocumentRecord;
  annotations: AnnotationRecord[];
  position?: ReadingPosition;
  preferences: ReaderPreferences;
  onPosition: (position: { locator: string; progress: number }) => void;
  onSelection: (selection: SelectionDraft) => void;
  onSentenceState?: (state: LocalSentenceState) => void;
  onCatalog?: (items: ReaderCatalogItem[]) => void;
}

function flowAnnotationsFor(blockId: string, annotations: AnnotationRecord[]) {
  return annotations.filter((annotation) => annotation.locator.kind === 'flow' && annotation.locator.blockId === blockId);
}

function AnnotatedBlock({ block, annotations, active, onActivate }: { block: FlowBlock; annotations: AnnotationRecord[]; active: boolean; onActivate: () => void }) {
  const rootRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const marker = new Mark(root);
    const items = flowAnnotationsFor(block.id, annotations)
      .map((annotation) => ({ annotation, locator: annotation.locator.kind === 'flow' ? annotation.locator : null }))
      .filter((item): item is { annotation: AnnotationRecord; locator: Extract<AnnotationRecord['locator'], { kind: 'flow' }> } => Boolean(item.locator))
      .sort((left, right) => left.locator.start - right.locator.start);

    let cancelled = false;
    marker.unmark({
      className: 'annotation-mark',
      done: () => {
        const apply = (index: number) => {
          if (cancelled || index >= items.length) return;
          const { annotation, locator } = items[index];
          marker.markRanges([{ start: locator.start, length: locator.end - locator.start }], {
            className: `annotation-mark annotation-${annotation.color}`,
            each: (element: HTMLElement) => { element.dataset.annotationId = annotation.id; },
            done: () => apply(index + 1),
          });
        };
        apply(0);
      },
    });
    return () => { cancelled = true; };
  }, [annotations, block.id, block.html]);

  return (
    <article
      ref={rootRef}
      className={`flow-block flow-${block.type} ${active ? 'is-active' : ''}`}
      data-block-id={block.id}
      onPointerDown={onActivate}
      dangerouslySetInnerHTML={{ __html: block.html }}
    />
  );
}

interface FlowPositionData {
  ratio: number;
  chapterId?: string;
  sentence?: { blockId: string; text: string };
}

function flowPosition(position?: ReadingPosition): FlowPositionData {
  if (!position?.locator) return { ratio: 0 };
  try {
    const parsed = JSON.parse(position.locator);
    const ratio = typeof parsed.ratio === 'number' ? Math.max(0, Math.min(1, parsed.ratio)) : 0;
    const chapterId = typeof parsed.chapterId === 'string' ? parsed.chapterId : undefined;
    const sentence = parsed.sentence && typeof parsed.sentence.blockId === 'string' && typeof parsed.sentence.text === 'string'
      ? { blockId: parsed.sentence.blockId, text: parsed.sentence.text }
      : undefined;
    return { ratio, chapterId, sentence };
  } catch {
    return { ratio: 0 };
  }
}

function headingLevel(block: FlowBlock) {
  const tag = /^h([1-6])$/i.exec(block.type);
  if (tag) return Number(tag[1]);
  return /^(?:第[\d一二三四五六七八九十百千零〇]+[章节回部卷篇](?:\s|[：:、.．—\-(【\[]|$)|chapter\s+\d+(?:\s|[：:.．—\-]|$))/i.test(block.text.trim()) ? 1 : 0;
}

export function flowCatalog(blocks: FlowBlock[]): ReaderCatalogItem[] {
  const headings = blocks.map((block) => ({ block, level: headingLevel(block) })).filter((item) => item.level > 0);
  if (!headings.length) {
    const first = blocks[0];
    return first ? [{ id: first.id, label: '全文', level: 0, locator: JSON.stringify({ type: 'flow', blockId: first.id }) }] : [];
  }
  return headings.map(({ block, level }) => ({
    id: block.id,
    label: block.text.trim() || '未命名章节',
    level: level - 1,
    locator: JSON.stringify({ type: 'flow', blockId: block.id }),
  }));
}

function catalogBlockId(locator: string) {
  try {
    const parsed = JSON.parse(locator);
    return typeof parsed.blockId === 'string' ? parsed.blockId : '';
  } catch {
    return '';
  }
}

export function flowChapterBlocks(blocks: FlowBlock[], catalog: ReaderCatalogItem[], chapterId: string) {
  if (!blocks.length) return [];
  const item = catalog.find((candidate) => candidate.id === chapterId) || catalog[0];
  const startBlockId = item ? catalogBlockId(item.locator) : blocks[0].id;
  const start = Math.max(0, blocks.findIndex((block) => block.id === startBlockId));
  if (!item || item.level === 0 && catalog.length === 1) return blocks.slice(start);
  const nextItem = catalog.slice(catalog.indexOf(item) + 1).find((candidate) => candidate.level <= item.level);
  const endBlockId = nextItem ? catalogBlockId(nextItem.locator) : '';
  const end = endBlockId ? blocks.findIndex((block) => block.id === endBlockId) : blocks.length;
  return blocks.slice(start, end < 0 ? blocks.length : end);
}

export function adjacentFlowChapter(catalog: ReaderCatalogItem[], chapterId: string, direction: -1 | 1) {
  const currentIndex = catalog.findIndex((item) => item.id === chapterId);
  if (currentIndex < 0) return catalog[direction === 1 ? 0 : catalog.length - 1];
  return catalog[currentIndex + direction];
}

export function FlowReader({ documentRecord, annotations, position, preferences, onPosition, onSelection, onSentenceState, onCatalog }: FlowReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const restoringRef = useRef(false);
  const timerRef = useRef<number | undefined>();
  const sentenceTimerRef = useRef<number | undefined>();
  const sentenceHighlighterRef = useRef<SentenceHighlighter>();
  const onSentenceStateRef = useRef(onSentenceState);
  const onPositionRef = useRef(onPosition);
  const blocksRef = useRef<FlowBlock[]>([]);
  const catalogRef = useRef<ReaderCatalogItem[]>([]);
  const activeChapterIdRef = useRef('');
  const restoreSentenceRef = useRef(flowPosition(position).sentence);
  const pendingChapterSentenceDirectionRef = useRef<-1 | 0 | 1>(0);
  const pendingSentencePointRef = useRef<{ chapterId: string; x: number; y: number }>();
  const [blocks, setBlocks] = useState<FlowBlock[]>([]);
  const [error, setError] = useState('');
  const [activeBlock, setActiveBlock] = useState('');
  const [activeChapterId, setActiveChapterId] = useState('');
  const catalog = useMemo(() => flowCatalog(blocks), [blocks]);

  blocksRef.current = blocks;
  catalogRef.current = catalog;
  activeChapterIdRef.current = activeChapterId;

  useEffect(() => {
    onSentenceStateRef.current = onSentenceState;
  }, [onSentenceState]);

  useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);

  useEffect(() => {
    let active = true;
    restoredRef.current = false;
    restoringRef.current = false;
    restoreSentenceRef.current = flowPosition(position).sentence;
    setBlocks([]);
    setError('');
    setActiveBlock('');
    setActiveChapterId('');
    loadFlowBlocks(documentRecord).then((loaded) => {
      if (active) setBlocks(loaded);
    }).catch((loadError: Error) => {
      if (active) setError(loadError.message || '文档解析失败。');
    });
    return () => { active = false; };
  }, [documentRecord]);

  useEffect(() => {
    onCatalog?.(catalog);
    if (!catalog.length) return;
    const restoredChapter = flowPosition(position).chapterId;
    setActiveChapterId((current) => catalog.some((item) => item.id === current)
      ? current
      : catalog.some((item) => item.id === restoredChapter)
        ? restoredChapter!
        : catalog[0].id);
  }, [catalog, onCatalog, position]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !blocks.length || restoredRef.current) return;
    restoredRef.current = true;
    const saved = flowPosition(position);
    restoringRef.current = true;
    requestAnimationFrame(() => {
      const target = saved.sentence?.blockId
        ? Array.from(root.querySelectorAll<HTMLElement>('.flow-block')).find((block) => block.dataset.blockId === saved.sentence?.blockId)
        : undefined;
      if (target) root.scrollTop = Math.max(0, root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 28);
      else root.scrollTop = Math.max(0, (root.scrollHeight - root.clientHeight) * saved.ratio);
      requestAnimationFrame(() => { restoringRef.current = false; });
    });
  }, [blocks.length, position]);

  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    window.clearTimeout(sentenceTimerRef.current);
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || sentenceHighlighterRef.current) return;
    const highlighter = new SentenceHighlighter(root.ownerDocument, (state) => onSentenceStateRef.current?.(state));
    sentenceHighlighterRef.current = highlighter;
    return () => {
      highlighter.destroy();
      if (sentenceHighlighterRef.current === highlighter) sentenceHighlighterRef.current = undefined;
    };
  }, [blocks.length, documentRecord.id]);

  useEffect(() => {
    const highlighter = sentenceHighlighterRef.current;
    const root = scrollRef.current;
    if (!highlighter || !root) return;
    window.clearTimeout(sentenceTimerRef.current);
    if (!preferences.sentenceHighlight) {
      highlighter.clear();
      return;
    }
    // Mark.js updates annotation nodes in a layout effect. Wait for that work so
    // Range endpoints are rebuilt against the final, real text-node structure.
    sentenceTimerRef.current = window.setTimeout(() => {
      const chapterBlocks = flowChapterBlocks(blocksRef.current, catalogRef.current, activeChapterIdRef.current);
      const ids = new Set(chapterBlocks.map((block) => block.id));
      const elements = Array.from(root.querySelectorAll<HTMLElement>('.flow-block')).filter((block) => ids.has(block.dataset.blockId || ''));
      highlighter.rebuild(elements);
      const pendingPoint = pendingSentencePointRef.current;
      if (pendingPoint?.chapterId === activeChapterIdRef.current) {
        pendingSentencePointRef.current = undefined;
        highlighter.activateAtPoint(pendingPoint.x, pendingPoint.y);
        window.setTimeout(persistProgress, 100);
        return;
      }
      const pendingDirection = pendingChapterSentenceDirectionRef.current;
      if (pendingDirection) {
        if (highlighter.state.count) {
          pendingChapterSentenceDirectionRef.current = 0;
          highlighter.activate(pendingDirection === 1 ? 0 : highlighter.state.count - 1, { scrollContainer: root });
          window.setTimeout(persistProgress, 180);
          return;
        }
        moveSentenceAcrossChapter(pendingDirection, activeChapterIdRef.current);
        return;
      }
      const saved = restoreSentenceRef.current;
      if (saved && ids.has(saved.blockId)) {
        const items = collectSentenceItems(elements);
        const index = items.findIndex((item) => item.block.dataset.blockId === saved.blockId && item.text === saved.text);
        if (index >= 0) {
          highlighter.activate(index);
          restoreSentenceRef.current = undefined;
        }
      }
    }, 32);
    return () => window.clearTimeout(sentenceTimerRef.current);
  }, [activeChapterId, annotations, blocks, catalog, documentRecord.id, preferences.columnWidth, preferences.fontSize, preferences.lineHeight, preferences.sentenceHighlight]);

  useEffect(() => {
    const onScroll = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      const root = scrollRef.current;
      if (!root || (direction !== 1 && direction !== -1)) return;
      root.scrollBy({ top: direction * Math.max(120, root.clientHeight * 0.88), behavior: 'smooth' });
      window.setTimeout(persistProgress, 420);
    };
    window.addEventListener('focus-reader:scroll', onScroll);
    return () => window.removeEventListener('focus-reader:scroll', onScroll);
  }, []);

  function currentSentence() {
    const root = scrollRef.current;
    const highlighter = sentenceHighlighterRef.current;
    if (!root || !highlighter || highlighter.state.activeIndex < 0) return undefined;
    const chapterBlocks = flowChapterBlocks(blocksRef.current, catalogRef.current, activeChapterIdRef.current);
    const ids = new Set(chapterBlocks.map((block) => block.id));
    const elements = Array.from(root.querySelectorAll<HTMLElement>('.flow-block')).filter((block) => ids.has(block.dataset.blockId || ''));
    const item = collectSentenceItems(elements)[highlighter.state.activeIndex];
    const blockId = item?.block.dataset.blockId;
    return item && blockId ? { blockId, text: item.text } : undefined;
  }

  function showChapter(chapterId: string, behavior: ScrollBehavior = 'smooth') {
    if (!catalogRef.current.some((item) => item.id === chapterId)) return;
    pendingChapterSentenceDirectionRef.current = 0;
    setActiveChapterId(chapterId);
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const item = catalogRef.current.find((candidate) => candidate.id === chapterId);
      const blockId = item ? catalogBlockId(item.locator) : '';
      const target = Array.from(root.querySelectorAll<HTMLElement>('.flow-block')).find((block) => block.dataset.blockId === blockId);
      if (target) root.scrollTo({ top: Math.max(0, root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 28), behavior });
      window.setTimeout(persistProgress, behavior === 'auto' ? 70 : 380);
    });
  }

  useEffect(() => {
    const onChapter = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      if (direction !== 1 && direction !== -1) return;
      const items = catalogRef.current;
      const current = Math.max(0, items.findIndex((item) => item.id === activeChapterIdRef.current));
      const next = items[current + direction];
      if (next) showChapter(next.id);
    };
    const onCatalog = (event: Event) => {
      const locator = (event as CustomEvent<{ locator?: string }>).detail?.locator;
      const blockId = typeof locator === 'string' ? catalogBlockId(locator) : '';
      const target = catalogRef.current.find((item) => catalogBlockId(item.locator) === blockId);
      if (target) showChapter(target.id, 'auto');
    };
    window.addEventListener('focus-reader:chapter', onChapter);
    window.addEventListener('focus-reader:catalog', onCatalog);
    return () => {
      window.removeEventListener('focus-reader:chapter', onChapter);
      window.removeEventListener('focus-reader:catalog', onCatalog);
    };
  }, []);

  function moveSentenceAcrossChapter(direction: -1 | 1, fromChapterId = activeChapterIdRef.current) {
    const chapters = catalogRef.current;
    const target = adjacentFlowChapter(chapters, fromChapterId, direction);
    if (!target) {
      pendingChapterSentenceDirectionRef.current = 0;
      return;
    }
    pendingChapterSentenceDirectionRef.current = direction;
    setActiveChapterId(target.id);
  }

  useEffect(() => {
    const onSentence = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      const root = scrollRef.current;
      const highlighter = sentenceHighlighterRef.current;
      if (!preferences.sentenceHighlight || !root || !highlighter || (direction !== 1 && direction !== -1)) return;
      if (highlighter.move(direction, { scrollContainer: root })) {
        window.setTimeout(persistProgress, 180);
        return;
      }
      moveSentenceAcrossChapter(direction);
    };
    window.addEventListener('focus-reader:sentence', onSentence);
    return () => window.removeEventListener('focus-reader:sentence', onSentence);
  }, [preferences.sentenceHighlight]);

  function persistProgress() {
    const root = scrollRef.current;
    if (!root) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const maxScroll = Math.max(1, root.scrollHeight - root.clientHeight);
      const ratio = Math.max(0, Math.min(1, root.scrollTop / maxScroll));
      onPositionRef.current({ locator: JSON.stringify({ type: 'flow', ratio, chapterId: activeChapterIdRef.current, sentence: currentSentence() }), progress: ratio });
    }, 350);
  }

  function captureSelection() {
    const root = scrollRef.current;
    if (!root) return;
    const selection = readFlowSelection(root);
    if (selection) onSelection(selection);
  }

  function activateSentence(event: React.MouseEvent<HTMLDivElement>) {
    if (!preferences.sentenceHighlight || window.getSelection()?.toString()) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.flow-block') : null;
    const blockId = target?.dataset.blockId;
    if (blockId) {
      const chapter = catalogRef.current.find((item) => flowChapterBlocks(blocksRef.current, catalogRef.current, item.id).some((block) => block.id === blockId));
      if (chapter && chapter.id !== activeChapterIdRef.current) {
        pendingSentencePointRef.current = { chapterId: chapter.id, x: event.clientX, y: event.clientY };
        setActiveChapterId(chapter.id);
        return;
      }
    }
    if (sentenceHighlighterRef.current?.activateAtPoint(event.clientX, event.clientY)) window.setTimeout(persistProgress, 100);
  }

  if (error) return <div className="reader-empty"><strong>无法打开文档</strong><span>{error}</span></div>;
  if (!blocks.length) return <div className="reader-empty"><span className="loading-indicator" />正在解析文档</div>;

  return (
    <div
      ref={scrollRef}
      className={`flow-scroll theme-${preferences.theme} ${preferences.focusMode === 'paragraph' ? 'focus-paragraph' : ''}`}
      onScroll={() => { if (!restoringRef.current) persistProgress(); }}
      onMouseUp={captureSelection}
      onClick={activateSentence}
    >
      <div
        className="flow-column"
        style={{
          width: `min(100%, ${preferences.columnWidth}px)`,
          paddingInline: preferences.pageMargin,
          fontSize: preferences.fontSize,
          lineHeight: preferences.lineHeight,
        }}
      >
        {blocks.map((block) => (
          <AnnotatedBlock
            key={block.id}
            block={block}
            annotations={annotations}
            active={activeBlock === block.id}
            onActivate={() => { if (preferences.focusMode === 'paragraph') setActiveBlock(block.id); }}
          />
        ))}
      </div>
    </div>
  );
}
