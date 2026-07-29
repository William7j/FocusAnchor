import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Highlighter, ListTree, Minus, NotebookPen, Plus, SkipBack, SkipForward, SlidersHorizontal } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { exportJson, exportMarkdown } from '../lib/export';
import { AnnotationDialog } from './AnnotationDialog';
import { NotesPanel } from './NotesPanel';
import type { AnnotationColor, AnnotationRecord, DocumentRecord, LocalSentenceState, ReaderCatalogItem, ReaderPreferences, ReadingPosition, SelectionDraft } from '../types';

const EpubReader = lazy(() => import('../reader/EpubReader').then((module) => ({ default: module.EpubReader })));
const FlowReader = lazy(() => import('../reader/FlowReader').then((module) => ({ default: module.FlowReader })));
const PdfReader = lazy(() => import('../reader/PdfReader').then((module) => ({ default: module.PdfReader })));

interface ReaderWorkspaceProps {
  documentRecord: DocumentRecord;
  annotations: AnnotationRecord[];
  position?: ReadingPosition;
  preferences: ReaderPreferences;
  onBack: () => void;
  onPosition: (position: { locator: string; progress: number }) => void;
  onCreateAnnotation: (draft: SelectionDraft, color: AnnotationColor, note: string) => Promise<void>;
  onDeleteAnnotation: (id: string) => Promise<void>;
  onUpdateNote: (id: string, note: string) => Promise<void>;
  onPreferences: (value: ReaderPreferences) => void;
  onExport: (format: 'markdown' | 'json', content: string) => Promise<void>;
}

const kindLabel: Record<DocumentRecord['kind'], string> = { epub: 'EPUB', pdf: 'PDF', text: 'TXT', markdown: 'Markdown', docx: 'DOCX' };

