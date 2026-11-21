# launch-visible-chrome.ps1 -- start a REAL, VISIBLE Chrome window on the laptop's desktop.
# Pure ASCII (PS 5.1 safe). Idempotent: kills a previous instance on the same port first.
#
# Two hard-won constraints baked in:
#
#   1) SESSION. An SSH-launched process belongs to Session 0 (services). Chrome started
#      there runs fine and CDP answers, but the window exists on no desktop the user can
#      see -- EnumWindows returns nothing. Fix: run it from a scheduled task whose
#      principal is LogonType=Interactive, i.e. "run only when user is logged on".
#      That lands the process in the user's Session 1.
#
#   2) TOPMOST. A previous revision did SetWindowPos(HWND_TOPMOST) to make sure the
#      window showed up. Result: the window covered everything and could not be clicked
#      away -- only minimise/close worked. Never set TOPMOST. This script asserts the
#      window is NOT topmost and reports the flags it observed.
#
# Usage:
#   powershell -File launch-visible-chrome.ps1 -Port 9260
#   powershell -File launch-visible-chrome.ps1 -Port 9260 -Kill      # only tear down

param(
  [int]$Port = 9260,
  [string]$ProfileDir = 'E:\Desktop\NetClass\instances\smartedu',
  [string]$Url = 'https://basic.smartedu.cn/',
  [string]$Chrome = 'C:\Users\WJX\AppData\Local\NetClass\browser\137.0.7151.55\chrome-win64\chrome.exe',
  [string]$TaskName = 'NCVis-smartedu',
  [int]$Width = 1600,
  [int]$Height = 940,
  [int]$X = 0,
  [int]$Y = 0,
  [switch]$Kill,
  [switch]$NoForeground
)

$ErrorActionPreference = 'Continue'
function Sect($t) { Write-Output ''; Write-Output ('===== ' + $t + ' =====') }
function Say($m) { Write-Output ('  ' + $m) }

function Get-CdpVersion([int]$p) {
  try {
    return Invoke-RestMethod -Uri ('http://127.0.0.1:' + $p + '/json/version') -TimeoutSec 4 -ErrorAction Stop
  } catch { return $null }
}

# ------------------------------------------------------------------ teardown
function Stop-Instance {
  $v = Get-CdpVersion $Port
  if (-not $v) { Say ('port ' + $Port + ' has no CDP -- nothing to stop'); return }
  Say ('stopping CDP instance on ' + $Port)
  # kill only the process that owns the listening socket, then its children by profile path
  $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($conn) {
    foreach ($c in $conn) {
      $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -match 'chrome|msedge') {
        Say ('taskkill /T /F ' + $proc.Id + ' (' + $proc.ProcessName + ')')
        & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null
      }
    }
  }
  # sweep leftovers that carry this exact profile
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $ProfileDir + '*') } |
    ForEach-Object { Say ('sweep pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Kill) {
  Sect 'KILL'
  Stop-Instance
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Say 'task stopped' }
  Say 'done'
  exit 0
}

Sect 'PRECHECK'
Say ('chrome  = ' + $Chrome + '  exists=' + (Test-Path $Chrome))
if (-not (Test-Path $Chrome)) { Say 'FAIL: chrome.exe missing'; exit 1 }
Say ('profile = ' + $ProfileDir)
Say ('url     = ' + $Url)
Say ('port    = ' + $Port)
$sess = (Get-Process -Id $PID).SessionId
Say ('session = ' + $sess + '  (this process; Chrome must NOT inherit Session 0)')

Sect 'TEARDOWN PREVIOUS'
Stop-Instance
Start-Sleep -Milliseconds 600

Sect 'PROFILE'
if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null; Say ('created ' + $ProfileDir) }
else { Say 'exists' }
# a stale SingletonLock from a hard kill makes the next launch silently exit
foreach ($lock in @('SingletonLock','SingletonCookie','SingletonSocket')) {
  $p = Join-Path $ProfileDir $lock
  if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue; Say ('removed ' + $lock) }
}

Sect 'BUILD ARGS'
$flags = @(
  ('--remote-debugging-port=' + $Port),
  ('--user-data-dir=' + $ProfileDir),
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
  '--disable-popup-blocking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-breakpad',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,TranslateUI',
  ('--window-size=' + $Width + ',' + $Height),
  ('--window-position=' + $X + ',' + $Y)
)
$argStr = ($flags | ForEach-Object { '"' + $_ + '"' }) -join ' '
Say $argStr

