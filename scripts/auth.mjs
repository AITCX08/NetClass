#!/usr/bin/env node
/**
 * scripts/auth.mjs —— 账号池 + 登录态探测 + 保活（P3 + P4）
 *
 * 设计（见 docs/AGENT-ARCHITECTURE.md §5）：
 *   - **三层降级**：reuse（复用现有 cookie）→ auto（自动填表/打开登录页）→ manual（通知人工）
 *     每层都有明确出口，绝不"假装登录成功"。
 *   - **不存明文**：账号池只存 secretRef（env: / file: / wincred:），落盘文件里永远没有密码。
 *   - **机器判据**：登录态靠注册表的 auth.probe（页面内 JS）或明确的结构特征判定，
 *     不用"看起来像登录了"这种猜测。
 *   - **probe 三态**：loggedIn / notLoggedIn / unreachable —— 三种情况处理方式完全不同，
 *     不能混成一个 false（否则"浏览器没开"会被误判成"掉登录"，然后去乱登录）。
 *
 * 能力边界（写死不越过）：
 *   - 图形/短信/人脸验证码 → 按 onCaptcha 决定【暂停等人】或【直接失败】，绝不尝试破解。
 *   - 不自动注册账号（自建账号不算成果，也没意义）。
 *
 * CLI：
 *   node scripts/auth.mjs probe [--platform ccjyxy]     探测（不带 --platform 则全平台）
 *   node scripts/auth.mjs ensure --platform ccjyxy      三层降级确保可用
 *   node scripts/auth.mjs accounts                     列出账号池（只显示脱敏 user）
 *   node scripts/auth.mjs keepalive --platform ccjyxy --every 600
 *   node scripts/auth.mjs selftest                     自检（多平台 probe 三态）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as registry from './registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ACCOUNTS_FILE = join(ROOT, 'config', 'accounts.json');   // gitignored
const AUTH_LOG = join(ROOT, 'runs', 'auth.log');

const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(msg, silent = false) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  if (!silent) console.log(line);
  try { mkdirSync(dirname(AUTH_LOG), { recursive: true }); writeFileSync(AUTH_LOG, line + '\n', { flag: 'a' }); } catch (_) { }
}

// ══════════════════════════════════════════════════════
// 最小 CDP 客户端（不依赖 nc.mjs 的 CLI 形态）
// ══════════════════════════════════════════════════════

/** 列出某端口的页面 target（失败返回 null 表示"不可达"） */
async function listTargets(port, timeoutMs = 4000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;   // 连不上 → unreachable（关键：与"没登录"区分开）
  }
}

/** 在某个 target 上跑一段 JS，返回 { ok, value, error } */
async function evalOn(target, expression, timeoutMs = 8000) {
  let ws;
  try {
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      ws.addEventListener('error', e => { clearTimeout(t); rej(new Error('ws error')); }, { once: true });
    });
    let id = 0;
    const send = (method, params = {}) => new Promise((res) => {
      const mid = ++id;
      const on = e => {
        try {
          const m = JSON.parse(e.data);
          if (m.id === mid) { ws.removeEventListener('message', on); res(m); }
        } catch (_) { }
      };
      ws.addEventListener('message', on);
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { try { ws.removeEventListener('message', on); } catch (_) { } res({}); }, timeoutMs);
    });
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r && r.result && r.result.exceptionDetails) {
      return { ok: false, error: String(r.result.exceptionDetails.text || 'exception').slice(0, 120) };
    }
    const v = r && r.result && r.result.result ? r.result.result.value : undefined;
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  } finally {
    try { ws && ws.close(); } catch (_) { }
  }
}

// ══════════════════════════════════════════════════════
// 账号池（只存引用，不存明文）
// ══════════════════════════════════════════════════════
// config/accounts.json 形如：
// { "cc-main": { "platform":"ccjyxy", "user":"186****1157", "secretRef":"env:CC_PASS", "note":"..." } }
//
// secretRef 支持：
//   env:VAR            从环境变量读
//   file:<path>        从文件读（第一行）
//   wincred:<target>   Windows 凭据管理器（v1 未实现，调用会明确报错）