export function ReaderWorkspace(props: ReaderWorkspaceProps) {
  const [notesOpen, setNotesOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<SelectionDraft>();
  const [sentenceState, setSentenceState] = useState<LocalSentenceState>({ count: 0, activeIndex: -1 });
  const [catalog, setCatalog] = useState<ReaderCatalogItem[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [selectedCatalogId, setSelectedCatalogId] = useState('');
  const { documentRecord, annotations, position, preferences } = props;

  useEffect(() => {
    setSentenceState({ count: 0, activeIndex: -1 });
    setCatalog([]);
    setCatalogOpen(false);
    setSelectedCatalogId('');
  }, [documentRecord.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.defaultPrevented || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const chapterDirection = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (chapterDirection) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('focus-reader:chapter', { detail: { direction: chapterDirection } }));
        return;
      }
      const sentenceDirection = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (sentenceDirection && preferences.sentenceHighlight) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('focus-reader:sentence', { detail: { direction: sentenceDirection } }));
        return;
      }
      const scrollDirection = sentenceDirection || event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)
        ? 1
        : event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)
          ? -1
          : 0;
      if (!scrollDirection) return;
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('focus-reader:scroll', { detail: { direction: scrollDirection } }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [documentRecord.kind, preferences.sentenceHighlight]);

  function changeChapter(direction: -1 | 1) {
    window.dispatchEvent(new CustomEvent('focus-reader:chapter', { detail: { direction } }));
  }

  function moveSentence(direction: -1 | 1) {
    if (!preferences.sentenceHighlight) return;
    window.dispatchEvent(new CustomEvent('focus-reader:sentence', { detail: { direction } }));
  }

  function updatePreferences(patch: Partial<ReaderPreferences>) {
    props.onPreferences({ ...preferences, ...patch });
  }

  const readerProps = {
    documentRecord,
    annotations,
    position,
    preferences,
    onPosition: props.onPosition,
    onSelection: setDraft,
    onSentenceState: setSentenceState,
    onCatalog: setCatalog,
  };

  return (
    <section className={`reader-workspace theme-${preferences.theme}`}>
      <header className="reader-toolbar">
        <div className="reader-title-group">
          <button className="icon-button" type="button" onClick={props.onBack} aria-label="返回书库" title="返回书库"><ArrowLeft size={19} /></button>
          <BookOpen size={18} />
          <div><h1>{documentRecord.title}</h1><span>{kindLabel[documentRecord.kind]}</span></div>
        </div>
        <div className="reader-toolbar-actions">
          <div className="catalog-anchor">
            <button className={`icon-button ${catalogOpen ? 'is-active' : ''}`} type="button" onClick={() => setCatalogOpen((value) => !value)} aria-label="目录" aria-expanded={catalogOpen} title="目录"><ListTree size={18} /></button>
            {catalogOpen && (
              <section className="reader-catalog" aria-label="目录">
                <header><h2>目录</h2><span>{catalog.length}</span></header>
                <div className="reader-catalog-list">
                  {catalog.length ? catalog.map((item) => (
                    <button
                      key={item.id}
                      className={item.id === selectedCatalogId ? 'is-active' : ''}
                      type="button"
                      title={item.label}
                      style={{ paddingInlineStart: `${12 + Math.min(4, item.level) * 12}px` }}
                      onClick={() => {
                        setSelectedCatalogId(item.id);
                        setCatalogOpen(false);
                        window.dispatchEvent(new CustomEvent('focus-reader:catalog', { detail: { locator: item.locator } }));
                      }}
                    >{item.label}</button>
                  )) : <p>正在生成目录</p>}
                </div>
              </section>
            )}
          </div>
          <div className="page-controls" aria-label={documentRecord.kind === 'pdf' ? '页面导航' : '章节导航'}>
            <button className="icon-button" type="button" onClick={() => changeChapter(-1)} aria-label={documentRecord.kind === 'pdf' ? '上一页' : '上一章'} title={documentRecord.kind === 'pdf' ? '上一页' : '上一章'}><ChevronLeft size={18} /></button>
            <span>{documentRecord.kind === 'pdf' ? '页面' : '章节'}</span>
            <button className="icon-button" type="button" onClick={() => changeChapter(1)} aria-label={documentRecord.kind === 'pdf' ? '下一页' : '下一章'} title={documentRecord.kind === 'pdf' ? '下一页' : '下一章'}><ChevronRight size={18} /></button>
          </div>
          <div className="sentence-controls" aria-label="逐句导航">
            <button className={`icon-button ${preferences.sentenceHighlight ? 'is-active' : ''}`} type="button" onClick={() => updatePreferences({ sentenceHighlight: !preferences.sentenceHighlight })} aria-label="逐句色块" title="逐句色块"><Highlighter size={17} /></button>
            <button className="icon-button" type="button" onClick={() => moveSentence(-1)} disabled={!preferences.sentenceHighlight || sentenceState.activeIndex < 0} aria-label="上一句" title="上一句"><SkipBack size={16} /></button>
            <output className={`sentence-status ${sentenceState.count ? 'is-ready' : ''}`} title={preferences.sentenceHighlight ? '当前句 / 已识别句子' : '逐句色块已关闭'}>{preferences.sentenceHighlight ? sentenceState.count ? `${sentenceState.activeIndex + 1} / ${sentenceState.count}` : '识别中' : '--'}</output>
            <button className="icon-button" type="button" onClick={() => moveSentence(1)} disabled={!preferences.sentenceHighlight || sentenceState.activeIndex < 0} aria-label="下一句" title="下一句"><SkipForward size={16} /></button>
          </div>
          <button className={`icon-button ${notesOpen ? 'is-active' : ''}`} type="button" onClick={() => setNotesOpen((value) => !value)} aria-label="我的笔记" title="我的笔记"><NotebookPen size={18} /></button>
          <div className="settings-anchor">
            <button className={`icon-button ${settingsOpen ? 'is-active' : ''}`} type="button" onClick={() => setSettingsOpen((value) => !value)} aria-label="阅读设置" title="阅读设置"><SlidersHorizontal size={18} /></button>
            {settingsOpen && (
              <section className="reader-settings" aria-label="阅读设置">
                <div className="setting-row"><span>字号</span><div className="stepper"><button className="icon-button tiny" type="button" onClick={() => updatePreferences({ fontSize: Math.max(14, preferences.fontSize - 1) })} aria-label="减小字号"><Minus size={15} /></button><output>{preferences.fontSize}</output><button className="icon-button tiny" type="button" onClick={() => updatePreferences({ fontSize: Math.min(30, preferences.fontSize + 1) })} aria-label="增大字号"><Plus size={15} /></button></div></div>
                <label className="setting-range">行距<input type="range" min="1.4" max="2.4" step="0.1" value={preferences.lineHeight} onChange={(event) => updatePreferences({ lineHeight: Number(event.target.value) })} /><output>{preferences.lineHeight.toFixed(1)}</output></label>
                <label className="setting-range">版心宽度<input type="range" min="520" max="920" step="20" value={preferences.columnWidth} onChange={(event) => updatePreferences({ columnWidth: Number(event.target.value) })} /><output>{preferences.columnWidth}</output></label>
                <label className="setting-range">左右边距<input type="range" min="16" max="160" step="4" value={preferences.pageMargin} onChange={(event) => updatePreferences({ pageMargin: Number(event.target.value) })} /><output>{preferences.pageMargin}</output></label>
                <label className="setting-select">主题<select value={preferences.theme} onChange={(event) => updatePreferences({ theme: event.target.value as ReaderPreferences['theme'] })}><option value="paper">纸白</option><option value="sepia">暖色</option><option value="night">夜间</option></select></label>
                <label className="setting-toggle"><span>段落聚焦</span><input type="checkbox" checked={preferences.focusMode === 'paragraph'} onChange={(event) => updatePreferences({ focusMode: event.target.checked ? 'paragraph' : 'off' })} /></label>
                <label className="setting-toggle"><span>逐句色块</span><input type="checkbox" checked={preferences.sentenceHighlight} onChange={(event) => updatePreferences({ sentenceHighlight: event.target.checked })} /></label>
              </section>
            )}
          </div>
        </div>
      </header>
      <div className={`reader-body ${notesOpen ? 'has-notes' : ''}`}>
        <main className="reader-content">
          <Suspense fallback={<div className="reader-empty"><span className="loading-indicator" />正在载入阅读器</div>}>
            {documentRecord.kind === 'epub' && <EpubReader key={documentRecord.id} {...readerProps} />}
            {documentRecord.kind === 'pdf' && <PdfReader key={documentRecord.id} {...readerProps} />}
            {(documentRecord.kind === 'text' || documentRecord.kind === 'markdown' || documentRecord.kind === 'docx') && <FlowReader key={documentRecord.id} {...readerProps} />}
          </Suspense>
        </main>
        {notesOpen && <NotesPanel annotations={annotations} onClose={() => setNotesOpen(false)} onDelete={props.onDeleteAnnotation} onUpdateNote={props.onUpdateNote} onExport={(format) => props.onExport(format, format === 'json' ? exportJson(documentRecord, annotations) : exportMarkdown(documentRecord, annotations))} />}
      </div>
      {draft && <AnnotationDialog draft={draft} onClose={() => setDraft(undefined)} onSave={(color, note) => props.onCreateAnnotation(draft, color, note)} />}
    </section>
  );
}
