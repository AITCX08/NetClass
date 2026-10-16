/**
 * tile-check.mjs — 四窗口 2×2 位置巡检（可被主管每轮调用）
 *
 * 为什么需要它（2026-10-16 用户反馈"四个窗口又变到左上角了"）：
 *   **浏览器一旦被重启（手动拉起 / 计划任务 / 崩溃恢复），窗口就回到默认位置和尺寸** ——
 *   实测知到的浏览器被 `schtasks /Run /TN NetClassVis-zhihuishu` 重启后就跑了。
 *   所以平铺**不能只做一次**，必须常驻巡检。
 *
 * 布局：笔记本真实屏 1920×1080，底部任务栏约 50px
 *   9224 @(0,0)      9227 @(960,0)
 *   9228 @(0,510)    9229 @(960,510)     每窗 960×510（1020 总高，留 60px 给任务栏）
 *
 * 实现要点（踩过的坑）：
 *   - **必须用 CDP 的 `Browser.getWindowForTarget` / `setWindowBounds`** ——
 *     Win32 `MoveWindow` / `EnumWindows` 在控制端**找不到**这些窗口（是 OCS Desktop 拉起的）。
 *   - 设 bounds 前先把 `windowState` 置 `normal`（最小化状态下设位置无效）。
 *   - 判定"需要修正"用**容差 8px**（Chrome 会回 516 而不是 960 这种边缘差）。
 *
 * 用法：
 *   node scripts\tile-check.mjs           # 巡检并按需修正，打印一行摘要
 *   node scripts\tile-check.mjs --quiet   # 只在修正时输出
 */
const PORTS = [9224, 9227, 9228, 9229];
const W = 960, H = 510;
const SLOTS = [[0, 0], [W, 0], [0, H], [W, H]];
const TOL = 8;
const QUIET = process.argv.includes('--quiet');

async function withTarget(port, fn) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 5000); });
  let i = 0;
  const send = (m, pr = {}, ms = 6000) => new Promise(res => {
    const id = ++i;
    const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method: m, params: pr }));
    setTimeout(() => res({}), ms);
  });
  try { return await fn(send, page); } finally { ws.close(); }
}

const fixed = [];
const okList = [];

for (let k = 0; k < PORTS.length; k++) {
  const port = PORTS[k];
  const [x, y] = SLOTS[k];
  try {
    const out = await withTarget(port, async (send, page) => {
      const wr = await send('Browser.getWindowForTarget', { targetId: page.id });
      const win = wr && wr.result;
      if (!win || !win.windowId) return 'no-window';
      const b = win.bounds || {};
      const off = Math.abs((b.left ?? -999) - x) > TOL || Math.abs((b.top ?? -999) - y) > TOL
        || Math.abs((b.width ?? 0) - W) > 16 || Math.abs((b.height ?? 0) - H) > 16;
      if (!off) return 'ok';
      await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      await new Promise(r => setTimeout(r, 200));
      await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: x, top: y, width: W, height: H } });
      await new Promise(r => setTimeout(r, 150));
      const chk = await send('Browser.getWindowForTarget', { targetId: page.id });
      const nb = chk && chk.result && chk.result.bounds;
      return 'fixed:' + (nb ? `${nb.left},${nb.top} ${nb.width}x${nb.height}` : '?');
    });
    if (out === 'ok') okList.push(port);
    else if (String(out).startsWith('fixed')) { fixed.push(port); log1(`  窗口 ${port} 位置不对 → 已摆回 @(${x},${y}) ${String(out).slice(6)}`); }
    else if (!QUIET) log1(`  窗口 ${port} 异常: ${out}`);
  } catch (e) {
    if (!QUIET) log1(`  窗口 ${port} 探测失败: ${String(e).slice(0, 40)}`);
  }
}

function log1(s) { console.log(s); }

if (fixed.length === 0) {
  if (!QUIET) console.log(`窗口平铺: ✅ 四窗口都在位 (${okList.join(',')})`);
  process.exit(0);
} else {
  console.log(`窗口平铺: 🔧 修正了 ${fixed.length} 个 (${fixed.join(',')})`);
  process.exit(0);
}
