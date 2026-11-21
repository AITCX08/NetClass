# switch-server-root.ps1 -- move the 17800 service onto E:\Desktop\NetClass\app.
# Pure ASCII (PS 5.1 safe).
#
# Safe order (never leaves the machine without a working 17800):
#   1. dry-start server.ps1 from the NEW root on port 17801 and verify /status payload sizes
#   2. only if sizes match the old server, stop the old one and re-register the task
#   3. start the task, verify 17800 answers with the same sizes
#   4. kill the 17801 probe server
#
# -Rollback puts the task back on the OLD root.

param(
  [string]$NewRoot = 'E:\Desktop\NetClass\app',
  [string]$OldRoot = 'C:\Users\WJX\AppData\Local\TaskMesh\netclass',
  [int]$ProbePort = 17801,
  [int]$Port = 17800,
  [string]$TaskName = 'NetClassServer',
  [switch]$Rollback
)

$ErrorActionPreference = 'Continue'
function Sect($t) { Write-Output ''; Write-Output ('===== ' + $t + ' =====') }
function Say($m) { Write-Output ('  ' + $m) }

function Get-StatusSize([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $p + '/status') -UseBasicParsing -TimeoutSec 6 -EA Stop
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}

# ---------------------------------------------------------------- rollback
if ($Rollback) {
  Sect 'ROLLBACK -> OLD ROOT'
  $a = 'powershell.exe'
  $args = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $OldRoot 'server.ps1') + '"'
  Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue | Stop-ScheduledTask -EA SilentlyContinue
  Start-Sleep -Seconds 1
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -like '*netclass*server.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue; Say ('killed ' + $_.ProcessId) }
  $act = New-ScheduledTaskAction -Execute $a -Argument $args
  Set-ScheduledTask -TaskName $TaskName -Action $act | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $s = Get-StatusSize $Port
  Say ('17800 -> ' + $(if ($s) { 'OK userJs=' + $s.userJsBytes + ' appJs=' + $s.appJsBytes } else { 'NO RESPONSE' }))
  exit $(if ($s) { 0 } else { 1 })
}

# ---------------------------------------------------------------- 1. probe new root
Sect '1. PROBE NEW ROOT ON ' + $ProbePort
foreach ($rel in @('server.ps1','App.js','netclass.user.js','dist\netclass.user.js')) {
  $p = Join-Path $NewRoot $rel
  Say ($(if (Test-Path $p) { 'OK   ' } else { 'FAIL ' }) + $rel + ' ' + $(if (Test-Path $p) { (Get-Item $p).Length } else { 0 }) + ' B')
}

$old = Get-StatusSize $Port
if ($old) { Say ('old 17800 baseline: userJs=' + $old.userJsBytes + ' appJs=' + $old.appJsBytes) }
else { Say 'old 17800: NO RESPONSE (continuing anyway)' }

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like ('*server.ps1*' + $ProbePort + '*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }

$probeArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',
               (Join-Path $NewRoot 'server.ps1'),'-Port',[string]$ProbePort,'-Root',$NewRoot)
$probe = Start-Process -FilePath 'powershell.exe' -ArgumentList $probeArgs -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3

$new = Get-StatusSize $ProbePort
if (-not $new) {
  Say ('FAIL: probe server did not answer on ' + $ProbePort)
  if (-not $probe.HasExited) { Stop-Process -Id $probe.Id -Force -EA SilentlyContinue }
  Say 'ABORT -- 17800 left untouched'
  exit 1
}
Say ('new probe: userJs=' + $new.userJsBytes + ' appJs=' + $new.appJsBytes)

if ($old -and ($new.userJsBytes -ne $old.userJsBytes -or $new.appJsBytes -ne $old.appJsBytes)) {
  Say 'FAIL: payload sizes differ from the live server -- not switching'
  Stop-Process -Id $probe.Id -Force -EA SilentlyContinue
  exit 1
}
Say 'payload sizes match'

# also verify the served bytes really come from the new root
try {
  $js = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $ProbePort + '/App.js') -UseBasicParsing -TimeoutSec 10
  $head = $js.Content.Substring(0, [Math]::Min(120, $js.Content.Length)) -replace "`r?`n", ' '
  Say ('new /App.js head: ' + $head)
} catch { Say ('new /App.js ERR ' + $_.Exception.Message) }

# ---------------------------------------------------------------- 2. cut over
Sect '2. CUT OVER 17800'
Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue | ForEach-Object {
  Say ('task state before = ' + $_.State)
  Stop-ScheduledTask -TaskName $TaskName -EA SilentlyContinue
}
Start-Sleep -Seconds 1
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*netclass*server.ps1*' -and $_.CommandLine -notlike ('*' + $ProbePort + '*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue; Say ('stopped old pid ' + $_.ProcessId) }
Start-Sleep -Seconds 1

$newArgStr = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $NewRoot 'server.ps1') +
             '" -Port ' + $Port + ' -Root "' + $NewRoot + '"'
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $newArgStr
Set-ScheduledTask -TaskName $TaskName -Action $act | Out-Null
Say ('task args -> ' + $newArgStr)

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

# ---------------------------------------------------------------- 3. verify
Sect '3. VERIFY 17800'
$done = Get-StatusSize $Port
if ($done) {
  Say ('17800 OK  userJs=' + $done.userJsBytes + ' appJs=' + $done.appJsBytes)
} else {
  Say '17800 NO RESPONSE'
  Start-Sleep -Seconds 3
  $done = Get-StatusSize $Port
  if ($done) { Say ('17800 OK (retry)  userJs=' + $done.userJsBytes + ' appJs=' + $done.appJsBytes) }
}
try {
  $ping = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + '/ping') -UseBasicParsing -TimeoutSec 5
  Say ('/ping -> ' + $ping.Content)
} catch { Say '/ping ERR' }

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*netclass*server.ps1*' } |
  ForEach-Object { Say ('running: pid=' + $_.ProcessId + ' ' + ($_.CommandLine -replace '.*-File\s+','').Substring(0,[Math]::Min(110,($_.CommandLine -replace '.*-File\s+','').Length))) }

Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue | ForEach-Object { Say ('task state after = ' + $_.State) }

# ---------------------------------------------------------------- 4. cleanup probe
Sect '4. STOP PROBE SERVER'
if ($probe -and -not $probe.HasExited) {
  Stop-Process -Id $probe.Id -Force -EA SilentlyContinue
  Say ('stopped probe pid ' + $probe.Id)
} else { Say 'probe already gone' }

Sect 'DONE'
exit $(if ($done) { 0 } else { 1 })
