/** ss-isolate.mjs — 关掉脚本，观察站点自己能否起播（判断是不是脚本干扰） */
const PORT = Number(process.argv[2] || 9224);
const MODE = process.argv[3] || 'off';   // off | on
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Runtime.enable').catch(() => { });

// 写配置：enabled = (MODE === 'on')
const set = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var cfg = {};
    try { cfg = JSON.parse(localStorage.getItem('netclass.cfg.v3') || '{}'); } catch (e) {}
    cfg.enabled = ${MODE === 'on' ? 'true' : 'false'};
    if (${MODE === 'on' ? 'true' : 'false'}) { cfg.mute = true; cfg.autoPlay = true; cfg.autoNext = true; cfg.autoQuiz = true; cfg.rate = 1; cfg.userRate = false; }
    localStorage.setItem('netclass.cfg.v3', JSON.stringify(cfg));
    return JSON.stringify(cfg);
  })()`, returnByValue: true
});
console.log('配置写入: ' + (set.result && set.result.value));

// 重置播放器状态：刷新页面
await c.send('Page.enable');
await c.send('Page.reload', { ignoreCache: true });
await sleep(35000);

const st = await c.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    module: !!window.NetClass,
    enabled: window.NetClass ? window.NetClass.cfg.enabled : null,
    v: (function(){ var v = document.querySelector('video'); return v ? { rs: v.readyState, dur: v.duration, t: Math.round(v.currentTime||0), paused: v.paused, net: v.networkState } : null; })(),
    cls: (document.querySelector('.video-player') || {}).className || null,
    active: Array.from(document.querySelectorAll('.lesson-item')).filter(function(e){ return e.className.indexOf('active') >= 0; }).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').slice(0,26); })
  })`, returnByValue: true
});
console.log('35s 后: ' + (st.result && st.result.value));
c.close();
