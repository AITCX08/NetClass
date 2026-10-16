/** ccexp.mjs — 定位培训页的「展开」按钮与分类标题的真实结构 */
const list = await (await fetch('http://127.0.0.1:9228/json/list')).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const p = cand[0];
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), 10000); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };

const Q1 = `JSON.stringify((function(){
  var bs = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return /^(展开|更多)$/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); });
  return bs.slice(0,8).map(function(b){
    var par = b.parentElement, gp = par && par.parentElement;
    return { tag: b.tagName, cls: String(b.className||'').slice(0,28),
      parentText: ((par && par.innerText)||'').replace(/\\s+/g,' ').slice(0,55),
      grandText: ((gp && gp.innerText)||'').replace(/\\s+/g,' ').slice(0,55) };
  });
})())`;
const Q2 = `JSON.stringify((function(){
  var keys = ['小初高公需','初中学段通识','专业课'];
  var out = [];
  keys.forEach(function(k){
    var hits = Array.from(document.querySelectorAll('*')).filter(function(e){
      var t = (e.innerText||'').trim();
      return t.indexOf(k) === 0 && t.length < 60 && (e.offsetWidth||e.offsetHeight) && e.children.length < 3;
    });
    out.push({ k: k, n: hits.length, sample: hits.slice(0,2).map(function(e){ return e.tagName + '.' + String(e.className||'').slice(0,22) + ' :: ' + (e.innerText||'').replace(/\\s+/g,' ').slice(0,36); }) });
  });
  return out;
})())`;

console.log('页面: ' + String(await ev('location.href.slice(-30)')));
console.log('=== 展开按钮真身 ===');
console.log(String(await ev(Q1)).slice(0, 900));
console.log('=== 分类标题候选 ===');
console.log(String(await ev(Q2)).slice(0, 800));
ws.close();
