// Echo Volume.exe --uninstall [--silent] [--remove-data]: the uninstaller, with the same window as setup.
// Loaded by desktop/main.js before anything of the app starts. An all-users install asks for admin rights first.
const os = require('os');
const path = require('path');
const { app } = require('electron');
const C = require('./lib/common');
const { uninstall, installInfo } = require('./lib/uninstall');
const { createWindow, handle, commonIpc } = require('./lib/window');

const log = C.createLog('uninstall');
const argv = process.argv.slice(1).map((a) => a.toLowerCase());
const SILENT = argv.some((a) => ['--silent', '/s'].includes(a));

// Its own profile in %TEMP%: the real one (%APPDATA%\Echo Volume) may be deleted and must not be in use
app.setPath('userData', path.join(os.tmpdir(), 'echo-volume-uninstall-profile'));
app.setAppUserModelId('local.echovolume.uninstall');

let win = null, busy = false, info = installInfo();
const emit = (p) => win && !win.isDestroyed() && win.webContents.send('setup:progress', { phase: 'uninstall', ...p });

app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  const elevated = await C.isElevated();
  log.info('Uninstaller started', { ...info, elevated, silent: SILENT, packaged: app.isPackaged });
  if (info.scope === 'machine' && !elevated && app.isPackaged) {
    if (argv.includes('--elevated') || !(await C.relaunchElevated(process.execPath, process.argv.slice(1).concat('--elevated')))) {
      log.warn('Administrator rights were not given');
    }
    return app.quit();
  }
  if (SILENT) {
    try { await uninstall({ removeData: argv.includes('--remove-data') }, () => {}, log); app.exit(0); } catch (e) { log.error('Uninstall failed', { error: e.message }); app.exit(1); }
    return;
  }
  win = createWindow({ title: `Uninstall ${C.PRODUCT}` });
  win.on('close', (e) => { if (busy) e.preventDefault(); });
  commonIpc(() => win, () => { if (!busy) win.destroy(); });
  handle('setup:state', () => ({
    mode: 'uninstall', product: C.PRODUCT, version: info.version, elevated, existing: null, defaults: {}, auto: null,
    uninstall: { dir: info.dir, scope: info.scope, dataDir: C.DATA_DIR() },
  }));
  handle('setup:uninstall', async (_e, o) => {
    if (busy) throw new Error('Already uninstalling');
    busy = true;
    try {
      const r = await uninstall({ removeData: o?.removeData === true }, emit, log);
      return { ok: true, ...r };
    } catch (e) {
      log.error('Uninstall failed', { error: e.message });
      return { ok: false, error: e.message };
    } finally { busy = false; }
  });
});
