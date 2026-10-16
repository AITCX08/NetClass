/** cctest.mjs — 在 ccjyxy 上：找「播放」→ 真实点击 → 连续观察 20 秒，看播放器是否出现 */
const list = await (await fetch('http://127.0.0.1:9228/json/list')).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const t = cand[0];
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 15000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROBE = `(function(){
  function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
  var v = f(document); var txt = (document.body.innerText||'').replace(/\\s+/g,' ');
  var plays = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return (e.innerText||'').trim()==='播放' && (e.offsetWidth||e.offsetHeight); });
  var vjs = document.querySelectorAll('[class*=video-js],video').length;
  return JSON.stringify({ plays: plays.length, vjs: vjs, video: v?Math.round(v.currentTime)+'/'+Math.round(v.duration||0)+(v.paused?' 停':' 播'):null, len: txt.length, head: txt.slice(-90) });
})()`;

console.log('标签 ' + t.id.slice(0, 6));
console.log('点前: ' + String(await ev(PROBE)).slice(0, 220));
const box = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return (e.innerText||'').trim()==='播放' && (e.offsetWidth||e.offsetHeight); })[0];
  if (!b) return null; b.scrollIntoView({block:'center'}); var r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), tag: b.tagName });
})()`);
console.log('按钮: ' + box);
if (box) {
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 4; k++) {
    await sleep(5000);
    console.log((k * 5) + 's: ' + String(await ev(PROBE)).slice(0, 220));
  }
}
ws.close();
