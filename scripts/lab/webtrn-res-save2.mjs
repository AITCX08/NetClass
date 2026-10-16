/** 一次性：填全元数据（学科/学段/类别/标题）→ 校验值仍在 → 保存 → 轮询计数 */
const PORT = Number(process.argv[2] || 9226);
const ITEM = process.argv[3];
const TITLE = process.argv[4] || '专业发展规划研修心得';
const TYPE = process.argv[5] || '研修作业';
const SUBJECT = process.argv[6] || '其他';
const STAGE = process.argv[7] || '小学、初中、高中';
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

// 关弹窗
await ev(`(function(){ Array.from(document.querySelectorAll('a,button,span')).filter(function(b){return /^(确定|关闭|×)$/.test((b.innerText||'').trim())}).forEach(function(b){ if (b.offsetParent!==null) { try{b.click()}catch(e){} } }); return 1; })()`);
await sleep(800);

console.log('填表: ' + await ev(`(function(){
  function setSel(name, want, item){
    var els = Array.from(document.querySelectorAll('select[name="' + name + '_' + item + '"]'));
    var ok = 0;
    els.forEach(function(s){
      var o = Array.from(s.options).find(function(x){ return (x.text||'').trim() === want; }) || Array.from(s.options).find(function(x){ return (x.text||'').indexOf(want) >= 0; });
      if (o) { s.value = o.value; ok++; try{s.dispatchEvent(new Event('change',{bubbles:true}))}catch(e){} }
    });
    return ok + '/' + els.length;
  }
  var item = ${JSON.stringify(ITEM)};
  var r = { subject: setSel('subject', ${JSON.stringify(SUBJECT)}, item), stage: setSel('stage', ${JSON.stringify(STAGE)}, item), type: setSel('type', ${JSON.stringify(TYPE)}, item) };
  var ts = Array.from(document.querySelectorAll('input[name="title_' + item + '"]'));
  ts.forEach(function(i){ i.value = ${JSON.stringify(TITLE)}; i.setAttribute('value', ${JSON.stringify(TITLE)}); try{i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true}))}catch(e){} });
  r.titles = ts.length;
  return JSON.stringify(r);
})()`));
await sleep(500);

console.log('保存前校验字段: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  var g = function(sel){ var e = document.querySelector(sel); return e ? String(e.value).slice(0,24) : 'missing'; };
  return JSON.stringify({
    subject: g('select[name="subject_' + item + '"]'),
    stage: g('select[name="stage_' + item + '"]'),
    type: g('select[name="type_' + item + '"]'),
    title: g('input[name="title_' + item + '"]'),
    resourceSubject: g('#resourceSubject_' + item),
    resourceStage: g('#resourceStage_' + item)
  });
})()`));

console.log('保存: ' + await ev(`(function(){ try { window.saveResource(${JSON.stringify(ITEM)}); return 'called'; } catch(e){ return 'ERR ' + e.message; } })()`));

for (let i = 0; i < 8; i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    count: (Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){return (a.innerText||'').match(/已有(\\d+)份/)?.[1]}).filter(Boolean)[0] || '?'),
    dlg: (Array.from(document.querySelectorAll('[class*=dialog],[class*=tip],[class*=alert]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,50)})[0] || '')
  })`);
  console.log('  ' + (i + 1) + ') ' + st);
  if (/"count":"[1-9]/.test(st)) { console.log('✅ 已保存，计数 +1'); break; }
}
ws.close();
