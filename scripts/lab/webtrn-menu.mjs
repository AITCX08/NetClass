/** webtrn-menu.mjs — 抓取左侧菜单链接 + 当前进度概览 */
const PORT = Number(process.argv[2] || 9226);
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
        if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); p.res(m.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res) => { this.pending.set(id, { res }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => res({ result: { value: 'timeout' } }), 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('generalControl_index'));
if (!page) { console.log('没找到登录后的页面'); process.exit(1); }
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();
await c.send('Frame.enable').catch(() => { });

const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var frames = Array.from(document.querySelectorAll('iframe')).map(function(f, i){
      return { i: i, src: String(f.src || ''), id: f.id || '', name: f.name || '' };
    });
    var links = Array.from(document.querySelectorAll('a')).map(function(a){
      return { text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 18), href: String(a.getAttribute('href') || '').slice(0, 120), onclick: String(a.getAttribute('onclick') || '').slice(0, 100) };
    }).filter(function(x){ return x.text || x.href; });
    var text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return JSON.stringify({
      frames: frames,
      progressText: (text.match(/研修进度[\\s\\S]{0,200}/) || [''])[0].slice(0, 200),
      links: links.slice(0, 60)
    }, null, 1).slice(0, 3500);
  })()`, returnByValue: true
});
console.log(r.result.value);
c.close();
