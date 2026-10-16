/**
 * cx-quiz-lab.mjs — 章测试「取证台」：只读探查测验页的结构与结果页回显
 *   node scripts/cx-quiz-lab.mjs --port 9227 --chapter <chapterId> [--pause] [--dump <file>]
 *
 * 目的（2026-10-16 为提高正确率做的取证）：
 *   ① 未提交的测验页：题目数/题型/提交按钮/是否允许重做（次数）
 *   ② 已提交的结果页：**站点有没有回显正确答案**（这是"二次提交修正/入库"的前提）
 *
 * 绝不做的事：不点提交、不点保存、不勾选项。纯读取。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 需要新开标签时，先经浏览器端点 Target.createTarget（不动驱动器那个标签） */
let myTargetId = null;
async function browserSend(m, pr = {}, ms = 20000) {
  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const bws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise(r => bws.addEventListener('open', r));
  const out = await new Promise(res => {
    const on = e => { const x = JSON.parse(e.data); if (x.id === 1) { bws.removeEventListener('message', on); res(x); } };
    bws.addEventListener('message', on);
    bws.send(JSON.stringify({ id: 1, method: m, params: pr }));
    setTimeout(() => res({ timeout: true }), ms);
  });
  bws.close();
  return out;
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let p = null;
if (A.newtab && A.url) {
  const r = await browserSend('Target.createTarget', { url: String(A.url) });
  myTargetId = r && r.result && r.result.targetId;
  console.log('新开标签 target=' + myTargetId);
  await sleep(6000);
  const l2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log('标签顺序（驱动器取的是第一个 chaoxing 页面）:');
  l2.filter(t => t.type === 'page').forEach((t, i) => console.log('   [' + i + '] ' + String(t.url).slice(0, 90)));
  p = l2.find(t => t.id === myTargetId) || null;
}
if (!p) p = list.find(t => t.type === 'page' && /chaoxing\.com/.test(t.url)) || list.find(t => t.type === 'page' && !/^chrome/.test(t.url));
if (!p) { console.log('没有 chaoxing 页面'); process.exit(1); }
console.log('本次操作的页面: ' + String(p.url).slice(0, 110));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const send = (m, pr = {}, ms = 60000) => new Promise(res => {
  const id = ++seq;
  const on = e => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method: m, params: pr }));
  setTimeout(() => res({ timeout: true }), ms);
});
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.timeout) return { __timeout: true }; if (r.result && r.result.exceptionDetails) return { __err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 300) }; return r.result && r.result.result ? r.result.result.value : null; };
await send('Page.enable');
ws.addEventListener('message', async e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.method === 'Page.javascriptDialogOpening') { console.log('  ⚠ 原生弹窗(' + m.params.type + '): ' + String(m.params.message).slice(0, 120)); await send('Page.handleJavaScriptDialog', { accept: true }); }
});

const DEEP = `function deep(r,d){ if(d>6) return null; try{ if(r.querySelector&&r.querySelector('.TiMu')) return r; var fs=Array.from(r.querySelectorAll('iframe')); for(var i=0;i<fs.length;i++){ var dd=null; try{dd=fs[i].contentDocument}catch(e){} if(dd){var h=deep(dd,d+1); if(h) return h;} } }catch(e){} return null; }`;

