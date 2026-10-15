/**
 * supervisor.mjs — 三平台系统级主管（长跑最后一块拼图）
 *
 * 为什么需要它：目标要跑 50+ 小时，期间任何一环挂掉都会**静默失效**：
 *   · Chrome（CDP 端口 9224/9227/9228）崩了 → 所有驱动报"无标签"
 *   · 某个看门狗/驱动挂了 → 该平台停止推进
 *   单靠各自的看门狗不够（看门狗自己也会死，第 36 轮就踩过 NaN 导致自尽的坑）。
 *
 * 本脚本每 60 秒做一次**全量体检**，缺什么补什么，并把状态落盘 runs/supervisor.log。
 *
 * ⚠️ 启动子进程一律用 `--k=v` 形式（空格形式曾因解析歧义产生 NaN → 进程空转被拖死）。
 *
 * 用法：node scripts\supervisor.mjs [--interval=60] [--dry]
 */
const argv = process.argv.slice(2);
const num = (k, d) => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' + k) { const v = Number(argv[i + 1]); return Number.isFinite(v) ? v : d; }
    if (a.startsWith('--' + k + '=')) { const v = Number(a.split('=')[1]); return Number.isFinite(v) ? v : d; }
  }
  return d;
};
const INTERVAL = num('interval', 60);
const DRY = argv.includes('--dry');

const { appendFileSync, mkdirSync, openSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const { spawn } = await import('node:child_process');
mkdirSync('runs', { recursive: true });
const log = (m) => {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + m;
  console.log(line);
  try { appendFileSync('runs/supervisor.log', line + '\n'); } catch (_) { }
};

/** 列出某类 node 进程的 pid
 *  ⚠️ 必须排除**作业运行器**（@deepseek-ai/dsh-subprocess-local/runner.js）：
 *     它的命令行里包含"我这条启动命令的全文"，会把所有脚本名都匹配上 → 严重误报
 *     （实测：同一 pid 同时出现在 ss看门狗/提交看门狗/进度记录 三个清单里）
 *  ★★ 出错时返回 **null**（不是 []）！这是关键：
 *     实测事故 —— 计划任务上下文里 powershell.exe 枚举超时 → 返回 [] → 主管以为"进程缺失"
 *     → 每分钟启动一个新副本 → 一小时内复制出 4 份驱动/看门狗，两个驱动抢同一标签。
 *     返回 null 后调用方会**跳过本轮**（fail-closed），宁可不动也不能复制。 */
function pidsOf(match) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '${match}' -and $_.CommandLine -notmatch 'runner\\.js' -and $_.CommandLine -notmatch 'subprocess-local' } | ForEach-Object { $_.ProcessId }`
    ], { encoding: 'utf8', timeout: 60000 });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number).filter(n => n > 0);
  } catch (_) { return null; }        // ← null = "我没查出来"，不是"没有"
}

function spawnDetached(args, outLog, errLog) {
  if (DRY) { log('  (dry) 会启动: node ' + args.join(' ')); return null; }
  // ★ 用 Node 的 spawn 直接拉起，**不再经 PowerShell 中转**：
  //   旧版走 `powershell.exe Start-Process`，实测会 `spawnSync powershell.exe ETIMEDOUT`
  //   → 该补的进程没补上，而主管以为已处理（最危险的那种"假成功"）。
  //   日志用**文件 fd** 重定向（不是管道）——管道在受限沙箱下会 EPERM。
  try {
    let out = 'ignore', err = 'ignore';
    try { out = openSync(outLog, 'a'); err = openSync(errLog, 'a'); } catch (_) { out = 'ignore'; err = 'ignore'; }
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', out, err]
    });
    child.unref();
    log('  🚀 启动 ' + args[0] + ' pid=' + child.pid);
    return child.pid;
  } catch (e) { log('  ✗ 启动失败 ' + args[0] + ': ' + String(e).slice(0, 70)); return null; }
}

/** CDP 端口是否有页面 */
async function portHasPage(port) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    return Array.isArray(list) && list.some(t => t.type === 'page');
  } catch (_) { return false; }
}

// 监管清单：name / 进程匹配 / 是否必须唯一 / 启动参数 / 日志
const TARGETS = [
  { name: 'ss看门狗', match: 'ss-watch\\.mjs', uniq: true, args: ['scripts/ss-watch.mjs', '--stall=3', '--interval=30'], out: 'runs/ss-watch-console.log', err: 'runs/ss-watch.err.log' },
  { name: '提交看门狗', match: 'cx-submit-watch\\.mjs', uniq: true, args: ['scripts/cx-submit-watch.mjs', '--interval=30'], out: 'runs/cx-submit-watch-console.log', err: 'runs/cx-submit-watch.err.log' , watchOnly: true },
  { name: '进度记录', match: 'progress-report\\.mjs', uniq: true, args: ['scripts/progress-report.mjs', '--every=300'], out: 'runs/progress-console.log', err: 'runs/progress.err.log' },
  // 长春驱动归 Agent B 独占（9228 同时只能一个会话，多开必 423 Locked）。
  // ★ 主管只【监视】不【启动】它，避免和 Agent B 抢标签（2026-10-15 主线让路）。
  { name: '长春驱动', match: 'cc-auto\\.mjs --port', uniq: true, args: ['scripts/cc-auto.mjs', '--port', '9228', '--tab', '0', '--secs', '10'], out: 'runs/cc-driver.log', err: 'runs/cc-driver.err.log', watchOnly: true },
  { name: '学习通驱动', match: 'cx-auto\\.mjs --port', uniq: true, args: ['scripts/cx-auto.mjs', '--port', '9227', '--secs', '10', '--maxmins', '400'], out: 'runs/cx-driver.out.log', err: 'runs/cx-driver.err.log' , watchOnly: true },
];

/** 重建某个端口的隧道（端口不通时调用） */
function rebuildTunnel(port) {
  if (DRY) { log('  (dry) 会重建 ' + port + ' 隧道'); return; }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile','-File','scripts/tunnel.ps1','-Port','${port}' -WorkingDirectory '${process.cwd()}' -WindowStyle Hidden`
    ], { encoding: 'utf8', timeout: 30000 });
    log('  🔧 已重建 ' + port + ' 隧道');
  } catch (e) { log('  ✗ 重建 ' + port + ' 隧道失败: ' + String(e).slice(0, 70)); }
}

