/** tm-row-state.mjs — 读脚本列表里每一行的启用勾选状态 */
const PORT = Number(process.argv[2] || 9225);
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${TM}/options.html#nav=scripts`)}`, { method: 'PUT' })).json();
await sleep(10000);
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });

const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var out = { rows: [] };
    var rows = document.querySelectorAll('tr, [class*=script_row], [class*=script]');
    var seen = 0;
    for (var i = 0; i < rows.length && seen < 20; i++) {
      var el = rows[i];
      var txt = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!/NetClass|OCS|万能/.test(txt)) continue;
      var cb = el.querySelector('input[type=checkbox]');
      out.rows.push({
        text: txt.slice(0, 60),
        tag: el.tagName,
        checkbox: cb ? cb.checked : 'none',
        cls: String(el.className).slice(0, 40)
      });
      seen++;
    }
    // 全表 checkbox 概览
    var all = Array.from(document.querySelectorAll('input[type=checkbox]'));
    out.checkboxes = all.slice(0, 10).map(function(cb){ return { checked: cb.checked, id: cb.id || '', cls: String(cb.className).slice(0, 30), title: cb.title || '' }; });
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
