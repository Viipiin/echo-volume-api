// Echo Volume desktop app (Electron): runs the API server in-process and wraps the UI in a native window,
// with a tray icon + quick popup, global hotkeys with an on-screen indicator, and in-app sign-in windows.
const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, nativeImage, nativeTheme, screen, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_ID = 'local.echovolume.app';
const ROOT = path.join(__dirname, '..');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId(APP_ID);

// ---------- data folder (.env, cookie.json, st-token.json live here, not inside the app) ----------
const DATA = app.getPath('userData');
function prepareData() {
  fs.mkdirSync(DATA, { recursive: true });
  const has = (f) => fs.existsSync(path.join(DATA, f));
  if (!has('.env')) {
    // Running from the project folder (not installed): carry over the existing setup once
    if (!app.isPackaged) {
      for (const f of ['.env', 'cookie.json']) {
        if (fs.existsSync(path.join(ROOT, f)) && !has(f)) fs.copyFileSync(path.join(ROOT, f), path.join(DATA, f));
      }
    }
    if (!has('.env')) fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(DATA, '.env'));
  }
}
prepareData();
process.env.DATA_DIR = DATA;
process.env.HOST ??= '127.0.0.1'; // the app only needs to be reachable from this PC

// ---------- settings ----------
const SETTINGS_FILE = path.join(DATA, 'settings.json');
let settings = { hotkeys: true, hotkeyDevice: '', mediaKeys: false };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

// ---------- server ----------
let server, base;
let mainWin, loginWin, miniWin, osdWin, tray;
let quitting = false;

function startServer() {
  server = require(path.join(ROOT, 'server.js'));
  base = `http://127.0.0.1:${server.port}`;
  server.events.on('listen-error', (e) => {
    dialog.showErrorBox('Echo Volume',
      e.code === 'EADDRINUSE'
        ? `Port ${server.port} is already in use.\n\nAnother copy of Echo Volume (or "node server.js") is probably running. Close it and start the app again.`
        : `The server could not start:\n${e.message}`);
    quitting = true; app.quit();
  });
  server.events.on('login-needed', (url) => openLogin(url));
  // Theme picked in the UI: themeSource switches every window (and the title bar via nativeTheme 'updated')
  // (Midnight is a dark theme as far as Windows is concerned; colors() gives it its own navy title bar.)
  nativeTheme.themeSource = toThemeSource(server.theme());
  server.events.on('theme', (t) => { nativeTheme.themeSource = toThemeSource(t); applyWindowColors(); });
  // Timer/alarm going off, song changes (switched on/off in the app's Settings tab)
  const notify = (n, silent) => {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body || '', silent, icon: path.join(ROOT, 'build', 'icon.png') });
    note.on('click', showMain);
    note.show();
  };
  server.events.on('alert', (n) => notify(n, false));
  server.events.on('song', (n) => notify(n, true));
  server.events.on('ready', () => {
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    if (mainWin && !mainWin.isDestroyed()) mainWin.reload();
    refreshTrayMenu();
  });
}

const keyQuery = () => (process.env.API_KEY ? `?key=${encodeURIComponent(process.env.API_KEY)}` : '');
async function api(url, body) {
  const r = await fetch(base + '/api' + url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(process.env.API_KEY && { 'x-api-key': process.env.API_KEY }) },
    body: body && JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------- windows ----------
const toThemeSource = (t) => (t === 'midnight' ? 'dark' : t);
const isDark = () => nativeTheme.shouldUseDarkColors;
const colors = () => (server?.theme() === 'midnight' ? { bg: '#060b1f', fg: '#eaf0ff' }
  : isDark() ? { bg: '#0f1115', fg: '#e9ecf1' } : { bg: '#f4f6f9', fg: '#151a22' });

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1040, height: 780, minWidth: 420, minHeight: 500,
    title: 'Echo Volume', icon: path.join(ROOT, 'build', 'icon.png'),
    backgroundColor: colors().bg, show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors().bg, symbolColor: colors().fg, height: 40 },
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadURL(base + '/' + keyQuery());
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!settings.trayHintShown) {
      tray?.displayBalloon({ title: 'Echo Volume is still running', content: 'It lives in the tray. Right-click the icon to quit.', iconType: 'info' });
      settings.trayHintShown = true; saveSettings();
    }
  });
  wireLinks(mainWin);
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show(); mainWin.focus();
}

