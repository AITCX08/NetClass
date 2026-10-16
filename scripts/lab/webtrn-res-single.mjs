/** 单次求值内完成：设值 → jQuery 复读 → 保存 → 立刻读弹窗（判断是否读到值/是否旧弹窗残留） */
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

// 先把所有弹窗点掉
await ev(`(function(){ var n=0; Array.from(document.querySelectorAll('a,span,button')).filter(function(b){return /^(确定|关闭|×)$/.test((b.innerText||'').trim())}).forEach(function(b){ if(b.offsetParent!==null){ try{b.click();n++}catch(e){} } }); return n; })()`);
await new Promise(r => setTimeout(r, 800));

const out = await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  window.__ncAlerts = [];
  var origAlert = window.alert;
  window.alert = function(m){ window.__ncAlerts.push('alert:' + String(m).slice(0,40)); };
  function val(name, want){
    var els = Array.from(document.querySelectorAll('select[name="' + name + '_' + item + '"]'));
    for (var i=0;i<els.length;i++){
      var o = Array.from(els[i].options).find(function(x){return (x.text||'').trim()===want;}) || Array.from(els[i].options).find(function(x){return (x.text||'').indexOf(want)>=0;});
      if (o) return o.value;
    }
    return '';
  }
  var s = { subj: val('subject','其他'), stg: val('stage','小学、初中、高中'), typ: val('type','研修作业') };
  function force(pid, v){
    var e = document.getElementById(pid + item);
    if (!e) return 'missing';
    var has = Array.from(e.options).some(function(o){ return o.value === v; });
    if (!has && v) { var o2 = document.createElement('option'); o2.value = v; o2.text = v; e.appendChild(o2); }
    e.value = v; return e.value.slice(0,12);
  }
  var r = {};
  r.subj = force('resourceSubject_', s.subj);
  r.stg = force('resourceStage_', s.stg);
  r.typ = force('resourceType_', s.typ);
  var t = document.getElementById('resourceTitle_' + item); if (t) { t.value = '专业发展规划研修心得'; }
  var d = document.getElementById('des_' + item); if (d && !d.value) { d.value = '结合本次新入职教师适岗培训专题研修整理的专业发展规划与研修心得。'; }
  r.jqTitle = window.jQuery ? String(window.jQuery('#' + 'resourceTitle_' + item).val()) : '(no jquery)';
  r.jqSubj = window.jQuery ? String(window.jQuery('#' + 'resourceSubject_' + item).val()).slice(0,14) : '';
  r.jqDes = window.jQuery ? String(window.jQuery('#' + 'des_' + item).val()).slice(0,14) : '';
  try { window.saveResource(item); r.save = 'called'; } catch(e){ r.save = 'ERR ' + e.message; }
  r.alertsNow = window.__ncAlerts.slice(0,3);
  window.alert = origAlert;
  return JSON.stringify(r);
})()`);
console.log(String(out).slice(0, 900));
await new Promise(r => setTimeout(r, 8000));
console.log('计数: ' + await ev(`JSON.stringify(Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ var m=(a.innerText||'').match(/已有(\\d+)份/); return m?m[1]:null; }).filter(Boolean))`));
console.log('弹窗: ' + await ev(`JSON.stringify(Array.from(document.querySelectorAll('[class*=dialog],[class*=tip]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,44)}).slice(0,2))`));
ws.close();
