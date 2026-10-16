/** tile-verify.mjs — 复核两个浏览器窗口的位置/尺寸 + 页面状态 */
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

for (const t of [{ port: 9224, name: 'shengsheng' }, { port: 9225, name: 'qiyang' }]) {
  console.log('===== ' + t.name + ' (:' + t.port + ') =====');
  try {
    const list = await (await fetch(`http://127.0.0.1:${t.port}/json/list`)).json();
    const course = list.find(x => x.type === 'page' && /shengshengketang|bjqiyang/.test(x.url));
    console.log('  标签: ' + list.filter(x => x.type === 'page').map(x => x.url.slice(0, 55)).join(' | '));

    const bc = new Cdp((await (await fetch(`http://127.0.0.1:${t.port}/json/version`)).json()).webSocketDebuggerUrl);
    await bc.open();
    if (course) {
      const win = await bc.send('Browser.getWindowForTarget', { targetId: course.id }).catch(() => null);
      if (win) {
        const b = await bc.send('Browser.getWindowBounds', { windowId: win.windowId }).catch(() => null);
        console.log('  窗口: ' + JSON.stringify(b && b.bounds));
      }
      const c = new Cdp(course.webSocketDebuggerUrl);
      await c.open();
      const r = await c.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          url: location.href.replace(location.origin, '').slice(0, 40),
          v: (function(){ var v = document.querySelector('video'); return v ? (Math.round(v.currentTime||0) + '/' + Math.round(v.duration||0) + (v.paused ? ' 暂停' : ' 播放') + ' x' + v.playbackRate + (v.muted ? ' 静音' : '')) : null; })(),
          module: !!window.NetClass,
          quiz: window.NetClass ? window.NetClass.state.quiz : null
        })`, returnByValue: true
      });
      console.log('  页面: ' + (r.result && r.result.value));
      c.close();
    }
    bc.close();
  } catch (e) { console.log('  ERR ' + e.message); }
  console.log('');
}
