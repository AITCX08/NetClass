/**
 * cc-auto.mjs — 长春教师培训（col.ccjyxy.cn）驱动器 v4
 *   node scripts/cc-auto.mjs --port 9228 --tab 0 --cat 2 --tag A
 *
 * 核心：状态机 —— 每个标签**同一时间只做一件事**：
 *     HOME   不在培训页 → 回培训页
 *     PLAY   正在播放（<video> 存在）→ 只守播放，播完才动
 *     COURSE 课程详情页 → 找可播段 → 播放；没有可播段 → 整课完成 → 回培训页
 *     PICK   培训页 → 展开分类 → 列未完成课 → 进第一门（轮转，避免死磕同一门）
 *
 * 关键实测事实：
 *   1. 油猴脚本在 ccjyxy 没有适配器，且会在播放器页反复「按停播放」→ 每轮先 dispose 它
 *   2. 倍速锁 1x（playbackRate=1.5 会被打回 1，实测 30s 墙钟 = 30s 视频）
 *   3. 「播放」按钮用 DOM .click() 能起播；CDP 鼠标点有时不触发
 *   4. 播放器页 = 有「返回课程列表」+ <video>；课程详情页 = 有「返回培训内容列表」
 *   5. 培训页只渲染展开分类里的课程卡（懒加载）；课程名最长 40+ 字，别按长度过滤
 */
import { Tab, listCcTabs, acquireTab, closeExtraTabs, ensureViewport, pageState, ensureTraining, expand, enumerate, openCourse, backToTraining, playFirstSegment, killUserscript, claimCourse, releaseCourse, myClaims, claimsSnapshot, touchClaims, sleep, CATNAMES } from './cc-lib.mjs';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
// ★ 2026-10-18 修：旧写法只认 `--cat 0`（空格形式）；`--cat=0` 会被存成 A['cat=0']
//   → A.cat 仍是 undefined → CAT=null → 日志显示 cat=ALL，分类参数**静默失效**
//   （实测：传 --cat=0 却把三个分类一起枚举，展开后互相折叠 → 卡片 0 宽 → "打不开"）。
//   现在两种形式都认。
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); continue; }        // --cat=0
  A[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;   // --cat 0
}

const PORT = Number(A.port || 9228);
const TAB = Number(A.tab || 0);
const CATRAW = (A.cat === undefined || A.cat === true || String(A.cat).toLowerCase() === 'all') ? null : Number(A.cat);
const CAT = (CATRAW === null || (Number.isInteger(CATRAW) && CATRAW >= 0 && CATRAW <= 2)) ? CATRAW : null;
const TAG = String(A.tag || ('t' + TAB));
const TOKEN = 'data-nc-owner';
const RUNFILE = 'runs/cc-run-' + TAG + '.json';
const POLL = Number(A.poll || 5) * 1000;
const STALL = Number(A.stall || 60) * 1000;
const MAXSEG = Number(A.maxseg || 40);

