/**
 * rate-ceiling.mjs — 逐档测「平台实际能接受的最高倍速（不被回退）」
 *
 * 方法：
 *   1. 先把脚本的目标倍速设成待测值（CFG.userRate=true, rate=X）—— 否则脚本自己的
 *      ratechange 监听会把倍速拉回它的目标值，测出来的就是脚本而不是平台。
 *   2. 同时把 video.playbackRate 与站点播放器(speed) 设成 X。
 *   3. 观察 8 秒：倍速有没有被回退 + 媒体时间实际推进速度。
 *
 * 用法：node rate-ceiling.mjs --port 9224 --target shengshengketang --rates 1.25,1.5,1.75,2,2.5,3,4
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);
const TARGET = A.target || 'shengshengketang';
const RATES = String(A.rates || '1.25,1.5,1.75,2,2.5,3,4').split(',').map(Number);
const OBSERVE = Number(A.secs || 8);
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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes(TARGET));
if (!page) { console.log('没找到页面: ' + TARGET); process.exit(1); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
const ev = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  return r.result && r.result.value;
};

console.log('页面: ' + page.url.slice(0, 70));
console.log('平台: ' + await ev('window.NetClass ? window.NetClass.platform : "?"'));
console.log('');

const results = [];
for (const R of RATES) {
  // 1) 脚本目标倍速 = 待测值（避免脚本自己回退）
  await ev(`(function(){
    var c = window.NetClass;
    if (!c) return 'no-cfg';
    c.cfg.userRate = true; c.cfg.rate = ${R};
    try { localStorage.setItem('netclass.cfg.v3', JSON.stringify(c.cfg)); } catch (e) {}
    return c.cfg.rate;
  })()`);

  // 2) 设站点播放器 + 视频元素
  const setRes = await ev(`(function(){
    var out = {};
    var v = document.querySelector('video');
    if (!v) return 'no-video';
    try {
      if (typeof player !== 'undefined' && player && typeof player.setSpeed === 'function') { player.setSpeed(${R}); out.sitePlayer = 'setSpeed(${R})'; }
    } catch (e) { out.sitePlayerErr = String(e).slice(0, 60); }
    v.playbackRate = ${R};
    out.afterSet = v.playbackRate;
    out.paused = v.paused;
    return JSON.stringify(out);
  })()`);

  await sleep(1200);
  const t0 = await ev('document.querySelector("video") ? document.querySelector("video").currentTime : null');
  const w0 = Date.now();
  await sleep(OBSERVE * 1000);
  const t1 = await ev('document.querySelector("video") ? document.querySelector("video").currentTime : null');
  const dt = (Date.now() - w0) / 1000;

  const st = await ev(`JSON.stringify({
    rate: (function(){ var v = document.querySelector('video'); return v ? v.playbackRate : null; })(),
    paused: (function(){ var v = document.querySelector('video'); return v ? v.paused : null; })(),
    cfgRate: window.NetClass ? window.NetClass.cfg.rate : null,
    fixes: window.NetClass ? window.NetClass.state.video.rateFixes : null,
    siteIcon: (function(){ var e = document.querySelector('.xgplayer-playbackrate'); return e ? (e.innerText||'').trim().slice(0,6) : null; })()
  })`);
  const s = JSON.parse(st);
  const adv = (t1 != null && t0 != null) ? (t1 - t0) : null;
  const eff = adv != null ? adv / dt : null;
  const held = s.rate != null && Math.abs(s.rate - R) < 0.02;
  results.push({ req: R, heldRate: s.rate, effective: eff, advanced: adv, revertCount: s.fixes });

  console.log('请求 ' + R + 'x → 2 秒后实际 ' + s.rate + 'x' +
    ' | ' + OBSERVE + 's 内媒体推进 ' + (adv != null ? adv.toFixed(1) : '?') + 's (' + (eff != null ? eff.toFixed(2) : '?') + 'x)' +
    ' | ' + (held ? '✅ 站住' : '❌ 被回退'));
}

console.log('');
console.log('=== 汇总 ===');
console.log('请求倍速 | 实际倍速 | 实测推进 | 结论');
for (const r of results) {
  const ok = r.heldRate != null && Math.abs(r.heldRate - r.req) < 0.02;
  console.log(String(r.req).padEnd(8) + ' | ' + String(r.heldRate).padEnd(8) + ' | ' + (r.effective != null ? r.effective.toFixed(2) + 'x' : '?').padEnd(8) + ' | ' + (ok ? '通过' : '回退'));
}
const passed = results.filter(r => r.heldRate != null && Math.abs(r.heldRate - r.req) < 0.02);
console.log('');
console.log('最高可稳定保持: ' + (passed.length ? Math.max(...passed.map(r => r.req)) + 'x' : '无'));
c.close();
