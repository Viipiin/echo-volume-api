// Echo Volume Setup: the installer app (packaged on its own as a portable exe, see installer/electron-builder.json).
// Carries the packaged app as resources/payload/payload.evpack (+ payload.json) and installs it with a wizard,
// or silently: /S | --silent [--dir=PATH] [--all-users] [--desktop=0] [--startmenu=0] [--startup=1] [--launch]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog, shell } = require('electron');
const C = require('./lib/common');
const { install } = require('./lib/install');
const { createWindow, handle, commonIpc } = require('./lib/window');

const log = C.createLog('setup');
const argv = process.argv.slice(1);
const arg = (name) => { const a = argv.find((x) => x.toLowerCase().startsWith(name.toLowerCase() + '=')); return a ? a.slice(name.length + 1) : null; };
const flag = (...names) => argv.some((x) => names.includes(x.toLowerCase()));
const SILENT = flag('/s', '--silent', '/silent');
const ELEVATED_RELAUNCH = flag('--elevated');
const EXIT = { ok: 0, failed: 1, cancelled: 2, DISK_SPACE: 3, CHECKSUM: 4, NEEDS_ADMIN: 5, BAD_ARGS: 6 };

// Setup keeps nothing of its own in %APPDATA%
app.setPath('userData', path.join(os.tmpdir(), 'echo-volume-setup-profile'));
app.setAppUserModelId('local.echovolume.setup');
// The elevated copy starts while this one is closing, so it doesn't take the lock
if (!ELEVATED_RELAUNCH && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const PAYLOAD_DIR = app.isPackaged ? path.join(process.resourcesPath, 'payload') : path.join(__dirname, 'payload');
let payload;
try {
  payload = { file: path.join(PAYLOAD_DIR, 'payload.evpack'), manifest: JSON.parse(fs.readFileSync(path.join(PAYLOAD_DIR, 'payload.json'), 'utf8')) };
} catch (e) {
  log.error('No payload', { dir: PAYLOAD_DIR, error: e.message });
}

// ---------- options: from the UI or the command line, always checked here ----------
function checkDir(d, existing = false) {
  if (typeof d !== 'string' || !d.trim() || d.length > 200) throw new Error('Choose an install folder.');
  let dir = path.win32.resolve(d.trim());
  if (!/^[A-Za-z]:\\/.test(dir) || /[<>"|?*]/.test(dir.slice(2)) || dir.slice(2).includes(':')) throw new Error('Choose a folder on a local drive.');
  if (existing) return dir; // an install Windows knows about: replaced where it is
  if (path.basename(dir).toLowerCase() !== C.PRODUCT.toLowerCase()) dir = path.join(dir, C.PRODUCT); // always its own folder
  const low = dir.toLowerCase(), win = (process.env.WINDIR || 'C:\\Windows').toLowerCase();
  if (low === win || low.startsWith(win + '\\')) throw new Error('Choose a folder outside Windows.');
  // A folder that exists must be an Echo Volume install (it gets replaced as a whole)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !fs.existsSync(path.join(dir, C.EXE))) {
    throw new Error(`${dir} already has other files in it. Choose another folder.`);
  }
  return dir;
}
function checkOptions(o, state) {
  if (!o || typeof o !== 'object') throw new Error('Bad options');
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const ex = state.existing;
  const action = ex ? (cmpVersion(payload.manifest.version, ex.version) === 0 ? 'repair' : 'upgrade') : 'install';
  // An existing install keeps its place and scope
  const scope = ex ? ex.scope : (o.scope === 'machine' ? 'machine' : 'user');
  return {
    action, scope, dir: ex ? checkDir(ex.dir, true) : checkDir(o.dir || C.locations(scope).defaultDir),
    desktop: bool(o.desktop, true), startMenu: bool(o.startMenu, true), startup: bool(o.startup, false), launch: bool(o.launch, true),
  };
}
const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
};

async function getState() {
  // --ignore-existing: a side-by-side install (testing), leaves other installs alone
  const installs = flag('--ignore-existing') ? [] : await C.findInstalls();
  const existing = installs.find((i) => i.kind === 'setup') || installs[0] || null;
  let auto = null;
  try { auto = arg('--auto') ? JSON.parse(Buffer.from(arg('--auto'), 'base64').toString('utf8')) : null; } catch {}
  return {
    mode: 'setup', product: C.PRODUCT, version: payload.manifest.version, elevated: await C.isElevated(),
    existing: existing && { kind: existing.kind, scope: existing.scope, version: existing.version, dir: existing.dir },
    compare: existing ? cmpVersion(payload.manifest.version, existing.version) : null,
    defaults: { user: C.locations('user').defaultDir, machine: C.locations('machine').defaultDir },
    sizeMb: Math.round(payload.manifest.totalBytes / 1048576), auto, _installs: installs,
  };
}

// ---------- running an install ----------
let running = null; // { controller, cancellable }
let installed = null; // { exe, dir, updated }
async function runInstall(opts, state, emit) {
  const controller = new AbortController();
  running = { controller, cancellable: true };
  const existing = opts.action === 'install' ? null : state._installs.find((i) => i.kind === state.existing.kind && i.dir === state.existing.dir);
  const freeMb = Number(arg('--debug-free-mb'));
  try {
    const r = await install({ ...opts, existing, payload, freeBytesOverride: freeMb >= 0 && arg('--debug-free-mb') ? freeMb * 1048576 : undefined },
      (p) => { running.cancellable = p.cancellable; emit(p); }, controller.signal, log);
    installed = { ...r, updated: !!existing };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || null, cancelled: !!e.cancelled };
  } finally { running = null; }
}

