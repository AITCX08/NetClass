/**
 * tile-port.mjs — 把指定端口的浏览器窗口摆到 左半屏/右半屏/整屏（CDP Browser.setWindowBounds）
 *   node scripts/tile-port.mjs --port 9227 --side right [--w 960 --h 1032]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const SIDE = String(A.side || 'right');
const W = Number(A.w || 960), H = Number(A.h || 1032);
const x = SIDE === 'right' ? W : 0;

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);   // browser-level
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 15000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 140))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const list = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).text());
const page = list.find(t => t.type === 'page' && !/tampermonkey/.test(t.url));
const { windowId } = await send('Browser.getWindowForTarget', { targetId: page.id });
await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
await send('Browser.setWindowBounds', { windowId, bounds: { left: x, top: 0, width: W, height: H } });
const now = await send('Browser.getWindowBounds', { windowId });
console.log(PORT + ' 窗口已摆到 ' + SIDE + '：' + JSON.stringify(now.bounds));
ws.close();
