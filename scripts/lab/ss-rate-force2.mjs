/** ss-rate-force2.mjs — 把脚本倍速设成 2x（与站点目标一致），看站点是否允许 2x 站住 */
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
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
const ev = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ result: { value: 'ERR ' + e.message } }));
  return r.result && r.result.value;
};

// 刷新页面拿一个干净的脚本实例
console.log('== 刷新页面 ==');
await c.send('Page.enable');
await c.send('Page.reload', { ignoreCache: true });
await sleep(40000);

console.log('  脚本状态: ' + await ev(`JSON.stringify({
  module: !!window.NetClass,
  rate: window.NetClass ? window.NetClass.cfg.rate : null,
  userRate: window.NetClass ? window.NetClass.cfg.userRate : null,
  shengshengDefault: window.NetClass ? window.NetClass.cfg.rateShengsheng : null,
  video: (function(){ var v = document.querySelector('video'); return v ? { rs: v.readyState, rate: v.playbackRate, t: Math.round(v.currentTime), dur: Math.round(v.duration||0) } : null; })()
})`));

console.log('');
console.log('== 把脚本倍速设成 2x（脚本与站点目标一致，脚本不会对抗）==');
console.log(await ev(`(function(){
  var c = window.NetClass;
  if (!c) return 'no module';
  c.cfg.userRate = true;
  c.cfg.rate = 2;
  try { localStorage.setItem('netclass.cfg.v3', JSON.stringify(c.cfg)); } catch (e) {}
  try { c.rate(2); } catch (e) {}
  var v = document.querySelector('video');
  try { if (v) v.playbackRate = 2; } catch (e) {}
  return JSON.stringify({ cfgRate: c.cfg.rate, userRate: c.cfg.userRate, videoRate: v ? v.playbackRate : null });
})()`));

console.log('');
console.log('== 观察 30 秒（脚本希望 2x；若被拽回说明站点禁止）==');
for (let i = 1; i <= 6; i++) {
  await sleep(5000);
  console.log('  ' + (i * 5) + 's: ' + await ev(`JSON.stringify({
    rate: (function(){ var v = document.querySelector('video'); return v ? v.playbackRate : null; })(),
    paused: (function(){ var v = document.querySelector('video'); return v ? v.paused : null; })(),
    cfgRate: window.NetClass ? window.NetClass.cfg.rate : null,
    fixes: window.NetClass ? window.NetClass.state.video.rateFixes : null
  })`));
}

console.log('');
console.log('== 实测推进（12 秒）==');
const t0 = await ev('document.querySelector("video").currentTime');
const w0 = Date.now();
await sleep(12000);
const t1 = await ev('document.querySelector("video").currentTime');
const dt = (Date.now() - w0) / 1000;
console.log('  真实 ' + dt.toFixed(1) + 's / 媒体 ' + (t1 - t0).toFixed(1) + 's → ' + ((t1 - t0) / dt).toFixed(2) + 'x');
c.close();
