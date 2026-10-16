# cc-minder.ps1 - 保活看护：保证"至少一个驱动在跑"且"播放有进展"，不抢别人已占的标签
#   每 60s 检查一次：
#     · 驱动数 = 0 且标签空闲(owner 为空) → 自己起一个（tag=A）
#     · 驱动在跑但播放 8 分钟没推进 → 记录 + 重启自己那个
#     · 驱动数 >= 2 → 什么都不做（别人在跑，别掺和）
# 用法: powershell -NoProfile -File scripts\cc-minder.ps1 -Hours 12
param([int]$Hours = 12, [int]$Port = 9228, [string]$Tag = 'A')
$ErrorActionPreference = 'SilentlyContinue'
$repo = 'C:\Users\Administrator\Desktop\Vibe\_opensource\artifacts\TaskMesh\netclass-20261013'
Set-Location $repo
$logf = "$repo\runs\cc-minder.log"

function Drv { Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and "$($_.CommandLine)" -match 'scripts\\cc-auto\.mjs' -and "$($_.CommandLine)" -notmatch 'wmic|--secs=10' } }
function Pos {
  $r = (& node scripts\cc-health.mjs --port $Port --secs 5 --every 30 2>$null | Select-Object -First 1)
  if ($r) { $r | ConvertFrom-Json } else { $null }
}
function Log($m) { Add-Content $logf ("[{0}] {1}" -f (Get-Date).ToString('HH:mm:ss'), $m) }
function StartDrv {
  $p = Start-Process -FilePath 'node' -ArgumentList "scripts\cc-auto.mjs --port $Port --tag $Tag" -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "$repo\runs\logs\cc-$Tag.out" -RedirectStandardError "$repo\runs\logs\cc-$Tag.err" -PassThru
  Log ("启动驱动 PID=" + $p.Id)
}

Log ("minder 启动 hours=$Hours")
$end = (Get-Date).AddHours($Hours)
$lastCur = -1; $lastMove = Get-Date; $spawns = 0

while ((Get-Date) -lt $end) {
  $d = @(Drv); $s = Pos; $now = Get-Date
  if ($s -and $s.v) {
    if ($lastCur -ge 0 -and [Math]::Abs([int]$s.v.cur - $lastCur) -gt 3) { $lastMove = $now }
    $lastCur = [int]$s.v.cur
  }
  $stuck = [int]($now - $lastMove).TotalSeconds
  Log ("drv={0} page={1} v={2}/{3}@{4} pct={5} stuck={6}s" -f $d.Count, $s.page, $s.v.cur, $s.v.dur, $s.v.rate, $s.pct, $stuck)

  if ($d.Count -eq 0) {
    $spawns++
    Log ("没有驱动 → 起一个（第 $spawns 次）")
    StartDrv
    $lastMove = Get-Date
    Start-Sleep -Seconds 40
    continue
  }
  if ($stuck -gt 480) {
    Log ("播放冻结 ${stuck}s → 重启驱动")
    foreach ($x in $d) { taskkill /F /PID $x.ProcessId 2>$null | Out-Null }
    Start-Sleep -Seconds 5
    StartDrv
    $lastMove = Get-Date
  }
  Start-Sleep -Seconds 120
}
Log ("minder 退出（起驱动 $spawns 次）")
