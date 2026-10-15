/** ccdiag.mjs — 诊断长春驱动的卡点：每个标签上究竟有什么 */
const P = 9228;
const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
console.log('ccjyxy 标签数: ' + cand.length);
const JS = `(function(){
  var t = (document.body.innerText||'').replace(/\\s+/g,' ');
  var cards = Array.from(document.querySelectorAll('div,li,article,section')).filter(function(e){
    var x = (e.innerText||'').replace(/\\s+/g,' ').trim();
    return x.length > 12 && x.length < 140 && /编码[:：]/.test(x) && /学时/.test(x);
  });
  var exp = Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){
    return /^(展开|更多)$/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight);
  });
  var paused = null; try { paused = localStorage.getItem('ncCc:paused'); } catch(e){}
  return JSON.stringify({
    url: location.href.slice(-28),
    onTraining: /学习总进度/.test(t),
    onCourse: /返回课程列表/.test(t),
    cards: cards.length,
    expBtns: exp.length,
    paused: paused,
    head: t.slice(0, 80)
  });
})()`;
for (const t of cand) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  const res = await new Promise(r => { ws.addEventListener('message', e => { const x = JSON.parse(e.data); if (x.id === 1) r(x); }); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: JS, returnByValue: true, awaitPromise: true } })); setTimeout(() => r({}), 8000); });
  console.log('  ' + t.id.slice(0, 6) + ' → ' + (res.result && res.result.result ? res.result.result.value : '?'));
  ws.close();
}
