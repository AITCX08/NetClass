/**
 * dump-survey.mjs —— dump 问卷全部题目与选项（dcwj.91huayi.com/vm/xxx.aspx）
 */
const PORT = Number(process.argv[2] || 9250);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fs = await import('node:fs');
const OUT = 'runs/shots';
fs.mkdirSync(OUT, { recursive: true });

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = (Array.isArray(l) ? l : []).filter(t => t.type === 'page');
const t = pages.find(p => /dcwj\.91huayi\.com/.test(p.url));
if (!t) { console.log('❌ 没有问卷标签，现有: ' + pages.map(p => p.url.slice(0, 60)).join(' | ')); process.exit(1); }
console.log('问卷: ' + t.url.slice(0, 120));

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', () => j(new Error('ws')), { once: true }); });
let id = 0; const pend = new Map();
ws.addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (me, pa = {}, to = 30000) => new Promise(res => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}) } }, to);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Page.enable'); await send('Runtime.enable');
await sleep(800);

// ① 页面尺寸
console.log('① 页面: ' + String(await ev(`JSON.stringify({h: document.body.scrollHeight, w: document.body.scrollWidth, vh: innerHeight})`)));

// ② 所有 radio / checkbox
console.log('\n② 所有 input:');
console.log(String(await ev(`JSON.stringify(Array.from(document.querySelectorAll('input')).map(function(e){
  return {type:e.type, name:e.name||'', id:e.id||'', val:String(e.value||'').slice(0,20), checked:e.checked};
}).slice(0, 80), null, 1)`)));

// ③ 题目块（问卷星常用 div.field / div.q）
console.log('\n③ 题目块:');
console.log(String(await ev(`(function(){
  var sels = ['div.field','div.q','div.question','li','div[class*=topic]','div[class*=item]'];
  var best = null, bestN = 0;
  sels.forEach(function(s){
    var n = document.querySelectorAll(s).length;
    if (n > bestN && n < 40) { bestN = n; best = s; }
  });
  if (!best) return 'no container found';
  var els = Array.from(document.querySelectorAll(best));
  return JSON.stringify({selector: best, count: els.length, items: els.slice(0, 20).map(function(e, i){
    var tx = (e.innerText||'').replace(/\\s+/g,' ').trim();
    var inputs = Array.from(e.querySelectorAll('input'));
    return {i: i, text: tx.slice(0, 200), inputs: inputs.map(function(x){ return x.type + ':' + String(x.value||'').slice(0,10); })};
  })}, null, 1);
})()`)));

// ④ 全文（含所有题目）
console.log('\n④ 全文:');
const body = String(await ev(`(document.body.innerText||'').replace(/\\s+/g,' ')`));
console.log(body.slice(0, 3000));

// ⑤ 提交按钮
console.log('\n⑤ 按钮:');
console.log(String(await ev(`JSON.stringify(Array.from(document.querySelectorAll('button,input[type=button],input[type=submit],a,div')).filter(function(e){
  var tx = (e.innerText||e.value||'').trim();
  return /提交|完成|保存|确定/.test(tx) && tx.length < 12;
}).slice(0, 10).map(function(e){
  var r = e.getBoundingClientRect();
  return {tag:e.tagName, txt:(e.innerText||e.value||'').trim(), rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};
}), null, 1)`)));

ws.close();
