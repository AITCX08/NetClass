#!/usr/bin/env node
/**
 * scripts/detect.mjs —— 探测闭环：跑探针 → 产出 profile 建议值
 *
 * 安全模型（规格 §5.3 / 红线 1、9）
 * ---------------------------------
 * · **绝不碰正在跑的标签。** 默认在**自己起的临时实例**里跑（`netclass up --mode offscreen`，
 *   新 profile、新端口），跑完只停自己启的那个。
 * · 想直接在既有实例上跑也行，但必须**显式** `--port <n>`，属于操作者主动选择。
 * · **默认不写回**。只有 `--write` 才改 config/platforms.json，且**只改它探到的字段**，
 *   `verified` 日期原样保留（不许用探测日期覆盖别人的实测日期）。
 * · **单平台单次**。没有 `--all`：8 平台 × A/B × 等待 = 小时级 + 必被风控。
 *
 * 探针实现状态（诚实版）
 * ----------------------
 *   plugin-blacklist  ✅ 已实现（passive）
 *   rate-ladder       ✅ 已实现（active，spawn 复用 scripts/test-rate-ladder.mjs + 解析汇总行）
 *   xhr-open-native   TODO(probe)
 *   isTrusted         TODO(probe)
 *   seek-readback     TODO(probe)
 *
 * 用法
 * ----
 *   node scripts/detect.mjs --list-probes
 *   node scripts/detect.mjs --platform huayi --passive
 *   node scripts/detect.mjs --platform huayi --active rate-ladder [--port 9231] [--secs 20]
 *   node scripts/detect.mjs --platform huayi --passive --write
 *   node scripts/detect.mjs --selftest          # 只用合成特征校验分类器，不连浏览器
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get, keys, FILE } from './registry.mjs';
import { INJECT_MODES } from './profile-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ─────────────────────────────────────────────────────────────
// 探针登记表（与 profile-schema.PROBE_IDS 同集合）
// ─────────────────────────────────────────────────────────────
export const PROBES = {
  'plugin-blacklist': {
    level: 'passive',
    risk: '无',
    writes: ['detect.level', 'detect.probes'],
    impl: 'scanInlineJs',
    how: 'Runtime.evaluate 拉页面内联 JS + 运行时特征，正则搜 window.OCS / isNative / navigator.webdriver 式判据；不发请求、不改页面',
  },
  'xhr-open-native': {
    level: 'active',
    risk: '中（可能被踢）',
    writes: ['detect.level'],
    impl: null,
    todo: 'TODO(probe)：需要包 XHR.prototype.open 做 A/B 并各停留 kickDelaySec+3 秒观察是否被踢。' +
          '当前没有可用实例（8 个平台的登录态/播放页都不在），实现后也无法在本次验收里跑出真值；' +
          '按规格「不猜」的原则先留空，避免写一个跑不出证据的 A/B。',
  },
  isTrusted: {
    level: 'active',
    risk: '中',
    writes: ['detect.probes'],
    impl: null,
    todo: 'TODO(probe)：需要对探针元素 dispatchEvent(new MouseEvent(...)) 并观察是否弹告警/跳转。' +
          '这个探针的判据是「合成事件是否被拒」，必须发生在真实播放/答题动作上才有意义，' +
          '没有带会话的实例时跑出来只会得到假阴性。',
  },
  'rate-ladder': {
    level: 'active',
    risk: '低（华医网可无损恢复）',
    writes: ['rate.declaredMax', 'rate.hardKill'],
    impl: 'rateLadder',
    how: 'spawn scripts/test-rate-ladder.mjs --port <p>，解析它的汇总行，零新逻辑',
  },
  'seek-readback': {
    level: 'active',
    risk: '低',
    writes: ['accounting.model', 'accounting.seekOk'],
    impl: null,
    todo: 'TODO(probe)：需要设 currentTime=duration-2 后抓后续上报体，比对 position 是原值还是被钳。' +
          '抓上报体要开 Network 域并等一个心跳周期（各平台 20–60s 不等），且必须有真实记账会话；' +
          '没有会话时读不到任何上报体。',
  },
};

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(6000) });
  return r.json();
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    ws.addEventListener('error', () => reject(new Error('CDP ws 连接失败')));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, timeout = 20000) {
        const id = ++seq;
        return new Promise((res, rej) => {
          pend.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
          setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, timeout);
        });
      },
      close() { try { ws.close(); } catch { } },
    }));
  });
}

async function evalOn(port, expression) {
  const list = await cdpTargets(port);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('端口 ' + port + ' 没有 page target');
  const c = await cdpConnect(page.webSocketDebuggerUrl);
  try {
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  } finally { c.close(); }
}

async function portAlive(port) {
  try { const l = await cdpTargets(port); return Array.isArray(l) && l.length > 0; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────
// 临时实例：自己起、自己停
// ─────────────────────────────────────────────────────────────
/**
 * netclass.mjs 的输出带 ANSI 颜色码。不去掉的话，正则会把 `\x1b[0m` 吃进实例 id，
 * 之后 `netclass stop <id>` 匹配不到 → **浏览器停不掉**（真实发生过一次：
 * zhihuishu--3b45 在 9229 上残留，stop 报「没有匹配的活实例」）。
 */
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

