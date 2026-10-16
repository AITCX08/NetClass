/**
 * ocs-register.mjs — 把 NetClass 脚本注册进 OCS 的「脚本列表」（config.json → render.scripts）
 *
 * 原理（已从 OCS 2.9.24 渲染层代码确认）：
 *   const enabledUserScripts = store.render.scripts.filter(s => s.enable);
 *   userscripts = enabledUserScripts.map(s => (s.isLocalScript ? "file://" : "") + (s.info?.code_url || s.url));
 *   → 启动浏览器时，worker 会逐个打开这些 URL；油猴弹安装页；OCS 自动点「安装」按钮。
 *
 * 用法：
 *   node ocs-register.mjs --action add      # 写入脚本列表（幂等）
 *   node ocs-register.mjs --action status   # 查看当前列表
 *   node ocs-register.mjs --action remove   # 从列表移除
 */
import { execFileSync } from 'node:child_process';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const ACTION = A.action || 'status';
const SCRIPT_ID = Number(A.id || 990000000001);
const SCRIPT_URL = A.url || 'C:/Users/WJX/AppData/Local/TaskMesh/netclass/netclass.user.js';
const SCRIPT_NAME = 'NetClass 网课自动处理';

const LAPTOP = 'WJX@192.168.1.8';
const SSH_KEY = 'C:/Users/Administrator/.ssh/taskmesh_windows_laptop_ed25519';
const SSH = [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.10',
  '-o', 'UserKnownHostsFile=C:/Users/Administrator/.ssh/known_hosts',
  '-i', SSH_KEY, LAPTOP
];
function ps(code, timeout = 60000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  const f = 'C:\\Users\\WJX\\AppData\\Local\\TaskMesh\\netclass\\ocsreg.b64';
  const chunk = 1200;
  const run = (cmd, t) => {
    try {
      return execFileSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe', [...SSH, cmd],
        { encoding: 'utf8', timeout: t, stdio: ['ignore', 'pipe', 'pipe'], input: '' });
    } catch (e) { return '[ssh err] ' + ((e.stdout || '') + (e.stderr || '')).trim(); }
  };
  const one = (c, t) => {
    const b = Buffer.from(c, 'utf16le').toString('base64');
    return run(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b}`, t);
  };
  // 分块传输，避免命令行过长
  one(`New-Item -ItemType Directory -Force -Path 'C:\\Users\\WJX\\AppData\\Local\\TaskMesh\\netclass' | Out-Null; Set-Content -LiteralPath '${f}' -Value '' -Encoding ASCII; 'ok'`, 30000);
  for (let i = 0; i < b64.length; i += chunk) {
    one(`Add-Content -LiteralPath '${f}' -Value '${b64.slice(i, i + chunk)}' -Encoding ASCII -NoNewline`, 30000);
  }
  return one(`
$b = (Get-Content -LiteralPath '${f}' -Raw) -replace '[^A-Za-z0-9+/=]',''
$c = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b))
$exe = 'C:\\Users\\WJX\\AppData\\Local\\TaskMesh\\netclass\\ocsreg-exec.ps1'
[IO.File]::WriteAllText($exe, $c, (New-Object Text.UTF8Encoding($false)))
[Console]::OutputEncoding = [Text.Encoding]::UTF8
& powershell -NoProfile -ExecutionPolicy Bypass -File $exe
`, timeout);
}

const CONFIG = 'C:/Users/WJX/AppData/Roaming/OCS Desktop/config.json';

const psCode = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cfgPath = '${CONFIG.replace(/\//g, '\\')}'
if (-not (Test-Path $cfgPath)) { Write-Output 'ERR: config.json not found'; exit 3 }

$json = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $json.render) { $json | Add-Member -NotePropertyName render -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $json.render.scripts) { $json.render | Add-Member -NotePropertyName scripts -NotePropertyValue @() -Force }

Write-Output '== 当前脚本列表 =='
$json.render.scripts | ForEach-Object {
  Write-Output ('  id=' + $_.id + ' enable=' + $_.enable + ' local=' + $_.isLocalScript + ' url=' + $_.url)
}

$action = '${ACTION}'
$sid = ${SCRIPT_ID}
$surl = '${SCRIPT_URL}'
$sname = '${SCRIPT_NAME}'
$isLocal = $${A.remote === true ? 'false' : 'true'}

if ($action -eq 'add') {
  $existing = $json.render.scripts | Where-Object { $_.id -eq $sid -or $_.url -eq $surl }
  if ($existing) {
    Write-Output '== 已存在，更新字段 =='
    foreach ($e in @($existing)) {
      $e.enable = $true
      $e.url = $surl
      $e.isLocalScript = $isLocal
      $e.isInternetLinkScript = $false
      if (-not $e.info) { $e | Add-Member -NotePropertyName info -NotePropertyValue ([pscustomobject]@{}) -Force }
      $e.info | Add-Member -NotePropertyName id -NotePropertyValue $sid -Force
      $e.info | Add-Member -NotePropertyName url -NotePropertyValue $surl -Force
      $e.info | Add-Member -NotePropertyName code_url -NotePropertyValue $surl -Force
      $e.info | Add-Member -NotePropertyName name -NotePropertyValue $sname -Force
      $e.info | Add-Member -NotePropertyName version -NotePropertyValue '0.4.0' -Force
      $e.info | Add-Member -NotePropertyName description -NotePropertyValue 'auto study: shengshengketang + bjqiyang' -Force
      $e.info | Add-Member -NotePropertyName authors -NotePropertyValue @([pscustomobject]@{ name = 'TaskMesh'; url = '' }) -Force
    }
  } else {
    Write-Output '== 新增条目 =='
    $item = [pscustomobject]@{
      id = $sid
      url = $surl
      enable = $true
      isLocalScript = $isLocal
      isInternetLinkScript = $false
      info = [pscustomobject]@{
        id = $sid
        url = $surl
        code_url = $surl
        name = $sname
        version = '0.4.0'
        description = 'auto study: shengshengketang + bjqiyang'
        ratings = 0
        total_installs = 0
        daily_installs = 0
        create_time = 0
        update_time = 0
        authors = @([pscustomobject]@{ name = 'TaskMesh'; url = '' })
      }
    }
    $json.render.scripts = @($json.render.scripts) + $item
  }
  # 校验本地文件是否存在（OCS 启动时会 existsSync 检查）
  if ($isLocal -and -not (Test-Path $surl)) { Write-Output ('WARN: 本地脚本文件不存在 -> ' + $surl) }
  # 备份后写回
  Copy-Item $cfgPath ($cfgPath + '.netclass-bak') -Force
  $out = $json | ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText($cfgPath, $out, (New-Object Text.UTF8Encoding($false)))
  Write-Output '== 写入完成 =='
}
elseif ($action -eq 'remove') {
  $json.render.scripts = @($json.render.scripts | Where-Object { $_.id -ne $sid -and $_.url -ne $surl })
  Copy-Item $cfgPath ($cfgPath + '.netclass-bak') -Force
  $out = $json | ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText($cfgPath, $out, (New-Object Text.UTF8Encoding($false)))
  Write-Output '== 已移除 =='
}

if ($action -ne 'status') {
  $json2 = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Output '== 写入后的脚本列表 =='
  $json2.render.scripts | ForEach-Object {
    Write-Output ('  id=' + $_.id + ' enable=' + $_.enable + ' url=' + $_.url)
  }
}
`;
console.log(ps(psCode, 90000));
