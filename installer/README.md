# Echo Volume Setup

A branded installer for Echo Volume: a small Electron app of its own ("Echo Volume Setup") that carries the packaged
app as a payload and installs it with a frameless, dark wizard. It replaces the default NSIS dialogs
(`npm run dist` still builds the old NSIS installer, if ever needed).

```
npm run build:all        → dist-installer/Echo-Volume-Setup-<version>.exe   (one portable exe, no admin needed)
```

## How it fits together

```
npm run build:app        electron-builder --dir      → dist-app/win-unpacked         (the app, ~370 MB)
npm run build:payload    installer/scripts/make-payload.js
                                                      → installer/payload/payload.evpack  (Brotli stream, ~125 MB)
                                                        installer/payload/payload.json    (version, sizes, SHA-256)
npm run build:installer  installer/scripts/make-splash.js + electron-builder --config installer/electron-builder.json
                                                      → dist-installer/Echo-Volume-Setup-<version>.exe (portable)
```

| Path | What it is |
|---|---|
| `installer/main.js` | Setup's main process: wizard window, IPC (validated), silent mode, elevation hand-off |
| `installer/preload.js` | The only bridge to the UI (`window.setup`): typed with JSDoc, no Node in the page |
| `installer/renderer/` | The wizard: `index.html` (strict CSP), `styles.css`, `app.js` |
| `installer/lib/install.js` | Install engine: verify → extract to a staging folder → swap in → shortcuts → registry, every step journaled for rollback |
| `installer/lib/pack.js` | Payload format: pack (build) and streaming unpack (install), with path checks |
| `installer/lib/uninstall.js`, `installer/uninstall-main.js` | The uninstaller. It ships **inside the app** (`Echo Volume.exe --uninstall`), same window and styles |
| `installer/lib/common.js` | Registry (`reg.exe`), shortcuts, processes, elevation, log |
| `installer/electron-builder.json` | Build config for Setup (the app's config stays in `package.json` → `build`) |

**Payload format** (`.evpack`): one Brotli stream of `[type][path][size][bytes]` entries. Node's own zlib unpacks it while
streaming to disk, so the progress bar shows real bytes and the current file name, and no 7-Zip binary ships. Paths are
checked on the way out (no `..`, no absolute paths, no device names), so a tampered payload can't write outside the
install folder. The whole file is SHA-256-checked against `payload.json` before anything is extracted.

**Why the uninstaller lives in the app**: Setup is a portable exe that unpacks itself to `%TEMP%` and deletes itself
afterwards, so it can't be the registered uninstaller. Copying a second Electron runtime (~150 MB) into the install
folder just to uninstall would double the footprint. `desktop/main.js` hands `--uninstall` to `installer/uninstall-main.js`
before anything of the app starts.

## What it does

- **Fresh install** (per user, no admin): `%LOCALAPPDATA%\Programs\Echo Volume`. *Customize* changes the folder,
  shortcuts, *Start with Windows* and *Open when done*, or picks **Everyone on this PC**: Setup relaunches itself with
  administrator rights (UAC) and carries on in `C:\Program Files\Echo Volume`.
- **Existing install**: Setup finds it under the Uninstall keys and offers **Upgrade / Repair / Reinstall** (by version)
  or **Uninstall**. It keeps the existing folder and scope. Older NSIS installs (v1 to v3) are *legacy*: their own
  uninstaller runs silently first (`/S --updated _?=<dir>`, so it waits and keeps the user's data), then v5 goes in
  the same place.
- **The running app** is asked to quit (`Echo Volume.exe --quit` → the single-instance lock tells the running copy).
  Whatever is still running after ~6 s (older versions don't understand `--quit`) is ended.
- **Registered with Windows**: `HK{CU|LM}\Software\Microsoft\Windows\CurrentVersion\Uninstall\local.echovolume.app`
  (DisplayName, DisplayVersion, Publisher, InstallLocation, UninstallString, QuietUninstallString, DisplayIcon,
  EstimatedSize, InstallDate). Shortcuts carry the app's AppUserModelID, so Windows notifications keep working.
- **Start with Windows**: `HKCU\…\Run\Echo Volume = "…\Echo Volume.exe" --hidden`, the same entry as the app's tray
  menu → *Start with Windows*. With `--hidden` the app starts in the tray.
- **Rollback**: cancel (until the old version is touched) or any failure undoes every step in reverse order: extracted
  files, the folder swap, shortcuts (restored if they existed), registry values (restored to what they were). An
  upgrade that fails puts the previous version back.
- **Disk space** is checked before anything is written (app size + 10% + 50 MB).
- **Uninstall** asks whether to delete the user's data too (`%APPDATA%\Echo Volume`: Amazon / SmartThings sign-in,
  playlists, settings); No is the default. It removes shortcuts, the Run entry and the Uninstall key, then a hidden
  PowerShell started through WMI deletes the folders once the uninstaller has exited.

## Silent install (deployment)

```
Echo-Volume-Setup-5.0.0.exe --silent [--dir="D:\Apps\Echo Volume"] [--all-users] [--desktop=0] [--startmenu=0] [--startup=1] [--launch]
```
`/S` works too. `--all-users` needs an elevated prompt (no UAC dialog in silent mode). Exit codes: `0` installed,
`1` failed, `2` cancelled, `3` not enough disk space, `4` damaged payload, `5` needs administrator rights, `6` bad arguments.

Silent uninstall: `"…\Echo Volume.exe" --uninstall --silent [--remove-data]` (this is the registered `QuietUninstallString`).

Testing switches: `--ignore-existing` installs side by side, ignoring installs Windows knows about;
`--debug-free-mb=N` pretends only N MB are free.

## Signing

Both configs carry `win.signtoolOptions` (publisher *Vipin Kumar*, SHA-256, DigiCert timestamp). Without a certificate
electron-builder skips signing ("no code signing certificate configured"). To sign, set before building:

```powershell
$env:CSC_LINK = "C:\certs\codesign.pfx"      # or base64 of the .pfx
$env:CSC_KEY_PASSWORD = "…"
npm run build:all
```
For a cloud HSM (Azure Trusted Signing), use `win.azureSignOptions` instead. Sign **both** builds: the app's exe ends up
inside the payload, and Setup is what people download. Unsigned, or newly signed with a certificate that has no
reputation yet, SmartScreen shows "Windows protected your PC" until enough people have run it. An EV certificate, or
Azure Trusted Signing, builds that reputation fastest.

## Debugging

- **Log**: `%TEMP%\echo-volume-setup.log` (JSON lines, setup and uninstall, *View log* on the error screen). Each install
  logs its options, every phase, the checksum, and on failure each rollback step.
- **Run Setup from source**: `npm run setup` (uses `installer/payload/`, so run `build:app` + `build:payload` once).
  DevTools are on when not packaged.
- **Preview the uninstaller from source**: `npm run app -- --uninstall`. This is a dry run: not packaged and no
  `install.json`, so it only logs what it would delete.
- **Payload compression**: Brotli quality 5 by default (~25 s, ~132 MB). `PAYLOAD_QUALITY=9 npm run build:payload` makes it ~8 MB smaller but takes ~5 minutes.
- **Only the installer changed?** `npm run build:installer` reuses the payload; only app changes need `build:app` + `build:payload`.

| Symptom | Cause / fix |
|---|---|
| `Invalid package …\app.asar` | Some code used Electron's `fs` on the payload; the engine must use `original-fs` (Electron treats `*.asar` paths as archives) |
| Setup starts, then nothing for a few seconds | The portable exe unpacks Setup to `%TEMP%` first (the splash shows meanwhile) |
| "The install folder is in use" | Something still holds a file (the app, Explorer preview, antivirus). Setup retries for 5 s, then rolls back |
| `checksum mismatch` | The exe is damaged or was built with a stale payload: `npm run build:all` |
| Folder left after uninstall | Look for `Could not delete …` in the log: a file was still open after 15 s |
| Electron starts as plain Node (`app` undefined) | `ELECTRON_RUN_AS_NODE=1` is set in that shell (VS Code terminals). Unset it |

## Test checklist

| # | Scenario | Expect |
|---|---|---|
| 1 | Fresh install (Install) | Installed in `%LOCALAPPDATA%\Programs\Echo Volume`, Start menu + desktop shortcuts, Settings → Apps shows *Echo Volume 5.0.0 / Vipin Kumar*, app opens after the countdown |
| 2 | Customize: other folder, no desktop shortcut, Start with Windows | Folder as chosen (with `\Echo Volume` added), no desktop shortcut, Run entry present, after sign-in the app sits in the tray |
| 3 | Everyone on this PC | UAC prompt, install continues in the elevated window, Program Files, shortcuts for all users |
| 4 | Upgrade from the NSIS 3.0.0 (all users) | Welcome shows *3.0.0 is installed*, *Upgrade* asks for admin, the old entry disappears from Settings → Apps, sign-in and playlists still there |
| 5 | Repair (same version again) | *Repair*, same folder, nothing duplicated |
| 6 | Uninstall (Settings → Apps), keep data | Styled uninstaller, shortcuts + Apps entry gone, folder gone a few seconds after Close, `%APPDATA%\Echo Volume` kept |
| 7 | Uninstall with *Also delete my data* | Both folders gone |
| 8 | Cancel mid-install | Confirm bar, *Installation cancelled*, no folder, no shortcuts, no Apps entry |
| 9 | Low disk space (`--debug-free-mb=10`) | *Not enough disk space*, nothing written; silent: exit code 3 |
| 10 | App running during upgrade | It quits (v5: politely; v3: ended), upgrade completes, no "file in use" |
| 11 | Silent install / uninstall | Exit code 0, same result as the wizard, log in `%TEMP%` |
| 12 | Keyboard only | Tab reaches every control with a visible focus ring, Enter activates, Esc goes back / closes the cancel bar |
| 13 | Reduced motion (Windows: *Animation effects* off) | No drifting background, ripples or confetti; progress still updates |
