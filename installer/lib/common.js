// Shared by the setup app (installer/main.js) and the uninstaller inside the installed app (installer/uninstall-main.js):
// product constants, log, registry (reg.exe), shortcuts, processes, elevation. Windows only.
const { spawn, execFile } = require('child_process');
// Electron's own fs treats *.asar paths as archives; the app's app.asar must be handled as a plain file
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const os = require('os');
const path = require('path');

const PRODUCT = 'Echo Volume';
const EXE = 'Echo Volume.exe';
const APP_ID = 'local.echovolume.app'; // the app's AppUserModelID (desktop/main.js), also its Uninstall key name
const PUBLISHER = 'Vipin Kumar';
const RUN_NAME = 'Echo Volume'; // HKCU Run value, same name the app's tray "Start with Windows" uses
const DATA_DIR = () => path.join(process.env.APPDATA, PRODUCT); // the app's userData: sign-in, playlists, settings
const LOG_FILE = path.join(os.tmpdir(), 'echo-volume-setup.log');

// ---------- log: one JSON object per line ----------
function createLog(mode) {
  const write = (level, msg, data) => {
    const line = JSON.stringify({ t: new Date().toISOString(), mode, level, msg, ...(data || {}) });
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
    if (level === 'error') console.error(line); else console.log(line);
  };
  return { file: LOG_FILE, info: (m, d) => write('info', m, d), warn: (m, d) => write('warn', m, d), error: (m, d) => write('error', m, d) };
}

