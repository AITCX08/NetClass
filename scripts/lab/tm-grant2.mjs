/** tm-grant2.mjs — 精准打开 #allow-user-scripts 开关 */
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

const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions')}`, { method: 'PUT' })).json();
await sleep(4000);
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const ev = async expr => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  return r.err || (r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 250) : (r.result && r.result.value));
};

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

console.log('== 目标开关当前状态 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var row = dp.shadowRoot.querySelector('#allow-user-scripts');
  if (!row) return 'row not found';
  var info = { tag: row.tagName, html: row.outerHTML.slice(0, 300) };
  var tg = row.querySelector('cr-toggle');
  info.hasCrToggle = !!tg;
  if (tg) { info.pressed = tg.getAttribute('aria-pressed'); info.checked = tg.checked; info.toggleHtml = tg.outerHTML.slice(0, 250); }
  return JSON.stringify(info, null, 1);
})()`));

console.log('== 点击开启 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var row = dp.shadowRoot.querySelector('#allow-user-scripts');
  if (!row) return 'row not found';
  var tg = row.querySelector('cr-toggle');
  if (!tg) { row.click(); return 'clicked row'; }
  var pressed = tg.getAttribute('aria-pressed');
  if (pressed === 'true') return 'already on';
  // cr-toggle 的内部可点区域
  var inner = tg.shadowRoot && (tg.shadowRoot.querySelector('#button') || tg.shadowRoot.querySelector('.cr-toggle') || tg.shadowRoot.firstElementChild);
  if (inner) { inner.click(); return 'clicked inner (was ' + pressed + ')'; }
  tg.click(); return 'clicked toggle (was ' + pressed + ')';
})()`));
await sleep(2500);

console.log('== 复查 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var row = dp.shadowRoot.querySelector('#allow-user-scripts');
  var tg = row && row.querySelector('cr-toggle');
  return tg ? ('pressed=' + tg.getAttribute('aria-pressed') + ' checked=' + tg.checked) : 'no toggle';
})()`));

// 顺带看站点访问
console.log('== 站点访问 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var el = dp.shadowRoot.querySelector('#host-access, #site-access, [id*=host], [id*=access]');
  if (!el) return 'no element';
  return el.tagName + ' id=' + (el.id||'') + ' text=' + (el.textContent||'').replace(/\\s+/g,' ').slice(0,200);
})()`));

c.close();
