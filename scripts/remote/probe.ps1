# probe.ps1 -- environment survey of the lab laptop. Pure ASCII (PS 5.1 safe).
# Shipped & run by scripts/ssh-exec.ps1 -File scripts/remote/probe.ps1

$ErrorActionPreference = 'Continue'
function H($t) { Write-Output ''; Write-Output ('===== ' + $t + ' =====') }

H 'IDENTITY'
Write-Output ("host   = " + $env:COMPUTERNAME)
Write-Output ("user   = " + $env:USERNAME)
Write-Output ("psver  = " + $PSVersionTable.PSVersion)
Write-Output ("now    = " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

H 'DRIVES'
Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  Write-Output ("{0}: free={1}GB used={2}GB" -f $_.Name,
    [math]::Round($_.Free/1GB,1), [math]::Round($_.Used/1GB,1))
}

H 'TARGET FOLDER E:\Desktop\NetClass'
$NEW = 'E:\Desktop\NetClass'
if (Test-Path $NEW) {
  Write-Output 'exists=YES'
  $items = @(Get-ChildItem $NEW -Force -ErrorAction SilentlyContinue)
  Write-Output ("entries=" + $items.Count)
  if ($items.Count -gt 0) {
    foreach ($i in $items) { Write-Output ("  " + $i.Mode + "  " + $i.Name) }
  } else {
    Write-Output '  (EMPTY)'
  }
} else {
  Write-Output 'exists=NO'
}
$eDesktop = 'E:\Desktop'
if (Test-Path $eDesktop) {
  Write-Output ('E:\Desktop entries=' + @(Get-ChildItem $eDesktop -Force -EA SilentlyContinue).Count)
} else {
  Write-Output 'E:\Desktop does not exist'
}

H 'OLD ROOT'
$OLD = 'C:\Users\WJX\AppData\Local\TaskMesh\netclass'
if (Test-Path $OLD) {
  Write-Output ('exists=YES path=' + $OLD)
  foreach ($sub in @('app','orders','logs','shots','instances')) {
    $p = Join-Path $OLD $sub
    if (Test-Path $p) {
      $n = @(Get-ChildItem $p -Recurse -File -Force -EA SilentlyContinue).Count
      $sz = [math]::Round((@(Get-ChildItem $p -Recurse -File -Force -EA SilentlyContinue) |
        Measure-Object Length -Sum).Sum / 1MB, 1)
      Write-Output ("  " + $sub.PadRight(12) + " files=" + $n + "  " + $sz + " MB")
    } else {
      Write-Output ("  " + $sub.PadRight(12) + " MISSING")
    }
  }
  $tot = @(Get-ChildItem $OLD -Recurse -File -Force -EA SilentlyContinue)
  Write-Output ("  TOTAL files=" + $tot.Count + "  " + [math]::Round(($tot | Measure-Object Length -Sum).Sum/1MB,1) + " MB")
} else {
  Write-Output 'exists=NO'
}

H 'APP PAYLOAD'
$APP = Join-Path $OLD 'app'
if (Test-Path $APP) {
  foreach ($f in @('launch.mjs','package.json','node_modules','dist','inject')) {
    $p = Join-Path $APP $f
    Write-Output ("  " + $f.PadRight(14) + $(if (Test-Path $p) { 'OK' } else { 'MISSING' }))
  }
  foreach ($f in @('launch.mjs','package.json')) {
    $p = Join-Path $APP $f
    if (Test-Path $p) {
      Write-Output ("  -- " + $f + " modified " + (Get-Item $p).LastWriteTime)
    }
  }
}

H 'ORDERS ALREADY RECORDED'
$ord = Join-Path $OLD 'orders'
if (Test-Path $ord) {
  $o = @(Get-ChildItem $ord -Force -EA SilentlyContinue)
  Write-Output ('count=' + $o.Count)
  foreach ($i in $o) { Write-Output ("  " + $i.Name) }
}

