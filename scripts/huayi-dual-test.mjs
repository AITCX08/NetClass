// dual-account-test.mjs —— 两个实例（两账号）同时播放验证
const P1 = 9231;   // 白云晴
const P2 = 9250;   // 陈金泽
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });

async function attachPlayer(port) {
  const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = l.filter(x => x.type === 'page' && /CoursePlay/.test(x.url))[0];
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (me, pa = {}, to = 25000) => new Promise(res => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
  });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { ws, send, ev, url: t.url };
}

const G = `(function(){
  var v = document.querySelector('video');
  var dlg = /您有其他课程正在播放/.test(document.body.innerText||'');
  var err = /播放行为异常|已停止播放/.test(document.body.innerText||'');
  if (!v) return JSON.stringify({v:0, dlg:dlg, err:err});
  var b = v.buffered;
  return JSON.stringify({
    v: 1,
    t: Math.round(v.currentTime*10)/10,
    d: Math.round(v.duration||0),
    r: v.playbackRate,
    pa: v.paused,
    pct: Math.round(v.currentTime/(v.duration||1)*1000)/10,
    buf: b.length ? Math.round(b.end(b.length-1)) : 0,
    plat: (window.NetClass && window.NetClass.state && window.NetClass.state.platform) || null,
    panel: !!Array.from(document.querySelectorAll('div')).filter(function(x){return /NetClass v/.test(x.innerText||'')}).length,
    dlg: dlg, err: err
  });
})()`;

console.log('=== 实例 ===');
const h1 = await attachPlayer(P1);
const h2 = await attachPlayer(P2);
console.log('  ' + P1 + ' (白云晴): ' + (h1 ? h1.url.match(/courseware_id=(\w{8})/)[1] : 'NO PLAYER'));
console.log('  ' + P2 + ' (陈金泽): ' + (h2 ? h2.url.match(/courseware_id=(\w{8})/)[1] : 'NO PLAYER'));
if (!h1 || !h2) { console.log('\n缺播放器，无法并行测试'); process.exit(0); }

// 都强制 1x 并播放
for (const h of [h1, h2]) {
  await h.ev(`(function(){var v=document.querySelector('video');if(!v)return 0;try{v.playbackRate=1;}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){});return 1})()`);
}
await sleep(2500);

const s1 = JSON.parse(await h1.ev(G) || '{}');
const s2 = JSON.parse(await h2.ev(G) || '{}');
console.log('\n=== 起始 ===');
console.log('  [1] ' + JSON.stringify(s1));
console.log('  [2] ' + JSON.stringify(s2));

const t0 = Date.now();
console.log('\n=== 并行采样（每 15s × 5 轮）===');
for (let i = 1; i <= 5; i++) {
  await sleep(15000);
  const wall = (Date.now() - t0) / 1000;
  const a = JSON.parse(await h1.ev(G) || '{}');
  const b = JSON.parse(await h2.ev(G) || '{}');
  const fa = a.v ? `t=${a.t} adv=${(a.t - s1.t).toFixed(1)} eff=${((a.t - s1.t) / wall).toFixed(2)} r=${a.r} pa=${a.pa} ${a.pct}%` : `NO_VIDEO dlg=${a.dlg} err=${a.err}`;
  const fb = b.v ? `t=${b.t} adv=${(b.t - s2.t).toFixed(1)} eff=${((b.t - s2.t) / wall).toFixed(2)} r=${b.r} pa=${b.pa} ${b.pct}%` : `NO_VIDEO dlg=${b.dlg} err=${b.err}`;
  console.log(`  +${wall.toFixed(0)}s`);
  console.log(`    [1 白云晴] ${fa}  dlg=${a.dlg} err=${a.err}`);
  console.log(`    [2 陈金泽] ${fb}  dlg=${b.dlg} err=${b.err}`);
}

console.log('\n=== 终态 ===');
const f1 = JSON.parse(await h1.ev(G) || '{}');
const f2 = JSON.parse(await h2.ev(G) || '{}');
console.log('  [1] ' + JSON.stringify(f1));
console.log('  [2] ' + JSON.stringify(f2));

for (const [n, h] of [['acc1', h1], ['acc2', h2]]) {
  const s = await h.send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) { fs.writeFileSync(`${OUT}/parallel-${n}.png`, Buffer.from(s.result.data, 'base64')); console.log('  📸 parallel-' + n + '.png'); }
}
h1.ws.close(); h2.ws.close();
