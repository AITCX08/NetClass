<#
  lap.ps1 — 在笔记本上执行一段本地 PowerShell 脚本（分块传输，规避引号/长度/编码问题）
  用法：
    .\lap.ps1 -File .\remote\some.ps1                # 上传并执行
    .\lap.ps1 -Code "Get-Date; hostname"            # 直接给代码
  说明：脚本在笔记本上以 $env:TEMP\nc-run.ps1 落地后执行，stdout/stderr 原样回传。
#>
param(
  [string]$File,
  [string]$Code,
  [switch]$DebugInfo
)
$ErrorActionPreference = 'Continue'
if ($DebugInfo) {
  Write-Host ("file='" + $File + "' codeLen=" + ($(if ($Code) { $Code.Length } else { 0 })))
}
$Key = 'C:/Users/YOURNAME/.ssh/id_ed25519'
$SshOpts = @(
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.100',
  '-o', 'UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts',
  '-i', $Key, 'user@host'
)
$Ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'

if ($File) {
  if (-not (Test-Path -LiteralPath $File)) { throw "no such file: $File" }
  $Code = Get-Content -LiteralPath $File -Raw
}
if (-not $Code) { throw 'need -File or -Code' }

# PowerShell 需要 UTF-16LE 的 base64，才能正确解析中文
$bytes = [Text.Encoding]::Unicode.GetBytes($Code)
$b64 = [Convert]::ToBase64String($bytes)
$chunk = 1200
$winTmp = "$env:TEMP\nc-chunks.txt"
$winWin = 'C:\Users\YOURNAME\AppData\Local\Temp\nc-chunks.txt'
$winExe = 'C:\Users\YOURNAME\AppData\Local\Temp\nc-run.ps1'

function RemotePs([string]$c) {
  $b = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($c))
  & $Ssh @SshOpts "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $b" 2>&1
}

RemotePs "[IO.File]::WriteAllText('$winWin','')" | Out-Null
for ($i = 0; $i -lt $b64.Length; $i += $chunk) {
  $part = $b64.Substring($i, [Math]::Min($chunk, $b64.Length - $i))
  RemotePs "[IO.File]::AppendAllText('$winWin','$part')" | Out-Null
}
RemotePs @"
`$b = (Get-Content -LiteralPath '$winWin' -Raw) -replace '\s',''
`$code = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(`$b))
[IO.File]::WriteAllText('$winExe', `$code, (New-Object Text.UTF8Encoding(`$false)))
`$OutputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
& powershell -NoProfile -ExecutionPolicy Bypass -File '$winExe'
"@
