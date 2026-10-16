/**
 * webtrn-res-final.mjs — 走平台自己的路径完成保存：modifyResource(themeId,resourceId) → 填可见面板 → saveResource
 *   node scripts/webtrn-res-final.mjs --port 9226 --item <itemId> --title "..." [--type 研修作业] [--subject 其他] [--stage 小学、初中、高中]
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

console.log('暂存行: ' + await ev(`JSON.stringify(Array.from(document.querySelectorAll('div[class*=a_u_row0]')).map(function(r){
  var m = String(r.className).match(/res_([0-9a-f]+)_o_([0-9a-z]+)/);
  return m ? { item: m[1].slice(0,20), uploadId: m[2] } : null;
}).filter(Boolean))`));

console.log('modifyResource: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  var row = Array.from(document.querySelectorAll('div[class*=a_u_row0]')).find(function(r){ return String(r.className).indexOf(item) >= 0; });
  if (!row) return 'no-row';
  var m = String(row.className).match(/res_([0-9a-f]+)_o_([0-9a-z]+)/);
  if (!m) return 'no-upload-id';
  try { window.modifyResource(m[1], m[2]); return 'called ' + m[2].slice(0,12); } catch(e){ return 'ERR ' + e.message; }
})()`));
await sleep(4000);

console.log('可见表单: ' + await ev(`JSON.stringify(Array.from(document.querySelectorAll('input[type=text],textarea,select')).filter(function(i){return i.offsetParent!==null}).map(function(i){return {tag:i.tagName,id:String(i.id).slice(0,44),val:String(i.value).slice(0,18)}}).slice(0,10))`));

console.log('填表: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  function pick(selName, want){
    var els = Array.from(document.querySelectorAll('select[name="' + selName + '_' + item + '"]'));
    for (var i=0;i<els.length;i++){
      var o = Array.from(els[i].options).find(function(x){return (x.text||'').trim()===want;}) || Array.from(els[i].options).find(function(x){return (x.text||'').indexOf(want)>=0;});
      if (o) return { el: els[i], value: o.value };
    }
    return null;
  }
  var out = [];
  [['subject', ${JSON.stringify(SUBJECT_TXT)}], ['stage', ${JSON.stringify(STAGE_TXT)}], ['type', ${JSON.stringify(TYPE_TXT)}]].forEach(function(pair){
    var r = pick(pair[0], pair[1]);
    if (r) { r.el.value = r.value; try { r.el.dispatchEvent(new Event('change',{bubbles:true})); } catch(e){} out.push(pair[0] + '=' + r.value.slice(0,12)); }
    else out.push(pair[0] + '=MISS');
  });
  var t = document.getElementById('resourceTitle_' + item) || document.querySelector('input[name="title_' + item + '"]');
  if (t) { t.value = ${JSON.stringify(TITLE)}; try { t.dispatchEvent(new Event('change',{bubbles:true})); } catch(e){} out.push('title=' + t.value.slice(0,10)); }
  return JSON.stringify(out);
})()`));
await sleep(800);

console.log('保存前: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)}; var g = function(id){ var e = document.getElementById(id); return e ? String(e.value).slice(0,16) : 'missing'; };
  return JSON.stringify({ title: g('resourceTitle_'+item), subject: g('resourceSubject_'+item), stage: g('resourceStage_'+item), type: g('resourceType_'+item) });
})()`));

console.log('保存: ' + await ev(`(function(){ try { window.saveResource(${JSON.stringify(ITEM)}); return 'called'; } catch(e){ return 'ERR '+e.message; } })()`));
for (let i = 0; i < 6; i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    count: (Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ var m=(a.innerText||'').match(/已有(\\d+)份/); return m?m[1]:null; }).filter(Boolean)[0] || '?'),
    dlg: (Array.from(document.querySelectorAll('[class*=dialog],[class*=tip],[class*=alert]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,40)})[0] || '')
  })`);
  console.log('  ' + (i+1) + ') ' + st);
  if (/"count":"[1-9]/.test(st)) { console.log('✅ 保存成功'); break; }
}
ws.close();
