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
import { Tab, listCcTabs, acquireTab, closeExtraTabs, pageState, ensureTraining, expand, enumerate, openCourse, backToTraining, playFirstSegment, killUserscript, claimCourse, releaseCourse, myClaims, claimsSnapshot, touchClaims, sleep, CATNAMES } from './cc-lib.mjs';
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;

const PORT = Number(A.port || 9228);
const TAB = Number(A.tab || 0);
const CAT = (A.cat === undefined || A.cat === true) ? null : Number(A.cat);
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

/** 一门课还有几段待播（课程详情页） */
async function pendingSegs(tab) {
  return await tab.ev(`(function(){
    return Array.from(document.querySelectorAll('.MuiListItem-root, .MuiListItemButton-root')).filter(function(e){
      if (/编码[:：]/.test(e.innerText||'')) return false;
      return Array.from(e.querySelectorAll('button')).some(function(b){ return /^(播放|继续|重播)$/.test((b.innerText||'').trim()); });
    }).length;
  })()`);
}

/** 播放当前视频直到播完；返回 'done' | 'gone' | 'stall' */
async function waitSegment(tab, idx) {
  let s0 = await pageState(tab);
  if (!s0 || !s0.video) return 'gone';
  const v0 = s0.video, t00 = Date.now();
  let last = v0.cur, lastMove = Date.now(), tries = 0, lastLog = 0, lastPause = Date.now();
  let maxCur = v0.cur;                 // ★ 历史最大位置（见下面的"回卷判据"）
  log(`  段${idx} 起播 ${v0.cur}/${v0.dur} @${v0.rate}x`);
  for (let g = 0; g < 3000; g++) {
    await sleep(POLL);
    const s = await pageState(tab);
    if (!s) continue;
    if (!s.video) {
      const wall = Math.round((Date.now() - t00) / 1000);
      log(`  段${idx} 播放器关闭（页面=${flag(s)} 墙钟=${wall}s）`);
      return s.onCourse ? 'done' : 'gone';
    }
    if (s.video.dur && s.video.cur >= s.video.dur - 1.5) {
      const wall = (Date.now() - t00) / 1000;
      log(`  ✔ 段${idx} 播完 ${s.video.cur}/${s.video.dur} 墙钟=${Math.round(wall)}s 实速=${Math.round((s.video.cur - v0.cur) / wall * 100) / 100}`);
      return 'done';
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
        return 'done';
      }
    }
    if (Math.abs(s.video.cur - last) > 0.4) { last = s.video.cur; lastMove = Date.now(); }
    if (Date.now() - lastLog > 120000) {
      lastLog = Date.now();
      const wall = (Date.now() - t00) / 1000;
      log(`  …段${idx} ${s.video.cur}/${s.video.dur} @${s.video.rate}x${s.video.paused ? '(暂停)' : ''} 实速=${Math.round((s.video.cur - v0.cur) / wall * 100) / 100} ${s.pct ? 'pct=' + s.pct : ''}`);
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
      if (tries >= 6) return 'stall';
    }
  }
  return 'stall';
}

/* ---------------- 主循环 ---------------- */
log('==== cc-auto v4 启动 port=' + PORT + ' tab=' + TAB + ' cat=' + (CAT === null ? 'ALL' : CAT + '(' + CATNAMES[CAT] + ')') + ' ====');
await pickTab();
if (!tab) { log('❌ 没有 ccjyxy 标签（也开不出来）'); process.exit(1); }
log('tab=' + tab.targetId.slice(0, 8) + ' tag=' + TAG);

let mode = 'HOME';        // HOME | PLAY | COURSE | PICK
let skip = new Set();     // 本轮跳过的课程（打不开/播不动）
let handled = 0, segTotal = 0, sinceEnum = 0;
let courses = [];
let current = null;       // 当前认领的课程 {name,cat}

