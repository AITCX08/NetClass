/** ss-quiz-loop.mjs — 循环观察弹题处理（作答/判定/题库），直到超时 */
const PORT = Number(process.argv[2] || 9224);
const SECS = Number(process.argv[3] || 180);
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
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error('e')) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout')); } }, 12000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const end = Date.now() + SECS * 1000;
let last = '';
while (Date.now() < end) {
  await sleep(12000);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
    if (!page) { console.log('no page'); continue; }
    const c = new Cdp(page.webSocketDebuggerUrl);
    await c.open();
    const expr = `JSON.stringify({
      q: window.NetClass ? window.NetClass.state.quiz : null,
      v: (function(){ var v = document.querySelector('video'); return v ? (Math.round(v.currentTime||0) + '/' + Math.round(v.duration||0) + (v.paused ? ' 暂停' : ' 播放') + (v.muted ? ' 静音' : '')) : null; })(),
      dialog: !!document.querySelector('.pop-quiz-dialog'),
      bank: window.NetClass ? Object.keys(window.NetClass.bank()).length : null,
      cur: window.NetClass ? window.NetClass.state.currentLesson : null,
      errs: window.NetClass ? window.NetClass.state.errors.slice(-2) : null
    })`;
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    c.close();
    const val = r.result && r.result.value;
    if (val !== last) { last = val; console.log('[' + new Date().toLocaleTimeString() + '] ' + val); }
  } catch (e) { console.log('err ' + e.message); }
}
console.log('观察结束');
