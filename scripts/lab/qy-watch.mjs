/** qy-watch.mjs — 观察 qiyang 自动推进：章节切换 / 播放状态 / 上报接口 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const ROUNDS = Number(A.rounds || 8);
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

for (let i = 0; i < ROUNDS; i++) {
  await sleep(8000);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && t.url.includes('bjqiyang'));
  if (!page) { console.log(`[${i}] 没有 qiyang 页面`); continue; }
  const c = new Cdp(page.webSocketDebuggerUrl);
  await c.open();
  const r = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href.replace(location.origin, '').slice(0, 80),
      module: !!window.NetClass,
      video: (function(){
        var v = document.querySelector('video');
        if (!v) return null;
        return { rs: v.readyState, dur: Math.round(v.duration || 0), t: Math.round(v.currentTime || 0), rate: v.playbackRate, paused: v.paused, muted: v.muted };
      })(),
      site: (function(){
        try {
          return {
            isEnd: (typeof isEnd !== 'undefined') ? isEnd : null,
            current_time: (typeof current_time !== 'undefined') ? current_time : null,
            getUrl: (typeof getUrl !== 'undefined') ? getUrl : null
          };
        } catch (e) { return 'err'; }
      })(),
      state: window.NetClass ? { video: window.NetClass.state.video, next: window.NetClass.state.next } : null
    })`, returnByValue: true
  });
  console.log(`[${i}] ` + (r.result && r.result.value));
  c.close();
}
