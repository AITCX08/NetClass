/** ccseg2.mjs — 回课程页 → 打印段列表 → 点「第二段（未完成那个）」的播放 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, pr = {}, ms = 12000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function realClick(finder) {
  const box = await ev(finder);
  if (!box || box === 'null') return null;
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  return b;
}
console.log('起点: ' + String(await ev('(function(){var t=(document.body.innerText||"").replace(/\\s+/g," ");return t.slice(0,70)})()')));

// ① 回课程页（点「返回课程列表」）
await realClick('JSON.stringify((function(){var b=Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="返回课程列表"&&(e.offsetWidth||e.offsetHeight)})[0];if(!b)return null;var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})())');
await sleep(8000);

// ② 打印段列表
const segs = await ev('JSON.stringify((function(){' +
  'var items=Array.from(document.querySelectorAll(".MuiListItem-root,.MuiListItemButton-root"));' +
  'return items.map(function(e,i){var btns=Array.from(e.querySelectorAll("button")).map(function(b){return (b.innerText||"").trim()});' +
  'var r=e.getBoundingClientRect();return {i:i,text:(e.innerText||"").replace(/\\s+/g," ").trim().slice(0,60),btns:btns,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}).filter(function(x){return x.btns.length>0;});' +
  '})())');
console.log('段列表: ' + String(segs).slice(0, 600));

// ③ 点第二个「播放/继续」按钮（未完成的那个）
const hit = await ev('JSON.stringify((function(){' +
  'var items=Array.from(document.querySelectorAll(".MuiListItem-root,.MuiListItemButton-root"));' +
  'var picked=[];' +
  'items.forEach(function(e,i){var b=Array.from(e.querySelectorAll("button")).find(function(x){return /^(播放|继续)$/.test((x.innerText||"").trim())});if(b)picked.push({i:i,e:e,b:b});});' +
  'if(!picked.length){var b2=Array.from(document.querySelectorAll("button")).find(function(x){return /^(播放|继续)$/.test((x.innerText||"").trim())});if(b2){var r2=b2.getBoundingClientRect();return {x:Math.round(r2.left+r2.width/2),y:Math.round(r2.top+r2.height/2),t:"loose"};}return null;}' +
  'var t=picked.length>1?picked[1]:picked[0];var r=t.b.getBoundingClientRect();' +
  'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),t:(t.e.innerText||"").replace(/\\s+/g," ").trim().slice(0,40),idx:t.i,total:picked.length};' +
  '})())');
console.log('选中: ' + String(hit));
if (hit && hit !== 'null') {
  const b = JSON.parse(hit);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  console.log('已点击' + (b.t ? ' → ' + b.t : ''));
}
await sleep(10000);
console.log('点后视频: ' + String(await ev('(function(){var v=document.querySelector("video");return v?JSON.stringify({cur:Math.round(v.currentTime),dur:Math.round(v.duration||0),src:String(v.currentSrc||"").slice(-20)}):"no-video"})()')));
ws.close();