for (let tick = 1; tick <= 100000; tick++) {
  try {
    if (!tab.ws || tab.ws.readyState !== 1) { tab = await pickTab(); if (!tab) { await sleep(10000); continue; } log('重连 tab=' + tab.targetId.slice(0, 6)); }
    await killUserscript(tab);
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
      if (s.video.dur && s.video.cur >= s.video.dur - 1.5) {
        // ★★ 死循环修复 v2（2026-10-15）：只设 mode 是没用的 —— COURSE 分支的条件是 `s.onCourse`，
        //    而视频停在末尾时**页面还在播放器上**（s.onPlayer），分支不匹配 → 又落回 PLAY → 每 3 秒转一圈。
        //    必须**真的点「返回课程列表」离开播放器**，之后 COURSE 分支才会命中。
        log(`段播完 ${s.video.cur}/${s.video.dur}（尾部）→ 点返回课程列表`);
        segTotal++;
        const left = await tab.clickText('返回课程列表');
        await sleep(6000);
        if (!left) { log('  ⚠ 没找到「返回课程列表」→ 直接回培训页'); await backToTraining(tab, log); mode = 'PICK'; sinceEnum = 0; await sleep(3000); continue; }
        mode = 'COURSE';
        continue;
      }
      const r = await waitSegment(tab, segTotal + 1);
      if (r === 'done' || r === 'gone') { segTotal++; mode = 'COURSE'; await sleep(4000); }
      else { mode = 'COURSE'; await sleep(3000); }
      continue;
    }

    /* ---- COURSE：课程详情页 ---- */
    if (s.onCourse) {
      if (current && current.name) touchClaims([current.name], TAG);
      const pend = await pendingSegs(tab);
      if (pend === 0) {
        log('  ✓ 课程页无待播段 → 本课结束，回培训页');
        if (current && current.name) releaseCourse(current.name, TAG, true);
        await backToTraining(tab, log);
        mode = 'PICK'; sinceEnum = 0;
        await sleep(3000);
        continue;
      }
      log('  课程页待播段=' + pend + ' → 点播放');
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
        await expand(tab, CAT, log);
        courses = await enumerate(tab, CAT);
        if (!courses.length) {
          for (let r = 0; r < 4 && !courses.length; r++) {
            log('  ⚠ 枚举 0 门 → 重展开(' + (r + 1) + '/4)');
            await sleep(6000); await expand(tab, CAT, log); courses = await enumerate(tab, CAT);
          }
        }
        if (!courses.length) { log('  ⚠ 仍 0 门，20s 后重试'); await sleep(20000); continue; }
        const undone = courses.filter(c => c.undone);
        log(`[${tick}] ${CAT === null ? '全部' : CATNAMES[CAT]} 枚举 ${courses.length} 门 / 未完成 ${undone.length} 门`);
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
        if (mine.indexOf(c.name) >= 0) { free.push(c); continue; }
        if (mine.length + free.length >= RESERVE) break;
        // eslint-disable-next-line no-await-in-loop
        if (await claimCourse(c.name, TAG, { port: PORT })) { mine = myClaims(TAG); free.push(c); }
      }
      if (!free.length) {
        const snap = claimsSnapshot();
        const others = Object.keys(snap).filter(k => snap[k].tag && snap[k].tag !== TAG).length;
        const doneN = Object.keys(snap).filter(k => snap[k].done).length;
        if (skip.size) { log('  本轮全部跳过（' + skip.size + ' 门），清空跳过表'); skip.clear(); }
        log(`  没有可认领的课（未完成 ${undone.length} 门；别的实例占 ${others} 门；已完成标记 ${doneN}）→ 重新枚举`);
        sinceEnum = 0; await sleep(8000); continue;
      }
      const target = free[0];
      log(`  ▶ 未完成 ${undone.length} 门，我占 ${free.length} 门 → ${target.name.slice(0, 30)}`);
      if (await openCourse(tab, target.name, log)) {
        mode = 'COURSE';
        // ★ 进课当下就认领：否则别的实例在枚举时会以为这门没人做
        await claimCourse(target.name, TAG, { port: PORT });
        current = { name: target.name, cat: target.cat };
        saveRun({ tag: TAG, target: target.name, cat: target.cat, mode, at: Date.now(), segTotal });
      } else {
        skip.add(target.name); releaseCourse(target.name, TAG);
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
