/** ss-stream-test.mjs — 直接测 shengsheng 这条流：m3u8 + 首个分片能不能取到 */
const PORT = Number(process.argv[2] || 9224);
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    var out = {};
    // 从页面抓当前播放地址
    var m3u8 = null;
    try {
      var perf = performance.getEntriesByType('resource').map(function(e){ return e.name; });
      var hit = perf.filter(function(u){ return /\\.m3u8/.test(u); });
      out.m3u8Urls = hit.slice(-3);
      m3u8 = hit.length ? hit[hit.length-1] : null;
    } catch (e) { out.perfErr = String(e); }
    if (!m3u8) return JSON.stringify(out);
    try {
      var r1 = await fetch(m3u8, { cache: 'no-store' });
      var txt = await r1.text();
      out.m3u8 = { status: r1.status, len: txt.length, head: txt.slice(0, 200) };
      var mm = txt.match(/^([^#\\r\\n].*\\.ts)\\s*$/m);
      if (mm) {
        var base = m3u8.replace(/[^\\/]*$/, '');
        var segUrl = base + mm[1];
        var t0 = Date.now();
        var r2 = await fetch(segUrl, { cache: 'no-store' });
        var buf = await r2.arrayBuffer();
        var b = new Uint8Array(buf.slice(0, 16));
        out.segment = { url: segUrl.slice(-60), status: r2.status, bytes: buf.byteLength, ms: Date.now()-t0, sig: Array.from(b).map(function(x){ return x.toString(16).padStart(2,'0'); }).join(' ') };
      } else out.segment = 'no .ts line found';
    } catch (e) { out.fetchErr = String(e); }
    return JSON.stringify(out, null, 1).slice(0, 1800);
  })()`, returnByValue: true, awaitPromise: true
});
console.log(r.result && r.result.value);
c.close();
