/**
 * ss-parallel-speed.mjs — ①验证同浏览器两个课程页并行是否真推进 ②实测倍速上限
 *   node scripts/ss-parallel-speed.mjs 9224 [观察秒数]
 */
const PORT = Number(process.argv[2] || 9224);
const OBS = Number(process.argv[3] || 30);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page' && String(t.url).includes('shengshengketang'));

async function connect(p) {
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (method, params = {}, ms = 15000) => new Promise(res => {
    const id = ++seq;
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res({ timeout: true }), ms);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.timeout ? 'TIMEOUT' : (r.result && r.result.result ? r.result.result.value : JSON.stringify(r).slice(0, 150));
  };
  return { ws, ev };
}

const SAMPLE = `(function(){
  var v = document.querySelector('video');
  var st = window.NetClass ? NetClass.state : null;
  return JSON.stringify({
    t: Date.now(), cur: v ? +v.currentTime.toFixed(1) : null, rate: v ? v.playbackRate : null,
    paused: v ? v.paused : null, fix: st ? st.video.rateFixes : null, ended: st ? st.video.ended : null,
    lesson: (document.querySelector('.lesson-active,.lesson-item.active,[class*=active]')||{}).innerText ? String(document.querySelector('.lesson-active,.lesson-item.active').innerText).replace(/\\s+/g,' ').slice(0,26) : null
  });
})()`;

const conns = [];
for (const p of pages) conns.push({ id: p.id.slice(0, 8), url: p.url, ...(await connect(p)) });

console.log('=== T0 采样 ===');
const t0 = [];
for (const c of conns) { const s = JSON.parse(await c.ev(SAMPLE)); t0.push(s); console.log('  ' + c.id + '  cur=' + s.cur + ' rate=' + s.rate + ' fix=' + s.fix + ' paused=' + s.paused); }

console.log('\n=== 倍速上限实测（在第一个页面）===');
const c0 = conns[0];
for (const r of [1.5, 2, 2.5, 3, 4]) {
  const applied = await c0.ev(`(function(){
    var v = document.querySelector('video'); if (!v) return 'no-video';
    try { if (window.NetClass && NetClass.rate) { NetClass.rate(${r}); } else { v.playbackRate = ${r}; } } catch(e){ return 'ERR '+e.message; }
    v.playbackRate = ${r};
    return 'set ' + ${r};
  })()`);
  await new Promise(x => setTimeout(x, 4000));
  const back = await c0.ev(`(function(){ var v=document.querySelector('video'); var st=window.NetClass?NetClass.state:null; return JSON.stringify({req:${r}, actual: v?v.playbackRate:null, paused: v?v.paused:null, fix: st?st.video.rateFixes:null}) })()`);
  console.log('  请求 ' + r + 'x → ' + String(back).slice(0, 120) + '   (' + applied + ')');
}

console.log('\n=== 站点播放器自带倍速档位 ===');
console.log('  ' + String(await c0.ev(`(function(){
  var out = [];
  document.querySelectorAll('[class*=rate],[class*=speed],[class*=倍速],li,span').forEach(function(e){
    var t = (e.innerText||'').trim();
    if (/^(0\\.5|0\\.75|1\\.0|1|1\\.25|1\\.5|1\\.75|2|2\\.5|3)x?$/.test(t)) out.push(t);
  });
  return JSON.stringify(Array.from(new Set(out)).slice(0, 12));
})()`)).slice(0, 200));

console.log('\n=== 并行推进验证（观察 ' + OBS + ' 秒）===');
await new Promise(x => setTimeout(x, OBS * 1000));
for (let i = 0; i < conns.length; i++) {
  const c = conns[i];
  const s = JSON.parse(await c.ev(SAMPLE));
  const dCur = (s.cur - t0[i].cur).toFixed(1);
  const wall = ((s.t - t0[i].t) / 1000).toFixed(1);
  console.log('  ' + c.id + '  墙钟 ' + wall + 's，视频推进 ' + dCur + 's（实测倍速 ' + (dCur / wall).toFixed(2) + 'x）rate=' + s.rate + ' paused=' + s.paused);
}
for (const c of conns) c.ws.close();
