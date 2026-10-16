/** 原子操作：同一 tick 内填 bean.* 字段并立即 saveResource（避免被页面重渲染清空） */
const PORT = Number(process.argv[2] || 9226);
const ITEM = process.argv[3];
const TITLE = process.argv[4] || '研修材料';
const TYPE_TXT = process.argv[5] || '研修作业';
const SUBJECT_TXT = process.argv[6] || '其他';
const STAGE_TXT = process.argv[7] || '小学、初中、高中';
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

// 先清掉多余的暂存行，只留 1 条
console.log('清理: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  var rows = Array.from(document.querySelectorAll('div[class*=a_u_row0]')).filter(function(r){ return String(r.className).indexOf(item) >= 0; });
  var n = 0;
  rows.slice(1).forEach(function(r){ var c = Array.from(r.querySelectorAll('a')).find(function(x){ return /取消/.test(x.innerText||''); }); if (c) { c.click(); n++; } });
  return 'rows=' + rows.length + ' cancelled=' + n;
})()`));
await sleep(3000);

console.log('原子填+存: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  function val(selName, want){
    var els = Array.from(document.querySelectorAll('select[name="' + selName + '_' + item + '"]'));
    for (var i=0;i<els.length;i++){
      var o = Array.from(els[i].options).find(function(x){return (x.text||'').trim()===want;}) || Array.from(els[i].options).find(function(x){return (x.text||'').indexOf(want)>=0;});
      if (o) return o.value;
    }
    return '';
  }
  var s = { subj: val('subject', ${JSON.stringify(SUBJECT_TXT)}), stg: val('stage', ${JSON.stringify(STAGE_TXT)}), typ: val('type', ${JSON.stringify(TYPE_TXT)}) };
  function set(id, v){ var e = document.getElementById(id); if (e) { e.value = v; return 1; } return 0; }
  var n = 0;
  n += set('resourceSubject_' + item, s.subj);
  n += set('resourceStage_' + item, s.stg);
  n += set('resourceType_' + item, s.typ);
  n += set('resourceTitle_' + item, ${JSON.stringify(TITLE)});
  var before = { subj: (document.getElementById('resourceSubject_'+item)||{}).value, title: (document.getElementById('resourceTitle_'+item)||{}).value };
  window.saveResource(item);
  return JSON.stringify({ picked: s, setCount: n, beforeSave: before });
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
