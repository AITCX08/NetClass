/** qy-list.mjs — 列出 bjqiyang 课程所有章节（分「直播课」「新章节/录播」两组），并标注状态 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9225);

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

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find(x => x.type === 'page' && x.url.includes('bjqiyang'));
const c = new Cdp(t.webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable');
const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
  var out = { live: [], recorded: [], other: [] };
  var group = 'other';
  document.querySelectorAll('.chapter-list > ul > li').forEach(function(li){
    var a = li.querySelector('a');
    if (!a) return;
    var href = String(a.getAttribute('href') || '');
    var nm = li.querySelector('.goodscourses_name');
    var name = nm ? nm.innerText.trim() : (a.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!href || href === 'javascript:void(0)') { group = name || group; return; }
    var rec = { id: (href.match(/goodscourses_id=(\\d+)/) || [])[1], name: name.slice(0, 60), href: href, group: group };
    if (group === '直播课') out.live.push(rec);
    else out.recorded.push(rec);
  });
  return JSON.stringify({ live: out.live.length, recorded: out.recorded.length, recordedList: out.recorded, liveSample: out.live.slice(0, 3) }, null, 1);
})()`,
  returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
