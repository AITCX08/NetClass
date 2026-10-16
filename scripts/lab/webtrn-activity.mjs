/** webtrn-activity.mjs — 摸清「研修活动」的参与方式（签到类可自动，需交内容的要区分出来） */
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
const page = list.find(t => t.type === 'page' && /my_team_list|team|activity/i.test(t.url)) || list.find(t => t.type === 'page' && t.url.includes('webtrn'));
if (!page) { console.log('no page'); process.exit(1); }
console.log('页面: ' + page.url.slice(0, 90));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var out = {};
    // 所有「参与 / 查看活动」类链接
    out.actionLinks = Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]')).map(function(e){
      var t = (e.innerText || e.value || '').replace(/\\s+/g,' ').trim();
      if (!t) return null;
      return { t: t.slice(0, 16), href: String(e.getAttribute('href') || '').slice(0, 130), oc: String(e.getAttribute('onclick') || '').slice(0, 130) };
    }).filter(function(x){ return x && /参与|查看|进入|活动|提交|上传/.test(x.t); }).slice(0, 20);
    // 活动区块文本
    var txt = (document.body.innerText || '').replace(/\\s+/g, ' ');
    var m = txt.match(/研修活动[\\s\\S]{0,300}/);
    out.activityText = m ? m[0].slice(0, 300) : null;
    return JSON.stringify(out, null, 1).slice(0, 2500);
  })()`, returnByValue: true
});
console.log(r.result.value);
c.close();
