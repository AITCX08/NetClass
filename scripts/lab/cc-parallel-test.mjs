/**
 * cc-parallel-test.mjs — 测试长春（ccjyxy）能同时跑几个标签
 *
 * 背景：之前记录"第 2 个标签 → report 接口 423 Locked"，
 *   但 2026-10-16 实测发现**开 2 个标签本身不触发 423**（在播的那个一直 200）。
 *   本脚本做决定性测试：让两个标签**都播放**，看服务端会不会拒绝第二个会话。
 *
 * 做法：
 *   ① 找出各标签的状态（在播？有视频？）
 *   ② 把在播标签的 URL 复制给没在播的标签
 *   ③ 等一会儿，读两个标签的钩子记录（有无 423）
 *
 * 用法：node scripts\cc-parallel-test.mjs --port 9228 [--wait 60]
 */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] || d) : d; };
const PORT = Number(arg('port', 9228));
const WAIT = Number(arg('wait', 60));

const EVAL = `JSON.stringify({
  url: location.href,
  hasVideo: !!document.querySelector('video'),
  playing: (function(){ var v = document.querySelector('video'); return v ? (!v.paused && v.currentTime > 0) : false })(),
  cur: (function(){ var v = document.querySelector('video'); return v ? Math.round(v.currentTime) : -1 })(),
  dur: (function(){ var v = document.querySelector('video'); return v ? Math.round(v.duration || 0) : -1 })(),
  hits: (window.__parHits || []).slice(-10),
  has423: (window.__parHits || []).some(function(h){ return h.status === 423 })
})`;

const HOOK = `(function(){
  if (window.__parHook) return 'already';
  window.__parHook = 1; window.__parHits = [];
  var of = window.fetch;
  window.fetch = function(){
    var url = String((arguments[0] && arguments[0].url) || arguments[0] || '');
    var p = of.apply(this, arguments);
    if (/video-progress|report|heartbeat|progress/i.test(url)) {
      p.then(function(r){ window.__parHits.push({ t: Date.now(), url: url.slice(-50), status: r.status }); }).catch(function(e){});
    }
    return p;
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    var x = this;
    x.addEventListener('load', function(){
      if (/video-progress|report|heartbeat|progress/i.test(String(x.__u))) window.__parHits.push({ t: Date.now(), url: String(x.__u).slice(-50), status: x.status });
    });
    return os.apply(this, arguments);
  };
  return 'hooked';
})()`;

async function pages() {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return l.filter(t => t.type === 'page' && /ccjyxy/.test(t.url));
}

async function withWs(target, fn) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let i = 0;
  const send = (m, pr = {}, ms = 8000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  try { return await fn(send); } finally { ws.close(); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ps = await pages();
console.log(`=== 长春标签数: ${ps.length} ===`);

// 挂钩子
for (const p of ps) {
  await withWs(p, async (send) => {
    await send('Runtime.evaluate', { expression: HOOK, returnByValue: true });
  });
}
console.log('  钩子已注入');

// 读状态
const states = [];
for (const p of ps) {
  const r = await withWs(p, send => send('Runtime.evaluate', { expression: EVAL, returnByValue: true }));
  const v = r && r.result && r.result.result && r.result.result.value;
  states.push({ id: p.id.slice(0, 6), ...(v ? JSON.parse(v) : {}) });
}
console.log('=== 初始状态 ===');
states.forEach((s, i) => console.log(`  [${i}] ${s.id} playing=${s.playing} cur=${s.cur}/${s.dur} url=${String(s.url).slice(0, 60)}`));

// 找在播的那个，把 URL 复制给没在播的
const playingOne = states.find(s => s.playing);
if (!playingOne) { console.log('  ⚠ 没有正在播放的标签 —— 请先让一个标签播起来'); process.exit(0); }
console.log(`=== 用 [${playingOne.id}] 的 URL 驱动其它标签 ===`);
for (let i = 0; i < ps.length; i++) {
  if (states[i].id === playingOne.id) continue;
  await withWs(ps[i], async (send) => {
    await send('Page.navigate', { url: playingOne.url });
    await sleep(1500);
    // 尝试播放
    await send('Runtime.evaluate', { expression: `(function(){ var v = document.querySelector('video'); if (v) { v.muted = true; try { v.play() } catch(e){}; return 'play-called' } return 'no-video' })()`, returnByValue: true });
  });
  console.log(`  [${states[i].id}] 已导航 + 尝试播放`);
  await sleep(3000);
}

console.log(`=== 等 ${WAIT} 秒观察 ===`);
await sleep(WAIT * 1000);

const after = [];
const ps2 = await pages();
for (const p of ps2) {
  const r = await withWs(p, send => send('Runtime.evaluate', { expression: EVAL, returnByValue: true }));
  const v = r && r.result && r.result.result && r.result.result.value;
  after.push({ id: p.id.slice(0, 6), ...(v ? JSON.parse(v) : {}) });
}
console.log('=== 最终状态 ===');
after.forEach((s, i) => {
  const codes = (s.hits || []).map(h => h.status).join(',');
  console.log(`  [${i}] ${s.id} playing=${s.playing} cur=${s.cur}/${s.dur} 有423=${s.has423} 报告码=[${codes}]`);
});
const any423 = after.some(s => s.has423);
console.log('=== 结论 ===');
console.log(any423 ? '  ❌ 出现 423 —— 服务端拒绝多会话' : '  ✅ 未出现 423 —— 多标签可并行');
