// Installs the payload. Every change is journaled with how to undo it; a failure or a cancel rolls back in reverse
// order, so a broken install leaves neither files nor registry entries behind (and an upgrade keeps the old version).
// The app is extracted next to the target folder and swapped in at the end, so the running old version is touched last.
// Electron's own fs treats *.asar paths as archives; the app's app.asar must be handled as a plain file
const fs = (() => { try { return require('original-fs'); } catch { return require('fs'); } })();
const path = require('path');
const { shell } = require('electron');
const C = require('./common');
const { sha256File, unpack } = require('./pack');

class Cancelled extends Error { constructor() { super('Installation cancelled'); this.cancelled = true; } }

// Overall progress: share of the bar each phase fills
const PHASES = { prepare: [0, 0.02], verify: [0.02, 0.1], extract: [0.1, 0.9], close: [0.9, 0.92], old: [0.92, 0.95], finish: [0.95, 1] };

/**
 * @param {object} o
 * @param {'install'|'upgrade'|'repair'} o.action
 * @param {string} o.dir install folder
 * @param {'user'|'machine'} o.scope
 * @param {boolean} o.desktop @param {boolean} o.startMenu @param {boolean} o.startup
 * @param {object|null} o.existing an install from findInstalls() this one replaces
 * @param {{ file: string, manifest: object }} o.payload
 * @param {(p: object) => void} emit progress: { phase, percent, text, bytes?, total?, file?, cancellable }
 * @param {AbortSignal} signal
 * @param {object} log
 * @param {number} [o.freeBytesOverride] testing only: pretend this much disk is free
 */
