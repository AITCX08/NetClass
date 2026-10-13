/** ask-inspect.mjs — 检查油猴安装确认页 ask.html 的结构，确认 OCS 能点到「安装」按钮 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);

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

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ask = tabs.find(t => t.url.includes('ask.html'));
if (!ask) { console.log('没有 ask.html 页面（安装对话框未出现）'); process.exit(1); }
console.log('ask 页面: ' + ask.url);

const c = new Cdp(ask.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const r = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
    buttons: Array.from(document.querySelectorAll('button, input[type=button], input[type=submit], [class*=button]')).map(function(b){
      return { tag: b.tagName, text: (b.innerText || b.value || '').trim().slice(0, 20), cls: String(b.className).slice(0, 50) };
    }).slice(0, 12),
    primary: !!document.querySelector('[class*="primary"]')
  }, null, 1)`,
  returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
