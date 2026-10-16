/**
 * webtrn-resource-save.mjs — 完成「上传类活动」的最后一步：填元数据 + 保存
 *
 *   node scripts/webtrn-resource-save.mjs --port 9226 --item <itemId> --title "专业发展规划研修心得" \
 *        [--subject 其他] [--stage 小学、初中、高中] [--type 研修作业] [--keep 1] [--timeout 60]
 *
 * 背景（HANDOVER §5.25）：上传成功后不会自动计数，「已有 N 份资源上传成功」只有在**保存**后才 +1。
 * 平台自己的保存函数是 saveResource('<itemId>')，它校验 #resourceSubject_/#resourceStage_ 不能是「选择…」；
 * 元数据面板在隐藏容器里，直接按 name 赋值即可（隐藏元素照样可写）。
 * --keep N：暂存行多于 N 条时，点掉多余的「取消」，避免一次提交多份重复资源。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9226);
const ITEM = String(A.item || '');
const TITLE = String(A.title || '研修材料');
const TYPE = String(A.type || '研修作业');
const SUBJECT = String(A.subject || '其他');
const STAGE = String(A.stage || '小学、初中、高中');
const KEEP = Number(A.keep == null ? 1 : A.keep);
const TIMEOUT = Number(A.timeout || 60);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && String(t.url).includes('activity_view'));
if (!p) { console.log('没找到研修活动页'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 30000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('== 1) 清理多余暂存行（保留 ' + KEEP + ' 条）==');
console.log(await ev(`(function(){
  var rows = Array.from(document.querySelectorAll('div[class*=a_u_row0]'));
  if (rows.length <= ${KEEP}) return '无需清理（' + rows.length + ' 条）';
  var n = 0;
  rows.slice(${KEEP}).forEach(function(r){ var c = Array.from(r.querySelectorAll('a')).find(function(x){return /取消/.test(x.innerText||'')}); if (c) { c.click(); n++; } });
  return '已取消 ' + n + ' 条';
})()`));
await sleep(2500);

console.log('== 2) 填元数据 ==');
console.log(await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  function setSel(name, want){
    var els = Array.from(document.querySelectorAll('select[name="' + name + '_' + item + '"]'));
    if (!els.length) return name + ':无';
    var ok = 0;
    els.forEach(function(s){
      var o = Array.from(s.options).find(function(x){ return (x.text||'').trim() === want; }) || Array.from(s.options).find(function(x){ return (x.text||'').indexOf(want) >= 0; });
      if (o) { s.value = o.value; try { s.dispatchEvent(new Event('change', {bubbles:true})); } catch(e){} ok++; }
    });
    return name + ':' + ok + '/' + els.length;
  }
  var r1 = setSel('subject', ${JSON.stringify(SUBJECT)});
  var r2 = setSel('stage', ${JSON.stringify(STAGE)});
  var r3 = setSel('type', ${JSON.stringify(TYPE)});
  var ts = Array.from(document.querySelectorAll('input[name="title_' + item + '"]'));
  ts.forEach(function(i){ i.value = ${JSON.stringify(TITLE)}; try { i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); } catch(e){} });
  ['resourceSubject_','resourceStage_','resourceType_'].forEach(function(p){
    var el = document.getElementById(p + item);
    if (el) { el.value = (p === 'resourceSubject_' ? ${JSON.stringify(SUBJECT)} : p === 'resourceStage_' ? ${JSON.stringify(STAGE)} : ${JSON.stringify(TYPE)}); }
  });
  return JSON.stringify({ subject: r1, stage: r2, type: r3, titles: ts.length, hiddenFixed: ['resourceSubject_','resourceStage_','resourceType_'].map(function(p){ return p + '=' + (document.getElementById(p+item) ? document.getElementById(p+item).value : 'missing'); }) });
})()`));
await sleep(800);

console.log('== 3) 保存 ==');
console.log(await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  var btn = Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button')).find(function(b){ return /^\\s*保存\\s*$/.test((b.value||b.innerText||'').trim()); });
  var via = 'none';
  if (typeof window.saveResource === 'function') { setTimeout(function(){ try { window.saveResource(item); } catch(e){} }, 30); via = 'saveResource(item)'; }
  else if (btn) { setTimeout(function(){ try { btn.click(); } catch(e){} }, 30); via = 'click-保存'; }
  return via;
})()`));

console.log('== 4) 轮询计数（最多 ' + TIMEOUT + 's）==');
let done = false;
for (let i = 0; i * 5 < TIMEOUT; i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    counter: Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ return (a.innerText||'').replace(/\\s+/g,' ').slice(0,44); }).filter(function(t){ return /已有/.test(t); }),
    staged: Array.from(document.querySelectorAll('div[class*=a_u_row0]')).length
  })`);
  console.log('  ' + (i + 1) + ') ' + String(st).slice(0, 200));
  if (/已有[1-9]/.test(String(st))) { done = true; break; }
}
console.log(done ? '✅ 保存成功（计数已 +1）' : '⚠ 仍未计数：看页面是否有校验提示（学科/学段/标题）');
ws.close();
