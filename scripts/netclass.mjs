#!/usr/bin/env node
/**
 * scripts/netclass.mjs —— 单入口
 *
 *   netclass up   --platform <key>          起一个实例（默认 offscreen，不抢焦点）
 *   netclass up   --platform <key> --login  起可见窗口让你手动登录
 *   netclass ps                             一屏看所有实例
 *   netclass stop <id>                      停实例（按 PID 整棵进程树带走）
  netclass stop all --yes                 停全部活实例
  netclass stop --platform <key> --yes    停某平台全部实例（先列清单再确认）
 *   netclass status                         浏览器 + 并发 + 实例总览
 *   netclass attach <id>                    连到已有实例做一次探活
 *
 * 设计要点
 * --------
 * 1. **不需要装扩展**：注入走 CDP Page.addScriptToEvaluateOnNewDocument，
 *    绕开 MV3 `chrome.userScripts` 那个 CLI 改不了的「允许用户脚本」开关。
 * 2. **不需要装 OCS**：浏览器用 Chrome for Testing（版本锁定，见 browser.mjs）。
 * 3. **多实例并行**：一实例一 profile 一端口，闸门默认 4 个（NETCLASS_MAX_INSTANCES 可调）。
 * 4. **登录永远人工**：`--login` 只是把窗口摆到前台给用户操作，不填任何账号密码。
 */
import { existsSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, cdpAlive } from './launch.mjs';
import { resolveBrowser, loadConfig as loadBrowserCfg, cacheDir } from './browser.mjs';
import {
  allocatePort, aliveCount, createProfile, defaultPort, formatTable, gate, portInUse,
  getInstance, instanceProfile, listInstances, makeId, maxConcurrent,
  pidAlive, profileSize, removeInstance, saveInstance, loadPlatforms,
} from './instances.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, '..');

/**
 * ★ 2026-11-22：颜色码以前是无条件输出的。
 * 后果很实际：任何按文本解析 netclass 输出的调用方（比如 detect.mjs 要从
 * `实例 <id> 已就绪` 里抠 id）都会把 `\x1b[0m` 一起抠进去，导致
 * `netclass stop <id>` 匹配不到实例、浏览器停不掉（真实踩过一次 9229 残留）。
 *
 * 现在：非 TTY（被管道/子进程捕获）、设了 NO_COLOR、或显式 --no-color 时全部置空。
 */
