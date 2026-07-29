import { useEffect, useRef, useState, type CSSProperties } from 'react';
import ePub from 'epubjs';
import { assetUrl } from '../lib/content';
import { collectSentenceItems, SentenceHighlighter, type SentenceItem } from '../lib/sentences';
import type { AnnotationRecord, DocumentRecord, LocalSentenceState, ReaderCatalogItem, ReaderPreferences, ReadingPosition, SelectionDraft } from '../types';

interface EpubReaderProps {
  documentRecord: DocumentRecord;
  annotations: AnnotationRecord[];
  position?: ReadingPosition;
  preferences: ReaderPreferences;
  onPosition: (position: { locator: string; progress: number }) => void;
  onSelection: (selection: SelectionDraft) => void;
  onSentenceState?: (state: LocalSentenceState) => void;
  onCatalog?: (items: ReaderCatalogItem[]) => void;
}

interface SentenceBinding {
  document: Document;
  sectionIndex: number;
  highlighter: SentenceHighlighter;
  items: SentenceItem[];
  dispose: () => void;
}

interface EpubPositionData {
  cfi?: string;
  sentence?: { sectionIndex: number; index: number; text: string };
}

function epubPosition(position?: ReadingPosition): EpubPositionData {
  if (!position?.locator) return {};
  try {
    const value = JSON.parse(position.locator);
    const sentence = value.sentence && Number.isInteger(value.sentence.sectionIndex) && Number.isInteger(value.sentence.index) && typeof value.sentence.text === 'string'
      ? { sectionIndex: value.sentence.sectionIndex, index: value.sentence.index, text: value.sentence.text }
      : undefined;
    return { cfi: typeof value.cfi === 'string' ? value.cfi : undefined, sentence };
  } catch {
    return {};
  }
}

function previousCfi(position?: ReadingPosition) {
  return epubPosition(position)?.cfi;
}

export function applyEpubContentPreferences(contents: any, preferences: ReaderPreferences) {
  const document = contents?.document as Document | undefined;
  if (!document?.head || !document.body) return;
  let style = document.getElementById('focus-reader-epub-preferences') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'focus-reader-epub-preferences';
    document.head.append(style);
  }
  style.textContent = `
    body { font-family: system-ui, sans-serif !important; font-size: ${preferences.fontSize}px !important; line-height: ${preferences.lineHeight} !important; }
    body p, body li, body blockquote, body dd, body dt, body figcaption, body td, body th { font-size: inherit !important; line-height: inherit !important; }
  `;
}

export function hasRenderableEpubBody(document: Document | undefined) {
  const body = document?.body;
  if (!body) return false;
  if (body.textContent?.replace(/\s+/g, '')) return true;
  return Boolean(body.querySelector('img, svg, video, audio, canvas, table, math'));
}

async function renditionHasRenderableContent(rendition: any) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const contents = rendition?.getContents?.() || [];
    if (contents.some((contents: any) => hasRenderableEpubBody(contents?.document))) return true;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return false;
}

function currentEpubCfi(rendition: any) {
  try {
    const cfi = rendition?.currentLocation?.()?.start?.cfi || rendition?.location?.start?.cfi;
    return typeof cfi === 'string' && cfi ? cfi : undefined;
  } catch {
    return undefined;
  }
}

function currentRenderableEpubSection(rendition: any) {
  const contents = rendition?.getContents?.() || [];
  const content = contents.find((candidate: any) => hasRenderableEpubBody(candidate?.document));
  const sectionIndex = Number(content?.sectionIndex);
  return Number.isInteger(sectionIndex) && sectionIndex >= 0 ? sectionIndex : undefined;
}

export async function displayEpubLocationWithFallback(rendition: any, resumeCfi?: string, fallbackSection?: number) {
  if (resumeCfi) {
    try {
      await rendition.display(resumeCfi);
      if (await renditionHasRenderableContent(rendition)) return;
    } catch {
      // A stored CFI can remain syntactically valid after an EPUB changes but
      // resolve to an empty view. Fall through to a known-good opening page.
    }
  }
  if (typeof fallbackSection === 'number' && Number.isInteger(fallbackSection) && fallbackSection >= 0) {
    try {
      await rendition.display(fallbackSection);
      if (await renditionHasRenderableContent(rendition)) return;
    } catch {
      // A malformed section must not leave the reader on a blank page.
    }
  }
  await rendition.display();
  if (await renditionHasRenderableContent(rendition)) return;
  await rendition.display(0);
  if (!await renditionHasRenderableContent(rendition)) throw new Error('EPUB 内容无法显示。');
}

