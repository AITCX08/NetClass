/** cckeep.mjs — 测"播放器保活"：置前标签 → 点播放 → 静观 36 秒（不干预） */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const page = cand[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 12000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { try { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; } catch (err) { return 'eval-err'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SNAP = 'JSON.stringify((function(){' +
  'function f(r){try{var v=r.querySelector&&r.querySelector("video");if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll("iframe"):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}' +
  'var v=f(document);var t=(document.body.innerText||"").replace(/\\s+/g," ");' +
  'var plays=Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)}).length;' +
  'return {v:v?(Math.round(v.currentTime)+"/"+Math.round(v.duration||0)+(v.paused?" 停":" 播")):null,plays:plays,vis:document.visibilityState,len:t.length};' +
  '})())';

await send('Page.bringToFront');
await sleep(1200);
console.log('置前后: ' + String(await ev(SNAP)).slice(0, 130));

const box = await ev('JSON.stringify((function(){' +
  'var b=Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)})[0];' +
  'if(!b)return null;b.scrollIntoView({block:"center"});var r=b.getBoundingClientRect();' +
  'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})())');
console.log('播放按钮: ' + box);
const jb = box && box !== 'null' ? JSON.parse(box) : null;
if (jb) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: jb.x, y: jb.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: jb.x, y: jb.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: jb.x, y: jb.y, button: 'left', clickCount: 1 });
  console.log('已点击播放 —— 接下来 36 秒只观察、不干预');
  for (let k = 1; k <= 12; k++) {
    await sleep(3000);
    console.log('  ' + (k * 3) + 's: ' + String(await ev(SNAP)).slice(0, 130));
  }
} else { console.log('没找到播放按钮（页面可能在别的状态）'); }
ws.close();
