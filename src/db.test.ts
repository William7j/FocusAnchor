// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { db, savePosition } from './db';

afterEach(async () => {
  await db.positions.clear();
});

describe('阅读进度', () => {
  it('按文档 ID 覆盖保存最新进度', async () => {
    await savePosition({ documentId: 'doc-1', locator: '{"ratio":0.2}', progress: .2, updatedAt: 1 });
    await savePosition({ documentId: 'doc-1', locator: '{"ratio":0.8}', progress: .8, updatedAt: 2 });
    await expect(db.positions.get('doc-1')).resolves.toMatchObject({ progress: .8, updatedAt: 2 });
  });
});