/**
 * 给临时实例挑一个高位端口。
 *
 * 为什么必须显式指定：`netclass up` 默认优先用平台的**规范端口**（zhihuishu→9229、
 * huayi→9231）。探测器跑在这些位置上会和「正式实例」语义混淆，也更容易被误 stop。
 * 这里从 9280 起找一个空的 CDP 端口传给 `netclass up --port`。
 */
async function pickTempPort(start = 9280, end = 9299) {
  for (let p = start; p <= end; p++) {
    if (!(await portAlive(p))) return p;
  }
  return null;
}

async function startTempInstance(key) {
  const wantPort = await pickTempPort();
  const args = [join(REPO, 'scripts', 'netclass.mjs'), 'up', '--platform', key, '--mode', 'offscreen'];
  if (wantPort) args.push('--port', String(wantPort));
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 90000, cwd: REPO,
  });
  const out = stripAnsi((r.stdout || '') + (r.stderr || ''));
  const port = (out.match(/CDP\s+http:\/\/127\.0\.0\.1:(\d+)/) || [])[1];
  const id = (out.match(/实例\s+(\S+)\s+已就绪/) || out.match(/（实例\s+([^）]+)）/) || [])[1];
  if (!port || !id) {
    return { ok: false, why: 'netclass up 没给出端口/实例 id', out: out.slice(-600) };
  }
  return { ok: true, id, port: Number(port), requestedPort: wantPort, out };
}

function stopTempInstance(id) {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'netclass.mjs'), 'stop', id], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
  });
  return stripAnsi((r.stdout || '') + (r.stderr || '')).trim();
}

/** 停完必须复核端口真的没了，否则大声报出来（残留浏览器比探测失败严重得多） */
async function stopTempAndVerify(inst) {
  const log = stopTempInstance(inst.id);
  await sleep(1200);
  if (await portAlive(inst.port)) {
    return { stopped: false, port: inst.port, log, warning: '⚠ 临时实例没停掉：端口 ' + inst.port + ' 仍在监听，请手动 netclass stop ' + inst.id };
  }
  return { stopped: true, port: inst.port, log };
}

// ─────────────────────────────────────────────────────────────
// 探针 1：plugin-blacklist（passive）
// ─────────────────────────────────────────────────────────────
/**
 * 在页面里收集「反自动化特征」。
 *
 * 每个 marker 都必须能在**站点自己的代码/运行时**里被观察到，不能把我们自己注入的东西
 * 算成站点的检测（那会把 C0 的站误判成 C4）。所以：
 *   · inline JS 扫描只看 <script> 的 textContent（我们自己的实现模块是 addScriptToEvaluateOnNewDocument
 *     注入的，不在 DOM 的 <script> 里，天然排除）
 *   · 运行时特征只看确定属于环境的属性（navigator.webdriver 等）
 */
