/** probe-page.mjs — 通用页面探针：查视频/脚本/播放器状态 */
const PORT = Number(process.argv[2] || 9224);
const MATCH = process.argv[3] || 'shengshengketang';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && t.url.includes(MATCH));
for (const t of pages) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error('e')) : p.res(m.result); } });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (mm, pp = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: mm, params: pp })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout')); } }, 15000); }); };
  const expr = `JSON.stringify({
    v: (function(){ var v = document.querySelector('video'); return v ? { rs: v.readyState, t: Math.round(v.currentTime||0), dur: Math.round(v.duration||0), paused: v.paused, muted: v.muted, rate: v.playbackRate } : null; })(),
    playerCls: (function(){ var e = document.querySelector('.video-player'); return e ? String(e.className) : null; })(),
    playerChildCount: (function(){ var e = document.querySelector('.video-player'); return e ? e.children.length : null; })(),
    module: !!window.NetClass,
    lesson: window.NetClass ? window.NetClass.state.currentLesson : null,
    quiz: window.NetClass ? window.NetClass.state.quiz : null
  })`;
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(t.url.slice(0, 70));
    console.log('  ' + (r.result && r.result.value));
  } catch (e) { console.log('  eval failed: ' + e.message); }
  ws.close();
  await sleep(200);
}
