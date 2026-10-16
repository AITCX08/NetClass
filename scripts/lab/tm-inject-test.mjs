/** tm-inject-test.mjs — 验证 userScripts 到底能不能注入：看 matches 内容 + 手动 execute 测试 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = {};
    var reg = await chrome.userScripts.getScripts();
    out.detail = reg.map(function(s){
      return { id: s.id, matches: s.matches, excludeMatches: s.excludeMatches, world: s.world,
               runAt: s.runAt, allFrames: s.allFrames, jsLen: (s.js||[]).map(function(x){ return String(x).length; }),
               jsHead: (s.js||[]).map(function(x){ return String(x).slice(0, 90); }) };
    });
    // 试着手动执行
    try {
      var res = await chrome.userScripts.execute({ target: { tabId: null }, js: [{ code: 'window.__TM_TEST__ = 42;' }], world: 'MAIN', injectImmediately: true });
      out.execResult = JSON.stringify(res);
    } catch (e) { out.execErr = String(e); }
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);

// 用页面里已有的 tab 测试 execute
const pages = list.filter(t => t.type === 'page' && t.url.includes('bjqiyang'));
if (pages[0]) {
  const pc = new Cdp(pages[0].webSocketDebuggerUrl);
  await pc.open();
  await pc.send('Runtime.enable');
  const before = await pc.send('Runtime.evaluate', { expression: 'typeof window.__TM_TEST__', returnByValue: true });
  console.log('页面里 __TM_TEST__ (before) = ' + (before.result && before.result.value));

  const r2 = await c.send('Runtime.evaluate', {
    expression: `(async function(){
      var tabs = [];
      try { tabs = await chrome.tabs.query({ url: '*://study.bjqiyang.com/*' }); } catch (e) { return 'tabsErr ' + e; }
      if (!tabs.length) return 'no tabs';
      try {
        var res = await chrome.userScripts.execute({ target: { tabId: tabs[0].id }, js: [{ code: 'window.__TM_TEST__ = 42;' }], world: 'MAIN', injectImmediately: true });
        return 'exec ok: ' + JSON.stringify(res);
      } catch (e) { return 'execErr ' + String(e); }
    })()`, returnByValue: true, awaitPromise: true
  }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  console.log('手动注入: ' + (r2.result && r2.result.value));
  await sleep(1500);
  const after = await pc.send('Runtime.evaluate', { expression: 'typeof window.__TM_TEST__', returnByValue: true });
  console.log('页面里 __TM_TEST__ (after) = ' + (after.result && after.result.value));
  pc.close();
}
c.close();