/** 全页文本 + 按钮 + 题目根节点的属性（结果页的答案常在属性/class 里） */
const SURVEY = `(function(){
  ${DEEP}
  var out = { url: location.href.slice(0,160), title: document.title };
  var dd = deep(document, 0);
  out.hasTiMu = !!dd;
  if (!dd) {
    // 没找到测验：把正文抓一段，看它到底是什么页
    var body = (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 400);
    out.bodyText = body;
    var ifr = [];
    Array.from(document.querySelectorAll('iframe')).forEach(function(f){ ifr.push(String(f.getAttribute('src')||'').slice(0,150)); });
    out.iframes = ifr;
    return JSON.stringify(out);
  }
  var body = (dd.body ? dd.body.innerText : '').replace(/\\s+/g,' ');
  out.framePath = 'yes';
  out.bodyText = body.slice(0, 6000);
  // ★ 密文判据：PUA 私用区字符数 + 页内有没有 font-cxsecret
  (function(){
    var n = 0, samp = [];
    for (var i=0;i<body.length;i++){ var c = body.charCodeAt(i); if (c>=0xE000 && c<=0xF8FF) { n++; if (samp.length<12) samp.push('U+'+c.toString(16)); } }
    out.pua = n; out.puaSample = samp;
    var f = 'none';
    try {
      Array.from((dd.defaultView||window).document.querySelectorAll('style')).forEach(function(s){ if ((s.textContent||'').indexOf('cxsecret')>=0) f = 'cxsecret'; });
      Array.from(dd.querySelectorAll('style')).forEach(function(s){ if ((s.textContent||'').indexOf('cxsecret')>=0) f = 'cxsecret-in-frame'; });
    } catch(e){}
    out.cipherFont = f;
    // 页面里有没有我们的解码器/字体库
    out.decoder = typeof (dd.defaultView||window).__cxDecode === 'object';
    out.glib = (dd.defaultView||window).__cxGLibV || 0;
    // ★ 未解码的原始题面（留给"解码质量"对照）
    var q0 = dd.querySelector('.TiMu');
    var s0 = q0 ? (q0.querySelector('.Zy_TItle') || q0).innerText : '';
    out.rawFirstStem = String(s0 || '').replace(/\\s+/g,' ').trim().slice(0, 200);
  })();
  // 关键字命中（决定"能不能读到正确答案"）
  out.marks = {};
  ['我的答案','正确答案','参考答案','答案解析','得分','本次成绩','成绩','重做','再次答题','重新答题','已提交','已完成','可提交','次数','限时','允许查看','查看答案'].forEach(function(k){ var n = (body.split(k).length - 1); if (n) out.marks[k] = n; });
  // 题目
  var qs = Array.from(dd.querySelectorAll('.TiMu'));
  out.qCount = qs.length;
  out.questions = qs.slice(0, 60).map(function(q, i){
    var attrs = {};
    Array.from(q.attributes || []).forEach(function(a){ attrs[a.name] = String(a.value).slice(0, 120); });
    var stemEl = q.querySelector('.Zy_TItle .clearfix') || q.querySelector('.Zy_TItle') || q.querySelector('.mark_name');
    var stem = stemEl ? (stemEl.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 260) : '';
    var ul = q.querySelector('ul');
    var lis = ul ? Array.from(ul.querySelectorAll('li')) : [];
    var opts = lis.map(function(li, k){
      var inp = li.querySelector('input[type=radio], input[type=checkbox]');
      var t = (li.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 160);
      return { k: k, v: inp ? String(inp.value) : null, nm: inp ? String(inp.name) : null, type: inp ? inp.type : null, checked: inp ? inp.checked : null, cls: String(li.className).slice(0,60), txt: t };
    });
    return { i: i, attrs: attrs, cls: String(q.className).slice(0,80), stem: stem, opts: opts,
             inner: (q.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 400) };
  });
  // 按钮
  var btns = [];
  Array.from(dd.querySelectorAll('a,button,input[type=button],input[type=submit],span,div')).forEach(function(b){
    var t = ((b.innerText || b.value || '')).trim();
    if (!t || t.length > 12) return;
    if (!(b.offsetWidth || b.offsetHeight)) return;
    if (/提交|交卷|保存|重做|再次|重新|返回|查看|解析|确定|完成|重考/.test(t)) btns.push({ t: t, tag: b.tagName, cls: String(b.className).slice(0,50), oc: String(b.getAttribute('onclick') || '').slice(0, 120) });
  });
  out.buttons = btns.slice(0, 30);
  // 隐藏域（答案域 / enc / 表单动作）
  var hs = Array.from(dd.querySelectorAll('input[type=hidden]')).map(function(x){ return { n: String(x.name).slice(0,40), v: String(x.value).slice(0,60) }; });
  out.hidden = hs.slice(0, 40);
  var form = dd.querySelector('form');
  out.formAction = form ? String(form.getAttribute('action') || '') : null;
  // 结果页：每题右侧的判定图标/文字（对错标记）
  out.resultHints = Array.from(dd.querySelectorAll('[class*=dui],[class*=cuo],[class*=right],[class*=wrong],[class*=correct],[class*=answer]')).slice(0, 40)
    .map(function(e){ return { cls: String(e.className).slice(0, 60), txt: (e.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 80), tag: e.tagName }; });
  return JSON.stringify(out);
})()`;

