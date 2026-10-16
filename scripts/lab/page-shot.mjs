/** 截图指定标签（compositor 级，JS 卡死也能截） */
const PORT = Number(process.argv[2] || 9226);
const MATCH = process.argv[3] || 'zjdx-kfkc';
const OUT = process.argv[4] || 'runs/orders/_shot.png';
const fs = await import('node:fs');
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes(MATCH));
if (!p) { console.log('无匹配标签'); process.exit(0); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 30000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const r = await send('Page.captureScreenshot', { format: 'png' });
if (r.timeout || !r.result) { console.log('截图失败'); process.exit(0); }
fs.writeFileSync(OUT, Buffer.from(r.result.data, 'base64'));
console.log('已保存: ' + OUT + ' (' + Math.round(r.result.data.length * 0.75 / 1024) + ' KB)');
ws.close();
