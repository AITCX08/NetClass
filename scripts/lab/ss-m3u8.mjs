/** ss-m3u8.mjs — 看 m3u8 内容 + 页面所有失败请求 + 尝试手动起播 */
const PORT = Number(process.argv[2] || 9224);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(u) { this.u = u; this.id = 0; this.pending = new Map(); this.fails = []; this.all = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.u);
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws')));
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.method === 'Network.loadingFailed') this.fails.push({ err: m.params.errorText, reqId: m.params.requestId, blocked: m.params.blockedReason || null });
        if (m.method === 'Network.requestWillBeSent') this.all.push(m.params.request.url);
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
await c.send('Network.enable');
await c.send('Runtime.enable').catch(() => { });

// 1) 直接取 m3u8 内容
console.log('=== m3u8 内容 ===');
const m3u8 = await c.send('Runtime.evaluate', {
  expression: `(async function(){
    try {
      var r = await fetch('https://video.mengkezaixian.com/80908283978271f0866a5107e0c90102/40bc98ad73366f8693ae26200d953bac-ld-m3u8.m3u8', { cache: 'no-store' });
      var t = await r.text();
      return JSON.stringify({ status: r.status, len: t.length, head: t.slice(0, 600) });
    } catch (e) { return 'ERR ' + e.message; }
  })()`, returnByValue: true, awaitPromise: true
});
console.log('  ' + (m3u8.result && m3u8.result.value));

// 2) 尝试手动起播
console.log('');
console.log('=== 手动起播尝试 ===');
const kick = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var v = document.querySelector('video');
    var out = {};
    if (v) {
      out.before = { rs: v.readyState, paused: v.paused, src: String(v.src || '').slice(0, 40) };
      try { v.load(); out.loaded = true; } catch (e) { out.loadErr = String(e); }
      try { var p = v.play(); if (p && p.then) p.then(function(){ out.played = true; }).catch(function(e){ out.playErr = String(e); }); } catch (e) { out.playErr = String(e); }
    } else out.noVideo = true;
    // 也点一下播放器
    var btn = document.querySelector('.xgplayer-start, .xgplayer-play, [class*=xgplayer-start]');
    if (btn) { try { btn.click(); out.clickedStart = true; } catch (e) { out.clickErr = String(e); } }
    return JSON.stringify(out);
  })()`, returnByValue: true, awaitPromise: true
});
console.log('  ' + (kick.result && kick.result.value));
await sleep(12000);

const after = await c.send('Runtime.evaluate', { expression: `JSON.stringify({v:(function(){const v=document.querySelector('video'); return v?{rs:v.readyState,dur:v.duration,t:Math.round(v.currentTime||0),paused:v.paused,net:v.networkState,err:v.error?v.error.code:null}:null;})(), cls:(document.querySelector('.video-player')||{}).className||null})`, returnByValue: true });
console.log('  12s 后: ' + (after.result && after.result.value));

// 3) 失败请求
console.log('');
console.log('=== 失败请求 ===');
for (const f of c.fails.slice(-10)) console.log('  ' + JSON.stringify(f));

console.log('');
console.log('=== 最后 15 个请求 ===');
for (const u of c.all.slice(-15)) console.log('  ' + u.slice(0, 130));
c.close();
