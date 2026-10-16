import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('runs/shots', { recursive: true });
const PORTS = [
  { p: 9224, t: 'shengsheng', n: 'ss' },
  { p: 9227, t: 'chaoxing',   n: 'cx' },
  { p: 9228, t: 'ccjyxy',     n: 'cc' },
];
for (const x of PORTS) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${x.p}/json/list`)).json();
    const page = l.find(t => t.type === 'page' && t.url.includes(x.t));
    if (!page) { console.log(`  ${x.n}: 无标签`); continue; }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let i = 0;
    const send = (m, pr = {}) => new Promise(res => { const id = ++i; const on = e => { const v = JSON.parse(e.data); if (v.id === id) { ws.removeEventListener('message', on); res(v); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), 15000); });
    // 只截"真实窗口可见的那一块"：outerWidth x (outerHeight - 96)
    const geo = await send('Runtime.evaluate', { expression: 'JSON.stringify({w:window.outerWidth,h:window.outerHeight})', returnByValue: true });
    const g = JSON.parse(geo.result.result.value);
    const realW = g.w, realH = Math.max(200, g.h - 96);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: realW, height: realH, scale: 1 } });
    const b64 = r && r.result && r.result.data;
    if (!b64) { console.log(`  ${x.n}: 截图失败`); ws.close(); continue; }
    const f = `runs/shots/panel-${x.n}.png`;
    writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log(`  ${x.n}: ${f}  (可见区 ${realW}x${realH})`);
    ws.close();
  } catch (e) { console.log(`  ${x.n} ERR ${String(e).slice(0, 50)}`); }
}
