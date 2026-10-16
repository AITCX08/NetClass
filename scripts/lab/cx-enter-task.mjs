/**
 * 走站内路径进任务点：在课程首页用 CDP 真实鼠标点 a[href*=studentstudy]
 *   node scripts/cx-enter-task.mjs --port 9227 --chapter 1236487649
 */
const PORT = 9227;
const argv = process.argv.slice(2);
const A = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = argv[i+1];
const CH = A.chapter || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url));
  if (!p) { console.log('no page'); process.exit(1); }
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (m, params = {}) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({ timeout: true }), 20000); });
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };
  const box = await ev(`(function(){
    var links = Array.from(document.querySelectorAll('a[href*="studentstudy"]'));
    var a = ${CH ? `links.find(function(x){ return (x.getAttribute('href')||'').indexOf('${CH}') >= 0; })` : 'links[0]'};
    if (!a) return null;
    a.scrollIntoView({block:'center'});
    var r = a.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), t: (a.innerText||'').trim().slice(0,30), href: (a.getAttribute('href')||'').slice(0,80) });
  })()`);
  if (!box) { console.log('没找到链接'); process.exit(1); }
  const b = JSON.parse(box);
  console.log('点击: ' + b.t + '  (' + b.x + ',' + b.y + ')');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(12000);
  const st = await ev(`JSON.stringify({ url: location.href.slice(-60), bad: /enc校验失败/.test(document.body.innerText||''), nodes: document.querySelectorAll('[onclick^="getTeacherAjax"]').length, cur: (document.getElementById('curChapterId')||{}).value })`);
  console.log('结果: ' + st);
  ws.close();
})();
