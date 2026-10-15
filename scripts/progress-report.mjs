/**
 * progress-report.mjs — 三平台统一进度记录器（长跑用）
 *
 * 每隔 --every 秒抓一次三个平台的**可靠指标**并落盘到 runs/progress.jsonl（每行一条 JSON），
 * 同时往控制台打一行人读摘要。用于长跑期间随时核对"到底推进了多少"。
 *
 * 指标来源（都是实测过的可靠口径）：
 *   长春   ：/api/v1/me/my-trainings-progress 的 learned_score / completed_courses
 *            + /api/v1/video-progress/resource?resource_id=N（当前段，N 从播放令牌解出）
 *   学习通 ：树里 span.roundpoint 的类名分布（blue=已完成 / orange01 jobCount=未完成）
 *   生生长 ：两个标签的 video.currentTime/duration/rate
 *
 * 用法：node scripts\progress-report.mjs [--every=300]
 */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1] || d) : d; };
const EVERY = arg('every', 300);

const { appendFileSync, mkdirSync } = await import('node:fs');
mkdirSync('runs', { recursive: true });
const human = (m) => console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + m);

async function withTab(port, urlRe, expr, ms = 15000) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
    const p = list.filter(t => t.type === 'page' && urlRe.test(t.url) && !/tampermonkey/.test(t.url))[0];
    if (!p) return null;
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 8000); });
    let i = 0;
    const send = (m, pr = {}) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    ws.close();
    return r && r.result && r.result.result ? r.result.result.value : null;
  } catch (e) { return null; }
}

const CC_EXPR = `(async function(){
  try {
    var tk = localStorage.getItem('access_token'); var H = { 'Accept':'application/json', 'Authorization':'Bearer ' + tk };
    var t = await (await fetch('/api/v1/me/my-trainings-progress', { credentials:'include', headers:H })).text();
    var m = t.match(/"learned_score":([0-9.]+).*?"completed_courses":(\\d+),"total_courses":(\\d+)/);
    var v = document.querySelector('video');
    return JSON.stringify({
      learned: m ? Number(m[1]) : null, done: m ? Number(m[2]) : null, total: m ? Number(m[3]) : null,
      cur: v ? Math.round(v.currentTime) : null, dur: v ? Math.round(v.duration||0) : null,
      rate: v ? v.playbackRate : null, paused: v ? v.paused : null
    });
  } catch(e) { return null; }
})()`;

const CX_EXPR = `(function(){
  try {
    var rp = Array.from(document.querySelectorAll('span.roundpoint'));
    var blue = rp.filter(function(e){ return /blue/.test(e.className); }).length;
    var todo = rp.filter(function(e){ return /orange01|jobCount/.test(e.className); }).length;
    function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
    var v = f(document);
    return JSON.stringify({ done: blue, todo: todo, total: blue + todo,
      cur: v ? Math.round(v.currentTime) : null, dur: v ? Math.round(v.duration||0) : null });
  } catch(e) { return null; }
})()`;

const SS_EXPR = `(function(){
  function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
  var v = f(document); var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  return JSON.stringify({ cur: v?Math.round(v.currentTime):null, dur: v?Math.round(v.duration||0):null, rate: v?v.playbackRate:null, title: t.slice(0,24) });
})()`;

async function ssAll() {
  try {
    const list = await (await fetch('http://127.0.0.1:9224/json/list', { signal: AbortSignal.timeout(8000) })).json();
    const pages = list.filter(t => t.type === 'page' && /shengshengketang/.test(t.url));
    const out = [];
    for (const p of pages) {
      try {
        const ws = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 8000); });
        let i = 0;
        const send = (m, pr = {}) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), 10000); });
        const r = await send('Runtime.evaluate', { expression: SS_EXPR, returnByValue: true });
        ws.close();
        if (r && r.result && r.result.result) out.push(JSON.parse(r.result.result.value));
      } catch (e) { }
    }
    return out;
  } catch (e) { return []; }
}

human('=== 三平台进度记录器启动（每 ' + EVERY + ' 秒一条）===');
for (;;) {
  const snap = { ts: new Date().toISOString() };
  const cc = await withTab(9228, /ccjyxy/, CC_EXPR);
  const cx = await withTab(9227, /chaoxing/, CX_EXPR);
  const ss = await ssAll();
  try { snap.cc = cc ? JSON.parse(cc) : null; } catch (_) { snap.cc = null; }
  try { snap.cx = cx ? JSON.parse(cx) : null; } catch (_) { snap.cx = null; }
  snap.ss = ss;
  try { appendFileSync('runs/progress.jsonl', JSON.stringify(snap) + '\n'); } catch (_) { }

  const c1 = snap.cc ? `长春 学时${snap.cc.learned}/90 完成${snap.cc.done}/90 当前段${snap.cc.cur}/${snap.cc.dur}@${snap.cc.rate}x${snap.cc.paused ? '(停)' : ''}` : '长春 ✗';
  const c2 = snap.cx ? `学习通 ${snap.cx.done}/${snap.cx.todo + snap.cx.done} 已完成（待做${snap.cx.todo}）视频${snap.cx.cur}/${snap.cx.dur}` : '学习通 ✗';
  const c3 = ss.length ? 'shengsheng ' + ss.map(s => `${s.cur}/${s.dur}@${s.rate}x`).join(' · ') : 'shengsheng ✗';
  human(c1 + '   |   ' + c2 + '   |   ' + c3);

  await new Promise(r => setTimeout(r, EVERY * 1000));
}
