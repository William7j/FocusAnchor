import type { AnnotationRecord, DocumentRecord } from '../types';

function dateTime(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function locationLabel(annotation: AnnotationRecord) {
  if (annotation.locator.kind === 'pdf') return `第 ${annotation.locator.page} 页`;
  if (annotation.locator.kind === 'epub') return 'EPUB 位置';
  return '文段';
}

export function exportMarkdown(documentRecord: DocumentRecord, annotations: AnnotationRecord[]) {
  const lines = [`# ${documentRecord.title}：阅读笔记`, '', `导出时间：${dateTime(Date.now())}`, ''];
  for (const annotation of annotations.sort((left, right) => left.createdAt - right.createdAt)) {
    lines.push(`## ${locationLabel(annotation)} · ${dateTime(annotation.createdAt)}`, '', `> ${annotation.quote}`, '');
    if (annotation.note.trim()) lines.push(annotation.note.trim(), '');
  }
  return lines.join('\n');
}

export function exportJson(documentRecord: DocumentRecord, annotations: AnnotationRecord[]) {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), document: documentRecord, annotations }, null, 2);
}
