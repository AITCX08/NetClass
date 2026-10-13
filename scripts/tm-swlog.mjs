/** tm-swlog.mjs — 监听油猴 service worker 的日志，同时打开目标页，看脚本为何不注入 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const URL_ = A.url || 'https://study.bjqiyang.com/agent/Goods/courses?goods_id=46789&store_id=1&sw=1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.logs = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Runtime.consoleAPICalled') this.logs.push('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 250));
        if (m.method === 'Runtime.exceptionThrown') this.logs.push('[EXC] ' + String(m.params.exceptionDetails.text || '') + ' ' + String(((m.params.exceptionDetails.exception || {}).description) || '').slice(0, 250));
        if (m.method === 'Log.entryAdded') this.logs.push('[' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 250));
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
if (!sw) { console.log('no SW'); process.exit(1); }
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });
await c.send('Log.enable').catch(() => { });

// 复刻 TM 的注册状态 & 试试手动执行
const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = {};
    try {
      var reg = await chrome.userScripts.getScripts();
      out.registered = reg.map(function(s){ return { id: s.id, world: s.world, matches: (s.matches||[]).length, js: (s.js||[]).length, allFrames: s.allFrames }; });
    } catch (e) { out.regErr = String(e); }
    try {
      out.worlds = await chrome.userScripts.getWorldConfigurations();
    } catch (e) { out.worldErr = String(e); }
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true, awaitPromise: true
});
console.log('== 注册详情 ==');
console.log(r.result && r.result.value);

console.log('');
console.log('== 打开页面，观察 SW 日志 ==');
const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
await sleep(15000);
console.log('SW 日志（最后 25 条）:');
for (const l of c.logs.slice(-25)) console.log('  ' + l);

console.log('');
console.log('== 页面是否有脚本 ==');
const pc = new Cdp(p.webSocketDebuggerUrl);
await pc.open();
await pc.send('Runtime.enable').catch(() => { });
const r2 = await pc.send('Runtime.evaluate', { expression: 'JSON.stringify({netclass: !!window.NetClass, ext: typeof window.external!=="undefined" && !!window.external.Tampermonkey})', returnByValue: true });
console.log('  ' + (r2.result && r2.result.value));
const r3 = await pc.send('Runtime.evaluate', { expression: 'JSON.stringify({sw: navigator.serviceWorker ? "yes" : "no", scripts: Array.from(document.scripts).map(s=>String(s.src||"").slice(0,60)).filter(Boolean).slice(0,8)})', returnByValue: true });
console.log('  ' + (r3.result && r3.result.value));
pc.close();
c.close();
