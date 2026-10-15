/** ccpassive.mjs — 纯被动抓包 40 秒：不做任何交互，只看上报/流请求的状态 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 10000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };

const reqs = new Map(), log = [];
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.method === 'Network.requestWillBeSent') {
    reqs.set(m.params.requestId, m.params.request.url);
    if (/video-progress|media\/play|playback-session/.test(m.params.request.url)) log.push({ t: 'req', u: m.params.request.url.replace('https://col.ccjyxy.cn', '').slice(0, 60) });
  } else if (m.method === 'Network.responseReceived') {
    if (/video-progress|media\/play|playback-session/.test(m.params.response.url)) log.push({ t: 'res', s: m.params.response.status, u: m.params.response.url.replace('https://col.ccjyxy.cn', '').slice(0, 60) });
  } else if (m.method === 'Network.loadingFailed') {
    const u = reqs.get(m.params.requestId) || '?';
    if (/video-progress|media\/play|playback-session|ccjyxy/.test(u)) log.push({ t: 'FAIL', u: u.replace('https://col.ccjyxy.cn', '').slice(0, 60), err: m.params.errorText, cors: !!m.params.corsErrorStatus });
  }
});
await send('Network.enable');
console.log('起点: ' + String(await ev('JSON.stringify((function(){var v=document.querySelector("video");return {cur:v?Math.round(v.currentTime):null,rate:v?v.playbackRate:null,paused:v?v.paused:null,rdy:v?v.readyState:null,hunt:!!window.__ccHunt};})())')));
await new Promise(r => setTimeout(r, 40000));
console.log('=== 40 秒内相关请求（' + log.length + ' 条）===');
log.slice(0, 20).forEach(x => console.log('  ' + JSON.stringify(x)));
console.log('结束: ' + String(await ev('JSON.stringify((function(){var v=document.querySelector("video");return {cur:v?Math.round(v.currentTime):null,rate:v?v.playbackRate:null,paused:v?v.paused:null,rdy:v?v.readyState:null};})())')));
ws.close();