function buildPassiveExpr() {
  return `(function(){
    var out = { inlineScripts: 0, inlineBytes: 0, externalScripts: [], markers: [], runtime: {},
                page: { url: location.href, title: document.title, textLen: (document.body ? document.body.innerText.length : 0) } };
    var texts = [];
    Array.prototype.forEach.call(document.querySelectorAll('script'), function(s){
      if (s.src) { out.externalScripts.push(s.src); return; }
      var t = s.textContent || '';
      if (!t) return;
      out.inlineScripts++; out.inlineBytes += t.length; texts.push(t);
    });
    var code = texts.join('\\n');
    var MARKS = [
      ['window.OCS',             /window\\.OCS\\b/],
      ['isNative(fn 指纹)',       /isNative\\s*\\(/],
      ['__lookupSetter__',       /__lookupSetter__/],
      ['navigator.webdriver',    /navigator\\.webdriver/],
      ['isTrusted 校验',          /isTrusted/],
      ['MouseEvent 合成检测',      /new\\s+MouseEvent\\s*\\(/],
      ['HTMLMediaElement 劫持',   /HTMLMediaElement\\.prototype/],
      ['ratechange 监听',         /ratechange/],
      ['visibility/occlusion',   /visibilitychange|webkitHidden|document\\.hidden/],
      ['toString 伪装检测',       /toString\\s*\\(\\s*\\)[^;]{0,40}native\\s+code|\\[native code\\]/],
      ['canvas 指纹',            /toDataURL|getImageData/],
      ['iframe 上报',            /createElement\\(['"]iframe['"]\\)/]
    ];
    MARKS.forEach(function(m){
      var re = m[1];
      var g = new RegExp(re.source, 'g');
      var n = (code.match(g) || []).length;
      if (n > 0) out.markers.push({ id: m[0], hits: n });
    });
    out.runtime.webdriver = (typeof navigator !== 'undefined') ? !!navigator.webdriver : null;
    out.runtime.ocsGlobal = (typeof window.OCS !== 'undefined');
    out.runtime.netclassGlobal = (typeof window.NetClass !== 'undefined');
    out.runtime.playwright = (typeof window.__playwright !== 'undefined') || (typeof window.__puppeteer_evaluation_script__ !== 'undefined');
    // 注意：runtime.webdriver 只作为「本地环境暴露面」记录，**不**塞进 markers —— 它不代表站点检测强度
    return JSON.stringify(out);
  })()`;
}

/**
 * 分类器：特征 → detect.level + probes。
 * 纯函数，可单测（--selftest 就是喂合成特征给这里）。
 *
 * 分级依据（保守：宁可低估也不高估，高估会让驱动白白降级）：
 *   0 个特征            → C0
 *   1 个特征            → C1（原生函数指纹）
 *   2 个特征            → C2（合成事件）
 *   ≥3 个特征 且含行为/会话类 → C4
 *   含 ratechange 或 iframe 上报 → 至少 C3（行为一致性）
 */
