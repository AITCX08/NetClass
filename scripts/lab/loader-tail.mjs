/** loader-tail.mjs — 读加载器 SW 的日志尾巴与去重签名，确认不再重复注册 */
const PORT = Number(process.argv[2] || 9224);
const LOADER = 'ebikemhgdinpnfeanicfkahlehcojjmn';

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, { res }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => res({ result: { value: null } }), 12000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const sw = list.find(t => t.type === 'service_worker' && t.url.includes(LOADER));
if (!sw) { console.log('加载器 SW 未运行'); process.exit(1); }
const c = new Cdp(sw.webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', {
  expression: `chrome.storage.local.get(['logRing','lastSig']).then(function(v){
    var ring = v.logRing || [];
    var regs = ring.filter(function(l){ return l.indexOf('registered') >= 0; });
    return JSON.stringify({
      lastSig: v.lastSig || null,
      ringLen: ring.length,
      totalRegistered: regs.length,
      last5Registered: regs.slice(-5),
      tail: ring.slice(-8)
    }, null, 1);
  })`, returnByValue: true, awaitPromise: true
});
console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value));
c.close();
