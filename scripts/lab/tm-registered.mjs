/** tm-registered.mjs — 查油猴已注册到 chrome.userScripts 的脚本（真实执行清单） */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

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

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = targets.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
if (!sw) { console.log('no service worker'); process.exit(1); }
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = {};
    try {
      var scripts = await chrome.userScripts.getScripts();
      out.count = scripts.length;
      out.ids = scripts.map(function(s){ return { id: s.id, matches: (s.matches||[]).slice(0,3), world: s.world, js: (s.js||[]).length }; }).slice(0, 12);
    } catch (e) { out.err = String(e); }
    try { out.worlds = await chrome.userScripts.getWorldConfigurations(); } catch (e) { out.worldErr = String(e); }
    try {
      var st = await chrome.storage.local.get(null);
      out.uidKeys = Object.keys(st).filter(function(k){ return k.indexOf('@uid#') >= 0; }).map(function(k){ return st[k] && st[k].value; });
      out.hasNetclass = JSON.stringify(out.uidKeys).indexOf('netclass') >= 0;
    } catch (e) { out.storeErr = String(e); }
    return JSON.stringify(out);
  })()`,
  returnByValue: true, awaitPromise: true
});
if (r.exceptionDetails) console.log('EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
else console.log(r.result && r.result.value);
c.close();