function launchInstalled(log) {
  if (!installed) return;
  log.info('Launching', { exe: installed.exe });
  if (stateCache?.elevated) {
    spawn('explorer.exe', [installed.exe], { detached: true, stdio: 'ignore' }).unref(); // runs it as the signed-in user, not as admin
  } else {
    spawn(installed.exe, installed.updated ? ['--updated'] : [], { detached: true, stdio: 'ignore', cwd: installed.dir }).unref();
  }
}

// ---------- silent ----------
async function silent() {
  log.info('Silent install', { argv });
  if (!payload) return app.exit(EXIT.failed);
  let opts;
  const state = await getState();
  try {
    opts = checkOptions({
      dir: arg('--dir') || arg('/d'), scope: flag('--all-users', '/allusers') ? 'machine' : 'user',
      desktop: arg('--desktop') !== '0', startMenu: arg('--startmenu') !== '0', startup: arg('--startup') === '1', launch: flag('--launch'),
    }, state);
  } catch (e) { log.error('Bad arguments', { error: e.message }); return app.exit(EXIT.BAD_ARGS); }
  let lastText = '';
  const r = await runInstall(opts, state, (p) => { if (p.text !== lastText) { lastText = p.text; log.info('Progress', { phase: p.phase, text: p.text }); } });
  if (r.ok && opts.launch) { stateCache = state; launchInstalled(log); }
  const code = r.ok ? EXIT.ok : r.cancelled ? EXIT.cancelled : EXIT[r.code] || EXIT.failed;
  log.info('Silent install done', { code, error: r.error });
  app.exit(code);
}

// ---------- the wizard ----------
let win = null, stateCache = null;
function wizard() {
  win = createWindow({ title: `${C.PRODUCT} Setup` });
  win.on('close', (e) => { if (running) { e.preventDefault(); win.webContents.send('setup:progress', { phase: 'ask-cancel' }); } });
  commonIpc(() => win, () => {
    if (running) return win.webContents.send('setup:progress', { phase: 'ask-cancel' });
    win.destroy();
  });
  handle('setup:state', async () => {
    if (!payload) throw new Error('This installer is incomplete (no payload). Rebuild it with npm run build:all.');
    stateCache = await getState();
    const { _installs, ...state } = stateCache;
    return state;
  });
  handle('setup:choose-folder', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to install Echo Volume', defaultPath: typeof current === 'string' ? current : undefined,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return checkDir(r.filePaths[0]);
  });
  handle('setup:install', async (_e, o) => {
    if (running) throw new Error('Already installing');
    const opts = checkOptions(o, stateCache);
    return runInstall(opts, stateCache, (p) => !win.isDestroyed() && win.webContents.send('setup:progress', p));
  });
  handle('setup:elevate', async (_e, o) => {
    const opts = checkOptions(o, stateCache);
    const self = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const args = [...(process.defaultApp ? [path.resolve(process.argv[1])] : []), '--elevated', `--auto=${Buffer.from(JSON.stringify(opts)).toString('base64')}`];
    log.info('Asking for administrator rights', { self });
    if (!(await C.relaunchElevated(self, args))) return false;
    setTimeout(() => app.quit(), 300);
    return true;
  });
  handle('setup:cancel', () => {
    if (!running?.cancellable) return false;
    log.warn('Cancel requested');
    running.controller.abort();
    return true;
  });
  handle('setup:launch', () => { launchInstalled(log); setTimeout(() => app.quit(), 400); });
  handle('setup:uninstall-existing', async () => {
    const ex = stateCache?._installs.find((i) => i.kind === stateCache.existing?.kind);
    if (!ex) return false;
    log.info('Starting the installed version\'s uninstaller', { kind: ex.kind, dir: ex.dir });
    if (ex.kind === 'setup') spawn(path.join(ex.dir, C.EXE), ['--uninstall'], { detached: true, stdio: 'ignore' }).unref();
    else await shell.openPath(ex.uninstaller); // the NSIS uninstaller asks for admin itself
    setTimeout(() => app.quit(), 300);
    return true;
  });
}

app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  log.info('Setup started', { version: payload?.manifest.version, argv, elevated: ELEVATED_RELAUNCH, exe: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath });
  if (SILENT) return silent();
  wizard();
});
