/** loader-swlog.mjs — 监听加载器 SW 的异常/日志，并 dump chrome 对象状态 */
const PORT = Number(process.argv[2] || 9224);
const LOADER = 'ebikemhgdinpnfeanicfkahlehcojjmn';
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
        if (m.method === 'Runtime.exceptionThrown') this.logs.push('[EXC] ' + String(m.params.exceptionDetails.text || '') + ' :: ' + String(((m.params.exceptionDetails.exception || {}).description) || '').slice(0, 300));
        if (m.method === 'Runtime.consoleAPICalled') this.logs.push('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 250));
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
const sw = list.find(t => t.type === 'service_worker' && t.url && t.url.includes(LOADER));
if (!sw) { console.log('加载器 SW 不在运行中'); process.exit(1); }
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });
await c.send('Log.enable').catch(() => { });

const r = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    chromeType: typeof chrome,
    chromeKeys: (typeof chrome === 'object' && chrome) ? Object.keys(chrome).slice(0, 30) : null,
    hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime,
    extId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || null,
    ua: navigator.userAgent.slice(0, 60),
    selfKeys: Object.keys(self).filter(function(k){ return /NETCLASS|lastCode|importScripts/i.test(k); }).slice(0, 10),
    importScriptsType: typeof self.importScripts
  })`, returnByValue: true
});
console.log('SW 状态: ' + (r.result && r.result.value));
console.log('');
console.log('日志:');
for (const l of c.logs.slice(-15)) console.log('  ' + l);
c.close();
