/**
 * cx-enter.mjs — 学习通：从个人空间进课程 → 点第一个未完成任务点 → 抓任务点页结构
 *   node scripts/cx-enter.mjs --port 9227
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 40000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 140))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('起点: ' + String(await ev('location.href.slice(0,60)')));
// 1) 点「课程」入口
console.log('点课程: ' + await ev(`(function(){
  var e = Array.from(document.querySelectorAll('div,a,span')).find(function(x){ return (x.innerText||'').trim()==='课程'; });
  if (!e) return 'no-entry';
  var m = (e.getAttribute('onclick')||'').match(/setUrl\\('[^']*','([^']+)'/);
  if (m) { location.href = m[1]; return 'goto:' + m[1].slice(0,60); }
  e.click(); return 'clicked';
})()`));
await sleep(10000);

// 2) 点《形势与政策》
console.log('点目标课程: ' + await ev(`(function(){
  var a = Array.from(document.querySelectorAll('a')).find(function(x){ return /形势与政策/.test(x.innerText||''); });
  if (!a) return 'not-found';
  var href = a.getAttribute('href') || (a.querySelector('a')||{}).href;
  if (href && href.indexOf('http') === 0) { location.href = href; return 'goto-course'; }
  a.click(); return 'clicked-card';
})()`));
await sleep(12000);

// 3) 输出课程页与任务点清单
const st = await ev(`(function(){
  var nodes = Array.from(document.querySelectorAll('[class*=chapter_item],[class*=catalog_item],.chapter'));
  var undone = nodes.map(function(n){
    var t = (n.innerText||'').replace(/\\s+/g,' ').trim();
    var done = /完成|已学|100%/.test(String(n.className) + t);
    var a = n.querySelector('a') || n.closest('a');
    return { t: t.slice(0,34), done: done, hasA: !!a };
  });
  return JSON.stringify({ url: location.href.slice(0,70), title: document.title.slice(0,20), nodes: nodes.length,
    undone: undone.filter(function(x){ return !x.done; }).slice(0,5), video: !!document.querySelector('video'),
    iframes: Array.from(document.querySelectorAll('iframe')).map(function(f){ return String(f.src).slice(0,55); }).slice(0,4) });
})()`);
console.log('课程页: ' + String(st).slice(0, 700));

// 4) 点第一个未完成任务点
console.log('点任务点: ' + await ev(`(function(){
  var nodes = Array.from(document.querySelectorAll('[class*=chapter_item],[class*=catalog_item],.chapter'));
  var target = nodes.find(function(n){
    var t = (n.innerText||'').replace(/\\s+/g,' ').trim();
    if (!t || t.length > 60) return false;
    if (/完成|已学/.test(String(n.className) + t)) return false;
    return /\\d\\.\\d/.test(t);
  });
  if (!target) return 'no-target';
  var a = target.querySelector('a') || target.closest('a');
  var t = (target.innerText||'').replace(/\\s+/g,' ').slice(0,30);
  if (a) { a.click(); return 'clicked:' + t; }
  target.click(); return 'clicked-node:' + t;
})()`));
await sleep(12000);
console.log('任务点页: ' + String(await ev(`(function(){
  var v = document.querySelector('video');
  return JSON.stringify({ url: location.href.slice(0,80), title: document.title.slice(0,22),
    video: v ? { dur: Math.round(v.duration||0), cur: Math.round(v.currentTime||0), rate: v.playbackRate, paused: v.paused } : null,
    iframes: Array.from(document.querySelectorAll('iframe')).map(function(f){ return String(f.src).slice(0,60); }).slice(0,5),
    quiz: !!document.querySelector('[class*=question],[class*=quiz],[class*=exam],[class*=answer]'),
    module: (window.NetClass && NetClass.platform) || null });
})()`)).slice(0, 700));
ws.close();
