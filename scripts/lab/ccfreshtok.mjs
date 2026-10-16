/** ccfreshtok.mjs — 抓一个"新鲜的"播放令牌，看当前真正在播哪个资源 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 10000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };

let freshTok = null, now = Math.floor(Date.now() / 1000);
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.method === 'Network.requestWillBeSent') {
    const mm = String(m.params.request.url).match(/\/api\/v1\/media\/play\/([^/]+)\//);
    if (mm) freshTok = mm[1];
  }
});
await send('Network.enable');
console.log('等待新的 media/play 请求（最多 60 秒）…');
for (let k = 0; k < 12 && !freshTok; k++) await new Promise(r => setTimeout(r, 5000));

const out = { now: now };
if (freshTok) {
  try {
    const pl = JSON.parse(Buffer.from(freshTok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    out.fresh = { course_id: pl.course_id, resource_id: pl.resource_id, iat: pl.iat, ageSec: now - pl.iat };
  } catch (e) { out.err = String(e).slice(0, 60); }
} else { out.fresh = 'none-in-60s'; }
// 顺便看页面上显示的段名
out.pageSeg = await ev(`(function(){var t=(document.body.innerText||'').replace(/\\s+/g,' ');var m=t.match(/课程：([^ ]{4,40})/);return m?m[1]:t.slice(0,80);})()`);
out.video = await ev(`(function(){var v=document.querySelector('video');return v?JSON.stringify({cur:Math.round(v.currentTime),dur:Math.round(v.duration||0),rate:v.playbackRate,paused:v.paused}):null;})()`);
console.log(JSON.stringify(out));
ws.close();
