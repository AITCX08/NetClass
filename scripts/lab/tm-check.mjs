/** tm-check.mjs — 重新加载油猴页面并列出已安装脚本（核对离线写入是否生效）
 *  用法：node tm-check.mjs --port 9224
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
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

// 新开一个干净的 options 页面
try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM_ID}/options.html#nav=utils`)}`, { method: 'PUT' }); } catch { }
await sleep(6000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const opt = list.reverse().find(t => t.type === 'page' && t.url.includes('options.html'));
if (!opt) { console.log('没有 options 页面'); process.exit(1); }
const c = new Cdp(opt.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

const r = await c.send('Runtime.evaluate', {
  expression: `(async () => {
    const out = { href: location.href, body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300) };
    try {
      const all = await chrome.storage.local.get(null);
      out.uidKeys = Object.keys(all).filter(k => k.startsWith('!extdb.@uid#'));
      out.names = out.uidKeys.map(k => all[k] && all[k].value);
    } catch (e) { out.err = String(e); }
    out.hasNetClass = /netclass/i.test(document.body.innerText || '');
    return JSON.stringify(out);
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
c.close();
