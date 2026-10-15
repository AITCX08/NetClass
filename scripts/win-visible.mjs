/**
 * win-visible.mjs — 把指定端口的窗口摆到"屏幕内可见"的位置并置前（可信版，先读真实屏幕尺寸）
 *   node scripts/win-visible.mjs --port 9227 --side right|left|full
 * 与 tile-port.mjs 的区别：先读页面里的 screen.availWidth/Height，按真实工作区摆，避免摆到屏幕外；
 * 摆完 Page.bringToFront()，并回读实际 bounds 供核对。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const SIDE = String(A.side || 'right');

const list = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).text());
const page = list.find(t => t.type === 'page' && !/tampermonkey/.test(t.url));
if (!page) { console.log('没找到页面'); process.exit(1); }

// 1) 用页面读真实工作区尺寸
const pws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => pws.addEventListener('open', r));
let seq = 0;
const psend = (m, p = {}, ms = 15000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { pws.removeEventListener('message', on); res(x); } }; pws.addEventListener('message', on); pws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => res({ timeout: true }), ms); });
const scr = await psend('Runtime.evaluate', { expression: 'JSON.stringify({w:screen.width,h:screen.height,aw:screen.availWidth,ah:screen.availHeight,dpr:devicePixelRatio})', returnByValue: true });
const S = JSON.parse(scr.result.result.value);
console.log('屏幕: ' + JSON.stringify(S));
await psend('Page.bringToFront');

// 2) 用浏览器级连接摆窗口
const ver = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).text());
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => bws.addEventListener('open', r));
seq = 0;
const bsend = (m, p = {}, ms = 15000) => new Promise((res, rej) => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { bws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error).slice(0, 120))) : res(x.result); } }; bws.addEventListener('message', on); bws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => rej(new Error('timeout ' + m)), ms); });

const { windowId } = await bsend('Browser.getWindowForTarget', { targetId: page.id });
const W = Math.floor(S.aw / 2), H = S.ah;
const bounds = SIDE === 'left' ? { left: 0, top: 0, width: W, height: H }
  : SIDE === 'full' ? { left: 0, top: 0, width: S.aw, height: S.ah }
    : { left: S.aw - W, top: 0, width: W, height: H };
try { await bsend('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch (e) { console.log('normal 失败: ' + e.message); }
await bsend('Browser.setWindowBounds', { windowId, bounds });
const now = await bsend('Browser.getWindowBounds', { windowId });
console.log('设置后 bounds: ' + JSON.stringify(now.bounds));
console.log('可见性判断: left=' + now.bounds.left + ' + width=' + now.bounds.width + ' = ' + (now.bounds.left + now.bounds.width) + ' ；屏幕可用宽=' + S.aw + ' → ' + ((now.bounds.left + now.bounds.width) <= S.aw ? '✅ 在屏内' : '❌ 超出屏幕'));
await psend('Page.bringToFront');
bws.close(); pws.close();
