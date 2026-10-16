/**
 * cx-clear.mjs — 清掉学习通页面上挡路的弹窗（真实鼠标点击）+ 关掉多余控制台窗口
 *   node scripts/cx-clear.mjs --port 9227
 */
const PORT = Number((process.argv.find(a => a.startsWith('--port=')) || '--port=9227').split('=')[1]);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url));
if (!p) { console.log('没有 chaoxing 页面'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 20000) => new Promise(res => { const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params })); setTimeout(() => res({ timeout: true }), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 找弹窗：「当前章节还有任务点未完成」→ 点绿色的「下一节」
const found = await ev(`(function(){
  var all = Array.from(document.querySelectorAll('div,section,article'));
  var dlg = all.find(function(e){ var t=(e.innerText||''); return /还有任务点未完成|是否去完成/.test(t) && t.length < 200 && (e.offsetWidth||e.offsetHeight); });
  if (!dlg) return 'no-dialog';
  var btns = Array.from(dlg.querySelectorAll('a,button,span,div')).filter(function(b){ return /^(下一节|去学习|确定)$/.test((b.innerText||'').trim()) && (b.offsetWidth||b.offsetHeight); });
  if (!btns.length) return 'no-btn';
  var target = btns.find(function(b){ return /下一节/.test(b.innerText); }) || btns[0];
  var r = target.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), txt: target.innerText.trim(), w: Math.round(r.width) });
})()`);
console.log('弹窗按钮: ' + found);
if (found && found !== 'no-dialog' && found !== 'no-btn') {
  const b = JSON.parse(found);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  console.log('已点「' + b.txt + '」');
  await sleep(6000);
}
// 复查：弹窗是否消失 + 当前在哪
console.log('复查: ' + String(await ev(`JSON.stringify({
  dialogGone: !/还有任务点未完成/.test(document.body.innerText||''),
  url: location.href.slice(0,75)
})`)).slice(0, 200));
ws.close();
