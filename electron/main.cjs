const { app, BrowserWindow, WebContentsView, ipcMain, protocol, session, dialog, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { LibraryService, assetIdIsValid, mimeTypeForAsset } = require('./library.cjs');
const { isAllowedWeReadUrl, parseCookieImport } = require('./security.cjs');
const {
  defaultWeReadAssistSettings,
  sanitizeWeReadAssistAction,
  sanitizeWeReadAssistSettings,
} = require('./weread-assist.cjs');

protocol.registerSchemesAsPrivileged([{
  scheme: 'reader',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

process.on('uncaughtException', (error) => console.error('[Focus Reader] Uncaught main-process error:', error));
process.on('unhandledRejection', (error) => console.error('[Focus Reader] Unhandled main-process rejection:', error));

const isDevelopment = !app.isPackaged;
const WEREAD_HOME = 'https://weread.qq.com/';
const WEREAD_DIAGNOSTIC_STATUSES = new Set(['scanning', 'ready', 'unsupported', 'error']);
const WEREAD_DIAGNOSTIC_SOURCES = new Set(['none', 'dom', 'canvas']);
const WEREAD_DIAGNOSTIC_REASONS = new Set([
  '',
  'waiting-reader',
  'waiting-canvas-text',
  'canvas-text-not-captured',
  'canvas-capture-unavailable',
  'canvas-2d-unavailable',
  'main-world-capture-failed',
  'capture-pull-failed',
  'capture-buffer-trimmed',
  'custom-highlight-unavailable',
  'waiting-readable-text',
  'rebuild-failed',
  'disabled',
]);
let mainWindow;
let weReadView;
let weReadSession;
let library;
let weReadAttached = false;
let weReadAssistSettings = { ...defaultWeReadAssistSettings };
let weReadAssistDiagnostics = { status: 'scanning', source: 'none', detected: false, sentences: 0, blocks: 0, reason: 'waiting-reader' };

function forwardWeReadAssistDiagnostics() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('weread:assist-diagnostics', weReadAssistDiagnostics);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: '专注阅读',
    backgroundColor: '#f7f9fe',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  if (isDevelopment) mainWindow.loadURL('http://127.0.0.1:5173');
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = undefined;
    weReadAttached = false;
  });
}

function assertRenderer(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('不允许的 IPC 来源。');
}

function normalizedBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') throw new Error('阅读区域尺寸无效。');
  const content = mainWindow?.getContentBounds();
  if (!content) throw new Error('主窗口不可用。');
  const x = Math.max(0, Math.round(Number(bounds.x) || 0));
  const y = Math.max(0, Math.round(Number(bounds.y) || 0));
  const width = Math.max(1, Math.min(content.width - x, Math.round(Number(bounds.width) || 1)));
  const height = Math.max(1, Math.min(content.height - y, Math.round(Number(bounds.height) || 1)));
  return { x, y, width, height };
}

function createWeReadView() {
  if (weReadView && !weReadView.webContents.isDestroyed()) return weReadView;
  weReadSession = session.fromPartition('persist:weread');
  weReadSession.setPermissionCheckHandler(() => false);
  weReadSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  weReadView = new WebContentsView({
    webPreferences: {
      partition: 'persist:weread',
      preload: path.join(__dirname, 'weread-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const contents = weReadView.webContents;
  contents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    weReadAssistDiagnostics = { status: 'scanning', source: 'none', detected: false, sentences: 0, blocks: 0, reason: 'waiting-reader' };
    forwardWeReadAssistDiagnostics();
  });
  contents.on('did-finish-load', () => {
    if (!contents.isDestroyed()) contents.send('weread-assist:settings', weReadAssistSettings);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedWeReadUrl(url)) contents.loadURL(url).catch(() => undefined);
    else if (url.startsWith('https://')) shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedWeReadUrl(url)) {
      event.preventDefault();
      if (url.startsWith('https://')) shell.openExternal(url).catch(() => undefined);
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedWeReadUrl(url)) event.preventDefault();
  });
  contents.loadURL(WEREAD_HOME).catch((error) => console.warn('[Focus Reader] WeRead initial load failed:', error.message));
  return weReadView;
}

function showWeRead(bounds) {
  if (!mainWindow) throw new Error('主窗口不可用。');
  const view = createWeReadView();
  if (!weReadAttached) {
    mainWindow.contentView.addChildView(view);
    weReadAttached = true;
  }
  view.setBounds(normalizedBounds(bounds));
  view.webContents.focus();
}

function hideWeRead() {
  if (!mainWindow || !weReadView || !weReadAttached) return;
  mainWindow.contentView.removeChildView(weReadView);
  weReadAttached = false;
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return { invalid: true };
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

async function registerReaderProtocol() {
  await protocol.handle('reader', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'document') return new Response('Not found', { status: 404 });
      const assetId = decodeURIComponent(url.pathname.slice(1));
      if (!assetIdIsValid(assetId)) return new Response('Not found', { status: 404 });
      const assetPath = library.existingAssetPath(assetId);
      if (!assetPath) return new Response('Not found', { status: 404 });
      const stat = await fsp.stat(assetPath);
      const range = parseRange(request.headers.get('range'), stat.size);
      if (range?.invalid) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
      const start = range?.start ?? 0;
      const end = range?.end ?? stat.size - 1;
      const headers = {
        'content-type': mimeTypeForAsset(assetId),
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
      };
      if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
      const stream = Readable.toWeb(fs.createReadStream(assetPath, { start, end }));
      return new Response(stream, { status: range ? 206 : 200, headers });
    } catch (error) {
      console.warn('[Focus Reader] Local document request failed:', error.message);
      return new Response('Unable to open document', { status: 500 });
    }
  });
}

