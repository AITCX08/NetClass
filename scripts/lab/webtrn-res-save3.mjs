/**
 * webtrn-res-save3.mjs — 收口「上传类活动」的保存（填 bean.* 表单字段 + saveResource）
 *
 * 关键事实（HANDOVER §5.25 补）：
 *   保存读的是**表单字段**： #resourceSubject_<itemId>(bean.peSubject.id) / #resourceStage_<itemId>(bean.peStage.id)
 *   / #resourceType_<itemId>(bean.enumConstByFlagResourceType.code) / #resourceTitle_<itemId>(bean.name) / #des_<itemId>
 *   而不是列表行里的 select[name=subject_<itemId>]（那是上传行自己的属性）。
 *   学科/学段/类别要填**选项 value**（不是文字），标题填文字。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9226);
const ITEM = String(A.item || '');
const TITLE = String(A.title || '研修材料');
const TYPE_TXT = String(A.type || '研修作业');
const SUBJECT_TXT = String(A.subject || '其他');
const STAGE_TXT = String(A.stage || '小学、初中、高中');
const INTRO = String(A.intro || '');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes('activity_view'));
if (!p) { console.log('没找到研修活动页'); process.exit(1); }
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

console.log('填 bean.* 字段: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  function pickValue(selName, want){
    var els = Array.from(document.querySelectorAll('select[name="' + selName + '_' + item + '"]'));
    for (var i = 0; i < els.length; i++) {
      var o = Array.from(els[i].options).find(function(x){ return (x.text||'').trim() === want; }) ||
              Array.from(els[i].options).find(function(x){ return (x.text||'').indexOf(want) >= 0; });
      if (o) return o.value;
    }
    return '';
  }
  var subj = pickValue('subject', ${JSON.stringify(SUBJECT_TXT)});
  var stg  = pickValue('stage', ${JSON.stringify(STAGE_TXT)});
  var typ  = pickValue('type', ${JSON.stringify(TYPE_TXT)});
  function put(id, val){ var e = document.getElementById(id); if (!e) return id + ':missing'; e.value = val; try { e.dispatchEvent(new Event('change', {bubbles:true})); } catch(e2){} return id.replace(item,'*') + '=' + String(val).slice(0,16); }
  var r = [];
  r.push(put('resourceSubject_' + item, subj));
  r.push(put('resourceStage_' + item, stg));
  r.push(put('resourceType_' + item, typ));
  r.push(put('resourceTitle_' + item, ${JSON.stringify(TITLE)}));
  if (${JSON.stringify(INTRO)}) r.push(put('des_' + item, ${JSON.stringify(INTRO)}));
  return JSON.stringify({ picks: { subj: subj.slice(0,14), stg: stg.slice(0,14), typ: typ }, applied: r });
})()`));
await sleep(600);

console.log('保存前校验: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  var g = function(id){ var e = document.getElementById(id); return e ? String(e.value).slice(0,18) : 'missing'; };
  return JSON.stringify({ title: g('resourceTitle_'+item), subject: g('resourceSubject_'+item), stage: g('resourceStage_'+item), type: g('resourceType_'+item) });
})()`));

console.log('保存: ' + await ev(`(function(){ try { window.saveResource(${JSON.stringify(ITEM)}); return 'called'; } catch(e){ return 'ERR ' + e.message; } })()`));
for (let i = 0; i < 8; i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    count: (Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ var m=(a.innerText||'').match(/已有(\\d+)份/); return m?m[1]:null; }).filter(Boolean)[0] || '?'),
    dlg: (Array.from(document.querySelectorAll('[class*=dialog],[class*=tip],[class*=alert]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,40)})[0] || '')
  })`);
  console.log('  ' + (i + 1) + ') ' + st);
  if (/"count":"[1-9]/.test(st)) { console.log('✅ 保存成功，计数 +1'); break; }
}
ws.close();
