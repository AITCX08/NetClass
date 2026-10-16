/** loader-inject-test.mjs — 直接在加载器 SW 里测 tabs.query(url过滤器) 与注入 */
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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const swT = list.find(t => t.type === 'service_worker' && t.url && t.url.includes(LOADER));
if (!swT) { console.log('加载器 SW 未运行（先跑 loader-reload.mjs 唤醒）'); process.exit(1); }
const c = new Cdp(swT.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = {};
    var MATCHES = ['https://edu.shengshengketang.com/*', 'https://study.bjqiyang.com/*'];
    try { var all = await chrome.tabs.query({}); out.all = all.map(function(t){ return t.id + ':' + String(t.url).slice(0, 50); }); } catch (e) { out.allErr = String(e); }
    try { var m1 = await chrome.tabs.query({ url: MATCHES }); out.byPattern = m1.map(function(t){ return t.id + ':' + String(t.url).slice(0, 50); }); } catch (e) { out.patternErr = String(e); }
    try { var m2 = await chrome.tabs.query({ url: 'https://edu.shengshengketang.com/*' }); out.byOne = m2.map(function(t){ return t.id; }); } catch (e) { out.oneErr = String(e); }
    // 直接向 shengsheng 标签注入测试
    var target = (out.byOne && out.byOne[0]) || null;
    if (target == null && out.all && out.all.length) {
      var found = out.all.filter(function(s){ return s.indexOf('shengshengketang') >= 0; });
      if (found.length) target = Number(found[0].split(':')[0]);
    }
    out.targetTab = target;
    if (target != null) {
      try {
        var probe = await chrome.userScripts.execute({ target: { tabId: target }, js: [{ code: 'JSON.stringify({ has: !!window.NetClass, build: window.__NETCLASS_BUILD_ID__ || null })' }], world: 'MAIN', injectImmediately: true });
        out.probe = probe;
      } catch (e) { out.probeErr = String(e); }
      try {
        var st = stamp ? stamp(self.__lastCode || self.NETCLASS_BUNDLED) : null;
        var code = st ? st.code : (self.__lastCode || self.NETCLASS_BUNDLED);
        await chrome.userScripts.execute({ target: { tabId: target }, js: [{ code: code }], world: 'MAIN', injectImmediately: true });
        out.injected = true;
      } catch (e) { out.injectErr = String(e); }
      await new Promise(function(r2){ setTimeout(r2, 1500); });
      try {
        var after = await chrome.userScripts.execute({ target: { tabId: target }, js: [{ code: 'JSON.stringify({ has: !!window.NetClass, build: window.__NETCLASS_BUILD_ID__ || null })' }], world: 'MAIN', injectImmediately: true });
        out.after = after;
      } catch (e) { out.afterErr = String(e); }
    }
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
c.close();
