/**
 * cc-diag-report.mjs — 抓 video-progress/report 的请求体与响应（只读，用 CDP Network 域，不动页面 JS）
 *   node runs\cc-diag-report.mjs --port 9228 --target <id或子串> --secs 60
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  A[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
}
const PORT = Number(A.port || 9228);
const SEL = String(A.target || 'ccjyxy');
const SECS = Number(A.secs || 60);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && (x.id === SEL || x.url.includes(SEL)));
if (!t) { console.log('no target'); process.exit(1); }
console.log('tab=' + t.id.slice(0, 8));

const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const hits = [];
const bodies = [];

ws.addEventListener('open', async () => {
  await send('Network.enable', {});
  console.log('Network.enable ok，抓 ' + SECS + 's …');
});
ws.addEventListener('message', async ev => {
  let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url || '';
    if (/video-progress|completions\/check|playback-session/.test(u)) {
      hits.push({ id: m.params.requestId, url: u.replace('https://col.ccjyxy.cn', ''), method: m.params.request.method, body: (m.params.request.postData || '').slice(0, 500), at: new Date().toTimeString().slice(0, 8) });
    }
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url || '';
    const h = hits.find(x => x.id === m.params.requestId);
    if (h) {
      h.status = m.params.response.status;
      try {
        const r = await send('Network.getResponseBody', { requestId: m.params.requestId });
        h.resp = String((r && r.body) || '').slice(0, 400);
      } catch (_) { }
    }
  }
});

setTimeout(() => {
  console.log('=== 抓到 ' + hits.length + ' 条 ===');
  for (const h of hits) console.log(JSON.stringify(h));
  try { ws.close(); } catch (_) { }
  process.exit(0);
}, SECS * 1000);
