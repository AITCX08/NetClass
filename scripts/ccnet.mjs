/** ccnet.mjs — 抓长春播放页的网络请求：点播放后把所有 media/api 请求与状态码打出来 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const page = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 20000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id && x.method !== 'Network.requestWillBeSent' && x.method !== 'Network.responseReceived' && x.method !== 'Network.loadingFailed') { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const reqs = [];
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/m3u8|\.ts|media|video|stream|play|study|learn|course|token/i.test(u) && !/\.js|\.css|\.png|\.woff/i.test(u))
      reqs.push({ k: 'req', url: u.slice(0, 110) });
  } else if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/m3u8|\.ts|media|video|stream|play|study|learn|course|token/i.test(u) && !/\.js|\.css|\.png|\.woff/i.test(u))
      reqs.push({ k: 'res', status: m.params.response.status, url: u.slice(0, 100) });
  } else if (m.method === 'Network.loadingFailed') {
    reqs.push({ k: 'FAIL', err: String(m.params.errorText).slice(0, 50), type: m.params.type });
  }
});
await send('Network.enable');

console.log('起点: ' + String(await ev('JSON.stringify({url:location.href.slice(-24), len:(document.body.innerText||"").length})')));

// 若在播放器页，直接观察；否则尝试进课程
const st = await ev('JSON.stringify((function(){var t=(document.body.innerText||"");return {onPlayer:/返回课程列表/.test(t),onCourse:/返回培训内容列表/.test(t),plays:Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)}).length};})())');
console.log('页态: ' + st);
const o = JSON.parse(st);

if (o.onPlayer) {
  console.log('已在播放器页 → 触发播放并抓包 25 秒');
  await ev('(function(){var els=Array.from(document.querySelectorAll(".video-js"));if(els[0]&&els[0].player){els[0].player.muted(true);els[0].player.play();}return "ok"})()');
} else if (o.plays > 0) {
  console.log('在课程页（' + o.plays + ' 个播放）→ 点第一个并抓包');
  const box = await ev('JSON.stringify((function(){var b=Array.from(document.querySelectorAll("button,a,div,span")).filter(function(e){return (e.innerText||"").trim()==="播放"&&(e.offsetWidth||e.offsetHeight)})[0];if(!b)return null;b.scrollIntoView({block:"center"});var r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})())');
  if (box && box !== 'null') {
    const b = JSON.parse(box);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    console.log('已点播放按钮');
  }
} else {
  console.log('既不在播放器页也不在课程页 —— 需要先导航');
}
await sleep(25000);
console.log('=== 抓到的请求（' + reqs.length + ' 条）===');
reqs.slice(0, 30).forEach(r => console.log('  ' + JSON.stringify(r).slice(0, 170)));
const vs = await ev('JSON.stringify((function(){function f(r){try{var v=r.querySelector&&r.querySelector("video");if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll("iframe"):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}var v=f(document);return v?{cur:Math.round(v.currentTime),dur:Math.round(v.duration||0),ready:v.readyState,net:v.networkState,paused:v.paused}:null})())');
console.log('结束视频状态: ' + vs);
ws.close();
