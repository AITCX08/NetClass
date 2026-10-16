/**
 * lesson.mjs — 课程目录操作（列出 / 点开未完成项），并打印播放器接管状态
 * 用法：
 *   node lesson.mjs --port 9224 --action list
 *   node lesson.mjs --port 9224 --action next
 *   node lesson.mjs --port 9224 --action status
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const ACTION = A.action || 'status';
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
        if (m.id && this.pending.has(m.id)) { const { res: r, rej: j } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes(A.target || 'course/v2'));
if (!t) { console.log('找不到课程页（先打开课程）'); process.exit(1); }
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

const EXPR = {
  list: `(() => {
    const items = Array.from(document.querySelectorAll('[class*=tab-body] *, [class*=item], [class*=lesson], [class*=node], li'));
    const rows = [];
    const seen = new Set();
    for (const el of items) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 70 || seen.has(t)) continue;
      if (!/已完成|已观看|未开始|学习中|\\d{2}:\\d{2}:\\d{2}/.test(t)) continue;
      if (el.querySelector('div,ul,ol')) continue;
      seen.add(t);
      rows.push({ cls: String(el.className).slice(0, 50), text: t.replace(/\\s+/g, ' ') });
    }
    return JSON.stringify({ total: rows.length, rows: rows.slice(0, 60) });
  })()`,
  next: `(async () => {
    const cur = { url: location.href };
    const r = window.NetClass ? window.NetClass.next() : null;
    await new Promise(r => setTimeout(r, 8000));
    return JSON.stringify({ clicked: r, url: location.href,
      videos: window.NetClass ? window.NetClass.videoInfo() : [],
      state: window.NetClass ? window.NetClass.state : null });
  })()`,
  status: `JSON.stringify({
    url: location.href,
    login: window.NetClass ? window.NetClass.login() : null,
    videos: window.NetClass ? window.NetClass.videoInfo() : [],
    state: window.NetClass ? window.NetClass.state : null,
    quizEls: window.NetClass ? window.NetClass.quizElements().slice(0, 5) : []
  })`
};

const r = await c.send('Runtime.evaluate', { expression: EXPR[ACTION], returnByValue: true, awaitPromise: true });
console.log(r.result && r.result.value);
c.close();
