/** tm-reload.mjs — 重载油猴扩展让新脚本生效，并检查注册状态 */
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

async function findSw() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
}

let sw = await findSw();
if (!sw) { console.log('no service worker'); process.exit(1); }
let c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
console.log('→ runtime.reload()');
await c.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }).catch(() => { });
c.close();
await sleep(7000);

sw = await findSw();
if (!sw) { console.log('reload 后找不到 service worker'); process.exit(1); }
c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = {};
    var reg = await chrome.userScripts.getScripts();
    out.registered = reg.map(function(s){ return s.id; });
    var st = await chrome.storage.local.get(null);
    out.scripts = Object.keys(st).filter(function(k){ return k.indexOf('!extdb.@uid#') === 0; }).map(function(k){ return st[k].value; });
    // 看 netclass 的 meta
    var keys = Object.keys(st).filter(function(k){ return k.indexOf('@meta#') === 0; });
    out.metas = keys.map(function(k){ var v = st[k].value; return { name: v.name, enabled: v.enabled, matches: (v.matches||[]).slice(0,3) }; });
    return JSON.stringify(out);
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
c.close();