function applyWindowColors() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setBackgroundColor(colors().bg);
    mainWin.setTitleBarOverlay({ color: colors().bg, symbolColor: colors().fg });
  }
}
nativeTheme.on('updated', applyWindowColors);

// Links from the UI: SmartThings sign-in opens in an app window that grabs the code itself;
// other external links open in the default browser.
function wireLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://api.smartthings.com/oauth/authorize')) openSmartThingsLogin(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openLogin(url) {
  if (loginWin && !loginWin.isDestroyed()) return loginWin.focus();
  loginWin = new BrowserWindow({ width: 520, height: 760, title: 'Sign in to Amazon — Echo Volume', icon: path.join(ROOT, 'build', 'icon.png'), autoHideMenuBar: true });
  loginWin.loadURL(url);
}

function openSmartThingsLogin(url) {
  const redirect = process.env.ST_REDIRECT_URI || 'https://httpbin.org/get';
  const win = new BrowserWindow({ width: 520, height: 760, title: 'Connect SmartThings — Echo Volume', icon: path.join(ROOT, 'build', 'icon.png'), autoHideMenuBar: true });
  const catchRedirect = async (e, target) => {
    if (!target.startsWith(redirect)) return;
    e.preventDefault();
    const q = new URL(target).searchParams;
    win.close();
    if (q.get('error')) return dialog.showMessageBox({ type: 'warning', message: 'SmartThings sign-in was cancelled.' });
    try {
      await api('/st/auth/code', { code: q.get('code'), state: q.get('state') });
      mainWin?.loadURL(base + '/' + keyQuery());
      showMain();
    } catch (err) { dialog.showErrorBox('SmartThings', err.message); }
  };
  win.webContents.on('will-redirect', catchRedirect);
  win.webContents.on('will-navigate', catchRedirect);
  win.loadURL(url);
}

// ---------- tray + quick popup ----------
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'build', 'tray.png')));
  tray.setToolTip('Echo Volume');
  tray.on('click', toggleMini);
  tray.on('double-click', showMain);
  refreshTrayMenu();
}

async function refreshTrayMenu() {
  if (!tray) return;
  let echos = [];
  try { echos = (await api('/devices')).filter((d) => d.online && !['VOX', 'REAVER', 'THIRD_PARTY_AVS_VIDEO_FIRST', 'WHA'].includes(d.family)); } catch {}
  if (!settings.hotkeyDevice && echos[0]) { settings.hotkeyDevice = echos[0].serial; saveSettings(); }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Echo Volume', click: showMain },
    { label: 'Quick controls', click: toggleMini },
    { label: 'Stop all audio', click: () => api('/stop-all', {}).then(() => osd('Echo Volume', 'Stopped everywhere', 0)).catch((e) => osd('Stop all', e.message, 0)) },
    { type: 'separator' },
    {
      label: 'Hotkeys control', submenu: echos.length
        ? echos.map((d) => ({ label: d.name, type: 'radio', checked: settings.hotkeyDevice === d.serial, click: () => { settings.hotkeyDevice = d.serial; saveSettings(); } }))
        : [{ label: 'No Echo devices yet', enabled: false }],
    },
    { label: 'Enable hotkeys', type: 'checkbox', checked: settings.hotkeys, click: (i) => { settings.hotkeys = i.checked; saveSettings(); registerHotkeys(); } },
    { label: 'Media keys control Echo music', type: 'checkbox', checked: settings.mediaKeys, click: (i) => { settings.mediaKeys = i.checked; saveSettings(); registerHotkeys(); } },
    { label: 'Show hotkeys…', click: showHotkeyHelp },
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(DATA) },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function toggleMini() {
  if (miniWin && !miniWin.isDestroyed() && miniWin.isVisible()) return miniWin.hide();
  const fresh = !miniWin || miniWin.isDestroyed();
  if (fresh) {
    miniWin = new BrowserWindow({
      width: 340, height: 460, show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
      backgroundColor: colors().bg, webPreferences: { contextIsolation: true, sandbox: true },
    });
    miniWin.on('blur', () => miniWin.hide());
    wireLinks(miniWin);
  }
  // Place next to the tray icon, inside the work area
  const tb = tray.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  const [w, h] = miniWin.getSize();
  const x = Math.min(Math.max(Math.round(tb.x + tb.width / 2 - w / 2), wa.x + 8), wa.x + wa.width - w - 8);
  const y = tb.y > wa.y + wa.height / 2 ? wa.y + wa.height - h - 8 : wa.y + 8;
  miniWin.setPosition(x, y);
  if (fresh) {
    miniWin.once('ready-to-show', () => { miniWin.show(); miniWin.focus(); });
    miniWin.loadURL(base + '/mini.html' + keyQuery());
  } else {
    miniWin.reload(); // fresh values each time it opens
    miniWin.show(); miniWin.focus();
  }
}

