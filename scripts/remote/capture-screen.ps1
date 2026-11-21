# capture-screen.ps1 -- capture the REAL desktop, and it does so from the right session.
# Pure ASCII (PS 5.1 safe).
#
# WHY THIS IS NOT TRIVIAL
# -----------------------
# Everything started over SSH lives in Session 0 (the services session). From there:
#   - EnumWindows() only enumerates the CALLER's session -> Chrome's windows are
#     invisible even though they exist and CDP answers fine.
#   - Graphics.CopyFromScreen() captures Session 0's empty desktop -> a blank PNG.
#   - Process.MainWindowHandle comes back 0x0.
# So a screenshot taken from an SSH shell is worthless. This script detects that it is
# in the wrong session, re-launches HIMSELF through an Interactive scheduled task (which
# lands in the logged-on user's session), waits for the sentinel, and prints the report.
#
# Usage (from an SSH shell, it self-escalates to Session 1 automatically):
#   powershell -File capture-screen.ps1 -Tag first-login
#
# Output: <OutDir>\win-<Tag>.txt, screen-<Tag>.png, window-<Tag>-<n>.png

param(
  [string]$OutDir = 'E:\Desktop\NetClass\runs\shots',
  [string]$Tag = 'shot',
  [int]$Port = 9260,
  [int]$WaitSec = 45,
  [switch]$InSession
)

$ErrorActionPreference = 'Continue'
function Say($m) { Write-Output ('  ' + $m) }

# ------------------------------------------------------------ which session are we in
$consoleSession = 0
$expl = Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1
if ($expl) { $consoleSession = $expl.SessionId }
$mySession = (Get-Process -Id $PID).SessionId

# ------------------------------------------------------------ self-relaunch into it
if (-not $InSession -and $mySession -ne $consoleSession) {
  Write-Output ('===== SELF-RELAUNCH =====')
  Say ('running in session ' + $mySession + ', desktop is session ' + $consoleSession)
  Say 'handing off to an Interactive scheduled task'

  $selfPath = 'E:\Desktop\NetClass\scripts\capture-inner.ps1'
  New-Item -ItemType Directory -Force -Path (Split-Path $selfPath -Parent) | Out-Null
  Copy-Item -LiteralPath $PSCommandPath -Destination $selfPath -Force
  Say ('copied self -> ' + $selfPath)

  $reportPath = Join-Path $OutDir ('win-' + $Tag + '.txt')
  $donePath = Join-Path $OutDir ('done-' + $Tag + '.txt')
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Remove-Item $donePath -Force -ErrorAction SilentlyContinue
  Remove-Item $reportPath -Force -ErrorAction SilentlyContinue

  $taskName = 'NCSess1Shot-' + $Tag
  $argStr = '-NoProfile -ExecutionPolicy Bypass -File "' + $selfPath + '" -InSession -OutDir "' +
            $OutDir + '" -Tag "' + $Tag + '" -Port ' + $Port
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argStr
  $principal = New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(5))
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Say ('task ' + $taskName + ' registered, LogonType=Interactive')
  Start-ScheduledTask -TaskName $taskName

  $waited = 0
  while ($waited -lt $WaitSec -and -not (Test-Path $donePath)) {
    Start-Sleep -Milliseconds 700
    $waited += 0.7
  }
  Say ('waited ' + [math]::Round($waited,1) + 's')

  Write-Output ''
  Write-Output '===== SESSION 1 REPORT ====='
  if (Test-Path $reportPath) { Get-Content $reportPath -Encoding UTF8 | ForEach-Object { Write-Output $_ } }
  else { Say 'report missing -- the task probably did not reach the capture code' }

  Write-Output ''
  Write-Output '===== FILES ====='
  Get-ChildItem $OutDir -Filter ('*' + $Tag + '*') -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | ForEach-Object { Say ($_.Name + '  ' + $_.Length + ' B') }

  Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
    ForEach-Object { Say ('task state=' + $_.State) }
  exit 0
}

