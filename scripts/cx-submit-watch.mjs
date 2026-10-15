/**
 * cx-submit-watch.mjs — 学习通「章测试提交」看门狗
 *
 * 背景（2026-10-15 实测）：驱动会把题**答完**（checked 从 0 变正），但**不会点提交**，
 * 题目一直停在「待完成」。用户明确要求：**做完要提交**。
 *
 * 本看门狗独立于驱动，专门兜这一环：
 *   ① 每 30 秒扫所有嵌套 iframe，找章测试作答区（深度可达 3 层，路径形如 /0/0/0）
 *   ② 若 `pending=true` 且 `checked>0`（已填答案）→ 点「提交」→ 再点弹窗的「确定」
 *   ③ **`checked=0` 时绝不提交**（避免把空白卷交上去浪费机会）
 *   ④ 提交后复查 `pending` 是否转 false、是否出现「已完成/成绩」
 *
 * ★ 关键实现细节（都踩过）：
 *   - 按钮在**第 3 层嵌套 iframe** 里，坐标计算极易算错（祖先 iframe 可能 top=-1979）
 *     → **不要算坐标**，直接调 `el.click()`：超星是 **jQuery** 页面，DOM click 有效
 *   - 提交后会弹确认框（`确定`，class 含 bluebtn）→ 也要点，否则不算提交
 *
 * 用法：node scripts\cx-submit-watch.mjs [--interval=30]
 */
const P = 9227;
const argv = process.argv.slice(2);
const getArg = (k, d) => { const m = argv.find(a => a.startsWith('--' + k)); return m ? Number(m.split('=')[1] || m.split(' ')[1]) : d; };
const INTERVAL = getArg('interval', 30);

const { appendFileSync, mkdirSync } = await import('node:fs');
mkdirSync('runs', { recursive: true });
const log = (m) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + m;
  console.log(line);
  try { appendFileSync('runs/cx-submit-watch.log', line + '\n'); } catch (_) { }
};

async function withTab(fn) {
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${P}/json/list`, { signal: AbortSignal.timeout(8000) })).json(); }
  catch (e) { return null; }
  const p = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url))[0];
  if (!p) return null;
  let ws;
  try {
    ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(rej, 8000); });
  } catch (e) { return null; }
  let i = 0;
  const send = (m, pr = {}, ms = 15000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
  try { return await fn(ev); } finally { try { ws.close(); } catch (_) { } }
}

/** 扫出所有章测试作答区（跨嵌套 iframe） */
const SCAN = `(function(){
  function deep(root, d, path){
    var out = [];
    if (d > 4) return out;
    try {
      Array.from(root.querySelectorAll('iframe')).forEach(function(f, i){
        var dd = null; try { dd = f.contentDocument; } catch(e){}
        if (!dd) return;
        var t = (dd.body ? dd.body.innerText : '').replace(/\\s+/g,' ');
        var timu = dd.querySelectorAll('.TiMu').length;
        if (timu > 0 || /待完成|已完成/.test(t)) {
          out.push({
            path: path + '/' + i, timu: timu,
            radios: dd.querySelectorAll('input[type=radio],input[type=checkbox]').length,
            checked: dd.querySelectorAll('input:checked').length,
            pending: /待完成/.test(t),
            done: /已完成|本次成绩|提交成功/.test(t),
            hasSubmit: Array.from(dd.querySelectorAll('a,button,span,div')).some(function(e){ return /^(提交|交卷)$/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); }),
            head: t.slice(0, 46)
          });
        }
        out = out.concat(deep(dd, d + 1, path + '/' + i));
      });
    } catch(e){}
    return out;
  }
  return JSON.stringify(deep(document, 1, ''));
})()`;

/** 点某层里的按钮（按文本）；jQuery 页面直接 el.click() 最可靠 */
const clickBtn = (texts) => `(function(){
  var RE = new RegExp('^(' + ${JSON.stringify(texts)} + ')$');
  function walk(root, d){
    try {
      var fs = Array.from(root.querySelectorAll('iframe'));
      for (var i = 0; i < fs.length; i++) {
        var dd = null; try { dd = fs[i].contentDocument; } catch(e){}
        if (!dd) continue;
        var cands = Array.from(dd.querySelectorAll('a,button,span,div')).filter(function(e){
          var tx = (e.innerText||'').trim();
          return RE.test(tx) && (e.offsetWidth||e.offsetHeight);
        });
        if (cands.length) { var b = cands[0]; var info = { txt:(b.innerText||'').trim(), cls:String(b.className||'').slice(0,26) }; try { b.click(); } catch(e){} return JSON.stringify({ clicked: info, depth: d+1 }); }
        var r = walk(dd, d+1);
        if (r) return r;
      }
    } catch(e){}
    return null;
  }
  return walk(document, 0) || 'not-found';
})()`;

log('=== 学习通「章测试提交」看门狗启动（间隔 ' + INTERVAL + 's）===');
let submitted = 0;

for (;;) {
  let frames = null;
  try { const raw = await withTab(ev => ev(SCAN)); frames = raw ? JSON.parse(raw) : null; } catch (_) { }
  if (!frames) { log('页面不可达，等 ' + INTERVAL + 's'); await new Promise(r => setTimeout(r, INTERVAL * 1000)); continue; }
  if (!frames.length) { log('未发现作答区（不在章测试页）'); await new Promise(r => setTimeout(r, INTERVAL * 1000)); continue; }

  for (const f of frames) {
    const tag = f.path + ' 题' + f.timu + ' 勾' + f.checked + '/' + f.radios + (f.pending ? ' 待完成' : '') + (f.done ? ' 已完成' : '');
    const answerable = f.pending && f.timu > 0 && f.hasSubmit;
    if (answerable && f.checked > 0) {
      log(tag + ' → 已填答案且未提交 → 点「提交」');
      const r1 = await withTab(ev => ev(clickBtn('提交|交卷|提交答案')));
      log('   提交点击: ' + String(r1).slice(0, 90));
      await new Promise(r => setTimeout(r, 3000));
      const r2 = await withTab(ev => ev(clickBtn('确定|确认')));
      log('   确认点击: ' + String(r2).slice(0, 90));
      await new Promise(r => setTimeout(r, 5000));
      const after = await withTab(ev => ev(SCAN));
      log('   提交后: ' + String(after).slice(0, 200));
      submitted++;
      continue;
    }
    if (answerable && f.checked === 0) {
      log(tag + ' → 还没填答案（不提交空白卷，等驱动答题）');
      continue;
    }
    if (f.done) { log(tag + ' → 已完成'); continue; }
    log(tag + ' → 无动作');
  }
  await new Promise(r => setTimeout(r, INTERVAL * 1000));
}
