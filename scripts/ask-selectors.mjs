/** ask-selectors.mjs — 验证 OCS 的按钮选择器能否命中 ask.html 的「安装」按钮 */
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
if (!ask) { console.log('no ask.html'); process.exit(1); }
const c = new Cdp(ask.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    byPrimary: (function(){ var e = document.querySelector('[class*="primary"]'); return e ? e.outerHTML.slice(0, 160) : null; })(),
    byType: (function(){ var e = document.querySelector('[type*="button"]'); return e ? e.outerHTML.slice(0, 200) : null; })(),
    byTypeIsInstall: (function(){ var e = document.querySelector('[type*="button"]'); return e ? ((e.textContent || e.getAttribute('value') || '')).trim() : null; })(),
    allInputs: Array.from(document.querySelectorAll('input')).map(function(e){ return { type: e.getAttribute('type'), cls: String(e.className), value: e.getAttribute('value') }; }).slice(0, 8)
  }, null, 1)`,
  returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
