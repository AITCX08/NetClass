/** 诊断+清理：列出所有暂存资源行（区分归属活动项与可见性），只留 1 条，然后重存 */
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

console.log('== 关掉提示弹窗 ==');
console.log(await ev(`(function(){
  var n = 0;
  Array.from(document.querySelectorAll('a,button,span')).filter(function(b){ return /^(确定|关闭|×)$/.test((b.innerText||'').trim()); }).forEach(function(b){ if (b.offsetParent !== null) { try { b.click(); n++; } catch(e){} } });
  return 'closed=' + n;
})()`));
await new Promise(r => setTimeout(r, 1200));

console.log('== 暂存行明细 ==');
console.log(await ev(`JSON.stringify(Array.from(document.querySelectorAll('div[class*=a_u_row0]')).map(function(r,i){
  var cls = String(r.className);
  var m = cls.match(/res_([0-9a-f]+)_o_([0-9a-z]+)/);
  return { i: i, itemId: m ? m[1] : null, uploadId: m ? m[2] : null, visible: !!(r.offsetWidth||r.offsetHeight), text: (r.innerText||'').replace(/\\s+/g,' ').slice(0,40) };
}))`));

console.log('== 只保留目标项的第 1 条 ==');
console.log(await ev(`(function(){
  var rows = Array.from(document.querySelectorAll('div[class*=a_u_row0]')).filter(function(r){ return String(r.className).indexOf(${JSON.stringify(ITEM)}) >= 0; });
  var n = 0;
  rows.slice(1).forEach(function(r){ var c = Array.from(r.querySelectorAll('a')).find(function(x){ return /取消/.test(x.innerText||''); }); if (c) { c.click(); n++; } });
  return 'itemRows=' + rows.length + ' cancelled=' + n;
})()`));
await new Promise(r => setTimeout(r, 3000));

console.log('== 再保存 ==');
console.log(await ev(`(function(){ try { window.saveResource(${JSON.stringify(ITEM)}); return 'called'; } catch(e){ return 'ERR ' + e.message; } })()`));
await new Promise(r => setTimeout(r, 8000));
console.log('计数: ' + await ev(`Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ return (a.innerText||'').replace(/\\s+/g,' ').slice(0,40); }).filter(function(t){ return /已有/.test(t); }).join(' || ')`));
console.log('弹窗: ' + await ev(`JSON.stringify(Array.from(document.querySelectorAll('[class*=dialog],[class*=alert],[class*=tip]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,60)}).filter(Boolean).slice(0,3))`));
ws.close();
