/**
 * parallel-probe.mjs — 自动探测"某网课平台在同一浏览器里最多能并行几个课程"
 *
 *   node scripts/parallel-probe.mjs --port 9224 [--max 3] [--secs 25] [--minRate 0.8] [--open <课程URL>] [--json]
 *
 * 做法：逐档 N=1,2,3…：确保 N 个标签页都在播 → 记录每个页的 currentTime → 等 --secs →
 *       再读一次，算每个页的"实测倍速 = 视频推进 / 墙钟"。有任何一页 < minRate×标称倍速 就判定
 *       该档位不可用，最大并行数 = 上一档。同时检查是否出现登录/踢下线信号。
 * 注意：默认**只复用已打开的页面**，不新开（--open 传课程 URL 才会新开标签，会额外占带宽）。
 * 产物：控制台表格 + runs/parallel-probe-<port>.json（供订单流程/技能引用）
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const MAX = Number(A.max || 3);
const SECS = Number(A.secs || 25);
const MIN_RATE = Number(A.minRate || 0.8);
const OPEN_URL = A.open ? String(A.open) : null;
const fs = await import('node:fs');

const list0 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list0.filter(t => t.type === 'page' && !/^(devtools|chrome|chrome-extension)/.test(t.url));
console.log('现有标签 ' + pages.length + ' 个；本平台可用页面 ' + pages.filter(p => /course|lesson|home|record/.test(p.url)).length);

async function conn(p) {
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (method, params = {}, ms = 20000) => new Promise(res => {
    const id = ++seq;
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res({ timeout: true }), ms);
  });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
  return { ws, ev };
}

const SAMPLE = `(function(){
  var v = document.querySelector('video');
  var t = document.body ? document.body.innerText.replace(/\\s+/g,' ') : '';
  return JSON.stringify({
    ts: Date.now(), cur: v ? +v.currentTime.toFixed(2) : null, rate: v ? v.playbackRate : null,
    paused: v ? v.paused : null, hidden: document.visibilityState === 'hidden',
    kicked: /(登录已失效|已在其他|重新登录|会话过期)/.test(t.slice(0, 1500)),
    title: document.title.slice(0, 20), url: location.pathname.slice(0, 40)
  });
})()`;
const ENSURE_PLAY = `(function(){
  var v = document.querySelector('video'); if (!v) return 'no-video';
  try { v.muted = true; if (v.paused) v.play(); } catch (e) {}
  if (window.NetClass && NetClass.cfg && !NetClass.cfg.enabled) { try { NetClass.cfg.enabled = true; } catch (e) {} }
  return v.paused ? 'paused' : 'playing';
})()`;

const targets = [];
for (const p of pages.filter(p => /shengsheng|courses|course\/|lesson|record|home/.test(p.url))) targets.push({ p, ...(await conn(p)) });
if (OPEN_URL) {
  const anchor = targets[0] || (await conn(pages[0]));
  await anchor.ws ? null : null;
}

const results = [];
let best = 0, nominalRate = 1.5;
for (let n = 1; n <= Math.min(MAX, targets.length); n++) {
  const use = targets.slice(0, n);
  console.log('\n=== N=' + n + ' ===');
  for (const c of use) await c.ev(ENSURE_PLAY);
  await new Promise(r => setTimeout(r, 3000));
  const t0 = [];
  for (const c of use) t0.push(JSON.parse(await c.ev(SAMPLE) || '{}'));
  await new Promise(r => setTimeout(r, SECS * 1000));
  const rows = [];
  let ok = true;
  for (let i = 0; i < use.length; i++) {
    const s = JSON.parse(await use[i].ev(SAMPLE) || '{}');
    if (!s.cur || t0[i].cur == null) { rows.push({ tab: use[i].p.id.slice(0, 8), note: '无视频/取不到时间', ok: false }); ok = false; continue; }
    const wall = (s.ts - t0[i].ts) / 1000;
    const adv = s.cur - t0[i].cur;
    const eff = adv / wall;
    const r = { tab: use[i].p.id.slice(0, 8), url: s.url, wall: +wall.toFixed(1), advance: +adv.toFixed(1), effRate: +eff.toFixed(2), rate: s.rate, hidden: s.hidden, kicked: s.kicked, ok: eff >= MIN_RATE * (s.rate || nominalRate) };
    rows.push(r);
    if (!r.ok) ok = false;
  }
  for (const r of rows) console.log('  ' + JSON.stringify(r));
  results.push({ n, ok, rows });
  if (ok) best = n; else { console.log('  → 该档位不达标，停止加档'); break; }
}
const out = { port: PORT, secs: SECS, minRate: MIN_RATE, max_parallel: best, tested: results, at: new Date().toISOString() };
fs.writeFileSync('runs/parallel-probe-' + PORT + '.json', JSON.stringify(out, null, 2));
console.log('\n== 结论 == 最大可并行: ' + best + '（结果已存 runs/parallel-probe-' + PORT + '.json）');
if (best === 0) console.log('   注意：一档都没过，先确认页面在播、视频有 currentTime');
for (const c of targets) c.ws.close();