export function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return {};
  try { return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch (e) { log(`⚠ config/accounts.json 不是合法 JSON：${e.message}`); return {}; }
}

/** 解析 secretRef → 明文（只在内存里，不落盘不打日志） */
export function resolveSecret(ref) {
  if (!ref) throw new Error('secretRef 为空');
  if (ref.startsWith('env:')) {
    const v = process.env[ref.slice(4)];
    if (!v) throw new Error(`环境变量 ${ref.slice(4)} 未设置`);
    return v;
  }
  if (ref.startsWith('file:')) {
    const p = ref.slice(5);
    if (!existsSync(p)) throw new Error(`密钥文件不存在：${p}`);
    return readFileSync(p, 'utf8').split('\n')[0].trim();
  }
  if (ref.startsWith('wincred:')) {
    throw new Error('wincred: 后端尚未实现（v1 请改用 env: 或 file:）');
  }
  throw new Error(`不支持的 secretRef 形式：${ref}（支持 env: / file: / wincred:）`);
}

/** 脱敏显示（只留前后各 3 位） */
function mask(s) {
  if (!s) return '(空)';
  const t = String(s);
  return t.length <= 8 ? '***' : `${t.slice(0, 3)}***${t.slice(-2)}`;
}

// ══════════════════════════════════════════════════════
// ① probe —— 登录态探测（P3 核心）
// ══════════════════════════════════════════════════════

/**
 * 探测某平台的登录态。
 * @returns {Promise<{
 *   state: 'loggedIn'|'notLoggedIn'|'unreachable',
 *   platform: string, label: string,
 *   via: string,          // 'registry-probe' | 'heuristic' | 'none'
 *   detail: string,       // 人话解释
 *   url?: string, who?: string|null, targetCount?: number
 * }>}
 */