const NO_COLOR = process.argv.includes('--no-color') || !!process.env.NO_COLOR || !process.stdout.isTTY;
const C = NO_COLOR
  ? { g: '', y: '', r: '', d: '', b: '', x: '' }
  : { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}✗${C.x} ${m}`);
const dim = (m) => console.log(`${C.d}${m}${C.x}`);

function arg(k, d) {
  const i = process.argv.indexOf('--' + k);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (k) => process.argv.includes('--' + k);

/**
 * 端口解析。
 * 默认走 allocatePort()：优先平台规范位，被占则从动态池拿。
 * ★ 2026-11-22 新增 `--port N`：探测器（detect.mjs）起临时实例时必须能**避开**规范端口，
 *   否则会把临时实例绑到 9229/9231 这些"正式位"上 —— 一旦正式实例在跑，两者语义就混了。
 */
async function resolvePort(platform) {
  const want = arg('port', null);
  if (!want || want === true) return await allocatePort(platform);
  const p = Number(want);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    bad('--port 必须是 1024-65535 的整数：' + want);
    process.exit(1);
  }
  if (await portInUse(p)) {
    bad('端口 ' + p + ' 已被占用，换一个');
    process.exit(1);
  }
  return p;
}

// ---------------------------------------------------------------- up
async function cmdUp() {
  const platform = arg('platform', arg('p', null));
  if (!platform || platform === true) {
    bad('缺 --platform');
    const pl = loadPlatforms();
    console.log('可用平台:');
    for (const [k, v] of Object.entries(pl)) {
      if (k.startsWith('_')) continue;
      console.log(`  ${k.padEnd(14)} ${v.label || ''}  ${v.cdp ? 'cdp=' + v.cdp : ''}${v._notAdapted ? '  (未适配)' : ''}`);
    }
    process.exit(1);
  }

  // 闸门
  const g = gate();
  if (!g.ok) { bad(g.reason); process.exit(1); }

  // 端口 + id + profile
  const port = await resolvePort(platform);
  const id = makeId(platform, process.argv.join('') + Date.now());
  const profile = createProfile(id);
  const isLogin = has('login');

  const pl = loadPlatforms()[platform] || {};
  // ★ 踩过的坑：平台常常只配了 auth.loginUrl、没有 homeUrl。
  //   如果回落到 about:blank，Chrome 会把它变成 chrome://new-tab-page/，
  //   那是受保护页 —— addScriptToEvaluateOnNewDocument **不会执行**，
  //   于是注入"看起来失败"。所以非登录模式也必须回落到 loginUrl。
  const defaultUrl = pl.auth?.loginUrl || pl.homeUrl || 'https://example.com/';
  const url = arg('url', defaultUrl);
  const mode = isLogin ? 'headed' : (arg('mode', 'offscreen'));

  console.log(`${C.b}启动 ${platform}${C.x}  ${C.d}(实例 ${id})${C.x}`);
  console.log(`  端口    ${port}${port === defaultPort(platform) ? '  ' + C.d + '(平台默认位)' + C.x : '  ' + C.d + '(动态池)' + C.x}`);
  console.log(`  profile ${profile}`);
  console.log(`  模式    ${mode}${mode === 'headed' ? '  ' + C.y + '← 窗口会出现在前台' + C.x : ''}`);

  // 先落一条 starting 记录，占住端口（否则并发分配会撞）
  saveInstance({
    id, platform, port, profile, mode,
    state: 'starting',
    pid: null,
    url,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    task: null,
  });

  let h;
  try {
    h = await launch({ port, profile, mode, url, quiet: false });
  } catch (e) {
    bad('启动失败: ' + e.message);
    saveInstance({ ...getInstance(id), state: 'dead', error: e.message });
    process.exit(1);
  }

  saveInstance({
    ...getInstance(id),
    pid: h.pid,
    browserVersion: h.browserVersion,
    browserFallback: h.fallback,
    inject: h.inject,
    state: isLogin ? 'needs_login' : 'idle',
    lastHeartbeat: new Date().toISOString(),
  });

  console.log('');
  ok(`实例 ${C.b}${id}${C.x} 已就绪`);
  console.log(`  CDP     http://127.0.0.1:${port}`);
  console.log(`  PID     ${h.pid}`);
  if (isLogin) {
    console.log('');
    warn('窗口已摆到前台 —— 请在里面手动登录。');
    dim('  登录完成后 profile 会保留登录态，之后 `netclass up --platform ' + platform + '` 免登录。');
    dim('  关窗口用：netclass stop ' + id);
  } else {
    dim('  这是后台模式（窗口在屏幕外），不抢焦点。要看得见用 --login 或 --mode headed。');
  }
  console.log('');
  console.log(formatTable());

  // ★ 只断 CDP 连接，不关浏览器（实例要一直活着跑）。
  //   不断开的话 WebSocket 会占住事件循环，CLI 永远不退出（实测踩到）。
  try { h.cdp.close(); } catch { }
  process.exit(0);
}

// ---------------------------------------------------------------- ps
function cmdPs() {
  console.log(formatTable());
}

// ---------------------------------------------------------------- status
async function cmdStatus() {
  const bcfg = loadBrowserCfg();
  console.log(`${C.b}NetClass 状态${C.x}\n`);

  // 浏览器
  console.log(`${C.b}浏览器${C.x}`);
  try {
    const b = await resolveBrowser({ quiet: true });
    const src = b.override ? 'env 覆盖' : b.fallback ? `${C.y}系统降级 (${b.name})${C.x}` : 'Chrome for Testing（锁定）';
    console.log(`  引擎      ${src}`);
    console.log(`  版本      ${b.version || '?'}${b.fallback ? '  ' + C.y + '(未锁定)' + C.x : ''}`);
    console.log(`  路径      ${b.path}`);
    console.log(`  缓存      ${cacheDir(bcfg)}`);
  } catch (e) {
    bad('浏览器不可用: ' + e.message.split('\n')[0]);
  }

  // 实例
  console.log(`\n${C.b}实例${C.x}  ${aliveCount()}/${maxConcurrent()}`);
  console.log(formatTable());

  // 端口
  const insts = listInstances().filter((i) => pidAlive(i.pid));
  if (insts.length) {
    console.log(`\n${C.b}CDP 端点${C.x}`);
    for (const i of insts) {
      const v = await cdpAlive(i.port);
      console.log(`  ${String(i.port).padEnd(6)} ${v ? C.g + '在线' + C.x : C.r + '离线' + C.x}  ${i.id}`);
    }
  }
}