export async function displayInitialEpubLocation(rendition: any, resumeCfi?: string) {
  await displayEpubLocationWithFallback(rendition, resumeCfi);
}

export async function resizeEpubRenditionWithFallback(rendition: any, width: number, height: number) {
  // EpubJS clears every active iframe before a resize and then redisplays its
  // stored CFI. Keep a chapter index as a second recovery target because a
  // stored CFI can be accepted by EpubJS while still rendering an empty view.
  const resumeCfi = currentEpubCfi(rendition);
  const fallbackSection = currentRenderableEpubSection(rendition);
  rendition.resize(width, height, resumeCfi);
  if (await renditionHasRenderableContent(rendition)) return;
  await displayEpubLocationWithFallback(rendition, resumeCfi, fallbackSection);
}

function sentenceBlocks(document: Document) {
  const selector = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, figcaption, td, th';
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((element) => Boolean(element.textContent?.trim()));
  const candidateSet = new Set(candidates);
  const parentsWithCandidateChildren = new Set<HTMLElement>();

  for (const candidate of candidates) {
    let parent = candidate.parentElement;
    while (parent) {
      if (candidateSet.has(parent)) parentsWithCandidateChildren.add(parent);
      parent = parent.parentElement;
    }
  }

  const leafBlocks = candidates.filter((candidate) => !parentsWithCandidateChildren.has(candidate));
  return leafBlocks.length ? leafBlocks : document.body ? [document.body] : [];
}

