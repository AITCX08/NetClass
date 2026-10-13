/** tm-toggle-fix.mjs — 检查并确保「允许运行用户脚本」= 开 */
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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let p = list.find(t => t.type === 'page' && t.url.startsWith('chrome://extensions'));
if (!p) { p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions')}`, { method: 'PUT' })).json(); await sleep(4000); }
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const ev = async expr => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  return r.err || (r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : (r.result && r.result.value));
};

// 展开
for (let i = 0; i < 8; i++) {
  await sleep(1200);
  const ok = await ev(`(function(){
    var m = document.querySelector('extensions-manager'); if (!m) return 'no-manager';
    var list = m.shadowRoot.querySelector('extensions-item-list'); if (!list) return 'no-list';
    var items = list.shadowRoot.querySelectorAll('extensions-item');
    for (var i = 0; i < items.length; i++) {
      if ((items[i].getAttribute('id') || '').indexOf('${TM}') >= 0) {
        var b = items[i].shadowRoot.querySelector('#detailsButton');
        if (b) { b.click(); return 'expanded'; }
      }
    }
    return 'pending';
  })()`);
  if (ok === 'expanded') break;
}
await sleep(2500);

const read = () => ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var row = dp.shadowRoot.querySelector('#allow-user-scripts');
  if (!row) return 'row-missing';
  return 'checkedAttr=' + row.hasAttribute('checked') + ' attr=' + row.getAttribute('checked');
})()`);

console.log('当前: ' + await read());
let st = await read();
if (st.indexOf('checkedAttr=false') >= 0) {
  console.log('→ 关掉了，重新点开');
  console.log(await ev(`(function(){
    var m = document.querySelector('extensions-manager');
    var dp = m.shadowRoot.querySelector('extensions-detail-view');
    var row = dp.shadowRoot.querySelector('#allow-user-scripts');
    row.click();
    return 'clicked';
  })()`));
  await sleep(2500);
  console.log('修复后: ' + await read());
} else {
  console.log('→ 本来就是开的，无需改动');
}

// 再看看 userScripts API
const sw = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'service_worker' && t.url.includes(TM));
if (sw) {
  const c2 = new Cdp(sw.webSocketDebuggerUrl);
  await c2.open();
  const r = await c2.send('Runtime.evaluate', { expression: `(function(){ try { return chrome.userScripts ? 'API ok' : 'null'; } catch(e) { return 'ERR ' + e.message; } })()`, returnByValue: true });
  console.log('userScripts: ' + (r.result && r.result.value));
  c2.close();
}
c.close();
