# ssh-exec.ps1 -- run PowerShell on the lab laptop without quoting, length, or encoding limits.
#
# Two modes:
#
#   -Command "<short ps>"
#       Inline via -EncodedCommand. Keep under ~2500 chars: base64(UTF-16LE) inflates
#       2.67x and cmd.exe rejects lines over 8191 bytes.
#
#   -File <local .ps1> [-Arg '<ps statement>' ...]
#       Shimmed via scp, then run with `powershell -File`. The script body is merged
#       with the -Arg statements written to a UTF-8-BOM file.
#
# WHY -Arg IS NOT PASSED AS COMMAND-LINE FLAGS
# --------------------------------------------
# `ssh host powershell ... "-Port" "9260"` goes through cmd.exe, which eats the inner
# double quotes. PowerShell then receives `'-Port','9260'` as one literal string and
# parameter binding dies with "cannot convert System.Object[] to Int32".
# So: never put arguments on the wire. -Arg takes full statements (`'$Port = 9260'`),
# which are written into the script text after removing its param() block.
#
# ENCODING
# --------
# PS 5.1 parses a .ps1 as ANSI unless the file carries a UTF-8 BOM. Every shim is
# written WITH a BOM, so CJK in arguments survives. Remote stdout is switched to UTF-8
# too, otherwise the laptop emits OEM codepage 936 and the control side reads mojibake.
#
# Reads SSH settings from config/local.json (single source of truth).

param(
  [string]$Command,
  [string]$File,
  [string[]]$Arg = @(),
  [string]$RemoteName = '',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $RepoRoot 'config/local.json') -Raw | ConvertFrom-Json
$SshTarget = $cfg.ssh.target
$SshUser = ($SshTarget -split '@')[0]
$SshKey = $cfg.ssh.keyPath
$SshAlias = $cfg.ssh.hostKeyAlias
$SshKnown = $cfg.ssh.knownHostsFile

$SshExe = Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe'
if (-not (Test-Path $SshExe)) { $SshExe = 'ssh' }
$ScpExe = Join-Path $env:WINDIR 'System32/OpenSSH/scp.exe'
if (-not (Test-Path $ScpExe)) { $ScpExe = 'scp' }

$opts = @(
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', "HostKeyAlias=$SshAlias",
  '-o', "UserKnownHostsFile=$SshKnown",
  '-o', 'ServerAliveInterval=15',
  '-i', $SshKey
)

$prelude = @'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
'@

$remoteDir = 'C:/Users/' + $SshUser + '/AppData/Local/Temp/nc-remote'

# Return the index just past the closing ')' of the script's param() block, or -1.
# Tracks single- and double-quoted strings so parentheses inside defaults/comments don't
# shift the balance. Only scans from the first `param(` that starts a line.
function Get-ParamBlockEnd([string]$text) {
  $m = [regex]::Match($text, '(?m)^[ \t]*param[ \t]*\(')
  if (-not $m.Success) { return -1 }
  $open = $text.IndexOf('(', $m.Index)
  if ($open -lt 0) { return -1 }
  $depth = 0
  $inSingle = $false
  $inDouble = $false
  for ($i = $open; $i -lt $text.Length; $i++) {
    $ch = $text[$i]
    if ($inSingle) {
      if ($ch -eq "'") {
        if ($i + 1 -lt $text.Length -and $text[$i + 1] -eq "'") { $i++ } else { $inSingle = $false }
      }
      continue
    }
    if ($inDouble) {
      if ($ch -eq '`') { $i++; continue }
      if ($ch -eq '"') { $inDouble = $false }
      continue
    }
    if ($ch -eq "'") { $inSingle = $true; continue }
    if ($ch -eq '"') { $inDouble = $true; continue }
    if ($ch -eq '(') { $depth++ }
    elseif ($ch -eq ')') {
      $depth--
      if ($depth -eq 0) { return $i + 1 }
    }
  }
  return -1
}

# ---------------------------------------------------------------- -File mode
if ($File) {
  $rp = Resolve-Path $File -ErrorAction SilentlyContinue
  if (-not $rp) { Write-Error "no such file: $File"; exit 1 }

  $bytes = [System.IO.File]::ReadAllBytes($rp)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $body = [System.Text.Encoding]::UTF8.GetString($bytes)
  if ($hasBom) { $body = $body.Substring(1) }

  $tag = 'ncshim-' + [guid]::NewGuid().ToString('N').Substring(0, 12)

  # ---- where the injected block goes -------------------------------------
  # param() must be the FIRST statement of a script (comments aside). Prefixing the
  # UTF-8 prelude ahead of it makes the parser reject the whole parameter list with
  # a pile of "invalid left-hand side" errors. So everything we add is inserted
  # immediately after param()'s closing paren, never before it.
  #
  # -Arg statements go there too: that overrides the declared defaults while param()
  # still declares the variables. Stripping param() instead lets PowerShell automatic
  # variables leak in -- `-Profile` silently became $PROFILE, the profile script path,
  # and ended up as a Chrome --user-data-dir.
  #
  # The end of the block is found with a paren scan, not a regex: `.*?\)` is only
  # correct when no default or comment contains a parenthesis.
  $inject = ''
  if ($Arg.Count -gt 0) { $inject += (($Arg -join "`r`n") + "`r`n") }
  $end = Get-ParamBlockEnd $body
  if ($end -ge 0) {
    $body = $body.Insert($end, "`r`n" + $inject + $prelude + "`r`n")
    $merged = $body
  } else {
    $merged = $inject + $prelude + "`r`n" + $body
  }
  if (-not $Quiet) { Write-Host ("[ssh-exec] " + (Split-Path $File -Leaf) + "  " + $Arg.Count + " arg(s), " + $body.Length + " chars") }

  # Fixed GUID-based names: the shim's filename must never inherit anything from the
  # caller's arguments (a `-Arg` value once leaked into the path and broke WriteAllText).
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ($tag + '.ps1')
  # UTF-8 WITH BOM -- this is what makes PS 5.1 read CJK correctly
  [System.IO.File]::WriteAllText($tmp, $merged, (New-Object System.Text.UTF8Encoding($true)))

  $remotePath = $remoteDir + '/' + $tag + '.ps1'

  $prep = 'powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path ''' +
          ($remoteDir -replace '/', '\') + ''' | Out-Null"'
  & $SshExe @opts $SshTarget $prep 2>&1 | Out-Null

  & $ScpExe @opts $tmp ($SshTarget + ':' + $remotePath) 2>&1 | ForEach-Object { if (-not $Quiet) { Write-Host $_ } }
  $scpRc = $LASTEXITCODE
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if ($scpRc -ne 0) { Write-Error "scp failed"; exit 1 }

  $remote = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ($remotePath -replace '/', '\') + '"'
  & $SshExe @opts $SshTarget $remote 2>&1 | ForEach-Object { Write-Output $_ }
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- -Command mode
if (-not $Command) { Write-Error "need -Command or -File"; exit 1 }

$body = $prelude + "`r`n" + $Command
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($body))
if ($b64.Length -gt 7000) {
  Write-Host ("[ssh-exec] inline payload " + $b64.Length + " chars -- exceeds cmd.exe 8191 limit; use -File")
}

if (-not $Quiet) { Write-Host ("[ssh-exec] " + $SshTarget + "  inline " + $Command.Length + " chars") }
& $SshExe @opts $SshTarget ('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $b64) 2>&1 |
  ForEach-Object { Write-Output $_ }
exit $LASTEXITCODE
