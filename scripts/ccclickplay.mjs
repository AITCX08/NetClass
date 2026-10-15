/** ccclickplay.mjs — 在 ccjyxy 指定标签上，真实鼠标点第一个「播放」按钮 */
const TARGET_ID = process.argv[2] || null;
const list = await (await fetch('http://127.0.0.1:9228/json/list')).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const t = TARGET_ID ? cand.find(x => x.id.startsWith(TARGET_ID)) : cand[0];
if (!t) { console.log('没找到标签'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 15000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };

const box = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('button,a,div,span')).find(function(e){ return (e.innerText||'').trim()==='播放' && (e.offsetWidth||e.offsetHeight); });
  if (!b) return null;
  b.scrollIntoView({block:'center'});
  var r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
})()`);
console.log('标签 ' + t.id.slice(0, 6) + '，播放按钮: ' + box);
if (box) {
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  console.log('已点击');
  await new Promise(r => setTimeout(r, 9000));
  console.log('点击后: ' + String(await ev(`(function(){
    function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
    var v=f(document); var t=(document.body.innerText||'').replace(/\\s+/g,' ');
    return JSON.stringify({ video: v?Math.round(v.currentTime)+'/'+Math.round(v.duration||0)+(v.paused?' 停':' 播'):null, head: t.slice(0,80) });
  })()`)));
}
ws.close();
