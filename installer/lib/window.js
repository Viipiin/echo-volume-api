// The setup / uninstall window: frameless, rounded (transparent corners), locked down. Shared IPC for both modes.
const path = require('path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const C = require('./common');

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererUrl = require('url').pathToFileURL(RENDERER).href;

function createWindow({ title }) {
  // No permissions (camera, notifications, …), no remote content
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools|data):/.test(d.url) }));
  const win = new BrowserWindow({
    width: 760, height: 480, frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    show: false, title, backgroundColor: '#00000000', icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      spellcheck: false, devTools: !app.isPackaged, webviewTag: false, navigateOnDragDrop: false,
    },
  });
  win.setMenu(null);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.loadFile(RENDERER);
  return win;
}

// IPC only from our own page
const fromUs = (e) => e.senderFrame?.url?.split(/[?#]/)[0] === rendererUrl;
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromUs(e)) throw new Error('Blocked');
    return fn(e, ...args);
  });
}
// Window buttons, the log; onClose decides what closing means (cancel while installing)
function commonIpc(getWin, onClose) {
  handle('setup:minimize', () => getWin()?.minimize());
  handle('setup:close', () => onClose());
  handle('setup:open-log', () => shell.openPath(C.LOG_FILE));
}

module.exports = { createWindow, handle, commonIpc };
