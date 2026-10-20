/**
 * cc-cycle.mjs — 长春教师培训 90 学时「轮转主管」（一个分类一个驱动进程）
 *
 * 为什么需要它（2026-10-18 定位到的真因）：
 *   ① 平台是 MUI 手风琴：展开一个分类 → **另外两个分类折叠**。折叠时课程卡仍在 DOM 里，
 *      但 display:none → getBoundingClientRect().width === 0。
 *   ② 驱动用 cat=ALL 时会把三个分类依次展开，最后只有分类2 是展开的；
 *      于是分类0/1 的卡"宽 0" → 旧 openCourse 判为"列表里找不到" → 整课判死
 *      → 52 门课被写进跳过表 → 之后每轮"全部跳过"→ 无限重枚举（表现出来就是"乱跳、不做视频"）。
 *   ③ 平台硬保护：同账号第二个播放页 → report 接口 423 Locked。
 *   ⇒ 只能「一个分类一个驱动进程」串行跑，并且必须由**同一个守门人**看着：崩了重启、跑完换分类。
 *
 * 用法：
 *   node scripts/cc-cycle.mjs --port 9228 --tab 0
 *   node scripts/cc-cycle.mjs --port 9228 --only 0        # 只跑分类0（调试用）
 *   node scripts/cc-cycle.mjs --port 9228 --rounds 1      # 只轮一遍就退（不自循环）
 *
 * 状态文件：runs/cc-cycle.json（当前分类/驱动 pid/各分类学时，看护脚本直接读它）
 * 日志：runs/cc-cycle.log（主管自己） + runs/cc-driver.log（驱动 stdout，追加）
 */
import { spawn, execFileSync } from 'node:child_process';
import { readCcStats } from './cc-lib.mjs';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';