export function classifyPassive(scan) {
  const marks = (scan && scan.markers) || [];
  const ids = marks.map((m) => m.id);
  const has = (re) => ids.some((i) => re.test(i));

  // 四类特征（对应规格 §2.1 的 C1/C2/C3）
  const behavioral = has(/ratechange|iframe 上报|visibility|occlusion/i);   // C3 行为一致性
  const fingerprint = has(/isNative|__lookupSetter__|toString 伪装|HTMLMediaElement 劫持|canvas 指纹/i); // C1 原生指纹
  const synthetic = has(/isTrusted|MouseEvent/i);                          // C2 合成事件
  const sessionish = has(/window\.OCS|navigator\.webdriver/i);             // 会话/环境黑名单

  const kinds = [behavioral, fingerprint, synthetic, sessionish].filter(Boolean).length;

  // ★ 分级只用「站点自己代码里能观察到的特征」。
  //   运行时的 navigator.webdriver=1 说明「我们可被检测」，不代表站点检测强度，
  //   所以它不进 markers（进 environment），否则任何 CDP 驱动的站都会被误判成 C4。
  let level;
  if (!marks.length) level = 'C0';
  else if (kinds >= 3) level = 'C4';        // 多特征组合（§2.1 C4）—— zhihuishu 形态
  else if (behavioral) level = 'C3';        // 只有行为一致性 —— huayi 形态
  else if (synthetic) level = 'C2';         // 合成事件
  else if (sessionish && fingerprint) level = 'C2';
  else level = 'C1';                        // 单一原生指纹 / 单一黑名单

  const probes = [];
  if (fingerprint) probes.push('xhr-open-native');
  if (synthetic) probes.push('isTrusted');
  if (marks.length) probes.push('plugin-blacklist');

  const inject = level === 'C0' || level === 'C1' || level === 'C2' ? 'full'
    : level === 'C3' ? 'minimal' : 'cdp-only';

  return {
    level,
    probes: [...new Set(probes)],
    inject,
    evidence: marks.map((m) => `${m.id}（命中 ${m.hits} 处）`),
    environment: scan.runtime && scan.runtime.webdriver ? ['navigator.webdriver=1（本地被检测面，不参与定级）'] : [],
    counters: { inlineScripts: scan.inlineScripts, inlineBytes: scan.inlineBytes, externalScripts: (scan.externalScripts || []).length },
  };
}

async function probePluginBlacklist(port) {
  const raw = await evalOn(port, buildPassiveExpr());
  const scan = JSON.parse(raw);
  const cls = classifyPassive(scan);

  /**
   * 覆盖度判定 —— 这一步不能省。
   *
   * 临时实例是**新 profile、未登录**，落在登录页/公开页上。那里的内联 JS 是壳子的，
   * 不是业务应用的，扫出来的等级只是**下界**。若把这种结果当结论写回，
   * 会把 zhihuishu 的 C4 直接降成 C0 —— 比不探测更糟。
   */
  const page = scan.page || {};
  const url = String(page.url || '');
  const looksApp = /(teacherTraining|courseIndex|courseDetail|study|learn|\/My|\/my[A-Z]|assessment)/i.test(url)
    || (page.textLen || 0) > 800;
  const status = looksApp ? 'ok' : 'partial';

  return {
    status,
    coverage: looksApp ? 'app' : 'anonymous',
    reason: looksApp ? null
      : '临时实例是新 profile、未登录，扫到的是登录页/公开页的 JS，等级只能当作**下界**，不能当结论（要拿真值请 --port 指向已登录实例）',
    page: { url: url.slice(0, 120), title: page.title, textLen: page.textLen },
    ...cls,
  };
}

// ─────────────────────────────────────────────────────────────
// 探针 2：rate-ladder（active，复用现成脚本）
// ─────────────────────────────────────────────────────────────
/**
 * 解析 test-rate-ladder.mjs 的汇总行：
 *   "    1.25x  →  实际  0.00x   ❌ 全被拦"
 *   "  ★ 最高可用倍速: 1x"
 */
