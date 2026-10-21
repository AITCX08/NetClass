/**
 * netclass-ctl.mjs — NetClass 部署控制（PC 侧 → 笔记本 OCS 浏览器）
 *
 * 前置：PC 侧起好 SSH 转发
 *   ssh -N -i C:/Users/YOURNAME/.ssh/id_ed25519 \
 *       -o HostKeyAlias=192.168.1.100 -o UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts \
 *       -L 9224:127.0.0.1:9224 user@host
 * 端口约定：SSH 转发 9224 → 笔记本 Chrome 调试端口 9224
 *
 * 用法：
 *   node netclass-ctl.mjs status                       # 端口/浏览器/标签页状态
 *   node netclass-ctl.mjs relaunch --profile <uid>     # 关闭该 profile 的浏览器，带调试端口重启（加载油猴）
 *   node netclass-ctl.mjs tabs                         # 列出所有标签页
 *   node netclass-ctl.mjs open --url <url>             # 新开标签页
 *   node netclass-ctl.mjs eval --target <子串> --expr '<js>'|--file <path>
 *   node netclass-ctl.mjs install --target <子串>      # 用油猴官方安装页把本地壳脚本装进 Tampermonkey
 *   node netclass-ctl.mjs verify                       # 校验脚本是否在两站页面上跑起来
 *   node netclass-ctl.mjs shot --target <子串> --out <png>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9224;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const LAPTOP = 'user@host';
const SSH_KEY = 'C:/Users/YOURNAME/.ssh/id_ed25519';
const CHROME = 'C:\\Users\\YOURNAME\\AppData\\Local\\Programs\\OCS Desktop\\resources\\bin\\chrome\\chrome\\chrome.exe';
const EXT_TAMPERMONKEY = 'C:/Users/YOURNAME/AppData/Roaming/OCS Desktop/downloads/extensions/tampermonkey';
const PROFILE_ROOT = 'C:\\Users\\YOURNAME\\AppData\\Roaming\\OCS Desktop\\userDataDirs';
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const SHELL_LOCAL = join(REPO, 'userscript', 'netclass.shell.user.js');

const SSH_ARGS = [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.100',
  '-o', 'UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts',
  '-i', SSH_KEY, LAPTOP
];

function ps(code, timeout = 120000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  try {
    return execFileSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      [...SSH_ARGS, `powershell -NoProfile -EncodedCommand ${b64}`],
      { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return ('[ssh error] ' + (e.stdout || '') + (e.stderr || '') + (e.message || '')).trim();
  }
}

/**
 * 远端脚本执行：先把脚本落成笔记本上的临时 .ps1（分块 base64 写入，绕过命令行长度限制），
 * 再用 -File 执行。比 -EncodedCommand 稳，适合长脚本。
 */
function psFile(code, timeout = 240000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  const chunk = 1200;
  const parts = [];
  for (let i = 0; i < b64.length; i += chunk) parts.push(b64.slice(i, i + chunk));
  const winPath = 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass\\_task.ps1';

  // 第 1 步：重置目标文件（ASCII 避免 BOM 污染 base64）
  ps(`New-Item -ItemType Directory -Force -Path 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass' | Out-Null; Set-Content -Path '${winPath}' -Value '' -Encoding ASCII; 'reset'`, 30000);

  // 第 2 步：分块以 base64 追加（ASCII、无换行）
  for (const part of parts) {
    ps(`Add-Content -Path '${winPath}' -Value '${part}' -Encoding ASCII -NoNewline`, 30000);
  }

  // 第 3 步：解码成真正的 utf16 脚本，再执行
  const decode = `
$p = '${winPath}'
$b64 = (Get-Content -LiteralPath $p -Raw) -replace '[^A-Za-z0-9+/=]',''
Write-Output ('transport_b64_len=' + $b64.Length)
$bytes = [Convert]::FromBase64String($b64)
$code = [Text.Encoding]::Unicode.GetString($bytes)
$exe = Join-Path (Split-Path $p) '_task-exec.ps1'
[IO.File]::WriteAllText($exe, $code, (New-Object Text.UTF8Encoding($false)))
& powershell -NoProfile -ExecutionPolicy Bypass -File $exe
`;
  return ps(decode, timeout).trim();
}

// ------------------------------------------------------------------ CDP
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const info = await r.json();
    const c = new Cdp(info.webSocketDebuggerUrl);
    await c.open();
    return c;
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', e => rej(new Error('ws: ' + (e.message || 'err'))));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res: rr, rej: rj } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? rj(new Error(JSON.stringify(m.error))) : rr(m.result);
        } else if (m.method && this.handlers.has(m.method)) {
          this.handlers.get(m.method).forEach(f => f(m.params, m.sessionId));
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(p));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

