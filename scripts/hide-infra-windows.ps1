# hide-infra-windows.ps1 — 隐藏"基础设施进程"的可见控制台窗口
#
# 背景：用户在本机打游戏，要求**不要弹窗**。
# 已知来源：计划任务 `TaskMesh Hub`（动作是 pythonw.exe）拉起的 **node 子进程会自建控制台窗口**，
#   标题形如 `C:\Coding\node\node.exe` —— 每次任务触发就冒一个。
#   （本脚本自身起的进程都走了隐藏路径；这个是别人的任务，改它不如"定期把窗口收掉"来得稳。）
#
# 做法：按**命令行特征**（不是窗口标题，标题太容易误伤）找到目标进程 → ShowWindow(SW_HIDE)。
# 用法：powershell -NoProfile -File scripts\hide-infra-windows.ps1

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NcHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@

# 命令行里含这些片段的进程，若有可见窗口就隐藏
$patterns = @(
  'TaskMesh\\hub\\versions',      # TaskMesh Hub（node 子进程）
  'desktop-hub-'
)

$hidden = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $cl = [string]$_.CommandLine
  $hit = $false
  foreach ($p in $patterns) { if ($cl -like "*$p*") { $hit = $true; break } }
  if (-not $hit) { return }
  $proc = Get-Process -Id $_.ProcessId
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    [void][NcHide]::ShowWindow($proc.MainWindowHandle, 0)   # 0 = SW_HIDE
    $hidden++
    Write-Output ("hidden pid=" + $_.ProcessId)
  }
}
if ($hidden -eq 0) { Write-Output 'nothing-to-hide' }
