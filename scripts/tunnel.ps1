# tunnel.ps1 - keep an SSH port-forward to the laptop's Chrome debug port alive.
# Usage: powershell -File tunnel.ps1 -Port 9226
param(
  [Parameter(Mandatory = $true)][int]$Port
)

$Key = 'C:/Users/Administrator/.ssh/taskmesh_windows_laptop_ed25519'
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'

$listen = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listen) {
  Write-Output ("port $Port already forwarded (pid " + ($listen[0].OwningProcess) + ")")
  exit 0
}

$args = @(
  '-N',
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.10',
  '-o', 'UserKnownHostsFile=C:/Users/Administrator/.ssh/known_hosts',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=6',
  '-i', $Key,
  '-L', "$Port`:127.0.0.1:$Port",
  'WJX@192.168.1.8'
)
$proc = Start-Process -FilePath $ssh -ArgumentList $args -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
$ok = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($ok) { Write-Output ("port $Port tunnel OK (pid " + $proc.Id + ")") } else { Write-Output ("port $Port tunnel FAILED (pid " + $proc.Id + ")") }