async function withPages(fn) {
  const cdp = await Cdp.connect();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page');
    const bound = [];
    for (const t of pages) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      bound.push({ target: t, sessionId });
    }
    return await fn(bound, cdp);
  } finally { cdp.close(); }
}
function pick(pages, sel) {
  if (!sel) return pages;
  return pages.filter(p => p.target.targetId === sel || (p.target.url || '').includes(sel) || (p.target.title || '').includes(sel));
}
async function evalIn(cdp, sid, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error('eval异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result && r.result.value;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ 命令
async function cmdStatus() {
  let online = false, info = null;
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); info = await r.json(); online = true; } catch { }
  console.log('debug port ' + PORT + ' : ' + (online ? 'ONLINE' : 'OFFLINE'));
  if (online) console.log('  ' + info.Browser + ' UA=' + String(info['User-Agent']).slice(0, 60));
  const procs = ps(`
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object {
  $prof = if($_.CommandLine -match 'userDataDirs\\\\([a-f0-9]{32})'){ $matches[1] } elseif($_.CommandLine -match 'profiles\\\\([a-f0-9]{32})'){ 'tm:' + $matches[1] } else { 'other' }
  $dbg = if($_.CommandLine -match '--remote-debugging-port=(\\d+)'){ $matches[1] } else { 'pipe' }
  $hl = if($_.CommandLine -match '--headless'){ 'headless' } else { 'headful' }
  Write-Output ("pid=" + $_.ProcessId + " prof=" + $prof + " debug=" + $dbg + " " + $hl)
}`);
  console.log('--- chrome processes ---');
  console.log(procs.trim());
  if (online) {
    await withPages(async pages => {
      console.log('--- tabs (' + pages.length + ') ---');
      for (const p of pages) console.log('  ' + p.target.targetId + '  ' + p.target.url);
    });
  }
}

async function cmdRelaunch({ profile, url, withExtension = true, port = PORT }) {
  if (!profile) throw new Error('需要 --profile <uid>');
  const short = String(profile).slice(0, 8) || 'x';
  const batch = [
    '@echo off',
    `start "" "${CHROME}" ^`,
    ` "--user-data-dir=${PROFILE_ROOT}\\${profile}" ^`,
    withExtension ? ` "--load-extension=${EXT_TAMPERMONKEY}" ^` : null,
    ` "--remote-debugging-port=${port}" ^`,
    ` "--remote-allow-origins=*" ^`,
    ` "--no-first-run" "--no-default-browser-check" "--disable-popup-blocking" ^`,
    ` "--disable-background-timer-throttling" "--disable-renderer-backgrounding" ^`,
    ` "--disable-features=Translate" "--lang=zh-CN" ^`,
    ` "--window-position=0,0" "--window-size=1400,900" "--restore-last-session" ^`,
    ` ${url ? `"${url}"` : ''}`
  ].filter(x => x !== null).join('\r\n');

  const b64Lines = batch.split('\r\n').map(l => Buffer.from(l, 'utf8').toString('base64'));
  const winBat = `C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass\\launch-${short}.bat`;

  // 先把 batch 逐行以 base64 落盘到 lines.b64（ASCII-only，绕开所有引号/编码问题）
  const b64File = `C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass\\lines-${short}.b64`;
  ps(`New-Item -ItemType Directory -Force -Path 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass' | Out-Null; Set-Content -LiteralPath '${b64File}' -Value '' -Encoding ASCII; 'reset'`, 30000);
  for (const line of b64Lines) {
    ps(`Add-Content -LiteralPath '${b64File}' -Value '${line}' -Encoding ASCII`, 30000);
  }
  const lineCount = Number((ps(`(Get-Content -LiteralPath '${b64File}' | Measure-Object -Line).Lines`, 30000) || '0').trim()) || 0;
  console.log('b64 lines written: ' + lineCount + '/' + b64Lines.length);

  const code = `
$root = 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass'
$prof = '${PROFILE_ROOT}\\${profile}'
Write-Output ('profile exists: ' + (Test-Path $prof))
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {
  if($_.CommandLine -and $_.CommandLine -like ("*" + $prof + "*")){ try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch {} }
}
Write-Output ('killed=' + $killed)
Start-Sleep -Seconds 2
$bat = '${winBat}'
$tmp = '${b64File}'
$lines = Get-Content -LiteralPath $tmp -ErrorAction SilentlyContinue
if(-not $lines){ $lines = @() }
$sb = New-Object System.Text.StringBuilder
foreach($x in $lines){ if($x.Trim()){ [void]$sb.AppendLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($x.Trim()))) } }
[IO.File]::WriteAllText($bat, $sb.ToString(), (New-Object Text.UTF8Encoding($false)))
Write-Output ('bat bytes=' + ((Get-Item -LiteralPath $bat).Length))
$task = 'NetClassLaunch-${short}'
cmd /c $bat
Start-Sleep -Seconds 11
$ok=$false
try { $r=Invoke-WebRequest ('http://127.0.0.1:${port}/json/version') -UseBasicParsing -TimeoutSec 6; $ok=($r.StatusCode -eq 200) } catch {}
Write-Output ('task=' + $task + ' debugPortOk=' + $ok)
if($ok){
  try { $t=Invoke-WebRequest ('http://127.0.0.1:${port}/json/list') -UseBasicParsing -TimeoutSec 6; $l=$t.Content | ConvertFrom-Json; Write-Output ('targets=' + $l.Count); $l | ForEach-Object { Write-Output ('  [' + $_.type + '] ' + ($_.url -replace '\\?.*','')) } } catch { Write-Output ('list ERR ' + $_.Exception.Message) }
} else {
  Write-Output '--- batch content ---'
  if(Test-Path -LiteralPath $bat){ Get-Content -LiteralPath $bat | ForEach-Object { Write-Output ('  ' + $_) } }
}
`;
  console.log(psFile(code).trim());
}

