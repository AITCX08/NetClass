#!/usr/bin/env node
/**
 * scripts/launch.mjs —— 三态浏览器启动器 + CDP 预注入
 *
 * 为什么不用扩展
 * --------------
 * MV3 的 `chrome.userScripts.register()` 需要在扩展详情页手动打开
 * 「允许用户脚本」开关（per-extension, per-profile），**CLI 改不了**。
 * 新 profile 里默认关闭 → 注册静默失败 → 页面上什么都不出现也不报错。
 * 这条把"一键启动"卡死了。
 *
 * 改用 CDP `Page.addScriptToEvaluateOnNewDocument`：
 *   零安装、零开发者模式、零手动开关，脚本在页面加载【之前】就注入好。
 * 执行 world 同样是 MAIN（与 MV3 userScripts 一致）。
 * 代价：多一个 CDP 连接特征 —— 但我们本来就用 CDP 驱动，特征早已存在。
 *
 * 三种显示模式
 * ------------
 *   headless   --headless=new，完全无窗口。最省资源，但媒体栈可能被节流。
 *   offscreen  有窗口但放在 (-32000,-32000)，用户看不见、不抢焦点，
 *              媒体栈走完整路径。**播放速率被节流时自动升级到这一档。**
 *   headed     正常窗口，用于登录 / 人工验证。
 *
 * 三档的取舍来自实测：SSH 起的浏览器在 Session 0 没有可见窗口，CDP 照样工作、
 * 视频照样播；长春那个窗口其实一直在 -32000,-32000 正常工作。
 * 所以"看不见"不等于"跑不动"，但"完全 headless"确实可能被节流。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 注入源
/**
 * 选注入脚本。优先 dist/netclass.user.js（自包含），退回 userscript/App.js。
 * 两者都会挂 window.NetClass。
 */
export function pickInjectSource(explicit) {
  const cands = [
    explicit,
    process.env.NETCLASS_INJECT,
    join(REPO, 'dist', 'netclass.user.js'),
    join(REPO, 'userscript', 'App.js'),
  ].filter(Boolean);
  for (const p of cands) {
    if (existsSync(p)) return { path: p, code: readFileSync(p, 'utf8') };
  }
  throw new Error('找不到要注入的脚本（dist/netclass.user.js 或 userscript/App.js）——先跑 node scripts/build.mjs');
}

// ---------------------------------------------------------------- 参数
/**
 * 各模式共用的 switch。每一条都是踩出来的，别删：
 *  - 防节流三件套：窗口不在前台时 Chrome 会掐定时器/降帧，视频就不动了
 *  - CalculateNativeWinOcclusion：窗口被判定"被遮挡"会整页降频（offscreen 模式尤其致命）
 *  - autoplay-policy：视频要能自己播，不能等用户手势
 *  - ExtensionsOnChromeUrls / FirstRun：干净起步
 */
function commonFlags({ port, profile, mode }) {
  const f = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,TranslateUI',
    '--disable-component-update',
    '--disable-sync',
    '--disable-breakpad',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1280,900',
  ];
  if (process.platform === 'linux') f.push('--no-sandbox', '--disable-dev-shm-usage');
  if (process.platform === 'win32') f.push('--no-sandbox');

  if (mode === 'headless') {
    f.push('--headless=new', '--disable-gpu');
  } else if (mode === 'offscreen') {
    // 有窗口但移到屏幕外：完整媒体栈 + 不抢焦点
    f.push('--window-position=-32000,-32000');
  } else {
    f.push('--window-position=80,60');
  }
  return f;
}