if (!existsSync('runs/logs')) mkdirSync('runs/logs', { recursive: true });
const LOGF = `runs/logs/cc-${TAG}.log`;
const stamp = () => new Date().toTimeString().slice(0, 8);
function log(...a) {
  const s = `[${stamp()}][${TAG}] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  console.log(s);
  try { appendFileSync(LOGF, s + '\n'); } catch (_) { }
}
function saveRun(state) { try { writeFileSync(RUNFILE, JSON.stringify(state, null, 1)); } catch (_) { } }
const flag = s => s ? (s.onPlayer ? 'P' : s.onCourse ? 'C' : s.onTrain ? 'T' : s.onMyTraining ? 'M' : '?') : '-';

let TARGETID = A.target ? String(A.target) : null;
let tab = null;
async function pickTab() {
  tab = await acquireTab(PORT, { token: TOKEN, targetId: TARGETID, index: TAB, tag: TAG });
  if (!tab) return null;
  TARGETID = tab.targetId;
  // 视口保活（多次开关标签后窗口会被压小 → 所有点击落空）
  if (await ensureViewport(tab)) log('  视口已恢复到 1200x1000');
  // 自检：确认这个标签确实是自己的（防止两个实例共用一个标签互相打断）
  const o = await tab.ev(`(function(){ return document.documentElement.getAttribute(${JSON.stringify(TOKEN)}) })()`);
  if (o !== TAG) { log('⚠ 标签归属异常（owner=' + o + '，期望 ' + TAG + '）'); }
  return tab;
}

/** 培训页：等到出现「门课程」标题（页面渲染完成） */
async function waitTrainRender(tab, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = await tab.ev(`(function(){ var a=Array.from(document.querySelectorAll('.MuiAccordion-root')); var vis=a.filter(function(x){var h=x.querySelector('h3');return h && /门课程/.test(h.innerText||'')}); return vis.length; })()`);
    if (n >= 3) return true;
    await sleep(2500);
  }
  return false;
}

/** 一门课的段落统计（课程详情页）
 *  ★★ 2026-10-19 修（Bug1/Bug3 的一半）：
 *    · 旧写法把「重播」算成待播，却**不认平台实际用的「重看」**，而且只看"有没有按钮"，
 *      不看这份列表到底是"还有待播段"还是"全看完了"。
 *    · 现在分开两类：pend = 播放|继续（真待播）；watched = 重看|重播（已看完的段）。
 *      另修一个隐患：`.MuiListItem-root` 与 `.MuiListItemButton-root` 会嵌套命中同一条 → 只取最内层。
 *  @returns {Promise<{pend:number,watched:number,total:number}>} */
async function pendingSegs(tab) {
  const raw = await tab.ev(`(function(){
    var raw = Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root'))
      .filter(function(e){ return !/编码[:：]/.test(e.innerText||''); });
    var items = raw.filter(function(e){ return !raw.some(function(o){ return o !== e && e.contains(o); }); });
    var pend = 0, watched = 0;
    items.forEach(function(e){
      var btns = Array.from(e.querySelectorAll('button')).map(function(b){ return (b.innerText||'').trim(); });
      if (btns.some(function(x){ return /^(播放|继续)$/.test(x); })) pend++;
      else if (btns.some(function(x){ return /^(重看|重播)$/.test(x); })) watched++;
    });
    return JSON.stringify({ pend: pend, watched: watched, total: items.length });
  })()`);
  try { return JSON.parse(raw); } catch (_) { return { pend: 0, watched: 0, total: 0 }; }
}

/** 播放当前视频直到播完；返回 {res:'done'|'gone'|'stall', segs}
 *  ★ 2026-10-18 改良：播完一段**不再立刻点「返回课程列表」**。
 *    实测这个播放器在播完后会**自动换片源续播下一段**（dur 从 1226 变成 702 那种）。
 *    旧写法一播完就返回列表 → 列表里这条还是「继续 80%/96%」（服务端记的位置比本地播的靠后，
 *    因为记账 1.25x 封顶）→ 又把同一段重看一遍，每段白花 1-4 分钟，看起来像"乱跳"。
 *    现在：检测到 dur 变化（>5s）就当作自动续播，**原地继续守**，直到播放器消失或真播完。 */
async function waitSegment(tab, idx) {
  let s0 = await pageState(tab);
  if (!s0 || !s0.video) return { res: 'gone', segs: 0 };
  let t00 = Date.now(), durRef = s0.video.dur, baseCur = s0.video.cur, segs = 0, wallAcc = 0;
  let last = s0.video.cur, lastMove = Date.now(), tries = 0, lastLog = 0, lastPause = Date.now();
  let maxCur = s0.video.cur;                 // ★ 历史最大位置（见下面的"回卷判据"）
  log(`  段${idx} 起播 ${s0.video.cur}/${s0.video.dur} @${s0.video.rate}x`);
  for (let g = 0; g < 6000; g++) {
    await sleep(POLL);
    const s = await pageState(tab);
    if (!s) continue;
    if (!s.video) {
      const wall = Math.round((Date.now() - t00) / 1000);
      log(`  段${idx} 播放器关闭（页面=${flag(s)} 墙钟=${wall}s，本次共播完 ${segs} 段）`);
      return { res: s.onCourse ? 'done' : 'gone', segs };
    }
    // ★ 自动续播：片源换了（时长明显不同）→ 段号 +1，基准重置，继续守
    if (s.video.dur > 0 && durRef > 0 && Math.abs(s.video.dur - durRef) > 5) {
      log(`  ⏭ 自动续播：段${idx}→段${idx + 1}（时长 ${Math.round(durRef)}s→${Math.round(s.video.dur)}s）`);
      idx++; segs++;
      wallAcc += (Date.now() - t00) / 1000;
      durRef = s.video.dur; baseCur = s.video.cur; maxCur = s.video.cur;
      t00 = Date.now(); last = s.video.cur; lastMove = Date.now(); lastPause = Date.now(); lastLog = 0; tries = 0;
      continue;
    }
    if (s.video.dur && s.video.cur >= s.video.dur - 0.2) {
      const wall = (Date.now() - t00) / 1000;
      log(`  ✔ 段${idx} 播完 ${s.video.cur.toFixed(1)}/${s.video.dur} 墙钟=${Math.round(wall)}s 实速=${Math.round((s.video.cur - baseCur) / wall * 100) / 100}`);
      segs++;
      await sleep(2500);   // ★ 留时间让站点发最后一次 checkpoint（position 必须 >= duration 才会计完成）
      return { res: 'done', segs, wall: wall + wallAcc };
    }
    // ★★ 回卷判据（2026-10-15 补，解决"卡在同一段无限重播"）：
    //   这个平台的播放器会**自己循环** —— 视频到末尾后立刻回到 0。
    //   驱动每 POLL 秒采一次样，很可能**永远抓不到** cur>=dur-1.5 那一瞬
    //   （实测：课程 435 因此卡了 27 分钟，而资源其实早已 completed:true）。
    //   判据：**历史最大位置到过末尾（>= dur-3），且现在已回卷（< dur*0.2）** → 这一遍确实播到头了。
    if (s.video.dur > 0) {
      if (s.video.cur > maxCur) maxCur = s.video.cur;
      if (maxCur >= s.video.dur - 3 && s.video.cur < s.video.dur * 0.2) {
        log(`  ✔ 段${idx} 判为播完（历史最高 ${Math.round(maxCur)}/${s.video.dur}，现已回卷到 ${Math.round(s.video.cur)}）`);
        segs++;
        return { res: 'done', segs, wall: (Date.now() - t00) / 1000 + wallAcc };
      }
    }
    if (Math.abs(s.video.cur - last) > 0.4) { last = s.video.cur; lastMove = Date.now(); }
    // ★ 速率守护（2026-10-19 改：目标倍速 1.25x，见 cc-lib HUNTER_JS 里的记账实测结论）
    //   平台记账上限 = 1.25 × 资源累计墙钟 → 1.25x 才能"一趟播完即记满"；2x 只会造成 62.5% 账差。
    if (s.video.rate && s.video.rate < 1.2) {
      log(`  段${idx} ⚠ 倍速被打回 ${s.video.rate}x → 压回 1.25x`);
      await tab.ev(`(function(){var v=document.querySelector('video');if(!v)return;try{var s=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'playbackRate').set;localStorage.setItem('ncCc:rate','1.25');s.call(v,1.25);v.muted=true;v.play&&v.play().catch(function(){})}catch(e){}})()`);
      try { await installHunter(tab); } catch (_) { }
    }
    if (Date.now() - lastLog > 120000) {
      lastLog = Date.now();
      const wall = (Date.now() - t00) / 1000;
      log(`  …段${idx} ${s.video.cur}/${s.video.dur} @${s.video.rate}x${s.video.paused ? '(暂停)' : ''} 实速=${Math.round((s.video.cur - baseCur) / wall * 100) / 100} ${s.pct ? 'pct=' + s.pct : ''}`);
    }
    if (s.video.paused) {
      if (Date.now() - lastPause > 8000) {
        log(`  段${idx} 暂停在 ${s.video.cur}/${s.video.dur} → 拉起`);
        await tab.ev(`(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play()}catch(e){}}})()`);
        await killUserscript(tab);
        lastPause = Date.now();
      }
    } else lastPause = Date.now();
    if (Date.now() - lastMove > STALL) {
      tries++;
      log(`  段${idx} ⚠ 停滞 ${Math.round((Date.now() - lastMove) / 1000)}s → 第 ${tries} 次恢复`);
      await tab.ev(`(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play()}catch(e){}}})()`);
      await killUserscript(tab);
      lastMove = Date.now();
      if (tries >= 6) return { res: 'stall', segs };
    }
  }
  return { res: 'stall', segs };
}

/** 重看最后一段（补录用）：服务端按 1.25x 墙钟封顶记 position，2x 播完会留账差，
 *  平台于是显示「重看」但 max_position 还没到 duration → 这门课永远不算完成。
 *  点最后一个「重看/重播」把它再播一遍，让 position 多上报几秒，把账差补齐。 */
async function playLastWatched(tab, log) {
  const r = await tab.ev(`(function(){
    var raw = Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root'))
      .filter(function(e){ return !/编码[:：]/.test(e.innerText||''); });
    var items = raw.filter(function(e){ return !raw.some(function(o){ return o !== e && e.contains(o); }); });
    for (var i = items.length - 1; i >= 0; i--) {
      var b = Array.from(items[i].querySelectorAll('button')).find(function(x){ return /^(重看|重播|继续|播放)$/.test((x.innerText||'').trim()); });
      if (b) { var seg=(items[i].innerText||'').replace(/\\s+/g,' ').trim().slice(0,42); b.click(); return JSON.stringify({label:(b.innerText||'').trim(), seg:seg}); }
    }
    return null;
  })()`);
  if (!r || r.__err) return false;
  try { const o = JSON.parse(r); log('    补录点段[' + o.label + '] ' + o.seg); } catch (_) { return false; }
  for (let w = 0; w < 25; w++) {
    await sleep(2000);
    const st = await pageState(tab);
    if (!st) continue;
    if (st.video && st.video.dur) {
      if (st.video.paused && w >= 3) await tab.ev(`(function(){var v=document.querySelector('video');if(v){v.muted=true;try{v.play()}catch(e){}}})()`);
      if (!st.video.paused || w >= 8) return true;
    }
    if (!st.onCourse && !st.onPlayer && !st.onTrain) return false;
  }
  return false;
}

/* ---------------- 主循环 ---------------- */
log('==== cc-auto v4 启动 port=' + PORT + ' tab=' + TAB + ' cat=' + (CAT === null ? 'ALL' : CAT + '(' + CATNAMES[CAT] + ')') + ' ====');
await pickTab();
if (!tab) { log('❌ 没有 ccjyxy 标签（也开不出来）'); process.exit(1); }
log('tab=' + tab.targetId.slice(0, 8) + ' tag=' + TAG);

let mode = 'HOME';        // HOME | PLAY | COURSE | PICK
// ★★ 持久化跳过表（2026-10-16 主线补）——旧写法是内存 Set 且每轮 `skip.clear()`，
//   于是"**能打开但播不动**"的课会被无限重试：实测「观察与猜想」陷入
//   `起播→10秒播放器关闭→回列表→再进同一门→再播10秒` 的死循环，学时零增长。
//   `skip.add` 也只在"打不开"时调用，**"播不动"根本没人管**。
//   现在：跳过表落盘 runs/cc-skip.json（跨轮/跨进程有效），并在成功完成后自动移除。
const SKIP_FILE = 'runs/cc-skip.json';   // 驱动的工作目录就是仓库根
let skip = new Set();
try {
  const j = JSON.parse(readFileSync(SKIP_FILE, 'utf8'));
  if (Array.isArray(j)) { j.forEach(n => skip.add(n)); if (skip.size) log('  跳过表（持久化）: ' + skip.size + ' 门 → ' + [...skip].map(s => s.slice(0, 16)).join(' / ')); }
} catch (_) { }
const saveSkip = () => { try { writeFileSync(SKIP_FILE, JSON.stringify([...skip], null, 1)); } catch (_) { } };
/** 把某门课加入跳过表（打不开 / 播不动 都走这里） */
const addSkip = (name, why) => { if (name && !skip.has(name)) { skip.add(name); saveSkip(); log('  ⏭ 加入跳过表: ' + String(name).slice(0, 22) + '（' + why + '）'); } };
const delSkip = (name) => { if (name && skip.has(name)) { skip.delete(name); saveSkip(); } };

/* ---------- 「无待播段」短期跳过表（★ 2026-10-19 新增，配合 Bug1 修复） ----------
 * 语义严格区分：
 *   · done 墓碑（cc-claim.json 的 done:true）= **平台认为这门课已完成**，别的实例永远别再做它
 *   · noSeg（本表）= "我进去看过，这会儿没有可播段"——只是**短期躲开**，不是完成，绝不写 done
 * 旧 bug 就是把 noSeg 当成了 done：进错课（同前缀兄弟课）→ 全是「重看」→ pendingSegs=0
 *   → 写 done → 平台仍显示未学习 → 认领表堵死 → 死循环。现在这条路被彻底掐断。 */
const NOSEG_FILE = 'runs/cc-noseg.json';
/* ★ 2026-10-19 实测：一门课「4 段全播完（全变重看）」之后，学时**不会立刻涨** ——
 *   课级完成是进课程页那一刻由 /api/v1/completions/check 在服务端判定的；
 *   我们回课程页时（播完最后一段后 9 秒）那次 check 早于最后一次 report 落库 → 返回未完成，
 *   之后再没人触发它 → 这门课就永远停在"全看完但不记学时"（实测 C2601738 卡了 1 小时）。
 *   修法：把「无待播段」短期跳过从 20 分钟缩到 **5 分钟** —— 每 5 分钟再进一次课，
 *   等于每 5 分钟替服务端重跑一次 completions/check，直到平台把卡片翻成「已完成」为止（一次约 20s）。 */
const NOSEG_TTL = Number(A.noseg || 5) * 60 * 1000;
let noSeg = {};
try {
  const j = JSON.parse(readFileSync(NOSEG_FILE, 'utf8'));
  const now = Date.now();
  for (const k of Object.keys(j || {})) if (now - Number(j[k] || 0) < NOSEG_TTL) noSeg[k] = Number(j[k]);
  if (Object.keys(noSeg).length) log('  「无待播段」短期跳过表: ' + Object.keys(noSeg).length + ' 门（' + Math.round(NOSEG_TTL / 60000) + ' 分钟 TTL）');
} catch (_) { }
const saveNoSeg = () => { try { writeFileSync(NOSEG_FILE, JSON.stringify(noSeg)); } catch (_) { } };
const addNoSeg = (name) => { if (!name) return; noSeg[name] = Date.now(); saveNoSeg(); log('  ⏭ 记入「无待播段」短期跳过（' + Math.round(NOSEG_TTL / 60000) + ' 分钟，不算完成）: ' + String(name).slice(0, 22)); };
const delNoSeg = (name) => { if (name && noSeg[name]) { delete noSeg[name]; saveNoSeg(); } };
const inNoSeg = (name) => !!(name && noSeg[name] && Date.now() - noSeg[name] < NOSEG_TTL);

let fastClose = {};        // 课程名 → 连续"播放器秒关"次数
let handled = 0, segTotal = 0, sinceEnum = 0;
let courses = [];
let current = null;       // 当前认领的课程 {name,cat,code}
let courseTries = 0;      // 当前课程：进入课程页尝试播放的次数（「播不动」防呆用）
let coursePlayed = 0;     // 当前课程：真正播出去的墙钟秒数累计
// ★ Bug2 修复（2026-10-19）：驱动必须**会自己让位**给 cc-cycle 做分类轮转。
//   · IDLE_EXIT：连续 N 次"认领不到课"（本分类没活干了）→ 退出，让主管重新读学时选下一个分类
//   · NOPROG_EXIT：连续 N 分钟没有任何播完的段（卡死/被限流）→ 退出，换一轮重来
const IDLE_EXIT = Number(A.idleexit || 4);
const NOPROG_EXIT = Number(A.noprog || 25) * 60 * 1000;
let idleRounds = 0;
let lastProgress = Date.now();
let replayTries = {};     // 课程名 → 已补录次数（重看最后一段补账差）
const REPLAY = Number(A.replay || 0);   // 0 = 关闭补录（默认；课级完成由服务端 completions/check 判定）

for (let tick = 1; tick <= 100000; tick++) {
  /* ★ Bug2 修复（放在**每轮开头**）：所有分支都以 continue 结束，放在循环尾部根本执行不到。
   *   连续 N 分钟没有播完任何一段（一段都没推进）→ 主动退出让位给 cc-cycle，避免"驱动永不退出 → 主管永远等不到轮转"。 */
  if (Date.now() - lastProgress > NOPROG_EXIT) {
    log('⛔ 连续 ' + Math.round(NOPROG_EXIT / 60000) + ' 分钟没有任何播完的段（累计 ' + segTotal + ' 段）→ 主动退出让位');
    process.exit(0);
  }
  try {
    if (!tab.ws || tab.ws.readyState !== 1) { tab = await pickTab(); if (!tab) { await sleep(10000); continue; } log('重连 tab=' + tab.targetId.slice(0, 6)); }
    await killUserscript(tab);
    // ★ 2026-10-18：每轮幂等装一次猎捕器（300ms 轮询：muted + 压倍速 + 拉起）。
    //   实测坑：`播放器页 → 返回课程列表 → 再进下一段` 之后**新起的 video 元素是 1x**，
    //   而猎捕器只在 playFirstSegment 里装过 → 页面重渲染后 setInterval 静默死掉，
    //   倍速掉回 1x（日志出现 `@1x` / 实速 0.6），学时增长直接腰斩。
    try { await installHunter(tab); } catch (_) { }
    const s = await pageState(tab);
    if (!s) { await sleep(5000); continue; }

    /* ---- 启动即接管：页面已经在播放器/课程页时，把当前课程认下来，免得别的实例也来做 ---- */
    if (!current && (s.onPlayer || s.onCourse)) {
      const nm = await tab.ev(`(function(){
        var t=(document.body.innerText||'').replace(/\\s+/g,' ');
        var m=t.match(/课程：([^ ]{2,60}?)\\s*(?=观看进度|$)/);
        return m ? m[1].trim() : null;
      })()`);
      if (nm) {
        await claimCourse(nm, TAG, { port: PORT });
        current = { name: nm, cat: null };
        const snap = claimsSnapshot();
        const others = Object.keys(snap).filter(k => snap[k].tag && snap[k].tag !== TAG).length;
        log('  接管当前课程: ' + nm.slice(0, 30) + '（别的实例占用 ' + others + ' 门）');
      }
    }

    /* ---- PLAY：正在播 ---- */
    if (s.onPlayer && s.video) {
      if (current && current.name) touchClaims([current.name], TAG);   // 心跳：只续当前这门
      /* ★★ 2026-10-19 修「最后 0.3 秒永远不记账」（实测：段19 起播 307.3/311 → 5s 后 310.7 → 走人
       *   → 平台 max_position_sec 卡在 310.7 < duration 311 → completed 永远 false → 该段无限重进）。
       *   服务端口径（抓包实测）：max_position_sec = 历次上报 position_sec 的最大值，
       *   且**按 1.25x 墙钟封顶**（40s 墙钟只 +50s，比值恒定 0.65@2x）。所以：
       *   · 必须真的把 position 报到 >= duration（旧代码 dur-1.5 就跳走，永远差 1.5 秒）
       *   · 报完还要留 3 秒让站点发「ended/暂停」那次 checkpoint，否则那次上报根本没发出去 */
      if (s.video.dur && s.video.cur >= s.video.dur - 0.2) {
        // ★★ 死循环修复 v2（2026-10-15）：只设 mode 是没用的 —— COURSE 分支的条件是 `s.onCourse`，
        //    而视频停在末尾时**页面还在播放器上**（s.onPlayer），分支不匹配 → 又落回 PLAY → 每 3 秒转一圈。
        //    必须**真的点「返回课程列表」离开播放器**，之后 COURSE 分支才会命中。
        log(`段播完 ${s.video.cur.toFixed(1)}/${s.video.dur}（真到末尾）→ 等 3s 让站点上报，再点返回课程列表`);
        segTotal++; lastProgress = Date.now();
        await sleep(3000);
        const left = await tab.clickText('返回课程列表');
        await sleep(6000);
        if (!left) { log('  ⚠ 没找到「返回课程列表」→ 直接回培训页'); await backToTraining(tab, log); mode = 'PICK'; sinceEnum = 0; await sleep(3000); continue; }
        mode = 'COURSE';
        continue;
      }
      const r = await waitSegment(tab, segTotal + 1);
      if (r.segs) { segTotal += r.segs; lastProgress = Date.now(); }
      if (r.wall) coursePlayed += r.wall;
      if (r.res === 'done' || r.res === 'gone') { mode = 'COURSE'; await sleep(4000); }
      else { mode = 'COURSE'; await sleep(3000); }
      continue;
    }

    /* ---- COURSE：课程详情页 ---- */
    if (s.onCourse) {
      if (current && current.name) touchClaims([current.name], TAG);
      const seg = await pendingSegs(tab);
      const pend = seg.pend;
      if (pend === 0) {
        /* ★★ 2026-10-19 修 Bug1（死循环总根因）：
         *   旧代码这里 `releaseCourse(name, TAG, true)` —— 只要"没看到待播段"就写 done:true。
         *   但"没看到待播段"有**两种完全不同的含义**：
         *     ① 平台口径真的做完了（卡片显示「已完成」，段全是「重看」）
         *     ② 我根本进错课了 / 列表还没渲染出来（假象）
         *   旧代码把 ② 也当 ① 写墓碑 → 平台仍显示未学习 → 认领表被假墓碑堵死
         *   → "未完成 9 门，已完成标记 9" 死循环（19:44~19:48 实测）。
         *   现在：**绝不在这里写 done**。done 只由「培训页卡片状态=已完成/已学习」决定（见 PICK 分支）。
         *   这里只做：有「重看」段就先补录一次，补不动了再释放认领 + 20 分钟短期跳过。 */
        const tries = current ? (replayTries[current.name] || 0) : 0;
        /* ★ 2026-10-19 重要实测：全 4 段都记成 completed:true（max_position 665.94 / dur 665.88）时，
         *   接口仍然返回 `course_completed:false` —— **课级完成是进课程页时由 /api/v1/completions/check
         *   在服务端判定的**，跟"我有没有把最后一段再播一遍"无关。
         *   ⇒ 所以「重看补录」默认**关闭**（否则每门课白播一整段，实测 666s≈9 分钟/次，8 门≈1.2 小时纯浪费）。
         *   只在显式给 --replay=1 时才补录（留给历史 2x 账差遗留的课做人工干预）。 */
        if (REPLAY > 0 && seg.watched > 0 && current && tries < REPLAY) {
          replayTries[current.name] = tries + 1;
          log('  ⏮ 无待播段但 ' + seg.watched + ' 段是「重看/重播」→ 第 ' + (tries + 1) + '/' + REPLAY + ' 次补录（--replay 显式开启）');
          const ok = await playLastWatched(tab, log);
          if (ok) { mode = 'PLAY'; await sleep(1500); continue; }
        }
        log('  ⚠ 课程页无「播放/继续」段（总段 ' + seg.total + '，重看 ' + seg.watched + '）→ 不标完成，只释放认领 + 短期跳过');
        if (current && current.name) { releaseCourse(current.name, TAG); addNoSeg(current.name); }
        current = null; courseTries = 0; coursePlayed = 0;
        await backToTraining(tab, log);
        mode = 'PICK'; sinceEnum = 0;
        await sleep(3000);
        continue;
      }
      log('  课程页待播段=' + pend + '（已看完 ' + seg.watched + '）→ 点播放');
      // ★★ 2026-10-18「播不动」防呆（历史事故：能打开但播不了 → 起播→秒关→回列表→再进同一门，学时零增长）
      //   判据：**这门课连续 4 次尝试、累计真正播放时长 < 30 秒**，还停在课程页 → 记跳过、换下一门。
      //   正常课不会命中（任何一段真播了 30 秒以上，coursePlayed 就上去了）。
      courseTries++;
      if (courseTries >= 4 && coursePlayed < 30) {
        log('  ⛔ 本课连续 ' + courseTries + ' 次只播了 ' + Math.round(coursePlayed) + 's（播不动）→ 跳过换课');
        if (current && current.name) addSkip(current.name, '播不动');
        if (current && current.name) releaseCourse(current.name, TAG);
        current = null; courseTries = 0; coursePlayed = 0;
        await backToTraining(tab, log);
        mode = 'PICK'; sinceEnum = 0;
        await sleep(3000);
        continue;
      }
      const v0 = await playFirstSegment(tab, log);
      if (!v0) {
        log('  ⚠ 段未起播，等 8s 重试');
        await sleep(8000);
        continue;
      }
      mode = 'PLAY';
      continue;
    }

    /* ---- PICK：培训页选课 ---- */
    if (s.onTrain) {
      if (sinceEnum <= 0) {
        await waitTrainRender(tab);
        // ★★ 2026-10-18 结论：实测【展开一个分类后，其他两个会从 DOM 消失】
        //   （MUI 手风琴 + 页面重渲染），所以【不能】在同一个页面里逐个分类枚举。
        //   正确做法：一个分类一个进程 —— 用 --cat=0 / 1 / 2 分别跑。
        //   实测：--cat=0（小初高公需）能枚举到 36 门、其中未完成 35 门。
        await expand(tab, CAT, log);
        courses = await enumerate(tab, CAT);
        if (!courses.length) {
          for (let r = 0; r < 4 && !courses.length; r++) {
            log('  ⚠ 枚举 0 门 → 重展开(' + (r + 1) + '/4)');
            await sleep(6000); await expand(tab, CAT, log); courses = await enumerate(tab, CAT);
          }
        }
        if (!courses.length) { log('  ⚠ 仍 0 门，20s 后重试'); await sleep(20000); continue; }
        // ★ 2026-10-18：停在培训页的这一刻，把**平台真实学时**落盘（runs/cc-stats-cache.json）。
        //   平台只在培训页渲染「已修 x / 达标 y 学时」和分类明细，播放器/课程页读不到；
        //   看护程序（cc-watch）与轮转主管（cc-cycle）都靠这份缓存显示进度，避免"学时 ?"。
        try {
          const st = await tab.ev(`(function(){
            var t=(document.body.innerText||'').replace(/\\s+/g,' ');
            var m=t.match(/已修\\s*([\\d.]+)\\s*\\/\\s*达标\\s*(\\d+)\\s*学时/);
            var cats=[];
            Array.from(document.querySelectorAll('.MuiAccordion-root')).forEach(function(a){
              var h=a.querySelector('h3'); if(!h) return; var x=(h.innerText||'').replace(/\\s+/g,' ');
              var mm=x.match(/([\\d.]+)\\s*\\/\\s*达标\\s*(\\d+)\\s*学时/);
              var nm=/小初高公需/.test(x)?0:(/初中学段通识/.test(x)?1:(/初中数学|专业课/.test(x)?2:null));
              if(nm!==null) cats.push({cat:nm, done:mm?Number(mm[1]):null, target:mm?Number(mm[2]):null, raw:x.slice(0,46)});
            });
            return JSON.stringify({total:m?{done:Number(m[1]),target:Number(m[2])}:null, cats:cats, onTrain:true, at:Date.now()});
          })()`);
          if (st) {
            writeFileSync('runs/cc-stats-cache.json', st);
            const o = JSON.parse(st);
            if (o.total) log('  📊 平台学时 ' + o.total.done + '/' + o.total.target + ' | ' + o.cats.map(c => '分类' + c.cat + ' ' + c.done + '/' + c.target).join(' · '));
          }
        } catch (_) { }
        const undone = courses.filter(c => c.undone);
        log(`[${tick}] ${CAT === null ? '全部' : CATNAMES[CAT]} 枚举 ${courses.length} 门 / 未完成 ${undone.length} 门`);
        /* ★★ 2026-10-19 自愈（Bug1）：认领表里标了 done、但**平台枚举里仍是未完成** → 那条 done 是假的。
         *   旧 bug 每天都会在这里堆假墓碑，堆满后整个认领表就废了（"没有可认领的课"死循环）。
         *   平台口径优先：平台说没完成，就把墓碑删掉，让这门课重新变成可认领。 */
        {
          const snap0 = claimsSnapshot();
          const undoneSet = new Set(undone.map(c => c.name));
          let healed = 0;
          for (const k of Object.keys(snap0)) {
            if (snap0[k].done && undoneSet.has(k)) { releaseCourse(k, TAG); healed++; }
          }
          if (healed) log('  🩹 自愈：清掉 ' + healed + ' 条「平台未完成却标 done」的假墓碑');
          /* ★ 2026-10-19：done 的**唯一合法来源** = 平台卡片自己说「已完成/已学习」。
           *   这里把平台口径的完成写进认领表（墓碑），让后续实例不必再进这门课。
           *   （旧代码是在"我看不到待播段"时写 done —— 语义完全错了，就是这么堵死认领表的。） */
          let marked = 0;
          for (const c of courses) {
            if (c.undone) continue;
            if (snap0[c.name] && snap0[c.name].done) continue;
            releaseCourse(c.name, TAG, true); marked++;
          }
          if (marked) log('  ✔ 平台口径已完成 ' + marked + ' 门 → 写入 done 墓碑（不再重复进课）');
        }
        if (!undone.length) { log('✅ 本分区全部完成'); break; }
        sinceEnum = 6;   // 每 6 次选课重新枚举一次
        handled = courses.length - undone.length;
      }
      sinceEnum--;
      const undone = courses.filter(c => c.undone);
      // ★ 跨进程认领：最多只预留 RESERVE 门（避免一个实例把全部课都占了，把另一个实例饿死）
      const RESERVE = 2;
      let mine = myClaims(TAG);
      const free = [];
      for (const c of undone) {
        if (skip.has(c.name)) continue;
        if (inNoSeg(c.name)) continue;          // 20 分钟内进过且没待播段 → 先躲开（不算完成）
        if (mine.indexOf(c.name) >= 0) { free.push(c); continue; }
        if (mine.length + free.length >= RESERVE) break;
        // eslint-disable-next-line no-await-in-loop
        if (await claimCourse(c.name, TAG, { port: PORT })) { mine = myClaims(TAG); free.push(c); }
      }
      if (!free.length) {
        const snap = claimsSnapshot();
        const others = Object.keys(snap).filter(k => snap[k].tag && snap[k].tag !== TAG).length;
        const doneN = Object.keys(snap).filter(k => snap[k].done).length;
        const nosN = undone.filter(c => inNoSeg(c.name)).length;
        if (skip.size) { log('  本轮全部跳过（' + skip.size + ' 门）—— 持久化跳过表保留，不清空'); }
        idleRounds++;
        log(`  没有可认领的课（未完成 ${undone.length} 门；无待播段暂避 ${nosN} 门；别的实例占 ${others} 门；已完成标记 ${doneN}）→ 重新枚举 [空转 ${idleRounds}/${IDLE_EXIT}]`);
        /* ★ Bug2 修复：认领不到就**退出让位**，别在这里原地转圈把 cc-cycle 的轮转时机卡死。
         *   （退出 code=0 → cc-cycle 会重新读学时、判断分类是否达标、再决定跑哪个分类） */
        if (idleRounds >= IDLE_EXIT) {
          log('⛔ 连续 ' + idleRounds + ' 次认领不到任何课 → 主动退出，让 cc-cycle 轮转/复核学时');
          process.exit(0);
        }
        sinceEnum = 0; await sleep(8000); continue;
      }
      idleRounds = 0;
      const target = free[0];
      log(`  ▶ 未完成 ${undone.length} 门，我占 ${free.length} 门 → ${target.name.slice(0, 30)}${target.code ? ' [' + target.code + ']' : ''}`);
      if (await openCourse(tab, target.name, log, target.cat, target.code)) {
        mode = 'COURSE';
        // ★ 进课当下就认领：否则别的实例在枚举时会以为这门没人做
        await claimCourse(target.name, TAG, { port: PORT });
        current = { name: target.name, cat: target.cat, code: target.code };
        courseTries = 0; coursePlayed = 0;   // 换课了，防呆计数重置
        delNoSeg(target.name);               // 这次真进来了，撤掉短期跳过
        saveRun({ tag: TAG, target: target.name, code: target.code, cat: target.cat, mode, at: Date.now(), segTotal });
      } else {
        addSkip(target.name, '打不开'); releaseCourse(target.name, TAG);
        log('  ✗ 打不开，释放并跳过');
      }
      await sleep(2500);
      continue;
    }

    /* ---- HOME：其它页态 ---- */
    if (mode !== 'HOME') log('  页态=' + flag(s) + ' → 回培训页');
    if (!await ensureTraining(tab, log)) { log('  ✗ 回不去培训页，刷新'); await tab.reload(); await sleep(12000); }
    mode = 'PICK';
    sinceEnum = 0;
    await sleep(2000);
  } catch (e) {
    log('  异常: ' + String(e && e.message).slice(0, 140));
    await sleep(8000);
  }
}
log('==== 结束：本分区处理 ' + handled + ' 门 / 累计播完 ' + segTotal + ' 段 ====');
process.exit(0);
