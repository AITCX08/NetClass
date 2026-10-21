/**
 * status.mjs — NetClass 一条命令监控总览（**只读**，不改任何状态）
 *
 *   node scripts/status.mjs              # 全量：隧道/CDP + 两站运行态 + 窗口 + 加载器 + 笔记本侧
 *   node scripts/status.mjs --no-ssh     # 跳过笔记本侧（SSH 不通时用）
 *
 * 覆盖：
 *   ① 本机隧道与 CDP（9224 shengsheng / 9225 qiyang / 9226 webtrn）
 *   ② 每个页面：脚本模块版本、开关、视频状态、弹题计数、allDone
 *   ③ 窗口位置尺寸（左右半屏是否还在）
 *   ④ 加载器 SW：去重签名 lastSig / 构建号 / 日志环，并**自动识别「每 60s 重复注册」**
 *   ⑤ 笔记本侧（SSH）：chrome 进程与会话、调试端口、17800 服务、NetClass 与 TaskMesh-Learning 计划任务
 *
 * 退出码：0 = 无告警；1 = 有告警（端口不通 / 模块未加载 / 重复注册 / 服务不可用）
 */
import { execFileSync } from 'node:child_process';

const A = new Set(process.argv.slice(2));
const SKIP_SSH = A.has('--no-ssh');

const PORTS = [
  { port: 9224, name: 'shengsheng' },
  { port: 9225, name: 'qiyang' },
  { port: 9226, name: 'webtrn' }
];
const LOADER_ID = 'ebikemhgdinpnfeanicfkahlehcojjmn';
const SSH_ARGS = [
  '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PasswordAuthentication=no',
  '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
  '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
  '-o', 'HostKeyAlias=192.168.1.100',
  '-o', 'UserKnownHostsFile=C:/Users/YOURNAME/.ssh/known_hosts',
  '-i', 'C:/Users/YOURNAME/.ssh/id_ed25519',
  'user@host'
];

const warnings = [];
const warn = m => { warnings.push(m); };

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws open failed')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

const j = async url => (await fetch(url)).json();

const PAGE_EXPR = `JSON.stringify({
  url: location.pathname + location.search.slice(0, 40),
  module: !!window.NetClass,
  version: window.NetClass ? window.NetClass.version : null,
  enabled: (function(){ try { return JSON.parse(localStorage.getItem('netclass.cfg.v3') || '{}').enabled === true; } catch (e) { return null; } })(),
  allDone: window.NetClass ? window.NetClass.state.allDone : null,
  video: (function(){ var v = document.querySelector('video'); return v ? (Math.round(v.currentTime || 0) + '/' + Math.round(v.duration || 0) + (v.paused ? ' 暂停' : ' 播放') + ' x' + v.playbackRate + (v.muted ? ' 静音' : '')) : null; })(),
  quiz: window.NetClass ? window.NetClass.state.quiz : null,
  errors: window.NetClass ? (window.NetClass.state.errors || []).length : null
})`;

const line = (...parts) => parts.filter(x => x !== undefined && x !== null).join('  ');

