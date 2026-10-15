/**
 * tile-4-cdp.mjs — 用 CDP 把四个平台窗口平铺成 2×2（用户明确要求）
 *
 * 为什么用 CDP 而不是 Win32 MoveWindow：
 *   Chrome 是 OCS Desktop 拉起的，`EnumWindows` 在**控制端**看不到它的窗口（实测 visible_big_windows=0），
 *   但 **CDP 的 `Browser.getWindowForTarget` 能拿到窗口句柄和 bounds** —— 而且 `Browser.setWindowBounds`
 *   是 Chrome 自己的接口，比外部 MoveWindow 更可靠（不会被 Chrome 的窗口管理覆盖回去）。
 *
 * 布局（笔记本真实屏 **1920×1080** → 每窗 960×540）：
 *   左上(0,0)      右上(512,0)
 *   左下(0,384)    右下(512,384)
 *
 * 用法：node scripts\tile-4-cdp.mjs [--w 512] [--h 384]
 */
const PORTS = [9224, 9227, 9228, 9229];
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1] || d) : d; };
// ★ 默认 960x540 = 1920x1080 屏的 2x2（笔记本真实分辨率）。
//   踩过的坑：System.Windows.Forms.Screen 报的是 WinDisc 虚拟显示器 1024x768，
//   按那个摆只会占满屏幕左上角。真实分辨率要从 GPU 读（RTX 3050 = 1920x1080）。
// ★ 默认 960x510 —— 高不是 540！1920x1080 屏**底部有任务栏（约 50px）**，
//   用满高 540 会把下面一排窗口切掉（用户实测反馈）。510x2 = 1020，留 60px 给任务栏。
//   注意：Screen.WorkingArea / SPI_GETWORKAREA 在这台机器上只报虚拟显示器的 1024x768，**不可信**。
const W = arg('w', 960), H = arg('h', 510);
const SLOTS = [[0, 0], [W, 0], [0, H], [W, H]];

async function withTarget(port, fn) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 6000); });
  let i = 0;
  const send = (m, pr = {}, ms = 8000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  try { return await fn(send); } finally { ws.close(); }
}

console.log(`=== 平铺 2×2（每窗 ${W}×${H}）===`);
for (let k = 0; k < PORTS.length; k++) {
  const port = PORTS[k], [x, y] = SLOTS[k];
  try {
    const out = await withTarget(port, async (send) => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
      const page = list.find(t => t.type === 'page');
      const wr = await send('Browser.getWindowForTarget', { targetId: page.id });
      const win = wr && wr.result;
      if (!win || !win.windowId) return '拿不到 windowId';
      // 先恢复再设位置（最小化状态下设 bounds 可能无效）
      await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      await new Promise(r => setTimeout(r, 250));
      const r2 = await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: x, top: y, width: W, height: H } });
      await new Promise(r => setTimeout(r, 200));
      const chk = await send('Browser.getWindowForTarget', { targetId: page.id });
      const b = chk && chk.result && chk.result.bounds;
      return b ? `@(${b.left},${b.top}) ${b.width}x${b.height} ${b.windowState}` : ('设置失败 ' + JSON.stringify(r2).slice(0, 80));
    });
    console.log(`  ${port} → ${out}`);
  } catch (e) {
    console.log(`  ${port} → ERR ${String(e).slice(0, 60)}`);
  }
}
