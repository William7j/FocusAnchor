// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import libraryModule from '../electron/library.cjs';

const { LibraryService, assetIdIsValid, safeExportName } = libraryModule;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('本地书库资产隔离', () => {
  it('复制支持的文档并以哈希资产 ID 暴露', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'focus-reader-test-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'chapter.md');
    const libraryRoot = path.join(root, 'library');
    await fs.writeFile(source, '# chapter\n\nA focused paragraph.', 'utf8');
    const service = new LibraryService(libraryRoot);
    const imported = await service.importFile(source);
    expect(imported.kind).toBe('markdown');
    expect(assetIdIsValid(imported.assetId)).toBe(true);
    expect(service.existingAssetPath(imported.assetId)).toContain(libraryRoot);
  });

  it('拒绝伪造资产 ID 和不安全导出文件名', () => {
    expect(assetIdIsValid('../secret.pdf')).toBe(false);
    expect(safeExportName('我的:笔记?', '.md')).toBe('我的-笔记-.md');
  });

  it('只删除应用书库中已导入的副本', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'focus-reader-test-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'chapter.txt');
    const libraryRoot = path.join(root, 'library');
    await fs.writeFile(source, '保留原始文件。', 'utf8');
    const service = new LibraryService(libraryRoot);
    const imported = await service.importFile(source);

    await expect(service.deleteAsset(imported.assetId)).resolves.toEqual({ deleted: true });
    expect(service.existingAssetPath(imported.assetId)).toBeNull();
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('保留原始文件。');
    await expect(service.deleteAsset(imported.assetId)).resolves.toEqual({ deleted: false });
  });
});