async function install(o, emit, signal, log) {
  const journal = []; // { what, undo }
  const undoable = (what, undo) => journal.push({ what, undo });
  const m = o.payload.manifest;
  let cancellable = true;
  const step = (phase, f, text, extra = {}) => {
    const [a, b] = PHASES[phase];
    emit({ phase, percent: a + (b - a) * Math.min(1, Math.max(0, f)), text, cancellable, ...extra });
  };
  const check = () => { if (signal.aborted && cancellable) throw new Cancelled(); };
  const dir = path.resolve(o.dir);
  const staging = `${dir}.installing`, old = `${dir}.previous`;
  const L = C.locations(o.scope);
  log.info('Install started', { action: o.action, dir, scope: o.scope, version: m.version, existing: o.existing && { kind: o.existing.kind, version: o.existing.version, dir: o.existing.dir } });

  try {
    // ---------- prepare ----------
    step('prepare', 0, 'Getting ready…');
    if (o.scope === 'machine' && !(await C.isElevated())) throw Object.assign(new Error('Installing for everyone on this PC needs administrator rights.'), { code: 'NEEDS_ADMIN' });
    const parent = path.dirname(dir);
    if (!fs.existsSync(parent)) {
      let top = parent; while (!fs.existsSync(path.dirname(top))) top = path.dirname(top);
      fs.mkdirSync(parent, { recursive: true });
      undoable(`created ${top}`, () => fs.rmSync(top, { recursive: true, force: true }));
    }
    const free = o.freeBytesOverride ?? (() => { const s = fs.statfsSync(parent); return s.bavail * s.bsize; })();
    const need = Math.round(m.totalBytes * 1.1) + 50 * 1024 * 1024; // the app, plus room for the swap
    if (free < need) {
      throw Object.assign(new Error(`Not enough free space on ${path.parse(dir).root}: ${mb(need)} needed, ${mb(free)} free.`), { code: 'DISK_SPACE' });
    }
    check();

    // ---------- verify the package ----------
    const sum = await sha256File(o.payload.file, (d, t) => step('verify', d / t, 'Checking the package…'), signal).catch((e) => { if (signal.aborted) throw new Cancelled(); throw e; });
    if (sum !== m.sha256) throw Object.assign(new Error('The installer is damaged (checksum mismatch). Download it again.'), { code: 'CHECKSUM' });
    log.info('Package verified', { sha256: sum });
    check();

    // ---------- extract next to the target ----------
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging);
    undoable('extracted files', () => fs.rmSync(staging, { recursive: true, force: true }));
    let last = 0;
    await unpack(o.payload.file, staging, (bytes, file) => {
      const now = Date.now();
      if (now - last < 50 && bytes < m.totalBytes) return;
      last = now;
      step('extract', bytes / m.totalBytes, 'Copying Echo Volume…', { bytes, total: m.totalBytes, file });
    }, signal).catch((e) => { if (signal.aborted) throw new Cancelled(); throw e; });
    log.info('Extracted', { files: m.files, bytes: m.totalBytes });
    check();

    // ---------- point of no return for cancel: the old version gets closed and replaced ----------
    cancellable = false;
    step('close', 0, 'Closing Echo Volume…');
    const quitExe = o.existing?.kind === 'setup' ? path.join(o.existing.dir, C.EXE) : null;
    await C.closeRunningApp(quitExe, log);

    if (o.existing?.kind === 'legacy') {
      step('old', 0, `Removing Echo Volume ${o.existing.version}…`);
      await C.runLegacyUninstall(o.existing, log); // keeps the user's data; can't be undone
      if (fs.existsSync(o.existing.dir) && path.resolve(o.existing.dir) !== dir) fs.rmSync(o.existing.dir, { recursive: true, force: true });
    }

    step('finish', 0, 'Putting it in place…');
    if (fs.existsSync(dir)) {
      fs.rmSync(old, { recursive: true, force: true });
      await retry(() => fs.renameSync(dir, old), 'The install folder is in use. Close Echo Volume and try again.');
      undoable('moved the previous version aside', () => fs.renameSync(old, dir));
    }
    await retry(() => fs.renameSync(staging, dir), 'Could not move the files into place.');
    undoable('moved the new version in', () => fs.renameSync(dir, staging)); // undone first, then the previous one moves back

    // ---------- shortcuts ----------
    step('finish', 0.3, 'Creating shortcuts…');
    const exe = path.join(dir, C.EXE);
    const link = { target: exe, cwd: dir, description: 'Control your Echo devices and TV', icon: exe, iconIndex: 0, appUserModelId: C.APP_ID };
    const shortcuts = {};
    for (const [key, file] of [['startMenu', L.startMenu], ['desktop', L.desktop]]) {
      const before = fs.existsSync(file) ? (() => { try { return shell.readShortcutLink(file); } catch { return null; } })() : null;
      const restore = () => (before ? shell.writeShortcutLink(file, 'create', before) : fs.rmSync(file, { force: true }));
      if (o[key]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!shell.writeShortcutLink(file, 'create', link)) throw new Error(`Could not create the shortcut ${file}`);
        undoable(`shortcut ${file}`, restore);
        shortcuts[key] = file;
      } else if (before && path.resolve(before.target || '') === exe) { // was ours, now unticked
        fs.rmSync(file, { force: true });
        undoable(`removed shortcut ${file}`, restore);
      }
    }

    // ---------- Settings → Apps entry ----------
    step('finish', 0.6, 'Registering with Windows…');
    const key = C.UNINSTALL_KEY(L.hive);
    const before = await C.regRead(key);
    undoable(`registry ${key}`, () => C.regRestore(key, before));
    const sizeKb = Math.round(C.dirSize(dir) / 1024);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const values = [
      ['DisplayName', 'REG_SZ', C.PRODUCT], ['DisplayVersion', 'REG_SZ', m.version], ['Publisher', 'REG_SZ', C.PUBLISHER],
      ['InstallLocation', 'REG_SZ', dir], ['DisplayIcon', 'REG_SZ', `"${exe}",0`], ['InstallDate', 'REG_SZ', day],
      ['UninstallString', 'REG_SZ', `"${exe}" --uninstall`], ['QuietUninstallString', 'REG_SZ', `"${exe}" --uninstall --silent`],
      ['EstimatedSize', 'REG_DWORD', sizeKb], ['NoModify', 'REG_DWORD', 1], ['NoRepair', 'REG_DWORD', 1],
    ];
    for (const [n, t, d] of values) await C.regSet(key, n, t, d);

    // ---------- start with Windows (per user, like the app's tray option) ----------
    const runBefore = (await C.regRead(C.RUN_KEY))?.[C.RUN_NAME] || null;
    const approvedBefore = (await C.regRead(C.APPROVED_KEY))?.[C.RUN_NAME] || null;
    undoable('startup entry', async () => {
      await (runBefore ? C.regSet(C.RUN_KEY, C.RUN_NAME, runBefore.type, runBefore.data) : C.regDeleteValue(C.RUN_KEY, C.RUN_NAME));
      if (approvedBefore) await C.regSet(C.APPROVED_KEY, C.RUN_NAME, approvedBefore.type, approvedBefore.data);
    });
    if (o.startup) {
      await C.regSet(C.RUN_KEY, C.RUN_NAME, 'REG_SZ', `"${exe}" --hidden`);
      await C.regDeleteValue(C.APPROVED_KEY, C.RUN_NAME); // switched off in Task Manager before: on again
    } else await C.regDeleteValue(C.RUN_KEY, C.RUN_NAME);

    // What the uninstaller needs to know
    fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ version: m.version, scope: o.scope, dir, shortcuts, installedAt: new Date().toISOString() }, null, 2));

    // ---------- done: the previous version can go ----------
    step('finish', 0.9, 'Cleaning up…');
    fs.rmSync(old, { recursive: true, force: true });
    if (o.existing?.kind === 'setup' && o.existing.scope !== o.scope) await C.regDeleteKey(C.UNINSTALL_KEY(C.locations(o.existing.scope).hive));
    step('finish', 1, 'Done');
    log.info('Install finished', { dir, sizeKb, shortcuts, startup: o.startup });
    return { dir, exe };
  } catch (e) {
    log[e.cancelled ? 'warn' : 'error']('Install failed, rolling back', { error: e.message, code: e.code, steps: journal.map((j) => j.what) });
    emit({ phase: 'rollback', percent: null, text: e.cancelled ? 'Cancelling…' : 'Undoing changes…', cancellable: false });
    for (const j of journal.reverse()) {
      try { await j.undo(); } catch (u) { log.error('Rollback step failed', { step: j.what, error: u.message }); }
    }
    log.info('Rollback finished');
    throw e;
  }
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(0)} MB`;
// Renames fail for a moment while Windows or antivirus still holds a file
async function retry(fn, message) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw Object.assign(new Error(message), { cause: e });
      await C.wait(500);
    }
  }
}

module.exports = { install, Cancelled };