const A = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq > 2) { A[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  A[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
}

const PORT = Number(A.port || 9228);
const TAB = Number(A.tab || 0);
const ONLY = (A.only === undefined || A.only === true) ? null : Number(A.only);
const ROUNDS = Number(A.rounds || 0);              // 0 = 无限
// ★ 2026-10-20：三分类全达标后要【连续几轮确认】才收工退出。
//   原来全达标后只 sleep 600s 再核 → 永远空转（实测转了 5 小时）。
//   默认 3 轮（约 20 分钟）确认稳定后退出；--done-exit=1 可改成立即退出。
const DONE_CONFIRM = Math.max(1, Number(A['done-exit'] || A.doneExit || 3));
const CATNAMES = ['小初高公需', '初中学段通识', '专业课-初中数学'];
const CYCLE_JSON = 'runs/cc-cycle.json';
const CYCLE_LOG = 'runs/cc-cycle.log';
const DRV_LOG = 'runs/cc-driver.log';
if (!existsSync('runs')) mkdirSync('runs', { recursive: true });

const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => {
  const s = `[${stamp()}][cycle] ` + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  console.log(s);
  try { appendFileSync(CYCLE_LOG, s + '\n'); } catch (_) { }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function saveState(o) { try { writeFileSync(CYCLE_JSON, JSON.stringify({ ...o, at: Date.now() }, null, 1)); } catch (_) { } }

/* ---------- 读平台真实学时（只读，不抢标签归属） ----------
 * 实现放在 cc-lib.readCcStats，看护脚本/轮转主管共用；隧道断时返回 null（= "没读到"，不是"做完了"）。 */
async function readStats() {
  const s = await readCcStats(PORT);
  if (s && s.cats && s.cats.length) return s;
  /* ★ 2026-10-19 修：驱动在播放器页时 tabs 里没有一个停在培训页 → 读不到分类明细
   *   → 已达标的分类过滤不掉（分类0 30.9/30 还继续跑 cat=0，白跑一整轮）。
   *   退回 cc-auto 每次停在培训页时落盘的 runs/cc-stats-cache.json。
   *   学时单调递增 ⇒ 缓存的 done 是**下界**，"缓存说已达标"一定仍然达标，跳过是安全的。 */
  const c = readStatsCache();
  if (c) return { ...c, fromCache: true };
  return s;
}

const STATS_CACHE = 'runs/cc-stats-cache.json';
function readStatsCache(maxAgeMs = 90 * 60 * 1000) {
  try {
    const st = JSON.parse(readFileSync(STATS_CACHE, 'utf8'));
    if (!st || !st.cats || st.cats.length < 2) return null;
    const at = Number(st.at) || 0;
    if (at && Date.now() - at > maxAgeMs) return null;
    return st;
  } catch (_) { return null; }
}

/* ---------- 是否还有别的 cc-auto 在跑（护单会话）
 * ★ 2026-10-18 修：不能只按 'cc-auto.mjs' 子串匹配 —— 本机 dsh/pwsh 包裹进程的命令行里
 *   常常只是**引用了这个文件名**（跑看护命令的 shell 自己就带），曾把调用方 shell 一起杀掉
 *   （表现为 pwsh 返回 4294967295）。必须要求是 `node ... scripts/cc-auto.mjs` 的真启动形态，
 *   并排除 runner.js / pwsh -Command 这类包裹层。 */
function ccAutoPids() {
  try {
    const out = execSyncPS(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'scripts[\\\\/]cc-auto\\.mjs' -and $_.CommandLine -notmatch 'runner\\.js|pwsh\\.exe|-Command' } |
      ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`);
    return String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (_) { return null; }
}
function execSyncPS(cmd) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000 });
}

/* ---------- 跑一个分类 ---------- */
function runDriver(cat) {
  return new Promise(resolve => {
    const out = openSync(DRV_LOG, 'a');
    const err = openSync('runs/cc-driver.err.log', 'a');
    const args = ['scripts/cc-auto.mjs', '--port', String(PORT), '--tab', String(TAB), '--cat=' + cat, '--tag', 't0'];
    log('▶ 启动驱动 cat=' + cat + '(' + CATNAMES[cat] + ')  ' + args.join(' '));
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', out, err], windowsHide: true });
    saveState({ cat, pid: child.pid, phase: 'running' });
    const t0 = Date.now();
    let done = false;
    /* ★★ 2026-10-19 修 Bug2（"分类1 早达标了却一直不切"）：
     *   旧逻辑只在**驱动退出之后**才重新读学时 → 驱动若在某个分类里原地打转永不退出，
     *   主管就永远拿不到轮转时机（实测 cat=1 15.7/15 已达标、却还在跑 cat=1 的死循环）。
     *   现在：驱动**运行中**也每 2 分钟读一次学时缓存（cc-auto 每次停在培训页都会刷新它），
     *   一旦当前分类达标 → 主动收掉驱动 → 进入下一轮换分类。
     *   注：缓存里的学时是"下界"（平台学时单调递增），所以"缓存说达标"一定仍然达标，切走是安全的。 */
    const watch = setInterval(async () => {
      if (done) return;
      try {
        const sc = readStatsCache(20 * 60 * 1000);
        if (!sc || !sc.cats) return;
        const s = sc.cats.find(x => x.cat === cat);
        if (s && s.done !== null && s.target !== null && s.done >= s.target) {
          log('✔ 分类' + cat + '(' + CATNAMES[cat] + ') 运行中已达标 ' + s.done + '/' + s.target + ' → 收掉本驱动，换下一个分类');
          try { child.kill('SIGKILL'); } catch (_) { }
          finish(-3, 'cat-done');
        }
      } catch (_) { }
    }, 120000);
    const finish = (code, why) => {
      if (done) return; done = true;
      try { clearInterval(watch); } catch (_) { }
      const secs = Math.round((Date.now() - t0) / 1000);
      log('■ 驱动退出 code=' + code + ' 跑了 ' + secs + 's（' + why + '）');
      resolve({ code, secs, why });
    };
    child.on('exit', c => finish(c, 'normal'));
    child.on('error', e => finish(-1, 'spawn-error: ' + String(e && e.message).slice(0, 80)));
    // 兜底：驱动卡死超过 3 小时也没意义（分类0 全做完也就 ~2.5h）
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { } finish(-9, 'timeout-3h'); }, 3 * 60 * 60 * 1000);
  });
}

/** 清掉残留的多余 cc-auto（只留 0 个；本主管同一时刻只该有 1 个自己起的） */
function killStrayDrivers(keepPid) {
  const list = ccAutoPids();
  if (!list) { log('⚠ 进程枚举失败 → 不清理（避免误杀）'); return; }
  const rows = list.map(l => { const m = l.match(/^(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), cmd: m[2] } : null; }).filter(Boolean);
  const extra = rows.filter(r => r.pid !== keepPid);
  if (!extra.length) return;
  for (const r of extra) {
    log('⚠ 清理多余驱动 pid=' + r.pid + ' :: ' + r.cmd.slice(0, 90));
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${r.pid} -Force -ErrorAction SilentlyContinue`], { timeout: 20000 }); } catch (_) { }
  }
}

