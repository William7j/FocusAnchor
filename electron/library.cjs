const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SUPPORTED_EXTENSIONS = new Map([
  ['.epub', { kind: 'epub', mimeType: 'application/epub+zip' }],
  ['.pdf', { kind: 'pdf', mimeType: 'application/pdf' }],
  ['.txt', { kind: 'text', mimeType: 'text/plain; charset=utf-8' }],
  ['.md', { kind: 'markdown', mimeType: 'text/markdown; charset=utf-8' }],
  ['.markdown', { kind: 'markdown', mimeType: 'text/markdown; charset=utf-8' }],
  ['.docx', { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
]);
const ASSET_ID_PATTERN = /^([a-f0-9]{64})\.(epub|pdf|txt|md|markdown|docx)$/;
const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024;

function extensionFor(filePath) {
  return path.extname(filePath).toLowerCase();
}

function documentInfoFor(filePath) {
  const extension = extensionFor(filePath);
  const info = SUPPORTED_EXTENSIONS.get(extension);
  if (!info) throw new Error('仅支持 EPUB、PDF、TXT、Markdown 和 DOCX 文件。');
  return { extension, ...info };
}

function assetIdIsValid(assetId) {
  return ASSET_ID_PATTERN.test(String(assetId || ''));
}

function mimeTypeForAsset(assetId) {
  const match = ASSET_ID_PATTERN.exec(String(assetId || ''));
  return match ? SUPPORTED_EXTENSIONS.get(`.${match[2]}`)?.mimeType || 'application/octet-stream' : 'application/octet-stream';
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function safeExportName(value, extension) {
  const base = String(value || '阅读笔记')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || '阅读笔记';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

class LibraryService {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  async ensure() {
    await fsp.mkdir(this.rootDirectory, { recursive: true });
  }

  assetPath(assetId) {
    if (!assetIdIsValid(assetId)) return null;
    const candidate = path.join(this.rootDirectory, assetId);
    const relative = path.relative(this.rootDirectory, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return candidate;
  }

  existingAssetPath(assetId) {
    const candidate = this.assetPath(assetId);
    return candidate && fs.existsSync(candidate) ? candidate : null;
  }

  async importFile(filePath) {
    const info = documentInfoFor(filePath);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('只能导入普通文件。');
    if (!stat.size) throw new Error('不能导入空文件。');
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('单个文档不能超过 512 MB。');

    await this.ensure();
    const checksum = await sha256File(filePath);
    const assetId = `${checksum}${info.extension}`;
    const targetPath = this.assetPath(assetId);
    const exists = Boolean(targetPath && fs.existsSync(targetPath));
    if (!exists) {
      const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.partial`;
      await fsp.copyFile(filePath, temporaryPath);
      await fsp.rename(temporaryPath, targetPath);
    }

    return {
      assetId,
      checksum,
      kind: info.kind,
      mimeType: info.mimeType,
      sourceName: path.basename(filePath),
      title: path.basename(filePath, info.extension),
      size: stat.size,
      duplicate: exists,
    };
  }

  async deleteAsset(assetId) {
    const targetPath = this.assetPath(assetId);
    if (!targetPath) throw new Error('文档资源无效。');
    try {
      await fsp.unlink(targetPath);
      return { deleted: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { deleted: false };
      throw new Error(`无法删除本地文档：${error.message || '未知错误'}`);
    }
  }

  async pickAndImport(parentWindow, dialog) {
    const result = await dialog.showOpenDialog(parentWindow, {
      title: '导入本地文档',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '阅读文档', extensions: ['epub', 'pdf', 'txt', 'md', 'markdown', 'docx'] }],
    });
    if (result.canceled) return [];

    const imported = [];
    const failures = [];
    for (const filePath of result.filePaths) {
      try {
        imported.push(await this.importFile(filePath));
      } catch (error) {
        failures.push({ name: path.basename(filePath), message: error.message });
      }
    }
    if (failures.length && !imported.length) throw new Error(failures.map((item) => `${item.name}：${item.message}`).join('\n'));
    return { imported, failures };
  }

  async exportText(parentWindow, dialog, payload) {
    const content = String(payload?.content || '');
    if (!content || content.length > 10 * 1024 * 1024) throw new Error('导出内容无效或过大。');
    const extension = payload?.format === 'json' ? '.json' : '.md';
    const result = await dialog.showSaveDialog(parentWindow, {
      title: '导出笔记',
      defaultPath: safeExportName(payload?.suggestedName, extension),
      filters: [{ name: extension === '.json' ? 'JSON 文件' : 'Markdown 文件', extensions: [extension.slice(1)] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await fsp.writeFile(result.filePath, content, 'utf8');
    return { saved: true };
  }
}

module.exports = {
  LibraryService,
  SUPPORTED_EXTENSIONS,
  assetIdIsValid,
  documentInfoFor,
  mimeTypeForAsset,
  safeExportName,
  sha256File,
};