// ---------------------------------------------------------------- CDP 客户端
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.contexts = [];
    this.onEvent = null;
  }

  async connect(timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        this.ws = new WebSocket(this.wsUrl);
        await new Promise((res, rej) => {
          this.ws.addEventListener('open', res, { once: true });
          this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
          setTimeout(() => rej(new Error('ws timeout')), 5000);
        });
        this.ws.addEventListener('message', (e) => {
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
          if (m.method === 'Runtime.executionContextCreated') this.contexts.push(m.params.context);
          if (this.onEvent) this.onEvent(m);
        });
        return this;
      } catch (e) {
        await sleep(400);
      }
    }
    throw new Error(`CDP 连接超时: ${this.wsUrl}`);
  }

  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((res) => {
      const id = ++this.id;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); res({}); } }, timeoutMs);
    });
  }

  async eval(expression, contextId) {
    const r = await this.send('Runtime.evaluate', {
      expression, contextId, returnByValue: true, awaitPromise: true,
    });
    return r?.result?.result?.value;
  }

  close() { try { this.ws?.close(); } catch { } }
}

// ---------------------------------------------------------------- WMI 拉起
/**
 * 用 WMI 的 Win32_Process.Create 启动进程。
 * 这样父进程是 WMI 服务（svchost），不是我们的 shell/SSH 会话，
 * 会话结束、SSH 断开、CLI 退出都不会带走浏览器。
 *
 * 踩过的坑：CommandLine 里引用要成对。直接把参数用单引号包进 PowerShell 会坏，
 * 所以先写一个临时 .ps1 再跑，彻底避开引号地狱。
 */
function spawnViaWmi(exe, args) {
  const q = (s) => (/[\s"]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s));
  const cmdline = q(exe) + ' ' + args.map(q).join(' ');

  const tmp = join(
    process.env.TEMP || process.env.TMP || '.',
    `netclass-launch-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ps1`,
  );
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$cmd = @\'',
    cmdline,
    '\'@',
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
    'if ($r.ReturnValue -ne 0) { Write-Output ("ERR:" + $r.ReturnValue); exit 1 }',
    'Write-Output $r.ProcessId',
  ].join('\n');

  try {
    writeFileSync(tmp, '\ufeff' + script, 'utf8');
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    const out = String(r.stdout || '').trim();
    if (r.status !== 0 || out.startsWith('ERR') || !/^\d+$/.test(out)) {
      throw new Error(`WMI 启动失败: ${out || r.stderr || 'unknown'}`);
    }
    return Number(out);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { }
  }
}

// ---------------------------------------------------------------- 端口就绪
async function waitForCDP(port, timeoutMs = 45000) {  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const vs = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return vs;
    } catch { await sleep(400); }
  }
  throw new Error(`浏览器 ${timeoutMs}ms 内没在 ${port} 上开 CDP`);
}

/** 找 /json/list 里的页面目标 */
async function firstPage(port) {
  const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return l.find((t) => t.type === 'page') || null;
}

// ---------------------------------------------------------------- 启动
/**
 * @param {object} o
 * @param {number} o.port        CDP 端口（必填）
 * @param {string} o.profile     user-data-dir（必填，实例独占）
 * @param {'headless'|'offscreen'|'headed'} [o.mode='offscreen']
 * @param {string} [o.url]       启动后导航到的地址
 * @param {boolean} [o.inject=true] 是否做 CDP 预注入
 * @param {string} [o.injectSource] 指定注入文件
 * @param {string[]} [o.extraFlags]
 */
