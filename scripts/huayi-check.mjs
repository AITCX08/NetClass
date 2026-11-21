// check-both.mjs —— 检查两个端口的播放状态并确保 1x 播放
const PORTS = [9231, 9250];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROBE = `(function(){
  var v = document.querySelector('video');
  if (!v) return JSON.stringify({v:0});
  return JSON.stringify({
    v:1,
    t: Math.round(v.currentTime),
    d: Math.round(v.duration||0),
    r: v.playbackRate,
    pa: v.paused,
    pct: Math.round(v.currentTime/(v.duration||1)*1000)/10,
    err: /播放行为异常|已停止播放/.test(document.body.innerText||'')
  });
})()`;

for (const port of PORTS) {
  console.log('\n=== ' + port + ' ===');
  let l;
  try {
    l = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) })).json();
  } catch (e) { console.log('  ❌ CDP 不通: ' + e.message); continue; }

  const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
  const t = pages.find(x => /CoursePlay/.test(x.url));
  if (!t) { console.log('  没有 CoursePlay 页，标签: ' + pages.map(p => p.url.slice(0, 50)).join(' | ')); continue; }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (me, pa = {}, to = 20000) => new Promise(res => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
  });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send('Runtime.enable');
  await sleep(600);

  let s = JSON.parse(await ev(PROBE) || '{}');
  console.log('  状态: ' + JSON.stringify(s));

  if (!s.v) { console.log('  无 video'); ws.close(); continue; }

  // 确保 1x + 播放
  await ev(`(function(){var v=document.querySelector('video');if(!v)return 0;try{v.playbackRate=1}catch(e){}var p=v.play();if(p&&p.catch)p.catch(function(){});return 1})()`);
  await sleep(2000);
  s = JSON.parse(await ev(PROBE) || '{}');
  console.log('  修正后: ' + JSON.stringify(s));
  ws.close();
}
