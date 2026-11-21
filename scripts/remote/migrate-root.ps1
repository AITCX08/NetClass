# migrate-root.ps1  -- RUNS ON THE LAB LAPTOP (pure ASCII, PS 5.1 compatible)
#
# Purpose: move the NetClass deployment payload onto the dedicated work folder so that
# code + runtime data + per-order records all live in one tree.
#
#   OLD: C:\Users\WJX\AppData\Local\TaskMesh\netclass
#   NEW: E:\Desktop\NetClass
#
# Target layout created under NEW ROOT:
#   app\        deployment payload (dist, inject scripts, launch.mjs, package files)
#   instances\  per-port Chrome user-data-dir (regenerable; skipped unless -IncludeInstances)
#   orders\     one folder per order: <yyyy-MM-dd>-<target-slug>\
#   runs\       logs / screenshots / evidence
#   config\     machine-local json (never committed anywhere)
#
# Exit codes: 0 ok, 2 nothing to migrate, 3 precheck failed, 4 copy failed
#
# NOTE: never run this while Chrome is alive on a forwarded port.
#       Check first:  Get-Process chrome -EA SilentlyContinue | Measure-Object

param(
  [string]$OldRoot = 'C:\Users\WJX\AppData\Local\TaskMesh\netclass',
  [string]$NewRoot = 'E:\Desktop\NetClass',
  [switch]$IncludeInstances,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Output ("[migrate] " + $m) }

Say ("OLD = " + $OldRoot)
Say ("NEW = " + $NewRoot)

# ---- precheck -------------------------------------------------------------
if (-not (Test-Path $OldRoot)) {
  Say "FAIL: old root does not exist"
  exit 3
}

$newDrive = (Split-Path -Qualifier $NewRoot)
if (-not (Test-Path ($newDrive + '\'))) {
  Say ("FAIL: drive " + $newDrive + " not available")
  exit 3
}

$chrome = @(Get-Process chrome -ErrorAction SilentlyContinue)
if ($chrome.Count -gt 0) {
  Say ("WARN: " + $chrome.Count + " chrome process(es) running - profile files may be locked")
}

# ---- skeleton -------------------------------------------------------------
$subs = @('app', 'instances', 'orders', 'runs', 'config')
foreach ($s in $subs) {
  $p = Join-Path $NewRoot $s
  if (-not (Test-Path $p)) {
    if ($DryRun) { Say ("WOULD create " + $p) }
    else { New-Item -ItemType Directory -Path $p -Force | Out-Null; Say ("created " + $p) }
  } else {
    Say ("exists  " + $p)
  }
}

# ---- copy -----------------------------------------------------------------
# robocopy /E  = all subdirs incl empty
# /XJ         = skip junctions (Chrome profiles contain them and they loop)
# /R:1 /W:1   = do not hang on locked files
$rcArgs = @($OldRoot, (Join-Path $NewRoot 'app'), '/E', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS')
if (-not $IncludeInstances) {
  $rcArgs += '/XD'
  $rcArgs += (Join-Path $OldRoot 'instances')
  Say "skipping instances\ (regenerable; pass -IncludeInstances to copy)"
}

if ($DryRun) {
  Say ("WOULD run: robocopy " + ($rcArgs -join ' '))
} else {
  Say ("robocopy " + ($rcArgs -join ' '))
  $rc = 0
  & robocopy @rcArgs | Out-Null
  $rc = $LASTEXITCODE
  Say ("robocopy exit = " + $rc)
  if ($rc -ge 8) {
    Say "FAIL: robocopy reported errors"
    exit 4
  }
}

# ---- report ---------------------------------------------------------------
if (-not $DryRun) {
  $oldCount = @(Get-ChildItem -Path $OldRoot -Recurse -File -Force -ErrorAction SilentlyContinue).Count
  $appDir = Join-Path $NewRoot 'app'
  $newCount = @(Get-ChildItem -Path $appDir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
  $appSize = [math]::Round(((Get-ChildItem -Path $appDir -Recurse -File -Force -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum / 1MB), 1)
  Say ("old files = " + $oldCount)
  Say ("new files = " + $newCount + "  (" + $appSize + " MB)")
  if ($newCount -lt 1) {
    Say "FAIL: nothing landed in app\"
    exit 4
  }
  $marker = Join-Path $NewRoot '.migrated-from.txt'
  ("migrated from " + $OldRoot + " at " + (Get-Date -Format s) + " by scripts/remote/migrate-root.ps1") |
    Set-Content -Path $marker -Encoding ASCII
  Say ("marker written " + $marker)
}

# ---- key files sanity -----------------------------------------------------
foreach ($f in @('launch.mjs', 'package.json')) {
  $p = Join-Path (Join-Path $NewRoot 'app') $f
  if (Test-Path $p) { Say ("OK   app\" + $f) } else { Say ("MISS app\" + $f) }
}

Say "DONE"
exit 0
