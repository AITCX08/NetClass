/** pause-guard-check.mjs — 盯一段时间，确认「已完成」的页面保持暂停不自播 */
const PORT = Number(process.argv[2] || 9225);
const ROUNDS = Number(process.argv[3] || 6);
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
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, { res }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => res({ result: { value: 'timeout' } }), 10000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

console.log('盯 ' + (ROUNDS * 8) + ' 秒，看是否保持暂停...');
let first = null, resumed = 0;
for (let i = 1; i <= ROUNDS; i++) {
  await sleep(8000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find(x => x.type === 'page' && x.url.includes('bjqiyang'));
    if (!t) { console.log('  [' + (i * 8) + 's] 无页面'); continue; }
    const c = new Cdp(t.webSocketDebuggerUrl);
    await c.open();
    const r = await c.send('Runtime.evaluate', {
      expression: 'JSON.stringify({t: Math.round(document.querySelector("video").currentTime||0), paused: document.querySelector("video").paused, allDone: window.NetClass ? window.NetClass.state.allDone : null})',
      returnByValue: true
    });
    const v = JSON.parse(r.result.value);
    if (first === null) first = v.t;
    if (!v.paused) resumed++;
    console.log('  [' + (i * 8) + 's] t=' + v.t + (v.paused ? ' ⏸暂停' : ' ▶播放中') + '  allDone=' + v.allDone);
    c.close();
  } catch (e) { console.log('  [' + (i * 8) + 's] ERR ' + e.message); }
}
console.log('');
console.log(resumed === 0 ? '✅ 全程保持暂停，没有自播' : ('❌ 有 ' + resumed + ' 次自播'));
