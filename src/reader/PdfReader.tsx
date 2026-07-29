import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { assetUrl } from '../lib/content';
import { collectSentenceItems, SentenceHighlighter } from '../lib/sentences';
import type { AnnotationRecord, DocumentRecord, LocalSentenceState, ReaderCatalogItem, ReaderPreferences, ReadingPosition, SelectionDraft } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const PDF_SCALE = 1.35;
const PAGE_GAP = 22;
const PAGE_RENDER_BUFFER = 2;

interface PdfReaderProps {
  documentRecord: DocumentRecord;
  annotations: AnnotationRecord[];
  position?: ReadingPosition;
  preferences: ReaderPreferences;
  onPosition: (position: { locator: string; progress: number }) => void;
  onSelection: (selection: SelectionDraft) => void;
  onSentenceState?: (state: LocalSentenceState) => void;
  onCatalog?: (items: ReaderCatalogItem[]) => void;
}

interface PdfPageLayout {
  width: number;
  height: number;
}

interface PageWindow {
  start: number;
  end: number;
}

interface PdfPositionData {
  ratio: number;
  page?: number;
  sentence?: { page: number; text: string };
}

function pdfPosition(position?: ReadingPosition): PdfPositionData {
  try {
    const parsed = JSON.parse(position?.locator || '{}');
    const ratio = Math.max(0, Math.min(1, Number(parsed.ratio) || 0));
    const page = Number.isInteger(parsed.page) && parsed.page > 0 ? parsed.page : undefined;
    const sentence = parsed.sentence && Number.isInteger(parsed.sentence.page) && parsed.sentence.page > 0 && typeof parsed.sentence.text === 'string'
      ? { page: parsed.sentence.page, text: parsed.sentence.text }
      : undefined;
    return { ratio, page, sentence };
  } catch {
    return { ratio: 0 };
  }
}

function pdfRatio(position?: ReadingPosition) {
  return pdfPosition(position).ratio;
}

function pageOffsetsFor(layouts: PdfPageLayout[]) {
  let offset = 0;
  return layouts.map((layout) => {
    const pageOffset = offset;
    offset += layout.height + PAGE_GAP;
    return pageOffset;
  });
}

function firstPageEndingAfter(offsets: number[], layouts: PdfPageLayout[], value: number) {
  let low = 0;
  let high = layouts.length - 1;
  let result = Math.max(0, layouts.length - 1);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] + layouts[middle].height > value) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return result;
}

function lastPageStartingBefore(offsets: number[], value: number) {
  let low = 0;
  let high = offsets.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] < value) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

async function measurePdfPageLayouts(pdf: any) {
  const layouts = new Array<PdfPageLayout>(pdf.numPages);
  let nextPage = 1;
  const workerCount = Math.min(4, pdf.numPages);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextPage <= pdf.numPages) {
      const pageNumber = nextPage++;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PDF_SCALE });
      layouts[pageNumber - 1] = {
        width: Math.max(1, Math.ceil(viewport.width)),
        height: Math.max(1, Math.ceil(viewport.height)),
      };
      page.cleanup?.();
    }
  }));

  return layouts;
}

