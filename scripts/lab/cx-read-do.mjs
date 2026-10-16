/**
 * cx-read-do.mjs — 临时接管页面对付「资料阅读/PPT 里内嵌的阅读理解题」
 *
 * 为什么要暂停驱动：驱动在不停切任务点，外部导航会被它覆盖 → 先置 ncCx:paused=1，
 * 做完再置回 0。（== 与驱动的"面板暂停"约定，驱动每轮会读它 ==）
 *
 * 用法：node scripts\cx-read-do.mjs --chapter=1236487731 [--dry]
 */
const P = 9227;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const CHAPTER = String(arg('chapter', '1236487731'));
const DRY = argv.includes('--dry');
const COURSE = '266554494', CLAZZ = '153244493';

const list = await (await fetch(`http://127.0.0.1:${P}/json/list`)).json();
const p = list.filter(t => t.type === 'page' && /chaoxing/.test(t.url) && !/tampermonkey/.test(t.url))[0];
if (!p) { console.log('无标签'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let i = 0;
const send = (m, pr = {}, ms = 25000) => new Promise(res => { const id = ++i; const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params: pr })); setTimeout(() => res({}), ms); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r && r.result && r.result.result ? r.result.result.value : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setPause = (v) => ev(`(function(){try{localStorage.setItem('ncCx:paused','${v}');return localStorage.getItem('ncCx:paused')}catch(e){return 'err'}})()`);

const FINDQ = `JSON.stringify((function(){
  function deep(root, d, path){
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
          return { path: path + '/' + i, stem: stem, opts: opts, radios: dd.querySelectorAll('input[type=radio],input[type=checkbox]').length, checked: dd.querySelectorAll('input:checked').length };
        }
        var r = deep(dd, d + 1, path + '/' + i);
        if (r) return r;
      }
    } catch(e){}
    return null;
  }
  return deep(document, 1, '');
})())`;

console.log('① 暂停驱动: paused=' + await setPause('1'));
await sleep(4000);
console.log('② 导航到 ' + CHAPTER + ': ' + await ev(`(function(){try{window.getTeacherAjax('${COURSE}','${CLAZZ}','${CHAPTER}');return 'ok'}catch(e){return 'ERR'}})()`));

let qd = null;
for (let k = 0; k < 8 && !qd; k++) {
  await sleep(5000);
  const raw = await ev(FINDQ);
  if (raw && raw !== 'null') { try { qd = JSON.parse(raw); } catch (_) { } }
  else console.log('   等题目加载… ' + ((k + 1) * 5) + 's');
}
if (!qd) { console.log('❌ 仍未找到题目'); console.log('③ 恢复驱动: ' + await setPause('0')); ws.close(); process.exit(1); }

console.log('③ 找到题目: ' + qd.stem.slice(0, 200));
qd.opts.forEach(o => console.log('   [' + o.k + '] ' + o.label.slice(0, 95) + '  <' + o.type + ' ' + o.name + '>'));

// 问答案
const ansRaw = await ev(`(async function(){
  try {
    var NC = window.NetClass;
    if (!NC || !NC.askDs) return JSON.stringify({ err: 'no-askDs' });
    var r = await NC.askDs({ type: '单选题', name: ${JSON.stringify(qd.stem.slice(0, 800))}, optionList: ${JSON.stringify(qd.opts.map(o => o.label))} });
    return JSON.stringify({ ok: true, answer: String(r).slice(0, 200) });
  } catch(e) { return JSON.stringify({ err: String(e).slice(0, 90) }); }
})()`);
console.log('④ DeepSeek: ' + String(ansRaw).slice(0, 240));
if (DRY) { console.log('--dry 结束'); console.log('⑤ 恢复驱动: ' + await setPause('0')); ws.close(); process.exit(0); }

// 解析答案 → 选项索引
let letters = [];
try {
  const a = JSON.parse(ansRaw).answer || '';
  const m = a.match(/[A-D]{1,4}/g);
  if (m) letters = (m[m.length - 1] || '').split('');
  if (!letters.length) { const ch = a.match(/[A-D]/); if (ch) letters = [ch[0]]; }
} catch (_) { }
console.log('⑤ 解析出答案选项: ' + JSON.stringify(letters) + '（共 ' + qd.opts.length + ' 项）');
if (!letters.length) { console.log('⚠ 答案解析不出，恢复驱动后退出'); console.log('   ' + await setPause('0')); ws.close(); process.exit(1); }

// 点选项（点 LI，不点 input —— input 是受控元素）
const CLICK_LI = `(function(){
  var want = ${JSON.stringify(letters)};
  function deep(root, d){
    if (d > 4) return 'no-frame';
    try {
      var fs = Array.from(root.querySelectorAll('iframe'));
      for (var i = 0; i < fs.length; i++) {
        var dd = null; try { dd = fs[i].contentDocument; } catch(e){}
        if (!dd) continue;
        var timu = dd.querySelectorAll('.TiMu');
        if (timu.length) {
          var lis = Array.from(timu[0].querySelectorAll('li'));
          var hit = [];
          want.forEach(function(L){
            var idx = L.charCodeAt(0) - 65;
            var li = lis[idx];
            if (li) { try { li.click(); } catch(e){} hit.push(L); }
          });
          return JSON.stringify({ clicked: hit, total: lis.length, checkedNow: dd.querySelectorAll('input:checked').length });
        }
        var r = deep(dd, d + 1);
        if (r && r !== 'no-frame') return r;
      }
    } catch(e){}
    return 'no-frame';
  }
  return deep(document, 1);
})()`;
console.log('⑥ 点选项: ' + String(await ev(CLICK_LI)).slice(0, 150));
await sleep(2500);

// 提交 + 确认
const CLICK_BTN = (labels) => `(function(){
  var RE = new RegExp('^(' + ${JSON.stringify(labels)} + ')$');
  function deep(root, d){
    if (d > 4) return null;
    try {
      var fs = Array.from(root.querySelectorAll('iframe'));
      for (var i = 0; i < fs.length; i++) {
        var dd = null; try { dd = fs[i].contentDocument; } catch(e){}
        if (!dd) continue;
        var c = Array.from(dd.querySelectorAll('a,button,span,div')).filter(function(e){ return RE.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); });
        if (c.length) { var b=c[0]; var t=(b.innerText||'').trim(); try{b.click();}catch(e){} return t; }
        var r = deep(dd, d + 1); if (r) return r;
      }
    } catch(e){}
    return null;
  }
  return deep(document, 1);
})()`;
console.log('⑦ 点提交: ' + String(await ev(CLICK_BTN('提交|交卷|提交答案'))).slice(0, 40));
await sleep(3500);
console.log('⑧ 点确认: ' + String(await ev(CLICK_BTN('确定|确认'))).slice(0, 40));
await sleep(5000);

const AFTER = `JSON.stringify((function(){
  function deep(root, d){
    if (d > 4) return null;
    try {
      var fs = Array.from(root.querySelectorAll('iframe'));
      for (var i = 0; i < fs.length; i++) {
        var dd = null; try { dd = fs[i].contentDocument; } catch(e){}
        if (!dd) continue;
        var t = (dd.body ? dd.body.innerText : '').replace(/\\s+/g,' ');
        if (dd.querySelectorAll('.TiMu').length || /待完成|已完成|本次成绩/.test(t)) {
          return { timu: dd.querySelectorAll('.TiMu').length, checked: dd.querySelectorAll('input:checked').length,
                   pending: /待完成/.test(t), done: /已完成|本次成绩|提交成功/.test(t), head: t.slice(0, 90) };
        }
        var r = deep(dd, d + 1); if (r) return r;
      }
    } catch(e){}
    return null;
  }
  return deep(document, 1);
})())`;
console.log('⑨ 提交后: ' + String(await ev(AFTER)).slice(0, 300));
console.log('⑩ 恢复驱动: ' + await setPause('0'));
ws.close();
