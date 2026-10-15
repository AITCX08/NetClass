/** ccfull.mjs — 完整链路：真实鼠标点课程卡片 → 进课程 → 点播放 → 观察 36 秒 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const page = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 12000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { try { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; } catch (err) { return 'eval-err'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function realClick(finder) {
  const box = await ev(finder);
  if (!box || box === 'null' || box === 'eval-err') return null;
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  return b;
}
const SNAP = 'JSON.stringify((function(){' +
  'function f(r){try{var v=r.querySelector&&r.querySelector("video");if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll("iframe"):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}' +
  'var v=f(document);var t=(document.body.innerText||"").replace(/\\s+/g," ");' +
  'var plays=Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)}).length;' +
  'return {v:v?(Math.round(v.currentTime)+"/"+Math.round(v.duration||0)+(v.paused?" 停":" 播")):null,plays:plays,len:t.length};})())';

await send('Page.bringToFront');
console.log('起点: ' + String(await ev(SNAP)).slice(0, 110));

// 1) 点第一个课程卡片（真实鼠标）
const CARD = 'JSON.stringify((function(){' +
  'var el=Array.from(document.querySelectorAll("div,li,article,section")).find(function(e){var t=(e.innerText||"").replace(/\\s+/g," ").trim();return /编码[:：]/.test(t)&&/学时/.test(t)&&t.length<140;});' +
  'if(!el)return null;el.scrollIntoView({block:"center"});var r=el.getBoundingClientRect();' +
  'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(30,r.height/2)),t:(el.innerText||"").slice(0,24)};})())';
const c = await realClick(CARD);
console.log('课程卡片: ' + JSON.stringify(c));
await sleep(9000);
console.log('进课后: ' + String(await ev(SNAP)).slice(0, 120));

// 2) 点「播放」
const PLAY = 'JSON.stringify((function(){' +
  'var b=Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)})[0];' +
  'if(!b)return null;b.scrollIntoView({block:"center"});var r=b.getBoundingClientRect();' +
  'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})())';
const pb = await realClick(PLAY);
console.log('播放按钮: ' + JSON.stringify(pb));
console.log('接下来只观察（不干预）:');
for (let k = 1; k <= 10; k++) { await sleep(3000); console.log('  ' + (k * 3) + 's: ' + String(await ev(SNAP)).slice(0, 120)); }
ws.close();
