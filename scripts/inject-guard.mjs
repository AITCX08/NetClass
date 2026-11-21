#!/usr/bin/env node
/**
 * scripts/inject-guard.mjs —— 新标签自动注入守护
 *
 * 为什么需要它
 * ------------
 * launch.mjs 用的是 CDP `Page.addScriptToEvaluateOnNewDocument`，它是**按 target** 注册的。
 * 页面自己 `window.open` / `LiveOpenVideoPlay()` 开出来的新标签是**新 target**，
 * 拿不到那份注册 → 新标签上没有 NetClass 面板。
 *
 * 华医网（91huayi）的直播回放就是这样：列表页点条目 → 开新标签到 CoursePlay，
 * 新标签永远是白板。别的平台没暴露这个问题只是因为他们不这么跳。
 *
 * 做法
 * ----
 * 长跑守护：每 N 秒扫一次 http://127.0.0.1:<port>/json/list，
 * 对「匹配 host 且 typeof window.NetClass === 'undefined'」的页面注入 dist/netclass.user.js。
 * 注入是幂等的（已有就跳过），所以扫得再勤也不会重复挂面板。
 *
 * 用法
 * ----
 *   node scripts/inject-guard.mjs --port 9231                       # 每 3s 扫，全平台匹配
 *   node scripts/inject-guard.mjs --port 9231 --match 91huayi       # 只盯华医网
 *   node scripts/inject-guard.mjs --port 9231 --every 5 --once      # 跑一轮就退出
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, '..');

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const PORT = Number(arg('port', 9231));
const EVERY = Number(arg('every', 3)) * 1000;
const ONCE = !!arg('once', false);
const MATCH = String(arg('match', '') || '');
const QUIET = !!arg('quiet', false);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => { if (!QUIET) console.log('[' + ts() + ']', ...a); };

// ---- 注入源
function loadSource() {
  const cands = [
    process.env.NETCLASS_INJECT,
    join(REPO, 'dist', 'netclass.user.js'),
    join(REPO, 'userscript', 'App.js'),
  ].filter(Boolean);
  for (const p of cands) {
    if (existsSync(p)) {
      const st = statSync(p);
      return { path: p, code: readFileSync(p, 'utf8'), mtime: st.mtimeMs, size: st.size };
    }
  }
  throw new Error('找不到注入源（先跑 node scripts/build.mjs）');
}

/**
 * ★ 2026-10-23：热重载。
 * 守护是长跑进程，如果只在启动时读一次 dist，改完代码 build 了新版本，守护还在
 * 往页面里塞旧脚本 —— 现象是「改了没生效，但注入日志一切正常」，很容易误判成缓存。
 * 每轮比一次 mtime+size，变了就重读。
 */
function currentSource(cur) {
  try {
    const st = statSync(cur.path);
    if (st.mtimeMs !== cur.mtime || st.size !== cur.size) {
      const code = readFileSync(cur.path, 'utf8');
      log('↻ 注入源已更新 (' + Math.round(cur.code.length / 1024) + 'KB → ' + Math.round(code.length / 1024) + 'KB)，后续注入用新版');
      return { ...cur, code, mtime: st.mtimeMs, size: st.size };
    }
  } catch (_) { }
  return cur;
}

// ---- 单页注入
async function injectInto(target, code) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });

  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params = {}, to = 20000) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({}); } }, to);
  });

  try {
    await send('Runtime.enable');
    // 已经在就跳过（幂等）
    const pre = await send('Runtime.evaluate', { expression: `typeof window.NetClass`, returnByValue: true });
    const kind = pre.result?.result?.value;
    if (kind && kind !== 'undefined') return { skipped: true, kind };

    // 页面还在加载时注入会失败，等它 interactive/complete
    const rs = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (rs.result?.result?.value === 'loading') return { deferred: true };

    const r = await send('Runtime.evaluate', { expression: code, returnByValue: true });
    const exc = r.result?.exceptionDetails;
    if (exc) return { failed: (exc.text || 'exception').slice(0, 100) };

    await sleep(900);
    const post = await send('Runtime.evaluate', {
      expression: `JSON.stringify({nc: typeof window.NetClass, ver: (window.NetClass&&window.NetClass.version)||null, plat: (window.NetClass&&window.NetClass.state&&window.NetClass.state.platform)||null})`,
      returnByValue: true,
    });
    let info = null;
    try { info = JSON.parse(post.result?.result?.value || 'null'); } catch { }
    return { injected: true, info };
  } finally {
    try { ws.close(); } catch { }
  }
}

// ---- 主循环
let src = loadSource();
log('守护启动  端口=' + PORT + '  每 ' + (EVERY / 1000) + 's  ' + (MATCH ? 'match=' + MATCH : '全平台') + '  源=' + src.path.split(/[\\/]/).pop() + ' (' + Math.round(src.code.length / 1024) + 'KB)');

const seen = new Map();   // targetId -> 上次处理结果
let round = 0;

for (;;) {
  round++;
  let list = [];
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(6000) });
    list = await r.json();
  } catch (e) {
    if (round === 1 || round % 20 === 0) log('CDP 不可达: ' + e.message);
    if (ONCE) break;
    await sleep(EVERY);
    continue;
  }

  src = currentSource(src);
  const pages = (Array.isArray(list) ? list : []).filter(t => t.type === 'page' && /^https?:/.test(t.url));
  for (const t of pages) {
    if (MATCH && !new RegExp(MATCH, 'i').test(t.url)) continue;
    let res;
    try {
      res = await injectInto(t, src.code);
    } catch (e) {
      res = { err: e.message };
    }

    const key = t.id;
    const sig = JSON.stringify(res);
    if (seen.get(key) === sig) continue;      // 状态没变就不刷日志
    seen.set(key, sig);

    const short = t.url.replace(/^https?:\/\//, '').slice(0, 62);
    if (res.injected) log('注入 ✓ ' + short + '  →  ' + JSON.stringify(res.info));
    else if (res.skipped) { if (round === 1) log('已有   ' + short); }
    else if (res.deferred) { /* 加载中，下轮再说，不刷屏 */ }
    else if (res.failed) log('失败 ✗ ' + short + '  ' + res.failed);
    else if (res.err) log('错误 ✗ ' + short + '  ' + res.err);
  }

  if (ONCE) break;
  await sleep(EVERY);
}

log('退出');
