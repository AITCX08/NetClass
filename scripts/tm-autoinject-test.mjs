/** tm-autoinject-test.mjs — 自己注册一个 user script，验证「自动注入」是否可用（对照 TM 的注册） */
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

console.log('== 注册自己的测试 user script ==');
const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    try {
      await chrome.userScripts.unregister({ ids: ['nctest'] }).catch(function(){});
      await chrome.userScripts.register([{
        id: 'nctest',
        matches: ['<all_urls>'],
        js: [{ code: 'window.__NC_AUTOINJECT__ = "yes-" + location.hostname;' }],
        runAt: 'document_start',
        allFrames: false,
        world: 'MAIN'
      }]);
      var reg = await chrome.userScripts.getScripts({ ids: ['nctest'] });
      return 'registered: ' + JSON.stringify(reg.map(function(s){ return { id: s.id, world: s.world, jsType: typeof (s.js||[])[0], jsVal: String((s.js||[])[0]).slice(0,60) }; }));
    } catch (e) { return 'ERR ' + String(e); }
  })()`, returnByValue: true, awaitPromise: true
});
console.log('  ' + (r.result && r.result.value));

console.log('== 打开新页看是否自动注入 ==');
const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://study.bjqiyang.com/agent/Goods/index?goods_id=46789&store_id=1&auto=1')}`, { method: 'PUT' })).json();
await sleep(12000);
const pc = new Cdp(p.webSocketDebuggerUrl);
await pc.open();
await pc.send('Runtime.enable');
const r2 = await pc.send('Runtime.evaluate', { expression: 'JSON.stringify({auto: window.__NC_AUTOINJECT__ || null, netclass: !!window.NetClass})', returnByValue: true });
console.log('  页面: ' + (r2.result && r2.result.value));
pc.close();

console.log('== 清理 ==');
const r3 = await c.send('Runtime.evaluate', {
  expression: `chrome.userScripts.unregister({ ids: ['nctest'] }).then(function(){ return 'unregistered'; }).catch(function(e){ return 'ERR ' + e; })`,
  returnByValue: true, awaitPromise: true
});
console.log('  ' + (r3.result && r3.result.value));
c.close();
