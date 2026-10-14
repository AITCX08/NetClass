/** 处理对话框 + 长超时求值：诊断卡住的页面 */
const PORT = Number(process.argv[2] || 9226);
const MATCH = process.argv[3] || 'zjdx-kfkc';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes(MATCH));
if (!p) { console.log('无匹配标签'); process.exit(0); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 45000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const events = [];
ws.addEventListener('message', ev => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === 'Page.javascriptDialogOpening') events.push('DIALOG: ' + String(m.params.message).slice(0, 120));
  if (m.method === 'Page.loadEventFired') events.push('LOAD');
  if (m.method === 'Network.loadingFailed') events.push('FAIL ' + String(m.params.errorText).slice(0, 60));
});
await send('Page.enable');
await send('Runtime.enable');
console.log('对话框处理: ' + JSON.stringify((await send('Page.handleJavaScriptDialog', { accept: true })).error || 'ok').slice(0, 100));
const r = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
console.log('求值: ' + (r.timeout ? '仍超时' : JSON.stringify(r.result && r.result.result && r.result.result.value)));
console.log('事件: ' + JSON.stringify(events.slice(-8)));
ws.close();
