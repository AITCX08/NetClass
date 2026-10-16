/**
 * cx-reload.mjs — 强制重载学习通页面（CDP 层，绕过被阻塞的 JS 线程）
 *   node scripts/cx-reload.mjs --port 9227 [--url <url>]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url)) || list.find(t => t.type === 'page');
if (!p) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 15000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
await send('Page.enable');
ws.addEventListener('message', async ev => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === 'Page.javascriptDialogOpening') {
    console.log('弹窗(type=' + m.params.type + '): ' + JSON.stringify(m.params.message).slice(0, 160));
    await send('Page.handleJavaScriptDialog', { accept: true });
    console.log('  → 已接受并关闭');
  }
});
const url = A.url || p.url;
const r = await send('Page.navigate', { url });
console.log('Page.navigate → ' + JSON.stringify(r).slice(0, 140));
await new Promise(res => setTimeout(res, 12000));
// 复核
const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href.slice(-50), nodes: document.querySelectorAll(\'[onclick^="getTeacherAjax"]\').length})', returnByValue: true });
console.log('复核: ' + JSON.stringify(ev.result && ev.result.result ? ev.result.result.value : ev).slice(0, 220));
ws.close();
