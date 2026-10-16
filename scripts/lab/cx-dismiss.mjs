/**
 * cx-dismiss.mjs — 处理/关闭卡住页面的原生 JS 弹窗（alert/confirm/beforeunload）
 *   node scripts/cx-dismiss.mjs --port 9227 [--secs 8] [--accept]
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const SECS = Number(A.secs || 6);
const ACCEPT = !!A.accept;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
let handled = 0;
ws.addEventListener('message', async ev => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.method === 'Page.javascriptDialogOpening') {
    console.log('弹窗: ' + m.params.type + '  msg=' + JSON.stringify(m.params.message).slice(0, 160));
    handled++;
    const r = await send('Page.handleJavaScriptDialog', { accept: m.params.type === 'beforeunload' ? true : ACCEPT });
    console.log('  → ' + (r.timeout ? '处理超时' : '已' + (ACCEPT ? '接受' : '取消')));
  }
});
await send('Page.enable');
await sleep(SECS * 1000);
if (!handled) console.log('（这段时间没有弹窗）');
ws.close();