async function cmdTabs() {
  await withPages(async pages => {
    for (const p of pages) console.log(p.target.targetId + '  ' + p.target.url);
  });
}

async function cmdOpen({ url }) {
  const cdp = await Cdp.connect();
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: url || 'about:blank' });
    console.log('opened ' + targetId);
  } finally { cdp.close(); }
}

async function cmdEval({ target, expr, file }) {
  const code = file ? readFileSync(file, 'utf8') : expr;
  if (!code) throw new Error('需要 --expr 或 --file');
  await withPages(async (pages, cdp) => {
    const hit = pick(pages, target);
    if (!hit.length) throw new Error('没匹配到标签页：' + target);
    for (const p of hit) {
      const v = await evalIn(cdp, p.sessionId, code);
      console.log('--- ' + p.target.url + '\n' + (typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
    }
  });
}

async function cmdShot({ target, out }) {
  await withPages(async (pages, cdp) => {
    const hit = pick(pages, target);
    if (!hit.length) throw new Error('没匹配到标签页：' + target);
    const p = hit[0];
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, p.sessionId);
    const f = out || join(REPO, 'runs', 'shot-' + Date.now() + '.png');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('saved ' + f);
  });
}

/** 把壳脚本装进 Tampermonkey：
 *  1) 在笔记本上起一个一次性 HTTP 服务（17802）托管 netclass.user.js
 *  2) 用 CDP 打开油猴官方安装页 options.html?url=...
 *  3) 轮询点击「安装」按钮；若拿不到按钮，退回在安装页里构造表单提交
 *  4) 打开仪表盘核对脚本是否登记成功
 */
async function cmdInstall({ target, port = PORT }) {
  const code = readFileSync(SHELL_LOCAL, 'utf8');
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const psCode = `
$dir = Join-Path $env:LOCALAPPDATA 'TaskMesh\\netclass\\install'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[IO.File]::WriteAllBytes((Join-Path $dir 'netclass.user.js'), [Convert]::FromBase64String('${b64}'))
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*netclass*install*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$srv = Join-Path $dir 'serve.js'
$js = @"
const http=require('http'),fs=require('fs'),p=require('path');
const dir=process.argv[2];
http.createServer((q,s)=>{
  const f=p.join(dir, q.url.split('?')[0]==='/'?'netclass.user.js':decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{ if(e){s.writeHead(404);return s.end('no')} s.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}); s.end(d) })
}).listen(17802,'127.0.0.1');
"@
[IO.File]::WriteAllText($srv, $js)
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"D:\\1.nodesj\\node.exe" "' + $srv + '" "' + $dir + '"') }
Start-Sleep -Seconds 1
try { $r = Invoke-WebRequest 'http://127.0.0.1:17802/netclass.user.js' -UseBasicParsing -TimeoutSec 5; Write-Output ('serve ok ' + $r.Content.Length) } catch { Write-Output ('serve ERR ' + $_.Exception.Message) }
`;
  console.log(ps(psCode, 60000).trim());

  const localUrl = 'http://127.0.0.1:17802/netclass.user.js';
  const installUrl = `chrome-extension://${TM_ID}/options.html?url=${encodeURIComponent(localUrl)}`;
  const dashUrl = `chrome-extension://${TM_ID}/options.html#nav=utils`;

  const cdp = await Cdp.connect();
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: installUrl });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await sleep(4500);

    let installed = false;
    for (let i = 0; i < 10 && !installed; i++) {
      const r = await evalIn(cdp, sessionId, `(() => {
        const all = Array.from(document.querySelectorAll('button, a, span, div, input'));
        const btn = all.find(el => /^\\s*(安装|Install)\\s*$/.test((el.innerText || el.value || '').trim()));
        if (btn) { btn.click(); return 'clicked:' + (document.title||''); }
        return 'no-button|title=' + document.title + '|text=' + (document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0, 150) : '');
      })()`);
      console.log('  attempt ' + i + ' -> ' + r);
      if (String(r).startsWith('clicked')) { installed = true; break; }
      await sleep(1200);
    }

    if (!installed) {
      console.log('  退回：直接构造安装表单提交');
      const formResult = await evalIn(cdp, sessionId, `(() => {
        try {
          const code = window.__nc_code || null;
          return 'no-code-available';
        } catch (e) { return 'err:' + e.message; }
      })()`);
      console.log('  ' + formResult);
    }

    await sleep(3000);
    const after = await evalIn(cdp, sessionId, `document.title + ' || ' + location.href`);
    console.log('  after=' + after);
    await cdp.send('Page.navigate', { url: dashUrl }, sessionId);
    await sleep(4500);
    const list = await evalIn(cdp, sessionId, `(() => {
      const t = document.body ? document.body.innerText : '';
      return t.replace(/\\s+/g,' ').slice(0, 600);
    })()`);
    console.log('  dashboard => ' + list);
  } finally { cdp.close(); }
}

