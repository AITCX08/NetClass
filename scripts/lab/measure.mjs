/** measure.mjs — 实测播放速度（媒体时间增量 / 真实经过时间），确认倍速与上报口径
 *  用法：node measure.mjs --port 9225 --target "Goods/Courses" [--secs 20]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const SECS = Number(A.secs || 20);
const TARGET = A.target || 'bjqiyang';
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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes(TARGET));
if (!page) { console.log('页面未找到: ' + TARGET); process.exit(1); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

async function sample() {
  const r = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href.replace(location.origin, '').slice(0, 70),
      t: (function(){ var v = document.querySelector('video'); return v ? v.currentTime : null; })(),
      rate: (function(){ var v = document.querySelector('video'); return v ? v.playbackRate : null; })(),
      paused: (function(){ var v = document.querySelector('video'); return v ? v.paused : null; })(),
      playerSpeed: (function(){ try { return (typeof player !== 'undefined' && player.getStatus && player.getStatus().speed) || null; } catch (e) { return null; } })()
    })`, returnByValue: true
  });
  return r.result && r.result.value;
}

console.log('采样起点...');
const a = JSON.parse(await sample());
const t0 = Date.now();
await sleep(SECS * 1000);
const b = JSON.parse(await sample());
const dt = (Date.now() - t0) / 1000;
const dm = b.t - a.t;
console.log('起点: ' + JSON.stringify(a));
console.log('终点: ' + JSON.stringify(b));
console.log(`真实经过 ${dt.toFixed(1)}s，媒体前进 ${dm.toFixed(1)}s → 实际速度 ${(dm / dt).toFixed(2)}x`);
c.close();
