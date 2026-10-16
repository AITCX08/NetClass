# cc-launch.ps1 - 停掉现有 cc-auto 驱动、清认领表、按需重启 A/B 两个实例
# 用法:
#   powershell -NoProfile -File scripts\cc-launch.ps1 -Status
#   powershell -NoProfile -File scripts\cc-launch.ps1 -Restart -WaitSec 90
param(
  [switch]$Restart,
  [switch]$Status,
  [int]$WaitSec = 60
)
$ErrorActionPreference = 'SilentlyContinue'
$repo = 'C:\Users\Administrator\Desktop\Vibe\netclass'
Set-Location $repo

function Get-Drivers {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and "$($_.CommandLine)" -match 'scripts\\cc-auto\.mjs' }
}

# 1) 杀掉所有真驱动
$drv = @(Get-Drivers)
Write-Output ("发现驱动: " + $drv.Count)
foreach ($d in $drv) {
  taskkill /F /PID $d.ProcessId 2>&1 | Out-Null
  Write-Output ("  killed PID " + $d.ProcessId)
}
Start-Sleep -Seconds 2
Write-Output ("停止后剩余: " + @(Get-Drivers).Count)

if ($Restart) {
  Remove-Item "$repo\runs\cc-claim.json" -Force -ErrorAction SilentlyContinue
  Remove-Item "$repo\runs\logs\cc-A.log","$repo\runs\logs\cc-B.log" -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath 'node' -ArgumentList 'scripts\cc-auto.mjs','--port','9228','--tab','0','--tag','A' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "$repo\runs\logs\cc-A.out" -RedirectStandardError "$repo\runs\logs\cc-A.err"
  Write-Output "launched A (会在日志里打印自己的 tab=)"
  Start-Sleep -Seconds 25
  # 等 A 占好标签后再起 B；B 发现标签都被占会自己新开一个
  $aLine = (Get-Content "$repo\runs\logs\cc-A.log" -Encoding UTF8 -ErrorAction SilentlyContinue | Select-String 'tab=' | Select-Object -First 1)
  Write-Output ("A: " + $aLine)
  Start-Process -FilePath 'node' -ArgumentList 'scripts\cc-auto.mjs','--port','9228','--tab','1','--tag','B' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput "$repo\runs\logs\cc-B.out" -RedirectStandardError "$repo\runs\logs\cc-B.err"
  Write-Output "launched B"
}

if ($WaitSec -gt 0) { Start-Sleep -Seconds $WaitSec }
Write-Output '--- A log tail ---'
if (Test-Path "$repo\runs\logs\cc-A.log") { Get-Content "$repo\runs\logs\cc-A.log" -Tail 8 -Encoding UTF8 }
Write-Output '--- B log tail ---'
if (Test-Path "$repo\runs\logs\cc-B.log") { Get-Content "$repo\runs\logs\cc-B.log" -Tail 8 -Encoding UTF8 }
Write-Output '--- running drivers ---'
foreach ($d in @(Get-Drivers)) { Write-Output ("  PID " + $d.ProcessId + "  " + (("" + $d.CommandLine) -replace '.*cc-auto\.mjs','cc-auto.mjs')) }
