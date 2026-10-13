/** tm-hostaccess.mjs — 找到站点访问控件并设为「在所有网站上」 */
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

console.log('== host access 区域 DOM ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var sr = dp.shadowRoot;
  var anchors = ['#no-site-access', '#site-access', '#host-access', '#host-access-select'];
  var out = [];
  for (var i = 0; i < anchors.length; i++) {
    var el = sr.querySelector(anchors[i]);
    if (el) {
      var parent = el.parentElement;
      out.push('FOUND ' + anchors[i] + ' tag=' + el.tagName + ' parentTag=' + (parent ? parent.tagName : '?') + ' parentHtml=' + (parent ? parent.outerHTML.slice(0, 400) : ''));
    }
  }
  if (!out.length) {
    // 全局搜关键字
    var html = sr.innerHTML || '';
    var idx = html.indexOf('site-access');
    out.push('no anchors; innerHTML has site-access at ' + idx + (idx >= 0 ? ' :: ' + html.slice(Math.max(0, idx - 200), idx + 400) : ''));
  }
  // 找所有 select / 按钮
  var sels = sr.querySelectorAll('select');
  for (var j = 0; j < sels.length; j++) out.push('select id=' + sels[j].id + ' opts=' + Array.from(sels[j].options).map(function(o){ return o.value + ':' + o.text; }).join('|').slice(0, 200));
  var btns = sr.querySelectorAll('cr-button, button');
  for (var k = 0; k < btns.length && k < 15; k++) out.push('btn text=' + (btns[k].textContent||'').trim().slice(0, 30) + ' id=' + (btns[k].id||''));
  return out.join('\\n');
})()`));
c.close();
