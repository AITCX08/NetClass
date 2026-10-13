/** tm-watch.mjs — 监听油猴后台日志 + 打开目标页，看脚本为什么没执行 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const URL_ = A.url || 'https://study.bjqiyang.com/agent/Goods/courses?goods_id=46789&store_id=1';
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
        if (m.method === 'Runtime.consoleAPICalled') this.logs.push('[console.' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 200));
        if (m.method === 'Log.entryAdded') this.logs.push('[' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 200));
        if (m.method === 'Runtime.exceptionThrown') this.logs.push('[exc] ' + String(m.params.exceptionDetails.text || '') + ' ' + String((m.params.exceptionDetails.exception || {}).description || '').slice(0, 200));
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

// 附加到 SW 并打开日志
let list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let sw = list.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
if (!sw) {
  // 触发 SW 启动
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome-extension://' + TM_ID + '/options.html')}`, { method: 'PUT' });
  await sleep(3000);
  list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  sw = list.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
}
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });
await c.send('Log.enable').catch(() => { });

// 打开目标页
console.log('打开: ' + URL_);
const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
await sleep(12000);

console.log('=== 油猴后台日志 ===');
for (const l of c.logs.slice(-30)) console.log('  ' + l);

console.log('');
console.log('=== 页面状态 ===');
const pc = new Cdp(p.webSocketDebuggerUrl);
await pc.open();
await pc.send('Runtime.enable').catch(() => { });
const r = await pc.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href.slice(0, 90),
    shell: !!window.__NETCLASS_SHELL__,
    module: !!window.NetClass,
    hasExt: typeof window.external !== 'undefined' && !!window.external.Tampermonkey,
    video: document.querySelectorAll('video').length
  })`, returnByValue: true
});
console.log('  ' + (r.result && r.result.value));
console.log('  页面控制台:');
for (const l of pc.logs.slice(-15)) console.log('    ' + l);
pc.close();
c.close();
