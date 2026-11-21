# probe2.ps1 -- focused: what actually needs to move, and what the live server depends on.
# Pure ASCII (PS 5.1 safe).

$ErrorActionPreference = 'Continue'
function Sect($t) { Write-Output ''; Write-Output ('===== ' + $t + ' =====') }

$OLD = 'C:\Users\WJX\AppData\Local\TaskMesh\netclass'
$NEW = 'E:\Desktop\NetClass'

Sect 'LIVE PAYLOAD IN OLD ROOT (the files the running server serves)'
foreach ($f in @('server.ps1','App.js','netclass.user.js','dist-netclass.user.js')) {
  $p = Join-Path $OLD $f
  if (Test-Path $p) {
    $i = Get-Item $p
    Write-Output ('  ' + $f.PadRight(24) + ' ' + $i.Length + ' B  ' + $i.LastWriteTime)
  } else {
    Write-Output ('  ' + $f.PadRight(24) + ' MISSING')
  }
}

Sect 'SERVED CONTENT (what 17800 is actually handing out right now)'
foreach ($u in @('/status','/ping','/App.js','/netclass.user.js')) {
  try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:17800' + $u) -UseBasicParsing -TimeoutSec 6 -EA Stop
    Write-Output ('  ' + $u.PadRight(20) + ' ' + $r.StatusCode + '  ' + $r.RawContentLength + ' B')
    if ($u -in '/status','/ping') { Write-Output ('      body: ' + $r.Content) }
  } catch {
    Write-Output ('  ' + $u.PadRight(20) + ' ERR ' + $_.Exception.Message.Split([char]10)[0])
  }
}

Sect 'SCHEDULED TASK ACTIONS (how the server + visible-chrome tasks are launched)'
foreach ($tn in @('NetClassServer','NetClassVis-huayi','NetClassVis-huayi2','NetClassTile4')) {
  $t = Get-ScheduledTask -TaskName $tn -EA SilentlyContinue
  if (-not $t) { Write-Output ('  ' + $tn + ' MISSING'); continue }
  foreach ($a in $t.Actions) {
    Write-Output ('  [' + $tn + '] exec=' + $a.Execute)
    Write-Output ('      args=' + $a.Arguments)
    Write-Output ('      cwd =' + $a.WorkingDirectory)
  }
  Write-Output ('      principal=' + $t.Principal.UserId + ' logon=' + $t.Principal.LogonType + ' run=' + $t.Principal.RunLevel)
}

Sect 'CHROME BINARIES'
$found = @()
foreach ($root in @('C:\Program Files\Google','C:\Program Files (x86)\Google','D:\','E:\Desktop','C:\Users\WJX\AppData\Local')) {
  if (Test-Path $root) {
    $hits = Get-ChildItem $root -Filter 'chrome.exe' -Recurse -Depth 4 -EA SilentlyContinue |
      Select-Object -First 8
    foreach ($h in $hits) { $found += $h.FullName }
  }
}
if ($found.Count -eq 0) { Write-Output '  none found' }
else {
  $found | Sort-Object -Unique | ForEach-Object {
    $v = (Get-Item $_).VersionInfo
    Write-Output ('  ' + $_ + '   v' + $v.ProductVersion)
  }
}
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (Test-Path $edge) { Write-Output ('  EDGE ' + (Get-Item $edge).VersionInfo.ProductVersion) }

Sect 'WHERE DO CHROME PROFILES LIVE'
foreach ($c in @(
  "$env:LOCALAPPDATA\TaskMesh",
  'C:\Users\WJX\AppData\Local\TaskMesh',
  'D:\TaskMesh',
  'E:\Desktop\NetClass'
)) {
  if (Test-Path $c) {
    Write-Output ('  ' + $c)
    Get-ChildItem $c -Directory -Force -EA SilentlyContinue |
      Select-Object -First 20 | ForEach-Object { Write-Output ('      ' + $_.Name) }
  }
}

Sect 'EXISTING ORDER RECORD FORMAT (orders\tianrui)'
$tr = Join-Path $OLD 'orders\tianrui'
if (Test-Path $tr) {
  Get-ChildItem $tr -Recurse -Force -EA SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($tr.Length)
    Write-Output ('  ' + $rel + $(if (-not $_.PSIsContainer) { '   ' + $_.Length + ' B' } else { '\' }))
  }
} else { Write-Output '  not present' }

Sect 'ORDERS DIR FULL'
Get-ChildItem (Join-Path $OLD 'orders') -Recurse -Force -EA SilentlyContinue | ForEach-Object {
  Write-Output ('  ' + $_.FullName.Substring((Join-Path $OLD 'orders').Length) + $(if (-not $_.PSIsContainer) { '   ' + $_.Length + ' B' } else { '\' }))
}

Sect 'E:\Desktop TOP LEVEL (is E: really the desktop?)'
Get-ChildItem 'E:\Desktop' -Force -EA SilentlyContinue |
  Select-Object -First 40 | ForEach-Object { Write-Output ('  ' + $_.Mode + '  ' + $_.Name) }

Sect 'REAL DESKTOP PATH'
Write-Output ('  USERPROFILE\Desktop = ' + (Test-Path "$env:USERPROFILE\Desktop"))
try {
  $reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -EA Stop
  Write-Output ('  registry Desktop   = ' + $reg.Desktop)
} catch { Write-Output '  registry read failed' }

Sect 'GIT ANYWHERE?'
foreach ($p in @('C:\Users\WJX\NetClass','D:\NetClass','E:\Desktop\NetClass\NetClass')) {
  Write-Output ('  ' + $p + ' -> ' + $(if (Test-Path $p) { 'EXISTS' } else { 'no' }))
}
$git = Get-Command git -EA SilentlyContinue
Write-Output ('  git on PATH: ' + $(if ($git) { $git.Source } else { 'no' }))

Sect 'DISK SPACE E:'
$d = Get-PSDrive E
Write-Output ('  E: free=' + [math]::Round($d.Free/1GB,1) + 'GB')

Sect 'END'
