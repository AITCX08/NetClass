/**
 * watchdog.mjs — 双平台驱动看门狗：驱动挂了就自动拉起，保证"长时间无人值守"
 *
 * 背景：长春 90 学时在 1x 下要跑几十小时，学习通也有 65 个叶子任务点。
 *       驱动进程一旦因网络抖动/页面异常退出，没人守着就白等一整夜。
 *
 * 用法：node scripts\watchdog.mjs            （常驻，每 60 秒体检一次）
 *      node scripts\watchdog.mjs --once     （只体检一次）
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const ONCE = process.argv.includes('--once');
const ROOT = process.cwd();
const STATE = 'runs/watchdog-state.json';
mkdirSync('runs', { recursive: true });

const logger = (tag) => (m) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '][' + tag + '] ' + m;
  console.log(line);
  try { appendFileSync('runs/watchdog.log', line + '\n'); } catch (_) { }
};

/** 探测某个 CDP 端口上，页面是否处于"推进中"状态（比"进程活着"更可靠） */
async function probe(port, kind) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    const pages = list.filter(t => t.type === 'page' && !/tampermonkey/.test(t.url));
    if (!pages.length) return { ok: false, why: 'no-page' };
    const p = pages[0];
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 6000); });
    let i = 0;
    const send = (m, pr = {}, ms = 8000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
    const JS = kind === 'cc'
      ? `(function(){var v=document.querySelector('video');var t=(document.body.innerText||'').replace(/\\s+/g,' ');return JSON.stringify({cur:v?Math.round(v.currentTime):null,dur:v?v.duration:null,paused:v?v.paused:null,len:t.length,player:/返回课程列表/.test(t)});})()`
      : `(function(){function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}var v=f(document);return JSON.stringify({cur:v?Math.round(v.currentTime):null,dur:v?v.duration:null,paused:v?v.paused:null,len:(document.body.innerText||'').length});})()`;
    const r = await send('Runtime.evaluate', { expression: JS, returnByValue: true, awaitPromise: true });
    ws.close();
    const val = r && r.result && r.result.result ? r.result.result.value : null;
    return { ok: !!val, data: val ? JSON.parse(val) : null };
  } catch (e) { return { ok: false, why: String(e).slice(0, 40) }; }
}

const KIDS = { cc: null, cx: null };
/** ★ 拉起前必须先查"系统里是否已有同类驱动"——否则会起重复进程：
 *  同一个标签被两个驱动抢点击 → 一个点播放、另一个把页面导航走 → 表现为"播放器总是消失"。
 *  长春更严重：多会话会触发平台的 423 锁，整条链直接废掉。 */
import { execFileSync } from 'node:child_process';
function runningDrivers(kind) {
  const re = kind === 'cc' ? 'cc-auto\\.mjs --port' : 'cx-auto\\.mjs --port';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '${re}' } | ForEach-Object { $_.ProcessId }`
    ], { encoding: 'utf8', timeout: 20000 });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number).filter(n => n > 0);
  } catch (_) { return []; }
}

function launch(kind) {
  const args = kind === 'cc'
    ? ['scripts/cc-auto.mjs', '--port', '9228', '--tab', '0', '--secs', '10']
    : ['scripts/cx-auto.mjs', '--port', '9227', '--secs', '8'];
  const log = `runs/${kind}-driver.log`;
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], detached: false, windowsHide: true });
  KIDS[kind] = { pid: child.pid, started: Date.now() };
  logger(kind)('🚀 拉起驱动 pid=' + child.pid);
  child.on('exit', (code) => { logger(kind)('💀 驱动退出 code=' + code); KIDS[kind] = null; });
  return child;
}

const log = logger('wd');
async function health(kind, port) {
  const pr = await probe(port, kind);
  return { kind, port, ...pr };
}

async function main() {
  log('看门狗启动（每 60 秒体检）');
  for (;;) {
    for (const [kind, port] of [['cc', 9228], ['cx', 9227]]) {
      const h = await health(kind, port);
      const alive = KIDS[kind] && KIDS[kind].pid;
      if (!h.ok) {
        log(kind + ' ❌ CDP 不通/无页面（' + (h.why || 'probe-fail') + '）' + (alive ? '（驱动进程还在 pid=' + KIDS[kind].pid + '）' : ''));
        // CDP 不通时驱动一般也会自己重连，先不杀；连续两次不通再考虑重启
      } else {
        const d = h.data || {};
        log(kind + ' ✅ cur=' + d.cur + '/' + Math.round(d.dur || 0) + (d.paused ? ' 停' : ' 播') + ' len=' + d.len + (d.player ? ' [播放器]' : '') + (alive ? '' : '  ⚠ 无驱动进程'));
        if (!alive) {
          const others = runningDrivers(kind);
          if (others.length) { log(kind + ' → 已有驱动在跑（pid=' + others.join(',') + '），不重复拉起'); KIDS[kind] = { pid: others[0], started: Date.now(), foreign: true }; }
          else { log(kind + ' → 无任何驱动，拉起'); launch(kind); }
        }
      }
    }
    if (ONCE) break;
    await new Promise(r => setTimeout(r, 60000));
  }
}
main();
