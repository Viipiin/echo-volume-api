// Removes an installed Echo Volume. Runs inside the installed app (Echo Volume.exe --uninstall), so the program folder
// is still in use: everything else is removed here, and the folder (plus the user's data, when asked) by a hidden
// PowerShell that waits for this process to exit.
const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');
const C = require('./common');

// What install.js recorded; older or hand-copied installs: worked out from where the exe is
function installInfo() {
  const dir = path.dirname(process.execPath);
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8')); } catch {}
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => p.toLowerCase() + path.sep);
  const scope = info.scope || (pf.some((p) => dir.toLowerCase().startsWith(p)) ? 'machine' : 'user');
  return { dir, scope, version: info.version || app.getVersion(), shortcuts: info.shortcuts || {} };
}

// Never deletes anything when not running from an installed copy (npm run app -- --uninstall): logs what it would do
const isRealInstall = () => app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), 'install.json'));

async function uninstall({ removeData }, emit, log) {
  const info = installInfo(), L = C.locations(info.scope), exe = path.join(info.dir, C.EXE);
  const dry = !isRealInstall();
  const act = async (what, fn) => { log.info(dry ? `(dry run) ${what}` : what); if (!dry) await fn(); };
  log.info('Uninstall started', { ...info, removeData, dry });

  emit({ percent: 0.05, text: 'Closing Echo Volume…' });
  await C.closeRunningApp(exe, log);

  emit({ percent: 0.3, text: 'Removing shortcuts…' });
  const links = new Set([info.shortcuts.startMenu, info.shortcuts.desktop, L.startMenu, L.desktop].filter(Boolean));
  for (const file of links) {
    let target = null;
    try { target = fs.existsSync(file) ? shell.readShortcutLink(file).target : null; } catch {}
    if (target && path.resolve(target).toLowerCase() === exe.toLowerCase()) await act(`remove ${file}`, () => fs.rmSync(file, { force: true }));
  }

  emit({ percent: 0.55, text: 'Removing it from Windows…' });
  const run = (await C.regRead(C.RUN_KEY))?.[C.RUN_NAME];
  if (run && run.data.toLowerCase().includes(exe.toLowerCase())) {
    await act('remove the startup entry', async () => { await C.regDeleteValue(C.RUN_KEY, C.RUN_NAME); await C.regDeleteValue(C.APPROVED_KEY, C.RUN_NAME); });
  }
  await act(`remove ${C.UNINSTALL_KEY(L.hive)}`, () => C.regDeleteKey(C.UNINSTALL_KEY(L.hive)));

  emit({ percent: 0.8, text: removeData ? 'Removing the program and your data…' : 'Removing the program…' });
  const targets = [info.dir, ...(removeData ? [C.DATA_DIR()] : [])];
  await act(`after exit, delete ${targets.join(' and ')}`, () => scheduleDelete(targets, log));
  emit({ percent: 1, text: 'Done' });
  log.info('Uninstall finished', { dry });
  return { dry, removeData };
}

// A hidden PowerShell that waits for this process (and its helpers) to exit, then deletes the folders.
// Started through WMI (Win32_Process.Create), so it isn't a child of this process: a detached spawn gets no console
// (powershell.exe doesn't start), and a normal child sits in libuv's kill-on-close job and dies with the uninstaller.
async function scheduleDelete(dirs, log) {
  const logLine = (level, msg) => `Add-Content -LiteralPath ${C.psQuote(C.LOG_FILE)} -Value (ConvertTo-Json -Compress @{ t = (Get-Date).ToUniversalTime().ToString('o'); mode = 'uninstall'; level = '${level}'; msg = ${msg} })`;
  const inner = `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1500;`
    + ` foreach ($d in @(${dirs.map(C.psQuote).join(',')})) { for ($i = 0; $i -lt 15 -and (Test-Path -LiteralPath $d); $i++) {`
    + ` try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop } catch { if ($i -eq 14) { ${logLine('error', "('Could not delete ' + $d + ': ' + $_.Exception.Message)")} }; Start-Sleep 1 } } }`
    + ` ${logLine('info', "'Folders deleted after exit'")}`;
  const cmd = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(inner, 'utf16le').toString('base64')}`;
  const r = await C.ps(`$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }`
    + `; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${C.psQuote(cmd)}; ProcessStartupInformation = $si }; "$($r.ReturnValue) $($r.ProcessId)"`);
  const [rv, pid] = r.stdout.trim().split(/\s+/);
  if (r.code || rv !== '0') throw new Error(`Could not schedule the folder removal (${rv || r.stderr.trim()})`);
  log.info('Scheduled folder removal', { dirs, pid: Number(pid) });
}

module.exports = { uninstall, installInfo, isRealInstall };
