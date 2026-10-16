/** cx-enter2.mjs — 学习通进课：一律用真实 click()（站点点击处理器会补 token），不用 href 跳转 */
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=9227').split('=')[1]);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 40000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error).slice(0, 140))) : res(x.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => rej(new Error('timeout ' + m)), ms);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1) 回个人空间 → 真点「课程」
await send('Page.enable');
await send('Page.navigate', { url: 'https://i.chaoxing.com/base' });
await sleep(9000);
console.log('A 点课程: ' + await ev(`(function(){
  var e = Array.from(document.querySelectorAll('div,a,span,li')).find(function(x){ return (x.innerText||'').trim()==='课程'; });
  if (!e) return 'no-entry'; e.click(); return 'clicked';
})()`));
await sleep(10000);

// 2) 真点《形势与政策》卡片（不用 href）
console.log('B 点课程卡片: ' + await ev(`(function(){
  var cands = Array.from(document.querySelectorAll('a,div,li')).filter(function(x){
    var t = (x.innerText||'').replace(/\\s+/g,' ').trim();
    return t.indexOf('形势与政策') >= 0 && t.length < 60;
  });
  if (!cands.length) return 'no-card';
  var h = cands[cands.length - 1];
  var a = h.querySelector('a') || h.closest('a') || h;
  a.click();
  return 'clicked:' + (h.innerText||'').replace(/\\s+/g,' ').slice(0,26);
})()`));
await sleep(14000);

// 3) 看课程页是否有章节树
console.log('C 课程页: ' + String(await ev(`(function(){
  var body = (document.body.innerText||'').replace(/\\s+/g,' ');
  return JSON.stringify({
    url: location.href.slice(0,80), title: document.title.slice(0,20),
    invalid: /无效的参数/.test(body),
    body: body.slice(0, 220),
    iframes: Array.from(document.querySelectorAll('iframe')).map(function(f){ return String(f.src||'').slice(0,55); }).slice(0,5),
    chapterish: document.querySelectorAll('[class*=chapter],[class*=catalog],[class*=cell],[class*=item]').length
  });
})()`)).slice(0, 800));
ws.close();