Sect 'REGISTER INTERACTIVE TASK'
$action = New-ScheduledTaskAction -Execute $Chrome -Argument ($argStr + ' "' + $Url + '"')
$userId = $env:COMPUTERNAME + '\' + $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$registered = $false
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  $registered = $true
  Say ('task ' + $TaskName + ' registered via Register-ScheduledTask, LogonType=Interactive, user=' + $userId)
} catch {
  Say ('Register-ScheduledTask failed: ' + $_.Exception.Message)
  Say 'falling back to schtasks /create /it'
  & schtasks /create /tn $TaskName /tr ('"' + $Chrome + '" ' + $argStr + ' "' + $Url + '"') /sc once /st 00:00 /it /f 2>&1 | ForEach-Object { Say $_ }
  if ($LASTEXITCODE -eq 0) { $registered = $true; Say 'task registered via schtasks /it' }
}
if (-not $registered) { Say 'FAIL: could not register the interactive task'; exit 1 }
Get-ScheduledTask -TaskName $TaskName | ForEach-Object {
  Say ('  principal=' + $_.Principal.UserId + ' logon=' + $_.Principal.LogonType + ' run=' + $_.Principal.RunLevel)
}

Sect 'START'
if ($registered -and (Get-Command Start-ScheduledTask -ErrorAction SilentlyContinue)) {
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { & schtasks /run /tn $TaskName 2>&1 | Out-Null }
} else {
  & schtasks /run /tn $TaskName 2>&1 | Out-Null
}

$v = $null
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 800
  $v = Get-CdpVersion $Port
  if ($v) { break }
}
if (-not $v) {
  Say ('FAIL: no CDP on ' + $Port + ' after 20s')
  Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue |
    ForEach-Object { Say ('  lastResult=' + $_.LastTaskResult) }
  exit 1
}
Say ('CDP up: ' + $v.Browser)

Sect 'WINDOW STATE'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static List<string> Rows(uint wantPid) {
    var res = new List<string>();
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != wantPid) return true;
      int len = GetWindowTextLength(h);
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      int ex = GetWindowLong(h, -20);
      bool topmost = (ex & 0x8) != 0;
      RECT r; GetWindowRect(h, out r);
      res.Add(string.Format("hwnd=0x{0:X} vis={1} topmost={2} rect={3},{4} {5}x{6} title={7}",
        h.ToInt64(), IsWindowVisible(h), topmost, r.L, r.T, r.R-r.L, r.B-r.T, sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return res;
  }
  public static IntPtr FindMain(uint wantPid, string contains) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != wantPid) return true;
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      if (contains == "" || sb.ToString().Contains(contains)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@ -ErrorAction SilentlyContinue

$mainPid = $null
$conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { $mainPid = [uint32]$conn.OwningProcess }
if (-not $mainPid) {
  Say 'could not resolve the CDP owner pid from the listening socket'
  Say '=> window placement cannot be inspected; use the browser tab list below'
  $rows = @()
} else {
  Say ('CDP owner pid = ' + $mainPid + '  session=' + (Get-Process -Id $mainPid -ErrorAction SilentlyContinue).SessionId)
  $rows = [W]::Rows($mainPid)
}
if ($rows.Count -eq 0) {
  Say 'NO VISIBLE WINDOW for the CDP process'
  Say '=> the process probably landed in Session 0 again; check the task principal'
} else {
  foreach ($r in $rows) { Say $r }
}

$topmostCount = 0
foreach ($r in $rows) { if ($r -like '*topmost=True*') { $topmostCount++ } }
if ($topmostCount -gt 0) {
  Say ('WARN: ' + $topmostCount + ' window(s) are TOPMOST -- will un-pin')
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class T { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }' -ErrorAction SilentlyContinue
  foreach ($r in $rows) {
    if ($r -match 'topmost=True') {
      $hv = [Convert]::ToInt64((($r -split 'hwnd=0x')[1] -split ' ')[0], 16)
      [T]::SetWindowPos([IntPtr]$hv, [IntPtr](-2), 0, 0, 0, 0, (0x0001 -bor 0x0002)) | Out-Null
    }
  }
  Start-Sleep -Milliseconds 150
  foreach ($r in [W]::Rows($mainPid)) { Say ('after: ' + $r) }
} else {
  Say 'OK: no topmost window'
}

if (-not $NoForeground -and $mainPid) {
  $hwnd = [W]::FindMain($mainPid, '')
  if ($hwnd -ne [IntPtr]::Zero) {
    [W]::ShowWindow($hwnd, 9) | Out-Null      # SW_RESTORE
    [W]::SetForegroundWindow($hwnd) | Out-Null
    Say 'brought to foreground'
  } else { Say 'no main window handle to foreground' }
}

Sect 'TARGETS'
try {
  $list = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/json/list') -TimeoutSec 6
  $list | Where-Object { $_.type -eq 'page' } | ForEach-Object { Say ($_.title + '  |  ' + $_.url) }
} catch { Say ('list ERR ' + $_.Exception.Message) }

Sect 'DONE'