// ---------- on-screen indicator ----------
function osd(title, value, max) {
  if (!osdWin || osdWin.isDestroyed()) {
    osdWin = new BrowserWindow({
      width: 300, height: 76, frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: false,
      alwaysOnTop: true, show: false, webPreferences: { contextIsolation: true, sandbox: true },
    });
    osdWin.setAlwaysOnTop(true, 'screen-saver');
    osdWin.setIgnoreMouseEvents(true);
    osdWin.loadFile(path.join(__dirname, 'osd.html'));
  }
  const wa = screen.getPrimaryDisplay().workArea;
  osdWin.setPosition(Math.round(wa.x + wa.width / 2 - 150), wa.y + wa.height - 76 - 48);
  const run = () => osdWin.webContents.executeJavaScript(`show(${JSON.stringify(title)}, ${JSON.stringify(value)}, ${max}, ${isDark()})`).then(() => osdWin.showInactive());
  if (osdWin.webContents.isLoading()) osdWin.webContents.once('did-finish-load', run); else run();
  clearTimeout(osd.t);
  osd.t = setTimeout(() => osdWin?.hide(), 1400);
}

// ---------- hotkeys ----------
const HOTKEYS = [
  { keys: 'Ctrl+Alt+Up', label: 'Echo volume up', run: () => echoStep(+1) },
  { keys: 'Ctrl+Alt+Down', label: 'Echo volume down', run: () => echoStep(-1) },
  { keys: 'Ctrl+Alt+Home', label: 'Echo mute / unmute', run: () => echoMute() },
  { keys: 'Ctrl+Alt+PageUp', label: 'TV volume up', run: () => tvStep(+2) },
  { keys: 'Ctrl+Alt+PageDown', label: 'TV volume down', run: () => tvStep(-2) },
  { keys: 'Ctrl+Alt+End', label: 'TV mute / unmute', run: () => tvMute() },
  { keys: 'Ctrl+Alt+E', label: 'Show / hide Echo Volume', run: () => (mainWin?.isVisible() && mainWin.isFocused() ? mainWin.hide() : showMain()) },
];
// Keyboard media keys → music on the Echo last used in the app. Opt-in (tray menu): while on, other
// players (Spotify, browsers) no longer get these keys.
const MEDIA_KEYS = [
  { keys: 'MediaPlayPause', label: 'Echo music play / pause', run: () => musicKey('toggle') },
  { keys: 'MediaNextTrack', label: 'Echo music next', run: () => musicKey('next') },
  { keys: 'MediaPreviousTrack', label: 'Echo music previous', run: () => musicKey('previous') },
  { keys: 'MediaStop', label: 'Echo music pause', run: () => musicKey('pause') },
];
const failedHotkeys = [];

function registerHotkeys() {
  globalShortcut.unregisterAll();
  failedHotkeys.length = 0;
  const keys = [...(settings.hotkeys ? HOTKEYS : []), ...(settings.mediaKeys ? MEDIA_KEYS : [])];
  for (const h of keys) if (!globalShortcut.register(h.keys, h.run)) failedHotkeys.push(h.keys);
}

