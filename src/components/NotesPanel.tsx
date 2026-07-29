import { Download, FileJson, FileText, Trash2, X } from 'lucide-react';
import type { AnnotationRecord } from '../types';

interface NotesPanelProps {
  annotations: AnnotationRecord[];
  onClose: () => void;
  onDelete: (id: string) => Promise<void>;
  onUpdateNote: (id: string, note: string) => Promise<void>;
  onExport: (format: 'markdown' | 'json') => Promise<void>;
}

function dateTime(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}

export function NotesPanel({ annotations, onClose, onDelete, onUpdateNote, onExport }: NotesPanelProps) {
  return (
    <aside className="notes-panel" aria-label="我的笔记">
      <header className="notes-header">
        <div><span className="eyebrow">仅本机</span><h2>我的笔记</h2></div>
        <div className="header-actions">
          <button className="icon-button" type="button" aria-label="导出 Markdown" title="导出 Markdown" onClick={() => onExport('markdown')}><FileText size={17} /></button>
          <button className="icon-button" type="button" aria-label="导出 JSON" title="导出 JSON" onClick={() => onExport('json')}><FileJson size={17} /></button>
          <button className="icon-button" type="button" aria-label="关闭笔记" title="关闭笔记" onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      {annotations.length ? (
        <div className="notes-list">
          {[...annotations].sort((left, right) => right.createdAt - left.createdAt).map((annotation) => (
            <article className="note-item" key={annotation.id}>
              <div className="note-meta"><span className={`annotation-dot annotation-${annotation.color}`} /><time>{dateTime(annotation.createdAt)}</time><button className="icon-button tiny" type="button" aria-label="删除笔记" title="删除" onClick={() => onDelete(annotation.id)}><Trash2 size={14} /></button></div>
              <blockquote>{annotation.quote}</blockquote>
              <textarea defaultValue={annotation.note} placeholder="添加想法" onBlur={(event) => onUpdateNote(annotation.id, event.target.value)} />
            </article>
          ))}
        </div>
      ) : (
        <div className="notes-empty"><Download size={21} /><span>选中文本后可添加划线和想法</span></div>
      )}
    </aside>
  );
}