// ---------------------------------------------------------------- stop
/**
 * 停实例。
 *
 * ★ 2026-11-22 修（安全 bug）：
 *   旧实现是 `i.id === target || i.platform === target` —— 也就是说 `netclass stop ccjyxy`
 *   会把**该平台所有实例**一起杀掉，包括正在跑单子的那一个，而帮助里只写了 `<id|all>`。
 *   误输入一个平台名 = 静默杀掉在跑的浏览器，直接违反「不重启浏览器」红线。
 *
 * 现在的语义：
 *   netclass stop <id>                 精确匹配实例 id（唯一默认方式）
 *   netclass stop all --yes            全部活实例（必须显式 --yes）
 *   netclass stop --platform <key> --yes  某平台全部实例（先列清单，必须 --yes）
 */
async function cmdStop() {
  const target = process.argv[3];
  const platformTarget = arg('platform', null);
  const confirmed = has('yes');

  if (!target && !platformTarget) {
    bad('用法: netclass stop <id> | netclass stop all --yes | netclass stop --platform <key> --yes');
    process.exit(1);
  }

  const all = listInstances();
  const alive = all.filter((i) => pidAlive(i.pid));
  let victims = [];

  if (platformTarget) {
    victims = alive.filter((i) => i.platform === String(platformTarget));
    if (!victims.length) { warn('没有匹配的活实例（平台 ' + platformTarget + '）'); return; }
    if (!confirmed) {
      bad('按平台停止会杀掉该平台的**全部**实例，共 ' + victims.length + ' 个：');
      for (const i of victims) console.log(`  · ${i.id}  pid ${i.pid}  端口 ${i.port}`);
      dim('确认无误请加 --yes 重跑。日常请用实例 id：netclass stop <id>');
      process.exit(1);
    }
  } else if (target === 'all') {
    victims = alive;
    if (!victims.length) { warn('没有匹配的活实例'); return; }
    if (!confirmed) {
      bad('停止全部实例会杀掉 ' + victims.length + ' 个：');
      for (const i of victims) console.log(`  · ${i.id}  pid ${i.pid}  端口 ${i.port}`);
      dim('确认无误请加 --yes 重跑。');
      process.exit(1);
    }
  } else {
    // 默认：只认精确 id。平台名不再隐式匹配（那正是这个 bug 的来源）。
    victims = all.filter((i) => i.id === target);
    if (!victims.length) {
      warn('没有 id 为「' + target + '」的实例');
      // 给一次有用的提示：如果它看起来像平台名，指出来
      const asPlatform = alive.filter((i) => i.platform === target);
      if (asPlatform.length) {
        dim('「' + target + '」是平台名，对应 ' + asPlatform.length + ' 个实例：' + asPlatform.map((i) => i.id).join(', '));
        dim('要按平台停止请用：netclass stop --platform ' + target + ' --yes');
      } else {
        dim('当前实例：' + (alive.map((i) => i.id).join(', ') || '（无）'));
      }
      return;
    }
  }

  for (const i of victims) {
    console.log(`停止 ${i.id} (pid ${i.pid}, 端口 ${i.port})`);
    try {
      if (i.port) {
        // 先试优雅关闭
        try {
          await fetch(`http://127.0.0.1:${i.port}/json/close`, { method: 'GET' }).catch(() => { });
        } catch { }
      }
      if (process.platform === 'win32' && i.pid) {
        const { spawnSync } = await import('node:child_process');
        spawnSync('taskkill', ['/PID', String(i.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else if (i.pid) {
        try { process.kill(i.pid, 'SIGKILL'); } catch { }
      }
    } catch (e) { warn('  关闭出错: ' + e.message); }

    saveInstance({ ...i, state: 'dead', stoppedAt: new Date().toISOString() });
    ok(`  ${i.id} 已停`);
  }
}

// ---------------------------------------------------------------- attach
async function cmdAttach() {
  const id = process.argv[3];
  const i = id ? getInstance(id) : null;
  if (!i) { bad('找不到实例: ' + id + '（先 netclass ps）'); process.exit(1); }
  const v = await cdpAlive(i.port);
  if (!v) { bad(`实例 ${id} 的 CDP (${i.port}) 不在线`); process.exit(1); }
  console.log(`${C.g}在线${C.x}  ${v.Browser}  端口 ${i.port}  工作目录 ${v.webSocketDebuggerUrl}`);
  const l = await (await fetch(`http://127.0.0.1:${i.port}/json/list`)).json();
  for (const t of l.filter((x) => x.type === 'page')) {
    console.log(`  [page] ${t.title}  ${String(t.url).slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------- prune
/**
 * 清理 dead 实例记录。
 *
 * 为什么需要：每起一次探测/临时实例都会在状态目录留一条记录；`netclass ps` 会一直把它们
 * 列出来（本次能力补全层的 detect 就跑出了 3 条），久了看起来像有一堆实例在跑。
 *
 * 只删记录，不动 profile 目录（重登一次很贵）；要连 profile 一起删加 --purge-profiles。
 */
async function cmdPrune() {
  const all = listInstances();
  const dead = all.filter((i) => !pidAlive(i.pid));
  if (!dead.length) { ok(`没有 dead 记录（共 ${all.length} 条实例）`); return; }

  console.log(`清理 ${dead.length} 条 dead 记录（共 ${all.length} 条）：`);
  let purge = has('purge-profiles');
  const { rmSync } = purge ? await import('node:fs') : {};
  for (const i of dead) {
    removeInstance(i.id);
    console.log(`  · ${i.id.padEnd(20)} 端口 ${String(i.port ?? '?').padEnd(6)} pid ${String(i.pid ?? '?').padEnd(8)} 最后心跳 ${i.lastHeartbeat || '?'}`);
    if (purge) {
      const dir = instanceProfile(i.id);
      try { rmSync(dir, { recursive: true, force: true }); console.log(`      已删 profile ${dir}`); }
      catch (e) { warn(`      profile 删除失败：${e.message}`); }
    }
  }
  ok(purge ? '已清理记录与 profile' : '已清理记录（profile 保留；要一并删加 --purge-profiles）');
}

// ---------------------------------------------------------------- help
function help() {
  console.log(`${C.b}NetClass${C.x} — 网课自动处理（Agent 工具包）

${C.b}用法${C.x}
  netclass up --platform <key> [--port N] 起一个后台实例（--port 指定端口，避开平台规范位用）
  netclass up --platform <key> --login    起可见窗口，你自己登录
  netclass ps                             看所有实例
  netclass stop <id>                      停实例（只认精确 id）
  netclass stop all --yes                 停全部活实例（必须 --yes）
  netclass stop --platform <key> --yes    停某平台全部实例（先列清单，必须 --yes）
  netclass prune [--purge-profiles]       清理 dead 实例记录（--purge-profiles 连 profile 一起删）
  netclass status                         浏览器 + 并发 + 实例总览
  netclass attach <id>                    探活一个实例

${C.b}环境变量${C.x}
  NETCLASS_MAX_INSTANCES   并发上限（默认 4）
  NETCLASS_BROWSER_DIR     浏览器缓存目录
  NETCLASS_BROWSER_PATH    直接指定浏览器可执行文件
  NETCLASS_USE_SYSTEM_BROWSER=1  降级用系统 Edge/Chrome（版本不锁定）
  NO_COLOR=1                     关闭颜色码（非 TTY 时会自动关闭；也可 --no-color）

${C.b}常用${C.x}
  netclass up --platform ccjyxy --login   # 第一次：登录
  netclass up --platform ccjyxy           # 之后：后台跑
  netclass ps                             # 看进度`);
}

// ---------------------------------------------------------------- main
const cmd = process.argv[2];
try {
  if (cmd === 'up') await cmdUp();
  else if (cmd === 'ps' || cmd === 'list') cmdPs();
  else if (cmd === 'status' || cmd === 'st') await cmdStatus();
  else if (cmd === 'stop') await cmdStop();
  else if (cmd === 'prune') await cmdPrune();
  else if (cmd === 'attach') await cmdAttach();
  else help();
} catch (e) {
  bad(e.message);
  process.exit(1);
}
