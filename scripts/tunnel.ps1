# tunnel.ps1 — 把笔记本上的 Chrome 调试端口转发到本机，并保持存活。
#
# 用法:
#   powershell -File scripts/tunnel.ps1 -Port 9228
#   pwsh -NoProfile -File scripts/tunnel.ps1 -Port 9230
#
# ★ 2026-10-20 重写：SSH 参数从 config/local.json 读取（去个人化后不再硬编码主机/私钥）。
#   之前的版本把主机/私钥/known_hosts 写死在脚本里，别人 clone 下来直接连不上。

param(
  [Parameter(Mandatory = $true)][int]$Port
)

$ErrorActionPreference = 'Stop'

# ── 读本机配置 ────────────────────────────────────
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LocalCfg = $null
$LocalPath = Join-Path $RepoRoot 'config/local.json'
if (Test-Path $LocalPath) {
  try { $LocalCfg = Get-Content $LocalPath -Raw | ConvertFrom-Json } catch { }
}

$SshTarget = if ($LocalCfg -and $LocalCfg.ssh.target) { $LocalCfg.ssh.target } else { $env:NC_SSH_TARGET }
if ([string]::IsNullOrWhiteSpace($SshTarget)) {
  Write-Output "port $Port tunnel FAILED: 没有 SSH 目标（请先跑 scripts/install.ps1 生成 config/local.json，或设 NC_SSH_TARGET）"
  exit 1
}
$SshHost  = ($SshTarget -split '@')[-1]
$SshUser  = ($SshTarget -split '@')[0]
$SshKey   = if ($LocalCfg -and $LocalCfg.ssh.keyPath) { $LocalCfg.ssh.keyPath } else { (Join-Path $env:USERPROFILE '.ssh/id_ed25519') }
$SshAlias = if ($LocalCfg -and $LocalCfg.ssh.hostKeyAlias) { $LocalCfg.ssh.hostKeyAlias } else { $SshHost }
$SshKnown = if ($LocalCfg -and $LocalCfg.ssh.knownHostsFile) { $LocalCfg.ssh.knownHostsFile } else { (Join-Path $env:USERPROFILE '.ssh/known_hosts') }

if (-not (Test-Path $SshKey)) {
  Write-Output "port $Port tunnel FAILED: 私钥不存在 $SshKey"
  exit 1
}

$SshExe = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path $SshExe)) { $SshExe = 'ssh' }

# ── 已经通了就别重复建 ────────────────────────────
$listen = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listen) {
  Write-Output ("port $Port already forwarded (pid " + ($listen[0].OwningProcess) + ")")
  exit 0
}

# ── 起 ssh -N -L ──────────────────────────────────
$sshArgs = @(
  '-N',
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey',
  '-o', 'ConnectTimeout=8',
  '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', "HostKeyAlias=$SshAlias",
  '-o', "UserKnownHostsFile=$SshKnown",
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=10',
  '-o', 'ServerAliveCountMax=6',
  '-i', $SshKey,
  '-L', "${Port}:127.0.0.1:${Port}",
  $SshTarget
)

$proc = Start-Process -FilePath $SshExe -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

# ── 验证 ──────────────────────────────────────────
$ok = $false
for ($i = 0; $i -lt 5; $i++) {
  Start-Sleep -Milliseconds 800
  $l = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($l) { $ok = $true; break }
  if ($proc.HasExited) { break }
}

if ($ok) {
  Write-Output ("port $Port tunnel OK (pid " + $proc.Id + ")")
  exit 0
} else {
  if (-not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { } }
  Write-Output ("port $Port tunnel FAILED (pid " + $proc.Id + ") —— 检查: ssh " + $SshTarget + " 是否可免密登录")
  exit 1
}