H 'NODE'
$node = Get-Command node -EA SilentlyContinue
if ($node) {
  Write-Output ('node   = ' + $node.Source)
  Write-Output ('version= ' + (& node --version 2>&1))
} else {
  Write-Output 'node NOT on PATH'
}
$pnpm = Get-Command pnpm -EA SilentlyContinue
if ($pnpm) { Write-Output ('pnpm   = ' + (& pnpm --version 2>&1)) } else { Write-Output 'pnpm NOT on PATH' }

H 'CHROME'
$chromePaths = @(
  'C:\Program Files\Google\Chrome for Testing\chrome.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
foreach ($c in $chromePaths) { Write-Output ($(if (Test-Path $c) { 'FOUND ' } else { '      ' }) + $c) }
$cft = Get-ChildItem 'C:\Program Files\Google' -Filter 'chrome.exe' -Recurse -EA SilentlyContinue |
  Select-Object -First 5
foreach ($c in $cft) { Write-Output ('  v: ' + $c.FullName + '  ' + $c.VersionInfo.ProductVersion) }
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
Write-Output ($(if (Test-Path $edge) { 'FOUND ' } else { '      ' }) + $edge)

H 'PROCESSES'
foreach ($n in @('chrome','msedge','node','pwsh','powershell')) {
  $p = @(Get-Process $n -EA SilentlyContinue)
  Write-Output ($n.PadRight(12) + ' count=' + $p.Count)
}

H 'LISTENING PORTS (interesting)'
Get-NetTCPConnection -State Listen -EA SilentlyContinue |
  Where-Object { $_.LocalPort -in 22,17800,9222,9224,9227,9228,9229,9230,9231,9250,9333,9444 } |
  Select-Object LocalAddress,LocalPort,OwningProcess |
  Sort-Object LocalPort | ForEach-Object {
    $pn = (Get-Process -Id $_.OwningProcess -EA SilentlyContinue).ProcessName
    Write-Output ("  " + $_.LocalAddress.PadRight(16) + ':' + ([string]$_.LocalPort).PadRight(6) + ' pid=' + $_.OwningProcess + ' (' + $pn + ')')
  }

H 'NETCLASS SERVICE 17800'
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:17800/' -UseBasicParsing -TimeoutSec 5 -EA Stop
  Write-Output ('status=' + $r.StatusCode + ' len=' + $r.RawContentLength)
  Write-Output ('ctype =' + $r.Headers['Content-Type'])
  $snip = $r.Content
  if ($snip.Length -gt 300) { $snip = $snip.Substring(0,300) }
  Write-Output ('body  =' + ($snip -replace "`r?`n",' '))
} catch {
  Write-Output ('FAIL ' + $_.Exception.Message)
}
foreach ($p in @('/health','/status','/api/status')) {
  try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:17800' + $p) -UseBasicParsing -TimeoutSec 4 -EA Stop
    Write-Output ('  ' + $p + ' -> ' + $r.StatusCode + ' ' + $r.Content.Length + 'b')
  } catch {
    Write-Output ('  ' + $p + ' -> ' + $_.Exception.Message.Split([char]10)[0])
  }
}

H 'SCHEDULED TASKS (netclass / huayi / shot / untop)'
Get-ScheduledTask -EA SilentlyContinue |
  Where-Object { $_.TaskName -match 'huayi|netclass|shot|untop|diagtop|scrwin|launch' } |
  ForEach-Object {
    $inf = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath -EA SilentlyContinue
    Write-Output ("  " + $_.TaskPath + $_.TaskName + '  state=' + $_.State + '  last=' + $inf.LastRunTime + '  rc=' + $inf.LastTaskResult)
  }

H 'FIREWALL (port 22)'
Get-NetFirewallRule -DisplayName 'OpenSSH*' -EA SilentlyContinue |
  ForEach-Object {
    $af = $_ | Get-NetFirewallPortFilter -EA SilentlyContinue
    Write-Output ("  " + $_.DisplayName + ' enabled=' + $_.Enabled + ' profile=' + $_.Profile + ' action=' + $_.Action + ' port=' + $af.LocalPort)
  }
Write-Output ('network category: ' + ((Get-NetConnectionProfile -EA SilentlyContinue |
  ForEach-Object { $_.Name + '=' + $_.NetworkCategory }) -join '; '))

H 'END'
