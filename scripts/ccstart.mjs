/** ccstart.mjs — 同一连接内：点「播放」→ 等 video 出现 → 起播 → 观察是否持续 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const page = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 12000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FIND = `(function(){function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}return f(document)})()`;
const ST = `(function(){
  var v = ${FIND};
  return JSON.stringify({ video: v?Math.round(v.currentTime)+'/'+Math.round(v.duration||0)+' @'+v.playbackRate+(v.paused?' 停':' 播'):null, len:(document.body.innerText||'').length });
})()`;
console.log('标签 ' + page.id.slice(0, 6) + ' 起点: ' + String(await ev(ST)).slice(0, 100));

// 1) 点「播放」
const box = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return (e.innerText||'').trim()==='播放' && (e.offsetWidth||e.offsetHeight); })[0];
  if (!b) return null; b.scrollIntoView({block:'center'}); var r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
})()`);
if (!box) { console.log('没找到播放按钮'); ws.close(); process.exit(0); }
const b = JSON.parse(box);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
console.log('已点播放按钮，等待 video 出现…');

// 2) 轮询等 video 出现并起播（最多 6 次 × 2s）
for (let k = 1; k <= 6; k++) {
  await sleep(2000);
  const started = await ev(`(function(){
    var v = ${FIND};
    if (!v) return 'no-video';
    v.muted = true;
    try { v.playbackRate = 2; } catch(e){}
    if (v.paused) { try { v.play(); } catch(e) { return 'play-err ' + String(e).slice(0,40); } }
    return JSON.stringify({ cur:+v.currentTime.toFixed(1), dur:Math.round(v.duration||0), paused:v.paused, rate:v.playbackRate });
  })()`);
  console.log('  ' + (k*2) + 's: ' + String(started).slice(0, 130));
  if (String(started).indexOf('"paused":false') >= 0) { console.log('  ✅ 起播成功'); break; }
}
// 3) 持续观察 30 秒
for (let k = 1; k <= 3; k++) {
  await sleep(10000);
  console.log('  持续观察 ' + (k*10) + 's: ' + String(await ev(ST)).slice(0, 110));
}
ws.close();
