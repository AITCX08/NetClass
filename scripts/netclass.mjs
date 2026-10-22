#!/usr/bin/env node
/**
 * scripts/netclass.mjs —— 单入口
 *
 *   netclass up   --platform <key>          起一个实例（默认 offscreen，不抢焦点）
 *   netclass up   --platform <key> --login  起可见窗口让你手动登录
 *   netclass ps                             一屏看所有实例
 *   netclass stop <id|all>                  停实例（按 PID 整棵进程树带走）
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
  allocatePort, aliveCount, createProfile, defaultPort, formatTable, gate,
  getInstance, instanceProfile, listInstances, makeId, maxConcurrent,
  pidAlive, profileSize, removeInstance, saveInstance, loadPlatforms,
} from './instances.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, '..');

const C = {
  g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m',
};
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
  const port = await allocatePort(platform);
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
async function cmdStop() {
  const target = process.argv[3];
  if (!target) { bad('用法: netclass stop <id|all>'); process.exit(1); }

  const all = listInstances();
  const victims = target === 'all'
    ? all.filter((i) => pidAlive(i.pid))
    : all.filter((i) => i.id === target || i.platform === target);

  if (!victims.length) { warn('没有匹配的活实例'); return; }

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

// ---------------------------------------------------------------- help
function help() {
  console.log(`${C.b}NetClass${C.x} — 网课自动处理（Agent 工具包）

${C.b}用法${C.x}
  netclass up --platform <key>            起一个后台实例（不抢焦点）
  netclass up --platform <key> --login    起可见窗口，你自己登录
  netclass ps                             看所有实例
  netclass stop <id|all>                  停实例
  netclass status                         浏览器 + 并发 + 实例总览
  netclass attach <id>                    探活一个实例

${C.b}环境变量${C.x}
  NETCLASS_MAX_INSTANCES   并发上限（默认 4）
  NETCLASS_BROWSER_DIR     浏览器缓存目录
  NETCLASS_BROWSER_PATH    直接指定浏览器可执行文件
  NETCLASS_USE_SYSTEM_BROWSER=1  降级用系统 Edge/Chrome（版本不锁定）

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
  else if (cmd === 'attach') await cmdAttach();
  else help();
} catch (e) {
  bad(e.message);
  process.exit(1);
}
