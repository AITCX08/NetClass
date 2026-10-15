/**
 * cx-net-probe.mjs — 抓视频加载期的网络请求（找视频为什么不下载）
 *   node scripts/cx-net-probe.mjs --port 9227 --secs 40
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const SECS = Number(A.secs || 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url));
if (!p) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 20000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const reqs = new Map();
ws.addEventListener('message', ev => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/cldisk|\.mp4|\.m3u8|\.ts\b|video|cldisk/.test(u)) reqs.set(m.params.requestId, { url: u.slice(0, 130), t: Date.now(), method: m.params.request.method });
  }
  if (m.method === 'Network.responseReceived' && reqs.has(m.params.requestId)) {
    const r = reqs.get(m.params.requestId);
    r.status = m.params.response.status;
    r.mime = m.params.response.mimeType;
    r.fromCache = m.params.response.fromDiskCache;
  }
  if (m.method === 'Network.loadingFailed' && reqs.has(m.params.requestId)) {
    const r = reqs.get(m.params.requestId);
    r.failed = m.params.errorText + ' blocked=' + m.params.blockedReason;
  }
});
await send('Network.enable');
// 触发一次播放尝试
const ev = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true });
await ev(`(function(){ function f(r){ var v=r.querySelector&&r.querySelector('video'); if(v) return v; var fs=Array.from(r.querySelectorAll('iframe')); for(var i=0;i<fs.length;i++){ var d=null; try{d=fs[i].contentDocument}catch(e){} if(d){ var q=f(d); if(q) return q; } } return null; } var v=f(document); if(v){ v.muted=true; try{ v.load(); }catch(e){} try{ var pr=v.play(); if(pr&&pr.catch) pr.catch(function(){}); }catch(e){} return 'played'; } return 'novideo'; })()`);
console.log('已触发播放，抓包 ' + SECS + 's ...');
await sleep(SECS * 1000);
const rows = Array.from(reqs.values());
console.log('媒体/视频相关请求 ' + rows.length + ' 条：');
for (const r of rows.slice(-25)) console.log('  [' + (r.status || '--') + (r.failed ? ' FAIL:' + r.failed : '') + '] ' + (r.mime || '') + '  ' + r.url);
if (!rows.length) console.log('  （完全没有媒体请求 → 说明 play() 没能触发取流）');
ws.close();
