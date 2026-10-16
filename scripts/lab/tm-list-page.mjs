/** tm-list-page.mjs — 直接打开油猴脚本列表页（#nav=scripts），读它认到的脚本 */
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

for (const hash of ['#nav=scripts', '']) {
  const url = `chrome-extension://${TM}/options.html${hash}`;
  const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  await sleep(9000);
  const c = new Cdp(p.webSocketDebuggerUrl);
  await c.open();
  await c.send('Runtime.enable').catch(() => { });
  const r = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href,
      title: document.title,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 900),
      scriptNames: Array.from(document.querySelectorAll('*')).filter(function(e){ return e.children.length === 0 && /NetClass|OCS|万能|U校园|慕课/.test(e.textContent || ''); }).map(function(e){ return (e.textContent||'').trim().slice(0, 40); }).slice(0, 10)
    })`, returnByValue: true
  });
  const val = r.result && r.result.value;
  console.log('=== ' + url + ' ===');
  console.log(val);
  console.log('');
  c.close();
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${p.id}`); } catch { }
}