async function nav(url, waitMs) {
  await send('Page.navigate', { url });
  await sleep(waitMs);
  let ready = null;
  for (let i = 0; i < 12; i++) {
    ready = await ev(`(function(){ ${DEEP} return !!deep(document,0) ? 'timu' : 'wait'; })()`);
    if (ready === 'timu') break;
    await sleep(2000);
  }
  return ready;
}

const CHAPTER = String(A.chapter || '');
if (A.scores) {
  // 批量读"已提交测验"的成绩单：--scores id1,id2,...  → 每行一条紧凑结果
  const ids = String(A.scores).split(',').map(s => s.trim()).filter(Boolean);
  const COURSE0 = String(A.course || '266554494'), CLAZZ0 = String(A.clazz || '153244493'), ENC0 = String(A.enc || 'cdb2c66bf5e1889e38c3cfb0e051f838');
  const ROWS = [];
  for (const id of ids) {
    const u = `https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=${id}&courseId=${COURSE0}&clazzid=${CLAZZ0}&enc=${ENC0}`;
    await nav(u, 8000);
    const raw = await ev(`(function(){ ${DEEP}
      var dd = deep(document,0); if(!dd) return JSON.stringify({err:'no-timu'});
      var t = (dd.body ? dd.body.innerText : '').replace(/\\s+/g,' ');
      var m = t.match(/本次成绩[:：]\\s*([0-9.]+)/);
      var title = (t.match(/^[^ ]+已完成/) || [])[0] || '';
      // 按题切：每题以「我的答案：」为锚，向前找题干、向后找得分
      var parts = t.split(/(?=【(?:判断题|单选题|多选题|填空题)】)/);
      var q = [];
      parts.forEach(function(p){
        var head = (p.match(/^【(判断题|单选题|多选题|填空题)】/) || [])[1];
        if (!head) return;
        var mine = (p.match(/我的答案：([^得]*?)得分/) || [])[1];
        var sc = (p.match(/得分：\\s*([0-9.]+)/) || [])[1];
        var stem = p.replace(/^【[^】]*】/,'').split(/A、|$ /)[0].slice(0, 60);
        q.push({ kind: head, mine: mine ? mine.replace(/\\s+/g,' ').trim().slice(0,50) : '', score: sc === undefined ? null : Number(sc), stem: stem.replace(/\\s+/g,' ').trim().slice(0, 46) });
      });
      var stat = {};
      q.forEach(function(x){ stat[x.kind] = stat[x.kind] || { n: 0, full: 0 }; stat[x.kind].n++; if (x.score && x.score > 0) stat[x.kind].full++; });
      return JSON.stringify({ title: title, score: m ? Number(m[1]) : null, stat: stat, q: q, bodyText: t.slice(0, 9000), url: location.href.slice(0,90) });
    })()`);
    let o = null; try { o = JSON.parse(String(raw)); } catch (e) { }
    console.log('=== ' + id + ' ===');
    if (!o || o.err) { console.log('  ' + String(raw).slice(0, 160)); continue; }
    console.log('  ' + o.title + '  本次成绩=' + o.score + '  ' + JSON.stringify(o.stat));
    o.q.forEach((x, i) => console.log('   ' + (i + 1) + ' [' + x.kind + '] 对=' + (x.score > 0 ? 'Y' : 'N') + ' 我的=' + JSON.stringify(x.mine) + ' | ' + x.stem));
    ROWS.push({ id: id, title: o.title, score: o.score, stat: o.stat, q: o.q, bodyText: o.bodyText });
  }
  writeFileSync(join(REPO, 'runs', 'cx-quiz-scores.json'), JSON.stringify(ROWS, null, 1), 'utf8');
  console.log('汇总已落盘 runs/cx-quiz-scores.json');
  ws.close();
  process.exit(0);
}
if (!CHAPTER) { console.log('需要 --chapter <chapterId>'); process.exit(1); }
const ENC = String(A.enc || 'cdb2c66bf5e1889e38c3cfb0e051f838');
const COURSE = String(A.course || '266554494');
const CLAZZ = String(A.clazz || '153244493');

