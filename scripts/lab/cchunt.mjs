/** cchunt.mjs — 单连接内高频猎捕播放器：视频一出现就立刻起播，并持续维持 90 秒 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const page = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 8000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { try { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; } catch (err) { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 页内常驻"猎捕器"：每 300ms 检查一次，视频一出现就 muted + 限倍速 + play()
const HUNTER = `(function(){
  if (window.__ccHunt) return 'already';
  window.__ccLog = [];
  window.__ccHunt = setInterval(function(){
    function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
    var v = f(document); if (!v) return;
    try { v.muted = true; } catch(e){}
    try { if (v.playbackRate !== 2) v.playbackRate = 2; } catch(e){}
    if (v.paused) { try { v.play().catch(function(){}); } catch(e){} }
    if (!v.__ccHooked) {
      v.__ccHooked = 1;
      v.addEventListener('playing', function(){ window.__ccLog.push('playing@' + Math.round(v.currentTime)); });
      v.addEventListener('pause', function(){ window.__ccLog.push('pause@' + Math.round(v.currentTime)); });
      v.addEventListener('ratechange', function(){ window.__ccLog.push('rate=' + v.playbackRate); });
    }
  }, 300);
  return 'installed';
})()`;
console.log('装猎捕器: ' + await ev(HUNTER));

// 确保在课程页并点击「播放」按钮（若不在播放器）
const st = await ev('JSON.stringify((function(){var t=document.body.innerText||"";return {onPlayer:/返回课程列表/.test(t),plays:Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)}).length};})())');
console.log('页态: ' + st);
const o = st ? JSON.parse(st) : {};
if (!o.onPlayer && o.plays > 0) {
  const box = await ev('JSON.stringify((function(){var b=Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)})[0];if(!b)return null;b.scrollIntoView({block:"center"});var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})())');
  if (box && box !== 'null') {
    const b = JSON.parse(box);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    console.log('已点「播放」');
  }
}
console.log('观察 90 秒（每 6 秒采样）:');
for (let k = 1; k <= 15; k++) {
  await sleep(6000);
  const s = await ev('JSON.stringify((function(){function f(r){try{var v=r.querySelector&&r.querySelector("video");if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll("iframe"):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}var v=f(document);return {v:v?Math.round(v.currentTime)+"/"+Math.round(v.duration||0)+" rdy"+v.readyState+(v.paused?" 停":" 播")+" @"+v.playbackRate:null, log:(window.__ccLog||[]).slice(-3)};})())');
  console.log('  ' + (k * 6) + 's: ' + s);
}
ws.close();
