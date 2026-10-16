/** tile.mjs — 关掉多余标签、课程页置前、两个浏览器窗口左右各半屏
 *  用法：node tile.mjs
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const TARGETS = [
  { port: 9224, name: 'shengsheng', side: 'left',  match: /shengshengketang\.com/ },
  { port: 9225, name: 'qiyang',     side: 'right', match: /bjqiyang\.com/ }
];

// 1) 屏幕尺寸（从页面读）
let screen = null;
for (const t of TARGETS) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${t.port}/json/list`)).json();
    const page = list.find(x => x.type === 'page');
    if (!page) continue;
    const c = new Cdp(page.webSocketDebuggerUrl);
    await c.open();
    const r = await c.send('Runtime.evaluate', { expression: 'JSON.stringify({w: screen.availWidth, h: screen.availHeight, tw: screen.width, th: screen.height})', returnByValue: true });
    screen = JSON.parse(r.result.value);
    c.close();
    console.log(t.name + ' 屏幕: ' + JSON.stringify(screen));
    break;
  } catch (e) { }
}
if (!screen) { console.log('读不到屏幕尺寸，用默认 1920x1080'); screen = { w: 1920, h: 1080 }; }
const W = screen.w, H = screen.h;

for (const t of TARGETS) {
  console.log('');
  console.log('===== ' + t.name + ' (:' + t.port + ') =====');
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${t.port}/json/list`)).json(); }
  catch (e) { console.log('  CDP 不可达'); continue; }

  // 2) 关掉非目标标签（油猴首页/changelog/newtab/脚本安装页 等）
  const pages = list.filter(x => x.type === 'page');
  const course = pages.find(x => t.match.test(x.url)) || pages.find(x => x.url.startsWith('http'));
  for (const p of pages) {
    if (course && p.id === course.id) continue;
    if (/tampermonkey\.net|chrome:\/\/newtab|about:blank|script_installation|ask\.html|netclass\.user\.js|hello-test|extensions/.test(p.url) || p.url.startsWith('chrome-error')) {
      try { await fetch(`http://127.0.0.1:${t.port}/json/close/${p.id}`); console.log('  关闭标签: ' + p.url.slice(0, 60)); } catch { }
    }
  }
  await sleep(800);

  if (!course) { console.log('  没找到课程标签'); continue; }

  // 3) 课程页置前
  const c = new Cdp(course.webSocketDebuggerUrl);
  await c.open();
  try { await c.send('Page.enable'); await c.send('Page.bringToFront'); console.log('  已置前: ' + course.url.slice(0, 60)); } catch (e) { console.log('  置前失败: ' + e.message); }
  c.close();

  // 4) 窗口左右铺满
  const bc = new Cdp((await (await fetch(`http://127.0.0.1:${t.port}/json/version`)).json()).webSocketDebuggerUrl);
  await bc.open();
  try {
    const win = await bc.send('Browser.getWindowForTarget', { targetId: course.id });
    const windowId = win.windowId;
    const bounds = { left: t.side === 'left' ? 0 : Math.floor(W / 2), top: 0, width: Math.floor(W / 2), height: H, windowState: 'normal' };
    await bc.send('Browser.setWindowBounds', { windowId, bounds });
    console.log('  窗口位置: ' + JSON.stringify(bounds));
  } catch (e) { console.log('  窗口调整失败: ' + e.message); }
  bc.close();
}
console.log('\n完成');
