/** ccplays.mjs — 看 ccjyxy 每个标签上有没有「播放」按钮、是否在播 */
const list = await (await fetch('http://127.0.0.1:9228/json/list')).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const JS = `(function(){
  function f(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=f(d);if(x)return x}}}catch(e){}return null}
  var v = f(document);
  var t = (document.body.innerText||'').replace(/\\s+/g,' ');
  var plays = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return (e.innerText||'').trim()==='播放' && (e.offsetWidth||e.offsetHeight); });
  var backs = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){ return /返回课程列表|返回培训内容列表/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); });
  return JSON.stringify({
    playBtns: plays.length,
    backBtns: backs.length,
    video: v ? Math.round(v.currentTime)+'/'+Math.round(v.duration||0)+(v.paused?' 停':' 播') : null,
    head: t.slice(0, 90)
  });
})()`;
for (const t of cand) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const res = await new Promise(r => { ws.addEventListener('message', e => { const x = JSON.parse(e.data); if (x.id === 1) r(x); }); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: JS, returnByValue: true, awaitPromise: true } })); setTimeout(() => r({}), 8000); });
  console.log(t.id.slice(0, 6) + ' → ' + (res.result && res.result.result ? res.result.result.value : '?'));
  ws.close();
}
