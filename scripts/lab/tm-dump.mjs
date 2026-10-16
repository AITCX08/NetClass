/** tm-dump.mjs — 列出 TM 里 NetClass 脚本的所有存储键（诊断为什么没被注册/执行） */
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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes(TM_ID));
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var st = await chrome.storage.local.get(null);
    var out = { allKeys: Object.keys(st).length, netclassKeys: [] };
    // 找 uuid：@uid# 里值为 NetClass 的那个
    var uidKey = Object.keys(st).filter(function(k){ return k.indexOf('!extdb.@uid#') === 0 && String(st[k].value).indexOf('NetClass') >= 0; })[0];
    if (!uidKey) return JSON.stringify({ err: 'no uidKey with NetClass' });
    var uuid = uidKey.split('@uid#')[1];
    out.uuid = uuid;
    Object.keys(st).forEach(function(k){
      if (k.indexOf(uuid) >= 0) {
        var v = st[k].value;
        out.netclassKeys.push({ key: k.split('!extdb.')[1], type: typeof v, preview: JSON.stringify(v).slice(0, 220) });
      }
    });
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
c.close();
