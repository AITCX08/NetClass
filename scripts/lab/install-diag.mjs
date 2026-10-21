/** install-diag.mjs — 诊断安装页为什么不出对话框：读安装页控制台 + 试 file:// 方案
 *  用法：node install-diag.mjs --port 9225
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
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
        if (m.method === 'Log.entryAdded') this.logs.push('[log:' + m.params.entry.level + '] ' + (m.params.entry.text || '').slice(0, 200));
        if (m.method === 'Runtime.consoleAPICalled') this.logs.push('[console] ' + (m.params.args || []).map(a => String(a.value || a.description || '')).join(' ').slice(0, 200));
        if (m.method === 'Runtime.exceptionThrown') this.logs.push('[exc] ' + JSON.stringify(m.params.exceptionDetails).slice(0, 200));
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

// 关掉旧的安装页
const t0 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
for (const t of t0.filter(x => x.url.includes('script_installation') || x.url.includes('netclass.user.js'))) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } catch { }
}
await sleep(1200);

// A) 打开安装页并读控制台
console.log('=== A. 打开安装页并监听控制台 ===');
const a = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://www.tampermonkey.net/script_installation.php#url=http://127.0.0.1:17800/netclass.user.js')}`, { method: 'PUT' })).json();
const ca = new Cdp(a.webSocketDebuggerUrl);
await ca.open();
await ca.send('Page.enable');
await ca.send('Runtime.enable').catch(() => { });
await ca.send('Log.enable').catch(() => { });
await sleep(8000);

const st = await ca.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = { href: location.href, bodyLen: (document.body.innerText||'').length };
    try {
      var r = await fetch('http://127.0.0.1:17800/netclass.user.js', { cache: 'no-store' });
      out.fetchFromPage = r.status + ' len=' + (await r.text()).length;
    } catch (e) { out.fetchFromPage = 'ERR ' + e.message; }
    try {
      out.tmExternal = typeof window.external !== 'undefined' && window.external.Tampermonkey ? Object.keys(window.external.Tampermonkey).slice(0,6) : null;
    } catch (e) { out.tmExternal = 'err'; }
    return JSON.stringify(out);
  })()`, returnByValue: true, awaitPromise: true
});
console.log('  页面状态: ' + (st.result && st.result.value));
console.log('  控制台:');
for (const l of ca.logs.slice(-12)) console.log('    ' + l);
ca.close();

// B) 试 file:// 方案
console.log('');
console.log('=== B. 试 file:// 直接打开本地脚本 ===');
const fileUrl = 'file:///C:/Users/YOURNAME/AppData/Local/TaskMesh/netclass/netclass.user.js';
const b = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(fileUrl)}`, { method: 'PUT' })).json();
await sleep(6000);
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
console.log('  打开后相关页面：');
for (const t of tabs.filter(x => /netclass|script_installation|options\.html|extension:\/\//.test(x.url))) {
  console.log('    [' + t.type + '] ' + t.url.slice(0, 120));
}

const cb = new Cdp(b.webSocketDebuggerUrl);
await cb.open();
await cb.send('Page.enable');
const st2 = await cb.send('Runtime.evaluate', { expression: 'location.href + " | " + document.title', returnByValue: true }).catch(() => null);
console.log('  file:// 页面: ' + (st2 && st2.result ? st2.result.value : '?'));
cb.close();