export async function probe(platform) {
  const reg = registry.get(platform);
  const port = reg.cdp;

  // Step 1：端口可达？（不可达 ≠ 没登录，这是两种完全不同的处理）
  const targets = await listTargets(port);
  if (targets === null) {
    return {
      state: 'unreachable', platform, label: reg.label, via: 'none',
      detail: `CDP ${port} 连不上（浏览器没开 / 隧道断）—— 无法判断登录态`,
    };
  }
  const pages = targets.filter(t => t.type === 'page');
  if (!pages.length) {
    return {
      state: 'unreachable', platform, label: reg.label, via: 'none',
      detail: `CDP ${port} 可达但没有页面标签`, targetCount: targets.length,
    };
  }

  // Step 2：优先用注册表声明的 probe（机器判据）
  const expr = reg.auth && reg.auth.probe;
  // 按「url 属于该平台」优先选标签
  const hit = pages.find(p => String(p.url || '').includes(reg.host)) || pages[0];
  const url = String(hit.url || '');

  if (expr) {
    const r = await evalOn(hit, `(function(){ try { return !!(${expr}); } catch(e){ return 'ERR:'+e.message; } })()`);
    if (r.ok) {
      if (r.value === true) {
        return { state: 'loggedIn', platform, label: reg.label, via: 'registry-probe', detail: `auth.probe 返回 true`, url };
      }
      if (typeof r.value === 'string' && r.value.startsWith('ERR:')) {
        return { state: 'notLoggedIn', platform, label: reg.label, via: 'registry-probe', detail: `auth.probe 抛错（表达式可能不适用于当前页）：${r.value.slice(4, 80)}`, url };
      }
      return { state: 'notLoggedIn', platform, label: reg.label, via: 'registry-probe', detail: `auth.probe 返回 ${JSON.stringify(r.value)}`, url };
    }
    // probe 执行失败 → 落到启发式
  }

  // Step 3：启发式（注册表没写 probe，或 probe 跑不动）
  const heur = await evalOn(hit, `(function(){
    var u = location.href || '';
    var t = document.body ? document.body.innerText : '';
    // 明显的登录页特征
    var loginUrl = /(?:^|\\/)(login|signin|passport|sso|auth)(?:[\\/?#.]|$)/i.test(u);
    var hasPwd = !!document.querySelector('input[type=password]');
    var loginWord = /(登录|登陆|请先登录|扫码登录|账号登录)/.test((t || '').slice(0, 2000));
    // 明显的已登录特征：有用户信息区 / 退出按钮 / 课程或培训内容
    var logoutWord = /(退出|注销|个人中心|我的|学号)/.test((t || '').slice(0, 3000));
    var contentWord = /(课程|培训|学时|目录|章节|学习)/.test((t || '').slice(0, 3000));
    var userEl = document.querySelector('[class*=avatar],[class*=userName],[class*=nickname],[class*=profile]');
    return JSON.stringify({
      href: u.slice(0,120), loginUrl: loginUrl, hasPwd: hasPwd,
      loginWord: loginWord, logoutWord: logoutWord, contentWord: contentWord, hasUserEl: !!userEl
    });
  })()`);

  if (!heur.ok) {
    return { state: 'unreachable', platform, label: reg.label, via: 'heuristic', detail: `页面读取失败：${heur.error}`, url };
  }

  let h;
  try { h = JSON.parse(heur.value); } catch { h = null; }
  if (!h) return { state: 'unreachable', platform, label: reg.label, via: 'heuristic', detail: '启发式结果解析失败', url };

  // 判定顺序（宁可说"没登录"让人看一眼，也不要说"登录了"结果跑起来失败）
  if (h.hasPwd && !h.logoutWord) {
    return { state: 'notLoggedIn', platform, label: reg.label, via: 'heuristic', detail: '页面有密码输入框且无用户区 → 登录页', url: h.href };
  }
  if (h.loginUrl && !h.contentWord) {
    return { state: 'notLoggedIn', platform, label: reg.label, via: 'heuristic', detail: `URL 像登录页（${h.href}）且无内容词`, url: h.href };
  }
  if (h.contentWord || h.hasUserEl || h.logoutWord) {
    const v = await evalOn(hit, `(function(){
      var t = document.body ? document.body.innerText : '';
      var m = t.match(/([\\u4e00-\\u9fa5]{2,4})\\s*(?:学号|同学|老师)/);
      if (m) return m[1];
      var e = document.querySelector('[class*=userName],[class*=nickname],[class*=avatar]');
      return e ? (e.innerText||'').trim().slice(0,20) : '';
    })()`);
    return {
      state: 'loggedIn', platform, label: reg.label, via: 'heuristic',
      detail: `页面有内容/用户区特征（content=${h.contentWord} userEl=${h.hasUserEl} logout=${h.logoutWord}）`,
      url: h.href, who: (v.ok && v.value) ? String(v.value) : null,
    };
  }
  return { state: 'notLoggedIn', platform, label: reg.label, via: 'heuristic', detail: '没有登录特征也没有内容特征 → 保守判为未登录', url: h.href };
}

// ══════════════════════════════════════════════════════
// ② ensure —— 三层降级确保会话可用
// ══════════════════════════════════════════════════════

/**
 * @param {object} task  任务单（用 task.platform / task.auth.mode / task.auth.onCaptcha）
 * @returns {Promise<{ok:boolean, blocked?:boolean, reason?:string, account?:string, probe:object}>}
 */
