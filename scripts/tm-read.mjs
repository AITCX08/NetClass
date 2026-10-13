/** tm-read.mjs — 只读：打开油猴「已安装脚本」页并打印脚本列表（核对安装结果）
 *  用法：node tm-read.mjs --port 9224
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws err')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method) this.events.push(m.method);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let opt = list.find(t => t.type === 'page' && t.url.includes('options.html'));
if (!opt) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM_ID}/options.html`)}`, { method: 'PUT' }); } catch { }
  await sleep(4000);
  const l2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  opt = l2.find(t => t.type === 'page' && t.url.includes('options.html'));
}
if (!opt) { console.log('no options page'); process.exit(1); }

const p = new Cdp(opt.webSocketDebuggerUrl);
await p.open();
await p.send('Page.enable');
await p.send('Runtime.enable').catch(() => { });
await p.send('Page.navigate', { url: `chrome-extension://${TM_ID}/options.html#nav=utils` });
await sleep(5000);

const r = await p.send('Runtime.evaluate', {
  expression: `(() => {
    const t = document.body ? document.body.innerText : '';
    return JSON.stringify({
      href: location.href,
      hasNetClass: /netclass|NetClass/i.test(t),
      hasOCS: /OCS|ocsjs/i.test(t),
      snippet: t.replace(/\\s+/g, ' ').slice(0, 700)
    });
  })()`, returnByValue: true
});
console.log(r.result && r.result.value);
p.close();