// ---------- processes ----------
// Resolves { code, stdout, stderr }; never rejects for a non-zero exit
function run(file, args, { timeout = 60000, verbatim = false } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, windowsVerbatimArguments: verbatim, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
}
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ps = (script, opts) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], opts);
// One argument for a Windows command line (CommandLineToArgvW rules)
const winArg = (a) => (/[\s"]/.test(a) || !a ? `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a);

const isElevated = async () => (await run('net.exe', ['session'], { timeout: 10000 })).code === 0;

// Starts exe elevated (UAC prompt). Resolves false when the user said no.
async function relaunchElevated(exe, args) {
  const r = await ps(`Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${psQuote(args.map(winArg).join(' ') || ' ')} -Verb RunAs`, { timeout: 120000 });
  return r.code === 0;
}

// Running copies of the app (any install), leaving out this process and its own helpers (same exe name in the uninstaller)
async function appProcesses() {
  const r = await ps(`Get-CimInstance Win32_Process -Filter "Name='${EXE}'" | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`);
  if (r.code || !r.stdout.trim()) return [];
  let list = JSON.parse(r.stdout); if (!Array.isArray(list)) list = [list];
  return list.filter((p) => p.ProcessId !== process.pid && p.ParentProcessId !== process.pid);
}
// Ask the running app to quit (quitExe: an installed v5+ exe, which understands --quit), then end whatever is left.
// (Older versions take --quit as "show the window", so they are only ended.)
async function closeRunningApp(quitExe, log) {
  let procs = await appProcesses();
  if (!procs.length) return false;
  log.info('Closing the running app', { pids: procs.map((p) => p.ProcessId) });
  if (quitExe && fs.existsSync(quitExe)) await run(quitExe, ['--quit'], { timeout: 15000 });
  for (let i = 0; i < 20 && procs.length; i++) { await wait(300); procs = await appProcesses(); }
  if (procs.length) {
    log.warn('The app did not quit, ending it', { pids: procs.map((p) => p.ProcessId) });
    await ps(`Stop-Process -Force -ErrorAction SilentlyContinue -Id ${procs.map((p) => p.ProcessId).join(',')}`);
    await wait(800); // let Windows release the files
  }
  return true;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- registry (reg.exe) ----------
const UNINSTALL_KEY = (hive) => `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
// { name: { type, data } } or null when the key doesn't exist
async function regRead(key) {
  const r = await run('reg.exe', ['query', key]);
  if (r.code) return null;
  const values = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (m) values[m[1]] = { type: m[2], data: m[3] ?? '' };
  }
  return values;
}
async function regSet(key, name, type, data) {
  const r = await run('reg.exe', ['add', key, ...(name === '(Default)' ? ['/ve'] : ['/v', name]), '/t', type, '/d', String(data), '/f']);
  if (r.code) throw new Error(`Could not write ${key}\\${name}: ${r.stderr.trim()}`);
}
const regDeleteKey = (key) => run('reg.exe', ['delete', key, '/f']);
const regDeleteValue = (key, name) => run('reg.exe', ['delete', key, '/v', name, '/f']);
// Puts a key back the way regRead saw it (null: it didn't exist)
async function regRestore(key, values) {
  await regDeleteKey(key);
  if (!values) return;
  for (const [name, v] of Object.entries(values)) await regSet(key, name, v.type, v.data);
}

// ---------- places ----------
function locations(scope) {
  const all = scope === 'machine';
  const startMenu = all ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const desktop = all ? path.join(process.env.PUBLIC, 'Desktop') : path.join(os.homedir(), 'Desktop');
  return {
    defaultDir: all ? path.join(process.env.ProgramFiles, PRODUCT) : path.join(process.env.LOCALAPPDATA, 'Programs', PRODUCT),
    startMenu: path.join(startMenu, `${PRODUCT}.lnk`),
    desktop: path.join(desktop, `${PRODUCT}.lnk`),
    hive: all ? 'HKLM' : 'HKCU',
  };
}

// Echo Volume installs this PC knows: v5+ ("setup") under our key, and older NSIS ones ("legacy", a GUID key)
async function findInstalls() {
  const r = await ps(`$out = @(); foreach ($h in 'HKCU','HKLM') { Get-ChildItem "$($h):\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      if ($p.DisplayName -like '${PRODUCT}*' -and $p.DisplayName -notlike '*Setup*') { $out += [pscustomobject]@{ hive = $h; key = $_.PSChildName; name = $p.DisplayName; version = $p.DisplayVersion; dir = $p.InstallLocation; uninstall = $p.UninstallString; quiet = $p.QuietUninstallString } } } }
    ConvertTo-Json -Compress -InputObject $out`);
  let list = [];
  try { list = JSON.parse(r.stdout || '[]'); if (!Array.isArray(list)) list = [list]; } catch {}
  return list.map((x) => {
    const uninstaller = /^"([^"]+)"/.exec(x.uninstall || '')?.[1] || null;
    const dir = x.dir || (uninstaller ? path.dirname(uninstaller) : null);
    return {
      kind: x.key === APP_ID ? 'setup' : 'legacy', scope: x.hive === 'HKLM' ? 'machine' : 'user', version: x.version || '?',
      dir, uninstaller, uninstall: x.uninstall, quiet: x.quiet, key: `${x.hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${x.key}`,
    };
  }).filter((x) => x.dir);
}

// Runs an old (electron-builder NSIS) uninstaller silently and waits for it, the way electron-builder's own updater does:
// - from a copy in %TEMP%: with --updated it moves the whole install folder aside in one go, which fails (exit code 2,
//   nothing removed) while its own exe in that folder is running
// - "_?=dir": the copy runs in place instead of re-launching itself and returning at once
// - --updated /KEEP_APP_DATA: the user's data stays
async function runLegacyUninstall(inst, log) {
  const copy = path.join(os.tmpdir(), `echo-volume-old-uninstaller-${process.pid}.exe`);
  fs.copyFileSync(inst.uninstaller, copy);
  try {
    await new Promise((resolve, reject) => {
      const args = ['/S', ...(inst.scope === 'machine' ? ['/allusers'] : []), '/KEEP_APP_DATA', '--updated', `_?=${inst.dir}`];
      log.info('Removing the old version', { uninstaller: inst.uninstaller, copy, args });
      // Verbatim: "_?=" must arrive unquoted, so argv0 is quoted by hand
      const child = spawn(copy, args, { windowsVerbatimArguments: true, windowsHide: true, argv0: `"${copy}"` });
      const timer = setTimeout(() => { child.kill(); reject(new Error('The old version\'s uninstaller did not finish')); }, 180000);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`The old version's uninstaller failed (exit code ${code})`)); });
    });
  } finally {
    for (let i = 0; i < 10; i++) { try { fs.rmSync(copy, { force: true }); break; } catch { await wait(300); } }
  }
}

// Size of a folder in bytes
function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

module.exports = {
  PRODUCT, EXE, APP_ID, PUBLISHER, RUN_NAME, DATA_DIR, LOG_FILE, UNINSTALL_KEY, RUN_KEY, APPROVED_KEY,
  createLog, run, ps, psQuote, winArg, wait, isElevated, relaunchElevated, appProcesses, closeRunningApp,
  regRead, regSet, regDeleteKey, regDeleteValue, regRestore, locations, findInstalls, runLegacyUninstall, dirSize,
};