// ★★ 自身去重：同一时间只允许一个主管
//   踩过的三条弯路（都别再用）：
//     ① `process.kill(pid, 0)` 判活 —— 计划任务在**不同用户上下文**，抛 EPERM 被误当"不存在"
//     ② 心跳文件判活 —— 第二实例常在第一实例写出心跳**之前**就起来了，照样放行
//     ③ 只在启动时检查 —— 两个几乎同时启动时都会通过
//   ✅ 最终做法：复用**已验证可用的 pidsOf**（枚举进程）做自身去重，
//      并且**每轮循环都复查一次**（不只启动时）：不是最小 pid 就退出。
function dedupeSelf(cycle) {
  const mine = pidsOf('supervisor\\.mjs');
  if (mine === null) return false;                 // 枚举失败 → 不动（fail-closed）
  const others = mine.filter(p => p !== process.pid);
  if (!others.length) return false;
  const keep = Math.min(...mine);
  if (keep !== process.pid) {
    log('  ⚠ 还有其它主管在跑（' + mine.join(',') + '）→ 本实例 pid=' + process.pid + ' 让位退出' + (cycle ? '（第 ' + cycle + ' 轮复查发现）' : ''));
    process.exit(0);
  }
  log('  ⚠ 发现 ' + others.length + ' 个多余主管（' + others.join(',') + '），本实例 pid=' + process.pid + ' 保留');
  return true;
}

let cycleNo = 0;
log('=== 系统级主管启动（每 ' + INTERVAL + 's 全量体检）===' + (DRY ? ' [dry]' : ''));
dedupeSelf(0);

for (;;) {
  const ports = [];
  const down = [];
  for (const p of [9224, 9227, 9228]) {
    const ok = await portHasPage(p);
    ports.push(p + (ok ? '✅' : '❌'));
    if (!ok) down.push(p);
  }
  // ★ 端口不通 → 重建隧道（2026-10-15 实测：9224/9227 的隧道会自己断，
  //   表现为"驱动还在跑、日志还在写，但两个平台完全停摆"——最隐蔽的失效模式）
  for (const p of down) rebuildTunnel(p);
  if (down.length) await new Promise(r => setTimeout(r, 20000));   // 给隧道 20 秒起来

  const issues = [];

  for (const t of TARGETS) {
    let pids = pidsOf(t.match);
    // ★★ fail-closed：枚举失败就**跳过本轮**，绝不能当成"缺失"去启动（那会复制失控）
    if (pids === null) { log('  ⚠ ' + t.name + ' 进程枚举失败 → 本轮跳过（不启动，避免复制）'); continue; }
    // ★ 重复实例要**动手清理**（不是只告警）：同一标签被两个驱动抢会互相干扰
    //   （一个点播放、另一个把页面导航走 → 表现为"播放器总是消失"）。
    //   策略：保留 pid 最小（最早启动）的那个，其余杀掉。
    if (t.uniq && pids.length > 1) {
      pids.sort((a, b) => a - b);
      const keep = pids[0], kill = pids.slice(1);
      log('  ⚠ ' + t.name + ' 有 ' + pids.length + ' 个实例，保留 ' + keep + '，清理 ' + kill.join(','));
      if (!DRY) {
        for (const pid of kill) {
          try {
            execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], { encoding: 'utf8', timeout: 20000 });
            log('    ✔ 已停 ' + pid);
          } catch (e) { log('    ✗ 停 ' + pid + ' 失败: ' + String(e).slice(0, 50)); }
        }
      }
      pids = [keep];
    }
    if (!pids.length) {
      issues.push(t.name + '缺失');
      // ★ watchOnly：只监视不启动（长春驱动归 Agent B 独占，多开会 423 Locked）
      if (t.watchOnly) log('  ⚠ ' + t.name + ' 不在运行（只监视不启动（已按用户要求暂停学习通处理））');
      else if (!DRY) spawnDetached(t.args, t.out, t.err);
    }
  }

  // ★ 顺手把"基础设施进程"的可见控制台窗口收掉（用户要求本机不弹窗）
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/hide-infra-windows.ps1'], { encoding: 'utf8', timeout: 30000 });
  } catch (_) { }

  log('CDP: ' + ports.join(' ') + (down.length ? '（已尝试重建 ' + down.join(',') + '）' : '') + '  |  ' + (issues.length ? '修复: ' + issues.join('、') : '全部在位'));
  cycleNo++;
  dedupeSelf(cycleNo);        // ★ 每轮复查：不是最小 pid 就让位退出
  await new Promise(r => setTimeout(r, INTERVAL * 1000));
}
