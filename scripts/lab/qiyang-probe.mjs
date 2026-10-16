/**
 * qiyang-probe.mjs — 探查 bjqiyang 学习页结构：章节列表 / 播放器 / 试看限制 / 接口
 * 用法：node qiyang-probe.mjs --port 9225
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);
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
async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(e => ({ err: String(e) }));
  if (r && r.err) return 'EVAL-ERR ' + r.err;
  if (r && r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300);
  return r && r.result ? r.result.value : '(none)';
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes('bjqiyang') && x.url.includes('courses'));
if (!t) { console.log('没有 qiyang 学习页'); process.exit(1); }
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

console.log('=== 1. 页面结构 ===');
console.log(await ev(c, `JSON.stringify({
  url: location.href,
  title: document.title,
  videos: Array.from(document.querySelectorAll('video')).map(function(v){ return { rs: v.readyState, dur: v.duration, t: v.currentTime, rate: v.playbackRate, paused: v.paused, muted: v.muted, src: String(v.currentSrc||'').slice(0,60) }; }),
  playerRoot: (function(){ var p = document.querySelector('.prism-player, .video-player, [id*=player], .aliplayer'); return p ? { cls: String(p.className).slice(0,60), id: p.id } : null; })(),
  chapterItems: Array.from(document.querySelectorAll('.chapter-item, .section-item, [class*=chapter] li, [class*=list] a, .course-list a, li a')).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50); }).filter(Boolean).slice(0,25),
  buttons: Array.from(document.querySelectorAll('button, [class*=btn], a[class*=play]')).map(function(b){ return (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20); }).filter(Boolean).slice(0,20)
})`));

console.log('');
console.log('=== 2. 试看限制文案 ===');
console.log(await ev(c, `JSON.stringify({
  hasVipLimit: !!document.querySelector('.vip_limit_content, [class*=vip_limit]'),
  vipText: (function(){ var e = document.querySelector('.vip_limit_content, [class*=vip_limit]'); return e ? (e.innerText||'').replace(/\\s+/g,' ').slice(0,120) : null; })(),
  trialHint: (function(){ var e = Array.from(document.querySelectorAll('div')).filter(function(d){ return /试看|购买/.test(d.innerText||'') && (d.innerText||'').length < 80; })[0]; return e ? (e.innerText||'').replace(/\\s+/g,' ').slice(0,100) : null; })()
})`));

console.log('');
console.log('=== 3. 播放器全局对象 ===');
console.log(await ev(c, `JSON.stringify({
  globals: Object.keys(window).filter(function(k){ return /player|ali|prism|vod|video/i.test(k); }).slice(0, 25),
  playerInstance: (function(){ 
    if (window.player && typeof window.player === 'object') return { hasPlayer: true, keys: Object.keys(window.player).slice(0, 20) };
    return null;
  })()
})`));

console.log('');
console.log('=== 4. 尝试点击播放 ===');
console.log(await ev(c, `(function(){
  var btns = ['.prism-big-play-btn', '.prism-play-btn', '[class*=big-play]', '[class*=play-btn]', 'video'];
  for (var i = 0; i < btns.length; i++) {
    var el = document.querySelector(btns[i]);
    if (el && (el.offsetWidth || el.offsetHeight)) { el.click(); return 'clicked ' + btns[i]; }
  }
  return 'no-playable';
})()`));

await sleep(10000);
console.log('');
console.log('=== 5. 10 秒后播放状态 ===');
console.log(await ev(c, `JSON.stringify({
  videos: Array.from(document.querySelectorAll('video')).map(function(v){ return { rs: v.readyState, dur: v.duration, t: v.currentTime, rate: v.playbackRate, paused: v.paused, muted: v.muted, err: v.error ? v.error.code : null }; }),
  vipStillShown: !!document.querySelector('.vip_limit_content[style*="display: block"], [class*=vip_limit][style*="display: block"]')
})`));
c.close();
