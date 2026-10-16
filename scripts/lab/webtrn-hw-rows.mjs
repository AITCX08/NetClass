/** 打印作业列表每一行的完整链接与按钮（找真正的提交入口） */
const PORT = Number(process.argv[2] || 9226);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes('homework'));
if (!p) { console.log('无作业列表标签'); process.exit(0); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 20000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const expr = `(function(){
  var out = { url: location.href.slice(0,110), rows: [] };
  var nodes = Array.from(document.querySelectorAll('table tr, ul li, div[class*=item], div[class*=list]'));
  nodes.forEach(function(n){
    var t = (n.innerText || '').replace(/\\s+/g,' ').trim();
    if (!/研修心得/.test(t) || t.length > 300) return;
    var links = Array.from(n.querySelectorAll('a')).map(function(a){
      return { txt: (a.innerText||'').trim().slice(0,12), onclick: (a.getAttribute('onclick')||'').slice(0,200), href: (a.getAttribute('href')||'').slice(0,120) };
    });
    out.rows.push({ cls: String(n.className||'').slice(0,30), text: t.slice(0,160), links: links });
  });
  out.rows = out.rows.slice(0, 4);
  return JSON.stringify(out);
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(r.timeout ? '求值超时' : String((r.result && r.result.result && r.result.result.value) || '').slice(0, 2600));
ws.close();
