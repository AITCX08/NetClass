/** nav-trace.mjs — 追踪 qiyang 页面的导航序列（找频繁刷新的循环） */
const PORT = Number(process.argv[2] || 9225);
const SECS = Number(process.argv[3] || 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.navs = []; this.console = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
          this.navs.push({ t: new Date().toISOString().slice(11, 19), url: String(m.params.frame.url).replace('https://study.bjqiyang.com', '') });
        }
        if (m.method === 'Runtime.consoleAPICalled') {
          const txt = (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ');
          if (/NetClass/.test(txt)) this.console.push(m.params.type + ': ' + txt.slice(0, 150));
        }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('bjqiyang'));
if (!page) { console.log('没有 qiyang 页面'); process.exit(1); }
console.log('监听中: ' + page.url.replace('https://study.bjqiyang.com', ''));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });

const end = Date.now() + SECS * 1000;
let lastNavCount = 0;
while (Date.now() < end) {
  await sleep(10000);
  if (c.navs.length !== lastNavCount) {
    lastNavCount = c.navs.length;
  }
}
console.log('');
console.log('=== ' + SECS + ' 秒内导航 ' + c.navs.length + ' 次 ===');
c.navs.forEach((n, i) => {
  const prev = i > 0 ? c.navs[i - 1] : null;
  const gap = prev ? '' : '';
  console.log('  ' + n.t + '  ' + n.url);
});
console.log('');
console.log('=== NetClass 控制台（最后 20 条）===');
for (const l of c.console.slice(-20)) console.log('  ' + l);
c.close();