function PdfPage({ pdf, pageNumber, layout, annotations, onSelection }: { pdf: any; pageNumber: number; layout: PdfPageLayout; annotations: AnnotationRecord[]; onSelection: (selection: SelectionDraft) => void }) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let renderTask: any;
    let page: any;
    setReady(false);
    (async () => {
      page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: PDF_SCALE });
      const pixelRatio = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      const textLayer = textLayerRef.current;
      const pageRoot = pageRef.current;
      if (!canvas || !textLayer || !pageRoot) return;
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${layout.width}px`;
      canvas.style.height = `${layout.height}px`;
      pageRoot.style.width = `${layout.width}px`;
      pageRoot.style.height = `${layout.height}px`;
      textLayer.replaceChildren();
      textLayer.style.setProperty('--scale-factor', String(viewport.scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;
      renderTask = page.render({ canvasContext: context, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await renderTask.promise;
      if (cancelled) return;
      const layer = new pdfjs.TextLayer({ textContentSource: await page.getTextContent(), container: textLayer, viewport });
      await layer.render();
      if (!cancelled) setReady(true);
    })().catch(() => { if (!cancelled) setReady(false); });
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
      page?.cleanup?.();
    };
  }, [layout.height, layout.width, pageNumber, pdf]);

  const pageAnnotations = annotations.filter((annotation) => annotation.locator.kind === 'pdf' && annotation.locator.page === pageNumber);

  function captureSelection() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    const pageRoot = pageRef.current;
    if (!selection || !range || selection.isCollapsed || !pageRoot || !pageRoot.contains(range.commonAncestorContainer)) return;
    const quote = selection.toString().replace(/\s+/g, ' ').trim();
    const pageRect = pageRoot.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).map((rect) => ({
      x: (rect.left - pageRect.left) / pageRect.width,
      y: (rect.top - pageRect.top) / pageRect.height,
      width: rect.width / pageRect.width,
      height: rect.height / pageRect.height,
    })).filter((rect) => rect.width > 0 && rect.height > 0);
    if (quote && rects.length) onSelection({ locator: { kind: 'pdf', page: pageNumber, rects }, quote });
  }

  return (
    <section className={`pdf-page ${ready ? 'is-ready' : ''}`} ref={pageRef} data-page-number={pageNumber} style={{ width: layout.width, height: layout.height }} onMouseUp={captureSelection}>
      <canvas ref={canvasRef} />
      <div ref={textLayerRef} className="textLayer pdf-text-layer" />
      <div className="pdf-annotation-layer" aria-hidden="true">
        {pageAnnotations.flatMap((annotation) => annotation.locator.kind === 'pdf' ? annotation.locator.rects.map((rect, index) => (
          <span
            key={`${annotation.id}-${index}`}
            className={`pdf-highlight annotation-${annotation.color}`}
            style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
          />
        )) : [])}
      </div>
    </section>
  );
}

function PdfPagePlaceholder({ pageNumber, layout }: { pageNumber: number; layout: PdfPageLayout }) {
  return <section className="pdf-page pdf-page-placeholder" data-page-number={pageNumber} style={{ width: layout.width, height: layout.height }} aria-label={`第 ${pageNumber} 页`} />;
}

export function PdfReader({ documentRecord, annotations, position, preferences, onPosition, onSelection, onSentenceState, onCatalog }: PdfReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>();
  const sentenceRebuildTimerRef = useRef<number | undefined>();
  const virtualWindowFrameRef = useRef<number | undefined>();
  const sentenceHighlighterRef = useRef<SentenceHighlighter>();
  const pendingSentencePageDirectionRef = useRef<-1 | 0 | 1>(0);
  const pendingSentencePointRef = useRef<{ page: number; x: number; y: number }>();
  const sentenceStateCallbackRef = useRef(onSentenceState);
  const onPositionRef = useRef(onPosition);
  const restoreSentenceRef = useRef(pdfPosition(position).sentence);
  const restoredRef = useRef(false);
  const restoringRef = useRef(false);
  const [pdf, setPdf] = useState<any>();
  const [pageLayouts, setPageLayouts] = useState<PdfPageLayout[]>([]);
  const [renderWindow, setRenderWindow] = useState<PageWindow>({ start: 0, end: -1 });
  const [error, setError] = useState('');
  const [activePage, setActivePage] = useState(1);
  const activePageRef = useRef(1);
  const pageOffsets = useMemo(() => pageOffsetsFor(pageLayouts), [pageLayouts]);

  activePageRef.current = activePage;

  useEffect(() => {
    sentenceStateCallbackRef.current = onSentenceState;
  }, [onSentenceState]);

  useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);

  function currentPageNumber() {
    const root = scrollRef.current;
    if (!root) return 1;
    const pages = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page'));
    if (!pages.length) return 1;
    const anchor = root.getBoundingClientRect().top + root.clientHeight * 0.28;
    const page = pages.find((candidate) => candidate.getBoundingClientRect().bottom > anchor) || pages[pages.length - 1];
    return Math.max(1, Number(page.dataset.pageNumber) || 1);
  }

  function currentSentence() {
    const highlighter = sentenceHighlighterRef.current;
    const pages = pagesRef.current;
    if (!highlighter || !pages || highlighter.state.activeIndex < 0) return undefined;
    const layers = Array.from(pages.querySelectorAll<HTMLElement>('.pdf-text-layer'))
      .filter((layer) => Number(layer.closest<HTMLElement>('.pdf-page')?.dataset.pageNumber) === activePageRef.current);
    const item = collectSentenceItems(layers)[highlighter.state.activeIndex];
    const page = Number(item?.block.closest<HTMLElement>('.pdf-page')?.dataset.pageNumber);
    return item && Number.isFinite(page) && page > 0 ? { page, text: item.text } : undefined;
  }

  const persistProgress = useCallback(() => {
    const root = scrollRef.current;
    if (!root || restoringRef.current) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const ratio = root.scrollTop / Math.max(1, root.scrollHeight - root.clientHeight);
      const page = activePageRef.current;
      onPositionRef.current({ locator: JSON.stringify({ type: 'pdf', ratio, page, sentence: currentSentence() }), progress: Math.max(0, Math.min(1, ratio)) });
    }, 350);
  }, []);

  const scrollToPage = useCallback((pageNumber: number, behavior: ScrollBehavior = 'smooth') => {
    const root = scrollRef.current;
    if (!root) return;
    const page = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page')).find((candidate) => Number(candidate.dataset.pageNumber) === pageNumber);
    if (!page) return;
    const top = root.scrollTop + page.getBoundingClientRect().top - root.getBoundingClientRect().top - 24;
    root.scrollTo({ top: Math.max(0, top), behavior });
    window.setTimeout(persistProgress, behavior === 'auto' ? 120 : 420);
  }, [persistProgress]);

  const updateVirtualWindow = useCallback(() => {
    const root = scrollRef.current;
    const pages = pagesRef.current;
    if (!root || !pages || !pageLayouts.length) return;
    const rootRect = root.getBoundingClientRect();
    const pagesRect = pages.getBoundingClientRect();
    const viewportTop = Math.max(0, rootRect.top - pagesRect.top);
    const viewportBottom = Math.max(viewportTop, rootRect.top + root.clientHeight - pagesRect.top);
    const firstVisible = firstPageEndingAfter(pageOffsets, pageLayouts, viewportTop);
    const lastVisible = Math.max(firstVisible, lastPageStartingBefore(pageOffsets, viewportBottom));
    const next = {
      start: Math.max(0, firstVisible - PAGE_RENDER_BUFFER),
      end: Math.min(pageLayouts.length - 1, lastVisible + PAGE_RENDER_BUFFER),
    };
    setRenderWindow((current) => current.start === next.start && current.end === next.end ? current : next);
  }, [pageLayouts, pageOffsets]);

  const scheduleVirtualWindow = useCallback(() => {
    if (virtualWindowFrameRef.current !== undefined) window.cancelAnimationFrame(virtualWindowFrameRef.current);
    virtualWindowFrameRef.current = window.requestAnimationFrame(() => {
      virtualWindowFrameRef.current = undefined;
      updateVirtualWindow();
    });
  }, [updateVirtualWindow]);

  useEffect(() => {
    let disposed = false;
    setPdf(undefined);
    setPageLayouts([]);
    setRenderWindow({ start: 0, end: -1 });
    setError('');
    restoredRef.current = false;
    restoringRef.current = false;
    restoreSentenceRef.current = pdfPosition(position).sentence;
    setActivePage(pdfPosition(position).page || 1);
    const loadingTask = pdfjs.getDocument({ url: assetUrl(documentRecord.assetId), rangeChunkSize: 64 * 1024 });
    loadingTask.promise.then((loaded) => {
      if (!disposed) setPdf(loaded);
    }).catch((loadError) => {
      if (!disposed) setError(loadError?.message || 'PDF 解析失败。');
    });
    return () => {
      disposed = true;
      loadingTask.destroy();
    };
  }, [documentRecord]);

  useEffect(() => {
    if (!pdf) return undefined;
    let disposed = false;
    setPageLayouts([]);
    setRenderWindow({ start: 0, end: -1 });
    void measurePdfPageLayouts(pdf).then((layouts) => {
      if (!disposed) setPageLayouts(layouts);
    }).catch((measureError) => {
      if (!disposed) setError(measureError?.message || 'PDF 页面布局解析失败。');
    });
    return () => { disposed = true; };
  }, [pdf]);

  useEffect(() => {
    onCatalog?.(pageLayouts.map((_layout, index) => ({
      id: `pdf-page-${index + 1}`,
      label: `第 ${index + 1} 页`,
      level: 0,
      locator: JSON.stringify({ type: 'pdf', page: index + 1 }),
    })));
  }, [onCatalog, pageLayouts]);

  useEffect(() => {
    const root = scrollRef.current;
    const pages = pagesRef.current;
    if (!pdf || pageLayouts.length !== pdf.numPages || !root || !pages || restoredRef.current) return undefined;
    let disposed = false;
    let frame: number | undefined;
    const saved = pdfPosition(position);
    const ratio = saved.ratio;

    const attemptRestore = () => {
      if (disposed || restoredRef.current) return;
      const pagesHeight = pages.getBoundingClientRect().height;
      if (!pagesHeight || !root.clientHeight) return;
      restoringRef.current = true;
      const applyPosition = () => {
        const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
        root.scrollTop = saved.page && pageOffsets[saved.page - 1] !== undefined
          ? Math.max(0, Math.min(maximum, pages.offsetTop + pageOffsets[saved.page - 1] - 24))
          : maximum * ratio;
      };
      applyPosition();
      frame = window.requestAnimationFrame(() => {
        if (disposed || restoredRef.current) return;
        if (!pages.getBoundingClientRect().height || !root.clientHeight) {
          restoringRef.current = false;
          return;
        }
        applyPosition();
        restoredRef.current = true;
        restoringRef.current = false;
        scheduleVirtualWindow();
      });
    };
    const scheduleRestore = () => {
      if (disposed || restoredRef.current) return;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(attemptRestore);
    };
    const observer = new ResizeObserver(scheduleRestore);
    observer.observe(root);
    observer.observe(pages);
    scheduleRestore();
    return () => {
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer.disconnect();
      restoringRef.current = false;
    };
  }, [pageLayouts.length, pageOffsets, pdf, position?.locator, position?.progress, scheduleVirtualWindow]);

  useEffect(() => {
    const root = scrollRef.current;
    const pages = pagesRef.current;
    if (!root || !pages || !pageLayouts.length) return undefined;
    const observer = new ResizeObserver(scheduleVirtualWindow);
    observer.observe(root);
    observer.observe(pages);
    scheduleVirtualWindow();
    return () => observer.disconnect();
  }, [pageLayouts.length, scheduleVirtualWindow]);

  useEffect(() => () => {
    window.clearTimeout(timerRef.current);
    window.clearTimeout(sentenceRebuildTimerRef.current);
    if (virtualWindowFrameRef.current !== undefined) window.cancelAnimationFrame(virtualWindowFrameRef.current);
  }, []);

  useEffect(() => {
    const pages = pagesRef.current;
    if (!pdf || pageLayouts.length !== pdf.numPages || !pages || !preferences.sentenceHighlight) {
      sentenceStateCallbackRef.current?.({ count: 0, activeIndex: -1 });
      return undefined;
    }

    const highlighter = new SentenceHighlighter(document, (state) => sentenceStateCallbackRef.current?.(state));
    sentenceHighlighterRef.current = highlighter;

    const rebuild = () => {
      window.clearTimeout(sentenceRebuildTimerRef.current);
      sentenceRebuildTimerRef.current = window.setTimeout(() => {
        const layers = Array.from(pages.querySelectorAll<HTMLElement>('.pdf-text-layer'))
          .filter((layer) => Number(layer.closest<HTMLElement>('.pdf-page')?.dataset.pageNumber) === activePageRef.current);
        highlighter.rebuild(layers);
        const pendingPoint = pendingSentencePointRef.current;
        if (pendingPoint?.page === activePageRef.current) {
          pendingSentencePointRef.current = undefined;
          highlighter.activateAtPoint(pendingPoint.x, pendingPoint.y);
          window.setTimeout(persistProgress, 100);
          return;
        }
        const pendingDirection = pendingSentencePageDirectionRef.current;
        if (pendingDirection) {
          if (highlighter.state.count) {
            pendingSentencePageDirectionRef.current = 0;
            highlighter.activate(pendingDirection === 1 ? 0 : highlighter.state.count - 1, { scrollContainer: scrollRef.current });
            window.setTimeout(persistProgress, 180);
          } else {
            const nextPage = activePageRef.current + pendingDirection;
            if (nextPage >= 1 && nextPage <= pageLayouts.length) {
              setActivePage(nextPage);
              scrollToPage(nextPage);
            } else {
              pendingSentencePageDirectionRef.current = 0;
            }
          }
          return;
        }
        const saved = restoreSentenceRef.current;
        if (saved && saved.page === activePageRef.current) {
          const items = collectSentenceItems(layers);
          const index = items.findIndex((item) => Number(item.block.closest<HTMLElement>('.pdf-page')?.dataset.pageNumber) === saved.page && item.text === saved.text);
          if (index >= 0) {
            highlighter.activate(index);
            restoreSentenceRef.current = undefined;
          }
        }
      }, 140);
    };

    const isTextLayerNode = (node: Node) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
      return Boolean(element?.closest('.pdf-text-layer') || element?.querySelector('.pdf-text-layer'));
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => isTextLayerNode(record.target) || Array.from(record.addedNodes).some(isTextLayerNode))) rebuild();
    });

    observer.observe(pages, { childList: true, characterData: true, subtree: true });
    rebuild();
    return () => {
      observer.disconnect();
      window.clearTimeout(sentenceRebuildTimerRef.current);
      if (sentenceHighlighterRef.current === highlighter) sentenceHighlighterRef.current = undefined;
      highlighter.destroy();
    };
  }, [activePage, pageLayouts.length, pdf, preferences.sentenceHighlight, scrollToPage]);

  useEffect(() => {
    const onChapter = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      const root = scrollRef.current;
      if (!root || (direction !== 1 && direction !== -1)) return;
      const next = Math.max(1, Math.min(pageLayouts.length, activePageRef.current + direction));
      if (next !== activePageRef.current) {
        setActivePage(next);
        scrollToPage(next);
      }
    };
    const onCatalog = (event: Event) => {
      try {
        const locator = (event as CustomEvent<{ locator?: string }>).detail?.locator;
        const page = typeof locator === 'string' ? Number(JSON.parse(locator).page) : NaN;
        if (Number.isInteger(page) && page >= 1 && page <= pageLayouts.length) {
          setActivePage(page);
          scrollToPage(page, 'auto');
        }
      } catch { /* Ignore a catalog entry belonging to another reader. */ }
    };
    window.addEventListener('focus-reader:chapter', onChapter);
    window.addEventListener('focus-reader:catalog', onCatalog);
    return () => {
      window.removeEventListener('focus-reader:chapter', onChapter);
      window.removeEventListener('focus-reader:catalog', onCatalog);
    };
  }, [pageLayouts.length, scrollToPage]);

  useEffect(() => {
    const onScroll = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      const root = scrollRef.current;
      if (!root || (direction !== 1 && direction !== -1)) return;
      root.scrollBy({ top: direction * Math.max(160, root.clientHeight * .86), behavior: 'smooth' });
      window.setTimeout(persistProgress, 420);
    };
    window.addEventListener('focus-reader:scroll', onScroll);
    return () => window.removeEventListener('focus-reader:scroll', onScroll);
  }, [persistProgress]);

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
      const nextPage = activePageRef.current + direction;
      if (nextPage < 1 || nextPage > pageLayouts.length) return;
      pendingSentencePageDirectionRef.current = direction;
      setActivePage(nextPage);
      scrollToPage(nextPage);
    };
    window.addEventListener('focus-reader:sentence', onSentence);
    return () => window.removeEventListener('focus-reader:sentence', onSentence);
  }, [pageLayouts.length, persistProgress, preferences.sentenceHighlight, scrollToPage]);

  if (error) return <div className="reader-empty"><strong>无法打开 PDF</strong><span>{error}</span></div>;
  if (!pdf) return <div className="reader-empty"><span className="loading-indicator" />正在载入 PDF</div>;
  if (pageLayouts.length !== pdf.numPages) return <div className="reader-empty"><span className="loading-indicator" />正在准备 PDF 页面布局</div>;
  return (
    <div
      ref={scrollRef}
      className={`pdf-scroll theme-${preferences.theme}`}
      style={{ paddingInline: preferences.pageMargin }}
      onScroll={() => {
        const page = currentPageNumber();
        if (page !== activePageRef.current) setActivePage(page);
        persistProgress();
        scheduleVirtualWindow();
      }}
      onClick={(event) => {
        if (!preferences.sentenceHighlight) return;
        if (!window.getSelection()?.isCollapsed) return;
        const page = event.target instanceof Element ? event.target.closest<HTMLElement>('.pdf-page') : null;
        const pageNumber = Number(page?.dataset.pageNumber);
        if (Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber !== activePageRef.current) {
          pendingSentencePointRef.current = { page: pageNumber, x: event.clientX, y: event.clientY };
          setActivePage(pageNumber);
          return;
        }
        if (sentenceHighlighterRef.current?.activateAtPoint(event.clientX, event.clientY)) window.setTimeout(persistProgress, 100);
      }}
    >
      <div ref={pagesRef} className="pdf-pages" style={{ maxWidth: preferences.columnWidth + 120, gap: PAGE_GAP }}>
        {pageLayouts.map((layout, index) => {
          const pageNumber = index + 1;
          const shouldRender = index >= renderWindow.start && index <= renderWindow.end;
          return shouldRender
            ? <PdfPage key={pageNumber} pdf={pdf} pageNumber={pageNumber} layout={layout} annotations={annotations} onSelection={onSelection} />
            : <PdfPagePlaceholder key={pageNumber} pageNumber={pageNumber} layout={layout} />;
        })}
      </div>
    </div>
  );
}