function normalizedTocLocator(book: any, href: string) {
  if (book?.spine?.get?.(href)) return href;
  const hashIndex = href.indexOf('#');
  const pathPart = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? href.slice(hashIndex) : '';
  const navigationPath = book?.packaging?.navPath || book?.packaging?.ncxPath;
  if (!pathPart || !navigationPath) return undefined;
  try {
    const base = new URL(String(navigationPath), 'https://focus-reader.invalid/');
    const normalizedPath = new URL(pathPart, base).pathname.replace(/^\//, '');
    const locator = `${decodeURI(normalizedPath)}${fragment}`;
    return book?.spine?.get?.(locator) ? locator : undefined;
  } catch {
    return undefined;
  }
}

function epubCatalogItems(book: any): ReaderCatalogItem[] {
  const items: ReaderCatalogItem[] = [];
  const seen = new Set<string>();
  const append = (entries: any[], level: number) => {
    for (const entry of entries || []) {
      const href = typeof entry?.href === 'string' ? entry.href.trim() : '';
      const locator = href ? normalizedTocLocator(book, href) : '';
      const label = String(entry?.label || '').replace(/\s+/g, ' ').trim();
      if (locator) {
        const id = `toc:${entry?.id || locator}:${items.length}`;
        if (!seen.has(`${locator}:${level}`)) {
          seen.add(`${locator}:${level}`);
          items.push({ id, label: label || locator, level, locator });
        }
      }
      append(entry?.subitems, level + 1);
    }
  };

  append(book?.navigation?.toc, 0);
  if (items.length) return items;

  return (book?.spine?.spineItems || [])
    .filter((section: any) => section?.href)
    .map((section: any, index: number) => {
      const href = String(section.href);
      const filename = href.split(/[\\/]/).pop() || href;
      return { id: `spine:${section.index ?? index}`, label: filename, level: 0, locator: href };
    });
}

export function EpubReader({ documentRecord, annotations, position, preferences, onPosition, onSelection, onSentenceState, onCatalog }: EpubReaderProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<any>();
  const sentenceBindingsRef = useRef(new Map<Document, SentenceBinding>());
  const currentSentenceDocumentRef = useRef<Document>();
  const appliedAnnotationCfisRef = useRef(new Set<string>());
  const chapterChangeRef = useRef(false);
  const preferencesRef = useRef(preferences);
  const annotationsRef = useRef(annotations);
  const positionRef = useRef(position);
  const onPositionRef = useRef(onPosition);
  const onSelectionRef = useRef(onSelection);
  const onSentenceStateRef = useRef(onSentenceState);
  const onCatalogRef = useRef(onCatalog);
  const restoreSentenceRef = useRef(epubPosition(position)?.sentence);
  const lastLocationRef = useRef<{ cfi?: string; progress?: number }>({});
  const resizeFrameRef = useRef<number>();
  const renderedSizeRef = useRef('');
  const [error, setError] = useState('');

  preferencesRef.current = preferences;
  annotationsRef.current = annotations;
  positionRef.current = position;
  onPositionRef.current = onPosition;
  onSelectionRef.current = onSelection;
  onSentenceStateRef.current = onSentenceState;
  onCatalogRef.current = onCatalog;

  function emitSentenceState(state: LocalSentenceState) {
    onSentenceStateRef.current?.(state);
  }

  function scheduleRenditionResize(force = false) {
    if (resizeFrameRef.current !== undefined) window.cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      const rendition = renditionRef.current;
      const mount = mountRef.current;
      if (!rendition || !mount) return;
      const width = Math.floor(mount.clientWidth);
      const height = Math.floor(mount.clientHeight);
      if (!width || !height) return;
      const size = `${width}x${height}`;
      if (!force && renderedSizeRef.current === size) return;
      renderedSizeRef.current = size;
      void resizeEpubRenditionWithFallback(rendition, width, height)
        .catch(() => undefined)
        .then(() => {
          if (renditionRef.current !== rendition) return;
          for (const contents of rendition.getContents?.() || []) {
            const document = contents?.document as Document | undefined;
            if (!document?.body) continue;
            const blocks = sentenceBlocks(document);
            const binding = sentenceBindingsRef.current.get(document);
            if (!binding) {
              installSentenceBinding(contents);
              continue;
            }
            binding.items = collectSentenceItems(blocks);
            binding.highlighter.rebuild(blocks);
          }
          syncVisibleSentenceState();
        });
    });
  }

  function persistCurrentPosition(location?: any) {
    const cfi = location?.start?.cfi || lastLocationRef.current.cfi || renditionRef.current?.currentLocation?.()?.start?.cfi;
    if (!cfi) return;
    const progress = Number(location?.start?.percentage ?? lastLocationRef.current.progress ?? renditionRef.current?.currentLocation?.()?.start?.percentage ?? 0);
    const binding = activeSentenceBinding();
    const index = binding?.highlighter.state.activeIndex ?? -1;
    const item = binding && index >= 0 ? binding.items[index] : undefined;
    const sentence = binding && item ? { sectionIndex: binding.sectionIndex, index, text: item.text } : undefined;
    onPositionRef.current({
      locator: JSON.stringify({ type: 'epub', cfi, sentence }),
      progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0,
    });
  }

  function iframeForDocument(document: Document) {
    return Array.from(mountRef.current?.querySelectorAll('iframe') || []).find((iframe) => iframe.contentDocument === document);
  }

  function scrollContainer() {
    const managerContainer = renditionRef.current?.manager?.container as HTMLElement | undefined;
    return managerContainer || mountRef.current?.querySelector<HTMLElement>('.epub-container') || undefined;
  }

  function sentenceScreenRect(binding: SentenceBinding, item: SentenceItem) {
    const iframe = iframeForDocument(binding.document);
    if (!iframe) return undefined;
    const iframeRect = iframe.getBoundingClientRect();
    const rangeRect = item.range.getBoundingClientRect();
    return {
      top: iframeRect.top + rangeRect.top,
      right: iframeRect.left + rangeRect.right,
      bottom: iframeRect.top + rangeRect.bottom,
      left: iframeRect.left + rangeRect.left,
      width: rangeRect.width,
      height: rangeRect.height,
    };
  }

  function scrollActiveSentence(binding: SentenceBinding, behavior: ScrollBehavior = 'smooth', align: 'center' | 'start' = 'center') {
    const container = scrollContainer();
    const item = binding.items[binding.highlighter.state.activeIndex];
    const rect = item && sentenceScreenRect(binding, item);
    if (!container || !rect) return;
    const containerRect = container.getBoundingClientRect();
    const delta = align === 'start'
      ? rect.top - containerRect.top - 28
      : rect.top + rect.height * .5 - (containerRect.top + container.clientHeight * .5);
    container.scrollBy({ top: delta, behavior });
  }

  function bindingIsVisible(binding: SentenceBinding) {
    const mount = mountRef.current;
    const iframe = iframeForDocument(binding.document);
    if (!mount || !iframe) return false;
    const mountRect = mount.getBoundingClientRect();
    const rect = iframe.getBoundingClientRect();
    return rect.right > mountRect.left && rect.left < mountRect.right && rect.bottom > mountRect.top && rect.top < mountRect.bottom;
  }

  function visibleSentenceBinding() {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const mountRect = mount.getBoundingClientRect();
    const centerX = mountRect.left + mountRect.width * .5;
    const centerY = mountRect.top + mountRect.height * .5;
    return [...sentenceBindingsRef.current.values()]
      .map((binding) => {
        const iframe = iframeForDocument(binding.document);
        const rect = iframe?.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height || rect.right <= mountRect.left || rect.left >= mountRect.right || rect.bottom <= mountRect.top || rect.top >= mountRect.bottom) return null;
        const visibleWidth = Math.min(rect.right, mountRect.right) - Math.max(rect.left, mountRect.left);
        const visibleHeight = Math.min(rect.bottom, mountRect.bottom) - Math.max(rect.top, mountRect.top);
        const visibleCenterX = (Math.max(rect.left, mountRect.left) + Math.min(rect.right, mountRect.right)) * .5;
        const visibleCenterY = (Math.max(rect.top, mountRect.top) + Math.min(rect.bottom, mountRect.bottom)) * .5;
        return {
          binding,
          visibleArea: visibleWidth * visibleHeight,
          distance: Math.abs(visibleCenterX - centerX) + Math.abs(visibleCenterY - centerY),
        };
      })
      .filter((item): item is { binding: SentenceBinding; visibleArea: number; distance: number } => Boolean(item))
      .sort((left, right) => right.visibleArea - left.visibleArea || left.distance - right.distance)[0]?.binding;
  }

  function activateSentenceBinding(binding: SentenceBinding) {
    currentSentenceDocumentRef.current = binding.document;
    for (const candidate of sentenceBindingsRef.current.values()) candidate.highlighter.setVisible(candidate === binding);
  }

  function syncVisibleSentenceState() {
    const binding = visibleSentenceBinding();
    if (!binding) return;
    activateSentenceBinding(binding);
    emitSentenceState(binding.highlighter.state);
  }

  function releaseSentenceBinding(document: Document) {
    const binding = sentenceBindingsRef.current.get(document);
    if (!binding) return;
    binding.dispose();
    sentenceBindingsRef.current.delete(document);
    if (currentSentenceDocumentRef.current === document) currentSentenceDocumentRef.current = undefined;
  }

  function clearSentenceBindings() {
    for (const document of [...sentenceBindingsRef.current.keys()]) releaseSentenceBinding(document);
    emitSentenceState({ count: 0, activeIndex: -1 });
  }

  async function displayedSectionContents(rendition: any, sectionIndex: number) {
    // A continuous rendition completes its display promise before the iframe is
    // always observable through getContents(), especially after a rapid switch.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const contents = (rendition.getContents?.() || []).find((candidate: any) => Number(candidate?.sectionIndex) === Number(sectionIndex));
      if (contents?.document?.body) return contents;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return undefined;
  }

  async function changeChapter(direction: -1 | 1, carrySentence = false) {
    const rendition = renditionRef.current;
    if (!rendition || chapterChangeRef.current) return;
    const binding = activeSentenceBinding();
    const fallbackIndex = Number(rendition.location?.start?.index);
    const sectionIndex = Number.isFinite(binding?.sectionIndex) ? binding?.sectionIndex : fallbackIndex;
    const section = rendition.book?.spine?.get?.(sectionIndex);
    let target = direction === 1 ? section?.next?.() : section?.prev?.();
    if (!target) return;
    const previousCfi = rendition.currentLocation?.()?.start?.cfi;
    chapterChangeRef.current = true;

    try {
      let attempts = 0;
      while (target && attempts < 20) {
        attempts += 1;
        try {
          // EPUB spine hrefs are allowed to omit a file extension. Passing the
          // numeric spine index avoids rejecting those valid XHTML chapters.
          await rendition.display(target.index);
          const displayedContents = await displayedSectionContents(rendition, target.index);
          if (displayedContents) {
            let targetBinding = [...sentenceBindingsRef.current.values()].find((candidate) => candidate.sectionIndex === target.index);
            if (!targetBinding) {
              installSentenceBinding(displayedContents);
              targetBinding = [...sentenceBindingsRef.current.values()].find((candidate) => candidate.sectionIndex === target.index);
            }
            if (targetBinding?.items.length) {
              activateSentenceBinding(targetBinding);
              targetBinding.highlighter.activate(carrySentence && direction === -1 ? targetBinding.items.length - 1 : 0);
              scrollActiveSentence(targetBinding, 'auto', carrySentence && direction === -1 ? 'center' : 'start');
              emitSentenceState(targetBinding.highlighter.state);
              persistCurrentPosition();
              return;
            }
          }
        } catch (chapterError: any) {
          console.warn('[Focus Reader] Unable to render EPUB spine item', target.index, chapterError?.message || 'unknown error');
          // Continue to the next linear spine item when an entry cannot render.
        }
        target = direction === 1 ? target.next?.() : target.prev?.();
      }
      if (previousCfi) await rendition.display(previousCfi);
    } catch {
      if (previousCfi) {
        try { await rendition.display(previousCfi); } catch { /* Keep the reader mounted for a later retry. */ }
      }
    } finally {
      chapterChangeRef.current = false;
      requestAnimationFrame(syncVisibleSentenceState);
    }
  }

  async function navigateCatalog(locator: string) {
    const rendition = renditionRef.current;
    if (!rendition || !locator || chapterChangeRef.current) return;
    const section = rendition.book?.spine?.get?.(locator.split('#')[0]);
    if (!section) return;
    chapterChangeRef.current = true;
    try {
      await rendition.display(locator);
      const displayedContents = await displayedSectionContents(rendition, section.index);
      if (displayedContents && !sentenceBindingsRef.current.has(displayedContents.document)) installSentenceBinding(displayedContents);
      const targetBinding = [...sentenceBindingsRef.current.values()].find((candidate) => candidate.sectionIndex === section.index);
      if (targetBinding) {
        activateSentenceBinding(targetBinding);
      }
      // rendition.display(locator) may have positioned a TOC fragment inside the
      // chapter. Pick the nearest visible sentence instead of resetting to its
      // first sentence and losing that anchor.
      syncVisibleSentenceState();
      persistCurrentPosition();
    } catch {
      // Keep the current chapter mounted when a malformed TOC target cannot render.
    } finally {
      chapterChangeRef.current = false;
      requestAnimationFrame(syncVisibleSentenceState);
    }
  }

  function scrollViewport(direction: -1 | 1) {
    const container = scrollContainer();
    if (!container) return;
    container.scrollBy({ top: direction * Math.max(240, container.clientHeight * .82), behavior: 'smooth' });
  }

  function activeSentenceBinding() {
    const current = currentSentenceDocumentRef.current;
    if (current) {
      const binding = sentenceBindingsRef.current.get(current);
      if (binding && bindingIsVisible(binding)) return binding;
    }
    const visible = visibleSentenceBinding();
    if (visible) {
      currentSentenceDocumentRef.current = visible.document;
      return visible;
    }

    const contents = renditionRef.current?.getContents?.() || [];
    for (const content of contents) {
      const binding = sentenceBindingsRef.current.get(content?.document);
      if (binding) {
        currentSentenceDocumentRef.current = binding.document;
        return binding;
      }
    }
    return undefined;
  }

  function moveSentence(direction: -1 | 1) {
    if (!preferencesRef.current.sentenceHighlight) return;
    const binding = activeSentenceBinding();
    if (!binding) return;

    if (binding.highlighter.move(direction)) {
      scrollActiveSentence(binding);
      persistCurrentPosition();
      return;
    }
    void changeChapter(direction, true);
  }

  function installSentenceBinding(contents: any) {
    const document = contents?.document as Document | undefined;
    if (!document?.body) return;
    releaseSentenceBinding(document);

    const blocks = sentenceBlocks(document);
    const items = collectSentenceItems(blocks);
    let binding: SentenceBinding;
    const highlighter = new SentenceHighlighter(document, (state) => {
      if (sentenceBindingsRef.current.get(document) !== binding) return;
      if (visibleSentenceBinding()?.document !== document) return;
      currentSentenceDocumentRef.current = document;
      emitSentenceState(state);
    });
    highlighter.setVisible(false);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (preferencesRef.current.sentenceHighlight && !event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        event.stopPropagation();
        moveSentence(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      const chapterDirection = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (chapterDirection) {
        event.preventDefault();
        event.stopPropagation();
        void changeChapter(chapterDirection);
        return;
      }
      const scrollDirection = event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)
        ? 1
        : event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)
          ? -1
          : 0;
      if (!scrollDirection) return;
      event.preventDefault();
      event.stopPropagation();
      scrollViewport(scrollDirection);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !preferencesRef.current.sentenceHighlight) return;
      activateSentenceBinding(binding);
      if (highlighter.activateAtPoint(event.clientX, event.clientY)) persistCurrentPosition();
    };

    binding = {
      document,
      sectionIndex: Number.isFinite(Number(contents?.sectionIndex)) ? Number(contents.sectionIndex) : 0,
      highlighter,
      items,
      dispose: () => {
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        highlighter.destroy();
      },
    };
    sentenceBindingsRef.current.set(document, binding);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    if (preferencesRef.current.sentenceHighlight) highlighter.rebuild(blocks);
    else highlighter.clear();
    const saved = restoreSentenceRef.current;
    if (saved && saved.sectionIndex === binding.sectionIndex && binding.items.length) {
      const byText = binding.items.findIndex((item) => item.text === saved.text);
      const index = binding.items[saved.index]?.text === saved.text ? saved.index : byText;
      if (index >= 0) {
        highlighter.activate(index);
        restoreSentenceRef.current = undefined;
        requestAnimationFrame(() => scrollActiveSentence(binding, 'auto', 'start'));
      }
    }
    syncVisibleSentenceState();
  }

  function syncAnnotations(rendition: any, source: AnnotationRecord[]) {
    for (const cfi of appliedAnnotationCfisRef.current) {
      try { rendition.annotations.remove(cfi, 'highlight'); } catch { /* A stale CFI should not prevent the rest of the book from opening. */ }
    }
    appliedAnnotationCfisRef.current.clear();

    const seen = new Set<string>();
    for (const annotation of source) {
      if (annotation.locator.kind !== 'epub' || seen.has(annotation.locator.cfi)) continue;
      seen.add(annotation.locator.cfi);
      try {
        rendition.annotations.add('highlight', annotation.locator.cfi, { annotationId: annotation.id, color: annotation.color }, () => undefined, `epub-highlight epub-${annotation.color}`);
        appliedAnnotationCfisRef.current.add(annotation.locator.cfi);
      } catch {
        // A stale CFI should not prevent the rest of the book from opening.
      }
    }
  }

  useEffect(() => {
    let disposed = false;
    let book: any;
    let rendition: any;
    const mount = mountRef.current;
    if (!mount) return undefined;
    setError('');
    mount.replaceChildren();
    renderedSizeRef.current = '';
    const sizeObserver = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => scheduleRenditionResize());
    sizeObserver?.observe(mount);

    (async () => {
      try {
        const response = await fetch(assetUrl(documentRecord.assetId));
        if (!response.ok) throw new Error('无法读取 EPUB 文件。');
        const bytes = await response.arrayBuffer();
        if (disposed) return;
        book = ePub(bytes);
        rendition = book.renderTo(mount, { width: '100%', height: '100%', manager: 'continuous', flow: 'scrolled', spread: 'none', allowScriptedContent: false });
        renditionRef.current = rendition;
        void book.loaded.navigation.then(
          () => { if (!disposed) onCatalogRef.current?.(epubCatalogItems(book)); },
          () => { if (!disposed) onCatalogRef.current?.(epubCatalogItems(book)); },
        );
        rendition.themes.default({ body: { 'font-family': 'system-ui, sans-serif' } });
        rendition.themes.override('font-size', `${preferencesRef.current.fontSize}px`, true);
        rendition.themes.override('line-height', String(preferencesRef.current.lineHeight), true);
        rendition.hooks.content.register((contents: any) => {
          applyEpubContentPreferences(contents, preferencesRef.current);
          installSentenceBinding(contents);
        });
        rendition.hooks.unloaded.register((contents: any) => {
          const document = contents?.document as Document | undefined;
          if (document) releaseSentenceBinding(document);
        });
        rendition.on('relocated', (location: any) => {
          const cfi = location?.start?.cfi;
          const progress = Number(location?.start?.percentage || 0);
          if (cfi) lastLocationRef.current = { cfi, progress: Number.isFinite(progress) ? progress : 0 };
          requestAnimationFrame(() => {
            syncVisibleSentenceState();
            persistCurrentPosition(location);
          });
        });
        rendition.on('selected', (cfiRange: string, contents: any) => {
          const quote = contents?.window?.getSelection?.().toString().replace(/\s+/g, ' ').trim();
          if (quote) onSelectionRef.current({ locator: { kind: 'epub', cfi: cfiRange }, quote });
        });
        syncAnnotations(rendition, annotationsRef.current);
        await displayInitialEpubLocation(rendition, previousCfi(positionRef.current));
        // renderTo() has already sized this initial view. Resizing here clears
        // it and can reopen an invalid saved CFI, causing the observed flash
        // followed by a blank page.
        renderedSizeRef.current = `${Math.floor(mount.clientWidth)}x${Math.floor(mount.clientHeight)}`;
        requestAnimationFrame(syncVisibleSentenceState);
      } catch (loadError: any) {
        if (!disposed) setError(loadError?.message || 'EPUB 解析失败。');
      }
    })();

    return () => {
      disposed = true;
      sizeObserver?.disconnect();
      if (resizeFrameRef.current !== undefined) window.cancelAnimationFrame(resizeFrameRef.current);
      renderedSizeRef.current = '';
      onCatalogRef.current?.([]);
      clearSentenceBindings();
      if (rendition) syncAnnotations(rendition, []);
      appliedAnnotationCfisRef.current.clear();
      renditionRef.current = undefined;
      try { rendition?.destroy(); } catch { /* EpubJS can throw during teardown. */ }
      try { book?.destroy(); } catch { /* EpubJS can throw during teardown. */ }
    };
  }, [documentRecord]);

  useEffect(() => {
    const onChapter = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      if (direction !== 1 && direction !== -1) return;
      void changeChapter(direction);
    };
    window.addEventListener('focus-reader:chapter', onChapter);
    return () => window.removeEventListener('focus-reader:chapter', onChapter);
  }, []);

  useEffect(() => {
    const onCatalog = (event: Event) => {
      const locator = (event as CustomEvent<{ locator?: string }>).detail?.locator;
      if (typeof locator === 'string') void navigateCatalog(locator);
    };
    window.addEventListener('focus-reader:catalog', onCatalog);
    return () => window.removeEventListener('focus-reader:catalog', onCatalog);
  }, []);

  useEffect(() => {
    const onScroll = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      if (direction !== 1 && direction !== -1) return;
      scrollViewport(direction);
    };
    window.addEventListener('focus-reader:scroll', onScroll);
    return () => window.removeEventListener('focus-reader:scroll', onScroll);
  }, []);

  useEffect(() => {
    const onSentence = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      if (direction !== 1 && direction !== -1) return;
      moveSentence(direction);
    };
    window.addEventListener('focus-reader:sentence', onSentence);
    return () => window.removeEventListener('focus-reader:sentence', onSentence);
  }, []);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    rendition.themes.override('font-size', `${preferences.fontSize}px`, true);
    rendition.themes.override('line-height', String(preferences.lineHeight), true);
    for (const contents of rendition.getContents?.() || []) applyEpubContentPreferences(contents, preferences);
    scheduleRenditionResize(true);
  }, [preferences.fontSize, preferences.lineHeight]);

  useEffect(() => {
    scheduleRenditionResize(true);
  }, [preferences.columnWidth, preferences.pageMargin]);

  useEffect(() => {
    const rendition = renditionRef.current;
    for (const contents of rendition?.getContents?.() || []) installSentenceBinding(contents);
    if (!preferences.sentenceHighlight) emitSentenceState({ count: 0, activeIndex: -1 });
  }, [preferences.sentenceHighlight]);

  useEffect(() => {
    const rendition = renditionRef.current;
    if (rendition) syncAnnotations(rendition, annotations);
  }, [annotations]);

  if (error) return <div className="reader-empty"><strong>无法打开 EPUB</strong><span>{error}</span></div>;
  return <div className={`epub-reader theme-${preferences.theme}`} style={{ '--reader-column-width': `${preferences.columnWidth}px`, '--reader-page-margin': `${preferences.pageMargin}px` } as CSSProperties}><div ref={mountRef} className="epub-mount" /></div>;
}
