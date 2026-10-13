/**
 * tm-list.mjs — 列出指定调试端口上 Tampermonkey 已安装的脚本（用于核对安装结果）
 * 用法：node tm-list.mjs --port 9224
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws err')));
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
console.log('--- pages ---');
for (const t of list.filter(x => x.type === 'page')) console.log('  ' + t.url.slice(0, 110));

const opt = list.find(t => t.type === 'page' && t.url.includes('options.html'));
if (!opt) { console.log('没有 options 页面'); process.exit(1); }

const p = new Cdp(opt.webSocketDebuggerUrl);
await p.open();
await p.send('Page.enable');

// 点击「已安装脚本」导航
const nav = await p.send('Runtime.evaluate', {
  expression: `(() => {
    const els = Array.from(document.querySelectorAll('a,li,div,span'));
    const target = els.find(e => /已安装脚本|Installed Userscripts/i.test(e.innerText || ''));
    if (target) { target.click(); return 'clicked:' + target.tagName; }
    return 'not-found';
  })()`, returnByValue: true
});
console.log('nav => ' + (nav.result && nav.result.value));
await sleep(3000);

const body = await p.send('Runtime.evaluate', {
  expression: `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 900)`,
  returnByValue: true
});
console.log('--- 页面文本 ---');
console.log(body.result && body.result.value);

const rows = await p.send('Runtime.evaluate', {
  expression: `JSON.stringify(Array.from(document.querySelectorAll('.script, .script-row, tbody tr, [class*=script]')).map(e => (e.innerText||'').replace(/\\s+/g,' ').trim()).filter(Boolean).slice(0,8))`,
  returnByValue: true
});
console.log('--- 脚本行 ---');
console.log(rows.result && rows.result.value);
p.close();
