# cc-watchdog.ps1 - 让单实例驱动持续跑：掉线/冻结就重启，抓不到进展就记录
# 用法: powershell -NoProfile -File scripts\cc-watchdog.ps1 [-Hours 12] [-Tag A]
param(
  [int]$Hours = 12,
  [string]$Tag = 'A',
  [int]$Port = 9228,
  [int]$CheckSec = 180
)
$ErrorActionPreference = 'SilentlyContinue'
$repo = 'D:\Vibe\NetClass'
Set-Location $repo

function Get-Drivers {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and "$($_.CommandLine)" -match 'scripts\\cc-auto\.mjs' }
}
function Get-Pos {
  try {
    $r = (& node scripts\cc-health.mjs --port $Port --secs 5 --every 30 2>$null | Select-Object -First 1)
    if ($r) { return $r | ConvertFrom-Json } else { return $null }
  } catch { return $null }
}
function Start-Driver {
  $p = Start-Process -FilePath 'node' -ArgumentList "scripts\cc-auto.mjs --port $Port --tag $Tag" -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "$repo\runs\logs\cc-$Tag.out" -RedirectStandardError "$repo\runs\logs\cc-$Tag.err" -PassThru
  Add-Content "$repo\runs\cc-watchdog.log" ("[{0}] 启动驱动 PID={1}" -f (Get-Date).ToString('HH:mm:ss'), $p.Id)
  return $p
}

Add-Content "$repo\runs\cc-watchdog.log" ("[{0}] watchdog 启动 tag={1} hours={2}" -f (Get-Date).ToString('HH:mm:ss'), $Tag, $Hours)
$end = (Get-Date).AddHours($Hours)
$lastPos = $null
$lastMove = Get-Date
$restarts = 0

while ((Get-Date) -lt $end) {
  $drv = @(Get-Drivers)
  $s = Get-Pos
  $now = Get-Date
  $max = if ($s -and $s.v -and $s.v.dur) { $s.v.dur } else { 0 }

  if ($drv.Count -eq 0) {
    $restarts++
    Add-Content "$repo\runs\cc-watchdog.log" ("[{0}] 没有驱动 → 重启（第 {1} 次）" -f $now.ToString('HH:mm:ss'), $restarts)
    Start-Driver | Out-Null
    Start-Sleep -Seconds 30
    continue
  }

  if ($s -and $s.v) {
    $cur = [int]$s.v.cur
    if ($lastPos -ne $null -and [Math]::Abs($cur - $lastPos) -gt 3) { $lastMove = $now }
    $lastPos = $cur
    $stuck = ($now - $lastMove).TotalSeconds
    $line = ("[{0}] page={1} v={2}/{3}@{4} pct={5} hours={6} courses={7} stuck={8}s drivers={9}" -f $now.ToString('HH:mm:ss'), $s.page, $cur, $max, $s.v.rate, $s.pct, $s.hours, $s.courses, [int]$stuck, $drv.Count)
  } else {
    $line = ("[{0}] page={1} err={2} hours={3} courses={4} drivers={5}" -f $now.ToString('HH:mm:ss'), $s.page, $s.err, $s.hours, $s.courses, $drv.Count)
  }
  Add-Content "$repo\runs\cc-watchdog.log" $line

  # 冻结超过 8 分钟 → 重启驱动
  if (($now - $lastMove).TotalMinutes -gt 8) {
    $restarts++
    Add-Content "$repo\runs\cc-watchdog.log" ("       冻结超过 8 分钟 → 杀驱动重启（第 {0} 次）" -f $restarts)
    foreach ($d in $drv) { taskkill /F /PID $d.ProcessId 2>$null | Out-Null }
    Start-Sleep -Seconds 5
    Start-Driver | Out-Null
    $lastMove = Get-Date
  }
  Start-Sleep -Seconds $CheckSec
}
Add-Content "$repo\runs\cc-watchdog.log" ("[{0}] watchdog 退出（重启 {1} 次）" -f (Get-Date).ToString('HH:mm:ss'), $restarts)
