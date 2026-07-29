// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { exportJson, exportMarkdown } from './export';
import type { AnnotationRecord, DocumentRecord } from '../types';

const documentRecord: DocumentRecord = { id: 'doc-1', assetId: 'a'.repeat(64) + '.md', checksum: 'a'.repeat(64), title: '测试文档', sourceName: '测试.md', kind: 'markdown', mimeType: 'text/markdown', size: 12, importedAt: 1, lastOpenedAt: 1 };
const annotation: AnnotationRecord = { id: 'note-1', documentId: 'doc-1', locator: { kind: 'flow', blockId: 'block-0', start: 0, end: 2 }, quote: '专注', color: 'mint', note: '保留留白。', createdAt: 1, updatedAt: 1 };

describe('笔记导出', () => {
  it('导出 Markdown 和带版本的 JSON', () => {
    expect(exportMarkdown(documentRecord, [annotation])).toContain('> 专注');
    const backup = JSON.parse(exportJson(documentRecord, [annotation]));
    expect(backup.version).toBe(1);
    expect(backup.annotations[0].note).toBe('保留留白。');
  });
});
