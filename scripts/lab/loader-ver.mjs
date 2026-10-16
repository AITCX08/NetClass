/** loader-ver.mjs — 查加载器 SW 里实际运行的代码版本（manifest 版本 + 特征函数） */
const PORT = Number(process.argv[2] || 9224);
const LOADER = 'ebikemhgdinpnfeanicfkahlehcojjmn';
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

// 唤醒 SW
const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions')}`, { method: 'PUT' })).json();
await sleep(4000);
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const ev = async expr => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  return r.err || (r.exceptionDetails ? 'EXC' : (r.result && r.result.value));
};
for (let i = 0; i < 6; i++) {
  await sleep(1400);
  const ok = await ev(`(function(){
    var m = document.querySelector('extensions-manager'); if (!m) return 'x';
    var list = m.shadowRoot.querySelector('extensions-item-list'); if (!list) return 'x';
    var items = list.shadowRoot.querySelectorAll('extensions-item');
    for (var i = 0; i < items.length; i++) {
      if ((items[i].getAttribute('id') || '').indexOf('${LOADER}') >= 0) {
        var b = items[i].shadowRoot.querySelector('#detailsButton'); if (b) { b.click(); return 'ok'; }
      }
    }
    return 'x';
  })()`);
  if (ok === 'ok') break;
}
await sleep(2000);

// 顺便看看详情页里的版本号
console.log('详情页版本: ' + await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view'); if (!dp) return 'x';
  var t = (dp.shadowRoot.textContent || '').replace(/\\s+/g, ' ');
  var mm = t.match(/版本\\s*([0-9.]+)/);
  return mm ? mm[1] : t.slice(0, 120);
})()`));

// 点「Service Worker」检查视图唤醒
await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view'); if (!dp) return 'x';
  var links = Array.from(dp.shadowRoot.querySelectorAll('a, button'));
  var sw = links.filter(function(e){ return /Service Worker/i.test(e.textContent || ''); });
  if (sw.length) { sw[0].click(); return 'clicked'; }
  return 'none';
})()`);
await sleep(5000);
c.close();
try { await fetch(`http://127.0.0.1:${PORT}/json/close/${p.id}`); } catch { }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const swT = list.find(t => t.type === 'service_worker' && t.url && t.url.includes(LOADER));
if (!swT) { console.log('SW 没起来'); process.exit(1); }
const c2 = new Cdp(swT.webSocketDebuggerUrl);
await c2.open();
const r = await c2.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = {};
    out.manifestVersion = chrome.runtime.getManifest().version;
    out.permissions = chrome.runtime.getManifest().permissions;
    out.hasStamp = typeof stamp === 'function';
    out.hasEnsureThenInject = typeof ensureThenInject === 'function';
    out.hasLogRing = false;
    try { var st = await chrome.storage.local.get(null); out.hasLogRing = !!st.logRing; out.logLen = (st.logRing||[]).length; out.buildId = st.lastBuildId || null; } catch (e) {}
    var reg = await chrome.userScripts.getScripts();
    out.codeHead = String((reg[0] && reg[0].js && reg[0].js[0] && reg[0].js[0].code) || '').slice(0, 70);
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true, awaitPromise: true
});
console.log('');
console.log(r.result && r.result.value);
c2.close();