export function parseRateLadder(stdout) {
  const rows = [];
  const re = /^\s+([\d.]+)x\s+→\s+实际\s+([\d.]+)x\s+(.*)$/gm;
  let m;
  while ((m = re.exec(stdout))) {
    rows.push({ rate: Number(m[1]), eff: Number(m[2]), verdict: (m[3] || '').trim() });
  }
  if (!rows.length) return null;

  const okRows = rows.filter((r) => Math.abs(r.eff - r.rate) <= r.rate * 0.1 + 0.05);
  const declaredMax = okRows.length ? Math.max(...okRows.map((r) => r.rate)) : null;
  const killed = rows.filter((r) => r.rate > (declaredMax || 0) && r.eff === 0);
  const maxLine = (stdout.match(/最高可用倍速:\s*([\d.]+)x/) || [])[1];

  return {
    declaredMax: declaredMax ?? (maxLine ? Number(maxLine) : null),
    hardKill: killed.length > 0,
    rows,
    killedAbove: killed.map((r) => r.rate),
    statedMax: maxLine ? Number(maxLine) : null,
  };
}

function probeRateLadder(port, secs) {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'test-rate-ladder.mjs'), '--port', String(port), '--rates', '1,1.25,1.5,1.75,2', '--secs', String(secs)], {
    encoding: 'utf8', timeout: (secs * 5 + 180) * 1000, cwd: REPO, maxBuffer: 8 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const parsed = parseRateLadder(out);
  if (!parsed) {
    return {
      status: 'blocked',
      reason: 'test-rate-ladder 没有产出汇总行（通常是该实例上没有可播放的 video：需要已登录且已打开播放页）',
      tail: out.split(/\r?\n/).slice(-8).join('\n'),
    };
  }
  return { status: 'ok', ...parsed, tail: out.split(/\r?\n/).slice(-4).join('\n') };
}

