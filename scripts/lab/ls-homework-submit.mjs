/**
 * ls-homework-submit.mjs — 学习平台（learnspace）作业提交：附件 → 保存草稿 → 提交
 *   node scripts/ls-homework-submit.mjs --port 9226 --file "<笔记本绝对路径>" [--submit] [--wait 45]
 * 前提：页面已停在 homework_doing.action（用 webtrn-hw2.mjs 打开作业入口）
 * 说明：提交不可撤销 —— 默认只保存草稿；加 --submit 才点提交（会处理确认框）。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9226);
const FILE = String(A.file || '');
const DO_SUBMIT = !!A.submit;
const WAIT = Number(A.wait || 45);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ITEM = String(A.item || '');
const pages = list.filter(t => t.type === 'page' && String(t.url).includes('homework_doing'));
let p = ITEM ? pages.find(t => String(t.url).includes(ITEM)) : pages[0];
if (!p) p = list.find(t => t.type === 'page' && String(t.url).includes('homework_index'));
if (!p) { console.log('没找到作业页（homework_doing / homework_index）'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 60000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('页面: ' + String(p.url).slice(0, 90));
// 非 doing 页 → 点「做作业」
if (!String(p.url).includes('homework_doing')) {
  console.log('进入作业: ' + await ev(`(function(){
    var a = Array.from(document.querySelectorAll('a')).find(function(x){ return /做作业|继续做作业/.test((x.innerText||'').trim()); });
    if (!a) return 'no-button';
    setTimeout(function(){ try { a.click(); } catch(e){} }, 20);
    return 'clicked';
  })()`));
  await sleep(9000);
}

console.log('附件位: ' + await ev(`document.querySelectorAll('input[type=file]').length`));
// 已有附件先删掉（避免传成两份 / 文件名不合要求）
const had = await ev(`(function(){
  var t = document.body.innerText.replace(/\\s+/g,' ');
  var m = t.match(/附件：([^\\s（(]+)/);
  var del = Array.from(document.querySelectorAll('a,span,button')).find(function(x){ return /^\\s*删除\\s*$/.test((x.innerText||'').trim()); });
  return JSON.stringify({ existing: m ? m[1] : null, hasDelete: !!del });
})()`);
console.log('现有附件: ' + had);
const h = JSON.parse(had);
if (h.existing && h.hasDelete) {
  console.log('删除旧附件: ' + await ev(`(function(){
    var del = Array.from(document.querySelectorAll('a,span,button')).find(function(x){ return /^\\s*删除\\s*$/.test((x.innerText||'').trim()); });
    if (!del) return 'no-delete';
    del.click(); return 'deleted';
  })()`));
  await sleep(2500);
}
const obj = await send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')`, returnByValue: false });
if (!obj.result.objectId) { console.log('没有 file input'); ws.close(); process.exit(1); }
await send('DOM.setFileInputFiles', { files: [FILE], objectId: obj.result.objectId });
console.log('已塞附件: ' + FILE);
console.log('补发事件: ' + await ev(`(function(){
  var i = document.querySelector('input[type=file]');
  try { i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); } catch(e){ return 'ERR '+e.message; }
  return 'ok';
})()`));

// 等上传完成（页面上出现文件名/百分比消失）
for (let i = 0; i < 10; i++) {
  await sleep(3000);
  const st = await ev(`(function(){
    var t = document.body.innerText.replace(/\\s+/g,' ');
    return JSON.stringify({ file: (t.match(/[\\w\\u4e00-\\u9fa5-]+\\.docx/)||[])[0] || null, pct: (t.match(/\\d+%/)||[])[0] || null });
  })()`);
  console.log('  ' + (i + 1) + ') ' + st);
  if (/"file":"[^"]+\.docx"/.test(st) && !/"pct":"[1-9]/.test(st)) break;
}

console.log('保存草稿: ' + await ev(`(function(){
  var b = Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button')).find(function(x){ return /^\\s*保存草稿\\s*$/.test((x.value||x.innerText||'').trim()); });
  if (!b) return 'no-save-button';
  setTimeout(function(){ try { b.click(); } catch(e){} }, 20);
  return 'clicked';
})()`));
await sleep(8000);
console.log('草稿结果: ' + await ev(`(document.body.innerText.replace(/\\s+/g,' ').match(/(保存成功|草稿已保存|成功)/)||['?'])[0]`));

if (!DO_SUBMIT) { console.log('（未加 --submit，停在草稿）'); ws.close(); process.exit(0); }

console.log('提交: ' + await ev(`(function(){
  var cs = Array.from(document.querySelectorAll('a,input[type=button],input[type=submit],button'));
  var b = cs.find(function(x){ return /^\\s*提交\\s*$/.test((x.value||x.innerText||'').trim()); });
  if (!b) return 'no-submit-button';
  setTimeout(function(){ try { b.click(); } catch(e){} }, 20);
  return 'clicked';
})()`));
await sleep(2500);

// ★ 站内自绘确认框（div.small_submit_comfirm）不吃 el.click() —— 用 CDP 真实鼠标点它的中心
const rect = await ev(`(function(){
  var el = document.querySelector('div.small_submit_comfirm') || document.querySelector('div.small_submit');
  if (!el) return null;
  var r = el.getBoundingClientRect();
  if (!r.width) return null;
  return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), cls: String(el.className) });
})()`);
if (rect) {
  const { x, y } = JSON.parse(rect);
  console.log('确认真实鼠标点击: ' + rect);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  console.log('已点击确认');
} else {
  console.log('没看到确认框（可能无需确认）');
}

for (let i = 0; i < Math.ceil(WAIT / 5); i++) {
  await sleep(5000);
  const st = await ev(`JSON.stringify({
    txt: (document.body.innerText.replace(/\\s+/g,' ').match(/(标记为已完成|已提交|待批阅|提交成功|批阅中|未提交|待提交)/)||['?'])[0],
    dlg: (Array.from(document.querySelectorAll('[class*=dialog],[class*=tip],[class*=alert]')).filter(function(e){return e.offsetParent!==null}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').slice(0,40)})[0] || '')
  })`);
  console.log('  ' + (i + 1) + ') ' + st);
  if (/已提交|提交成功|批阅中|待批阅/.test(st)) { console.log('✅ 提交完成'); break; }
}
ws.close();
