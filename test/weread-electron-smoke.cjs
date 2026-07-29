const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Keep the test isolated from the user's persistent Electron profile and do
// not initialize a GPU process in headless Windows smoke runs.
app.setPath('userData', path.join(os.tmpdir(), `focus-reader-smoke-${process.pid}`));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const smokeSettings = {
  mode: 'off',
  dimming: 0.52,
  bandHeight: 150,
  followPointer: false,
  showGuideLine: false,
  sentenceHighlight: true,
};
const fixtureArgument = process.argv.find((argument) => argument.startsWith('--fixture='));
const fixtureName = fixtureArgument ? fixtureArgument.slice('--fixture='.length) : 'weread-canvas.html';
const waitForRedraw = process.argv.includes('--wait-for-redraw');
const assertFinalPaint = process.argv.includes('--assert-final-paint');
let completing = false;
let lastDiagnostics = null;

async function waitForFixtureRedraw(window) {
  if (!waitForRedraw) return true;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const redrawn = await window.webContents.executeJavaScript('Boolean(window.__focusReaderFixtureRedrawn)');
    if (redrawn) {
      // Capture polling plus sentence rebuilding are deliberately async.
      await new Promise((resolve) => setTimeout(resolve, 700));
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function canvasHighlightMargins(window) {
  return window.webContents.executeJavaScript(`
    (() => {
      const canvas = document.querySelector('.wr_canvasContainer canvas');
      const fragments = [...document.querySelectorAll('.focus-reader-sentence-fragment')];
      if (!(canvas instanceof HTMLCanvasElement) || !fragments.length) return [];
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return [];
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const canvasRect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / canvasRect.width;
      const scaleY = canvas.height / canvasRect.height;
      return fragments.map((fragment) => {
        const rect = fragment.getBoundingClientRect();
        const left = Math.max(0, Math.floor((rect.left - canvasRect.left) * scaleX));
        const right = Math.min(canvas.width, Math.ceil((rect.right - canvasRect.left) * scaleX));
        const top = Math.max(0, Math.floor((rect.top - canvasRect.top) * scaleY));
        const bottom = Math.min(canvas.height, Math.ceil((rect.bottom - canvasRect.top) * scaleY));
        let inkTop = bottom;
        let inkBottom = top - 1;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            if (pixels[offset + 3] > 128 && pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100) {
              inkTop = Math.min(inkTop, y);
              inkBottom = Math.max(inkBottom, y);
            }
          }
        }
        return {
          topMargin: (inkTop - top) / scaleY,
          bottomMargin: (bottom - inkBottom - 1) / scaleY,
          hasInk: inkBottom >= inkTop,
        };
      });
    })()
  `);
}

async function canvasConnectorCount(window) {
  return window.webContents.executeJavaScript("document.querySelectorAll('.focus-reader-sentence-connector, .sentence-connector').length");
}

async function canvasFragmentTops(window) {
  return window.webContents.executeJavaScript(`
    (() => {
      const canvas = document.querySelector('.wr_canvasContainer canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return [];
      const canvasTop = canvas.getBoundingClientRect().top;
      return [...document.querySelectorAll('.focus-reader-sentence-fragment')]
        .map((fragment) => fragment.getBoundingClientRect().top - canvasTop);
    })()
  `);
}

const timeout = setTimeout(() => {
  console.error(`WE_READ_SMOKE_TIMEOUT diagnostics=${JSON.stringify(lastDiagnostics)}`);
  app.exit(1);
}, 12000);

ipcMain.on('weread-assist:diagnostics', async (event, diagnostics) => {
  lastDiagnostics = diagnostics;
  if (completing || diagnostics?.status !== 'ready' || diagnostics?.source !== 'canvas') return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  completing = true;
  const redrawn = await waitForFixtureRedraw(window);
  window.webContents.send('weread-assist:settings', smokeSettings);
  let coloredPixels = 0;
  for (let attempt = 0; attempt < 6 && coloredPixels <= 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const bitmap = (await window.webContents.capturePage()).toBitmap();
    let currentColoredPixels = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      const blue = bitmap[index];
      const green = bitmap[index + 1];
      const red = bitmap[index + 2];
      if (red > 180 && green > blue + 8 && red > blue + 14) currentColoredPixels += 1;
    }
    coloredPixels = Math.max(coloredPixels, currentColoredPixels);
  }
  clearTimeout(timeout);
  const margins = await canvasHighlightMargins(window);
  const connectorCount = await canvasConnectorCount(window);
  const fragmentTops = await canvasFragmentTops(window);
  const centered = margins.length >= 2
    && margins.every((margin) => margin.hasInk && Math.abs(margin.topMargin - margin.bottomMargin) <= 2.2);
  const finalPaintIsClean = !assertFinalPaint || (fragmentTops.length >= 2 && fragmentTops.every((top) => top >= 430));
  if (redrawn && diagnostics.sentences >= 3 && coloredPixels > 100 && centered && connectorCount === 0 && finalPaintIsClean) {
    console.log(`WE_READ_SMOKE_OK fixture=${fixtureName} sentences=${diagnostics.sentences} coloredPixels=${coloredPixels} connectors=${connectorCount} fragmentTops=${JSON.stringify(fragmentTops)} margins=${JSON.stringify(margins)}`);
    app.exit(0);
  } else {
    console.error(`WE_READ_SMOKE_FAILED fixture=${fixtureName} redrawn=${redrawn} sentences=${diagnostics.sentences} coloredPixels=${coloredPixels} connectors=${connectorCount} fragmentTops=${JSON.stringify(fragmentTops)} margins=${JSON.stringify(margins)}`);
    app.exit(1);
  }
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'weread-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('did-finish-load', () => {
    window.webContents.send('weread-assist:settings', smokeSettings);
  });
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', fixtureName), 'utf8');
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
