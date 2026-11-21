# migrate-root.ps1 -- control-side driver (runs on THIS machine)
#
# Ships scripts/remote/migrate-root.ps1 to the lab laptop, runs it there, then
# (with -Apply) rewrites config/local.json so every other script follows the new root.
#
# Usage:
#   pwsh -NoProfile -File scripts/migrate-root.ps1                    # dry run on laptop
#   pwsh -NoProfile -File scripts/migrate-root.ps1 -Go                # real copy
#   pwsh -NoProfile -File scripts/migrate-root.ps1 -Go -Apply         # copy + flip config
#   pwsh -NoProfile -File scripts/migrate-root.ps1 -Go -IncludeInstances
#
# Pure ASCII on purpose: the shipped helper must survive PS 5.1 ANSI parsing.

param(
  [string]$NewRoot = 'E:/Desktop/NetClass',
  [switch]$Go,
  [switch]$Apply,
  [switch]$IncludeInstances
)

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Output ("[driver] " + $m) }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LocalPath = Join-Path $RepoRoot 'config/local.json'
if (-not (Test-Path $LocalPath)) { Say "FAIL: config/local.json missing"; exit 1 }
$cfg = Get-Content $LocalPath -Raw | ConvertFrom-Json

$SshTarget = $cfg.ssh.target
$SshHost = ($SshTarget -split '@')[-1]
$SshKey = $cfg.ssh.keyPath
$SshAlias = $cfg.ssh.hostKeyAlias
$SshKnown = $cfg.ssh.knownHostsFile
$OldRoot = $cfg.browser.remoteRoot

$SshExe = Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe'
if (-not (Test-Path $SshExe)) { $SshExe = 'ssh' }
$ScpExe = Join-Path $env:WINDIR 'System32/OpenSSH/scp.exe'
if (-not (Test-Path $ScpExe)) { $ScpExe = 'scp' }

$CommonOpts = @(
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey',
  '-o', 'ConnectTimeout=8',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', "HostKeyAlias=$SshAlias",
  '-o', "UserKnownHostsFile=$SshKnown",
  '-i', $SshKey
)

Say ("target = " + $SshTarget + "   old = " + $OldRoot + "   new = " + $NewRoot)

# ---- 1. connectivity ------------------------------------------------------
& $SshExe @CommonOpts $SshTarget 'echo SSH_OK' 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
if ($LASTEXITCODE -ne 0) { Say "FAIL: ssh not reachable"; exit 1 }

# ---- 2. ship helper -------------------------------------------------------
$helper = Join-Path $RepoRoot 'scripts/remote/migrate-root.ps1'
if (-not (Test-Path $helper)) { Say "FAIL: helper missing $helper"; exit 1 }

# byte sanity: any >127 means the laptop's PS 5.1 may mangle it
$bytes = [System.IO.File]::ReadAllBytes($helper)
$bad = @($bytes | Where-Object { $_ -gt 127 }).Count
Say ("helper bytes = " + $bytes.Length + "  non-ascii = " + $bad)
if ($bad -gt 0) { Say "FAIL: helper is not pure ASCII"; exit 1 }

$remoteTmp = 'C:/Users/' + ($SshTarget -split '@')[0] + '/AppData/Local/Temp/migrate-root.ps1'
& $ScpExe @CommonOpts $helper ($SshTarget + ':' + $remoteTmp) 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
if ($LASTEXITCODE -ne 0) { Say "FAIL: scp failed"; exit 1 }
Say ("shipped -> " + $remoteTmp)

# ---- 3. run ---------------------------------------------------------------
$flag = if ($Go) { '' } else { ' -DryRun' }
if ($IncludeInstances) { $flag += ' -IncludeInstances' }
$remoteCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $remoteTmp + '" -OldRoot "' +
             $OldRoot + '" -NewRoot "' + $NewRoot + '"' + $flag + '; echo REMOTE_EXIT=$LASTEXITCODE'

& $SshExe @CommonOpts $SshTarget $remoteCmd 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
$remoteOk = ($LASTEXITCODE -eq 0)

if (-not $remoteOk) { Say "FAIL: remote migrate exited non-zero"; exit 1 }

# ---- 4. flip config -------------------------------------------------------
if ($Apply) {
  if (-not $Go) { Say "REFUSE: -Apply requires -Go (dry run does not move anything)"; exit 1 }
  $raw = Get-Content $LocalPath -Raw
  $raw = $raw -replace '("remoteRoot"\s*:\s*")[^"]*(")', ('${1}' + $NewRoot + '${2}')
  Set-Content -Path $LocalPath -Value $raw -Encoding UTF8
  $back = (Get-Content $LocalPath -Raw | ConvertFrom-Json).browser.remoteRoot
  Say ("config remoteRoot = " + $back)
  if ($back -ne $NewRoot) { Say "FAIL: config not updated"; exit 1 }
  Say "OK -- now restart the netclass service so it picks up the new root"
} else {
  Say "config unchanged (pass -Apply to switch remoteRoot)"
}

Say "DONE"
