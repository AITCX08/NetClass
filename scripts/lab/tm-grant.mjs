/** tm-grant.mjs — 在 chrome://extensions 里给油猴开启「允许运行用户脚本」+ 站点访问权限
 *  用法：node tm-grant.mjs --port 9225
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
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

// 1) 展开详情
for (let i = 0; i < 8; i++) {
  await sleep(1200);
  const ok = await ev(`(function(){
    var m = document.querySelector('extensions-manager');
    if (!m) return 'no-manager';
    var list = m.shadowRoot.querySelector('extensions-item-list');
    if (!list) return 'no-list';
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

// 2) 列出详情页里所有 toggle 行
console.log('== 详情页 toggle 行 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  if (!dp) return 'no-detail-view';
  var out = [];
  var rows = dp.shadowRoot.querySelectorAll('extensions-toggle-row, [class*=toggle-row]');
  for (var i = 0; i < rows.length; i++) {
    var t = (rows[i].textContent || '').replace(/\\s+/g, ' ').trim();
    var tg = rows[i].querySelector('cr-toggle, [role=switch]');
    out.push({ i: i, label: t.slice(0, 70), checked: tg ? (tg.getAttribute('aria-pressed') || tg.checked) : 'n/a', id: rows[i].id || '' });
  }
  return JSON.stringify(out, null, 1);
})()`));

// 3) 点亮「允许运行用户脚本」
console.log('== 尝试开启「允许运行用户脚本」 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var rows = dp.shadowRoot.querySelectorAll('extensions-toggle-row, [class*=toggle-row]');
  for (var i = 0; i < rows.length; i++) {
    var t = (rows[i].textContent || '');
    if (!/用户脚本|user script/i.test(t)) continue;
    var tg = rows[i].querySelector('cr-toggle, [role=switch]');
    if (!tg) return 'row found but no toggle';
    var pressed = tg.getAttribute('aria-pressed');
    if (pressed === 'true') return 'already on';
    var box = tg.shadowRoot && tg.shadowRoot.querySelector('#button, .cr-toggle, [part=bar]');
    (box || tg).click();
    return 'clicked (was ' + pressed + ')';
  }
  return 'row not found; rows=' + rows.length;
})()`));
await sleep(2000);

// 4) 站点访问：设为「在所有网站上」
console.log('== 站点访问设置 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  var out = [];
  var sel = dp.shadowRoot.querySelector('#hostAccess, select, [class*=site-access], [class*=host-access]');
  if (sel) out.push('found: ' + sel.tagName + ' id=' + (sel.id||'') + ' val=' + (sel.value||'') + ' text=' + (sel.textContent||'').replace(/\\s+/g,' ').slice(0,120));
  else out.push('no host access control found');
  return out.join(' | ');
})()`));

c.close();
try { await fetch(`http://127.0.0.1:${PORT}/json/close/${p.id}`); } catch { }
