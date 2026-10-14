/** 试平台自己的属性面板：showResource(itemId) → 看可见表单 → 填 → 点面板保存 */
const PORT = Number(process.argv[2] || 9226);
const ITEM = process.argv[3];
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes('activity_view'));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 30000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 150))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('showResource 源码: ' + await ev(`String(window.showResource).slice(0, 300)`));
console.log('调用: ' + await ev(`(function(){ try { window.showResource(${JSON.stringify(ITEM)}); return 'called'; } catch(e){ return 'ERR ' + e.message; } })()`));
await sleep(3000);
console.log('可见表单: ' + await ev(`JSON.stringify({
  inputs: Array.from(document.querySelectorAll('input[type=text],textarea,select')).filter(function(i){return i.offsetParent!==null}).map(function(i){return {tag:i.tagName,id:String(i.id).slice(0,50),name:String(i.name).slice(0,40),val:String(i.value).slice(0,20)}}).slice(0,12),
  buttons: Array.from(document.querySelectorAll('a,input[type=button],button')).filter(function(b){return b.offsetParent!==null && /保存|提交|确定/.test(b.value||b.innerText||'')}).map(function(b){return (b.value||b.innerText||'').trim().slice(0,10)}).slice(0,6)
})`));
ws.close();
