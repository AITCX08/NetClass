/**
 * cx-answer-quiz.mjs — 学习通章测试：解密题面 → DeepSeek 作答 → 勾选 → 提交
 *   node scripts/cx-answer-quiz.mjs --port 9227 [--submit] [--limit 20] [--dry]
 *
 * 链路（全部实测打通）：
 *   ① 密文字体：页面内嵌 base64 TTF → cx-ttf.js 取 glyph 轮廓（glyphId 有效即有轮廓 = 密文字符）
 *   ② 字形解码：轮廓→折线→even-odd 填充→36×36 位图→与 GB2312 字形指纹库比对（scripts/cx-inject-lib.mjs 注入）
 *   ③ 作答：NetClass.askDs({type,name,optionList})（DeepSeek，key 已配）
 *   ④ 勾选：原生 el.click() + 补 change/click（选项 <li> 很宽，坐标点击不可靠）
 *   ⑤ 提交：真实鼠标点「提交」→ 处理二次确认框
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const SUBMIT = A.submit === true || A.submit === 'true';
const DRY = !!A.dry;
const LIMIT = Number(A.limit || 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let c = null;
async function conn() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find(t => t.type === 'page' && /chaoxing/.test(t.url));
  if (!p) return null;
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (m, params = {}, ms = 90000) => new Promise(res => {
    const id = ++seq;
    const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method: m, params }));
    setTimeout(() => res({ timeout: true }), ms);
  });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.timeout) return { __timeout: true };
    if (r.result && r.result.exceptionDetails) return { __err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 260) };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  return { ws, send, ev };
}
const file = p => readFileSync(join(REPO, p), 'utf8');

c = await conn();
if (!c) { console.log('没有 chaoxing 页面'); process.exit(1); }

// ★ 提交会触发原生 alert/confirm（如"请刷新页面后重试"），JS 线程被阻塞后所有 Runtime.evaluate 都会超时。
//   必须挂 Page.javascriptDialogOpening 自动关掉，否则整个流程卡死。
let dialogLog = [];
try {
  await c.send('Page.enable');
  c.ws.addEventListener('message', async ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogLog.push(m.params.type + ':' + String(m.params.message).slice(0, 120));
      console.log('  ⚠ 原生弹窗(' + m.params.type + '): ' + JSON.stringify(m.params.message).slice(0, 140) + ' → 自动关闭');
      await c.send('Page.handleJavaScriptDialog', { accept: true });
    }
  });
} catch (e) { }

/** 确保解密链路就绪（TTF 解析 + 字体安装 + 指纹库 + 解码器） */
async function ensureDecoder() {
  let r = await c.ev('typeof window.__cxTT');
  if (r !== 'object') await c.ev(file('runs/cx/cx-ttf.js'));
  r = await c.ev('typeof window.__cxFont');
  if (r !== 'object') await c.ev(file('runs/cx/cx-font.js'));
  const inst = await c.ev('(async function(){ var F=window.__cxFont; if(!F.installed){ await F.install(); } return F.installed; })()');
  if (!inst) return { err: 'font-install-failed' };
  // ★ 必须显式 T.load(base64)：c2g/locaAt/glyf 都是 load() 之后才挂上去的
  const ld = await c.ev('(function(){ var F=window.__cxFont, T=window.__cxTT; if(!F.b64) return "no-b64"; if(T.c2g && T.c2g.size) return "already:" + T.c2g.size; try { var info = T.load(F.b64); return "loaded:" + info.cmapEntries; } catch(e){ return "err:" + e.message; } })()');
  if (String(ld).indexOf('loaded') < 0 && String(ld).indexOf('already') < 0) return { err: 'ttf-load: ' + ld };
  r = await c.ev('window.__cxGLibV || 0');
  if (r !== 36) {
    console.log('  注入字形指纹库…');
    const out = spawnSync(process.execPath, [join(HERE, 'cx-inject-lib.mjs'), '--port', String(PORT), '--lib', 'runs/cx/glyph-lib36.json'], { cwd: REPO, encoding: 'utf8' });
    if (out.status !== 0) return { err: 'lib-inject-failed: ' + (out.stderr || '').slice(0, 160) };
  }
  r = await c.ev('typeof window.__cxDecode');
  if (r !== 'object') await c.ev(file('runs/cx/cx-decode.js'));
  const t = await c.ev('JSON.stringify(window.__cxDecode.text("恣咰咧"))');
  return { ok: true, probe: t };
}

