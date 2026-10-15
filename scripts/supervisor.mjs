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

const { appendFileSync, mkdirSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
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
 */
function pidsOf(match) {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '${match}' -and $_.CommandLine -notmatch 'runner\\.js' -and $_.CommandLine -notmatch 'subprocess-local' } | ForEach-Object { $_.ProcessId }`
    ], { encoding: 'utf8', timeout: 25000 });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(Number).filter(n => n > 0);
  } catch (_) { return []; }
}

function spawnDetached(args, outLog, errLog) {
  if (DRY) { log('  (dry) 会启动: node ' + args.join(' ')); return null; }
  try {
    const p = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Start-Process -FilePath 'node' -ArgumentList ${args.map(a => "'" + a + "'").join(',')} -WorkingDirectory '${process.cwd()}' -WindowStyle Hidden -PassThru -RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}' | Select-Object -ExpandProperty Id`
    ], { encoding: 'utf8', timeout: 25000 });
    const pid = Number(String(p).trim());
    log('  🚀 启动 ' + args[0] + ' pid=' + pid);
    return pid;
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
  { name: '提交看门狗', match: 'cx-submit-watch\\.mjs', uniq: true, args: ['scripts/cx-submit-watch.mjs', '--interval=30'], out: 'runs/cx-submit-watch-console.log', err: 'runs/cx-submit-watch.err.log' },
  { name: '进度记录', match: 'progress-report\\.mjs', uniq: true, args: ['scripts/progress-report.mjs', '--every=300'], out: 'runs/progress-console.log', err: 'runs/progress.err.log' },
  { name: '长春驱动', match: 'cc-auto\\.mjs --port', uniq: true, args: ['scripts/cc-auto.mjs', '--port', '9228', '--tab', '0', '--secs', '10'], out: 'runs/cc-driver.log', err: 'runs/cc-driver.err.log' },
  { name: '学习通驱动', match: 'cx-auto\\.mjs --port', uniq: true, args: ['scripts/cx-auto.mjs', '--port', '9227', '--secs', '10', '--maxmins', '400'], out: 'runs/cx-driver.out.log', err: 'runs/cx-driver.err.log' },
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

log('=== 系统级主管启动（每 ' + INTERVAL + 's 全量体检）===' + (DRY ? ' [dry]' : ''));

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
    const pids = pidsOf(t.match);
    if (!pids.length) { issues.push(t.name + '缺失'); if (!DRY) spawnDetached(t.args, t.out, t.err); }
    else if (t.uniq && pids.length > 1) { log('  ⚠ ' + t.name + ' 有 ' + pids.length + ' 个实例（' + pids.join(',') + '），保留 1 个'); }
  }

  log('CDP: ' + ports.join(' ') + (down.length ? '（已尝试重建 ' + down.join(',') + '）' : '') + '  |  ' + (issues.length ? '修复: ' + issues.join('、') : '全部在位'));
  await new Promise(r => setTimeout(r, INTERVAL * 1000));
}
