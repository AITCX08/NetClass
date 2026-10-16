/** ss-home.mjs — 摸清 shengsheng 首页的课程列表结构（要支持多门课） */
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
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
if (!page) { console.log('no page'); process.exit(1); }
console.log('当前页: ' + page.url);
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var out = {};
    out.url = location.href;
    // 课程卡片
    var cards = Array.from(document.querySelectorAll('[class*=course],[class*=card],[class*=item]')).filter(function(e){
      var t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
      return t && t.length > 4 && t.length < 120 && /课程|导论|理论|实务/.test(t) && e.querySelectorAll('a,img').length;
    });
    out.cards = cards.map(function(e){
      var a = e.querySelector('a[href]');
      return {
        cls: String(e.className).slice(0, 40),
        text: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
        href: a ? String(a.getAttribute('href')).slice(0, 90) : null
      };
    }).slice(0, 10);
    // 所有链接里含 course 的
    out.courseLinks = Array.from(document.querySelectorAll('a[href*=course], a[href*=Goods], a[href*=learn]')).map(function(a){
      return { t: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40), href: String(a.getAttribute('href')).slice(0, 100) };
    }).filter(function(x){ return x.t || x.href; }).slice(0, 15);
    // 我的学习 / 目录类导航
    out.navLinks = Array.from(document.querySelectorAll('a,li,div[class*=menu]')).map(function(e){
      var t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
      return t && t.length < 12 && /我的|学习|课程|继续/.test(t) ? { t: t, href: String(e.getAttribute && e.getAttribute('href') || '').slice(0, 80) } : null;
    }).filter(Boolean).slice(0, 12);
    out.bodyText = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
    return JSON.stringify(out, null, 1).slice(0, 3000);
  })()`, returnByValue: true
});
console.log(r.result.value);
c.close();
