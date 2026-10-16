/**
 * cx-start.mjs — 点开第一个未完成任务点并起播（静音 + 倍速到底），返回结果与当前页结构
 *   node scripts/cx-start.mjs --port 9227
 */
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=9227').split('=')[1]);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /mooc1\.chaoxing|studentcourse/.test(t.url));
if (!p) { console.log('没有课程页'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 40000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error).slice(0, 140))) : res(x.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => rej(new Error('timeout ' + m)), ms);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) 找第一个任务点（形如 1.1.1.1 / 1.1.1 且未完成），取坐标真点
const box = await ev(`(function(){
  var cands = Array.from(document.querySelectorAll('*')).filter(function(e){
    if (e.children.length > 1) return false;
    var t = (e.innerText||'').replace(/\\s+/g,' ').trim();
    return /^1\\.1\\.1\\.1/.test(t);
  });
  var el = cands[0]; if (!el) return null;
  el.scrollIntoView({block:'center'});
  var r = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), txt: (el.innerText||'').replace(/\\s+/g,' ').slice(0,30) });
})()`);
console.log('任务点坐标: ' + box);
if (box) {
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  console.log('已真实点击');
}
await sleep(13000);

// 2) 新页/新标签落地情况
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const now = tabs.filter(t => t.type === 'page' && /chaoxing/.test(t.url)).map(t => String(t.url).slice(0, 70));
console.log('标签: ' + JSON.stringify(now));

// 3) 找 video 起播
const target = tabs.find(t => t.type === 'page' && /chaoxing/.test(t.url) && /knowledge|mycourse|chapter|work/.test(t.url)) || p;
const ws2 = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws2.addEventListener('open', r));
seq = 0;
const send2 = (m, params = {}, ms = 30000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev2 => { const x = JSON.parse(ev2.data); if (x.id === id) { ws2.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error).slice(0, 120))) : res(x.result); } };
  ws2.addEventListener('message', on);
  ws2.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => rej(new Error('timeout ' + m)), ms);
});
const ev2 = async (e) => (await send2('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
console.log('页面: ' + String(await ev2(`location.href.slice(0,80)`)).slice(0, 80));
console.log('起播: ' + String(await ev2(`(function(){
  var v = document.querySelector('video');
  if (!v) {
    var f = Array.from(document.querySelectorAll('iframe')).map(function(x){return String(x.src||'').slice(0,50)});
    return JSON.stringify({ no: 'video-not-found', iframes: f.slice(0,4), body: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,120) });
  }
  v.muted = true;
  var out = { dur: Math.round(v.duration||0), cur: Math.round(v.currentTime||0) };
  var rates = [2, 1.75, 1.5, 1.25, 1];
  for (var i=0;i<rates.length;i++){ try{ v.playbackRate = rates[i]; }catch(e){} if (Math.abs(v.playbackRate-rates[i])<0.01){ out.rate = rates[i]; break; } }
  if (v.paused) v.play();
  out.paused = v.paused;
  return JSON.stringify(out);
})()`)).slice(0, 300));
ws.close(); ws2.close();
