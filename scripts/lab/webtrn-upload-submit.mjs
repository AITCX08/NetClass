/**
 * webtrn-upload-submit.mjs — 上传类活动「一次做完」：点上传 → 塞文件 → 填字段 → uploadResource → 校验计数
 *   node scripts/webtrn-upload-submit.mjs --port 9226 --item <itemId> --file "<笔记本绝对路径>" --title "<标题>" [--subject 其他] [--stage 小学、初中、高中] [--type 研修作业]
 * 关键顺序（踩坑记录见 HANDOVER §5.26/§5.28）：
 *   ① 先点「上传我的资源」再 setFileInputFiles + 补发 input/change（否则 uploadify 不触发）
 *   ② 暂存行出现后**立刻**填行级字段并调 uploadResource(itemId)（页面会重渲染，拖久了行就没了）
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9226);
const ITEM = String(A.item || '');
const FILE = String(A.file || '');
const TITLE = String(A.title || '研修材料');
const TYPE = String(A.type || '研修作业');
const SUBJECT = String(A.subject || '其他');
const STAGE = String(A.stage || '小学、初中、高中');

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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 该 item 的上传区序号：上传区的 id 就是 upload_<itemId>，直接精确匹配（别往上找容器，会撞到整页 HTML）
const idx = await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  var areas = Array.from(document.querySelectorAll('.act_uploadArea'));
  var direct = areas.findIndex(function(a){ return a.id === 'upload_' + item; });
  if (direct >= 0) return String(direct);
  for (var i = 0; i < areas.length; i++) {
    var fi = areas[i].querySelector('input[type=file]') || (areas[i].parentElement && areas[i].parentElement.querySelector('input[type=file]'));
    if (fi && String((areas[i].id || '')).indexOf(item) >= 0) return String(i);
  }
  return '-1';
})()`);
console.log('上传区序号: ' + idx);
if (idx === '-1') { console.log('没找到该活动项的上传区'); ws.close(); process.exit(1); }

console.log('1) 触发上传入口: ' + await ev(`(function(){
  var a = document.querySelectorAll('.act_uploadArea')[${idx}];
  var b = Array.from(a.querySelectorAll('a,input,button')).find(function(x){ return /上传我的资源|继续添加/.test(x.value||x.innerText||''); });
  if (!b) return 'no-button';
  b.click(); return 'clicked';
})()`));
await sleep(1500);

const obj = await send('Runtime.evaluate', { expression: `document.querySelectorAll('.act_uploadArea')[${idx}].querySelector('input[type=file]')`, returnByValue: false });
if (!obj.result.objectId) { console.log('没有 file input'); ws.close(); process.exit(1); }
await send('DOM.setFileInputFiles', { files: [FILE], objectId: obj.result.objectId });
console.log('2) 已塞文件: ' + FILE);
console.log('   事件: ' + await ev(`(function(){
  var i = document.querySelectorAll('.act_uploadArea')[${idx}].querySelector('input[type=file]');
  try { i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); } catch(e){ return 'ERR '+e.message; }
  return 'ok';
})()`));

// 3) 等暂存行出现（最多 30s）
let staged = 0;
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  staged = Number(await ev(`Array.from(document.querySelectorAll('div[class*=a_u_row0]')).filter(function(r){ return String(r.className).indexOf(${JSON.stringify(ITEM)}) >= 0 && !/资源原始名称/.test(r.innerText||''); }).length`));
  console.log('   等待暂存行… ' + staged);
  if (staged > 0) break;
}
if (!staged) { console.log('❌ 上传没起来（暂存行没出现）'); ws.close(); process.exit(1); }

// 4) 立刻填字段 + 提交
console.log('4) 填字段并提交: ' + await ev(`(function(){
  var item = ${JSON.stringify(ITEM)};
  window.__ncA = []; var oa = window.alert; window.alert = function(m){ window.__ncA.push(String(m).slice(0,40)); };
  function setRow(name, want){
    var els = Array.from(document.querySelectorAll('select[name="' + name + '_' + item + '"]'));
    var ok = 0;
    els.forEach(function(s){ var o = Array.from(s.options).find(function(x){return (x.text||'').trim()===want;}) || Array.from(s.options).find(function(x){return (x.text||'').indexOf(want)>=0;}); if (o) { s.value = o.value; ok++; } });
    return ok + '/' + els.length;
  }
  var r = { subject: setRow('subject', ${JSON.stringify(SUBJECT)}), stage: setRow('stage', ${JSON.stringify(STAGE)}), type: setRow('type', ${JSON.stringify(TYPE)}) };
  var ts = Array.from(document.querySelectorAll('input[name="title_' + item + '"]'));
  ts.forEach(function(t){ t.value = ${JSON.stringify(TITLE)}; });
  r.titles = ts.length;
  try { window.uploadResource(item); r.call = 'called'; } catch(e){ r.call = 'ERR ' + e.message; }
  r.alerts = window.__ncA.slice(0,3);
  window.alert = oa;
  return JSON.stringify(r);
})()`));

for (let i = 0; i < 6; i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    count: (Array.from(document.querySelectorAll('.act_uploadArea')).map(function(a){ var m=(a.innerText||'').match(/已有(\\d+)份/); return m?m[1]:null; }).filter(Boolean)[0] || '?'),
    dlg: (Array.from(document.querySelectorAll('[class*=dialog],[class*=tip]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,46)})[0] || ''),
    staged: Array.from(document.querySelectorAll('div[class*=a_u_row0]')).filter(function(r){ return String(r.className).indexOf(${JSON.stringify(ITEM)}) >= 0 && !/资源原始名称/.test(r.innerText||''); }).length
  })`);
  console.log('   ' + (i + 1) + ') ' + st);
  if (/"count":"[1-9]/.test(st)) { console.log('✅ 完成：资源已提交'); break; }
}
ws.close();
