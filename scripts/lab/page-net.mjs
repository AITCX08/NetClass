/** 抓取指定标签的网络活动：找出卡住的请求（pending/failed） */
const PORT = Number(process.argv[2] || 9226);
const MATCH = process.argv[3] || 'zjdx-kfkc';
const WAIT = Number(process.argv[4] || 18) * 1000;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes(MATCH));
if (!p) { console.log('无匹配标签'); process.exit(0); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 25000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const reqs = new Map(), failed = [], finished = [];
ws.addEventListener('message', ev => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  const P = m.params || {};
  if (m.method === 'Network.requestWillBeSent') reqs.set(P.requestId, String(P.request.url).slice(0, 110));
  if (m.method === 'Network.loadingFailed') failed.push((reqs.get(P.requestId) || P.requestId) + ' :: ' + String(P.errorText).slice(0, 60));
  if (m.method === 'Network.loadingFinished') finished.push(reqs.get(P.requestId) || P.requestId);
});
await send('Network.enable');
await send('Page.enable');
console.log('重载: ' + String(p.url).slice(0, 80));
await send('Page.navigate', { url: p.url });
await new Promise(r => setTimeout(r, WAIT));
console.log('== 已完成 ' + finished.length + ' 个请求；失败 ' + failed.length + ' 个 ==');
console.log('--- 失败 ---'); failed.slice(0, 10).forEach(f => console.log('  ' + f));
const pending = [...reqs.entries()].filter(([id]) => !finished.includes(reqs.get(id)));
console.log('--- 仍在挂起（' + pending.length + '）---');
pending.slice(0, 12).forEach(([id, u]) => console.log('  ' + u));
const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({t:document.title,ready:document.readyState,body:(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,400)})', returnByValue: true }, 15000);
console.log('求值: ' + (r.timeout ? '超时' : String((r.result && r.result.result && r.result.result.value) || '').slice(0, 500)));
ws.close();