async function checkPort({ port, name }) {
  const out = { port, name, cdp: false, browser: null, page: null, windows: null, loader: null };
  try {
    const v = await j(`http://127.0.0.1:${port}/json/version`);
    out.cdp = true;
    out.browser = v.Browser;
  } catch { warn(`${port} ${name}: CDP 不通（隧道断了？powershell -File scripts/tunnel.ps1 -Port ${port}）`); return out; }

  const list = await j(`http://127.0.0.1:${port}/json/list`);
  const pages = list.filter(t => t.type === 'page' && !/^(devtools|chrome|chrome-extension):/.test(t.url));
  const course = pages.find(p => /shengshengketang|bjqiyang|webtrn\.cn/.test(p.url));

  if (course) {
    try {
      const c = new Cdp(course.webSocketDebuggerUrl);
      await c.open();
      const r = await c.send('Runtime.evaluate', { expression: PAGE_EXPR, returnByValue: true });
      out.page = JSON.parse(r.result.value);
      c.close();
    } catch (e) { out.page = { err: e.message }; }
    if (out.page && out.page.module === false) warn(`${port} ${name}: 页面里没有 NetClass 模块（刷新页面或跑 loader-inject-test.mjs ${port}）`);
  } else if (pages.length) {
    out.page = { url: pages[0].url.slice(0, 60) + '（非课程页）' };
  }

  try {
    const bc = new Cdp((await j(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl);
    await bc.open();
    const target = course || pages[0];
    if (target) {
      const w = await bc.send('Browser.getWindowForTarget', { targetId: target.id }).catch(() => null);
      if (w) out.windows = (await bc.send('Browser.getWindowBounds', { windowId: w.windowId }).catch(() => ({}))).bounds || null;
    }
    bc.close();
  } catch { /* 窗口信息拿不到不算故障 */ }

  const sw = list.find(t => t.type === 'service_worker' && t.url.includes(LOADER_ID));
  if (!sw) {
    // MV3 的 SW 会被回收 —— 休眠是常态，只要页面里有模块就不算故障（页面缺模块另有告警）
    out.loader = { sw: false, asleep: true };
  } else {
    try {
      const c2 = new Cdp(sw.webSocketDebuggerUrl);
      await c2.open();
      const r = await c2.send('Runtime.evaluate', {
        expression: `chrome.storage.local.get(['logRing','lastSig','lastBuildId','lastAt']).then(function(v){
          var ring = v.logRing || [];
          var regs = ring.filter(function(l){ return l.indexOf('registered') >= 0; });
          return JSON.stringify({ lastSig: v.lastSig || null, build: v.lastBuildId || null, lastAt: v.lastAt || null,
            ringLen: ring.length, registered: regs.length, last3: regs.slice(-3), tail: ring.slice(-2) });
        })`,
        returnByValue: true, awaitPromise: true
      });
      const s = JSON.parse(r.result.value);
      // 症状判定：签名缺失 + 日志里反复 registered ⇒ 去重失效（背景见 docs/HANDOVER.md §5.21）
      s.sw = true;
      s.looping = !s.lastSig && s.registered >= 2;
      if (s.looping) warn(`${port} ${name}: 加载器在重复注册（lastSig 缺失，日志已有 ${s.registered} 次 registered）`);
      out.loader = s;
      c2.close();
    } catch (e) { out.loader = { sw: true, err: e.message }; }
  }
  return out;
}

function sshRun(code, timeout = 90000) {
  const b64 = Buffer.from(code, 'utf16le').toString('base64');
  try {
    return execFileSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      [...SSH_ARGS, `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}`],
      { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], input: '' });
  } catch (e) { return '[ssh err] ' + String((e.stdout || '') + (e.stderr || '')).trim().slice(0, 300); }
}

const REMOTE_PS = `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$c = Get-Process chrome -ErrorAction SilentlyContinue
Write-Output ('CHROME|' + ($c | Measure-Object).Count)
$c | Group-Object SessionId | ForEach-Object { Write-Output ('CHROME_SESSION|' + $_.Name + '|' + $_.Count) }
foreach ($p in @(9224,9225,9226)) {
  try { Invoke-WebRequest ("http://127.0.0.1:{0}/json/version" -f $p) -UseBasicParsing -TimeoutSec 3 | Out-Null; Write-Output ('PORT|' + $p + '|READY') }
  catch { Write-Output ('PORT|' + $p + '|down') }
}
try { $r = Invoke-WebRequest 'http://127.0.0.1:17800/status' -UseBasicParsing -TimeoutSec 5; Write-Output ('SERVER|' + $r.Content) }
catch { Write-Output 'SERVER|down' }
Get-ScheduledTask | Where-Object { $_.TaskName -match 'NetClass|TaskMesh-Learning' } | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  Write-Output ('TASK|' + $_.TaskName + '|' + $_.State + '|' + $i.LastTaskResult)
}
`;

