/**
 * page-reload.mjs — 重载指定标签（按 URL 子串）并打印结果；用于解卡与看首屏
 *   node scripts/page-reload.mjs 9226 zjdx-kfkc [等待秒数]
 */
const PORT = Number(process.argv[2] || 9226);
const MATCH = process.argv[3] || 'webtrn.cn';
const WAIT = Number(process.argv[4] || 12) * 1000;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes(MATCH));
if (!p) { console.log('无匹配标签: ' + MATCH); process.exit(0); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 25000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
await send('Page.enable');
const url = p.url;
console.log('目标: ' + url.slice(0, 100));
const nav = await send('Page.navigate', { url });
console.log('navigate -> ' + JSON.stringify(nav.result || nav.error || nav).slice(0, 100));
await new Promise(r => setTimeout(r, WAIT));
const expr = `JSON.stringify({title:document.title,url:location.href.slice(0,90),ready:document.readyState,
  body:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,700),
  controls:Array.from(new Set(Array.from(document.querySelectorAll('a,input[type=button],button')).map(b=>(b.value||b.innerText||'').trim().slice(0,14)).filter(Boolean))).slice(0,20)})`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, 30000);
console.log(r.timeout ? '求值仍超时（主线程忙）' : String((r.result && r.result.result && r.result.result.value) || '').slice(0, 1200));
ws.close();
