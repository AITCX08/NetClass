/** win-titles.mjs — 两个调试端口各自打开的页面标题与视频状态 */
const list = async p => await (await fetch(`http://127.0.0.1:${p}/json/list`)).json();

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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout')); } }, 15000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

for (const P of [9224, 9225]) {
  console.log('===== :' + P + ' =====');
  try {
    const tabs = await list(P);
    for (const t of tabs.filter(x => x.type === 'page' && x.url.startsWith('http'))) {
      const c = new Cdp(t.webSocketDebuggerUrl);
      await c.open();
      const r = await c.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          title: document.title,
          host: location.hostname,
          path: location.pathname.slice(0, 40),
          v: (function(){ var v = document.querySelector('video'); return v ? (Math.round(v.currentTime||0) + '/' + Math.round(v.duration||0) + (v.paused ? ' ⏸暂停' : ' ▶播放中') + ' x' + v.playbackRate) : null; })(),
          allDone: window.NetClass ? window.NetClass.state.allDone : null,
          enabled: window.NetClass ? window.NetClass.cfg.enabled : null
        })`, returnByValue: true
      });
      console.log('  [' + t.url.slice(0, 62) + ']');
      console.log('    ' + (r.result && r.result.value));
      c.close();
    }
  } catch (e) { console.log('  ERR ' + e.message); }
  console.log('');
}

// 第二次采样，判断有没有在推进
console.log('=== 8 秒后复查（看时间有没有走）===');
for (const P of [9224, 9225]) {
  try {
    const tabs = await list(P);
    for (const t of tabs.filter(x => x.type === 'page' && x.url.startsWith('http'))) {
      const c = new Cdp(t.webSocketDebuggerUrl);
      await c.open();
      const r = await c.send('Runtime.evaluate', { expression: `JSON.stringify({ t: (function(){ var v = document.querySelector('video'); return v ? (Math.round(v.currentTime||0) + (v.paused ? ' ⏸' : ' ▶')) : null; })() })`, returnByValue: true });
      console.log('  :' + P + ' ' + t.url.slice(30, 55) + ' -> ' + (r.result && r.result.value));
      c.close();
    }
  } catch (e) { }
}
