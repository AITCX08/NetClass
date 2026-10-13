/** ss-logs.mjs — 抓 shengsheng 页面控制台日志（看壳的加载路径与适配器行为） */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const RELOAD = A.reload === true || A.reload === 'true';
const SECS = Number(A.secs || 25);
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
        if (m.method === 'Runtime.consoleAPICalled') {
          this.logs.push('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 220));
        }
        if (m.method === 'Log.entryAdded') this.logs.push('[' + m.params.entry.level + '] ' + String(m.params.entry.text || '').slice(0, 220));
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
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });
await c.send('Log.enable').catch(() => { });

if (RELOAD) {
  console.log('reload page...');
  await c.send('Page.reload', { ignoreCache: true });
}
await sleep(SECS * 1000);
console.log('=== 控制台（NetClass 相关）===');
for (const l of c.logs.filter(x => /NetClass|TM|Tampermonkey|error|Error|拒绝|blocked/i.test(x)).slice(-40)) console.log('  ' + l);
c.close();
