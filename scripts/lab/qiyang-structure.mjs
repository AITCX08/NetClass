/** qiyang-structure.mjs — 摸清 bjqiyang 学习页的「章节课程」列表结构与进度上报 */
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
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

console.log('=== 1. 页面里所有可点击的课程项（含章节）===');
console.log(await ev(c, `JSON.stringify({
  chapterLinks: Array.from(document.querySelectorAll('a[href*=Courses], a[href*=courses], .chapter a, .section a, dd a, li a')).map(function(a){ 
    return { t: (a.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 40), h: String(a.getAttribute('href')||'').slice(0, 90) };
  }).filter(function(x){ return x.t; }).slice(0, 40)
})`));

console.log('');
console.log('=== 2. 章节容器 HTML（前 1200 字符）===');
console.log(await ev(c, `(function(){
  var cands = ['.chapter', '.section', '.course-list', '.chapter-list', '.list-box', '#chapter', '.catalog', '.sedian', '.kecheng'];
  for (var i = 0; i < cands.length; i++) {
    var e = document.querySelector(cands[i]);
    if (e) return cands[i] + ' :: ' + e.outerHTML.replace(/\\s+/g, ' ').slice(0, 1000);
  }
  return 'no-known-container';
})()`));

console.log('');
console.log('=== 3. 完整 DOM 里带 goodscourses_id 的链接（章节 vs 直播）===');
console.log(await ev(c, `JSON.stringify({
  all: Array.from(document.querySelectorAll('a')).filter(function(a){ return /goodscourses_id/.test(String(a.getAttribute('href')||'')); }).map(function(a){ return { t: (a.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 30), h: a.getAttribute('href') }; }).slice(0, 40)
})`));

console.log('');
console.log('=== 4. 页面里的 JS 变量 / 接口线索 ===');
console.log(await ev(c, `JSON.stringify({
  scripts: Array.from(document.querySelectorAll('script')).map(function(s){ return String(s.src||'').slice(0,100); }).filter(Boolean).slice(0, 10),
  ocsHints: Object.keys(window).filter(function(k){ return /course|video|progress|study/i.test(k); }).slice(0, 20)
})`));
c.close();
