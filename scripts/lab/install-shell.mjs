/**
 * install-shell.mjs — 把一个 .user.js 装进 OCS 浏览器里的 Tampermonkey
 *
 * 思路（对 Chrome 137 + Tampermonkey 5.4.0 实测可用）：
 *   1) 用 WMI 启动/复用一个带 --remote-debugging-port 的 Chrome（同一 profile，保留登录态）
 *   2) 确保 profile 打开扩展开发者模式（否则 chrome-extension:// 页面会被 ERR_BLOCKED_BY_CLIENT）
 *   3) 从 HTTP 端点 /json/new?<options.html url> 打开油猴选项页（CDP 的 Target.createTarget 会被拦）
 *   4) 在该页里构造 POST 表单提交脚本内容（name/namespace/source/code/uuid）→ 油猴处理安装
 *   5) 打开仪表盘核对脚本已登记
 *
 * 用法：
 *   node install-shell.mjs --port 9226 --profile test-profile --script ../userscript/netclass.shell.user.js
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const LAPTOP = 'user@host';
const SSH_KEY = 'C:/Users/YOURNAME/.ssh/id_ed25519';
const CHROME = 'C:\\Users\\YOURNAME\\AppData\\Local\\Programs\\OCS Desktop\\resources\\bin\\chrome\\chrome\\chrome.exe';
const EXT_TM = 'C:/Users/YOURNAME/AppData/Roaming/OCS Desktop/downloads/extensions/tampermonkey';
const PREF_ROOT = 'C:\\Users\\YOURNAME\\AppData\\Roaming\\OCS Desktop\\userDataDirs';

const SSH = [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.100',
  '-o', 'UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts',
  '-i', SSH_KEY, LAPTOP
];

function remotePs(code, timeout = 120000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  try {
    return execFileSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      [...SSH, `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`],
      { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return ('[ssh error] ' + (e.stdout || '') + (e.stderr || '')).trim(); }
}

// 分块传输较长的远端脚本
function remotePsLong(code, tag = '_t', timeout = 240000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  const chunk = 1200;
  const parts = [];
  for (let i = 0; i < b64.length; i += chunk) parts.push(b64.slice(i, i + chunk));
  const win = `C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass\\${tag}.b64`;
  remotePs(`New-Item -ItemType Directory -Force -Path 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass' | Out-Null; Set-Content -LiteralPath '${win}' -Value '' -Encoding ASCII; 'ok'`, 30000);
  for (const p of parts) remotePs(`Add-Content -LiteralPath '${win}' -Value '${p}' -Encoding ASCII -NoNewline`, 30000);
  const dec = `
$p='${win}'
$b=(Get-Content -LiteralPath $p -Raw) -replace '[^A-Za-z0-9+/=]',''
$code=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b))
$exe=Join-Path (Split-Path $p) '${tag}-exec.ps1'
[IO.File]::WriteAllText($exe,$code,(New-Object Text.UTF8Encoding($false)))
[Console]::OutputEncoding=[Text.Encoding]::UTF8
& powershell -NoProfile -ExecutionPolicy Bypass -File $exe
`;
  return remotePs(dec, timeout);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  static async connect(port) {
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const c = new Cdp(info.webSocketDebuggerUrl); await c.open(); return c;
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', e => rej(new Error('ws: ' + (e.message || 'err'))));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(p));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

// ---------------------------------------------------------------- 主流程
const args = process.argv.slice(2);
const O = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) O[args[i].slice(2)] = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : true;

const PORT = Number(O.port || 9226);
const PROFILE_NAME = O.profile || 'test-profile';
const SCRIPT = O.script || new URL('../userscript/netclass.shell.user.js', import.meta.url).pathname.replace(/^\//, '');
const PROFILE_DIR = PROFILE_NAME.includes(':') ? PROFILE_NAME.split(':')[1] : `${PREF_ROOT}\\${PROFILE_NAME}`;
const START = O.start !== 'false';

const shellCode = readFileSync(SCRIPT, 'utf8');
console.log(`[1/5] script=${SCRIPT} (${shellCode.length} bytes) profile=${PROFILE_NAME}`);

if (START) {
  console.log('[2/5] 启动带调试端口的 Chrome（WMI，脱离 ssh 进程树）…');
  const startPs = `
$chrome = '${CHROME}'
$prof = '${PROFILE_DIR}'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${PORT}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (-not (Test-Path (Join-Path $prof 'Default'))) { New-Item -ItemType Directory -Force -Path (Join-Path $prof 'Default') | Out-Null }
$cl = '"' + $chrome + '" --user-data-dir="' + $prof + '" --load-extension="${EXT_TM}" --disable-extensions-except="${EXT_TM}" --remote-debugging-port=${PORT} --remote-allow-origins=* --no-first-run --no-default-browser-check --lang=zh-CN about:blank'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cl }
Write-Output ('spawn ret=' + $r.ReturnValue + ' pid=' + $r.ProcessId)
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 2
  try { $x = Invoke-WebRequest ('http://127.0.0.1:${PORT}/json/version') -UseBasicParsing -TimeoutSec 3; Write-Output 'debug port ready'; break } catch { }
}
`;
  console.log(remotePs(startPs, 120000).trim());
}

console.log('[3/5] 打开油猴选项页…');
const optUrl = `chrome-extension://${TM_ID}/options.html`;
let optsTarget = null;
for (let i = 0; i < 12 && !optsTarget; i++) {
  // 先尝试 /json/new（可能返回重定向，不一定是目标页）
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${optUrl}`, { method: 'PUT' }); } catch (e) { }
  await sleep(2500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    optsTarget = list.find(t => t.type === 'page' && /^chrome-extension:\/\/[a-p]{32}\/options\.html/.test(t.url))
      || list.find(t => t.type === 'page' && t.url.includes('options.html'));
  } catch (e) { }
  if (!optsTarget) console.log('  attempt ' + i + ': 还没出现 options 页');
}
if (!optsTarget) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log('  当前页面：');
  for (const t of list.filter(t => t.type === 'page')) console.log('   - ' + t.url.slice(0, 110));
  console.error('  打不开选项页：检查 devmode / 扩展是否加载');
  process.exit(2);
}
console.log('  opened: ' + optsTarget.url);

const cdp = await Cdp.connect(PORT);
try {
  const page = new Cdp(optsTarget.webSocketDebuggerUrl);
  await page.open();
  await page.send('Page.enable');

  console.log('[4/5] 提交安装表单…');
  const jsB64 = Buffer.from(shellCode, 'utf8').toString('base64');
  const r = await page.send('Runtime.evaluate', {
    expression: `(() => {
      try {
        const code = atob('${jsB64}');
        const f = document.createElement('form');
        f.method = 'POST'; f.action = 'options.html';
        const add = (n, v) => { const i = document.createElement('input'); i.type='hidden'; i.name=n; i.value=v; f.appendChild(i); };
        add('name', 'netclass'); add('namespace', 'taskmesh.local/netclass');
        add('source', 'manual://netclass'); add('origin', 'manual://netclass');
        add('code', code); add('uuid', 'nc-shell-0001');
        document.body.appendChild(f); f.submit();
        return 'submitted';
      } catch (e) { return 'err:' + e.message; }
    })()`,
    returnByValue: true
  });
  console.log('  ' + (r.result && r.result.value));
  await sleep(6000);
  const after = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  console.log('  after: ' + (after.result && after.result.value));
  page.close();

  console.log('[5/5] 核对仪表盘…');
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?chrome-extension://${TM_ID}/options.html`, { method: 'PUT' }); } catch (e) { }
  await sleep(5000);
  const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const dashT = list2.find(t => t.type === 'page' && t.url.includes('options.html'));
  if (dashT) {
    const dp = new Cdp(dashT.webSocketDebuggerUrl); await dp.open();
    await dp.send('Page.enable');
    const txt = await dp.send('Runtime.evaluate', {
      expression: `document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0,900) : ''`, returnByValue: true
    });
    console.log('  ' + (txt.result && txt.result.value));
    dp.close();
  }
} finally { cdp.close(); }
