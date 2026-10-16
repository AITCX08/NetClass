/** ss-quiz.mjs — 定位 shengsheng 随堂弹题的 DOM 结构与脚本处理状态 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9224);

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
  expression: `JSON.stringify({
    quizFeed: window.NetClass ? window.NetClass.feed() : null,
    quizElements: window.NetClass ? window.NetClass.quizElements() : null,
    state: window.NetClass ? window.NetClass.state.quiz : null,
    popQuizDom: Array.from(document.querySelectorAll('[class*=pop-quiz], [class*=popQuiz], [class*=quiz], [class*=dialog], [class*=van-dialog], [class*=van-popup]')).map(function(e){
      return { cls: String(e.className).slice(0, 70), visible: !!(e.offsetWidth || e.offsetHeight), text: (e.innerText||'').replace(/\\s+/g,' ').slice(0, 120) };
    }).slice(0, 10),
    buttons: Array.from(document.querySelectorAll('button')).map(function(b){ return (b.innerText||'').trim().slice(0,14); }).filter(Boolean).slice(0, 12)
  }, null, 1)`, returnByValue: true
});
console.log(r.result && r.result.value);
c.close();
