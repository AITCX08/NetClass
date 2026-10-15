/**
 * layout.mjs — 把多个 netclass 浏览器窗口自动排成"平均分块"并全部可见
 *   node scripts/layout.mjs [--ports 9224,9227,9228] [--side all]
 *
 * 布局规则（按真实工作区尺寸算，1920x1032 为例）：
 *   n=1 → 整屏
 *   n=2 → 左右各半
 *   n=3 → 三列均分（640x1032 ×3）  ← 你要的"上下左右平均分块"
 *   n=4 → 2x2 网格
 *   n>4 → 2 行均分，第二行补满
 * 每个窗口都：置前(bringToFront) + 摆到算好的位置 + 回读 bounds 核对是否在屏内。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORTS = String(A.ports || '9224,9225,9226,9227,9228').split(',').map(s => Number(s.trim())).filter(Boolean);

async function probe(port) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
    const page = list.find(t => t.type === 'page' && !/tampermonkey|devtools|chrome-extension/.test(t.url));
    if (!page) return null;
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(4000) })).json();
    return { port, page, ver, url: page.url };
  } catch (e) { return null; }
}

async function getScreen(port, page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const r = await new Promise(res => {
    const on = ev => { const m = JSON.parse(ev.data); if (m.id === 1) { ws.removeEventListener('message', on); res(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify({aw:screen.availWidth,ah:screen.availHeight,sw:screen.width,sh:screen.height})', returnByValue: true } }));
    setTimeout(() => res({ timeout: true }), 8000);
  });
  ws.close();
  try { return JSON.parse(r.result.result.value); } catch (e) { return null; }
}

const alive = [];
for (const p of PORTS) { const a = await probe(p); if (a) alive.push(a); }
console.log('发现 ' + alive.length + ' 个可用窗口: ' + alive.map(a => a.port).join(', '));
if (!alive.length) process.exit(1);

const scr = await getScreen(alive[0].port, alive[0].page) || { aw: 1920, ah: 1032 };
const W = scr.aw, H = scr.ah;
const n = alive.length;
const slots = [];
if (n === 1) slots.push({ left: 0, top: 0, width: W, height: H });
else if (n === 2) { const w = Math.floor(W / 2); slots.push({ left: 0, top: 0, width: w, height: H }, { left: w, top: 0, width: W - w, height: H }); }
else if (n === 3) { const w = Math.floor(W / 3); slots.push({ left: 0, top: 0, width: w, height: H }, { left: w, top: 0, width: w, height: H }, { left: 2 * w, top: 0, width: W - 2 * w, height: H }); }
else if (n === 4) { const w = Math.floor(W / 2), h = Math.floor(H / 2); slots.push({ left: 0, top: 0, width: w, height: h }, { left: w, top: 0, width: W - w, height: h }, { left: 0, top: h, width: w, height: H - h }, { left: w, top: h, width: W - w, height: H - h }); }
else { const h = Math.floor(H / 2), top = Math.ceil(n / 2), wt = Math.floor(W / top); for (let i = 0; i < n; i++) { const row = i < top ? 0 : 1; const col = i < top ? i : i - top; const cnt = row === 0 ? top : n - top; const w2 = Math.floor(W / cnt); slots.push({ left: col * w2, top: row * h, width: w2, height: H - h }); } }

for (let i = 0; i < n; i++) {
  const a = alive[i], s = slots[i];
  const ws = new WebSocket(a.ver.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (m, p = {}, ms = 12000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => res({ timeout: true }), ms); });
  const { windowId } = (await send('Browser.getWindowForTarget', { targetId: a.page.id })).result;
  await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await send('Browser.setWindowBounds', { windowId, bounds: s });
  const now = (await send('Browser.getWindowBounds', { windowId })).result;
  const b = now.bounds;
  const inside = (b.left + b.width) <= W + 2 && (b.top + b.height) <= H + 4;
  console.log('  ' + a.port + ' → [' + b.left + ',' + b.top + ' ' + b.width + 'x' + b.height + '] ' + (inside ? '✅ 在屏内' : '❌ 越界') + ' | ' + String(a.url).slice(0, 46));
  ws.close();
  // 置前
  const pws = new WebSocket(a.page.webSocketDebuggerUrl);
  await new Promise(r => pws.addEventListener('open', r));
  pws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront' }));
  await new Promise(r => setTimeout(r, 300));
  pws.close();
}
console.log('排版完成（' + n + ' 窗口，工作区 ' + W + 'x' + H + '）');
