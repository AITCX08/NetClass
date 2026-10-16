/**
 * cx-answer.mjs — 学习通章测试答题器：抓题 → NetClass.askDs(DeepSeek) → 勾选 → 可选提交
 *   node scripts/cx-answer.mjs --port 9227 [--limit 3] [--submit] [--dry]
 * 结构（实测）：测验在 3 层 iframe 内；每题一组 input[type=checkbox|radio][name=answer*][value=A|B|C|D]；
 *              选项文本在 LI.before-after-checkbox / LABEL.fl.before；按钮「暂时保存 / 提交」。
 * 勾选用真实鼠标事件（站点处理器不吃 el.click()）。
 */
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const LIMIT = Number(A.limit || 3);
const DO_SUBMIT = !!A.submit;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const p = list.find(t => t.type === 'page' && /studentstudy/.test(t.url));
if (!p) { console.log('没有测验页'); process.exit(1); }
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, params = {}, ms = 40000) => new Promise((res, rej) => {
  const id = ++seq;
  const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); x.error ? rej(new Error(JSON.stringify(x.error).slice(0, 140))) : res(x.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params }));
  setTimeout(() => rej(new Error('timeout ' + m)), ms);
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 找承载测验的 document（逐层进 iframe，找含 answer* 输入的那个）
const DOC_PATH = `(function(){
  function hunt(w, path){
    try {
      var d = w.document;
      if (d.querySelector('input[name^=answer]')) return path;
      var fs = Array.from(d.querySelectorAll('iframe'));
      for (var i = 0; i < fs.length; i++) {
        try { var r = hunt(fs[i].contentWindow, path.concat([i])); if (r) return r; } catch (e) {}
      }
    } catch (e) {}
    return null;
  }
  return JSON.stringify(hunt(window, []));
})()`;
const pathStr = await ev(DOC_PATH);
console.log('测验所在的 iframe 路径: ' + pathStr);
const path = JSON.parse(pathStr || 'null');
if (!path) { console.log('未找到测验输入框'); ws.close(); process.exit(1); }
const G = `(function(){ var w = window; ${path.map(i => `w = w.document.querySelectorAll('iframe')[${i}].contentWindow;`).join(' ')} return w.document; })()`;
const inDoc = (expr) => `(function(){ var d = ${G}; return (${expr}); })()`;

// 1) 抓题
const qs = JSON.parse(await ev(inDoc(`JSON.stringify((function(){
  var groups = {};
  Array.from(d.querySelectorAll('input[name^=answer]')).forEach(function(i){
    (groups[i.name] = groups[i.name] || []).push(i);
  });
  var out = [];
  Object.keys(groups).forEach(function(name){
    var ins = groups[name];
    var q = { name: name, type: ins[0].type, options: [], stem: '' };
    // 选项文本：从同组 input 找最近的 li/label
    ins.forEach(function(i){
      var host = i.closest('li,label,div');
      var t = host ? (host.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      q.options.push({ name: i.value, data: t.replace(/^[A-D]\\s*/, '').slice(0, 60) });
    });
    // 题干：往上找题目容器
    var node = ins[0], stem = '';
    for (var k = 0; k < 8 && node; k++) {
      var txt = (node.innerText || '').replace(/\\s+/g, ' ').trim();
      if (/【(单选题|多选题|判断题)】/.test(txt) && txt.length < 600) { stem = txt; break; }
      node = node.parentElement;
    }
    q.stem = stem;
    q.kind = /【多选题】/.test(stem) ? 2 : (/【判断题】/.test(stem) ? 3 : 1);
    out.push(q);
  });
  return out;
})())`)));
console.log('抓到题目数: ' + qs.length);
// 过滤"伪题组"：保留 A-D 选择题 + 对/错判断题（页面上另有 name=answercheck* 但 value 是数字的隐藏组）
const OPT_OK = /^([A-D]|对|错|正确|错误|是|否|T|F|true|false)$/i;
const realQs = qs.filter(q => q.options.length && q.options.every(o => OPT_OK.test(String(o.name).trim())));
console.log('真题目数: ' + realQs.length + '（已剔除伪题组 ' + (qs.length - realQs.length) + '）');
for (const q of realQs.slice(0, LIMIT)) console.log('  [' + q.kind + '] ' + (q.stem || '(无题干)').slice(0, 70) + ' | 选项 ' + q.options.map(o => o.name).join(''));

