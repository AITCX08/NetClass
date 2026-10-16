/** loader-diag.mjs — 查 NetClass Loader 扩展是否加载、有无错误、注册了什么 */
const PORT = Number(process.argv[2] || 9224);
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

const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions')}`, { method: 'PUT' })).json();
await sleep(4000);
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const ev = async expr => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  return r.err || (r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 200) : (r.result && r.result.value));
};

for (let i = 0; i < 8; i++) {
  await sleep(1300);
  const ok = await ev(`(function(){
    var m = document.querySelector('extensions-manager'); if (!m) return 'no-manager';
    var list = m.shadowRoot.querySelector('extensions-item-list'); if (!list) return 'no-list';
    return 'items=' + list.shadowRoot.querySelectorAll('extensions-item').length;
  })()`);
  if (ok.startsWith('items=')) { console.log('扩展数量: ' + ok); break; }
}

console.log('');
console.log('== 扩展清单（id / 名称 / 是否启用 / 错误）==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var list = m.shadowRoot.querySelector('extensions-item-list');
  var items = list.shadowRoot.querySelectorAll('extensions-item');
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var sr = items[i].shadowRoot;
    var id = items[i].getAttribute('id') || '';
    var nameEl = sr.querySelector('#name, [id=name]');
    var name = nameEl ? (nameEl.textContent || '').trim() : '';
    var errEl = sr.querySelector('extensions-error-list');
    out.push({ idx: i, id: id.slice(0, 32), name: name, err: errEl ? (errEl.textContent||'').replace(/\\s+/g,' ').slice(0,200) : null });
  }
  return JSON.stringify(out, null, 1);
})()`));

c.close();
try { await fetch(`http://127.0.0.1:${PORT}/json/close/${p.id}`); } catch { }