if (A.pause) { await ev(`(function(){ try{ var k=localStorage.getItem('ncCx:paused'); localStorage.setItem('ncCx:paused','1'); return k; }catch(e){ return 'err'; } })()`); console.log('已暂停驱动器（原值已记，--resume 恢复）'); }
if (A.resume) { await ev(`(function(){ try{ localStorage.removeItem('ncCx:paused'); return 'resumed'; }catch(e){ return 'err'; } })()`); console.log('已恢复驱动器'); ws.close(); process.exit(0); }

const url = A.url || `https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?chapterId=${CHAPTER}&courseId=${COURSE}&clazzid=${CLAZZ}&enc=${ENC}`;
console.log('导航 → ' + url);
const ready = await nav(url, 9000);
console.log('  TiMu 就绪: ' + ready);
const surveyRaw = await ev(SURVEY);
let survey = null; try { survey = JSON.parse(String(surveyRaw)); } catch (e) { console.log('survey 解析失败: ' + String(surveyRaw).slice(0, 300)); }
if (survey) {
  console.log('  URL: ' + survey.url);
  console.log('  题数: ' + survey.qCount);
  console.log('  PUA密文字符数: ' + survey.pua + '  样例: ' + JSON.stringify(survey.puaSample) + '  密文字体: ' + survey.cipherFont);
  console.log('  页内解码器: ' + survey.decoder + '  字形库版本: ' + survey.glib);
  console.log('  原始首题面: ' + String(survey.rawFirstStem).slice(0, 120));
  console.log('  关键字: ' + JSON.stringify(survey.marks));
  console.log('  按钮: ' + JSON.stringify(survey.buttons));
  console.log('  正文片段: ' + (A.fullbody ? String(survey.bodyText) : String(survey.bodyText).slice(0, 500)));
  (survey.questions || []).slice(0, 12).forEach(q => {
    console.log('   Q' + (q.i + 1) + ' [' + q.cls + '] attrs=' + JSON.stringify(q.attrs).slice(0, 120));
    console.log('      stem: ' + q.stem.slice(0, 120));
    (q.opts || []).forEach(o => console.log('      ' + o.k + ' v=' + o.v + ' type=' + o.type + ' checked=' + o.checked + ' cls=' + o.cls + ' | ' + o.txt.slice(0, 70)));
  });
}
const dumpFile = A.dump ? String(A.dump) : join(REPO, 'runs', 'cx-quiz-lab-' + CHAPTER + '.json');
writeFileSync(dumpFile, JSON.stringify(survey || { raw: String(surveyRaw).slice(0, 4000) }, null, 1), 'utf8');
console.log('已落盘: ' + dumpFile);

// ★ 真值取证：把测验页放大后截图 —— 字体渲染出来的是**正确字形**，
//   而 DOM 里是密文串，所以截图是解码准确率的 ground truth（人眼/视觉模型可读）。
//   ⚠️ 教训（2026-10-16 实测）：**绝对不要用 Emulation.setDeviceMetricsOverride** ——
//   它改掉 screen.width/devicePixelRatio 等指纹，学习通 detect.chaoxing.com 立刻弹
//   「您的账号于 HH:MM 在一台谷歌内核浏览器设备登录章节页面，多终端登录可能会被判定异常学习」。
//   改用 captureScreenshot 的 clip.scale（纯渲染参数，不动页面指纹）。
if (A.shot) {
  const shotFile = String(A.shot);
  const size = await ev(`(function(){ var d=document.documentElement; return JSON.stringify({w:Math.max(d.scrollWidth, innerWidth), h:Math.max(d.scrollHeight, innerHeight)}); })()`);
  let sz = { w: 800, h: 2000 }; try { sz = JSON.parse(String(size)); } catch (e) { }
  const scale = Number(A.scale || 2.6);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: sz.w, height: Math.min(sz.h, 6000), scale: scale } });
  if (r && r.result && r.result.data) {
    writeFileSync(shotFile, Buffer.from(r.result.data, 'base64'));
    console.log('已截图: ' + shotFile + '  (' + Math.round(r.result.data.length * 0.75 / 1024) + ' KB, ' + sz.w + 'x' + Math.min(sz.h, 6000) + ' @' + scale + 'x)');
  } else console.log('截图失败: ' + JSON.stringify(r).slice(0, 200));
}
ws.close();