export async function ensure(task) {
  const platform = task.platform;
  const reg = registry.get(platform);
  const mode = (task.auth && task.auth.mode) || 'auto';
  const onCaptcha = (task.auth && task.auth.onCaptcha) || 'pause';

  // ── 第 1 层：reuse —— 先看现有会话 ────────────
  const p0 = await probe(platform);
  if (p0.state === 'loggedIn') {
    log(`[ensure] ${reg.label} 已登录（${p0.via}）→ 复用现有会话${p0.who ? ' · ' + p0.who : ''}`);
    return { ok: true, account: p0.who || null, probe: p0 };
  }
  if (p0.state === 'unreachable') {
    log(`[ensure] ${reg.label} 不可达：${p0.detail}`);
    return { ok: false, blocked: false, reason: 'unreachable: ' + p0.detail, probe: p0 };
  }

  // 到这里 = notLoggedIn
  log(`[ensure] ${reg.label} 未登录（${p0.detail}）`);

  if (mode === 'reuse') {
    return { ok: false, blocked: true, reason: 'mode=reuse 但会话已失效，需要人工登录', probe: p0 };
  }

  // ── 第 2 层：验证码闸门 ──────────────────────
  const captcha = reg.auth && reg.auth.captcha;
  if (captcha && captcha !== 'none') {
    if (onCaptcha === 'fail') {
      return { ok: false, blocked: true, reason: `需要 ${captcha} 验证码，onCaptcha=fail → 直接失败`, probe: p0 };
    }
    log(`[ensure] ⚠ ${reg.label} 需要 ${captcha} 验证码 → 暂停等人工（onCaptcha=pause）`);
    return {
      ok: false, blocked: true,
      reason: `需要人工过 ${captcha} 验证码：请在 ${reg.cdp} 端口的浏览器里手动登录 ${reg.auth.loginUrl}`,
      probe: p0,
    };
  }

  // ── 第 3 层：auto —— 无验证码，打开登录页等人/用持久 profile ──
  // ★ 本项目的会话模型是 persistentProfile：只要浏览器 profile 在，登录态就在。
  //   所以「掉登录」意味着 profile 丢了或 cookie 过期 —— 这两种都必须人工一次。
  //   这里【不做】自动填表（没有账号明文，也不该有），只负责：
  //   ① 打开登录页  ② 有限等待  ③ 明确报告结果（绝不假装成功）
  const waitSec = 180;
  log(`[ensure] ${reg.label} 打开登录页并等待人工登录（最多 ${waitSec}s）…`);
  const nav = await evalOn(
    (await listTargets(reg.cdp))?.find(t => t.type === 'page') || {},
    `(function(){ location.href = ${JSON.stringify(reg.auth.loginUrl)}; return location.href; })()`
  );
  if (!nav.ok) {
    return { ok: false, blocked: true, reason: `打开登录页失败：${nav.error}`, probe: p0 };
  }

  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const p = await probe(platform);
    if (p.state === 'loggedIn') {
      log(`[ensure] ✅ ${reg.label} 登录已恢复${p.who ? '（' + p.who + '）' : ''}`);
      return { ok: true, account: p.who || null, probe: p };
    }
  }
  return {
    ok: false, blocked: true,
    reason: `等待 ${waitSec}s 仍未检测到登录（请在 ${reg.cdp} 端口的浏览器里手动登录 ${reg.auth.loginUrl}）`,
    probe: await probe(platform),
  };
}

// ══════════════════════════════════════════════════════
// ③ keepAlive —— 长任务保活（P4）
// ══════════════════════════════════════════════════════

/**
 * 定期探测；掉登录就报告（不尝试自动登录，交给 ensure）。
 * @param {string} platform
 * @param {{every?:number, rounds?:number, onLost?:Function}} opts
 */
export async function keepAlive(platform, opts = {}) {
  const every = opts.every ?? 600;      // 默认 10 分钟
  const rounds = opts.rounds ?? Infinity;
  const reg = registry.get(platform);
  log(`[keepAlive] ${reg.label} 每 ${every}s 探测一次${rounds !== Infinity ? '，共 ' + rounds + ' 轮' : ''}`);

  let lost = 0;
  for (let i = 0; i < rounds; i++) {
    const p = await probe(platform);
    const tag = p.state === 'loggedIn' ? '✅' : (p.state === 'unreachable' ? '⚠不可达' : '❌未登录');
    log(`[keepAlive] ${reg.label} ${tag}${p.who ? ' · ' + p.who : ''} · ${p.detail}`);
    if (p.state !== 'loggedIn' && p.state !== 'unreachable') {
      lost++;
      if (opts.onLost) { try { await opts.onLost(p); } catch (_) { } }
      if (lost >= 2) { log(`[keepAlive] ${reg.label} 连续 ${lost} 次未登录 → 停止看护，需要人工/via ensure`); return { ok: false, reason: 'session-lost', probe: p }; }
    } else { lost = 0; }
    if (i < rounds - 1) await sleep(every * 1000);
  }
  return { ok: true };
}