# ------------------------------------------------------------ real capture
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class SC {
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
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static List<object[]> All() {
    var res = new List<object[]>();
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.Length == 0) return true;
      int ex = GetWindowLong(h, -20);
      RECT r; GetWindowRect(h, out r);
      res.Add(new object[] { h, pid, sb.ToString(), (ex & 0x8) != 0, r.L, r.T, r.R - r.L, r.B - r.T });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@ -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$reportPath = Join-Path $OutDir ('win-' + $Tag + '.txt')
$donePath = Join-Path $OutDir ('done-' + $Tag + '.txt')
$lines = New-Object System.Collections.Generic.List[string]

$lines.Add('session=' + $mySession + '  desktopSession=' + $consoleSession + '  pid=' + $PID)
$lines.Add('now=' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$lines.Add('')

# CDP owner pid for the debug port
$cdpPid = 0
$conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { $cdpPid = [int]$conn.OwningProcess }
$lines.Add('cdpPort=' + $Port + '  cdpPid=' + $cdpPid)
$lines.Add('')

$lines.Add('--- visible top-level windows ---')
$wins = [SC]::All()
foreach ($w in $wins) {
  $lines.Add(('hwnd=0x{0:X} pid={1} topmost={2} rect={3},{4} {5}x{6} title={7}' -f
    ([int64]$w[0]), $w[1], $w[3], $w[4], $w[5], $w[6], $w[7], $w[2]))
}
$lines.Add('count=' + $wins.Count)

# ---- focus the Chrome window so the screenshot shows it, not whatever is on top
# Pick by AREA among the CDP process's own windows. Matching on title once selected
# Chrome's own "translate this page?" bubble (330x61) instead of the browser frame,
# which produced a 2.8 KB "screenshot" of the bubble.
$main = $null
$bestArea = 0
foreach ($w in $wins) {
  $isCdp = ($cdpPid -ne 0 -and [int]$w[1] -eq $cdpPid)
  $area = [int]$w[6] * [int]$w[7]
  if ($isCdp -and $area -gt $bestArea) { $main = $w; $bestArea = $area }
}
if (-not $main) {
  foreach ($w in $wins) {
    if (([string]$w[2]) -match 'Chrome') {
      $area = [int]$w[6] * [int]$w[7]
      if ($area -gt $bestArea) { $main = $w; $bestArea = $area }
    }
  }
}
if ($main) {
  $lines.Add('')
  $lines.Add('focusTarget hwnd=0x' + ([int64]$main[0]).ToString('X') + ' pid=' + $main[1] + ' title=' + $main[2])
  [SC]::ShowWindow([IntPtr][int64]$main[0], 9) | Out-Null
  [SC]::SetForegroundWindow([IntPtr][int64]$main[0]) | Out-Null
  Start-Sleep -Milliseconds 900
}

# ---- full virtual screen
try {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $full = Join-Path $OutDir ('screen-' + $Tag + '.png')
  $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $lines.Add('')
  $lines.Add('screen=' + $full + '  ' + (Get-Item $full).Length + ' B  ' + $b.Width + 'x' + $b.Height)
} catch {
  $lines.Add('screen capture FAILED: ' + $_.Exception.Message)
}

# ---- per-window PrintWindow for the chrome window (works even if occluded)
if ($main) {
  try {
    $h = [IntPtr][int64]$main[0]
    $wid = [int]$main[6]; $hei = [int]$main[7]
    if ($wid -gt 0 -and $hei -gt 0) {
      $wb = New-Object System.Drawing.Bitmap($wid, $hei)
      $wg = [System.Drawing.Graphics]::FromImage($wb)
      $hdc = $wg.GetHdc()
      [SC]::PrintWindow($h, $hdc, 2) | Out-Null   # PW_RENDERFULLCONTENT
      $wg.ReleaseHdc($hdc)
      $wf = Join-Path $OutDir ('window-' + $Tag + '.png')
      $wb.Save($wf, [System.Drawing.Imaging.ImageFormat]::Png)
      $wg.Dispose(); $wb.Dispose()
      $lines.Add('window=' + $wf + '  ' + (Get-Item $wf).Length + ' B')
    }
  } catch { $lines.Add('PrintWindow FAILED: ' + $_.Exception.Message) }
}

if ($conn) { $lines.Add('') }
$lines.Add('')
$lines.Add('--- chrome processes ---')
Get-Process chrome -ErrorAction SilentlyContinue | Sort-Object Id | ForEach-Object {
  $lines.Add('pid=' + $_.Id + ' session=' + $_.SessionId + ' hwnd=0x' + $_.MainWindowHandle.ToString('X') + ' title=' + $_.MainWindowTitle)
}

Set-Content -Path $reportPath -Value ($lines -join "`r`n") -Encoding UTF8
Set-Content -Path $donePath -Value ('done ' + (Get-Date -Format s)) -Encoding ASCII
Write-Output 'capture complete'
