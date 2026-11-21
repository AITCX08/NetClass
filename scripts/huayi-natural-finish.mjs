/**
 * natural-finish.mjs —— 让视频从末尾前 90 秒【自然】播完，触发 TimerPlay 里的 SaveLearningTime
 *
 * 背景（关键）：
 *   TimerPlay 每 tick 检查 (playTime + 10) >= playTotalTime，满足才调 SaveLearningTime(1, playTime, total)。
 *   如果直接 seek 到 duration，定时器可能来不及捕获 → 学习记录不保存 → 首页学时不涨。
 *   → 必须留出足够长的自然播放尾巴。
 *
 * 用法: node runs/natural-finish.mjs <port>
 */
const PORT = Number(process.argv[2] || 9231);
const TAIL = Number(process.argv[3] || 90);   // 留多少秒自然播
const sleep = ms => new Promise(r => setTimeout(r, ms));

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
const t = pages.find(p => /CoursePlay/.test(p.url));
if (!t) { console.log('❌ 没有 CoursePlay'); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
let id = 0; const pend = new Map();
const reqs = [];
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    const ty = m.params.type || '';
    if (ty === 'XHR' || ty === 'Fetch') {
      const u = r.url.replace(/^https?:\/\/[^/]+/, '');
      if (!/\.ts\?|App\.js|\.css|\.png|\.jpg/.test(u)) reqs.push({ m: r.method, u, b: String(r.postData || '').slice(0, 250) });
    }
  }
});
const send = (me, pa = {}, to = 25000) => new Promise(res => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await sleep(700);

console.log('页面: ' + t.url.slice(0, 95));

// ① 当前状态
console.log('① 当前: ' + String(await ev(`(function(){
  var v = document.querySelector('video');
  return JSON.stringify({
    t: v ? Math.round(v.currentTime) : -1,
    d: v ? Math.round(v.duration||0) : -1,
    pa: v ? v.paused : null,
    PlayTime: (document.getElementById('PlayTime')||{}).value,
    learnState: (typeof learnState !== 'undefined' ? learnState : 'undef')
  });
})()`)));

// ② seek 到末尾前 TAIL 秒，恢复 1x 播放
console.log('② seek 到 duration-' + TAIL + ' 并自然播放');
console.log('   ' + String(await ev(`(function(){
  var v = document.querySelector('video');
  if (!v) return 'no video';
  var target = Math.max(0, (v.duration || 0) - ${TAIL});
  try { v.currentTime = target; } catch(e) { return 'seek err: ' + e.message; }
  try { v.playbackRate = 1; } catch(e){}
  var p = v.play(); if (p && p.catch) p.catch(function(){});
  return 'seeked to ' + Math.round(target) + ', playing at 1x';
})()`)));

// ③ 每 10 秒盯一次，直到播完
console.log('\n③ 盯播（每 10s）');
for (let k = 1; k <= 18; k++) {
  await sleep(10000);
  const st = JSON.parse(await ev(`(function(){
    var v = document.querySelector('video');
    return JSON.stringify({
      t: v ? Math.round(v.currentTime) : -1,
      d: v ? Math.round(v.duration||0) : -1,
      pa: v ? v.paused : null,
      PlayTime: (document.getElementById('PlayTime')||{}).value,
      learnState: (typeof learnState !== 'undefined' ? learnState : 'undef'),
      number: (typeof number !== 'undefined' ? number : 'undef'),
      timer: (typeof videoTimer !== 'undefined' ? String(videoTimer).slice(0,16) : 'undef')
    });
  })()`) || '{}');
  console.log('   +' + (k * 10) + 's  t=' + st.t + '/' + st.d + '  pa=' + st.pa + '  PlayTime=' + st.PlayTime + '  learnState=' + st.learnState + '  number=' + st.number + '  timer=' + st.timer);
  if (st.d > 0 && st.t >= st.d - 1) { console.log('   ✅ 已到末尾'); break; }
}

// ④ 再等 8 秒让定时器跑完保存逻辑
await sleep(8000);

console.log('\n④ 最终状态: ' + String(await ev(`(function(){
  var v = document.querySelector('video');
  return JSON.stringify({
    t: v ? Math.round(v.currentTime) : -1,
    d: v ? Math.round(v.duration||0) : -1,
    PlayTime: (document.getElementById('PlayTime')||{}).value,
    learnState: (typeof learnState !== 'undefined' ? learnState : 'undef'),
    learn_state: (document.getElementById('learn_state')||{}).value,
    timer: (typeof videoTimer !== 'undefined' ? String(videoTimer).slice(0,16) : 'undef'),
    bodyHas: /恭喜|完成|已学完|学习完成/.test(document.body.innerText||'')
  }, null, 1);
})()`)));

console.log('\n⑤ 关键 XHR（' + reqs.length + '）:');
reqs.forEach(r => {
  console.log('  ' + r.m + ' ' + r.u.slice(0, 120));
  if (r.b) console.log('     ' + r.b.slice(0, 200));
});

ws.close();