/* ---------------- 主轮转 ---------------- */
log('=== 轮转主管启动 port=' + PORT + ' tab=' + TAB + (ONLY === null ? '' : ' only=' + ONLY) + (ROUNDS ? ' rounds=' + ROUNDS : ' 持续轮转') + ' ====');

let round = 0;
let doneRounds = 0;   // 连续"三分类全达标"的轮数（用于收工判定）
let stuck = {};      // cat → 连续"秒退"次数
for (;;) {
  round++;
  const stats = await readStats();
  if (stats && stats.cats && stats.cats.length) {
    const line = stats.cats.map(c => `分类${c.cat} ${c.done}/${c.target}`).join(' · ');
    log('学时 ' + (stats.total ? stats.total.done + '/' + stats.total.target : '?') + ' | ' + line + (stats.fromCache ? '（缓存·cc-auto 落盘）' : ''));
  } else if (stats && !stats.onTrain) {
    log('（页面不在培训页：' + (stats.onPlayer ? '播放器' : stats.onCourse ? '课程页' : '其它') + ' → 学时等回到培训页再读）');
  } else {
    log('⚠ 读不到学时（隧道/页面异常）→ 继续按分类顺序推进');
  }

  // 选出还缺学时的分类（ONLY 优先）
  let order = ONLY === null ? [0, 1, 2] : [ONLY];
  if (stats && stats.cats && stats.cats.length) {
    order = order.filter(c => {
      const s = stats.cats.find(x => x.cat === c);
      if (ONLY !== null) return true;
      if (!s || s.done === null || s.target === null) return true;
      if (s.done >= s.target) { log('✔ 分类' + c + '(' + CATNAMES[c] + ') 已达标 ' + s.done + '/' + s.target + ' → 跳过'); return false; }
      return true;
    });
  }
  if (!order.length) {
    // ★ 2026-10-20 修：原来这里只"10 分钟后再核一遍"→ 三分类全达标后【永远空转】
    //   （实测从 06:05 转到 11:16，5 小时，cc-watch 也跟着每 3 分钟写"驱动未运行"）。
    //   现在：连续 DONE_CONFIRM 轮都全达标 → 写最终报告并自行退出，把CPU/日志还给系统。
    doneRounds++;
    log('🎉 三个分类全部达标（第 ' + doneRounds + '/' + DONE_CONFIRM + ' 轮确认）· 平台页面 '
      + (stats && stats.total ? stats.total.done + '/' + stats.total.target : '?') + ' 学时');
    saveState({ phase: 'all-done', doneRounds, at: Date.now() });

    // 第一轮确认时就把最终成果落盘（即便后面被 kill 也有记录）
    if (doneRounds === 1 && stats && stats.cats) {
      try {
        const prof = stats.cats[1] ? stats.cats[1].done : 0;
        const prof2 = stats.cats[2] ? stats.cats[2].done : 0;
        const lines = [
          '# 长春教师培训 · 完成报告',
          '',
          '- 生成时间：' + new Date().toLocaleString('zh-CN'),
          '- 平台：https://col.ccjyxy.cn（CDP 9228）',
          '',
          '## 学时账（平台口径）',
          '',
          '| 分类 | 已修 / 达标 | 状态 |',
          '|---|---|---|',
          ...stats.cats.map(c => '| ' + (CATNAMES[c.cat] || ('分类' + c.cat)) + ' | ' + c.done + ' / ' + c.target + ' | ' + (c.done >= c.target ? '✅ 达标' : '❌ 未达标') + ' |'),
          '| **总学时** | **' + stats.total.done + ' / ' + stats.total.target + '** | ' + (stats.total.done >= stats.total.target ? '✅' : '❌') + ' |',
          '| **专业科目**（分类1+2） | **' + (prof + prof2).toFixed(1) + ' / 60** | ' + ((prof + prof2) >= 60 ? '✅' : '❌') + ' |',
          '',
          '> 平台要求：公需科目 30 学时 + 专业科目（含学段通识）60 学时。',
          '',
          '## 结论',
          '',
          ((prof + prof2) >= 60 && stats.total.done >= stats.total.target)
            ? '**全部达标，培训完成。**'
            : '**未全部达标，需继续。**',
          '',
        ].join('\n');
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join, dirname } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        // cc-cycle.mjs 里没有 ROOT 常量 → 用自身位置推算项目根（scripts/ 的上一级）
        const projRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
        mkdirSync(join(projRoot, 'runs'), { recursive: true });
        writeFileSync(join(projRoot, 'runs', 'cc-final-report.md'), lines);
        log('📄 最终报告已写入 runs/cc-final-report.md');
      } catch (e) {
        log('⚠ 写最终报告失败：' + String(e.message).slice(0, 60));
      }
    }

    if (doneRounds >= DONE_CONFIRM) {
      log('✅ 连续 ' + DONE_CONFIRM + ' 轮确认全达标 → 收工退出（不再空转）');
      saveState({ phase: 'finished', doneRounds, at: Date.now() });
      process.exit(0);
    }
    await sleep(600000);
    if (ROUNDS && round >= ROUNDS) break;
    continue;
  }
  doneRounds = 0;   // 有任何分类没达标 → 重置确认计数

  const cat = order[0];
  // 起跑前先确保没有残留驱动（单会话硬约束：多开必 423）
  killStrayDrivers(0);
  await sleep(3000);

  const r = await runDriver(cat);
  // 秒退（< 90s）连续 3 次 → 这个分类有硬卡点，换下一个，别在这儿死磕
  if (r.secs < 90 && r.code !== 0) {
    stuck[cat] = (stuck[cat] || 0) + 1;
    log('⚠ 分类' + cat + ' 第 ' + stuck[cat] + ' 次秒退');
    if (stuck[cat] >= 3) {
      log('⛔ 分类' + cat + ' 连续秒退 → 先跳到下一个分类，稍后回来');
      stuck[cat] = 0;
      if (order.length > 1) {
        const nxt = order[1];
        log('→ 改跑分类' + nxt);
        const r2 = await runDriver(nxt);
        if (r2.secs < 90 && r2.code !== 0) { log('⚠ 分类' + nxt + ' 也秒退 → 休息 5 分钟'); await sleep(300000); }
      } else { await sleep(300000); }
    } else {
      await sleep(45000);
    }
  } else {
    stuck[cat] = 0;
    await sleep(8000);       // 换分类前留一点缓冲，避免两个页面交接太快
  }

  if (ROUNDS && round >= ROUNDS) { log('已达到 --rounds=' + ROUNDS + ' → 退出'); break; }
}
log('==== 轮转主管退出（轮数 ' + round + '） ====');
process.exit(0);
