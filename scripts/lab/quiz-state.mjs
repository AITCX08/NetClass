/** quiz-state.mjs — 摸清 shengsheng 弹题的三种状态 DOM（作答中 / 答错 / 答对） */
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
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000); });
  }
  close() { try { this.ws.close(); } catch { } }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('shengshengketang'));
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

const r = await c.send('Runtime.evaluate', {
  expression: `(function(){
    var box = document.querySelector('.pop-quiz-dialog');
    if (!box) return JSON.stringify({ dialog: null });
    var out = {
      html: box.outerHTML.slice(0, 2500),
      buttons: Array.from(box.querySelectorAll('button')).map(function(b){ return { text: (b.innerText||'').trim(), cls: String(b.className).slice(0,50) }; }),
      allText: (box.innerText || '').replace(/\\s+/g, ' '),
      optionItems: Array.from(box.querySelectorAll('.option-item')).map(function(e){
        return { cls: String(e.className).slice(0, 60), checked: e.getAttribute('aria-checked'), text: (e.innerText||'').replace(/\\s+/g,' ').slice(0, 40) };
      }),
      // 是否有「正确答案」提示元素
      answerHints: Array.from(box.querySelectorAll('[class*=answer], [class*=result], [class*=tip]')).map(function(e){
        return { cls: String(e.className).slice(0, 60), text: (e.innerText||'').replace(/\\s+/g,' ').slice(0, 80) };
      })
    };
    return JSON.stringify(out, null, 1);
  })()`, returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