// ---------------------------------------------------------------- 抓题
const GRAB = `(function(){
  function findDoc(sel){ var hit=null; (function walk(r,path,depth){ try { if(r.querySelector&&r.querySelector(sel)){ hit={doc:r,path:path}; return; } if(depth>6) return;
    Array.from(r.querySelectorAll('iframe')).forEach(function(f,i){ var d=null; try{d=f.contentDocument}catch(e){} if(d&&!hit) walk(d,path.concat([i]),depth+1); }); }catch(e){} })(document,[],0); return hit; }
  var d = findDoc('.TiMu');
  if (!d) return JSON.stringify({ err: 'no-TiMu' });
  var doc = d.doc;
  var statusEl = doc.querySelector('.testTit_status, .testTit, .TiMuStatus');
  var status = statusEl ? (String(statusEl.className) + ' | ' + (statusEl.innerText||'').replace(/\\s+/g,' ').trim()).slice(0, 160) : null;
  var bodyAll = (doc.body.innerText || '').replace(/\\s+/g,' ');
  var finished = /已完成|已提交|已交卷|满分|得分/.test(bodyAll);
  var roots = Array.from(doc.querySelectorAll('.clearfix .TiMu, .TiMu'));
  var out = [];
  roots.forEach(function(root, idx){
    var qEl = root.querySelector('.Zy_TItle .clearfix') || root.querySelector('.Zy_TItle') || root.querySelector('.mark_name');
    var stem = qEl ? (qEl.innerText || '').replace(/\\s+/g,' ').trim() : '';
    var typeEl = root.querySelector('input[name^=answertype], input[name^=type]');
    var ul = root.querySelector('ul');
    var lis = ul ? Array.from(ul.querySelectorAll('li')) : [];
    var opts = [];
    lis.forEach(function(li, i){
      var txtEl = li.querySelector('.after') || li;
      var txt = (txtEl.innerText || '').replace(/\\s+/g,' ').trim();
      var input = li.querySelector('input[type=radio], input[type=checkbox]');
      var letter = input && input.value ? String(input.value).trim() : '';
      if (!letter) { var m = txt.match(/^([A-D])/); letter = m ? m[1] : String.fromCharCode(65+i); }
      txt = txt.replace(/^[A-D][.、\\s]+/, '').trim();
      // ★★ 文本为空的兜底（2026-10-15 主线补）：**判断题的「对/错」是 <b class="ri"> / <b class="wr"> 图标，
      //    取不到任何 innerText → 旧代码 if (txt) 会把两个选项都丢掉 → opts 为空 → askDs 报"题目没有可读选项"。
      //    （注意：本段在模板字符串里，注释中禁用反引号 —— 这个坑已踩三次）
      //    这里从 input.value 反推：true→「对」(归一到 A)、false→「错」(归一到 B)，保证下游按字母点击的逻辑可用。
      if (!txt) {
        var v = String((input && input.value) || '').toLowerCase();
        if (v === 'true') { txt = '对'; letter = 'A'; }
        else if (v === 'false') { txt = '错'; letter = 'B'; }
        else if (v) { txt = v; }
        else { txt = '选项' + (i + 1); }
      }
      opts.push({ letter: letter.slice(0,4), text: txt.slice(0,200) });
    });
    var name = lis[0] && lis[0].querySelector('input') ? lis[0].querySelector('input').name : ('q'+idx);
    out.push({ idx: idx, name: name, stem: stem, options: opts,
               kind: /多选/.test(stem) ? 'multiple' : (/判断/.test(stem) ? 'judge' : (lis[0] && lis[0].querySelector('input[type=checkbox]') ? 'multiple' : 'single')) });
  });
  var btn = null;
  Array.from(doc.querySelectorAll('a,button,input[type=button],input[type=submit]')).forEach(function(b){
    if (btn) return; var t = ((b.innerText||b.value||'')).trim();
    if (/^提交$/.test(t) || /^交卷$/.test(t)) { var r = b.getBoundingClientRect(); btn = { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; }
  });
  var bodyText = (doc.body.innerText||'').replace(/\\s+/g,' ').slice(0, 300);
  return JSON.stringify({ path: d.path, status: status, finished: finished, count: out.length, questions: out, submitBtn: btn, bodyText: bodyText });
})()`;