export async function launch(o = {}) {
  const {
    port,
    profile,
    mode = 'offscreen',
    url = 'about:blank',
    inject = true,
    injectSource,
    extraFlags = [],
    quiet = false,
  } = o;

  if (!port) throw new Error('launch: 缺 port');
  if (!profile) throw new Error('launch: 缺 profile（每实例必须独占 user-data-dir）');

  const log = quiet ? () => { } : (...a) => console.log('  ' + a.join(' '));

  const browser = await resolveBrowser({ quiet: true });
  log(`浏览器  ${browser.version || '?'}  ${browser.fallback ? '(系统降级)' : ''}`);

  mkdirSync(profile, { recursive: true });
  // 清掉上次残留的单实例锁，否则新进程会直接退出
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(profile, f), { force: true, recursive: true }); } catch { }
  }

  const flags = [...commonFlags({ port, profile, mode }), ...extraFlags];
  if (mode === 'headless') flags.push('about:blank'); // 避免 headless 下没 target

  log(`模式    ${mode}   端口 ${port}`);

  // ★ Windows 上 detached:true 仍然不够：子进程继承父 console，SSH 会话一关就被带走
  //   （实测「启动成功」后 6 秒端口消失）。改用 WMI Win32_Process.Create，
  //   父进程是 WMI 服务而不是我们的 shell，才能真正脱离。
  let childPid = null;
  let child = null;
  if (process.platform === 'win32') {
    childPid = spawnViaWmi(browser.path, flags);
  } else {
    child = spawn(browser.path, flags, { stdio: 'ignore', detached: true });
    child.unref();
    childPid = child.pid;
  }

  const version = await waitForCDP(port);
  log(`CDP     ${version.Browser}`);

  const cdp = await new CDP('').connect(0).catch(() => null); // 占位，下面用页面 ws
  let page = await firstPage(port);
  if (!page) {
    // 有些环境下没页面目标，手动开一个
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).catch(() => { });
    await sleep(800);
    page = await firstPage(port);
  }
  if (!page) throw new Error('浏览器起来了但没有 page target');

  const client = new CDP(page.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');

  let injectInfo = null;
  if (inject) {
    const src = pickInjectSource(injectSource);
    // ★ 关键：在 document 创建【之前】就登记，页面一加载即生效
    const r = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: src.code });
    injectInfo = { path: src.path, bytes: src.code.length, identifier: r?.result?.identifier };
    log(`注入    ${src.path.split(/[\\/]/).pop()} (${(src.code.length / 1024).toFixed(0)}KB)`);
  }

  if (url && url !== 'about:blank') {
    await client.send('Page.navigate', { url });
    log(`导航    ${url.slice(0, 70)}`);
  }

  return {
    port,
    pid: childPid,
    mode,
    profile,
    browser: browser.path,
    browserVersion: browser.version,
    fallback: !!browser.fallback,
    inject: injectInfo,
    cdp: client,
    /** 关闭：先 CDP 优雅关，再按 PID 强杀（Chrome 的子进程要一起带走） */
    async close({ killTree = true } = {}) {
      try { await client.send('Browser.close', {}, 3000); } catch { }
      client.close();
      await sleep(600);
      if (killTree && childPid) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } else {
            try { process.kill(-childPid, 'SIGKILL'); } catch { process.kill(childPid, 'SIGKILL'); }
          }
        } catch { }
      }
    },
  };
}

// ---------------------------------------------------------------- 探活
export async function cdpAlive(port, timeoutMs = 3000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- CLI
async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };
  const has = (k) => process.argv.includes('--' + k);

  if (has('selftest')) {
    const port = Number(arg('port', 9401));
    const profile = join(REPO, 'runs', 'launch-selftest-profile');
    console.log(`selftest: 起一个 offscreen 实例 @ ${port}`);
    const h = await launch({ port, profile, mode: 'offscreen', url: 'about:blank' });
    const v = await h.cdp.eval('1+1');
    console.log(`  渲染器探活 1+1 = ${v}`);
    const nc = await h.cdp.eval('window.NetClass ? window.NetClass.version : null');
    console.log(`  window.NetClass = ${nc || '(尚未，因为 about:blank)'}`);
    await h.close();
    console.log('  ✅ selftest 通过');
    return;
  }

  const port = Number(arg('port', 0));
  const profile = arg('profile', '');
  const mode = arg('mode', 'offscreen');
  const url = arg('url', 'about:blank');
  if (!port || !profile) {
    console.log('用法: node scripts/launch.mjs --port 9250 --profile <dir> [--mode headless|offscreen|headed] [--url <u>] [--selftest]');
    return;
  }
  const h = await launch({ port, profile, mode, url });
  console.log(JSON.stringify({ port: h.port, pid: h.pid, mode: h.mode, inject: h.inject }, null, 2));
  if (!has('keep')) await h.close();
}

if (process.argv[1]?.endsWith('launch.mjs')) {
  main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
