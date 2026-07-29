import { BookMarked, Cloud, FilePlus2, Library, LoaderCircle, NotebookPen, Pencil, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { db, getPreferences, savePosition, savePreferences } from './db';
import { ReaderWorkspace } from './components/ReaderWorkspace';
import { WereadWorkspace } from './components/WereadWorkspace';
import brandLogo from './assets/focus-reader-mark.svg';
import type { AnnotationColor, AnnotationRecord, DocumentRecord, ImportedAsset, ReaderPreferences, ReadingPosition, SelectionDraft } from './types';

type Route = 'library' | 'weread' | 'reader';

const documentTypeLabel: Record<DocumentRecord['kind'], string> = {
  epub: 'EPUB', pdf: 'PDF', text: 'TXT', markdown: 'MD', docx: 'DOCX',
};

function fileSize(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function App() {
  const [route, setRoute] = useState<Route>('library');
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [positions, setPositions] = useState<Record<string, ReadingPosition>>({});
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({});
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord>();
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [position, setPosition] = useState<ReadingPosition>();
  const [preferences, setPreferences] = useState<ReaderPreferences>();
  const [importing, setImporting] = useState(false);
  const [wereadImmersive, setWereadImmersive] = useState(false);
  const [renamingDocument, setRenamingDocument] = useState<DocumentRecord>();
  const [renameValue, setRenameValue] = useState('');
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<number | undefined>();

  const notify = useCallback((message: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4800);
  }, []);

  const refreshLibrary = useCallback(async () => {
    const [nextDocuments, nextPositions, nextAnnotations] = await Promise.all([
      db.documents.orderBy('lastOpenedAt').reverse().toArray(),
      db.positions.toArray(),
      db.annotations.toArray(),
    ]);
    setDocuments(nextDocuments);
    setPositions(Object.fromEntries(nextPositions.map((item) => [item.documentId, item])));
    setNoteCounts(nextAnnotations.reduce<Record<string, number>>((counts, item) => {
      counts[item.documentId] = (counts[item.documentId] || 0) + 1;
      return counts;
    }, {}));
  }, []);

  useEffect(() => {
    getPreferences().then(setPreferences);
    refreshLibrary().catch((error: Error) => notify(error.message));
    return () => window.clearTimeout(noticeTimer.current);
  }, [notify, refreshLibrary]);

  useEffect(() => {
    if (route !== 'weread') setWereadImmersive(false);
  }, [route]);

  async function openDocument(documentRecord: DocumentRecord) {
    const opened = { ...documentRecord, lastOpenedAt: Date.now() };
    await db.documents.put(opened);
    const [nextPosition, nextAnnotations] = await Promise.all([
      db.positions.get(opened.id),
      db.annotations.where('documentId').equals(opened.id).toArray(),
    ]);
    setSelectedDocument(opened);
    setPosition(nextPosition);
    setAnnotations(nextAnnotations);
    setRoute('reader');
    refreshLibrary().catch(() => undefined);
  }

  async function importDocuments() {
    const native = window.readerNative?.library;
    if (!native) {
      notify('请从桌面应用打开书库。');
      return;
    }
    setImporting(true);
    try {
      const result = await native.importDocuments();
      const assets = Array.isArray(result) ? [] : result.imported;
      const importedDocuments: DocumentRecord[] = [];
      for (const asset of assets) {
        const existing = await db.documents.where('checksum').equals(asset.checksum).first();
        if (existing) {
          const updated = { ...existing, lastOpenedAt: Date.now() };
          await db.documents.put(updated);
          importedDocuments.push(updated);
          continue;
        }
        const documentRecord: DocumentRecord = {
          id: crypto.randomUUID(),
          assetId: asset.assetId,
          checksum: asset.checksum,
          title: asset.title || asset.sourceName,
          sourceName: asset.sourceName,
          kind: asset.kind,
          mimeType: asset.mimeType,
          size: asset.size,
          importedAt: Date.now(),
          lastOpenedAt: Date.now(),
        };
        await db.documents.add(documentRecord);
        importedDocuments.push(documentRecord);
      }
      await refreshLibrary();
      if (!Array.isArray(result) && result.failures.length) notify(`已导入 ${assets.length} 个文档；${result.failures.length} 个未能导入。`);
      if (importedDocuments[0]) await openDocument(importedDocuments[0]);
    } catch (error: any) {
      notify(error.message || '导入文档失败。');
    } finally {
      setImporting(false);
    }
  }

  async function persistPosition(next: { locator: string; progress: number }) {
    if (!selectedDocument) return;
    const record: ReadingPosition = { documentId: selectedDocument.id, locator: next.locator, progress: next.progress, updatedAt: Date.now() };
    setPosition(record);
    setPositions((current) => ({ ...current, [record.documentId]: record }));
    await savePosition(record);
  }

  async function createAnnotation(draft: SelectionDraft, color: AnnotationColor, note: string) {
    if (!selectedDocument) return;
    const annotation: AnnotationRecord = {
      id: crypto.randomUUID(),
      documentId: selectedDocument.id,
      locator: draft.locator,
      quote: draft.quote,
      color,
      note,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.annotations.add(annotation);
    setAnnotations((current) => [...current, annotation]);
    setNoteCounts((current) => ({ ...current, [annotation.documentId]: (current[annotation.documentId] || 0) + 1 }));
    window.getSelection()?.removeAllRanges();
  }

  async function updateNote(id: string, note: string) {
    const target = annotations.find((item) => item.id === id);
    if (!target || target.note === note) return;
    const updatedAt = Date.now();
    await db.annotations.update(id, { note, updatedAt });
    setAnnotations((current) => current.map((item) => item.id === id ? { ...item, note, updatedAt } : item));
  }

  async function deleteAnnotation(id: string) {
    const target = annotations.find((item) => item.id === id);
    if (!target) return;
    await db.annotations.delete(id);
    setAnnotations((current) => current.filter((item) => item.id !== id));
    setNoteCounts((current) => ({ ...current, [target.documentId]: Math.max(0, (current[target.documentId] || 1) - 1) }));
  }

  function beginRename(documentRecord: DocumentRecord) {
    setRenamingDocument(documentRecord);
    setRenameValue(documentRecord.title);
  }

  async function renameDocument() {
    const documentRecord = renamingDocument;
    const title = renameValue.trim().replace(/\s+/g, ' ');
    if (!documentRecord || !title) return;
    const updated = { ...documentRecord, title: title.slice(0, 160) };
    try {
      await db.documents.put(updated);
      setDocuments((current) => current.map((item) => item.id === updated.id ? updated : item));
      setSelectedDocument((current) => current?.id === updated.id ? updated : current);
      setRenamingDocument(undefined);
      notify('书名已更新。');
    } catch (error: any) {
      notify(error.message || '重命名失败。');
    }
  }

  async function removeDocument(documentRecord: DocumentRecord) {
    if (!window.confirm(`确定从书库删除《${documentRecord.title}》吗？相关笔记和阅读进度也会删除。`)) return;
    const native = window.readerNative?.library;
    if (!native) {
      notify('请从桌面应用管理本地书库。');
      return;
    }
    try {
      await native.deleteDocument({ assetId: documentRecord.assetId });
      await db.transaction('rw', db.documents, db.positions, db.annotations, async () => {
        await db.documents.delete(documentRecord.id);
        await db.positions.delete(documentRecord.id);
        await db.annotations.where('documentId').equals(documentRecord.id).delete();
      });
      if (selectedDocument?.id === documentRecord.id) {
        setSelectedDocument(undefined);
        setAnnotations([]);
        setPosition(undefined);
        setRoute('library');
      }
      await refreshLibrary();
      notify('已从书库删除。');
    } catch (error: any) {
      notify(error.message || '删除文档失败。');
    }
  }

  function updatePreferences(next: ReaderPreferences) {
    setPreferences(next);
    savePreferences(next).catch((error: Error) => notify(error.message));
  }

  async function exportNotes(format: 'markdown' | 'json', content: string) {
    if (!selectedDocument || !window.readerNative?.library) return;
    try {
      const result = await window.readerNative.library.exportNotes({ content, format, suggestedName: `${selectedDocument.title}-笔记` });
      if (result.saved) notify('笔记已导出。');
    } catch (error: any) {
      notify(error.message || '笔记导出失败。');
    }
  }

  const activeRoute = route === 'reader' && !selectedDocument ? 'library' : route;
  if (!preferences) return <div className="boot-screen"><LoaderCircle className="spin" size={24} />正在准备阅读空间</div>;

  return (
    <div className={`app-shell ${wereadImmersive && activeRoute === 'weread' ? 'is-weread-immersive' : ''}`}>
      <aside className="app-sidebar">
        <div className="brand"><img className="brand-mark" src={brandLogo} alt="" /><span>专注阅读</span></div>
        <nav aria-label="主导航">
          <button className={activeRoute === 'library' ? 'is-active' : ''} type="button" onClick={() => setRoute('library')}><Library size={18} /><span>本地书库</span></button>
          <button className={activeRoute === 'weread' ? 'is-active' : ''} type="button" onClick={() => setRoute('weread')}><Cloud size={18} /><span>微信读书</span></button>
        </nav>
        <div className="sidebar-bottom"><span><NotebookPen size={16} />离线笔记</span></div>
      </aside>
      <main className="app-main">
        {activeRoute === 'library' && (
          <section className="library-workspace">
            <header className="workspace-header"><div><span className="eyebrow">本地书库</span><h1>继续阅读</h1></div><button className="command-button" type="button" disabled={importing} onClick={importDocuments}>{importing ? <LoaderCircle className="spin" size={17} /> : <FilePlus2 size={17} />}{importing ? '正在导入' : '导入文档'}</button></header>
            {documents.length ? (
              <div className="book-grid">
                {documents.map((documentRecord) => {
                  const progress = positions[documentRecord.id]?.progress || 0;
                  return <article className="book-card" key={documentRecord.id}>
                    <button className="book-card-open" type="button" onClick={() => openDocument(documentRecord)} aria-label={`打开 ${documentRecord.title}`}>
                      <span className={`book-cover cover-${documentRecord.kind}`}><BookMarked size={27} /><small>{documentTypeLabel[documentRecord.kind]}</small></span>
                      <span className="book-card-copy"><strong>{documentRecord.title}</strong><small>{documentRecord.sourceName}</small><span className="book-meta"><span>{fileSize(documentRecord.size)}</span><span>{noteCounts[documentRecord.id] || 0} 条笔记</span></span><span className="progress-track"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span><em>{Math.round(progress * 100)}%</em></span>
                    </button>
                    <span className="book-card-actions">
                      <button className="icon-button tiny" type="button" onClick={() => beginRename(documentRecord)} aria-label={`重命名 ${documentRecord.title}`} title="重命名"><Pencil size={14} /></button>
                      <button className="icon-button tiny destructive-button" type="button" onClick={() => void removeDocument(documentRecord)} aria-label={`删除 ${documentRecord.title}`} title="删除"><Trash2 size={14} /></button>
                    </span>
                  </article>;
                })}
              </div>
            ) : (
              <div className="library-empty"><span className="empty-icon"><FilePlus2 size={30} /></span><h2>把文档放进书库</h2><button className="command-button" type="button" disabled={importing} onClick={importDocuments}><FilePlus2 size={17} />导入文档</button></div>
            )}
          </section>
        )}
        {activeRoute === 'weread' && <WereadWorkspace onNotice={notify} onImmersiveChange={setWereadImmersive} />}
        {activeRoute === 'reader' && selectedDocument && <ReaderWorkspace documentRecord={selectedDocument} annotations={annotations} position={position} preferences={preferences} onBack={() => setRoute('library')} onPosition={persistPosition} onCreateAnnotation={createAnnotation} onDeleteAnnotation={deleteAnnotation} onUpdateNote={updateNote} onPreferences={updatePreferences} onExport={exportNotes} />}
      </main>
      {renamingDocument && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRenamingDocument(undefined)}>
          <form className="annotation-dialog rename-dialog" role="dialog" aria-modal="true" aria-label="重命名书籍" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void renameDocument(); }}>
            <header className="dialog-header"><div><span className="eyebrow">本地书库</span><h2>重命名书籍</h2></div><button className="icon-button" type="button" onClick={() => setRenamingDocument(undefined)} aria-label="关闭" title="关闭"><X size={18} /></button></header>
            <label className="rename-field"><span>书名</span><input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={160} autoFocus /></label>
            <footer className="dialog-actions"><button className="quiet-button" type="button" onClick={() => setRenamingDocument(undefined)}>取消</button><button className="command-button" type="submit" disabled={!renameValue.trim()}>保存</button></footer>
          </form>
        </div>
      )}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
