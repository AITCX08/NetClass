/**
 * cx-auto.mjs — 学习通「任务点顺序驱动」v3（2026-10-15）
 *   node scripts/cx-auto.mjs --port 9227 [--secs 8] [--maxmins 240] [--quiz true|false]
 *
 * v3 的关键修正（v1/v2 都"快速跳过"、视频不起播的根因）：
 *  1) **切任务点用页面自己的 `getTeacherAjax(courseId, clazzid, chapterId)`**
 *     —— 它是站内 AJAX（jQuery.get /mycourse/studentstudyAjax），自己带合法上下文，
 *     **完全绕开 `enc校验失败`**；也不点树节点（点树节点会触发站点自己的自动跳转 → 乱跳）。
 *  2) 页内代理 runs/cx/agent.js：枚举叶子任务点（自带 `.jobUnfinishCount` 的 H5 = 叶子，
 *     容器没有它）、读视频状态、给播放按钮的**顶层坐标**（累加每层 iframe offset + elementFromPoint 复核）。
 *  3) ★ **AJAX 切点后媒体不会自己下载**（readyState=0/dur=null/netState=1，CDP 抓包看到 mp4 返回 206 却立刻 ERR_ABORTED）；
 *     唯一有效动作是显式 `video.load()`（`A.kick()`）。只调 play() 没用，真实鼠标点播放按钮也没用
 *     （那时按钮还是 0×0 未初始化）。
 *  4) 倍速：站点在 ratechange 后**同 tick** 把 playbackRate 写回 1 → 用独立模块 runs/cx/cx-rate.js
 *     （实例级 defineProperty 让站点读到目标值 + watchdog 用原生 setter 压回）。实测 wallRate=1.499。
 *  5) 章测试：遇到 QUIZ 动作时调用 scripts/cx-answer-quiz.mjs（解密→DeepSeek→勾选→提交）。
 *  6) 队列顺序：始终挑**树里第一个未完成叶子**（已完成的自然跳过），不靠"下一节"按钮。
 *
 * 完成判定：树里叶子的 `un===0`（`un>0` = 该点未完成）。工作期间树状态不会变（侧边栏不随 AJAX 刷新），
 * 所以定期整页 reload 拿权威状态 —— 这也是"已完成的不重复做"的依据。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const AGENT_SRC = readFileSync(join(REPO, 'runs', 'cx', 'agent.js'), 'utf8');
const RATE_SRC = readFileSync(join(REPO, 'runs', 'cx', 'cx-rate.js'), 'utf8');

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) A[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
const PORT = Number(A.port || 9227);
const SECS = Number(A.secs || 8);
const MAXMINS = Number(A.maxmins || 240);
const DO_QUIZ = String(A.quiz) !== 'false';           // 章测试默认真答（--quiz false 跳过）
const LAPTOP_MODE = String(A.laptop) === 'true';      // 在笔记本本机跑（不经常驻守护）
const T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[' + new Date().toTimeString().slice(0, 8) + ']', ...a);

async function conn() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find(t => t.type === 'page' && /chaoxing\.com/.test(t.url) && !/tampermonkey/.test(t.url));
  if (!p) return null;
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let seq = 0;
  const send = (m, params = {}, ms = 30000) => new Promise(res => {
    const id = ++seq; const on = ev => { const x = JSON.parse(ev.data); if (x.id === id) { ws.removeEventListener('message', on); res(x); } };
    ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method: m, params }));
    setTimeout(() => res({ timeout: true }), ms);
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.timeout) return null;
    if (r.result && r.result.exceptionDetails) return { __err: String((r.result.exceptionDetails.exception || {}).description || '').slice(0, 200) };
    const rr = r.result && r.result.result;
    return rr ? rr.value : null;
  };
  return { ws, send, ev, url: p.url };
}
const okWs = c => c && c.ws.readyState === 1;
async function mouse(c, x, y) {
  try {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(70);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(70);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } catch (e) { }
}
async function ensureAgent() {
  if (!okWs(c)) { c = await conn(); if (!okWs(c)) return false; }
  const v = await c.ev('window.__cxAgentV || 0');
  if (v !== 2) { await c.ev(AGENT_SRC); await sleep(500); }
  const rt = await c.ev('window.__cxRateV || 0');
  if (rt !== 1) { await c.ev(RATE_SRC); await sleep(300); }
  const t = await c.ev('typeof window.__cxAgent');
  if (t !== 'object') { await c.ev(AGENT_SRC); await sleep(500); }
  return true;
}
async function step() {
  if (!okWs(c)) { c = await conn(); if (!okWs(c)) return null; }
  const raw = await c.ev('(function(){ if (window.__cxAgentV !== 2) return JSON.stringify({act:"NOAGENT"}); try { return JSON.stringify(window.__cxAgent.step()); } catch(e){ return JSON.stringify({__err: String(e && e.stack || e).slice(0,200)}); } })()');
  if (!raw) return null;
  if (raw.__err) return { __err: raw.__err };
  try { return JSON.parse(raw); } catch (e) { return null; }
}
/** 面板/人工暂停：面板按暂停会写 ncCx:paused=1（v1 的老约定）→ 驱动器必须尊重 */
async function isPaused() {
  try { const v = await c.ev(`(function(){ try { return localStorage.getItem('ncCx:paused'); } catch(e){ return null; } })()`); return v === '1'; } catch (e) { return false; }
}
/** 整页 reload 刷新侧边栏树状态，然后重新装代理 */
async function reloadAndWait() {
  try { await c.ev('location.reload()'); } catch (e) { }
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    if (!okWs(c)) c = await conn();
    if (!okWs(c)) continue;
    const n = await c.ev('document.querySelectorAll(\'[onclick^="getTeacherAjax"]\').length');
    if (typeof n === 'number' && n > 0) { await ensureAgent(); return true; }
  }
  return false;
}

