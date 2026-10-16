/** cc-idle.mjs — 进课程页后什么都不做，看平台是否自己跳走（60-90 秒）
 *  node scripts/cc-idle.mjs --tab 0 --secs 90
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9228), SECS = Number(A.secs || 90);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
const cand = list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
const t = cand[Number(A.tab || 0)] || cand[0];
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, p = {}, ms = 20000) => new Promise(res => {
  const id = ++seq; const on = e => { let x; try { x = JSON.parse(e.data); } catch (_) { return } if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: p })); setTimeout(() => res({ timeout: true }), ms);
});
const ev = async (e, ms = 15000) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, ms); return r.timeout ? null : (r.result && r.result.result ? r.result.result.value : null); };

const PROBE = `(function(){
  var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  return JSON.stringify({onTrain:/学习总进度/.test(t),onCourse:/返回课程列表/.test(t),v:!!document.querySelector('video'),n:document.querySelectorAll('.MuiListItemButton-root').length,tail:t.slice(0,46)});
})()`;

// 记录路由变化
await ev(`(function(){
  if (window.__ccRouteHook) return 'has';
  window.__ccRouteHook=1; window.__ccRoutes=[];
  var push=history.pushState, rep=history.replaceState;
  function note(kind){ try{ window.__ccRoutes.push(new Date().toTimeString().slice(0,8)+' '+kind+' '+location.href); }catch(e){} }
  history.pushState=function(){ note('push'); return push.apply(this,arguments); };
  history.replaceState=function(){ note('replace'); return rep.apply(this,arguments); };
  window.addEventListener('popstate',function(){ note('pop'); });
  return 'installed';
})()`);

console.log('标签: ' + t.id.slice(0, 6) + '（只观察，不点击）');
let prev = '';
for (let i = 0; i <= SECS / 3; i++) {
  const s = await ev(PROBE); const o = s ? JSON.parse(s) : {};
  const line = (o.onTrain ? '训练页 ' : o.onCourse ? '课程页 ' : '其他   ') + (o.v ? 'video=YES ' : 'video=no  ') + 'items=' + o.n + ' | ' + o.tail;
  if (line !== prev) { console.log(String(i * 3).padStart(3) + 's ' + line); prev = line; }
  await new Promise(r => setTimeout(r, 3000));
}
const routes = await ev(`JSON.stringify(window.__ccRoutes||[])`);
console.log('路由事件: ' + routes);
process.exit(0);