function renderRemote(raw) {
  const rows = { chrome: 0, sessions: [], ports: [], server: null, tasks: [] };
  for (const l of raw.split(/\r?\n/)) {
    const p = l.split('|');
    if (p[0] === 'CHROME') rows.chrome = Number(p[1]);
    else if (p[0] === 'CHROME_SESSION') rows.sessions.push(`${p[1]}:${p[2]}`);
    else if (p[0] === 'PORT') rows.ports.push(`${p[1]}=${p[2]}`);
    else if (p[0] === 'SERVER') rows.server = p.slice(1).join('|');
    else if (p[0] === 'TASK') rows.tasks.push({ name: p[1], state: p[2], result: p[3] });
  }
  return rows;
}

// ------------------------------------------------------------------ main
console.log('NetClass 状态总览  ' + new Date().toISOString() + '  (HEAD 侧 ' + process.cwd() + ')');

const states = [];
for (const t of PORTS) states.push(await checkPort(t));

console.log('\n== 隧道 / 页面 ==');
for (const s of states) {
  if (!s.cdp) { console.log(line(`  ${s.port} ${s.name.padEnd(10)}`, 'CDP 不通')); continue; }
  const p = s.page || {};
  const quiz = p.quiz ? `quiz ${p.quiz.seen}/${p.quiz.answered}(对${p.quiz.correct} 错${p.quiz.wrong})` : 'quiz -';
  console.log(line(
    `  ${s.port} ${s.name.padEnd(10)}`,
    `CDP ok`,
    `module=${p.version || (p.module ? 'yes' : 'NO')}`,
    `enabled=${p.enabled}`,
    `video=${p.video || '-'}`,
    quiz,
    `allDone=${p.allDone}`,
    p.url ? `url=${p.url}` : ''
  ));
}

console.log('\n== 窗口 ==');
for (const s of states) {
  if (!s.windows) continue;
  console.log(`  ${s.port} ${s.name.padEnd(10)} ${s.windows.left},${s.windows.top} ${s.windows.width}x${s.windows.height}`);
}

console.log('\n== 加载器 ==');
for (const s of states) {
  const l = s.loader || {};
  if (!l.sw) { console.log(`  ${s.port} ${s.name.padEnd(10)} SW 休眠（MV3 正常，下次 alarm/导航会自唤起）${l.err ? ' | err ' + l.err : ''}`); continue; }
  const verdict = l.looping ? '⚠ 重复注册' : (l.lastSig ? '去重生效' : '无签名（首轮）');
  console.log(line(
    `  ${s.port} ${s.name.padEnd(10)}`,
    `lastSig=${l.lastSig || '(缺失)'}`,
    `build=${l.build || '-'}`,
    `ring=${l.ringLen}`,
    `registered=${l.registered}次`,
    verdict,
    l.last3 && l.last3.length ? `最近: ${l.last3[l.last3.length - 1]}` : ''
  ));
}

if (!SKIP_SSH) {
  console.log('\n== 笔记本侧（SSH） ==');
  const raw = sshRun(REMOTE_PS);
  if (raw.startsWith('[ssh err]')) {
    warn('笔记本侧取不到状态（SSH 不通）: ' + raw.slice(0, 120));
    console.log('  ' + raw.slice(0, 200));
  } else {
    const r = renderRemote(raw);
    console.log(`  chrome 进程 ${r.chrome}（会话 ${r.sessions.join(' ') || '?'}）  调试端口 ${r.ports.join(' ')}`);
    console.log(`  17800 服务：${r.server}`);
    if (r.server === 'down') warn('笔记本 17800 脚本服务不可用（加载器会退回内置 bundled.js，不再热更新）');
    const live = r.tasks.filter(t => t.state === 'Running');
    const residue = r.tasks.filter(t => /^NetClass(Probe|UIA|FreshTM|Matrix|TestNoExcept|UILaunch)/.test(t.name));
    console.log(`  运行中任务：${live.map(t => t.name).join(', ') || '(无)'}`);
    console.log(`  NetClass 任务 ${r.tasks.length} 个${residue.length ? `，其中历史残留 ${residue.length} 个（清理：nc.mjs run --file runs/remote/cleanup-residue-tasks.ps1）` : ''}`);
  }
}

console.log('\n== 结论 ==');
if (!warnings.length) console.log('  一切正常，无告警。');
else for (const w of warnings) console.log('  ⚠ ' + w);

process.exit(warnings.length ? 1 : 0);
