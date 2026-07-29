import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AnnotationColor, SelectionDraft } from '../types';

const colors: Array<{ value: AnnotationColor; label: string }> = [
  { value: 'sun', label: '暖黄' },
  { value: 'mint', label: '薄荷' },
  { value: 'sky', label: '晴蓝' },
  { value: 'rose', label: '珊瑚' },
];

interface AnnotationDialogProps {
  draft: SelectionDraft;
  onClose: () => void;
  onSave: (color: AnnotationColor, note: string) => Promise<void>;
}

export function AnnotationDialog({ draft, onClose, onSave }: AnnotationDialogProps) {
  const [color, setColor] = useState<AnnotationColor>('sun');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setColor('sun');
    setNote('');
  }, [draft]);

  async function save() {
    setSaving(true);
    try {
      await onSave(color, note);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="annotation-dialog" role="dialog" aria-modal="true" aria-label="添加想法" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">选中文本</span>
            <h2>记录想法</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭" title="关闭"><X size={18} /></button>
        </header>
        <blockquote>{draft.quote}</blockquote>
        <div className="color-row" aria-label="划线颜色">
          {colors.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`color-swatch color-${item.value} ${color === item.value ? 'is-selected' : ''}`}
              aria-label={item.label}
              title={item.label}
              onClick={() => setColor(item.value)}
            />
          ))}
        </div>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="写下自己的想法" autoFocus />
        <footer className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button type="button" className="command-button" disabled={saving} onClick={save}><Check size={17} />保存</button>
        </footer>
      </section>
    </div>
  );
}
