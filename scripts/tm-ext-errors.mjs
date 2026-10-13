/** tm-ext-errors.mjs — 读 chrome://extensions 里油猴的报错/状态 */
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
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

// 展开油猴条目
for (let i = 0; i < 8; i++) {
  await sleep(1200);
  const ok = await ev(`(function(){
    var m = document.querySelector('extensions-manager');
    if (!m) return 'no-manager';
    var list = m.shadowRoot.querySelector('extensions-item-list');
    if (!list) return 'no-list';
    var items = list.shadowRoot.querySelectorAll('extensions-item');
    if (!items.length) return 'no-items';
    for (var i = 0; i < items.length; i++) {
      var id = items[i].getAttribute('id') || '';
      if (id.indexOf('${TM}') >= 0) {
        var btn = items[i].shadowRoot.querySelector('#detailsButton');
        if (btn) { btn.click(); return 'expanded'; }
        return 'no-details-button';
      }
    }
    return 'not-found:' + items.length;
  })()`);
  if (ok !== 'no-manager' && ok !== 'no-list' && ok !== 'no-items') { console.log('expand -> ' + ok); break; }
}
await sleep(2500);

const out = await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var res = { errors: [], toggles: [], info: '' };
  var list = m.shadowRoot.querySelector('extensions-item-list');
  var items = list.shadowRoot.querySelectorAll('extensions-item');
  for (var i = 0; i < items.length; i++) {
    var id = items[i].getAttribute('id') || '';
    if (id.indexOf('${TM}') < 0) continue;
    var sr = items[i].shadowRoot;
    res.info = (sr.textContent || '').replace(/\\s+/g, ' ').slice(0, 400);
    var eb = sr.querySelector('extensions-error-list') || sr.querySelector('[class*=error]');
    if (eb) res.errors.push((eb.textContent || '').replace(/\\s+/g, ' ').slice(0, 400));
    var toggles = sr.querySelectorAll('cr-toggle, extensions-toggle-row');
    res.toggles.push('toggles=' + toggles.length);
    var en = sr.querySelector('#enableToggle');
    res.toggles.push('enable aria=' + (en ? en.getAttribute('aria-pressed') : 'n/a'));
  }
  // 详情页的错误容器
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  if (dp) {
    var dsr = dp.shadowRoot;
    var eb2 = dsr.querySelector('extensions-error-list');
    if (eb2) res.errors.push('[detail] ' + (eb2.textContent||'').replace(/\\s+/g,' ').slice(0, 500));
    var warn = dsr.querySelector('#warnings, [class*=warning]');
    if (warn) res.errors.push('[warn] ' + (warn.textContent||'').replace(/\\s+/g,' ').slice(0, 300));
    res.info = res.info + ' | detail=' + (dsr.textContent||'').replace(/\\s+/g,' ').slice(0, 500);
  }
  return JSON.stringify(res, null, 1);
})()`);
console.log(out);
c.close();