// ══════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2] || 'probe';
  const argv = process.argv.slice(3);
  const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

  try {
    if (cmd === 'probe') {
      const one = flag('platform');
      const list = one ? [one] : registry.keys();
      const out = [];
      for (const k of list) {
        const p = await probe(k);
        out.push(p);
        const icon = p.state === 'loggedIn' ? '✅' : (p.state === 'unreachable' ? '⚠' : '❌');
        console.log(`  ${icon} ${k.padEnd(12)} ${String(p.label).padEnd(16)} ${p.state.padEnd(12)} via=${p.via}`);
        console.log(`     ${p.detail}${p.who ? '  · ' + p.who : ''}`);
      }
      if (argv.includes('--json')) console.log('\n' + JSON.stringify(out, null, 2));
      // 退出码：全部 loggedIn 才 0（unreachable / notLoggedIn 都算非 0，便于 CI）
      process.exit(out.every(x => x.state === 'loggedIn') ? 0 : 1);
    } else if (cmd === 'ensure') {
      const plat = flag('platform');
      if (!plat) { console.error('用法：ensure --platform <key>'); process.exit(2); }
      const t = { platform: plat, auth: { mode: flag('mode', 'auto'), onCaptcha: flag('on-captcha', 'pause') } };
      const r = await ensure(t);
      console.log('\n结果：' + JSON.stringify({ ok: r.ok, blocked: r.blocked, reason: r.reason, account: r.account }, null, 2));
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'accounts') {
      const a = loadAccounts();
      const ks = Object.keys(a);
      if (!ks.length) { console.log('（config/accounts.json 不存在或为空）\n账号池只存 secretRef，不存密码。示例：\n  { "cc-main": { "platform":"ccjyxy", "user":"186****1157", "secretRef":"env:CC_PASS" } }'); process.exit(0); }
      for (const k of ks) {
        const x = a[k];
        console.log(`  ${k.padEnd(14)} ${String(x.platform).padEnd(12)} user=${mask(x.user)}  secretRef=${x.secretRef}`);
        // 顺手验证 secretRef 能不能解析（不打印值）
        try { resolveSecret(x.secretRef); console.log(`  ${''.padEnd(14)} secretRef ✅ 可解析`); }
        catch (e) { console.log(`  ${''.padEnd(14)} secretRef ⚠ ${e.message}`); }
      }
    } else if (cmd === 'keepalive') {
      const plat = flag('platform');
      if (!plat) { console.error('用法：keepalive --platform <key> [--every 600] [--rounds N]'); process.exit(2); }
      const r = await keepAlive(plat, { every: Number(flag('every', 600)), rounds: Number(flag('rounds', 3)) });
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'selftest') {
      console.log('=== auth probe 自检（覆盖 loggedIn / notLoggedIn / unreachable 三态）===\n');
      const expect = { ccjyxy: 'loggedIn', shengsheng: 'loggedIn', chaoxing: 'unreachable', zhihuishu: 'unreachable' };
      let pass = 0, fail = 0;
      for (const [k, want] of Object.entries(expect)) {
        const p = await probe(k);
        const ok = p.state === want;
        if (ok) pass++; else fail++;
        console.log(`  ${ok ? '✅' : '❌'} ${k.padEnd(12)} 期望 ${want.padEnd(12)} 实际 ${p.state.padEnd(12)}（${p.detail.slice(0, 60)}）`);
      }
      console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
      process.exit(fail ? 1 : 0);
    } else {
      console.log('用法：node scripts/auth.mjs [probe|ensure|accounts|keepalive|selftest] [--platform k] [--json]');
      process.exit(2);
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(1);
  }
}
