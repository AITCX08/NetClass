/**
 * cc-auto.mjs — 长春教师培训（col.ccjyxy.cn）驱动器 v3
 *
 * 设计要点（相对 v2 的修复）：
 *   1. 认领标签：每个实例绑定 --tab N（并记录 targetId）；列表顺序变了就重认领
 *   2. 分工：--cat N 只做第 N 个分类（0 小初高公需 / 1 初中学段通识 / 2 专业课-初中数学），多实例零冲突
 *   3. 严格单段闭环：进课 → 点「播放/继续」→ 等 <video> 真正结束 → 才点下一段 → 全段完成才返回列表
 *   4. 抗卡死：进度停滞 45s 自动恢复（点播放器播放键 / 视频再 play）；弹题等弹层自动记录并尝试继续
 *   5. 枚举 0 门 ≠ 全部完成：重展开重试；单个分类内 0 门才算该类做完（作业、返回键、页面兜底都走这一条）
 *   6. 全程日志落盘 runs/logs/cc-<tag>.log，关键动作带 [STEP] 便于定位卡点
 *
 * 用法：
 *   node scripts/cc-auto.mjs --port 9228 --tab 0 --cat 0 --tag A
 *   node scripts/cc-auto.mjs --port 9228 --tab 1 --cat 1 --tag B
 *   node scripts/cc-auto.mjs --port 9228 --tab 2 --cat 2 --tag C --newtab
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;

const PORT = Number(A.port || 9228);
const TAB = Number(A.tab || 0);
const CAT = (A.cat === undefined || A.cat === true) ? null : Number(A.cat);
const NEWTAB = !!A.newtab;
const TAG = String(A.tag || ('t' + TAB));
const POLL = Number(A.poll || 6) * 1000;          // 视频轮询间隔
const STALL = Number(A.stall || 45) * 1000;       // 进度停滞阈值
const CATNAME = ['小初高公需', '初中学段通识', '专业课-初中数学'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = 'https://col.ccjyxy.cn';

const LOGDIR = 'runs/logs';
if (!existsSync(LOGDIR)) mkdirSync(LOGDIR, { recursive: true });
let LOGF = `${LOGDIR}/cc-${TAG}.log`;
const stamp = () => new Date().toTimeString().slice(0, 8);
function log(...a) {
  const s = `[${stamp()}][${TAG}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  console.log(s);
  try { appendFileSync(LOGF, s + '\n'); } catch (_) { }
}

/* ---------- CDP ---------- */
async function listTabs() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    return list.filter(t => t.type === 'page' && /ccjyxy/.test(t.url) && !/tampermonkey/.test(t.url));
  } catch (_) { return null; }
}
async function newTab() {
  try { await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(HOME)}`, { method: 'PUT' }); } catch (_) { }
  await sleep(7000);
}
const wsCache = new Map();
async function conn() {
  let cand = await listTabs();
  if (cand === null) return null;
  if (cand.length <= TAB && NEWTAB) { await newTab(); cand = await listTabs() || []; }
  const p = cand[TAB] || cand[0];
  if (!p) return null;
  const key = p.id;
  let ent = wsCache.get(key);
  if (!ent || ent.ws.readyState !== 1) {
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); setTimeout(r, 8000); });
    let seq = 0;
    const send = (m, params = {}, ms = 25000) => new Promise(res => {
      const id = ++seq; const on = ev => { let x; try { x = JSON.parse(ev.data); } catch (_) { return; } if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
      ws.addEventListener('message', on);
      try { ws.send(JSON.stringify({ id, method: m, params })); } catch (_) { res({ timeout: true }); }
      setTimeout(() => { ws.removeEventListener('message', on); res({ timeout: true }); }, ms);
    });
    ent = { ws, send, id: p.id };
    wsCache.set(key, ent);
  }
  const ev = async (e, ms = 25000) => {
    const r = await ent.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, ms);
    if (r && r.timeout) return null;
    if (r && r.result && r.result.exceptionDetails) { log('  [js-err]', JSON.stringify(r.result.exceptionDetails).slice(0, 150)); return null; }
    return r && r.result && r.result.result ? r.result.result.value : null;
  };
  const click = async (x, y) => {
    await ent.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await ent.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await ent.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const info = async () => { try { const t = (await listTabs() || []).find(t => t.id === ent.id); return t || null; } catch (_) { return null; } };
  return { ws: ent.ws, send: ent.send, ev, click, info, id: p.id };
}
/** 页面上某段文本所在元素的真实鼠标点击 */
async function clickText(c, txt, exact = true) {
  const box = await c.ev(`(function(){
    var el = Array.from(document.querySelectorAll('button,a,div,span')).find(function(e){
      var x=(e.innerText||'').trim();
      return ${exact ? `x === ${JSON.stringify(txt)}` : `x.indexOf(${JSON.stringify(txt)}) >= 0`} && (e.offsetWidth||e.offsetHeight);
    });
    if (!el) return null; el.scrollIntoView({block:'center'});
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return JSON.stringify({x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});
  })()`);
  if (!box) return false;
  const b = JSON.parse(box);
  await c.click(b.x, b.y);
  return true;
}
const VSTATE = `(function(){
  function find(r){try{var v=r.querySelector&&r.querySelector('video');if(v)return v;var fs=r.querySelectorAll?r.querySelectorAll('iframe'):[];for(var i=0;i<fs.length;i++){var d=null;try{d=fs[i].contentDocument}catch(e){}if(d){var x=find(d);if(x)return x}}}catch(e){}return null}
  var v=find(document);
  var t=(document.body.innerText||'').replace(/\\s+/g,' ');
  return JSON.stringify({
    cur: v?Math.round(v.currentTime*10)/10:null, dur: v?Math.round(v.duration||0):null,
    rate: v?v.playbackRate:null, paused: v?v.paused:null, ended: v?v.ended:null,
    onTrain: /学习总进度/.test(t), onCourse: /返回课程列表/.test(t),
    playBtns: Array.from(document.querySelectorAll('button,a,div,span')).filter(function(e){var x=(e.innerText||'').trim();return (x==='播放'||x==='继续'||x==='重播')&&(e.offsetWidth||e.offsetHeight)}).length,
    head: t.slice(0,110)
  });
})()`;
const state = async c => { const s = await c.ev(VSTATE); return s ? JSON.parse(s) : null; };

/* ---------- 页面动作 ---------- */
async function ensureTraining(c) {
  let s = await state(c);
  if (s && s.onTrain) return true;
  if (s && s.onCourse) { log('  返回培训页：点「返回课程列表」'); await clickText(c, '返回课程列表'); await sleep(6000); }
  s = await state(c);
  if (s && s.onTrain) return true;
  log('  兜底导航：我的培训 → 进入');
  await clickText(c, '我的培训'); await sleep(4000);
  await clickText(c, '进入'); await sleep(7000);
  s = await state(c);
  if (s && s.onTrain) return true;
  // 最后兜底：刷新
  log('  刷新页面重进培训页');
  await c.ev(`location.href=${JSON.stringify(HOME)}`);
  await sleep(9000);
  await clickText(c, '我的培训'); await sleep(4000);
  await clickText(c, '进入'); await sleep(7000);
  s = await state(c);
  return !!(s && s.onTrain);
}
/** 展开指定分类（cat=null → 全部） */
async function expand(c, cat) {
  const names = cat === null ? CATNAME : [CATNAME[cat]];
  for (const nm of names) {
    for (let k = 0; k < 5; k++) {
      const done = await c.ev(`(function(){
        var hs = Array.from(document.querySelectorAll('h3.MuiAccordion-heading'));
        var h = hs.find(function(e){ return (e.innerText||'').indexOf(${JSON.stringify(nm)}) >= 0; });
        if (!h) return 'nohead';
        if (/收起/.test(h.innerText||'')) return 'open';
        var b = h.querySelector('button'); if (!b) return 'nobtn';
        b.scrollIntoView({block:'center'}); var r = b.getBoundingClientRect();
        return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+Math.min(24,r.height/2))});
      })()`);
      if (done === 'open') break;
      if (done === 'nohead' || done === 'nobtn' || !done) { await sleep(2500); continue; }
      const b = JSON.parse(done); await c.click(b.x, b.y); await sleep(2500);
    }
  }
  await sleep(1500);
}
/** 枚举课程（带分类归属与完成状态） */
async function enumerate(c, cat) {
  const raw = await c.ev(`JSON.stringify((function(){
    var out=[], seen={};
    var hs = Array.from(document.querySelectorAll('h3.MuiAccordion-heading'));
    function catOf(el){
      var res=null;
      hs.forEach(function(h){
        var r=el;
        for(var k=0;k<10&&r;k++){ if(r===h){var tx=(h.innerText||'');res=/小初高公需/.test(tx)?0:(/初中学段通识/.test(tx)?1:(/专业课/.test(tx)?2:null));return;} r=r.parentElement; }
      });
      return res;
    }
    var btns = Array.from(document.querySelectorAll('button.MuiListItemButton-root, .MuiListItemButton-root'));
    btns.forEach(function(b){
      var t=(b.innerText||'').replace(/\\s+/g,' ').trim();
      if(!/编码[:：]/.test(t) || !/学时/.test(t)) return;
      var name=t.split('编码')[0].trim();
      if(!name||name.length>60||seen[name])return; seen[name]=1;
      out.push({name:name, cat:catOf(b), undone:!/(已完成|已学习|合格)/.test(t), text:t.slice(0,120)});
    });
    return out;
  })())`);
  const all = raw ? JSON.parse(raw) : [];
  return cat === null ? all : all.filter(x => x.cat === cat);
}

/* ---------- 进入课程 ---------- */
async function openCourse(c, course) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const box = await c.ev(`(function(){
      var bs = Array.from(document.querySelectorAll('button.MuiListItemButton-root, .MuiListItemButton-root'));
      var b = bs.find(function(e){ return (e.innerText||'').indexOf(${JSON.stringify(course.name.slice(0, 18))}) >= 0; });
      if (!b) return null; b.scrollIntoView({block:'center'});
      var r = b.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return JSON.stringify({x: Math.round(r.left + Math.min(40, r.width/2)), y: Math.round(r.top + r.height/2)});
    })()`);
    if (!box) { log('  ⚠ 列表里找不到课程卡片:', course.name.slice(0, 20)); return false; }
    const b = JSON.parse(box);
    await c.click(b.x, b.y);
    // 等课程页（返回课程列表 + 有 video）
    for (let w = 0; w < 28; w++) {
      await sleep(2000);
      const s = await state(c);
      if (s && s.onCourse) { log('  已进课程页 (' + (2 * (w + 1)) + 's)'); return true; }
    }
    log('  ⚠ 第 ' + attempt + ' 次点开后仍未进课程页，重试');
    const s = await state(c);
    if (s && s.onCourse) return true;
  }
  return false;
}

/* ---------- 处理一门课：逐段播完 ---------- */
async function playCourse(c, course) {
  let segs = 0;
  let lastEnd = 0;
  for (let seg = 1; seg <= 40; seg++) {
    const s0 = await state(c);
    if (!s0 || !s0.onCourse) { log('  离开课程页了（可能已回列表）'); break; }
    if (s0.playBtns === 0) {
      // 没有可点的段 → 可能自动播完了，等一会再看
      await sleep(5000);
      const s1 = await state(c);
      if (!s1 || !s1.onCourse) break;
      if (s1.playBtns === 0) { log('  课程页无可播段（playBtns=0）'); break; }
    }
    const clicked = await clickText(c, '播放') || await clickText(c, '继续') || await clickText(c, '重播');
    if (!clicked) { log('  点不到「播放/继续」按钮'); break; }
    segs++;
    // 等视频起播
    let started = null;
    for (let w = 0; w < 20; w++) {
      await sleep(2000);
      const s = await state(c);
      if (!s) break;
      if (s.cur != null && s.dur) { started = s; break; }
      if (!s.onCourse) break;
    }
    if (!started) { log(`  段${segs}: 视频未起播（可能弹层/网络慢）`); await sleep(6000); continue; }
    // 播完循环
    let lastCur = started.cur, lastMove = Date.now(), nudges = 0, stallTry = 0;
    for (let g = 0; g < 3000; g++) {
      await sleep(POLL);
      const s = await state(c);
      if (!s) continue;
      if (s.cur == null) {
        // 视频没了：可能弹题 / 已回到列表
        if (!s.onCourse) { log(`  段${segs}: 播放页关闭（回到课程/列表）`); break; }
        log(`  段${segs}: 找不到 <video>，等待`);
        await sleep(5000); continue;
      }
      if (s.dur && s.cur >= s.dur - 1.5) { log(`  ✔ 段${segs} 播完 ${s.cur}/${s.dur}s`); lastEnd = Date.now(); break; }
      if (Math.abs(s.cur - lastCur) > 0.4) { lastCur = s.cur; lastMove = Date.now(); }
      if (s.paused && Date.now() - lastMove > 8000) {
        log(`  段${segs}: 暂停在 ${s.cur}/${s.dur}s，尝试继续`);
        await clickText(c, '继续') || await clickText(c, '播放') || await c.ev(`(function(){var v=document.querySelector('video');if(v){v.muted=true;v.play&&v.play()}})()`);
        lastMove = Date.now();
      }
      if (Date.now() - lastMove > STALL) {
        stallTry++;
        log(`  段${segs}: ⚠ 停滞 ${Math.round((Date.now() - lastMove) / 1000)}s @${s.cur}/${s.dur}s → 第 ${stallTry} 次恢复`);
        // 1) 点播放器自己的播放键  2) 视频 play()  3) 点「继续」
        await c.ev(`(function(){var b=document.querySelector('button.vjs-play-control');if(b)b.click();var v=document.querySelector('video');if(v){v.muted=true;if(v.paused){try{v.play()}catch(e){}} }})()`);
        await clickText(c, '继续');
        lastMove = Date.now();
        if (stallTry >= 4) { log(`  段${segs}: 恢复无效，跳过本段`); break; }
      }
      if (Date.now() - lastMove > 4 * STALL) { log(`  段${segs}: 长时间无进展，放弃本段`); break; }
    }
    // 段结束后：等页面稳定
    await sleep(4000);
    const s2 = await state(c);
    if (!s2 || !s2.onCourse) { log('  段后不在课程页 → 结束本课'); break; }
    if (segs >= 8) { log('  已播 8 段，保守收尾'); break; }
  }
  log(`  本课共点了 ${segs} 段`);
  return segs;
}

/* ---------- 完成任务 ---------- */
let claimedFixed = false;
async function backToList(c) {
  log('  [STEP] 返回课程列表');
  await clickText(c, '返回课程列表');
  await sleep(6000);
  let s = await state(c);
  if (s && s.onTrain) return true;
  s = await state(c);
  if (s && s.onCourse) { await clickText(c, '返回课程列表'); await sleep(6000); }
  return !!(await state(c))?.onTrain;
}

async function courseDone(c, name) {
  const raw = await c.ev(`JSON.stringify((function(){
    var bs=Array.from(document.querySelectorAll('button.MuiListItemButton-root, .MuiListItemButton-root'));
    var b=bs.find(function(e){return (e.innerText||'').indexOf(${JSON.stringify(name.slice(0, 18))})>=0});
    return b? b.innerText.replace(/\\s+/g,' ').trim().slice(0,120) : null;
  })())`);
  return raw ? (JSON.parse(raw) || '') : '';
}

/* ---------- 主循环 ---------- */
log('==== cc-auto v3 启动 port=' + PORT + ' tab=' + TAB + ' cat=' + CAT + (CAT === null ? '' : '(' + CATNAME[CAT] + ')') + ' ====');
let c = await conn();
if (!c) { log('❌ 没有 ccjyxy 页面（检查隧道: powershell -File scripts\\tunnel.ps1 -Port ' + PORT + '）'); process.exit(1); }
let handled = 0, failStreak = 0;

for (let round = 1; round <= 2000; round++) {
  try {
    c = await conn();
    if (!c) { log('  CDP 掉了，10s 后重连'); await sleep(10000); continue; }
    const pz = await c.ev(`(function(){try{return localStorage.getItem('ncCc:paused')==='1'}catch(e){return false}})()`);
    if (pz) { log('⏸ 面板已暂停（ncCc:paused=1），等待'); await sleep(15000); continue; }

    if (!(await ensureTraining(c))) { log('  ✗ 无法进入培训页，15s 重试'); await sleep(15000); continue; }
    await expand(c, CAT);
    let courses = await enumerate(c, CAT);
    if (!courses.length) {
      for (let r = 0; r < 4 && !courses.length; r++) {
        log('  ⚠ 枚举 0 门 → 重展开（第 ' + (r + 1) + ' 次）');
        await sleep(5000); await expand(c, CAT); courses = await enumerate(c, CAT);
      }
    }
    if (!courses.length) { log('  ⚠ 仍枚举不到课程，30s 后重试'); await sleep(30000); continue; }
    const undone = courses.filter(x => x.undone);
    if (CAT === null) {
      const totalDone = courses.length - undone.length;
      await c.ev(`(function(){try{localStorage.setItem('ncCc:total','${courses.length}');localStorage.setItem('ncCc:done','${totalDone}');localStorage.setItem('ncCc:at',String(Date.now()))}catch(e){}})()`);
    }
    log(`[${round}] ${CAT === null ? '全部' : CATNAME[CAT]}：枚举 ${courses.length} 门，未完成 ${undone.length} 门`);
    if (!undone.length) {
      if (CAT === null) { log('✅ 全部课程枚举均已标完成'); break; }
      log('✅ 本分类课程全部完成'); break;
    }
    const target = undone[0];
    log('  ▶ 处理: ' + target.name.slice(0, 30) + '  (cat=' + target.cat + ')');
    if (await openCourse(c, target)) {
      await playCourse(c, target);
      await backToList(c);
      const done = await courseDone(c, target.name);
      log('  列表回显: ' + (done || '(读不到)'));
      handled++; failStreak = 0;
    } else {
      failStreak++;
      log('  ✗ 进课失败，第 ' + failStreak + ' 次');
      if (failStreak >= 3) { log('  连续失败 3 次 → 刷新页面重来'); await c.ev('location.reload()'); await sleep(12000); failStreak = 0; }
    }
  } catch (e) {
    log('  异常: ' + String(e && e.message).slice(0, 120));
    await sleep(8000);
  }
}
log('==== 结束：处理 ' + handled + ' 门 ====');
