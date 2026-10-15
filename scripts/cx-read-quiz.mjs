/**
 * cx-read-quiz.mjs — 处理「资料阅读 / PPT」节点里内嵌的【阅读理解】题（答题+提交）
 *
 * 背景：用户点名"阅读资源漏了一个"。实测 1.1.3 资料阅读 的**第 3 层嵌套 iframe** 里有
 *   一道【阅读理解】题（12 选项、checked=0、pending=true）；驱动把它当"纯阅读"跳过 → 永远没人答。
 *   本脚本：定位 → 取题面/选项 → `NetClass.askDs` 问答案 → 点选项 → 点提交 → 点确认 → 复查。
 *
 * 用法：node scripts\cx-read-quiz.mjs [--chapter=1236487731] [--dry]
 */
const P = 9227;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const CHAPTER = String(arg('chapter', '1236487731'));
const DRY = argv.includes('--dry');
const COURSE = '266554494', CLAZZ = '153244493';

const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url))[0];
if (!p) { console.log('无 chaoxing 标签'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, pr = {}, ms = 20000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ① 进任务点（用站内 AJAX，绕开 enc）
console.log('导航到 chapterId=' + CHAPTER + ' …');
console.log('  → ' + await ev(`(function(){try{ if(window.getTeacherAjax){ window.getTeacherAjax('${COURSE}','${CLAZZ}','${CHAPTER}'); return 'ok'; } return 'no-func'; }catch(e){return 'ERR '+String(e).slice(0,50)}})()`));
await sleep(16000);

// ② 取题面 + 选项（深挖嵌套 iframe）
const Q = `JSON.stringify((function(){
  function deep(root, d, path){
    var out = null;
    if (d > 4) return null;
    try {
      var fs = Array.from(root.querySelectorAll('iframe'));
      for (var i = 0; i < fs.length; i++) {
        var dd = null; try { dd = fs[i].contentDocument; } catch(e){}
        if (!dd) continue;
        var timu = dd.querySelectorAll('.TiMu');
        if (timu.length) {
          var q = timu[0];
          var stem = (q.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 900);
          var opts = Array.from(q.querySelectorAll('li')).map(function(li, k){
            var lab = (li.innerText||'').replace(/\\s+/g,' ').trim();
            var inp = li.querySelector('input');
            return { k: k, label: lab.slice(0, 120), name: inp ? (inp.getAttribute('name')||'') : '', type: inp ? (inp.getAttribute('type')||'') : '' };
          });
          return { path: path + '/' + i, timu: timu.length, stem: stem, opts: opts, radios: dd.querySelectorAll('input[type=radio],input[type=checkbox]').length, checked: dd.querySelectorAll('input:checked').length };
        }
        var r = deep(dd, d + 1, path + '/' + i);
        if (r) return r;
      }
    } catch(e){}
    return null;
  }
  return deep(document, 1, '');
})())`;
const raw = await ev(Q);
if (!raw || raw === 'null') { console.log('❌ 没找到题目（可能还在加载或被驱动导航走了）'); ws.close(); process.exit(1); }
const qd = JSON.parse(raw);
console.log('题面: ' + qd.stem.slice(0, 220));
console.log('选项数: ' + qd.opts.length + '  已勾: ' + qd.checked + '  路径: ' + qd.path);
qd.opts.forEach(o => console.log('   [' + o.k + '] ' + o.label.slice(0, 90) + '  <' + o.type + ' ' + o.name + '>'));
if (DRY) { console.log('--dry：只探测不答题'); ws.close(); process.exit(0); }

// ③ 用模块自带的 DeepSeek 能力问答案
console.log('问 DeepSeek …');
const ask = `(async function(){
  try {
    var NC = window.NetClass;
    if (!NC || !NC.askDs) return JSON.stringify({ err: 'no-askDs' });
    var r = await NC.askDs({ type: '单选题', name: ${JSON.stringify(qd.stem.slice(0, 800))}, optionList: ${JSON.stringify(qd.opts.map(o => o.label))} });
    return JSON.stringify({ ok: true, answer: String(r).slice(0, 300) });
  } catch(e) { return JSON.stringify({ err: String(e).slice(0, 80) }); }
})()`;
const ans = await ev(ask);
console.log('DS 返回: ' + String(ans).slice(0, 260));
ws.close();