// ★★ 解密准备必须在【提取之前】（2026-10-15 主线修）——
//   学习通按页内嵌密文字体子集，且提取时会直接调用 __cxDecode.text() 解码；
//   如果先提取再准备，提取用的还是上一页的字表 → 题面全是乱码（实测就是踩了这个顺序坑）。
const dec = await ensureDecoder();
if (dec.err) { console.log('解密链路未就绪: ' + dec.err); process.exit(1); }
console.log('解密链路就绪');
const fontReload = await reloadCipherFont();
console.log('   密文字体重载: ' + fontReload);

const st = await c.ev(GRAB);
if (!st || typeof st !== 'string') { console.log('抓题失败（返回异常）: ' + JSON.stringify(st).slice(0, 300)); process.exit(1); }
const data = JSON.parse(st);
if (data.err) { console.log('当前页不是测验页: ' + data.err); process.exit(1); }
console.log('测验页: 题目数=' + data.count + '  状态=' + data.status + '  提交按钮=' + JSON.stringify(data.submitBtn));


/** ★★ 换页重载密文字体（2026-10-15 主线补）——这是"题面乱码"问题的真正修法。
 *  学习通**按页内嵌字体子集**：每换一页，font-cxsecret 的 base64 TTF 就换一份。
 *  解密器的 c2g（字符码→字形 id）是从**当前这份字体**建的；不重载就会拿旧表去比对，
 *  结果是"解不出来"（实测：在测验页上 c2g.size 仍停在上一页的 109，解码原样返回）。
 *  做法：从（含 iframe 的）页面里捞出 font-cxsecret 的 base64 → __cxTT.load() → 清解码缓存。 */
async function reloadCipherFont() {
  const b64 = await c.ev(`(function(){
    var hit = null;
    (function walk(r, d){
      if (hit || d > 4) return;
      try {
        Array.from(r.querySelectorAll('style')).forEach(function(s){
          if (hit) return;
          var t = s.textContent || '';
          var m = t.match(/font-cxsecret[^}]*?base64,([A-Za-z0-9+/=]+)/);
          if (m && m[1] && m[1].length > 1000) hit = m[1];
        });
        Array.from(r.querySelectorAll('iframe')).forEach(function(f){
          if (hit) return;
          var dd = null; try { dd = f.contentDocument } catch (e) { }
          if (dd) walk(dd, d + 1);
        });
      } catch (e) { }
    })(document, 0);
    return hit;
  })()`);
  if (!b64) return 'no-font-found';
  const r = await c.ev('(async function(){ try { await window.__cxTT.load("' + b64 + '"); if (window.__cxDecode) window.__cxDecode._cache = {}; return "loaded c2g=" + (window.__cxTT.c2g && window.__cxTT.c2g.size || "?"); } catch(e) { return "ERR " + String(e).slice(0,50); } })()');
  return r;
}

// ---------------------------------------------------------------- 解码题面
let decodedAll = [];
for (const q of data.questions) {
  const payload = JSON.stringify({ stem: q.stem, options: q.options.map(o => o.text) });
  const r = await c.ev(`(function(){
    var p = ${payload};
    if (!window.__cxDecode) return JSON.stringify({ err: 'no-decoder' });
    var d1 = window.__cxDecode.text(p.stem);
    var opts = p.options.map(function(t){ return window.__cxDecode.text(t).text; });
    return JSON.stringify({ stem: d1.text, options: opts });
  })()`);
  let parsed = null;
  if (r && typeof r === 'string') { try { parsed = JSON.parse(r); } catch (e) { parsed = null; } }
  if (!parsed) { console.log('  解码失败 #' + q.idx + ': ' + JSON.stringify(r).slice(0, 200)); decodedAll.push(null); continue; }
  if (parsed.err) { console.log('  解码器异常 #' + q.idx + ': ' + parsed.err); decodedAll.push(null); continue; }
  decodedAll.push(parsed);
  console.log('\n[' + (q.idx + 1) + '][' + q.kind + '] ' + parsed.stem.slice(0, 120));
  parsed.options.forEach((t, i) => console.log('     ' + (q.options[i] ? q.options[i].letter : String.fromCharCode(65 + i)) + ' ' + t.slice(0, 90)));
}

