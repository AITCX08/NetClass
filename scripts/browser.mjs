#!/usr/bin/env node
/**
 * scripts/browser.mjs —— 浏览器版本锁定与供应
 *
 * 为什么存在
 * ----------
 * 网课自动化对浏览器版本很敏感：CDP API、`--headless=new`、H.264/AAC 解码能力
 * 在不同 Chromium 构建上都不一样。用户自带的浏览器可能是 360/QQ/搜狗这类魔改
 * Chromium，也可能版本太老，行为完全不可复现。
 *
 * 所以本项目**锁定一个版本**：Chrome for Testing（Google 官方为自动化发布的构建）。
 *
 * 为什么不选 Chromium 快照
 * ------------------------
 * Chromium 开源构建的 ffmpeg_branding="Chromium"，**没有 H.264/AAC 解码器**。
 * 网课视频几乎全是 mp4(H.264+AAC) → 用 Chromium 直接放不出画面。这是硬伤。
 * Chrome for Testing 是 Chrome 构建，带完整专有编解码。
 *
 * 为什么不打包进仓库
 * ------------------
 * 163MB 会污染 git clone。改成首次运行时下载 + GitHub Release 提供可选离线包。
 * **一份二进制，多个 profile 共用** —— 开 4 个实例不会吃 4×163MB。
 *
 * 国内可达性（实测 2026-10）
 * -------------------------
 *   storage.googleapis.com         → 不可达（SSL 失败）
 *   registry.npmmirror.com         → 可达，163MB/约 60s
 * 所以镜像优先 npmmirror，官方源只作为境外用户的兜底。
 *
 * 校验链（Google 不发布 per-file SHA256，所以用功能性验证）
 * ------------------------------------------------------
 *   ① 字节数 == 镜像目录给出的 size
 *   ② zip 能解压
 *   ③ chrome --version 报出锁定的版本号   ← 最硬的一条
 *   ④ SHA256 记进 cacheDir/sha256-<ver>.txt（TOFU，供将来检测损坏/篡改）
 *
 * 用法
 * ----
 *   node scripts/browser.mjs status
 *   node scripts/browser.mjs install [--force]
 *   node scripts/browser.mjs path          # 打印可执行文件路径（必要时自动装）
 *   node scripts/browser.mjs which         # 报告最终会解析到哪个浏览器
 *   node scripts/browser.mjs use-system    # 强制降级到系统浏览器（调试用）
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, '..');

// ---------------------------------------------------------------- 平台标识
export function platformKey(plat = process.platform, arch = process.arch) {
  if (plat === 'win32') return arch === 'x64' ? 'win64' : 'win32';
  if (plat === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (plat === 'linux') return 'linux64';
  throw new Error(`不支持的平台: ${plat}/${arch}`);
}

/** zip 解出来的目录名 / 可执行文件名 */
function layout(key) {
  if (key.startsWith('win')) return { dir: `chrome-${key}`, exe: 'chrome.exe' };
  if (key.startsWith('mac')) return { dir: `chrome-${key}`, exe: 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' };
  return { dir: `chrome-${key}`, exe: 'chrome' };
}

// ---------------------------------------------------------------- 配置
const DEFAULTS = {
  engine: 'chrome-for-testing',
  version: '137.0.7151.55',
  /**
   * mirrors: {url} 会被替换成 <base>/<version>/<platform>/chrome-<platform>.zip
   * 顺序即优先级。国内用户第一个就命中；境外用户会很快落到官方源。
   */
  mirrors: [
    'https://registry.npmmirror.com/-/binary/chrome-for-testing',
    'https://storage.googleapis.com/chrome-for-testing-public',
  ],
  /** 镜像目录里给出的字节数，用于 ① 号校验（缺失则跳过该条） */
  expectedSize: { win64: 171065107, 'chrome-headless-shell-win64': 108635994 },
  allowFallback: true,
  autoUpdate: false,
};

export function loadConfig() {
  const p = join(REPO, 'config', 'browser.json');
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    console.warn(`  ⚠ config/browser.json 解析失败（${e.message}），用内置默认值`);
    return { ...DEFAULTS };
  }
}

