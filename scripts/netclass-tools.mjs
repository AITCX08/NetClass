/**
 * netclass-tools.mjs — PC 侧控制工具：通过 Chrome DevTools Protocol 操作笔记本上的 OCS 浏览器。
 *
 * 子命令：
 *   list                            列出当前所有标签页
 *   eval  --target <id|url子串> --file <js路径> | --expr <表达式>
 *                                   在目标页面里求值，打印结果
 *   drop  --profile <profile目录名> [--port 9223]      关闭该 profile 的浏览器
 *   launch --profile <profile目录名> [--port 9223]      以调试端口启动该 profile（加载同一套扩展）
 *   install --target <id|url子串> --script <user.js>    把油猴脚本装进 Tampermonkey（走官方安装页）
 *   shot  --target <id|url子串> --out <png路径>
 *   online                          检查调试端口是否在线
 *
 * 约定：调试端口默认 9223，只监听 127.0.0.1；PC 侧用 SSH 转发把端口接到本机后再跑本工具。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { argv, exit } from 'node:process';

const LAPTOP = 'user@host';
const KEY = 'C:/Users/YOURNAME/.ssh/id_ed25519';
const HOST_KEY_ALIAS = '192.168.1.1000';
const CHROME = 'C:\\Users\\YOURNAME\\AppData\\Local\\Programs\\OCS Desktop\\resources\\bin\\chrome\\chrome\\chrome.exe';
const EXT_DIR = 'C:/Users/YOURNAME/AppData/Roaming/OCS Desktop/downloads/extensions/tampermonkey';
const PROFILE_ROOT = 'C:\\Users\\YOURNAME\\AppData\\Roaming\\OCS Desktop\\userDataDirs';
const PORT = 9223;

const SSH_ARGS = [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', `HostKeyAlias=${HOST_KEY_ALIAS}`,
  '-o', 'UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts',
  '-i', KEY, LAPTOP
];

/** 在笔记本上跑一段 PowerShell（base64 编码，避免引号问题） */
function ps(code, { timeout = 60000 } = {}) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  return execFileSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    [...SSH_ARGS, `powershell -NoProfile -EncodedCommand ${b64}`],
    { encoding: 'utf8', timeout });
}

// ----------------------------------------------------------------- CDP 客户端
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  static async connect(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const info = await res.json();
    const c = new Cdp(info.webSocketDebuggerUrl);
    await c.open();
    return c;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', e => reject(new Error('ws error: ' + (e.message || 'unknown'))));
      this.ws.addEventListener('message', ev => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        } else if (msg.method) {
          for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 30000);
    });
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  close() { try { this.ws.close(); } catch { } }
}

/** 连到每个页面目标（page），逐个建立 session */
async function withPages(fn) {
  const cdp = await Cdp.connect(PORT);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pages = targetInfos.filter(t => t.type === 'page');
    const out = [];
    for (const t of pages) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      out.push({ target: t, sessionId, cdp });
    }
    return await fn(out, cdp);
  } finally { cdp.close(); }
}

function pickTargets(list, selector) {
  if (!selector) return list;
  const byId = list.filter(p => p.target.targetId === selector);
  if (byId.length) return byId;
  return list.filter(p => (p.target.url || '').includes(selector) || (p.target.title || '').includes(selector));
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true
  }, sessionId);
  if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result && r.result.value;
}

// ----------------------------------------------------------------- 子命令
async function cmdList() {
  await withPages(async pages => {
    for (const p of pages) {
      console.log(`${p.target.targetId}  ${p.target.url}`);
    }
  });
}

async function cmdOnline() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const j = await r.json();
    console.log(JSON.stringify(j, null, 2));
  } catch (e) { console.log('OFFLINE ' + e.message); exit(2); }
}

