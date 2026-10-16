/**
 * cc-explore.mjs — 探长春教师培训平台：进培训 → 展开分类 → 枚举课程 → 进一门课看任务结构
 *   node scripts/cc-explore.mjs --port 9228
 */
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=9228').split('=')[1]);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 30000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({ timeout: true }), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function clickText(txt, sel = 'button,a,div,span') {
  const box = await ev(`(function(){
    var el = Array.from(document.querySelectorAll('${sel}')).find(function(e){ return (e.innerText||'').trim() === ${JSON.stringify(txt)} && (e.offsetWidth||e.offsetHeight); });
    if (!el) return null; el.scrollIntoView({block:'center'});
    var r = el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), tag:el.tagName});
  })()`);
  if (!box) return null;
  const b = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  return b;
}

console.log('起点: ' + String(await ev('document.title + " | " + location.href.slice(0,40)')));
// 1) 进入培训
let r = await clickText('进入');
console.log('点进入: ' + JSON.stringify(r));
await sleep(8000);

// 2) 展开所有分类
for (let i = 0; i < 4; i++) {
  const n = await ev(`(function(){ var bs = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return /^(展开|更多|显示更多)$/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); }); bs.forEach(function(b){ try{ b.click(); }catch(e){} }); return bs.length; })()`);
  await sleep(2500);
  if (!n) break;
}

// 3) 枚举课程
const info = await ev(`JSON.stringify((function(){
  var t = (document.body.innerText||'').replace(/\\s+/g,' ');
  var cards = Array.from(document.querySelectorAll('[class*=course],[class*=Course],li,tr')).filter(function(e){
    var x = (e.innerText||'').replace(/\\s+/g,' ').trim();
    return x.length > 6 && x.length < 90 && /学时/.test(x);
  }).slice(0, 10).map(function(e){ return (e.innerText||'').replace(/\\s+/g,' ').slice(0,60); });
  return { head: t.slice(0, 380), courseSamples: cards, links: Array.from(document.querySelectorAll('a')).filter(function(a){ return /course|study|learn/i.test(a.getAttribute('href')||''); }).slice(0,5).map(function(a){ return (a.innerText||'').trim().slice(0,24) + ' => ' + a.getAttribute('href').slice(0,50); }) };
})())`);
console.log(String(info).slice(0, 1100));
ws.close();
