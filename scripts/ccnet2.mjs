/** ccnet2.mjs — 专项：抓播放页所有失败请求的完整信息（URL/类型/错误），并列出 API 调用序列 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const page = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 20000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const reqs = new Map();   // requestId → url
const fails = [];
const apis = [];
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.method === 'Network.requestWillBeSent') {
    reqs.set(m.params.requestId, m.params.request.url);
    if (/\/api\//.test(m.params.request.url)) apis.push({ t: 'req', m: m.params.request.method || 'GET', u: m.params.request.url.replace('https://col.ccjyxy.cn', '').slice(0, 70) });
  } else if (m.method === 'Network.responseReceived') {
    if (/\/api\//.test(m.params.response.url)) apis.push({ t: 'res', s: m.params.response.status, u: m.params.response.url.replace('https://col.ccjyxy.cn', '').slice(0, 70) });
  } else if (m.method === 'Network.loadingFailed') {
    const u = reqs.get(m.params.requestId) || '(unknown)';
    fails.push({ url: u.slice(0, 120), err: m.params.errorText, type: m.params.type, blocked: m.params.blockedReason || null, cors: !!m.params.corsErrorStatus });
  }
});
await send('Network.enable');
console.log('起点: ' + String(await ev('JSON.stringify({len:(document.body.innerText||"").length, onPlayer:/返回课程列表/.test(document.body.innerText||"")})')));

// 触发一次播放（真实鼠标点 .vjs-play-control）
const box = await ev('JSON.stringify((function(){function find(r,path){try{var el=r.querySelector(".vjs-play-control");if(el&&(el.offsetWidth||el.offsetHeight))return {el:el,path:path};var fs=Array.from(r.querySelectorAll("iframe"));for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var res=find(d,path.concat([i]));if(res)return res}}}catch(e){}return null}var res=find(document,[]);if(!res)return null;var w=window,ox=0,oy=0;for(var k=0;k<res.path.length;k++){var f=w.document.querySelectorAll("iframe")[res.path[k]];var fr=f.getBoundingClientRect();ox+=fr.left;oy+=fr.top;w=f.contentWindow}var r=res.el.getBoundingClientRect();return {x:Math.round(ox+r.left+r.width/2),y:Math.round(oy+r.top+r.height/2)};})())');
console.log('Play 按钮: ' + box);
if (box && box !== 'null') {
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  console.log('已点 Play');
}
await sleep(22000);
console.log('=== API 序列 ===');
apis.slice(0, 14).forEach(a => console.log('  ' + JSON.stringify(a)));
console.log('=== 失败请求（' + fails.length + '）===');
fails.slice(0, 10).forEach(f => console.log('  ' + JSON.stringify(f)));
const vs = await ev('JSON.stringify((function(){function f(r){try{var v=r.querySelector&&r.querySelector("video");if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll("iframe"):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}var v=f(document);return v?{cur:Math.round(v.currentTime),dur:Math.round(v.duration||0),ready:v.readyState,paused:v.paused}:null})())');
console.log('结束: ' + vs);
ws.close();
