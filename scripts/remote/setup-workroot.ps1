# setup-workroot.ps1 -- build E:\Desktop\NetClass as the single work root.
# Pure ASCII (PS 5.1 safe). Idempotent. Never deletes the old root.
#
# Layout:
#   app\        live payload served on 127.0.0.1:17800 (server.ps1, App.js, netclass.user.js, dist\)
#   instances\  Chrome --user-data-dir per debug port
#   orders\     one directory per order: <yyyy-MM-dd>-<slug>\
#   runs\       logs / screenshots / captures
#   scripts\    ps1 that the laptop executes
#   config\     machine-local json
#
# Old root stays untouched so the scheduled task can be rolled back in one line.

param(
  [string]$NewRoot = 'E:\Desktop\NetClass',
  [string]$OldRoot = 'C:\Users\WJX\AppData\Local\TaskMesh\netclass',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Sect($t) { Write-Output ''; Write-Output ('===== ' + $t + ' =====') }
function Say($m) { Write-Output ('  ' + $m) }

Sect 'SKELETON'
foreach ($s in @('app','app\dist','instances','orders','runs','runs\logs','runs\shots','scripts','config')) {
  $p = Join-Path $NewRoot $s
  if (Test-Path $p) { Say ('exists  ' + $p) }
  elseif ($DryRun) { Say ('WOULD   ' + $p) }
  else { New-Item -ItemType Directory -Force -Path $p | Out-Null; Say ('created ' + $p) }
}

Sect 'COPY LIVE PAYLOAD'
$files = @(
  @{ src = 'server.ps1'            ; dst = 'app\server.ps1' },
  @{ src = 'App.js'                ; dst = 'app\App.js' },
  @{ src = 'netclass.user.js'      ; dst = 'app\netclass.user.js' },
  @{ src = 'dist-netclass.user.js' ; dst = 'app\dist\netclass.user.js' }
)
foreach ($f in $files) {
  $s = Join-Path $OldRoot $f.src
  $d = Join-Path $NewRoot $f.dst
  if (-not (Test-Path $s)) { Say ('MISSING ' + $s); continue }
  $sSize = (Get-Item $s).Length
  if ($DryRun) { Say ('WOULD   ' + $f.dst + '  (' + $sSize + ' B)'); continue }
  Copy-Item -LiteralPath $s -Destination $d -Force
  $dSize = (Get-Item $d).Length
  $ok = if ($sSize -eq $dSize) { 'OK  ' } else { 'SIZE MISMATCH ' }
  Say ($ok + $f.dst + '  ' + $dSize + ' B')
}

Sect 'MIGRATE ORDER RECORDS'
$oldOrders = Join-Path $OldRoot 'orders'
$newOrders = Join-Path $NewRoot 'orders'
if (Test-Path $oldOrders) {
  $items = @(Get-ChildItem $oldOrders -Force -EA SilentlyContinue)
  Say ('source entries = ' + $items.Count)
  foreach ($i in $items) {
    $dst = Join-Path $newOrders $i.Name
    if (Test-Path $dst) { Say ('skip (exists) ' + $i.Name); continue }
    if ($DryRun) { Say ('WOULD   ' + $i.Name) }
    else {
      if ($i.PSIsContainer) { Copy-Item -LiteralPath $i.FullName -Destination $dst -Recurse -Force }
      else { Copy-Item -LiteralPath $i.FullName -Destination $dst -Force }
      Say ('copied  ' + $i.Name)
    }
  }
} else { Say 'no old orders dir' }

Sect 'MIGRATE LOGS + SHOTS'
foreach ($pair in @(@{ s = 'logs'; d = 'runs\logs' }, @{ s = 'shots'; d = 'runs\shots' })) {
  $s = Join-Path $OldRoot $pair.s
  if (-not (Test-Path $s)) { Say ('no ' + $pair.s); continue }
  $d = Join-Path $NewRoot $pair.d
  $n = 0
  foreach ($f in @(Get-ChildItem $s -File -Force -EA SilentlyContinue)) {
    $t = Join-Path $d $f.Name
    if (Test-Path $t) { continue }
    if (-not $DryRun) { Copy-Item -LiteralPath $f.FullName -Destination $t -Force }
    $n++
  }
  Say ($pair.s + ' -> ' + $pair.d + '  copied ' + $n + ' file(s)')
}

Sect 'VERIFY PAYLOAD'
if (-not $DryRun) {
  foreach ($rel in @('app\server.ps1','app\App.js','app\netclass.user.js','app\dist\netclass.user.js')) {
    $p = Join-Path $NewRoot $rel
    Say ($(if (Test-Path $p) { 'OK   ' } else { 'FAIL ' }) + $rel + '  ' + $(if (Test-Path $p) { (Get-Item $p).Length } else { 0 }) + ' B')
  }
  $appAll = @(Get-ChildItem (Join-Path $NewRoot 'app') -Recurse -File -Force -EA SilentlyContinue)
  Say ('app total files = ' + $appAll.Count + '  ' + [math]::Round(($appAll | Measure-Object Length -Sum).Sum/1MB,2) + ' MB')
  $ordAll = @(Get-ChildItem (Join-Path $NewRoot 'orders') -Recurse -Force -EA SilentlyContinue)
  Say ('orders total entries = ' + $ordAll.Count)
}

Sect 'DONE'