// ─────────────────────────────────────────────────────────────
// 写回（只改探到的字段）
// ─────────────────────────────────────────────────────────────
function writeBack(key, patch) {
  const doc = JSON.parse(readFileSync(FILE, 'utf8'));
  const p = doc[key];
  if (!p) throw new Error('注册表里没有 ' + key);
  p.profile = p.profile || {};
  const applied = [];
  for (const [path, val] of Object.entries(patch)) {
    const parts = path.split('.');
    let cur = p.profile;
    for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
    const leaf = parts[parts.length - 1];
    if (cur[leaf] === val) continue;      // 没变就不动（保持 diff 干净）
    cur[leaf] = val;
    applied.push(path + ' = ' + JSON.stringify(val));
  }
  // verified 一律保留原值：探测不能冒充实测
  writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return applied;
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const val = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes('--' + n);

  // ── selftest：只用合成特征证明分类器 ──────────────────
  if (has('selftest')) {
    const cases = [
      { name: 'C0（无任何特征）', scan: { markers: [], inlineScripts: 3, inlineBytes: 9000, externalScripts: [] }, want: 'C0' },
      { name: 'C1（只有原生指纹）', scan: { markers: [{ id: 'isNative(fn 指纹)', hits: 1 }] }, want: 'C1' },
      { name: 'C2（只有合成事件）', scan: { markers: [{ id: 'isTrusted 校验', hits: 2 }, { id: 'MouseEvent 合成检测', hits: 1 }] }, want: 'C2' },
      { name: 'C3（只有行为一致性 = huayi 形态）', scan: { markers: [{ id: 'ratechange 监听', hits: 2 }, { id: 'iframe 上报', hits: 3 }] }, want: 'C3' },
      { name: 'C4（zhihuishu 形态：OCS + isNative + isTrusted）', scan: { markers: [{ id: 'window.OCS', hits: 2 }, { id: 'isNative(fn 指纹)', hits: 1 }, { id: 'isTrusted 校验', hits: 1 }] }, want: 'C4' },
      { name: 'C1→C2（黑名单 + 原生指纹，两类）', scan: { markers: [{ id: 'window.OCS', hits: 1 }, { id: 'isNative(fn 指纹)', hits: 1 }] }, want: 'C2' },
      { name: 'runtime.webdriver 不参与定级', scan: { markers: [], runtime: { webdriver: true } }, want: 'C0' },
    ];
    let bad = 0;
    console.log('detect.selftest —— 分类器');
    for (const c of cases) {
      const got = classifyPassive(c.scan);
      const okk = got.level === c.want;
      if (!okk) bad++;
      console.log('  ' + (okk ? '✓' : '✗') + ' ' + c.name.padEnd(46) + ' → ' + got.level + (okk ? '' : '（期望 ' + c.want + '）'));
    }
    // rate-ladder 解析器
    const sample = [
      '    1.00x  →  实际  1.00x   ✅ 可用',
      '    1.25x  →  实际  0.00x   ❌ 全被拦',
      '    1.50x  →  实际  0.00x   ❌ 全被拦',
      '  ★ 最高可用倍速: 1x',
    ].join('\n');
    const pr = parseRateLadder(sample);
    const okr = pr && pr.declaredMax === 1 && pr.hardKill === true;
    if (!okr) bad++;
    console.log('  ' + (okr ? '✓' : '✗') + ' rate-ladder 解析器（华医网样例）→ declaredMax=' + (pr && pr.declaredMax) + ' hardKill=' + (pr && pr.hardKill));
    console.log(bad ? '\n❌ ' + bad + ' 项未过' : '\n✅ all pass');
    process.exit(bad ? 1 : 0);
  }

  if (has('list-probes')) {
    console.log('探针登记表：');
    for (const [id, p] of Object.entries(PROBES)) {
      console.log('  ' + id.padEnd(18) + p.level.padEnd(9) + (p.impl ? '✅ 已实现' : '○  TODO') + '   写回 ' + p.writes.join(', '));
    }
    process.exit(0);
  }

  const key = val('platform');
  if (!key) {
    console.error('用法：node scripts/detect.mjs --platform <key> [--passive] [--active <probe>] [--port N] [--write] [--json]');
    console.error('      node scripts/detect.mjs --list-probes');
    console.error('      node scripts/detect.mjs --selftest');
    console.error('可用平台：' + keys().join(' / '));
    process.exit(2);
  }
  if (has('all')) {
    console.error('❌ 不支持 --all：单平台单次（8 平台 × A/B × 等待 = 小时级 + 必被风控，规格 §5.3 硬性要求 3）');
    process.exit(2);
  }

  const activeId = val('active');
  if (activeId && !PROBES[activeId]) {
    console.error('未知探针「' + activeId + '」，可选：' + Object.keys(PROBES).join(' / '));
    process.exit(2);
  }
  const doPassive = has('passive') || !activeId;

  (async () => {
    const p = get(key);
    const result = { platform: key, cdp: Number(p.cdp), probes: {}, temp: null, suggestions: {}, applied: [] };

    // ── 目标端口：显式 --port 优先，否则自己起临时实例 ──
    let port = val('port') ? Number(val('port')) : null;
    if (port) {
      if (!(await portAlive(port))) { console.error('❌ 端口 ' + port + ' 的 CDP 不通'); process.exit(1); }
      result.probes._port = { status: 'ok', port, source: '--port（操作者显式指定）' };
    } else {
      const t = await startTempInstance(key);
      if (!t.ok) {
        console.error('❌ 起临时实例失败：' + t.why);
        console.error(t.out);
        process.exit(1);
      }
      port = t.port;
      result.temp = { id: t.id, port: t.port };
      result.probes._port = { status: 'ok', port: t.port, source: '临时实例（netclass up --mode offscreen，新 profile）' };
    }

    try {
      // ── passive ──
      if (doPassive) {
        if (!PROBES['plugin-blacklist'].impl) {
          result.probes['plugin-blacklist'] = { status: 'todo', reason: PROBES['plugin-blacklist'].todo };
        } else {
          try { result.probes['plugin-blacklist'] = await probePluginBlacklist(port); }
          catch (e) { result.probes['plugin-blacklist'] = { status: 'error', reason: e.message }; }
        }
        const r = result.probes['plugin-blacklist'];
        if (r && r.status === 'ok') {
          result.suggestions['detect.level'] = r.level;
          result.suggestions['detect.probes'] = r.probes;
          result.suggestions['detect.inject'] = r.inject;
        }
      }

      // ── active ──
      if (activeId) {
        const meta = PROBES[activeId];
        if (!meta.impl) {
          result.probes[activeId] = { status: 'todo', reason: meta.todo };
        } else if (activeId === 'rate-ladder') {
          const secs = Number(val('secs') || 15);
          result.probes[activeId] = probeRateLadder(port, secs);
          const r = result.probes[activeId];
          if (r.status === 'ok') {
            if (r.declaredMax !== null) result.suggestions['rate.declaredMax'] = r.declaredMax;
            result.suggestions['rate.hardKill'] = r.hardKill;
          }
        }
      }
    } finally {
      // ── 只停自己启的那个，并复核端口确实关了 ──
      if (result.temp) {
        const s = await stopTempAndVerify(result.temp);
        result.temp.stopped = s.stopped;
        result.temp.stopLog = s.log;
        if (s.warning) result.temp.warning = s.warning;
      }
    }

    // ── 输出 ──
    if (has('json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('探测 ' + key + '   端口 ' + port + '   (' + result.probes._port.source + ')');
      console.log('');
      for (const [id, r] of Object.entries(result.probes)) {
        if (id.startsWith('_')) continue;
        const mark = r.status === 'ok' ? '✅' : r.status === 'todo' ? '○ '
          : r.status === 'blocked' ? '⛔' : r.status === 'partial' ? '⚠ ' : '❌';
        console.log('  ' + mark + ' ' + id + '  [' + PROBES[id].level + ']' + (r.coverage ? '  coverage=' + r.coverage : ''));
        if (r.status === 'ok' && r.evidence) {
          for (const ev of r.evidence) console.log('        依据：' + ev);
        }
        if (r.status === 'ok' && r.rows) {
          for (const row of r.rows) console.log('        ' + row.rate + 'x → 实际 ' + row.eff + 'x  ' + row.verdict);
        }
        if (r.reason) console.log('        ' + r.reason);
        if (r.status === 'todo') console.log('        ' + r.reason);
      }
      console.log('');
      if (Object.keys(result.suggestions).length) {
        console.log('建议值（默认不写回）：');
        for (const [k, v] of Object.entries(result.suggestions)) console.log('  ' + k + ' = ' + JSON.stringify(v));
      } else {
        console.log('建议值：无（没有探针产出可用结论）');
      }
      if (result.temp) console.log('\n临时实例 ' + result.temp.id + ' 已停：' + result.temp.stopped);
    }

    // ── 写回 ──
    if (has('write')) {
      if (!Object.keys(result.suggestions).length) {
        console.error('\n❌ --write 但没有建议值，不写任何东西');
        process.exit(1);
      }
      const patch = {};
      if (result.suggestions['detect.level']) patch['detect.level'] = result.suggestions['detect.level'];
      if (result.suggestions['detect.probes']) patch['detect.probes'] = result.suggestions['detect.probes'];
      if (result.suggestions['detect.inject']) patch['detect.inject'] = result.suggestions['detect.inject'];
      if (result.suggestions['rate.declaredMax'] !== undefined) patch['rate.declaredMax'] = result.suggestions['rate.declaredMax'];
      if (result.suggestions['rate.hardKill'] !== undefined) patch['rate.hardKill'] = result.suggestions['rate.hardKill'];
      const applied = writeBack(key, patch);
      console.log('\n已写回 ' + FILE + '（verified 日期保留原值）：');
      if (!applied.length) console.log('  （与现值相同，未改动）');
      for (const a of applied) console.log('  ' + a);
    } else if (Object.keys(result.suggestions).length) {
      console.log('\n（未写回。确认无误后加 --write）');
    }
    process.exit(0);
  })().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
}
