/** tm-dashboard.mjs — 打开油猴管理面板，读它的状态（脚本是否启用 / 是否有 devmode 提示） */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
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
        if (m.method === 'Runtime.consoleAPICalled') this.logs.push('[' + m.params.type + '] ' + (m.params.args || []).map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ').slice(0, 200));
        if (m.method === 'Runtime.exceptionThrown') this.logs.push('[EXC] ' + String(m.params.exceptionDetails.text || '').slice(0, 200));
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

const url = `chrome-extension://${TM_ID}/options.html`;
const p = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
await sleep(9000);
const c = new Cdp(p.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });
await c.send('Page.enable').catch(() => { });

const r = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    url: location.href,
    bodyLen: (document.body.innerText||'').length,
    text: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 800),
    hasDevModeWarning: /developer mode|开发者模式/i.test(document.body.innerText||''),
    scriptRows: Array.from(document.querySelectorAll('[class*=script_row],[class*=scriptrow],tr')).slice(1,8).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').slice(0, 90); })
  }, null, 1)`, returnByValue: true
});
console.log(r.result && r.result.value);
console.log('页面日志:');
for (const l of c.logs.slice(-12)) console.log('  ' + l);
c.close();