async function cmdEval({ target, file, expr }) {
  const code = file ? readFileSync(file, 'utf8') : expr;
  if (!code) throw new Error('需要 --file 或 --expr');
  await withPages(async (pages, cdp) => {
    const hit = pickTargets(pages, target);
    if (!hit.length) throw new Error('没找到匹配的标签页：' + target);
    for (const p of hit) {
      const v = await evalIn(cdp, p.sessionId, code);
      console.log(`--- ${p.target.url}\n` + (typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
    }
  });
}

async function cmdShot({ target, out }) {
  await withPages(async (pages, cdp) => {
    const hit = pickTargets(pages, target);
    if (!hit.length) throw new Error('没找到匹配的标签页：' + target);
    for (const p of hit) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, p.sessionId);
      const f = out || `runs/shot-${Date.now()}.png`;
      mkdirSync(f.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
      writeFileSync(f, Buffer.from(r.data, 'base64'));
      console.log('saved ' + f + '  (' + p.target.url + ')');
    }
  });
}

function cmdDrop({ profile }) {
  const ps1 = `
$prof = "${PROFILE_ROOT}\\" + ${JSON.stringify(profile)}
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {
  if($_.CommandLine -and $_.CommandLine -like ("*" + $prof + "*")){
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
  }
}
Write-Output ("killed=" + $killed)
`;
  console.log(ps(ps1).trim());
}

function cmdLaunch({ profile, port = PORT, headless = false }) {
  const ps1 = `
$prof = "${PROFILE_ROOT}\\" + ${JSON.stringify(profile)}
if(-not (Test-Path $prof)){ Write-Output "ERR: profile not found $prof"; exit 3 }
$port = ${port}
$args = @(
  "--user-data-dir=$prof",
  "--load-extension=${EXT_DIR}",
  "--remote-debugging-port=$port",
  "--remote-allow-origins=*",
  "--no-first-run","--no-default-browser-check",
  "--disable-features=Translate","--lang=zh-CN",
  "--window-size=1280,900",
  "about:blank"
)
$p = Start-Process -FilePath "${CHROME}" -ArgumentList $args -PassThru
Start-Sleep -Seconds 4
$ok = $false
try { $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/json/version") -UseBasicParsing -TimeoutSec 5; $ok = ($r.StatusCode -eq 200) } catch {}
Write-Output ("pid=" + $p.Id + " debugPortOk=" + $ok)
`;
  console.log(ps(ps1, { timeout: 120000 }).trim());
}

/** 通过 Tampermonkey 官方安装页安装脚本：把脚本托管到 127.0.0.1 后打开安装页并点「安装」 */
async function cmdInstall({ target, script, servePort = 17801 }) {
  const code = readFileSync(script, 'utf8');
  // 在笔记本上起一个一次性静态服务（用 node 内置 http），把脚本内容托管出去
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const ps1 = `
$tmp = Join-Path $env:TEMP ("netclass-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$b64 = "${b64}"
[IO.File]::WriteAllBytes((Join-Path $tmp "netclass.user.js"), [Convert]::FromBase64String($b64))
$srv = @"
const http=require('http'),fs=require('fs'),p=require('path');
const dir=process.argv[2];
http.createServer((q,s)=>{const f=p.join(dir,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,d)=>{if(e){s.writeHead(404);return s.end('no')}s.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});s.end(d)})}).listen(${servePort},'127.0.0.1');
"@
[IO.File]::WriteAllText((Join-Path $tmp "srv.js"), $srv)
$p = Start-Process -FilePath "D:\\1.nodesj\\node.exe" -ArgumentList @((Join-Path $tmp "srv.js"), $tmp) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1
try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:${servePort}/netclass.user.js" -UseBasicParsing -TimeoutSec 5; Write-Output ("server ok len=" + $r.Content.Length) } catch { Write-Output ("server ERR " + $_.Exception.Message) }
Write-Output ("serverpid=" + $p.Id)
Write-Output ("tmp=" + $tmp)
`;
  const out = ps(ps1, { timeout: 60000 }).trim();
  console.log(out);

  const installUrl = `https://update.greasyfork.org/scripts/0/0/x.user.js`; // 仅占位，真正安装用下面本地地址
  const localUrl = `http://127.0.0.1:${servePort}/netclass.user.js`;
  const url = `chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html?url=${encodeURIComponent(localUrl)}`;

  await withPages(async (pages, cdp) => {
    const hit = pickTargets(pages, target);
    if (!hit.length) throw new Error('没找到目标标签页：' + target);
    const p = hit[0];
    await cdp.send('Page.enable', {}, p.sessionId);
    await cdp.send('Page.navigate', { url }, p.sessionId);
    await new Promise(r => setTimeout(r, 4000));
    // 在安装页里找「安装」按钮并点击
    const clicked = await evalIn(cdp, p.sessionId, `
      (() => {
        const btn = Array.from(document.querySelectorAll('button, a, span, div'))
          .find(el => /^\\s*(安装|Install)\\s*$/.test(el.innerText || ''));
        if (!btn) return 'no-install-button:' + document.title;
        btn.click();
        return 'clicked:' + document.title;
      })()
    `);
    console.log('install => ' + clicked);
    await new Promise(r => setTimeout(r, 3000));
    const after = await evalIn(cdp, p.sessionId, `document.title + ' | ' + location.href`);
    console.log('after => ' + after);
  });
}

// ----------------------------------------------------------------- 入口
const [cmd, ...rest] = argv.slice(2);
function opts() {
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) { o[rest[i].slice(2)] = (rest[i + 1] && !rest[i + 1].startsWith('--')) ? rest[++i] : true; }
  }
  return o;
}
const O = opts();
try {
  switch (cmd) {
    case 'list': await cmdList(); break;
    case 'online': await cmdOnline(); break;
    case 'eval': await cmdEval({ target: O.target, file: O.file, expr: O.expr }); break;
    case 'shot': await cmdShot({ target: O.target, out: O.out }); break;
    case 'drop': cmdDrop({ profile: O.profile }); break;
    case 'launch': cmdLaunch({ profile: O.profile, port: O.port || PORT, headless: !!O.headless }); break;
    case 'install': await cmdInstall({ target: O.target, script: O.script, servePort: O.servePort || 17801 }); break;
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
      exit(1);
  }
} catch (e) {
  console.error('ERROR: ' + (e && e.stack || e));
  exit(1);
}
