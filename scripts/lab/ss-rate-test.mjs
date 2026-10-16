/** ss-rate-test.mjs — 实测 shengsheng 是否允许倍速：查播放器控件 + 试设 2x 看是否被站点拦截 */
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
if (!page) { console.log('没有 shengsheng 页面'); process.exit(1); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

// 1) 播放器里有没有倍速控件 / 有没有「禁止快进」提示
console.log('== 1) 播放器控件探查 ==');
const r1 = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    currentRate: (function(){ var v = document.querySelector('video'); return v ? v.playbackRate : null; })(),
    rateControls: Array.from(document.querySelectorAll('[class*=rate], [class*=speed], [class*=倍速], [class*=playback]')).map(function(e){
      return { cls: String(e.className).slice(0, 60), text: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 40), visible: !!(e.offsetWidth || e.offsetHeight) };
    }).slice(0, 12),
    disableFast: Array.from(document.querySelectorAll('[class*=disable-fast], [class*=disableFast]')).map(function(e){
      return { cls: String(e.className).slice(0, 50), text: (e.innerText || '').trim().slice(0, 40) };
    }),
    playerCls: (function(){ var e = document.querySelector('.video-player'); return e ? String(e.className) : null; })()
  }, null, 1)`, returnByValue: true
});
console.log(r1.result && r1.result.value);

// 2) 试着设 2x，看站点是否把它拽回来
console.log('');
console.log('== 2) 试设 2x（观察 8 秒）==');
await c.send('Runtime.evaluate', {
  expression: `(function(){
    var v = document.querySelector('video');
    if (!v) return 'no video';
    v.playbackRate = 2;
    window.__NC_RATE_TEST__ = { set: Date.now(), timeline: [] };
    var rec = function(tag){ window.__NC_RATE_TEST__.timeline.push({ t: Date.now() - window.__NC_RATE_TEST__.set, rate: v.playbackRate, paused: v.paused, tag: tag }); };
    rec('after-set');
    v.addEventListener('ratechange', function(){ rec('ratechange'); });
    return 'set to 2';
  })()`, returnByValue: true
});
await sleep(8000);
const r2 = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    now: (function(){ var v = document.querySelector('video'); return v ? { rate: v.playbackRate, paused: v.paused, t: Math.round(v.currentTime) } : null; })(),
    timeline: (window.__NC_RATE_TEST__ || {}).timeline || []
  })`, returnByValue: true
});
console.log(r2.result && r2.result.value);

// 3) 量一下真实推进速度
console.log('');
console.log('== 3) 实测推进速度（10 秒）==');
const t0 = await c.send('Runtime.evaluate', { expression: 'document.querySelector("video").currentTime', returnByValue: true });
const w0 = Date.now();
await sleep(10000);
const t1 = await c.send('Runtime.evaluate', { expression: 'document.querySelector("video").currentTime', returnByValue: true });
const r3 = await c.send('Runtime.evaluate', { expression: 'JSON.stringify({rate: document.querySelector("video").playbackRate, paused: document.querySelector("video").paused})', returnByValue: true });
const dt = (Date.now() - w0) / 1000;
const dm = (t1.result.value - t0.result.value);
console.log('  真实 ' + dt.toFixed(1) + 's / 媒体 ' + dm.toFixed(1) + 's → ' + (dm / dt).toFixed(2) + 'x   ' + r3.result.value);
c.close();
