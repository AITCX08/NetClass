/**
 * nc.mjs — NetClass 单文件控制台（PC 侧 → 笔记本 OCS 浏览器）
 *
 * 子命令
 *   up     --profile <uid|test> [--port 9224] [--url <课程页>] [--nopipe]
 *          启动一个带调试端口、加载油猴扩展的 Chrome（WMI 拉起，脱离 ssh 进程树）
 *   tabs   [--port]                列出标签页
 *   new    --port --url <url>      新开标签页
 *   eval   --port --target <子串> --expr '<js>' | --file <path>
 *   run    --file <ps1> [--args '-Apply']   在笔记本上执行 PowerShell（分块传输）
 *          --args 只允许字/数字/空格与 - . : = \ / " 这些字符，避免注入到远程命令行
 *   watch  --port --url <url>      打开课程页并常驻验证脚本状态（每 5s 打印一次）
 *   probe  --port --url <url>      打开页面并抓取 DOM/接口探针（用于适配新站点）
 *
 * 依赖：PC 侧先建立 SSH 转发 —— powershell -File scripts/tunnel.ps1 -Port <port>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const RUNS = join(REPO, 'runs');
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const LAPTOP = 'user@host';
const SSH_KEY = 'C:/Users/YOURNAME/.ssh/id_ed25519';
const CHROME = 'C:\\Users\\YOURNAME\\AppData\\Local\\Programs\\OCS Desktop\\resources\\bin\\chrome\\chrome\\chrome.exe';
const EXT_TM = 'C:/Users/YOURNAME/AppData/Roaming/OCS Desktop/downloads/extensions/tampermonkey';
// ★ 新平台（如学习通）要看到 NetClass 面板/模块，必须把加载器也装上；
//   只加载油猴时 --disable-extensions-except 会把加载器排除掉，页面里就没有 window.NetClass。
const EXT_NC = 'C:/Users/YOURNAME/AppData/Roaming/OCS Desktop/downloads/extensions/netclass-loader';
const PREF_ROOT = 'C:\\Users\\YOURNAME\\AppData\\Roaming\\OCS Desktop\\userDataDirs';
const WORK = 'C:\\Users\\YOURNAME\\AppData\\Local\\TaskMesh\\netclass';

const SSH = [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.100',
  '-o', 'UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts',
  '-i', SSH_KEY, LAPTOP
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sshRaw(cmd, timeout = 60000) {
  try {
    return execFileSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe', [...SSH, cmd],
      { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], input: '' });
  } catch (e) { return '[ssh err] ' + ((e.stdout || '') + (e.stderr || '')).trim(); }
}
function psOne(code, timeout = 60000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  return sshRaw(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`, timeout);
}
let seq = 0;
const ARGS_SAFE = /^[A-Za-z0-9 _\-.:=\\/"]*$/;
function psFile(code, timeout = 300000, args = '') {
  if (args && !ARGS_SAFE.test(args)) throw new Error('--args 含不安全字符: ' + args);
  const tag = 'nc' + (++seq);
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  const f = `${WORK}\\${tag}.b64`;
  const chunk = 1200;
  psOne(`New-Item -ItemType Directory -Force -Path '${WORK}' | Out-Null; Set-Content -LiteralPath '${f}' -Value '' -Encoding ASCII; 'ok'`, 30000);
  for (let i = 0; i < b64.length; i += chunk) {
    psOne(`Add-Content -LiteralPath '${f}' -Value '${b64.slice(i, i + chunk)}' -Encoding ASCII -NoNewline`, 30000);
  }
  const dec = `
$b = (Get-Content -LiteralPath '${f}' -Raw) -replace '[^A-Za-z0-9+/=]',''
$c = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b))
$exe = '${WORK}\\${tag}-exec.ps1'
[IO.File]::WriteAllText($exe, $c, (New-Object Text.UTF8Encoding($false)))
[Console]::OutputEncoding = [Text.Encoding]::UTF8
& powershell -NoProfile -ExecutionPolicy Bypass -File $exe ${args}
`;
  return psOne(dec, timeout);
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  static async browser(port) {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const c = new Cdp(v.webSocketDebuggerUrl); await c.open(); return c;
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws open failed')));
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

async function targetList(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return await r.json();
}
function pickTargets(list, sel) {
  if (!sel) return list.filter(t => t.type === 'page');
  return list.filter(t => t.type === 'page' && (t.id === sel || t.url.includes(sel) || (t.title || '').includes(sel)));
}
async function evalOn(port, target, expr) {
  const list = await targetList(port);
  const hit = pickTargets(list, target);
  if (!hit.length) throw new Error('no target for ' + target);
  const results = [];
  for (const t of hit) {
    const c = new Cdp(t.webSocketDebuggerUrl);
    await c.open();
    try {
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      results.push({ url: t.url, value: r.result && r.result.value, exception: r.exceptionDetails ? JSON.stringify(r.exceptionDetails).slice(0, 300) : null });
    } finally { c.close(); }
  }
  return results;
}

// ------------------------------------------------------------------ commands
async function cmdUp({ profile, port = 9224, url = '', nopipe = false }) {
  const isTest = !profile || profile === 'test' || profile === 'test-profile';
  const profDir = isTest ? `${WORK}\\test-profile` : `${PREF_ROOT}\\${profile}`;
  const tag = isTest ? 'test' : String(profile).slice(0, 8);
  const cli = [
    `"${CHROME}"`,
    `--user-data-dir="${profDir}"`,
    nopipe ? '' : `--load-extension="${EXT_TM},${EXT_NC}" --disable-extensions-except="${EXT_TM},${EXT_NC}"`,
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--no-first-run`, `--no-default-browser-check`, `--lang=zh-CN`,
    `--disable-features=Translate`,
    `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`,
    `--window-size=1400,900`,
    url ? `"${url}"` : ''
  ].filter(Boolean).join(' ');
  const bat = `@echo off\r\nstart "" ${cli}\r\necho launched %DATE% %TIME% > "${WORK}\\chrome-${tag}.log"\r\n`;
  const batB64 = Buffer.from(bat, 'utf8').toString('base64');
  const batWin = `${WORK}\\runchrome-${tag}.bat`;

  const script = `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path '${WORK}' | Out-Null
if (-not (Test-Path '${profDir}\\Default')) { New-Item -ItemType Directory -Force -Path '${profDir}\\Default' | Out-Null }
[IO.File]::WriteAllBytes('${batWin}', [Convert]::FromBase64String('${batB64}'))
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${batWin}"' }
Write-Output ('spawn=' + $r.ReturnValue)
for ($i=0; $i -lt 18; $i++) { Start-Sleep -Seconds 2; try { $x = Invoke-WebRequest 'http://127.0.0.1:${port}/json/version' -UseBasicParsing -TimeoutSec 3; Write-Output 'port ready'; break } catch { } }
if ($i -ge 18) { Write-Output 'PORT NOT READY' }
`;
  console.log(psFile(script, 240000).trim());
}

async function cmdTabs({ port = 9224 }) {
  const list = await targetList(port);
  for (const t of list) if (t.type === 'page') console.log(t.id + '  ' + t.url.slice(0, 130));
}

async function cmdNew({ port = 9224, url }) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url || 'about:blank')}`, { method: 'PUT' });
  console.log('created: ' + r.status);
}

async function cmdEval({ port = 9224, target, expr, file }) {
  const code = file ? readFileSync(file, 'utf8') : expr;
  if (!code) throw new Error('need --expr or --file');
  const out = await evalOn(port, target, code);
  for (const o of out) console.log('--- ' + o.url + '\n' + (typeof o.value === 'string' ? o.value : JSON.stringify(o.value, null, 2)));
}

async function cmdRun({ file, script, args }) {
  const code = file ? readFileSync(file, 'utf8') : script;
  if (!code) throw new Error('need --file or --script');
  console.log(psFile(code, 300000, args || ''));
}

const STATE_EXPR = `JSON.stringify({
  url: location.href,
  title: document.title,
  shell: !!window.__NETCLASS_SHELL__,
  module: !!window.NetClass,
  version: window.NetClass ? window.NetClass.version : null,
  state: window.NetClass ? window.NetClass.state : null,
  videos: document.querySelectorAll('video').length,
  videoState: (function(){ const v = document.querySelector('video'); return v ? { t: Math.round(v.currentTime), d: Math.round(v.duration), rate: v.playbackRate, paused: v.paused, muted: v.muted } : null; })(),
  panel: !!document.getElementById('netclass-panel'),
  quizPending: !!window.__NETCLASS_QUIZ_PENDING__
})`;

async function cmdWatch({ port = 9224, url, times = 12 }) {
  if (url) { try { await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }); } catch { } }
  for (let i = 0; i < times; i++) {
    await sleep(5000);
    try {
      const list = await targetList(port);
      const pages = list.filter(t => t.type === 'page' && /shengshengketang|bjqiyang/.test(t.url));
      if (!pages.length) { console.log(`[${i}] 还没有课程页`); continue; }
      const r = await evalOn(port, 'shengshengketang', STATE_EXPR);
      for (const x of r) console.log(`[${i}] ` + x.value);
    } catch (e) { console.log(`[${i}] err ` + e.message); }
  }
}

async function cmdProbe({ port = 9224, url }) {
  const expr = `JSON.stringify({
    url: location.href,
    title: document.title,
    nodeCount: document.querySelectorAll('*').length,
    videos: Array.from(document.querySelectorAll('video')).map(v => ({ src: (v.currentSrc||'').slice(0,120), dur: v.duration, rate: v.playbackRate })),
    iframes: Array.from(document.querySelectorAll('iframe')).map(f => (f.src||'').slice(0,120)).slice(0,5),
    buttons: Array.from(document.querySelectorAll('button,a[role=button],.btn,[class*=btn]')).map(b => (b.innerText||'').trim()).filter(Boolean).slice(0,25),
    lists: Array.from(document.querySelectorAll('[class*=list] li,[class*=catalog] li,[class*=chapter] li,[class*=section]')).map(l => ({ cls: l.className.slice(0,60), text: (l.innerText||'').trim().slice(0,60) })).slice(0,20),
    quizLike: Array.from(document.querySelectorAll('[class*=quiz],[class*=question],[class*=pop],[class*=dialog],[class*=modal]')).map(e => ({ cls: e.className.slice(0,70), text: (e.innerText||'').trim().slice(0,120) })).slice(0,10),
    globals: Object.keys(window).filter(k => /player|video|ali|vlc|dplayer|prism/i.test(k)).slice(0,20)
  })`;
  if (url) { try { await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }); } catch { } await sleep(9000); }
  const out = await evalOn(port, '', expr);
  for (const o of out) { console.log('=== ' + o.url.slice(0, 100)); console.log(o.value); }
}

// ------------------------------------------------------------------ main
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const cmd = argv[0];
const P = Number(A.port || 9224);
try {
  switch (cmd) {
    case 'up': await cmdUp({ profile: A.profile, port: P, url: A.url || '', nopipe: !!A.nopipe }); break;
    case 'tabs': await cmdTabs({ port: P }); break;
    case 'new': await cmdNew({ port: P, url: A.url }); break;
    case 'eval': await cmdEval({ port: P, target: A.target, expr: A.expr, file: A.file }); break;
    case 'run': await cmdRun({ file: A.file, script: A.script, args: A.args }); break;
    case 'watch': await cmdWatch({ port: P, url: A.url, times: Number(A.times || 12) }); break;
    case 'probe': await cmdProbe({ port: P, url: A.url }); break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
  }
} catch (e) { console.error('ERROR ' + (e.stack || e)); process.exit(1); }
