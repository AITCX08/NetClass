/** ss-quiz-watch.mjs — 持续观察 shengsheng 弹题事件（作答/判定/题库回填）
 *  用法：node ss-quiz-watch.mjs --port 9224 --mins 10
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const MINS = Number(A.mins || 10);
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

const deadline = Date.now() + MINS * 60000;
let last = '';
while (Date.now() < deadline) {
  await sleep(20000);
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { console.log('[' + new Date().toLocaleTimeString() + '] CDP 不可达'); continue; }
  const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
  if (!page) { console.log('[' + new Date().toLocaleTimeString() + '] 无 shengsheng 页面'); continue; }
  const c = new Cdp(page.webSocketDebuggerUrl);
  try { await c.open(); } catch { continue; }
  let r;
  try {
    r = await c.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        quiz: window.NetClass ? window.NetClass.state.quiz : null,
        bank: window.NetClass ? Object.keys(window.NetClass.bank()).length : null,
        cur: window.NetClass ? window.NetClass.state.currentLesson : null,
        next: window.NetClass ? window.NetClass.state.next : null,
        v: (function(){ var v = document.querySelector('video'); return v ? Math.round(v.currentTime||0) + '/' + Math.round(v.duration||0) + (v.paused?' 暂停':' 播放') : null; })(),
        dialog: !!document.querySelector('.pop-quiz-dialog')
      })`, returnByValue: true
    });
  } catch { c.close(); continue; }
  const val = r.result && r.result.value;
  c.close();
  if (val && val !== last) {
    last = val;
    console.log('[' + new Date().toLocaleTimeString() + '] ' + val);
  }
}
console.log('观察结束');
