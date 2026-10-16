/**
 * click-lesson.mjs — 在课程目录里点开「未完成」的第一节，用于验证播放器接管
 * 用法：node click-lesson.mjs --port 9224 --target course/v2 [--index 0]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
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
        if (m.id && this.pending.has(m.id)) {
          const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes(A.target || 'course/v2'));
if (!t) { console.log('找不到课程页'); process.exit(1); }
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

// 列出目录项并点开第一个未完成项
const r = await c.send('Runtime.evaluate', {
  expression: `(() => {
    const items = Array.from(document.querySelectorAll('.tab-section li, [class*=catalog] li, [class*=section] li, li'));
    const rows = items.map((li, i) => ({ i, text: (li.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) })).filter(x => x.text);
    const pending = items.find(li => /已观看\\s*\\d+%|未开始|学习中/.test(li.innerText || ''));
    let clicked = null;
    if (pending) { clicked = (pending.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60); pending.click(); }
    return JSON.stringify({ total: items.length, clicked, sample: rows.slice(0, 8) });
  })()`, returnByValue: true
});
console.log('目录 => ' + (r.result && r.result.value));

await sleep(9000);
const st = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    videos: (window.NetClass ? window.NetClass.videoInfo() : []),
    state: window.NetClass ? window.NetClass.state : null,
    quizEls: (window.NetClass ? window.NetClass.quizElements() : []).slice(0, 4)
  })`, returnByValue: true
});
console.log('播放器状态 => ' + (st.result && st.result.value));
c.close();
