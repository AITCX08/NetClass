/**
 * cctrack.mjs — 盯死当前资源直到 completed:true（终点验证）
 *
 * 用法：node scripts\cctrack.mjs [--mins 40]
 * 逻辑：① 从页面播放令牌 JWT 解出当前 course_id/resource_id
 *      ② 每 60 秒查一次 /api/v1/video-progress/resource
 *      ③ 出现 completed:true 就打印 + 落盘，并顺带查培训总账与 completions
 */
const P = 9228;
const MINS = Number((process.argv.find(a => a.startsWith('--mins')) || '').split('=')[1] || 40);
const { appendFileSync, mkdirSync } = await import('node:fs');
mkdirSync('runs', { recursive: true });

const log = (m) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + m;
  console.log(line);
  try { appendFileSync('runs/cctrack.log', line + '\n'); } catch (_) { }
};

async function withPage(fn) {
  const list = await (await fetch(`http://127.0.0.1:${P}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
  const p = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
  if (!p) return null;
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 8000); });
  let i = 0;
  const send = (m, pr = {}, ms = 12000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
  try { return await fn(ev); } finally { try { ws.close(); } catch (_) { } }
}

const PROBE = `(async function(){
  try {
    var es = performance.getEntriesByType('resource') || [];
    var tok = null;
    for (var i = es.length - 1; i >= 0; i--) { var m = String(es[i].name).match(/\\/api\\/v1\\/media\\/play\\/([^/]+)\\//); if (m) { tok = m[1]; break; } }
    var info = {};
    if (tok) { var pl = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); info = { course_id: pl.course_id, resource_id: pl.resource_id, iat: pl.iat, exp: pl.exp, tokenAge: Math.round(Date.now()/1000) - pl.iat }; }
    var v = document.querySelector('video');
    info.video = v ? { cur: Math.round(v.currentTime), dur: Math.round(v.duration||0), rate: v.playbackRate, paused: v.paused, ready: v.readyState } : null;
    info.hunt = !!window.__ccHunt;
    var tk = localStorage.getItem('access_token');
    var H = { 'Accept': 'application/json', 'Authorization': 'Bearer ' + tk };
    if (info.resource_id) {
      var r1 = await fetch('/api/v1/video-progress/resource?resource_id=' + info.resource_id, { credentials:'include', headers: H });
      info.resource = await r1.json();
    }
    var r2 = await fetch('/api/v1/me/my-trainings-progress', { credentials:'include', headers: H });
    var t = await r2.text();
    var m2 = t.match(/"learned_score":([0-9.]+).*?"completed_courses":(\\d+)/);
    info.training = m2 ? { learned: m2[1], done: m2[2] } : null;
    var r3 = await fetch('/api/v1/completions/my', { credentials:'include', headers: H });
    var ct = await r3.text();
    try { info.completions = JSON.parse(ct).length; } catch(e) { info.completions = -1; }
    return JSON.stringify(info);
  } catch(e) { return JSON.stringify({ err: String(e).slice(0, 80) }); }
})()`;

log('=== 终点追踪启动（盯当前资源到 completed:true）===');
let lastRid = null, doneSeen = false;
for (let k = 0; k < MINS; k++) {
  const raw = await withPage(ev => ev(PROBE));
  if (!raw) { log('⚠ 页面不可达，等 60s'); await new Promise(r => setTimeout(r, 60000)); continue; }
  let d; try { d = JSON.parse(raw); } catch (_) { d = { err: 'parse' }; }
  if (d.err) { log('⚠ ' + d.err); await new Promise(r => setTimeout(r, 60000)); continue; }
  const res = d.resource || {};
  const pct = res.duration_sec ? Math.round(res.max_position_sec / res.duration_sec * 100) : 0;
  if (d.resource_id !== lastRid) { log('▶ 资源切换 → course=' + d.course_id + ' resource=' + d.resource_id); lastRid = d.resource_id; }
  log('res=' + d.resource_id + ' 平台记账 ' + Math.round(res.max_position_sec || 0) + '/' + Math.round(res.duration_sec || 0) + ' (' + pct + '%) done=' + res.completed +
    '  | 视频 ' + (d.video ? d.video.cur + '/' + d.video.dur + ' @' + d.video.rate + (d.video.paused ? ' 停' : ' 播') + ' rdy' + d.video.ready : 'n/a') +
    '  | 猎捕器=' + d.hunt + '  | 学时=' + (d.training ? d.training.learned : '?') + ' 完成=' + (d.training ? d.training.done : '?') + ' completions=' + d.completions);
  if (res.completed === true || (d.completions && d.completions > 0)) {
    log('🎉🎉 终点达成！资源已完成 / completions 非空');
    log('   完整证据: ' + JSON.stringify(d));
    doneSeen = true;
    break;
  }
  await new Promise(r => setTimeout(r, 60000));
}
log(doneSeen ? '=== 追踪结束：达成 ===' : '=== 追踪窗口结束，仍未 completed ===');