async function weReadStatus() {
  if (!weReadSession) weReadSession = session.fromPartition('persist:weread');
  const cookies = await weReadSession.cookies.get({ domain: 'weread.qq.com' });
  return { visible: weReadAttached, hasSession: cookies.length > 0 };
}

function setupIpc() {
  ipcMain.handle('library:import', async (event) => {
    assertRenderer(event);
    return library.pickAndImport(mainWindow, dialog);
  });
  ipcMain.handle('library:export', async (event, payload) => {
    assertRenderer(event);
    return library.exportText(mainWindow, dialog, payload);
  });
  ipcMain.handle('library:delete', async (event, payload) => {
    assertRenderer(event);
    return library.deleteAsset(payload?.assetId);
  });
  ipcMain.handle('weread:open', async (event, bounds) => {
    assertRenderer(event);
    showWeRead(bounds);
    return weReadStatus();
  });
  ipcMain.handle('weread:hide', async (event) => {
    assertRenderer(event);
    hideWeRead();
    return weReadStatus();
  });
  ipcMain.handle('weread:set-bounds', async (event, bounds) => {
    assertRenderer(event);
    if (weReadAttached && weReadView) weReadView.setBounds(normalizedBounds(bounds));
  });
  ipcMain.handle('weread:login', async (event) => {
    assertRenderer(event);
    const view = createWeReadView();
    await view.webContents.loadURL(WEREAD_HOME);
    return weReadStatus();
  });
  ipcMain.handle('weread:import-cookie', async (event, payload) => {
    assertRenderer(event);
    const cookies = parseCookieImport(payload);
    if (!weReadSession) weReadSession = session.fromPartition('persist:weread');
    for (const cookie of cookies) await weReadSession.cookies.set(cookie);
    if (weReadView && !weReadView.webContents.isDestroyed()) weReadView.webContents.reloadIgnoringCache();
    return { imported: cookies.length };
  });
  ipcMain.handle('weread:logout', async (event) => {
    assertRenderer(event);
    if (!weReadSession) weReadSession = session.fromPartition('persist:weread');
    await weReadSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    if (weReadView && !weReadView.webContents.isDestroyed()) await weReadView.webContents.loadURL(WEREAD_HOME);
    return weReadStatus();
  });
  ipcMain.handle('weread:status', async (event) => {
    assertRenderer(event);
    return weReadStatus();
  });
  ipcMain.handle('weread:get-assist-diagnostics', async (event) => {
    assertRenderer(event);
    return weReadAssistDiagnostics;
  });
  ipcMain.handle('weread:set-assist', async (event, payload) => {
    assertRenderer(event);
    weReadAssistSettings = sanitizeWeReadAssistSettings(payload);
    if (weReadView && !weReadView.webContents.isDestroyed()) {
      weReadView.webContents.send('weread-assist:settings', weReadAssistSettings);
    }
    return weReadAssistSettings;
  });
  ipcMain.handle('weread:assist-action', async (event, payload) => {
    assertRenderer(event);
    const action = sanitizeWeReadAssistAction(payload);
    if (weReadView && !weReadView.webContents.isDestroyed()) {
      weReadView.webContents.send('weread-assist:action', action);
    }
  });
  ipcMain.on('weread-assist:diagnostics', (event, payload) => {
    if (!mainWindow || !weReadView || event.sender !== weReadView.webContents) return;
    const source = payload && typeof payload === 'object' ? payload : {};
    const requestedStatus = String(source.status || '');
    const status = WEREAD_DIAGNOSTIC_STATUSES.has(requestedStatus) ? requestedStatus : source.detected ? 'ready' : 'scanning';
    const requestedSource = String(source.source || '');
    const diagnostics = {
      status,
      source: WEREAD_DIAGNOSTIC_SOURCES.has(requestedSource) ? requestedSource : 'none',
      detected: status === 'ready',
      sentences: Math.max(0, Math.min(5000, Math.round(Number(source.sentences) || 0))),
      blocks: Math.max(0, Math.min(1000, Math.round(Number(source.blocks) || 0))),
      reason: WEREAD_DIAGNOSTIC_REASONS.has(String(source.reason || '')) ? String(source.reason || '') : '',
    };
    weReadAssistDiagnostics = diagnostics;
    forwardWeReadAssistDiagnostics();
  });
  ipcMain.on('weread-assist:page', (event, payload) => {
    if (!weReadView || event.sender !== weReadView.webContents || weReadView.webContents.isDestroyed()) return;
    const direction = Number(payload?.direction);
    if (direction !== -1 && direction !== 1) return;
    const keyCode = direction === 1 ? 'Right' : 'Left';
    weReadView.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    weReadView.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  });
}

app.whenReady().then(async () => {
  library = new LibraryService(path.join(app.getPath('userData'), 'library'));
  await library.ensure();
  await registerReaderProtocol();
  setupIpc();
  createMainWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createMainWindow();
  });
}).catch((error) => {
  console.error('[Focus Reader] Startup failed:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (weReadView && !weReadView.webContents.isDestroyed()) weReadView.webContents.close();
});