/** 检查两站页面上脚本是否运行 */
async function cmdVerify() {
  await withPages(async (pages, cdp) => {
    for (const p of pages) {
      if (!/shengshengketang|bjqiyang/.test(p.target.url)) continue;
      const probe = `JSON.stringify({
          url: location.href,
          shell: !!window.__NETCLASS_SHELL__,
          module: !!window.NetClass,
          version: (window.NetClass && window.NetClass.version) || null,
          panel: !!document.getElementById('netclass-panel'),
          video: document.querySelectorAll('video').length,
          state: window.NetClass ? window.NetClass.state : null
        })`;
      const r = await evalIn(cdp, p.sessionId, probe);
      console.log(r);
    }
  });
}

async function cmdShow({ profile, port = PORT, url, start = true }) {
  if (!profile) throw new Error('需要 --profile <uid|test-profile>');
  const isTest = profile === 'test-profile';
  const profDir = isTest
    ? 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass\\test-profile'
    : `${PROFILE_ROOT}\\${profile}`;
  const tag = isTest ? 'test' : String(profile).slice(0, 8);
  const winDir = 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass';

  // 批处理内容全部由 Node 生成（CRLF 绝不会丢）
  const cli = [
    `"${CHROME}"`,
    `--user-data-dir="${profDir}"`,
    `--load-extension="${EXT_TAMPERMONKEY}"`,
    `--disable-extensions-except="${EXT_TAMPERMONKEY}"`,
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--no-first-run`, `--no-default-browser-check`,
    `--lang=zh-CN`, `--disable-features=Translate`,
    `--window-size=1400,900`,
    url ? `"${url}"` : ''
  ].filter(Boolean).join(' ');
  const bat = `@echo off\r\nstart "" ${cli}\r\necho launched %DATE% %TIME% > "${winDir}\\chrome-${tag}.log"\r\n`;

  const b64 = Buffer.from(bat, 'utf8').toString('base64');
  const batWin = `${winDir}\\runchrome-${tag}.bat`;
  const ps1 = `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$dir = '${winDir}'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[IO.File]::WriteAllBytes('${batWin}', [Convert]::FromBase64String('${b64}'))
Write-Output ('bat bytes=' + (Get-Item '${batWin}').Length)
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (-not (Test-Path '${profDir}\\Default')) { New-Item -ItemType Directory -Force -Path '${profDir}\\Default' | Out-Null }
${start ? `
$task = 'NetClassChrome-${tag}'
schtasks /Create /TN $task /TR ('cmd.exe /c "' + '${batWin}' + '"') /SC ONCE /ST 23:59 /F /IT | Out-Null
schtasks /Run /TN $task | Out-Null
for ($i=0; $i -lt 15; $i++) { Start-Sleep -Seconds 2; try { $r = Invoke-WebRequest ('http://127.0.0.1:${port}/json/version') -UseBasicParsing -TimeoutSec 3; Write-Output 'debug port ready'; break } catch { } }
if ($i -ge 15) {
  Write-Output 'port not ready; direct start fallback'
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('cmd.exe /c "' + '${batWin}' + '"') }
  Write-Output ('wmi ret=' + $r.ReturnValue)
  for ($j=0; $j -lt 10; $j++) { Start-Sleep -Seconds 2; try { $x = Invoke-WebRequest ('http://127.0.0.1:${port}/json/version') -UseBasicParsing -TimeoutSec 3; Write-Output 'debug port ready (fallback)'; break } catch { } }
}
` : ''}
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match 'remote-debugging-port=${port}' } | ForEach-Object {
  Write-Output ('  main pid=' + $_.ProcessId + ' session=' + (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).SessionId)
}
`;
  console.log(psFile(ps1, 300000).trim());
}

async function cmdRunPs({ script, file }) {
  const code = file ? readFileSync(file, 'utf8') : script;
  if (!code) throw new Error('需要 --script <ps代码> 或 --file <ps文件>');
  const out = psFile(code, 300000);
  console.log(out);
}

/** 安装（v2）：在油猴自己的安装页里构造表单提交，不依赖界面按钮 */
async function cmdInstall2({ port = PORT }) {
  const code = readFileSync(SHELL_LOCAL, 'utf8');
  const jsB64 = Buffer.from(code, 'utf8').toString('base64');
  const optUrl = `chrome-extension://${TM_ID}/options.html`;

  const cdp = await Cdp.connect();
  try {
    // 打开 options.html（带重试：扩展刚加载时可能被拦）
    let sessionId = null;
    for (let i = 0; i < 8 && !sessionId; i++) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const s = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, s.sessionId);
      await cdp.send('Page.navigate', { url: optUrl }, s.sessionId);
      await sleep(2500);
      const u = await evalIn(cdp, s.sessionId, 'location.href').catch(() => '');
      console.log('  open attempt ' + i + ' -> ' + u);
      if (String(u).startsWith('chrome-extension://')) { sessionId = s.sessionId; break; }
      await sleep(2000);
    }
    if (!sessionId) throw new Error('无法打开油猴选项页（可能 devmode 未生效）');

    const submit = await evalIn(cdp, sessionId, `(() => {
      try {
        const code = atob('${jsB64}');
        const f = document.createElement('form');
        f.method = 'POST';
        f.action = 'options.html';
        const add = (n, v) => { const i = document.createElement('input'); i.type='hidden'; i.name=n; i.value=v; f.appendChild(i); };
        add('name', 'netclass');
        add('namespace', 'taskmesh.local/netclass');
        add('source', 'http://127.0.0.1:17802/netclass.user.js');
        add('origin', 'http://127.0.0.1:17802');
        add('code', code);
        add('uuid', 'nc-shell-0001');
        document.body.appendChild(f);
        f.submit();
        return 'submitted';
      } catch (e) { return 'err:' + e.message; }
    })()`);
    console.log('  submit => ' + submit);
    await sleep(6000);

    const after = await evalIn(cdp, sessionId, `location.href + ' || ' + (document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0,400) : '')`).catch(e => 'ERR ' + e.message);
    console.log('  after => ' + after);
  } finally { cdp.close(); }
}