// 2) 逐题问 DS 并勾选
let done = 0;
for (const q of realQs.slice(0, Math.max(LIMIT, 100))) {
  let ans = '';
  try {
    ans = await ev(`(function(){
      if (!(window.NetClass && NetClass.askDs)) return 'NO-MODULE';
      var r = NetClass.askDs({ type: ${q.kind}, name: ${JSON.stringify((q.stem || '').replace(/^[\\d\\s.]*/, '').slice(0, 300))}, optionList: ${JSON.stringify(q.options.map(o => ({ name: o.name, data: o.data })))} });
      return Promise.resolve(r).then(function(x){
        if (typeof x === 'string') return x;
        if (x && (x.answer || x.a || x.letter)) return String(x.answer || x.a || x.letter);
        return JSON.stringify(x).slice(0, 80);
      });
    })()`);
  } catch (e) { ans = 'ERR ' + e.message; }
  console.log('  Q[' + q.kind + '] DS 答: ' + String(ans).slice(0, 30));
  const raw = String(ans);
  // 防护：调用失败时会得到 "[object Object]" / "{...}"，里面含字母 B、C，绝不能被当成答案（实测踩过）
  const bad = /object Object|^\{|\bERR\b|NO-MODULE/.test(raw);
  const letters = bad ? [] : (raw.toUpperCase().match(/[A-D]/g) || []);
  if (bad) { console.log('    → 作答失败（' + raw.slice(0, 40) + '），跳过本题'); continue; }
  if (!letters.length) { console.log('    → 没拿到字母，跳过'); continue; }
  // 3) 勾选（真实鼠标）
  for (const L of letters) {
    // ★ checkbox 用原生 click() + 补 change/click 事件：
    //   坐标点击不可靠（选项 <LI> 宽 814px、中心是空白；真正可点的 <LABEL> 只有 29px 宽）。
    const r1 = await ev(`(function(){
      var w = window;
      ${path.map(i => `w = w.document.querySelectorAll('iframe')[${i}].contentWindow;`).join('\n      ')}
      var d = w.document;
      var el = Array.from(d.querySelectorAll('input[name="' + ${JSON.stringify(q.name)} + '"]')).find(function(i){ return i.value === '${L}'; });
      if (!el) return 'notfound';
      var before = el.checked;
      try { el.click(); } catch (e) {}
      if (!el.checked) { try { (el.closest('label') || el).click(); } catch (e) {} }
      if (!el.checked) {
        el.checked = true;
        ['input','change','click'].forEach(function(t){ try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
      }
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      return JSON.stringify({ before: before, after: el.checked });
    })()`);
    console.log('    ' + L + ' → ' + String(r1));
    if (String(r1).indexOf('"after":true') >= 0) done++;
  }
}
console.log('已勾选 ' + done + ' 个选项');

// 4) 提交
if (DO_SUBMIT) {
  const box = await ev(inDoc(`(function(){ var el = Array.from(d.querySelectorAll('a,button,input[type=button]')).find(function(b){ return /^\\s*提交\\s*$/.test((b.innerText||b.value||'').trim()); }); if(!el) return null; el.scrollIntoView({block:'center'}); var r=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}); })()`));
  if (box) {
    const b = JSON.parse(box);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(3000);
    // 确认框
    const ok = await ev(`(function(){ var el = Array.from(document.querySelectorAll('a,button,span,div')).find(function(e){ return /^(确定|确认)$/.test((e.innerText||'').trim()) && (e.offsetWidth||e.offsetHeight); }); if(!el) return null; var r=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}); })()`);
    if (ok) { const o = JSON.parse(ok); await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: o.x, y: o.y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: o.x, y: o.y, button: 'left', clickCount: 1 }); console.log('已点确认'); }
    await sleep(6000);
    console.log('提交后页面: ' + String(await ev(inDoc(`(d.body.innerText||'').replace(/\\s+/g,' ').slice(0,200)`))).slice(0, 200));
  } else console.log('没找到提交按钮');
}
ws.close();
