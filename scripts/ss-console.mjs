/** ss-console.mjs — 抓 shengsheng 页面控制台 + CSP 信息 */
const PORT = Number(process.argv[2] || 9224);
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
        if (m.method === 'Runtime.consoleAPICalled') this.logs.push('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 220));
        if (m.method === 'Log.entryAdded') this.logs.push('[' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 220));
        if (m.method === 'Runtime.exceptionThrown') this.logs.push('[EXC] ' + String(m.params.exceptionDetails.text || '').slice(0, 220));
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
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
if (!page) { console.log('no page'); process.exit(1); }
console.log('page: ' + page.url.slice(0, 70));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });
await c.send('Log.enable').catch(() => { });

await c.send('Page.reload', { ignoreCache: true });
await sleep(25000);

console.log('=== 控制台 ===');
for (const l of c.logs.slice(-30)) console.log('  ' + l);

const r = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    module: !!window.NetClass,
    hasShellFlag: !!window.__NETCLASS_SHELL__,
    cspMeta: (function(){ var m = document.querySelector('meta[http-equiv="Content-Security-Policy"]'); return m ? m.content : null; })(),
    scripts: Array.from(document.scripts).map(s => String(s.src || 'inline').slice(0, 50)).slice(0, 10)
  })`, returnByValue: true
});
console.log('=== 页面状态 ===');
console.log('  ' + (r.result && r.result.value));
c.close();