/** 缓存根目录。优先级：NETCLASS_BROWSER_DIR > 配置 > LOCALAPPDATA */
export function cacheDir(cfg = loadConfig()) {
  if (process.env.NETCLASS_BROWSER_DIR) return process.env.NETCLASS_BROWSER_DIR;
  if (cfg.cacheDir) return cfg.cacheDir.replace(/^~/, process.env.USERPROFILE || process.env.HOME || '');
  const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || process.env.HOME || '.', '.local', 'share');
  return join(base, 'NetClass', 'browser');
}

function installedPath(cfg = loadConfig()) {
  const key = platformKey();
  const { dir, exe } = layout(key);
  return join(cacheDir(cfg), cfg.version, dir, exe);
}

// ---------------------------------------------------------------- 工具
const fmtMB = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';

function sha256File(p) {
  const h = createHash('sha256');
  h.update(readFileSync(p));
  return h.digest('hex');
}

/**
 * 读浏览器版本。
 *
 * ★ 踩过的坑：Windows 上 `chrome.exe --version` 与 `--product-version` **都不输出**。
 *   原因是 chrome.exe 是 GUI 子系统程序（/SUBSYSTEM:WINDOWS），不挂父控制台，
 *   没有 stdout —— 而且 `--version` 会真的开一个窗口出来。
 *
 * 所以分三层，按可靠性排序：
 *   ① Windows：读同目录的 `<version>.manifest`（Chrome for Testing 自带，纯文件系统操作）
 *   ② Unix：`--version` 正常打到 stdout
 *   ③ 兜底：读 PE 版本信息（VersionInfo.ProductVersion）
 */
function runVersion(exe) {
  const dir = dirname(exe);

  // ① Windows：Chrome for Testing 解压目录里有个 "137.0.7151.55.manifest"
  if (process.platform === 'win32') {
    try {
      const mf = readdirSync(dir).find((f) => /^\d+\.\d+\.\d+\.\d+\.manifest$/i.test(f));
      if (mf) return mf.replace(/\.manifest$/i, '');
    } catch { }

    // ③ 兜底：PE 版本信息
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
        { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const m = String(r.stdout || '').trim().match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) return m[1];
    } catch { }
    return null;
  }

  // ② Unix
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000 });
  const m = String((r.stdout || '') + (r.stderr || '')).match(/(\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** 探测系统浏览器（降级用，不是首选） */
export function detectSystemBrowser() {
  const key = platformKey();
  const candidates = [];
  if (key.startsWith('win')) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || '';
    candidates.push(
      { name: 'Edge', path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), priority: 1 },
      { name: 'Edge', path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), priority: 1 },
      { name: 'Chrome', path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), priority: 2 },
      { name: 'Chrome', path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), priority: 2 },
      { name: 'Chrome', path: join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'), priority: 3 },
      // OCS Desktop 内置的 Chrome for Testing（老用户机器上可能还有）
      { name: 'OCS-Chrome', path: join(la, 'Programs', 'OCS Desktop', 'resources', 'bin', 'chrome', 'chrome', 'chrome.exe'), priority: 9 },
    );
  } else if (key.startsWith('mac')) {
    candidates.push(
      { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', priority: 2 },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium', priority: 3 },
    );
  } else {
    candidates.push(
      { name: 'Chrome', path: '/usr/bin/google-chrome', priority: 2 },
      { name: 'Chromium', path: '/usr/bin/chromium', priority: 3 },
      { name: 'Chromium', path: '/usr/bin/chromium-browser', priority: 3 },
    );
  }
  for (const c of [...candidates].sort((a, b) => a.priority - b.priority)) {
    if (existsSync(c.path)) return { ...c, version: runVersion(c.path) };
  }
  return null;
}

