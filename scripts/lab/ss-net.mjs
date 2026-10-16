/** ss-net.mjs — 抓 shengsheng 页面的视频相关请求，定位卡点 */
const PORT = Number(process.argv[2] || 9224);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.reqs = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Network.requestWillBeSent') {
          const u2 = m.params.request.url;
          if (/vod|play|video|auth|m3u8|ts\?|mp4|record|learning|Learn|popQuiz/i.test(u2)) this.reqs.push({ kind: 'REQ', url: u2.slice(0, 150) });
        }
        if (m.method === 'Network.responseReceived') {
          const u2 = m.params.response.url;
          if (/vod|play|video|auth|m3u8|ts\?|mp4|record|Learn|popQuiz/i.test(u2)) this.reqs.push({ kind: 'RES', status: m.params.response.status, url: u2.slice(0, 150) });
        }
        if (m.method === 'Network.loadingFailed') {
          this.reqs.push({ kind: 'FAIL', err: String(m.params.errorText || '').slice(0, 80), reqId: m.params.requestId });
        }
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
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Network.enable');
await c.send('Page.enable');
await c.send('Runtime.enable').catch(() => { });

console.log('reload...');
await c.send('Page.reload', { ignoreCache: true });
await sleep(30000);

console.log('=== 视频相关请求 ===');
const seen = new Set();
for (const r of c.reqs) {
  const key = r.kind + r.url;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log('  ' + r.kind + ' ' + (r.status ? '[' + r.status + '] ' + r.url : r.url || r.err));
}

console.log('');
console.log('=== 视频元素状态 ===');
const st = await c.send('Runtime.evaluate', { expression: `JSON.stringify({v:(function(){const v=document.querySelector('video'); return v?{rs:v.readyState,dur:v.duration,t:Math.round(v.currentTime||0),paused:v.paused,net:v.networkState}:null;})(), cls:(document.querySelector('.video-player')||{}).className||null})`, returnByValue: true });
console.log('  ' + (st.result && st.result.value));
c.close();
