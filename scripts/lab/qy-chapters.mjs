/** qy-chapters.mjs — 拉取 bjqiyang 课程 46789 的完整章节清单（含完成状态）
 *  用法：node qy-chapters.mjs --port 9225
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
  if (r && r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 400);
  return r && r.result ? r.result.value : '(none)';
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes('bjqiyang'));
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');

console.log('=== 完整章节清单（含状态）===');
const raw = await ev(c, `JSON.stringify(Array.from(document.querySelectorAll('.chapter-list a')).map(function(a){
  var li = a.closest('li');
  var nm = a.querySelector('.goodscourses_name');
  return {
    href: String(a.getAttribute('href')||''),
    name: nm ? nm.innerText.trim() : (a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50),
    cls: li ? String(li.className).slice(0, 40) : '',
    title: nm ? String(nm.getAttribute('title')||'').slice(0,60) : '',
    html: li ? li.innerHTML.replace(/\\s+/g,' ').slice(0, 260) : ''
  };
}))`);
try {
  const arr = JSON.parse(raw);
  console.log('总数: ' + arr.length);
  console.log(JSON.stringify(arr.slice(0, 6), null, 1));
  console.log('...');
  // 统计带 finished/end 标记的
  const withEnd = arr.filter(x => /finish|end|完成|已学|complete/i.test(x.html + x.cls));
  console.log('带完成标记的: ' + withEnd.length);
} catch (e) { console.log(raw); }

console.log('');
console.log('=== 「新章节」区块的 DOM ===');
console.log(await ev(c, `(function(){
  var secs = Array.from(document.querySelectorAll('.section-list, [dstype]'));
  return JSON.stringify(secs.map(function(s){ return { dstype: s.getAttribute('dstype'), cls: String(s.className).slice(0,40), count: s.querySelectorAll('a[href*=goodscourses_id]').length, head: (s.querySelector('li')||{}).innerText }; }), null, 1);
})()`));
c.close();