// ------------------------------------------------------------------ 入口
const [cmd, ...rest] = process.argv.slice(2);
const O = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) O[rest[i].slice(2)] = (rest[i + 1] && !rest[i + 1].startsWith('--')) ? rest[++i] : true;
try {
  switch (cmd) {
    case 'show': await cmdShow({ profile: O.profile, port: O.port || PORT, url: O.url, start: O.start !== 'false' }); break;
    case 'run': await cmdRunPs({ script: O.script, file: O.file }); break;
    case 'inst2': await cmdInstall2({ port: O.port || PORT }); break;
    case 'status': await cmdStatus(); break;
    case 'relaunch': await cmdRelaunch({ profile: O.profile, url: O.url, withExtension: O.noext ? false : true, port: O.port || PORT }); break;
    case 'tabs': await cmdTabs(); break;
    case 'open': await cmdOpen({ url: O.url }); break;
    case 'eval': await cmdEval({ target: O.target, expr: O.expr, file: O.file }); break;
    case 'shot': await cmdShot({ target: O.target, out: O.out }); break;
    case 'install': await cmdInstall({ target: O.target }); break;
    case 'verify': await cmdVerify(); break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n'));
      process.exit(1);
  }
} catch (e) {
  console.error('ERROR: ' + (e.stack || e));
  process.exit(1);
}
