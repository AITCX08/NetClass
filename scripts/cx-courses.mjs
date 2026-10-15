/**
 * cx-courses.mjs — 学习通：进入"我的课程"并列出课程（供适配器定位《形势与政策》）
 *   node scripts/cx-courses.mjs --port 9227 [--match 形势与政策]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const WANT = A.match ? String(A.match) : null;

// 新开一个标签到个人空间
const anchor = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /chaoxing/.test(t.url));
const aws = new WebSocket(anchor.webSocketDebuggerUrl);
await new Promise(r => aws.addEventListener('open', r));
let seq = 0;
const asend = (m, p = {}, ms = 30000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { aws.removeEventListener('message', on); res(x); } }; aws.addEventListener('message', on); aws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => res({ timeout: true }), ms); });
const nt = await asend('Target.createTarget', { url: 'https://i.chaoxing.com/base' });
const newId = nt.result && nt.result.targetId;
aws.close();
await new Promise(r => setTimeout(r, 9000));

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.id === newId);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
seq = 0;
const send = (m, p = {}, ms = 30000) => new Promise((res, rej) => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error).slice(0, 120))) : res(x.result); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => rej(new Error('timeout ' + m)), ms); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('个人空间: ' + (await ev(`document.title`)));
const url = await ev(`(function(){
  var e = Array.from(document.querySelectorAll('div,a')).find(function(x){ return (x.innerText||'').trim() === '课程'; });
  if (!e) return 'none';
  var m = (e.getAttribute('onclick')||'').match(/setUrl\\('[^']*','([^']+)'/);
  return m ? m[1] : 'nomatch';
})()`);
console.log('课程入口: ' + String(url).slice(0, 120));
if (url && url !== 'none' && url !== 'nomatch') {
  await send('Page.enable'); await send('Page.navigate', { url });
  await sleep(10000);
}
console.log('落地: ' + String(await ev(`document.title + ' | ' + location.href.slice(0,90)`)));
console.log('课程清单: ' + String(await ev(`(function(){
  var out = [];
  Array.from(document.querySelectorAll('a')).forEach(function(a){
    var t = (a.innerText||'').replace(/\\s+/g,' ').trim();
    if (t && t.length > 3 && t.length < 30 && /chaoxing|mycourse|visit|course/.test(a.href||'')) out.push(t + ' => ' + String(a.getAttribute('href')).slice(0, 70));
  });
  return JSON.stringify(Array.from(new Set(out)).slice(0, 12));
})()`)).slice(0, 900));
if (WANT) {
  console.log('目标课程定位: ' + await ev(`(function(){
    var hits = Array.from(document.querySelectorAll('a,div,li')).filter(function(e){ return (e.innerText||'').includes(${JSON.stringify(WANT)}) && (e.innerText||'').length < 60; });
    if (!hits.length) return '未找到 ' + ${JSON.stringify(WANT)};
    var h = hits[0];
    var a = h.closest('a') || h.querySelector('a');
    return JSON.stringify({ text: (h.innerText||'').replace(/\\s+/g,' ').slice(0,40), href: a ? String(a.getAttribute('href')).slice(0,90) : 'no-a', tag: h.tagName });
  })()`));
}
ws.close();