// ---------------------------------------------------------------- 下载
async function download(url, dest, { onProgress } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let lastPrint = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    got += chunk.length;
    const now = Date.now();
    if (onProgress && now - lastPrint > 400) {
      lastPrint = now;
      onProgress(got, total);
    }
  });
  await pipeline(body, createWriteStream(dest));
  return { bytes: got, total };
}

/** 解压：优先用系统 tar（Win10 1803+ 的 bsdtar 能处理 zip），失败退回 Expand-Archive */
function extract(zip, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    let r = spawnSync('tar', ['-xf', zip, '-C', destDir], { encoding: 'utf8', timeout: 300000, windowsHide: true });
    if (r.status === 0) return 'tar';
    r = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destDir}' -Force`],
      { encoding: 'utf8', timeout: 600000, windowsHide: true });
    if (r.status === 0) return 'Expand-Archive';
    throw new Error('解压失败: ' + (r.stderr || r.stdout || 'unknown').slice(0, 300));
  }
  const r = spawnSync('unzip', ['-o', '-q', zip, '-d', destDir], { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error('解压失败: ' + (r.stderr || '').slice(0, 300));
  return 'unzip';
}

// ---------------------------------------------------------------- install
export async function install({ force = false, quiet = false } = {}) {
  const cfg = loadConfig();
  const key = platformKey();
  const { exe } = layout(key);
  const target = installedPath(cfg);
  const log = quiet ? () => { } : (...a) => console.log(...a);

  if (existsSync(target) && !force) {
    const v = runVersion(target);
    if (v === cfg.version) {
      log(`  ✅ 已就绪：Chrome for Testing ${v}`);
      return { path: target, version: v, cached: true };
    }
    log(`  ⚠ 已存在但版本不符（期望 ${cfg.version}，实际 ${v}），重装`);
  }

  const root = cacheDir(cfg);
  mkdirSync(root, { recursive: true });
  const zip = join(root, `chrome-${key}-${cfg.version}.zip`);

  let lastErr = null;
  for (const base of cfg.mirrors) {
    const url = `${base}/${cfg.version}/${key}/chrome-${key}.zip`;
    log(`  下载 ${cfg.version} (${key})`);
    log(`    源: ${base}`);
    try {
      const { bytes } = await download(url, zip, {
        onProgress: quiet ? undefined : (got, total) => {
          const pct = total ? ((got / total) * 100).toFixed(1) : '?';
          process.stdout.write(`\r    进度: ${fmtMB(got)}/${total ? fmtMB(total) : '?'} (${pct}%)   `);
        },
      });
      if (!quiet) process.stdout.write('\n');
      log(`    完成: ${fmtMB(bytes)}`);

      // ① 字节数校验
      const want = cfg.expectedSize?.[key];
      if (want && bytes !== want) throw new Error(`字节数不符（期望 ${want}，实得 ${bytes}）`);

      // ④ 记录 SHA256（TOFU）
      const hash = sha256File(zip);
      writeFileSync(join(root, `sha256-${cfg.version}.txt`), hash + '\n', 'ascii');
      log(`    SHA256: ${hash.slice(0, 16)}…（已记录）`);

      // ② 解压
      const how = extract(zip, join(root, cfg.version));
      log(`    解压: ${how}`);

      // ③ 版本校验 —— 最硬的一条
      if (!existsSync(target)) throw new Error(`解压后找不到可执行文件: ${target}`);
      const v = runVersion(target);
      if (v !== cfg.version) throw new Error(`版本校验失败（期望 ${cfg.version}，实得 ${v}）`);
      log(`  ✅ Chrome for Testing ${v} 就绪`);

      try { rmSync(zip, { force: true }); } catch { }
      return { path: target, version: v, cached: false };
    } catch (e) {
      lastErr = e;
      log(`    ✗ ${e.message}`);
      try { rmSync(zip, { force: true }); } catch { }
    }
  }

  // 全部镜像失败 → 降级
  if (cfg.allowFallback) {
    const sys = detectSystemBrowser();
    if (sys) {
      console.warn(`\n  ⚠ 下载失败，降级到系统浏览器：${sys.name} ${sys.version || '(版本未知)'}`);
      console.warn(`  ⚠ 版本未锁定，可能出现 --headless=new 缺失、编解码差异、CDP 行为不同`);
      return { path: sys.path, version: sys.version, fallback: true, name: sys.name };
    }
  }

  throw new Error(
    `无法获得浏览器。最后错误：${lastErr?.message}\n\n` +
    `三条出路：\n` +
    `  1) 换镜像重试：  NETCLASS_BROWSER_MIRROR=<url> node scripts/browser.mjs install --force\n` +
    `  2) 安装 Edge：    winget install Microsoft.Edge\n` +
    `  3) 下载离线包解压到：${join(root, cfg.version)}\n` +
    `     （GitHub Release 附件 netclass-browser-${key}-${cfg.version}.zip）`
  );
}

// ---------------------------------------------------------------- 解析入口
/**
 * 拿到可用的浏览器路径。
 * 优先：环境变量覆盖 > 锁定版本（必要时下载）> 系统浏览器降级
 */
export async function resolveBrowser({ quiet = false } = {}) {
  if (process.env.NETCLASS_BROWSER_PATH) {
    const p = process.env.NETCLASS_BROWSER_PATH;
    if (!existsSync(p)) throw new Error(`NETCLASS_BROWSER_PATH 指向的文件不存在: ${p}`);
    return { path: p, version: runVersion(p), override: true };
  }
  const cfg = loadConfig();
  const target = installedPath(cfg);
  if (existsSync(target) && runVersion(target) === cfg.version) {
    return { path: target, version: cfg.version, cached: true };
  }
  if (process.env.NETCLASS_USE_SYSTEM_BROWSER === '1') {
    const sys = detectSystemBrowser();
    if (!sys) throw new Error('NETCLASS_USE_SYSTEM_BROWSER=1 但没找到任何系统浏览器');
    return { path: sys.path, version: sys.version, fallback: true, name: sys.name };
  }
  return install({ quiet });
}

// ---------------------------------------------------------------- CLI
async function main() {
  const cmd = process.argv[2] || 'status';
  const cfg = loadConfig();
  const key = platformKey();

  if (cmd === 'status') {
    const p = installedPath(cfg);
    const has = existsSync(p);
    const v = has ? runVersion(p) : null;
    console.log('浏览器状态');
    console.log(`  引擎        Chrome for Testing（锁定 ${cfg.version}）`);
    console.log(`  平台        ${key}`);
    console.log(`  缓存目录    ${cacheDir(cfg)}`);
    console.log(`  已安装      ${has ? `是 (${v})` : '否'}`);
    if (has) console.log(`  路径        ${p}`);
    const sys = detectSystemBrowser();
    console.log(`  系统浏览器  ${sys ? `${sys.name} ${sys.version || ''} @ ${sys.path}` : '（未找到）'}`);
    console.log(`  自动升级    ${cfg.autoUpdate ? '开启' : '关闭（必须显式 install --force）'}`);
    return;
  }

  if (cmd === 'install') {
    await install({ force: process.argv.includes('--force') });
    return;
  }

  if (cmd === 'path') {
    const r = await resolveBrowser();
    console.log(r.path);
    return;
  }

  if (cmd === 'which') {
    const r = await resolveBrowser();
    const src = r.override ? 'env 覆盖' : r.fallback ? `系统降级 (${r.name})` : r.cached ? '缓存命中' : '刚刚安装';
    console.log(`${r.path}  [${r.version}]  ← ${src}`);
    return;
  }

  if (cmd === 'use-system') {
    const sys = detectSystemBrowser();
    if (!sys) { console.error('没找到系统浏览器'); process.exit(1); }
    console.log(`系统浏览器: ${sys.name} ${sys.version || ''}\n${sys.path}`);
    console.log('\n用它可以这样跑：');
    console.log(`  $env:NETCLASS_USE_SYSTEM_BROWSER = "1"`);
    return;
  }

  console.log('用法: node scripts/browser.mjs <status|install|path|which|use-system> [--force]');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('browser.mjs')) {
  main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
