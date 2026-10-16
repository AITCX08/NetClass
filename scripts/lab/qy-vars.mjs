/** qy-vars.mjs — 提取 bjqiyang 学习页里的内联 JS 变量：source / getUrl / current_time / isEnd / goodscourses_exper */
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
  if (r && r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 400);
  return r && r.result ? r.result.value : '(none)';
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes('bjqiyang'));
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

console.log('=== 关键变量 ===');
console.log(await ev(c, `JSON.stringify({
  source: (typeof source !== 'undefined') ? String(source).slice(0, 200) : null,
  getUrl: (typeof getUrl !== 'undefined') ? String(getUrl).slice(0, 300) : null,
  current_time: (typeof current_time !== 'undefined') ? current_time : null,
  isEnd: (typeof isEnd !== 'undefined') ? isEnd : null,
  goodscourses_exper: (typeof goodscourses_exper !== 'undefined') ? goodscourses_exper : null,
  goodscourses_id: (typeof goodscourses_id !== 'undefined') ? goodscourses_id : null,
  url: location.href
})`));

console.log('');
console.log('=== 页面内联脚本里含这些变量的片段 ===');
console.log(await ev(c, `(function(){
  var out = [];
  var scripts = Array.from(document.querySelectorAll('script')).filter(function(s){ return !s.src; });
  for (var i = 0; i < scripts.length; i++) {
    var txt = scripts[i].textContent || '';
    if (/getUrl|current_time|goodscourses_exper|isEnd|var source/.test(txt)) {
      out.push(txt.replace(/\\s+/g, ' ').slice(0, 900));
    }
  }
  return JSON.stringify(out.slice(0, 4), null, 1);
})()`));

console.log('');
console.log('=== 播放器 API 可用性 ===');
console.log(await ev(c, `JSON.stringify({
  hasPlayer: typeof player !== 'undefined',
  methods: (typeof player !== 'undefined') ? ['getCurrentTime','getDuration','play','pause','seek','setSpeed','getStatus'].filter(function(m){ return typeof player[m] === 'function'; }) : []
})`));
c.close();
