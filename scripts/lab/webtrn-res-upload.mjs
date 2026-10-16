/** 走上传专用提交：填行级字段 → uploadResource(themeId) → 看计数 */
const PORT = Number(process.argv[2] || 9226);
const ITEM = process.argv[3];
const TITLE = process.argv[4] || '研修材料';
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

console.log('uploadResource 源码头: ' + await ev(`String(window.uploadResource).replace(/\\s+/g,' ').slice(0, 420)`));

console.log('调用: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  function setRow(name, want){
    var els = Array.from(document.querySelectorAll('select[name="' + name + '_' + item + '"]'));
    var ok = 0;
    els.forEach(function(s){
      var o = Array.from(s.options).find(function(x){return (x.text||'').trim()===want;}) || Array.from(s.options).find(function(x){return (x.text||'').indexOf(want)>=0;});
      if (o) { s.value = o.value; ok++; }
    });
    return ok + '/' + els.length;
  }
  var r = { subject: setRow('subject','其他'), stage: setRow('stage','小学、初中、高中'), type: setRow('type','研修作业') };
  var ts = Array.from(document.querySelectorAll('input[name="title_' + item + '"]'));
  ts.forEach(function(t){ t.value = ${JSON.stringify(TITLE)}; });
  r.titles = ts.length;
  try { window.uploadResource(item); r.call = 'called'; } catch(e){ r.call = 'ERR ' + e.message; }
  return JSON.stringify(r);
})()`));

for (let i = 0; i < 8; i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    count: (Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ var m=(a.innerText||'').match(/已有(\\d+)份/); return m?m[1]:null; }).filter(Boolean)[0] || '?'),
    dlg: (Array.from(document.querySelectorAll('[class*=dialog],[class*=tip]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,44)})[0] || ''),
    staged: Array.from(document.querySelectorAll('div[class*=a_u_row0]')).length
  })`);
  console.log('  ' + (i + 1) + ') ' + st);
  if (/"count":"[1-9]/.test(st)) { console.log('✅ 上传提交成功，计数 +1'); break; }
}
ws.close();