let c = await conn();
if (!okWs(c)) { log('没有 chaoxing 页面'); process.exit(1); }
log('cx-auto v3 启动 port=' + PORT + ' secs=' + SECS + ' maxmins=' + MAXMINS);
await ensureAgent();

const ST = { done: 0, skipped: 0, quiz: 0, rounds: 0, quizSeen: new Set() };
let curId = null, curTitle = '', lastCur = -1, stallSec = 0, tries = 0, lastLog = 0;
let processed = 0, retryRounds = 0;

while (Date.now() - T0 < MAXMINS * 60000) {
  // 面板/人工暂停开关（人工排查时用它让驱动别插手，避免把视频重新 goto 导致进度清零）
  if (await isPaused()) {
    if (!ST.pauseLogged) { log('⏸ 已暂停（ncCx:paused=1），等待恢复…'); ST.pauseLogged = true; }
    await sleep(8000);
    continue;
  }
  if (ST.pauseLogged) { log('▶ 恢复运行'); ST.pauseLogged = false; }

  const s = await step();
  if (!s) { await sleep(4000); continue; }
  if (s.__err) { log('step 异常: ' + s.__err); await sleep(4000); continue; }
  if (s.act === 'NOAGENT') { await ensureAgent(); await sleep(2000); continue; }

  if (s.act === 'ALLDONE') {
    // 全部"未完成叶子"都被跳过 → 清一次跳过名单重试（很多是起播失败，值得再试）
    if (s.skipped > 0 && retryRounds < 3) {
      retryRounds++;
      log('↺ 可推进的点都用完了，但还有 ' + s.skipped + ' 个被跳过的点 → 清名单重试第 ' + retryRounds + ' 轮');
      await c.ev('(function(){ try { localStorage.removeItem("ncCx:skip:266554494"); } catch(e){} })()');
      await reloadAndWait();
      await sleep(3000);
      continue;
    }
    log('✅ 无可推进的未完成叶子任务点：树里已完成 ' + s.done + '/' + s.total + '，跳过名单 ' + s.skipped);
    break;
  }

  // ★★ 定期"回补"（2026-10-15 主线补）：把"仍未完成"的节点的跳过标记清掉，让它们**在做题过程中**就重新入队。
  //   已有的重试只在 `ALLDONE`（所有未完成叶子都被跳过）时才触发 —— 而只要有别的点还能推进就永远不满足，
  //   于是早期被跳过的点（实测 1.2.4 章测试等 15 个）会被晾在那里没人管，日志那句"稍后回补"形同虚设。
  //   这里每 ~12 个动作周期清一次，代价极小。
  ST.acts = (ST.acts || 0) + 1;
  if (ST.acts % 12 === 0) {
    const un = await c.ev('(window.__cxAgent && window.__cxAgent.unskipUndone) ? window.__cxAgent.unskipUndone() : 0');
    if (un) log('  ↻ 回补：清掉 ' + un + ' 个未完成节点的跳过标记，重新入队');
  }

  if (s.act === 'GOTO') {
    const isNew = String(s.nextId) !== String(curId);
    if (isNew) {
      ST.rounds++;
      curId = s.nextId; curTitle = s.next; lastCur = -1; stallSec = 0; tries = 0;
      ST.arrivedAt = Date.now(); ST.graceLogged = 0;
      log('#' + ST.rounds + ' → ' + curTitle + '  (id=' + curId + ')  树进度 ' + s.done + '/' + s.total + ' [切换:' + s.goto + ']');
      await sleep(9000);
      // 落地确认：AJAX 换正文需要时间（首次 goto 后 url 的 chapterId 会短暂与 curChapterId 不一致，属正常）
      const nowCh = await c.ev('(document.getElementById("curChapterId")||{}).value');
      if (String(nowCh) !== String(s.nextId)) await sleep(7000);
    } else {
      // 同一目标重复 GOTO（页面没切过去）→ 再点一次
      ST.gotoRetry = (ST.gotoRetry || 0) + 1;
      if (ST.gotoRetry % 3 === 1) log('   ↻ 重新切换 ' + String(curTitle).slice(0, 22) + '（curChapterId 未变化，第 ' + ST.gotoRetry + ' 次）');
      const g2 = await c.ev('window.__cxAgent.goto(' + JSON.stringify(String(s.nextId)) + ')');
      if (ST.gotoRetry > 12) { log('   ⚠ 该点切不过去，跳过'); await c.ev('window.__cxAgent.skip(' + JSON.stringify(String(s.nextId)) + ')'); ST.skipped++; ST.gotoRetry = 0; }
      await sleep(7000);
    }
    continue;
  }

  if (s.act === 'PLAY' || s.act === 'PLAYING') {
    if (s.nextId) curId = s.nextId;
    ST.noworkStreak = 0;
    const v = s.vid;
    if (s.act === 'PLAY') {
      tries++;
      const p = s.play || {};
      if (tries <= 2) log('   起播: mode=' + p.mode + (p.at ? ' at=' + p.at.x + ',' + p.at.y + ' inVp=' + p.at.inVp + ' hit=' + p.at.hit : '') + ' kick=' + JSON.stringify(p.kick || {}).slice(0, 110));
      if (p.at && p.mode === 'mouse') await mouse(c, p.at.x, p.at.y);
    }
    if (v) {
      if (v.cur !== lastCur) { stallSec = 0; lastCur = v.cur; } else stallSec += SECS;
      if (Date.now() - lastLog > 25000) {
        lastLog = Date.now();
        log('   ▶ ' + String(curTitle).slice(0, 22) + '  ' + v.cur + '/' + v.dur + 's  rate=' + v.rate + (v.paused ? ' [暂停]' : '') + '  树 ' + s.done + '/' + s.total);
      }
      if (v.dur > 0 && v.cur >= v.dur - 1.5) {
        // ★ 到末尾不等于"站点已记账"：站点要求观看时长 ≥ 总时长 90~100%，末尾几秒仍在累计；
        //   只有 ended=true 或进度真的停住（stall）才去刷新复核，避免把还没记完账的视频切掉。
        if (!v.ended && stallSec < 20) {
          if (Date.now() - lastLog > 20000) { lastLog = Date.now(); log('   ⏳ 接近结束 ' + v.cur + '/' + v.dur + '，等待记账…'); }
          await sleep(SECS * 1000);
          continue;
        }
        log('   ⏹ 视频结束 ' + v.cur + '/' + v.dur + '（ended=' + v.ended + '）');
        ST.videoFin = (ST.videoFin || 0) + 1;
        await sleep(9000);
        // 站点常常自己切到下一节（此时树状态还没刷新）；等一轮再看
        const nowCh = await c.ev('(document.getElementById("curChapterId")||{}).value');
        if (nowCh && String(nowCh) !== String(curId)) {
          log('   ✅ 站点已自动切走（' + curId + ' → ' + nowCh + '）');
          ST.done++;
        }
        // 每 3 个视频结束 → 整页刷新一次，拿"站点记账后的权威树状态"（侧边栏只随整页刷新更新）
        if (ST.videoFin % 3 === 0) {
          log('   ↻ 累计 ' + ST.videoFin + ' 个视频结束 → 整页刷新核对进度');
          await reloadAndWait();
        }
        continue;
      }
      if (stallSec > 180) {
        log('   ⚠ 视频 180s 无进展（' + v.cur + '/' + v.dur + '）→ 跳过该点，稍后回补');
        await c.ev('window.__cxAgent.skip(' + JSON.stringify(curId) + ')');
        ST.skipped++; await sleep(2000); continue;
      }
      if (tries > 8 && v.cur < 1) {
        log('   ⚠ 起播 8 次失败 → 跳过该点');
        await c.ev('window.__cxAgent.skip(' + JSON.stringify(curId) + ')');
        ST.skipped++; await sleep(2000); continue;
      }
      // 心跳：站点会不定期把播放暂停/降速，每 60s 补一次 load+play+倍速（只在真停住时动）
      if (v.paused && Date.now() - (ST.lastKick || 0) > 30000) {
        ST.lastKick = Date.now();
        const k = await c.ev('JSON.stringify(window.__cxAgent.kick())');
        log('   ↻ 心跳起播: ' + String(k).slice(0, 120));
      } else if (!v.paused && Date.now() - (ST.lastKick || 0) > 90000) {
        ST.lastKick = Date.now();
        await c.ev('(function(){ try { var r = window.__cxRateNow && window.__cxRateNow(); if (r && r.patched) { } } catch(e){} })()');
      }
      await sleep(SECS * 1000);
      continue;
    }
    await sleep(3000);
    continue;
  }

  if (s.act === 'QUIZ') {
    const qid = s.nextId || curId;
    if (ST.quizSeen.has(String(qid))) {
      if (ST.quizSeen.size >= 64) break;
      await sleep(3000);
      continue;
    }
    ST.quizSeen.add(String(qid));
    log('   📝 测验页 quiz=' + s.quiz + ' → ' + (DO_QUIZ ? '调用答题器作答并提交' : '（--quiz false）仅记录，跳过'));
    if (DO_QUIZ) {
      // 让出页面控制权：答题器要自己挂 Page 事件、驱动鼠标
      try {
        const r = spawnSync(process.execPath, [join(HERE, 'cx-answer-quiz.mjs'), '--port', String(PORT), '--submit'],
          { cwd: REPO, encoding: 'utf8', timeout: 12 * 60 * 1000 });
        const tail = String((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-6).join(' | ');
        log('     答题器: ' + tail.slice(0, 320));
        const done = /已完成|成绩|保存成功/.test(String(r.stdout || ''));
        ST.quizResult = ST.quizResult || {};
        ST.quizResult[qid] = done ? 'ok' : 'unknown';
      } catch (e) {
        log('     答题器异常: ' + String(e.message).slice(0, 160));
      }
      c = await conn();
      await ensureAgent();
    } else {
      await c.ev('window.__cxAgent.skip(' + JSON.stringify(String(qid)) + ')');
    }
    ST.quiz++;
    await sleep(2000);
    continue;
  }

  // NOWORK：无视频、无题目（资料阅读 / PPT / 讨论）
  // ★ 关键：刚切过来的任务点内容可能还在加载（AJAX 拉正文要 5~20s），
  //   "刚来就没视频"不能立刻判空 —— 给 45 秒宽限期，超过才算无内容。
  const skipId = s.nextId || curId;
  const onNodeFor = Date.now() - (ST.arrivedAt || 0);
  if (onNodeFor < 45000) {
    if (!ST.graceLogged || Date.now() - ST.graceLogged > 20000) {
      ST.graceLogged = Date.now();
      log('   …等待加载（' + Math.round(onNodeFor / 1000) + 's/' + String(s.next || '').slice(0, 22) + ' cur=' + s.cur + '）');
    }
    await sleep(4000);
    continue;
  }
  // ★★ 无视频无题目的节点（"资料阅读 / PPT"类的无题形态）不要直接跳过！
  //   实测有两个这样的点（1.4.3.3 / 1.4.4）被直接跳过后**永远不完成**。
  //   超星对这类是**停留计时**完成（OCS 里叫 readweb.goto() + timing 秒）→ 给它一次"停留 + 复查"：
  //   在 45~120 秒区间里每 8 秒复查一次"树里 blue（已完成）数是否增加"，增加了就说明本站点记完账了。
  if (onNodeFor < 120000) {
    const blueNow = await c.ev(`(function(){ var rp=document.querySelectorAll('span.roundpoint'); var b=0; Array.from(rp).forEach(function(e){ if(/blue/.test(String(e.className||''))) b++; }); return b; })()`);
    if (ST.blueAtArrive == null) ST.blueAtArrive = Number(blueNow) || 0;
    if (Number(blueNow) > Number(ST.blueAtArrive)) {
      log('   ✓ 停留计时完成（blue ' + ST.blueAtArrive + ' → ' + blueNow + '）→ 继续下一个');
      ST.blueAtArrive = null; ST.noworkStreak = 0;
      await sleep(2000);
      continue;
    }
    if (!ST.graceLogged || Date.now() - ST.graceLogged > 20000) {
      ST.graceLogged = Date.now();
      log('   …停留待完成（' + Math.round(onNodeFor / 1000) + 's/120s）' + String(s.next || '').slice(0, 20) + ' blue=' + blueNow);
    }
    await sleep(8000);
    continue;
  }
  ST.blueAtArrive = null;
  log('   ○ 无视频无题目（' + String(s.next || curTitle).slice(0, 26) + ' id=' + skipId + ' cur=' + s.cur + '）→ 跳过该点，稍后回补');
  log('      正文线索: videoSrc=' + String(s.videoSrc).slice(0, 40) + ' cardsText=' + String(s.cardsText || '').slice(0, 70));
  if (skipId) await c.ev('window.__cxAgent.skip(' + JSON.stringify(String(skipId)) + ')');
  ST.skipped++;
  ST.noworkStreak = (ST.noworkStreak || 0) + 1;
  // ★ 连续多个点都"无内容"，高度怀疑是站点已经把某些点记完账、侧边栏状态过期（AJAJC 不刷新树）
  //   → 整页 reload 拿权威状态，避免一直在幻觉状态里空转
  if (ST.noworkStreak >= 4) {
    ST.noworkStreak = 0;
    log('   ↻ 连续 4 个无内容 → 整页刷新重扫侧边栏状态');
    await reloadAndWait();
    continue;
  }
  await sleep(2000);
}

log('结束：处理轮次 ' + ST.rounds + ' / 跳过 ' + ST.skipped + ' / 测验待答 ' + ST.quiz);
