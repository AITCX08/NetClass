/** ss-structure.mjs — 三层页面的 DOM 结构（用于改写脚本的多课程推进） */
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
const c = new Cdp(page.webSocketDebuggerUrl);
await c.open();

const ev = async (expr) => {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result && r.result.value;
};

// ---------- 首页 ----------
console.log('########## 1. 首页 /home ##########');
await ev(`location.href='https://edu.shengshengketang.com/home'`);
await sleep(9000);
console.log(await ev(`(function(){
  var cards = Array.from(document.querySelectorAll('.classify-card'));
  return JSON.stringify({
    count: cards.length,
    items: cards.map(function(e, i){
      var r = e.getBoundingClientRect();
      return { i: i, text: (e.innerText||'').replace(/\\s+/g,' ').slice(0,50), tag: e.tagName, cls: String(e.className).slice(0,50), size: Math.round(r.width)+'x'+Math.round(r.height) };
    }),
    // 卡片内部有没有可点的子元素
    inner: cards.length ? cards[0].outerHTML.slice(0, 400) : null
  }, null, 1);
})()`));

// ---------- 课程页（子课程列表） ----------
console.log('');
console.log('########## 2. 课程页 /record/sub/ ##########');
await ev(`location.href='https://edu.shengshengketang.com/record/sub/1954895960937099265?classifyId=1954895910571896833&subClassifyId=1954895960937099265'`);
await sleep(10000);
console.log(await ev(`(function(){
  // 找「状态 + 名称」的重复块
  var all = Array.from(document.querySelectorAll('div,li,section'));
  var cands = all.filter(function(e){
    var t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 80) return false;
    if (!/^(学习中|未开始|已完成)/.test(t)) return false;
    return e.querySelectorAll('*').length <= 12;
  });
  return JSON.stringify({
    total: cands.length,
    sample: cands.slice(0, 4).map(function(e){
      var r = e.getBoundingClientRect();
      return {
        cls: String(e.className).slice(0, 60),
        text: (e.innerText||'').replace(/\\s+/g,' ').slice(0, 50),
        size: Math.round(r.width)+'x'+Math.round(r.height),
        parentCls: e.parentElement ? String(e.parentElement.className).slice(0, 60) : null,
        html: e.outerHTML.slice(0, 350)
      };
    })
  }, null, 1);
})()`));

// ---------- 子课程页（课时目录） ----------
console.log('');
console.log('########## 3. 子课程页 /course/v2/ ##########');
await ev(`location.href='https://edu.shengshengketang.com/course/v2/1955104870025424897'`);
await sleep(10000);
console.log(await ev(`(function(){
  var items = Array.from(document.querySelectorAll('.lesson-item'));
  return JSON.stringify({
    lessons: items.length,
    sample: items.slice(0, 3).map(function(e){
      return { cls: String(e.className).slice(0,40), text: (e.innerText||'').replace(/\\s+/g,' ').slice(0,40) };
    }),
    // 页面顶部有没有课程名/返回入口
    breadcrumb: (function(){
      var t = document.body.innerText || '';
      var m = t.match(/^[\\s\\S]{0,200}/);
      return m ? m[0].replace(/\\s+/g,' ').slice(0, 200) : null;
    })()
  }, null, 1);
})()`));

c.close();
