/** loader-sw.mjs — 通过 chrome://extensions 的「检查视图」唤醒加载器 SW，然后读它的状态 */
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
  return r.err || (r.exceptionDetails ? 'EXC' : (r.result && r.result.value));
};

// 展开加载器详情并点「Service Worker」检查视图
for (let i = 0; i < 6; i++) {
  await sleep(1400);
  const ok = await ev(`(function(){
    var m = document.querySelector('extensions-manager'); if (!m) return 'x';
    var list = m.shadowRoot.querySelector('extensions-item-list'); if (!list) return 'x';
    var items = list.shadowRoot.querySelectorAll('extensions-item');
    for (var i = 0; i < items.length; i++) {
      if ((items[i].getAttribute('id') || '').indexOf('${LOADER}') >= 0) {
        var b = items[i].shadowRoot.querySelector('#detailsButton');
        if (b) { b.click(); return 'ok'; }
      }
    }
    return 'x';
  })()`);
  if (ok === 'ok') break;
}
await sleep(2500);

console.log('== 点 Service Worker 检查视图 ==');
console.log(await ev(`(function(){
  var m = document.querySelector('extensions-manager');
  var dp = m.shadowRoot.querySelector('extensions-detail-view');
  if (!dp) return 'no detail view';
  var sr = dp.shadowRoot;
  var links = Array.from(sr.querySelectorAll('a, button, [role=link], [class*=link]'));
  var sw = links.filter(function(e){ return /Service Worker|服务工作线程|检查视图/i.test((e.textContent||'') + ' ' + (e.getAttribute('href')||'')); });
  if (!sw.length) return 'no sw link; links=' + links.map(function(e){ return (e.textContent||'').trim().slice(0,20); }).filter(Boolean).slice(0,10).join('|');
  sw[0].click();
  return 'clicked: ' + (sw[0].textContent||'').trim().slice(0,30);
})()`));
await sleep(6000);

console.log('');
console.log('== 现在的 targets ==');
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
for (const t of list.filter(x => x.url && (x.url.includes(LOADER) || x.type === 'service_worker'))) {
  console.log('  [' + t.type + '] ' + t.url.slice(0, 100));
}

// 找到就查询
const swT = list.find(t => t.url && t.url.includes(LOADER));
if (swT) {
  const c2 = new Cdp(swT.webSocketDebuggerUrl);
  await c2.open();
  const r = await c2.send('Runtime.evaluate', {
    expression: `(async function(){
      var out = {};
      try { out.storage = await chrome.storage.local.get(null); } catch (e) { out.storageErr = String(e); }
      try { out.registered = (await chrome.userScripts.getScripts()).map(function(s){ return { id: s.id, matches: s.matches, len: (s.js||[]).map(function(x){ return x.code ? String(x.code).length : 'file'; }) }; }); } catch (e) { out.regErr = String(e); }
      try { var tabs = await chrome.tabs.query({ url: Array.from(['https://edu.shengshengketang.com/*']) }); out.sshTabs = tabs.map(function(t){ return t.id + ':' + String(t.url).slice(0,50); }); } catch (e) { out.tabErr = String(e); }
      out.hasCode = !!self.__lastCode;
      out.bundled = !!self.NETCLASS_BUNDLED;
      return JSON.stringify(out, null, 1);
    })()`, returnByValue: true, awaitPromise: true
  });
  console.log('');
  console.log('== 加载器 SW 状态 ==');
  console.log(r.result && r.result.value);
  c2.close();
} else {
  console.log('  (加载器 SW 仍未出现)');
}
c.close();
