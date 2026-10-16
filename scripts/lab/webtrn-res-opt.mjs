/** 用隐藏 select 自己的选项来设值（不存在则注入 option），然后保存 */
const PORT = Number(process.argv[2] || 9226);
const ITEM = process.argv[3];
const TITLE = process.argv[4];
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

console.log('隐藏 select 的选项: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  return JSON.stringify(['resourceSubject_','resourceStage_','resourceType_'].map(function(pid){
    var e = document.getElementById(pid + item);
    if (!e) return pid + ':missing';
    return { id: pid, count: e.options.length, first: Array.from(e.options).slice(0,4).map(function(o){ return (o.text||'').slice(0,10) + '|' + String(o.value).slice(0,16); }) };
  }));
})()`));

console.log('用自身选项设值并保存: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  // 从行级 select 取想要的 value
  function rowVal(selName, want){
    var els = Array.from(document.querySelectorAll('select[name="' + selName + '_' + item + '"]'));
    for (var i=0;i<els.length;i++){
      var o = Array.from(els[i].options).find(function(x){return (x.text||'').trim()===want;}) || Array.from(els[i].options).find(function(x){return (x.text||'').indexOf(want)>=0;});
      if (o) return { value: o.value, text: (o.text||'').trim() };
    }
    return null;
  }
  var want = { s: rowVal('subject','其他'), g: rowVal('stage','小学、初中、高中'), t: rowVal('type','研修作业') };
  var log = [];
  function apply(pid, w){
    var e = document.getElementById(pid + item);
    if (!e || !w) { log.push(pid + '=skip'); return; }
    var hit = Array.from(e.options).find(function(o){ return o.value === w.value; }) || Array.from(e.options).find(function(o){ return (o.text||'').trim() === w.text; });
    if (hit) { e.value = hit.value; log.push(pid + '=hit:' + (hit.text||'').slice(0,8)); return; }
    // 自身没有该选项 → 注入一个
    var opt = document.createElement('option'); opt.value = w.value; opt.text = w.text; e.appendChild(opt);
    e.value = w.value;
    log.push(pid + '=injected:' + w.text.slice(0,8));
  }
  apply('resourceSubject_', want.s);
  apply('resourceStage_', want.g);
  apply('resourceType_', want.t);
  var t = document.getElementById('resourceTitle_' + item); if (t) t.value = ${JSON.stringify(TITLE)};
  var chk = { subj: (document.getElementById('resourceSubject_'+item)||{}).value, stage: (document.getElementById('resourceStage_'+item)||{}).value, type: (document.getElementById('resourceType_'+item)||{}).value, title: (document.getElementById('resourceTitle_'+item)||{}).value };
  window.saveResource(item);
  return JSON.stringify({ log: log, check: chk });
})()`));
for (let i = 0; i < 6; i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    count: (Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ var m=(a.innerText||'').match(/已有(\\d+)份/); return m?m[1]:null; }).filter(Boolean)[0] || '?'),
    dlg: (Array.from(document.querySelectorAll('[class*=dialog],[class*=tip],[class*=alert]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,44)})[0] || '')
  })`);
  console.log('  ' + (i + 1) + ') ' + st);
  if (/"count":"[1-9]/.test(st)) { console.log('✅ 保存成功'); break; }
}
ws.close();
