/** qiyang-deep.mjs — 深挖 bjqiyang：章节结构、可看视频、进度上报接口、直播课列表 */
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
const t = list.find(x => x.type === 'page' && x.url.includes('bjqiyang'));
if (!t) { console.log('没有 qiyang 页面'); process.exit(1); }
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

// 安装网络抓取钩子
await ev(c, `(function(){
  if (window.__qyHdr) return 'already';
  window.__qyHdr = { req: [] };
  var OX = window.XMLHttpRequest, so = OX.prototype.open, ss = OX.prototype.send, sh = OX.prototype.setRequestHeader;
  OX.prototype.open = function (m, u) { this.__u = String(u); this.__h = {}; this.__m = m; return so.apply(this, arguments); };
  OX.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = String(v).slice(0, 20); } catch (e) {} return sh.apply(this, arguments); };
  OX.prototype.send = function (d) {
    var self = this;
    this.addEventListener('load', function () {
      try {
        window.__qyHdr.req.push({ method: self.__m, url: self.__u.slice(0, 160), body: d ? String(d).slice(0, 200) : null, status: self.status, resp: String(self.responseText).slice(0, 200) });
        if (window.__qyHdr.req.length > 60) window.__qyHdr.req.shift();
      } catch (e) {}
    });
    return ss.apply(this, arguments);
  };
  var of = window.fetch;
  window.fetch = function (input, init) {
    var u = typeof input === 'string' ? input : (input && input.url) || '';
    var m = (init && init.method) || 'GET';
    var b = init && init.body ? String(init.body).slice(0, 200) : null;
    var p = of.apply(this, arguments);
    p.then(function (res) { try { window.__qyHdr.req.push({ method: m, url: String(u).slice(0, 160), body: b, status: res.status, via: 'fetch' }); } catch (e) {} });
    return p;
  };
  return 'hooked';
})()`);

console.log('=== 1. 章节/直播 列表结构 ===');
console.log(await ev(c, `JSON.stringify({
  tabs: Array.from(document.querySelectorAll('[class*=tab], .nav-tabs li, [role=tab]')).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20); }).filter(Boolean).slice(0,10),
  allCourseLinks: Array.from(document.querySelectorAll('a[href*=Courses], a[href*=courses]')).map(function(a){ return { t: (a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30), h: a.getAttribute('href') }; }).slice(0, 30),
  catalogHtml: (function(){ var e = document.querySelector('.chapter-list, .course-chapter, [class*=chapter], [class*=catalog]'); return e ? e.outerHTML.slice(0, 400) : null; })()
})`));

console.log('');
console.log('=== 2. 播放器当前源与可看性 ===');
console.log(await ev(c, `JSON.stringify({
  player: window.player ? { url: (window.player._urls || []).slice(0, 2), tag: window.player.tag, played: window.player.played } : null,
  videoSrc: (function(){ var v = document.querySelector('video'); return v ? String(v.currentSrc || v.src || '').slice(0, 200) : null; })(),
  trialSeconds: (function(){ var e = Array.from(document.querySelectorAll('*')).filter(function(d){ return /可试看\\s*\\d+\\s*秒/.test(d.innerText || '') && (d.innerText||'').length < 60; })[0]; return e ? (e.innerText||'').replace(/\\s+/g,' ').slice(0,60) : null; })()
})`));

console.log('');
console.log('=== 3. 试播 20 秒看是否被拦 ===');
console.log(await ev(c, `(function(){
  var v = document.querySelector('video');
  if (!v) return 'no-video';
  v.muted = true; v.volume = 0;
  var p = v.play();
  if (p && p.catch) p.catch(function(e){ window.__qyPlayErr = e.message; });
  return 'play called';
})()`));
await sleep(20000);
console.log(await ev(c, `JSON.stringify({
  video: (function(){ var v = document.querySelector('video'); return v ? { rs: v.readyState, dur: v.duration, t: v.currentTime, paused: v.paused, muted: v.muted, rate: v.playbackRate } : null; })(),
  playErr: window.__qyPlayErr || null,
  banner: (function(){ var e = document.querySelector('.vip_limit_content, [class*=vip_limit]'); return e ? { vis: !!(e.offsetWidth||e.offsetHeight), text: (e.innerText||'').replace(/\\s+/g,' ').slice(0,60) } : null; })()
})`));

console.log('');
console.log('=== 4. 网络请求记录 ===');
console.log(await ev(c, `JSON.stringify((window.__qyHdr ? window.__qyHdr.req : []).slice(-18), null, 1)`));
c.close();