function showHotkeyHelp() {
  const line = (h) => `${h.keys.padEnd(20)} ${h.label}${failedHotkeys.includes(h.keys) ? '  (in use by another app)' : ''}`;
  dialog.showMessageBox({
    type: 'info', title: 'Echo Volume hotkeys',
    message: 'Global hotkeys',
    detail: HOTKEYS.map(line).join('\n')
      + (settings.mediaKeys ? '\n' + MEDIA_KEYS.map(line).join('\n') : '\n\nMedia keys: off (tray menu → Media keys control Echo music)')
      + '\n\nEcho hotkeys control the device chosen under tray menu → Hotkeys control; media keys control the Echo music last played on.',
  });
}

async function musicKey(cmd) {
  try {
    if (cmd === 'toggle') cmd = (await api('/music/now')).state === 'PLAYING' ? 'pause' : 'play';
    const r = await api('/music/' + cmd, {});
    osd(r.device, { play: 'Playing', pause: 'Paused', next: 'Next track', previous: 'Previous track' }[cmd], 0);
  } catch (e) { osd('Music', e.message, 0); }
}

// Echo: steps of 1 on Alexa's 0-10 scale. Rapid presses are coalesced into one command.
const echo = { level: null, at: 0, muted: null, timer: null, name: '' };
async function echoCurrent() {
  if (echo.level != null && Date.now() - echo.at < 15000) return echo.level;
  const r = await api('/volume?device=' + encodeURIComponent(settings.hotkeyDevice));
  echo.name = r.device; echo.level = Math.round((r.volume ?? 50) / 10); echo.at = Date.now();
  return echo.level;
}
async function echoStep(d) {
  if (!settings.hotkeyDevice) return osd('Echo Volume', 'Pick a device in the tray menu', 0);
  try {
    echo.level = Math.max(0, Math.min(10, (await echoCurrent()) + d)); echo.at = Date.now(); echo.muted = false;
    osd(echo.name || 'Echo', `${echo.level} / 10`, echo.level / 10);
    clearTimeout(echo.timer);
    echo.timer = setTimeout(() => api('/volume', { device: settings.hotkeyDevice, level: echo.level * 10 }).catch((e) => osd('Echo', e.message, 0)), 200);
  } catch (e) { osd('Echo', e.message, 0); }
}
async function echoMute() {
  if (!settings.hotkeyDevice) return;
  try {
    const cur = await echoCurrent();
    const mute = !(echo.muted ?? cur === 0);
    echo.muted = mute;
    osd(echo.name || 'Echo', mute ? 'Muted' : 'Unmuted', mute ? 0 : cur / 10);
    const r = await api(mute ? '/mute' : '/unmute', { device: settings.hotkeyDevice });
    echo.level = mute ? 0 : Math.round(r.volume / 10); echo.at = Date.now();
  } catch (e) { osd('Echo', e.message, 0); }
}

// TV (SmartThings): 0-100 scale
const tv = { volume: null, at: 0, muted: false, timer: null, name: 'TV' };
async function tvCurrent() {
  if (tv.volume != null && Date.now() - tv.at < 10000) return tv.volume;
  const t = await api('/st/tv?fast=1');
  tv.volume = t.volume ?? 0; tv.muted = !!t.muted; tv.name = t.name || 'TV'; tv.at = Date.now();
  return tv.volume;
}
async function tvStep(d) {
  try {
    tv.volume = Math.max(0, Math.min(100, (await tvCurrent()) + d)); tv.at = Date.now();
    osd(tv.name, String(tv.volume), tv.volume / 100);
    clearTimeout(tv.timer);
    tv.timer = setTimeout(() => api('/st/tv/volume', { level: tv.volume }).catch((e) => osd('TV', e.message, 0)), 200);
  } catch (e) { osd('TV', e.message, 0); }
}
async function tvMute() {
  try {
    await tvCurrent();
    tv.muted = !tv.muted;
    osd(tv.name, tv.muted ? 'Muted' : 'Unmuted', tv.muted ? 0 : tv.volume / 100);
    await api(tv.muted ? '/st/tv/mute' : '/st/tv/unmute', {});
  } catch (e) { osd('TV', e.message, 0); }
}

// ---------- lifecycle ----------
app.on('second-instance', showMain);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {}); // keep running in the tray

app.whenReady().then(() => {
  startServer();
  server.events.once('listening', () => {
    createTray();
    createMainWindow();
    registerHotkeys();
    if (failedHotkeys.length) console.log('Hotkeys unavailable:', failedHotkeys.join(', '));
  });
});
