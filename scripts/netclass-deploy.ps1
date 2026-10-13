<#
  netclass-deploy.ps1 — 从 PC 侧部署/更新笔记本上的 NetClass 组件
  用法：
    .\netclass-deploy.ps1 -Action push         # 上传 server.ps1 / App.js / 壳脚本
    .\netclass-deploy.ps1 -Action start        # 在笔记本上启动本机模块服务（17800）
    .\netclass-deploy.ps1 -Action stop         # 停止模块服务
    .\netclass-deploy.ps1 -Action status       # 查看服务与文件状态
    .\netclass-deploy.ps1 -Action shell        # 打印壳脚本的本地安装地址
  依赖：C:\Users\Administrator\.ssh\taskmesh_windows_laptop_ed25519（既有 SSH 身份）
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('push', 'start', 'stop', 'status', 'shell', 'logs')][string]$Action,
  [string]$Repo = ''
)
if (-not $Repo) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
  $Repo = (Resolve-Path (Join-Path $here '..')).Path
}
Write-Host ("repo = " + $Repo)

$LaptopHost = '192.168.1.8'
$LaptopUser = 'WJX'
$Key = 'C:/Users/Administrator/.ssh/taskmesh_windows_laptop_ed25519'
$SshOpts = @(
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.10',
  '-o', 'UserKnownHostsFile=C:/Users/Administrator/.ssh/known_hosts',
  '-i', $Key
)
$RemoteRoot = 'C:\Users\WJX\AppData\Local\TaskMesh\netclass'
$Ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$Scp = 'C:\Windows\System32\OpenSSH\scp.exe'

function Invoke-RemotePs([string]$Code) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
  & $Ssh @SshOpts "$LaptopUser@$LaptopHost" "powershell -NoProfile -EncodedCommand $b64"
}

switch ($Action) {
  'push' {
    $pairs = @(
      "$Repo\scripts\netclass-server.ps1|$RemoteRoot\server.ps1",
      "$Repo\userscript\App.js|$RemoteRoot\App.js",
      "$Repo\userscript\netclass.shell.user.js|$RemoteRoot\netclass.user.js"
    )
    Invoke-RemotePs "New-Item -ItemType Directory -Force -Path '$RemoteRoot','$RemoteRoot\logs' | Out-Null; 'ok'"
    foreach ($pair in $pairs) {
      $local = $pair.Split('|')[0]
      $remote = $pair.Split('|')[1]
      if (-not (Test-Path -LiteralPath $local)) { Write-Warning ("missing local file: " + $local); continue }
      $tmp = '/C:/Users/WJX/AppData/Local/Temp/netclass-' + [IO.Path]::GetFileName($remote)
      & $Scp @SshOpts $local "$LaptopUser@$LaptopHost`:$tmp" | Out-Null
      $tmpWin = $tmp -replace '^/C:', 'C:'
      Invoke-RemotePs "Move-Item -Force -LiteralPath '$tmpWin' -Destination '$remote'; 'moved'"
      Write-Host ("uploaded -> " + $remote)
    }
    Invoke-RemotePs "Get-ChildItem '$RemoteRoot' -File | Select-Object Name,Length | Format-Table -AutoSize | Out-String"
  }
  'start' {
    Invoke-RemotePs @"
`$root = '$RemoteRoot'
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { `$_.CommandLine -like '*netclass*server.ps1*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path `$root 'server.ps1')) -WindowStyle Hidden
Start-Sleep -Seconds 2
try { `$r = Invoke-WebRequest 'http://127.0.0.1:17800/ping' -UseBasicParsing -TimeoutSec 5; Write-Output ('ping -> ' + `$r.Content) } catch { Write-Output ('ping ERR ' + `$_.Exception.Message) }
"@
  }
  'stop' {
    Invoke-RemotePs @"
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { `$_.CommandLine -like '*netclass*server.ps1*' } | ForEach-Object { Write-Output ("stop pid " + `$_.ProcessId); Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
"@
  }
  'status' {
    Invoke-RemotePs @"
`$root = '$RemoteRoot'
Write-Output "== files =="
if (Test-Path `$root) { Get-ChildItem `$root -Recurse -File | Select-Object FullName,Length,LastWriteTime | Format-Table -AutoSize | Out-String } else { 'not deployed' }
Write-Output "== service =="
`$p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { `$_.CommandLine -like '*netclass*server.ps1*' }
if (`$p) { `$p | Select-Object ProcessId,CreationDate | Format-Table -AutoSize | Out-String } else { 'service not running' }
try { `$r = Invoke-WebRequest 'http://127.0.0.1:17800/ping' -UseBasicParsing -TimeoutSec 4; Write-Output ('ping -> ' + `$r.Content) } catch { Write-Output 'ping -> no response' }
try { `$a = Invoke-WebRequest 'http://127.0.0.1:17800/App.js' -UseBasicParsing -TimeoutSec 6; Write-Output ('App.js -> ' + `$a.Content.Length + ' bytes') } catch { Write-Output 'App.js -> unavailable' }
"@
  }
  'logs' {
    Invoke-RemotePs @"
`$root = '$RemoteRoot'
foreach(`$f in @('logs\serve.log','logs\ingest.jsonl')){
  `$p = Join-Path `$root `$f
  Write-Output ("===== " + `$f + " =====")
  if(Test-Path `$p){ Get-Content `$p -Tail 40 } else { '(none)' }
}
"@
  }
  'shell' {
    Write-Host '壳脚本路径：' "$Repo\userscript\netclass.shell.user.js"
    Write-Host '本地服务地址：http://127.0.0.1:17800/App.js'
  }
}
