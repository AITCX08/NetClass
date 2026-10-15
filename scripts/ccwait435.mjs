/**
 * ccwait435.mjs — 等 course 435 的第二段（resource 1415）播完，并验证"整课结算"这一步
 *
 * 为什么单独写：cctrack.mjs 靠"从 performance 缓冲区找最新播放令牌"来识别当前资源，
 * 但令牌只在播放器重建时才发新的，缓冲区里往往还是**上一个资源的旧令牌** → 会误判。
 * 这里直接盯**指定 resource id** + **培训总账**，不依赖令牌。
 *
 * 用法：node scripts\ccwait435.mjs [--rid=1415] [--mins=70]
 */
const P = 9228;
const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find(a => a.startsWith('--' + k)); return m ? (m.split('=')[1] || m.split(' ')[1]) : d; };
const RID = Number(arg('rid', 1415));
const MINS = Number(arg('mins', 70));

const { appendFileSync, mkdirSync } = await import('node:fs');
mkdirSync('runs', { recursive: true });
const log = (m) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + m;
  console.log(line);
  try { appendFileSync('runs/ccwait435.log', line + '\n'); } catch (_) { }
};

async function withTab(fn) {
  const list = await (await fetch(`http://127.0.0.1:${P}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
  const p = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
  if (!p) return null;
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 8000); });
  let i = 0;
  const send = (m, pr = {}, ms = 15000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
  try { return await fn(ev); } finally { try { ws.close(); } catch (_) { } }
}

const PROBE = `(async function(){
  try {
    var tk = localStorage.getItem('access_token');
    var H = { 'Accept': 'application/json', 'Authorization': 'Bearer ' + tk };
    var out = {};
    var r1 = await fetch('/api/v1/video-progress/resource?resource_id=${RID}', { credentials:'include', headers: H });
    out.res = await r1.json();
    var r2 = await fetch('/api/v1/me/my-trainings-progress', { credentials:'include', headers: H });
    var t = await r2.text();
    var m = t.match(/"earned_score":([0-9.]+).*?"learned_score":([0-9.]+).*?"completed_courses":(\\d+),"total_courses":(\\d+)/);
    out.training = m ? { earned:m[1], learned:m[2], done:m[3], total:m[4] } : null;
    var r3 = await fetch('/api/v1/completions/my', { credentials:'include', headers: H });
    var ct = await r3.text();
    try { out.completions = JSON.parse(ct).length; } catch(e) { out.completions = -1; }
    var v = document.querySelector('video');
    out.video = v ? { cur: Math.round(v.currentTime), dur: Math.round(v.duration||0), rate: v.playbackRate, paused: v.paused, ready: v.readyState } : null;
    return JSON.stringify(out);
  } catch(e) { return JSON.stringify({ err: String(e).slice(0,80) }); }
})()`;

log('=== 盯 resource ' + RID + ' 到 completed，并验证整课结算（最多 ' + MINS + ' 分钟）===');
let won = false;
for (let k = 0; k < MINS; k++) {
  let d = null;
  try {
    const raw = await withTab(ev => ev(PROBE));
    d = raw ? JSON.parse(raw) : null;
  } catch (_) { }
  if (!d) { log('⚠ 页面不可达/解析失败，等 60s'); await new Promise(r => setTimeout(r, 60000)); continue; }
  if (d.err) { log('⚠ ' + d.err); await new Promise(r => setTimeout(r, 60000)); continue; }
  const res = d.res || {};
  const pct = res.duration_sec ? Math.round(res.max_position_sec / res.duration_sec * 100) : 0;
  log('res' + RID + ' 记账 ' + Math.round(res.max_position_sec || 0) + '/' + Math.round(res.duration_sec || 0) + ' (' + pct + '%) done=' + res.completed +
    ' | 视频 ' + (d.video ? d.video.cur + '/' + d.video.dur + ' @' + d.video.rate + (d.video.paused ? ' 停' : ' 播') + ' rdy' + d.video.ready : 'n/a') +
    ' | 学时 earned=' + (d.training ? d.training.earned : '?') + ' learned=' + (d.training ? d.training.learned : '?') +
    ' 完成=' + (d.training ? d.training.done + '/' + d.training.total : '?') + ' completions=' + d.completions);
  if (res.completed === true) {
    log('🎉 resource ' + RID + ' 已 completed=true');
    won = true;
  }
  if (d.training && d.training.learned !== '0.0' && d.training.learned !== '0') {
    log('🏆🏆🏆 整课结算发生！learned_score 从 0 变成 ' + d.training.learned + '，completed_courses=' + d.training.done);
    log('   完整证据: ' + JSON.stringify(d));
    break;
  }
  if (won && d.completions > 0) {
    log('🏆 completions 非空（' + d.completions + ' 条）→ 闭环成立');
    log('   完整证据: ' + JSON.stringify(d));
    break;
  }
  await new Promise(r => setTimeout(r, 60000));
}
log(won ? '=== 追踪结束（资源已完成，学时未变 → 说明要等整课两段都完成才算）===' : '=== 窗口结束 ===');
