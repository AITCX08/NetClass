/** ccwatch.mjs — 点「播放」后立刻连查 30 秒：有没有新 target / 播放器元素出现 */
const P = 9228;
const targets0 = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const before = new Set(targets0.map(t => t.id));
console.log('点前 target 数: ' + targets0.length + ' → ' + targets0.map(t => t.type + ':' + String(t.url).slice(-24)).join(' | '));

const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const page = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url))[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, params = {}, ms = 10000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 先确保在课程页（点「返回培训列表」→ 找课程卡片进课程）
console.log('当前页正文长度: ' + String(await ev('(document.body.innerText||"").length')));
const box = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return (e.innerText||'').trim()==='播放' && (e.offsetWidth||e.offsetHeight); })[0];
  if (!b) return JSON.stringify({ none: true, plays: Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){return (e.innerText||'').trim()==='播放'}).length });
  b.scrollIntoView({block:'center'}); var r = b.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
})()`);
console.log('播放按钮: ' + box);
const jb = JSON.parse(box);
if (jb.x) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: jb.x, y: jb.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: jb.x, y: jb.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: jb.x, y: jb.y, button: 'left', clickCount: 1 });
  console.log('已点击，开始观察…');
  for (let k = 1; k <= 6; k++) {
    await sleep(3000);
    const tl = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
    const news = tl.filter(t => !before.has(t.id)).map(t => t.type + ':' + String(t.url).slice(-40));
    const st = await ev(`(function(){
      function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
      var v=f(document);
      return JSON.stringify({ video: v?Math.round(v.currentTime)+'/'+Math.round(v.duration||0)+(v.paused?' 停':' 播'):null, len:(document.body.innerText||'').length, iframes: document.querySelectorAll('iframe').length });
    })()`);
    console.log((k*3) + 's: ' + String(st).slice(0,120) + (news.length ? '  ★新target: ' + news.join(',') : ''));
  }
}
ws.close();
