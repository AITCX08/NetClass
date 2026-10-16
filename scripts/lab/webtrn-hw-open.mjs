/** 取作业链接的完整 onclick，并关掉卡死标签、开新标签重试 */
const PORT = Number(process.argv[2] || 9226);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pages = list.filter(t => t.type === 'page');
const hw = pages.find(t => String(t.url).includes('homework'));
const dead = pages.find(t => String(t.url).includes('zjdx-kfkc'));
if (dead) { await fetch(`http://127.0.0.1:${PORT}/json/close/${dead.id}`); console.log('已关闭卡死标签'); }

const ws = new WebSocket(hw.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 20000) => new Promise(res => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => res({ timeout: true }), ms);
});
const r = await send('Runtime.evaluate', {
  expression: `(function(){
    var a = Array.from(document.querySelectorAll('a')).filter(function(x){return (x.innerText||'').trim()==='查看作业'});
    return JSON.stringify(a.map(function(x){ return x.getAttribute('onclick'); }));
  })()`, returnByValue: true
});
console.log('完整 onclick:');
const arr = JSON.parse((r.result && r.result.result && r.result.result.value) || '[]');
for (const s of arr) console.log('  ' + String(s).replace(/\s+/g, ' '));
// 解析出真实 URL（把 +window.location... 换成当前域名）
const m = String(arr[0] || '').match(/window\.open\('([^']+)'/);
if (m) {
  let u = m[1];
  if (u.endsWith('domain=')) u += encodeURIComponent('https://tea.webtrn.cn');
  console.log('重试 URL: ' + u.slice(0, 160));
  const nt = await send('Target.createTarget', { url: u });
  console.log('新标签: ' + JSON.stringify(nt.result || nt.error).slice(0, 120));
}
ws.close();
