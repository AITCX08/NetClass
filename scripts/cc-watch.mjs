/**
 * cc-watch.mjs — 长春 90 学时「看护」采样器（只读，不动页面、不起驱动）
 *
 * 每 --every 秒采一次，把一行追加到 runs/cc-agent-watch.log：
 *   [时间] 学时X/90 | 分类0 a/30 分类1 b/15 分类2 c/45 | 驱动=PID/无 | 备注
 *
 * 备注里的"乱跳"判据（2026-10-18 定）：
 *   最近 --win 分钟内的新日志里 **一次 '起播' 都没有**，却有 >=3 次
 *   「已进课程页 / 课程页无待播段 / 本课结束 / 打不开」→ 驱动在空转，没在做视频。
 *   （正常形态：起播 → …段N 推进 → ✔ 播完 → 点返回课程列表，每段几百秒）
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readCcStats } from './cc-lib.mjs';

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
const EVERY = Number(A.every || 180) * 1000;
const WIN = Number(A.win || 6) * 60 * 1000;
const LOGF = String(A.log || 'runs/cc-agent-watch.log');
const DRVLOG = String(A.drvlog || 'runs/logs/cc-t0.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hhmmss = () => new Date().toTimeString().slice(0, 8);

function driverPid() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts/cc-auto\\.mjs' } | ForEach-Object { $_.ProcessId }`],
      { encoding: 'utf8', timeout: 25000 });
    const pids = String(out).split(/\s+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    return pids.length ? pids.join(',') : null;
  } catch (_) { return '?'; }
}

/** 最近 WIN 内的驱动日志分类统计 */
function recentActivity() {
  let lines = [];
  try { lines = readFileSync(DRVLOG, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return null; }
  const now = new Date();
  const cutoff = now.getTime() - WIN;
  const hit = { start: 0, prog: 0, done: 0, idle: 0, open: 0, skip: 0 };
  for (const ln of lines.slice(-400)) {
    const m = ln.match(/^\[(\d\d):(\d\d):(\d\d)\]/);
    if (!m) continue;
    const t = new Date(now); t.setHours(+m[1], +m[2], +m[3], 0);
    if (t.getTime() < cutoff) continue;
    if (/段\d+ 起播|点段\[/.test(ln)) hit.start++;
    if (/…段\d+/.test(ln)) hit.prog++;
    if (/✔ 段\d+/.test(ln)) hit.done++;
    if (/已进课程页/.test(ln)) hit.open++;
    if (/没有可认领的课|本轮全部跳过|重新枚举/.test(ln)) hit.idle++;
    if (/加入跳过表|打不开/.test(ln)) hit.skip++;
  }
  return hit;
}

let n = 0;
// 学时缓存落盘：进程重启后仍然能显示"最近一次读到的真实学时"（标 ~ 表示不是本刻读数）
const CACHE = 'runs/cc-stats-cache.json';
let lastKnown = null;
try { lastKnown = JSON.parse(readFileSync(CACHE, 'utf8')); } catch (_) { lastKnown = null; }
for (;;) {
  n++;
  const s = await readCcStats(PORT);
  const pid = driverPid();
  const act = recentActivity();

  // 缓存每拍都重读：驱动（cc-auto）在培训页会随时刷新它，不必等看护自己读到
  let cached = lastKnown;
  try { cached = JSON.parse(readFileSync(CACHE, 'utf8')); } catch (_) { }
  const src = (s && s.onTrain) ? s : cached;
  if (s && s.onTrain) { lastKnown = s; try { writeFileSync(CACHE, JSON.stringify(s)); } catch (_) { } }
  const approx = !(s && s.onTrain) ? '~' : '';

  let hrs = '?';
  let cats = '分类0 ?/30 分类1 ?/15 分类2 ?/45';
  if (src && src.total) hrs = approx + src.total.done + '/' + src.total.target;
  if (src && src.cats && src.cats.length === 3) {
    const g = c => { const x = src.cats.find(y => y.cat === c); return x && x.done !== null ? approx + x.done + '/' + x.target : '?'; };
    cats = `分类0 ${g(0)} 分类1 ${g(1)} 分类2 ${g(2)}`;
  }

  let note;
  if (!s) note = 'CDP/隧道不可达（读不到学时，需重建 9228 隧道）';
  else if (!pid) note = '驱动未运行（等 cc-cycle 拉起）';
  else if (!s.onTrain) note = '驱动在' + (s.onPlayer ? '播放器页' : s.onCourse ? '课程页' : '其它页') + (act && act.start ? ` · 近${WIN / 60000}min 起播${act.start}次` : '');
  else if (act && act.start === 0 && (act.open + act.idle) >= 3) note = `⚠ 乱跳：近${WIN / 60000}min 无起播，进课${act.open}/空转${act.idle}`;
  else if (act) note = `正常 · 起播${act.start} 推进${act.prog} 播完${act.done}`;
  else note = '无日志';

  const line = `[${hhmmss()}] 学时${hrs} | ${cats} | 驱动=${pid || '无'} | ${note}`;
  console.log(line);
  try { appendFileSync(LOGF, line + '\n'); } catch (_) { }

  // ★ 2026-10-20 修：三个分类全达标 + 驱动没在跑 → 看护任务已完成，退出不再空转。
  //   （原来会永远每 3 分钟写一行"驱动未运行（等 cc-cycle 拉起）"，
  //    实测从 06:05 写到 11:16 —— 5 小时空转。）
  if (s && s.cats && s.cats.length && !pid) {
    const allMet = s.cats.every(c => c.done !== null && c.target !== null && c.done >= c.target);
    if (allMet) {
      const done = `[${hhmmss()}] ✅ 三分类全达标且驱动未运行 → 看护收工退出`;
      console.log(done);
      try { appendFileSync(LOGF, done + '\n'); } catch (_) { }
      process.exit(0);
    }
  }

  await sleep(EVERY);
}
