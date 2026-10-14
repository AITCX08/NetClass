/**
 * webtrn-attach.mjs — 把本机文件塞进 webtrn 作业页的「上传我的资源」文件框（CDP DOM.setFileInputFiles）
 *
 *   node scripts/webtrn-attach.mjs --port 9226 --list                     # 列出上传区：标题 / 输入框序号 / 已上传数
 *   node scripts/webtrn-attach.mjs --port 9226 --index 0 --file <绝对路径>  # 塞文件（文件必须在**笔记本**上）
 *   node scripts/webtrn-attach.mjs --port 9226 --near 专业发展规划 --file <路径> [--save]
 *
 * 说明：webtrn 的上传区是 uploadify（隐藏 input[type=file]，id 随机），只能靠 CDP 直接 setFileInputFiles；
 * 浏览器在笔记本上跑，所以 --file 必须是**笔记本本地**的绝对路径（先用 scp 推上去）。
 * --save 会在上传完成后点「保存」（串行、只点一次，避免重复提交）。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9226);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && String(t.url).includes('activity_view'));
if (!page) { console.log('没找到研修活动页（activity_view）'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (method, params = {}, ms = 20000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', on); m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 200))) : res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => rej(new Error('timeout ' + method)), ms);
});
const evalJs = async (expression, byValue = true) => (await send('Runtime.evaluate', { expression, returnByValue: byValue, awaitPromise: true })).result.value;

const LIST_EXPR = `(function(){
  var areas = Array.from(document.querySelectorAll('.act_uploadArea'));
  return JSON.stringify(areas.map(function(a, i){
    var box = a.closest('div[class]');
    for (var k=0;k<4 && box;k++){ if(/act_|item|box|wrap|panel/i.test(box.className||'') && (box.innerText||'').length>40) break; box = box.parentElement; }
    var t = (box ? box.innerText : '').replace(/\\s+/g,' ').trim();
    var title = (box ? (box.querySelector('h1,h2,h3,h4,.title,[class*=title]')||{}).innerText : '') || '';
    var done = (t.match(/已有(\\d+)份资源上传成功/) || [,'?'])[1];
    return { area: i, title: String(title).replace(/\\s+/g,' ').slice(0,30), uploaded: done, text: t.slice(0, 70) };
  }));
})()`;

if (A.list || !A.file) {
  console.log('== 上传区 ==');
  const rows = JSON.parse(await evalJs(LIST_EXPR));
  for (const r of rows) console.log(`  [${r.area}] title="${r.title}" 已上传=${r.uploaded}\n        ${r.text}`);
  if (!A.file) console.log('\n用法：--index <序号> --file <笔记本上的绝对路径> [--save]');
  ws.close();
  process.exit(0);
}

const idxExpr = A.near
  ? `(function(){
      var areas = Array.from(document.querySelectorAll('.act_uploadArea'));
      for (var i=0;i<areas.length;i++){
        var box = areas[i].closest('div[class]');
        for (var k=0;k<4 && box;k++){ if(((box.innerText)||'').indexOf(${JSON.stringify(String(A.near))}) >= 0) return String(i); box = box.parentElement; }
      }
      return '-1';
    })()`
  : String(Number(A.index || 0));
const idx = await evalJs(idxExpr);
if (Number(idx) < 0) { console.log('没找到匹配 "' + A.near + '" 的上传区'); ws.close(); process.exit(1); }
console.log('目标上传区序号: ' + idx);

// 取隐藏 file input 的 remote object，再交给 DOM.setFileInputFiles
const obj = await send('Runtime.evaluate', {
  expression: `document.querySelectorAll('.act_uploadArea')[${idx}].querySelector('input[type=file]')`,
  returnByValue: false
});
const objectId = obj.result.objectId;
if (!objectId) { console.log('该上传区没有 file input'); ws.close(); process.exit(1); }
await send('DOM.setFileInputFiles', { files: [String(A.file)], objectId });
console.log('已塞入文件: ' + A.file);

for (let i = 1; i <= 10; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const st = JSON.parse(await evalJs(LIST_EXPR))[Number(idx)];
  console.log(`  轮询 ${i}: 已上传=${st ? st.uploaded : '?'} | ${st ? st.text.slice(0, 60) : ''}`);
  if (st && st.uploaded && st.uploaded !== '0') break;
}

if (A.save) {
  const clicked = await evalJs(`(function(){
    var areas = Array.from(document.querySelectorAll('.act_uploadArea'));
    var a = areas[${idx}]; if (!a) return 'no-area';
    var box = a.closest('div[class]');
    for (var k=0;k<4 && box;k++){ if(/act_|item|box|wrap|panel/i.test(box.className||'')) break; box = box.parentElement; }
    var btn = Array.from((box||document).querySelectorAll('a,input[type=button],button')).find(function(b){return /保存/.test(b.value||b.innerText||'')});
    if (!btn) return 'no-save-button';
    btn.click(); return 'clicked-save';
  })()`);
  console.log('保存: ' + clicked);
}
ws.close();