if (DRY) { console.log('\n--dry：不解题、不勾选，直接退出'); c.ws.close(); process.exit(0); }

// ---------------------------------------------------------------- 问 DeepSeek + 勾选
const OPT_OK = /^[A-D]$/;
let picked = 0, answered = 0;
for (let i = 0; i < data.questions.length && i < LIMIT; i++) {
  const q = data.questions[i], dq = decodedAll[i];
  if (!dq) continue;
  const optionList = q.options.map((o, k) => ({ name: o.letter, data: (dq.options[k] || o.text).slice(0, 120) }));
  let ans = await c.ev(`(function(){
    if (!(window.NetClass && NetClass.askDs)) return 'NO-MODULE';
    var r = NetClass.askDs({ type: ${q.kind === 'multiple' ? 2 : (q.kind === 'judge' ? 3 : 1)},
                             name: ${JSON.stringify(dq.stem.slice(0, 300))},
                             optionList: ${JSON.stringify(optionList)} });
    return Promise.resolve(r).then(function(x){
      if (typeof x === 'string') return x;
      if (x && (x.answer || x.a || x.letters)) return String(x.answer || x.a || x.letters);
      return JSON.stringify(x).slice(0, 120);
    });
  })()`);
  const raw = String(ans);
  if (/NO-MODULE|object Object|^\{|ERR/.test(raw)) { console.log('  #' + (i + 1) + ' 作答失败: ' + raw.slice(0, 80)); continue; }
  let letters = (raw.toUpperCase().match(/[A-D]/g) || []);
  // 判断题：对/错 映射到 A/B
  if (q.kind === 'judge') {
    if (/对|正确|是|TRUE/.test(raw)) letters = ['A'];
    else if (/错|错误|否|FALSE/.test(raw)) letters = ['B'];
    else if (!letters.length) letters = ['A'];
    letters = letters.slice(0, 1);
  } else if (q.kind === 'single') {
    letters = letters.slice(0, 1);
  }
  if (!letters.length) { console.log('  #' + (i + 1) + ' 没拿到字母: ' + raw.slice(0, 60)); continue; }
  answered++;
  console.log('  #' + (i + 1) + ' 解析: kind=' + q.kind + ' name=' + q.name + ' raw=[' + raw.slice(0, 60).replace(/\n/g, ' ') + '] → letters=' + letters.join(''));
  // ★ 学习通真正的"勾选"是 LI 上的 onclick="addcheck(qid)"，同时把选择写进隐藏域 answer<qid>。
  //   checkbox 本身是 tabindex=-1 的受控元素，直接点 input 不改状态（实测 "notfound"/无效）。
  const qid = (String(q.name).match(/(\d{6,})/) || [])[1] || q.name;
  const r1 = await c.ev(`(function(){
    var qid = ${JSON.stringify(qid)};
    var doc = null;
    (function walk(r, depth){ try { if (r.querySelector('.TiMu')) { doc = r; return; } if (depth>6) return;
      Array.from(r.querySelectorAll('iframe')).forEach(function(f){ var d=null; try{d=f.contentDocument}catch(e){} if(d && !doc) walk(d, depth+1); }); } catch(e){} })(document, 0);
    if (!doc) return 'no-doc';
    var roots = Array.from(doc.querySelectorAll('.TiMu'));
    // 按 qid 找题目：优先匹配 answer<qid> 隐藏域
    var root = null;
    roots.forEach(function(r){ if (!root && r.querySelector('input[name="answer' + qid + '"]')) root = r; });
    if (!root) root = roots[0];
    // ★ 选项输入是 radio（单选/判断）或 checkbox（多选），**不是** input[name^=answercheck 一定带 checked**；
    //   判断题的 value 是 true/false，所以按"选项序号"定位（A=0,B=1,...）
    var ul = root.querySelector('ul') || root;
    var lis = Array.from(ul.querySelectorAll('li'));
    var want = ${JSON.stringify(letters)};
    var wantIdx = want.map(function(L){ return 'ABCD'.indexOf(L); });
    var res = [];
    // 单选/判断：先把其它选项清掉
    if (${JSON.stringify(q.kind)} !== 'multiple') {
      lis.forEach(function(li, k){
        if (wantIdx.indexOf(k) >= 0) return;
        var inp = li.querySelector('input[type=radio], input[type=checkbox]');
        if (inp && (inp.checked || li.className.indexOf('check_answer') >= 0)) { try { li.click(); } catch(e){} }
      });
    }
    wantIdx.forEach(function(k){
      var li = lis[k];
      if (!li) { res.push({ k: k, err: 'no-li' }); return; }
      var inp = li.querySelector('input[type=radio], input[type=checkbox]');
      var a = li.querySelector('a');                 // ★ 选项里的 <a>（实测：点它才有效）
      var lab = li.querySelector('label');
      var already = inp ? inp.checked : li.className.indexOf('check_answer') >= 0;
      // ★★ 点击顺序（2026-10-15 实测校准）：**先点 input**，再点 a，最后才点 li。
      //   旧代码先 li.click() —— 对学习通真实的答题页**无效**（选项 li 上没有 click 处理，
      //   真正接住事件的是里面的 label/input 和 a 元素）。这就是"答案没被记录 → 全 0 分"的根因。
      //   ⚠️ 本段在模板字面量里，注释中禁用反引号（这个坑我自己踩过三次）
      if (inp && !inp.checked) { try { inp.click(); } catch (e) { } }          // ① 首选
      if (inp && !inp.checked && lab) { try { lab.click(); } catch (e) { } }   // ② label
      if (inp && !inp.checked && a) { try { a.click(); } catch (e) { } }       // ③ 选项里的 a
      if (!already) { try { li.click(); } catch (e) { } }                      // ④ 兜底
      if (inp && !inp.checked) { inp.checked = true; ['input', 'change', 'click'].forEach(function (t) { try { inp.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) { } }); }
      if (typeof doc.defaultView.addcheck === 'function') { try { doc.defaultView.addcheck(Number(qid)); } catch (e) { } }
      var checkedNow = inp ? inp.checked : li.className.indexOf('check_answer') >= 0;
      res.push({ k: k, checked: checkedNow, val: inp ? inp.value : null });
    });
    // addcheck 里有 200ms 延时（setTimeout）→ 这里同步读可能还是空，外面再读一次
    var hidden = doc.querySelector('input[name="answer' + qid + '"]');
    return JSON.stringify({ picked: res, hidden: hidden ? hidden.value : null });
  })()`);
  console.log('     勾选 → ' + String(r1).slice(0, 260));
  const hiddenVal = await c.ev(`(function(){ var d=null; (function walk(r,dep){ try { if(r.querySelector('.TiMu')){d=r;return;} if(dep>6) return; Array.from(r.querySelectorAll('iframe')).forEach(function(f){ var dd=null; try{dd=f.contentDocument}catch(e){} if(dd&&!d) walk(dd,dep+1); }); }catch(e){} })(document,0); if(!d) return null; var h=d.querySelector('input[name="answer${qid}"]'); return h? h.value : null; })()`);
  console.log('     隐藏域 answer' + qid + ' = ' + JSON.stringify(hiddenVal));
  if (String(r1).indexOf('"checked":true') >= 0) picked++;
  await sleep(500);
}
console.log('\n已作答 ' + answered + ' 题，勾选 ' + picked + ' 个选项');

// ---------------------------------------------------------------- 提交前校验（照 OCS 的 uploadable 思路）
// ★★ 用户明确要求：**必须每题都正确选中才能提交**。
//   OCS 的判据（reference/ocsjs/packages/scripts/src/projects/cx.ts:937）：
//     选项所在容器里存在 [class*="check_answer"] 才算"这一题选好了"。
//   旧代码只看 picked > 0（**点中一个选项就提交**）→ 大量题空白提交 → 全 0 分（实测 1.2.4 就是）。
//   注意：本段在模板字面量里 —— 注释中禁用反引号。
const verifyRaw = await c.ev(`(function(){
  function deep(r,d){ if(d>4) return null; try{ if(r.querySelector&&r.querySelector('.TiMu')) return r; var fs=Array.from(r.querySelectorAll('iframe')); for(var i=0;i<fs.length;i++){ var dd=null; try{dd=fs[i].contentDocument}catch(e){} if(dd){var h=deep(dd,d+1); if(h) return h;} } }catch(e){} return null; }
  var f = deep(document,0); if(!f) return JSON.stringify({err:'no-frame'});
  var qs = Array.from(f.querySelectorAll('.TiMu'));
  var done = 0, blank = [];
  qs.forEach(function(q, qi){
    var ok = !!q.querySelector('[class*="check_answer"]');                      // OCS 判据
    if (!ok && q.querySelector('input[type=radio]:checked, input[type=checkbox]:checked')) ok = true;   // 兜底判据
    if (ok) done++; else blank.push(qi + 1);
  });
  return JSON.stringify({ total: qs.length, done: done, blank: blank.slice(0, 30) });
})()`);
let vv = {}; try { vv = JSON.parse(String(verifyRaw)); } catch (_) { }
const vTotal = Number(vv.total) || 0, vDone = Number(vv.done) || 0;
const finishRate = vTotal ? vDone / vTotal : 0;
const uploadable = vTotal > 0 && vDone === vTotal;
console.log('   提交前校验: 完成率 ' + (finishRate * 100).toFixed(1) + '%  (' + vDone + '/' + vTotal + ')  →  '
  + (uploadable ? '✅ 可提交' : '⚠ 未答完，改为仅保存'));
if (!uploadable && vv.blank && vv.blank.length) console.log('   空白题号: ' + vv.blank.join(', '));

// 配置：--save-only（只保存不提交） / --need-all=false（允许未答完也提交）
const SAVE_ONLY = String(A['save-only']) === 'true';
const NEED_ALL = A['need-all'] === undefined ? true : String(A['need-all']) === 'true';

// 未答完（或要求只保存）→ 调站点自己的 noSubmit() 暂存（OCS 同款做法：先屏蔽 alert 免得阻塞 JS 线程）
if (SUBMIT && (!uploadable || SAVE_ONLY)) {
  const saved = await c.ev(`(function(){
    try {
      var w = null;
      (function walk(r,d){ try{ if(r.querySelector && r.querySelector('.TiMu')){ w = r.defaultView; return; } if(d>6) return; Array.from(r.querySelectorAll('iframe')).forEach(function(f){ var dd=null; try{dd=f.contentDocument}catch(e){} if(dd&&!w) walk(dd,d+1); }); }catch(e){} })(document,0);
      if (!w) return 'no-window';
      try { w.alert = function(){}; } catch(e) {}
      if (typeof w.noSubmit === 'function') { w.noSubmit(); return 'noSubmit-called'; }
      return 'no-noSubmit-fn';
    } catch(e) { return 'ERR ' + String(e).slice(0,60); }
  })()`);
  console.log('   ' + (SAVE_ONLY ? '(配置:仅保存)' : '(未答完)') + ' → 暂存: ' + saved);
}

// ---------------------------------------------------------------- 提交
if (SUBMIT && data.submitBtn && (uploadable || !NEED_ALL) && !SAVE_ONLY) {
  const click = async (x, y) => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(80);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  // ★ 顶层坐标 = 逐层累加每层 iframe 的 getBoundingClientRect().left/top（不能再叠加内层 getBoundingClientRect，
  //   那是**相对最内层视口**的；实测直接叠加会得到 2629 这种离谱值 → 鼠标点到视口外）。
  const btn = await c.ev(`(function(){
    function walk(r, path, sel){ try { var e = r.querySelector(sel); if (e) return { el: e, path: path };
      var fs = Array.from(r.querySelectorAll('iframe'));
      for (var i=0;i<fs.length;i++){ var d=null; try{d=fs[i].contentDocument}catch(x){} if (d){ var q=walk(d, path.concat([i]), sel); if (q) return q; } } } catch(x){}
      return null; }
    var res = walk(document, [], '.TiMu');
    if (!res) return null;
    var doc = res.el.ownerDocument;
    var b = null;
    Array.from(doc.querySelectorAll('a,button,input[type=button],input[type=submit]')).forEach(function(x){ if(b) return; var t=((x.innerText||x.value||'')).trim(); if(/^提交$/.test(t)||/^交卷$/.test(t)) b=x; });
    if (!b) return null;
    var res2 = walk(document, [], '.TiMu');
    if (!res2) return null;
    var fs2 = res2.path, innerDoc = res2.el.ownerDocument;
    // 逐层累加绝对偏移
    var w2 = window, offX = 0, offY = 0;
    for (var k2=0;k2<fs2.length;k2++){ var ff = w2.document.querySelectorAll('iframe')[fs2[k2]]; var rr = ff.getBoundingClientRect(); offX += rr.left; offY += rr.top; w2 = ff.contentWindow; }
    // 1) 先让最内层的 iframe 把自己内部滚到合适位置（内层 iframe 自己内部可滚）
    (function(){
      var w = window;
      for (var k=0;k<fs2.length-1;k++){ var f = w.document.querySelectorAll('iframe')[fs2[k]]; w = f.contentWindow; }
      try { var ir = b.getBoundingClientRect(); var need = ir.top + ir.height/2 - w.innerHeight/2; if (need > w.innerHeight/4) w.scrollBy(0, Math.min(need, w.innerHeight*0.9)); } catch(e){}
    })();
    // 2) 再滚顶层页面（把最外层 iframe 的对应位置拉到视口中间）
    function absOf(){
      var w = window, x = 0, y = 0;
      for (var k=0;k<fs2.length;k++){ var f = w.document.querySelectorAll('iframe')[fs2[k]]; var r = f.getBoundingClientRect(); x += r.left; y += r.top; w = f.contentWindow; }
      var ir = b.getBoundingClientRect();
      return { x: Math.round(x + ir.left + ir.width/2), y: Math.round(y + ir.top + ir.height/2) };
    }
    var a1 = absOf();
    var delta = a1.y - Math.round(innerHeight/2);
    if (Math.abs(delta) > innerHeight/4) { try { window.scrollBy(0, Math.max(-innerHeight*3, Math.min(innerHeight*3, delta))); } catch(e){} }
    var a2 = absOf();
    var hit = null; try { var he = document.elementFromPoint(a2.x, a2.y); hit = he ? (he.tagName + '.' + String(he.className||'').slice(0,24)) : null; } catch(e){}
    return JSON.stringify({ x: a2.x, y: a2.y, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), inVp: (a2.x>=0&&a2.y>=0&&a2.x<=innerWidth&&a2.y<=innerHeight), hit: hit, path: fs2.join('.') });
  })()`);
  const b2 = btn && btn.__err ? null : (btn ? JSON.parse(btn) : null);
  if (!b2) { console.log('找不到提交按钮'); }
  else {
    console.log('点提交 (' + b2.x + ',' + b2.y + ')  size=' + b2.w + 'x' + b2.h + ' inVp=' + b2.inVp + ' hit=' + b2.hit);
    if (b2.inVp && b2.hit && /A\.|SPAN|BUTTON/i.test(b2.hit)) { console.log('   → 真实鼠标'); await click(b2.x, b2.y); }
    // 坐标层不可靠（按钮在 3 层 iframe 底部，鼠标事件经常打到别处）→ **始终**用 DOM 点击兜底：
    //   该 <a> 的 onclick 就是 btnBlueSubmit()，DOM click 等价用户点击。
    if (b2.inVp && b2.hit && /A\.|SPAN|BUTTON/i.test(b2.hit)) { /* 已用真实鼠标 */ }
    const rDom = await c.ev(`(function(){
      function walk(r, path, sel){ try { var e=r.querySelector(sel); if(e) return e;
        var fs=Array.from(r.querySelectorAll('iframe'));
        for (var i=0;i<fs.length;i++){ var d=null; try{d=fs[i].contentDocument}catch(x){} if(d){ var q=walk(d, path.concat([i]), sel); if(q) return q; } } } catch(x){} return null; }
      var b = walk(document, [], 'a.workBtnIndex');
      if (!b) return 'nobtn';
      try { b.click(); return 'clicked'; } catch(e){ return 'err:' + e.message; }
    })()`);
    console.log('   DOM 点击提交: ' + rDom);
    // ★ 提交要求 enc（由 btnBlueSubmit→validateTimeNew→toadd 异步写入 #enc）；
    //   enc 为空时服务端只会"保存"不会"提交"（实测：alert 提示"保存成功"但任务点仍是待完成）。
    for (let w = 0; w < 15; w++) {
      await sleep(2000);
      const st2 = await c.ev(`(function(){
        function findDoc(sel){ var hit=null; (function walk(r,p,d){ try { if(r.querySelector&&r.querySelector(sel)){ hit=r; return; } if(d>6) return;
          Array.from(r.querySelectorAll('iframe')).forEach(function(f){ var dd=null; try{dd=f.contentDocument}catch(e){} if(dd&&!hit) walk(dd,p,d+1); }); }catch(e){} })(document,0,0); return hit; }
        var doc = findDoc('.TiMu'); if (!doc) return null;
        var e = doc.getElementById('enc');
        var ans = [];
        Array.from(doc.querySelectorAll('input[name^="answer"]')).forEach(function(i){ if (i.type === 'hidden' && i.name.indexOf('answertype') < 0) ans.push(i.value); });
        return JSON.stringify({ enc: e ? e.value : null, answers: ans.join('|').slice(0, 60), url: location.href.slice(-40) });
      })()`);
      if (st2 && typeof st2 === 'string') { console.log('   [' + (w * 2) + 's] ' + st2); try { const o = JSON.parse(st2); if (o.enc && o.enc.length > 8) break; } catch (e) { } }
    }
  }
  await sleep(3500);
  const cf = await c.ev(`(function(){
    var out = [];
    (function scan(r, path, depth){ try {
      Array.from(r.querySelectorAll('a,button,span,div,input[type=button]')).forEach(function(e){
        var t = (e.innerText||e.value||'').trim();
        if (/^(确定|确认|是|继续提交)$/.test(t) && (e.offsetWidth||e.offsetHeight)) { var b = e.getBoundingClientRect(); out.push({ x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2), t: t }); }
      });
      if (depth > 4) return;
      Array.from(r.querySelectorAll('iframe')).forEach(function(f,i){ var d=null; try{d=f.contentDocument}catch(e){} if(d) scan(d, path.concat([i]), depth+1); });
    } catch(e){} })(document, [], 0);
    return JSON.stringify(out);
  })()`);
  let confirms = [];
  try { confirms = JSON.parse(cf || '[]'); } catch (e) { confirms = []; }
  for (const co of confirms.slice(0, 2)) { console.log('  确认框: ' + co.t + ' @' + co.x + ',' + co.y); await click(co.x, co.y); await sleep(2500); }
  await sleep(4000);
  const after = await c.ev(`(function(){ function findDoc(sel){ var hit=null; (function walk(r,p,d){ try{ if(r.querySelector&&r.querySelector(sel)){ hit=r; return; } if(d>6) return; Array.from(r.querySelectorAll('iframe')).forEach(function(f){ var dd=null; try{dd=f.contentDocument}catch(e){} if(dd&&!hit) walk(dd,p,d+1); }); }catch(e){} })(document,0,0); return hit; } var d = findDoc('.TiMu'); return d ? (d.body.innerText||'').replace(/\\s+/g,' ').slice(0,240) : 'no-doc'; })()`);
  console.log('提交后页面: ' + String(after).slice(0, 200));
}
c.ws.close();
