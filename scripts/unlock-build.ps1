<#
.SYNOPSIS
  Frees the build output so electron-builder can replace it.
  Fixes: "EBUSY: resource busy or locked, unlink '...\dist-app\win-unpacked\resources\app.asar'"

.DESCRIPTION
  Windows won't delete a file another process has open. electron-builder deletes the last build first, so
  anything holding a file in it fails the build. In order, this script:
    1. Asks a running Echo Volume to quit (--quit, the same request the installer sends). Closing its window
       only hides it in the tray, so it's often still running.
    2. Ends what's left of the app: anything running from the build folders, and the Electron that
       "npm run app" started from node_modules.
    3. Asks Windows which processes still hold a file there (Restart Manager: the check installers use)
       and closes them. Anything not part of this app (an editor, a terminal) is asked about first,
       unless -Force. Windows itself and antivirus are never closed: they're waited for instead.
    4. Deletes the old win-unpacked folders (electron-builder rebuilds them), retrying for a while
       in case antivirus is still scanning the new files.
  Exit code 0 = the output is free; 1 = something still holds it (it says what).

.PARAMETER Force
  Close everything found holding the files without asking.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\unlock-build.ps1
.EXAMPLE
  .\scripts\unlock-build.ps1 -WhatIf     # only show what it would close and delete
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch] $Force,
  [string[]] $Folders = @('dist-app', 'dist', 'dist-installer')
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$dirs = @($Folders | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path -LiteralPath $_ } |
  ForEach-Object { (Resolve-Path -LiteralPath $_).Path.TrimEnd('\') + '\' })
if ($dirs.Count -eq 0) { Write-Host 'Nothing to unlock: no build output yet.'; exit 0 }

function Test-Under([string] $path, [string[]] $under) {
  if (-not $path) { return $false }
  foreach ($d in $under) { if ($path.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return $false
}
function Stop-Pids([int[]] $ids, [string] $why) {
  foreach ($id in $ids | Select-Object -Unique) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    if ($PSCmdlet.ShouldProcess("$($p.ProcessName) (PID $id)", "Stop: $why")) {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
      Write-Host "  Closed $($p.ProcessName) (PID $id): $why"
    }
  }
}
# Processes Windows won't let us (or shouldn't) close; they let go by themselves
$untouchable = @('System', 'Idle', 'MsMpEng', 'NisSrv', 'MpDefenderCoreService', 'SearchIndexer', 'SearchProtocolHost', 'csrss', 'wininit', 'services', 'lsass', 'svchost', 'explorer')

# ---------- 1. Ask Echo Volume to quit ----------
$app = @(Get-Process -Name 'Echo Volume', 'Echo Volume Setup' -ErrorAction SilentlyContinue)
if ($app.Count -gt 0) {
  Write-Host 'Echo Volume is running (maybe only in the tray): asking it to quit...'
  $exe = ($app | Where-Object { $_.Path -and $_.ProcessName -eq 'Echo Volume' } | Select-Object -First 1).Path
  if ($exe -and $PSCmdlet.ShouldProcess($exe, 'Run with --quit')) {
    Start-Process -FilePath $exe -ArgumentList '--quit' -WindowStyle Hidden
    $app | ForEach-Object { $_.WaitForExit(8000) | Out-Null }
  }
}

# ---------- 2. End what's left of the app ----------
$electronDir = (Join-Path $root 'node_modules\electron\dist').TrimEnd('\') + '\'
$leftovers = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -in @('Echo Volume', 'Echo Volume Setup') -or (Test-Under $_.Path $dirs) -or (Test-Under $_.Path @($electronDir))
} | ForEach-Object { $_.Id })
if ($leftovers.Count -gt 0) { Stop-Pids $leftovers 'part of Echo Volume' ; Start-Sleep -Milliseconds 800 }

# ---------- 3. Whatever else holds a file there (Windows Restart Manager) ----------
if (-not ('EchoVolume.FileLocks' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace EchoVolume {
  public static class FileLocks {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct RM_PROCESS_INFO {
      public RM_UNIQUE_PROCESS Process;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
      public int ApplicationType; public uint AppStatus; public uint TSSessionId;
      [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nServices, string[] services);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
    // The ids of the processes that have any of these files open
    public static int[] Holding(string[] files) {
      uint h; var key = new StringBuilder(64);
      if (RmStartSession(out h, 0, key) != 0) return new int[0];
      try {
        if (RmRegisterResources(h, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) return new int[0];
        for (int attempt = 0; attempt < 3; attempt++) {
          uint needed, count = 0, reasons = 0;
          int r = RmGetList(h, out needed, ref count, null, ref reasons);
          if (r == 0) return new int[0];
          if (r != 234) return new int[0]; // 234 = ERROR_MORE_DATA: there are some, sized below
          var info = new RM_PROCESS_INFO[needed]; count = needed;
          r = RmGetList(h, out needed, ref count, info, ref reasons);
          if (r == 0) { var ids = new List<int>(); for (int i = 0; i < count; i++) ids.Add(info[i].Process.dwProcessId); return ids.ToArray(); }
          if (r != 234) return new int[0]; // the list grew meanwhile: ask again
        }
        return new int[0];
      } finally { RmEndSession(h); }
    }
  }
}
'@
}
function Get-Holders {
  $files = @(Get-ChildItem -LiteralPath $dirs -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 2000 | ForEach-Object { $_.FullName })
  if ($files.Count -eq 0) { return @() }
  return @([EchoVolume.FileLocks]::Holding($files) | Where-Object { $_ -ne $PID } | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
}

$holders = Get-Holders
foreach ($p in $holders) {
  $name = "$($p.ProcessName) (PID $($p.Id))"
  if ($p.ProcessName -in $untouchable) { Write-Host "  $name has files open: waiting for it (it can't be closed safely)"; continue }
  $ask = -not $Force -and -not $WhatIfPreference
  if ($ask) {
    $title = if ($p.MainWindowTitle) { " - $($p.MainWindowTitle)" } else { '' }
    $answer = Read-Host "  $name$title has files in the build output open. Close it? [Y/n]"
    if ($answer -match '^(n|no)$') { Write-Host "  Left $name running"; continue }
  }
  Stop-Pids @($p.Id) 'had build files open'
}

# ---------- 4. Delete the old app folders, waiting for antivirus ----------
$old = @(Get-ChildItem -LiteralPath $dirs -Directory -Recurse -Filter '*-unpacked' -ErrorAction SilentlyContinue)
foreach ($d in $old) {
  if (-not $PSCmdlet.ShouldProcess($d.FullName, 'Delete (electron-builder rebuilds it)')) { continue }
  $gone = $false
  for ($i = 1; $i -le 8 -and -not $gone; $i++) {
    try { Remove-Item -LiteralPath $d.FullName -Recurse -Force; $gone = $true }
    catch { Start-Sleep -Seconds ([Math]::Min(2 * $i, 6)) }
  }
  if ($gone) { Write-Host "Deleted $($d.FullName)" }
}

# ---------- Result ----------
if ($WhatIfPreference) { exit 0 }
$still = @(Get-Holders)
if ($still.Count -eq 0 -and -not (@($old | Where-Object { Test-Path -LiteralPath $_.FullName }).Count)) {
  Write-Host 'Build output is free.' -ForegroundColor Green
  exit 0
}
Write-Host 'Still locked:' -ForegroundColor Yellow
$still | ForEach-Object { Write-Host "  $($_.ProcessName) (PID $($_.Id)) $($_.Path)" }
Write-Host '  If nothing is listed, a window or terminal is inside the folder (close it), or antivirus is'
Write-Host '  still scanning: run this again in a minute, or exclude the build folders in Windows Security.'
exit 1
