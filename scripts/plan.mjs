#!/usr/bin/env node
/**
 * scripts/plan.mjs —— 决策器（能力补全层的核心）
 *
 * 把 platforms.json 里的「防护事实」变成一份可直接执行的策略。
 *
 * 硬性纪律（规格 §5.2 / 红线 8）
 * ------------------------------
 * 1. **纯函数**：不 fetch、不起浏览器、不写文件、**不读 runs/**。
 *    唯一允许的 IO 是 registry.load()（它读的正是 config/platforms.json）。
 *    这条不是洁癖：plan 要被 plan.selftest.mjs 逐字段断言，混进 IO 就不可测了。
 * 2. **不猜**：字段缺失一律回落 constraints 并标 confidence=legacy + warning，
 *    **绝不用默认值冒充实测值**。
 * 3. 无副作用：CLI 分支用 isMain 守护，被 import 时什么都不执行。
 *
 * 契约见 docs/CAPABILITY-LAYER-SPEC.md §4 / §5.2。
 */
import { fileURLToPath } from 'node:url';
import { load, keys, find } from './registry.mjs';
import { profileConfidence } from './profile-schema.mjs';

// ─────────────────────────────────────────────────────────────
// 常量：决策表里的固定量
// ─────────────────────────────────────────────────────────────

/** 尾段等待秒数：seek 到 `duration - N` 之后还要跑多久才自然播完 */
const TAIL_WAIT = {
  position: 15,   // §5.2：duration-15
  watchtime: 0,   // 不能 seek，没有尾段等待
  tick: 100,      // §5.2：duration-90，留 10 秒余量给记账 tick
  settle: 0,      // 见下：settle 取保守分支
};

/** 检测强度 → 注入方式（§5.2 规则表） */
function injectByLevel(level) {
  if (level === 'C0' || level === 'C1' || level === 'C2') return 'full';
  if (level === 'C3') return 'minimal';
  if (level === 'C4' || level === 'C5') return 'cdp-only';
  return 'full';
}

/**
 * settle 模型的 seek 取值。
 *
 * 规格 §5.2 只写「按上面任一种」，没指定哪一种。这里取**保守分支**（等同 watchtime：
 * 不能靠 seek 推进、必须自然播），因为三个 settle 平台的实测事实都指向「必须真播」：
 *   - shengsheng：domAbsent，连续 10 轮无 <video> 才算学完
 *   - chaoxing ：完成判据是任务点被服务端标记，播到末尾不会自动标记
 *   - webtrn   ：根本没有视频
 * 若将来某个 settle 平台实测可以跳尾，改它的 profile.accounting.seekOk / seekTarget 覆盖即可。
 */
function seekForModel(model) {
  switch (model) {
    case 'position': return { ok: true, target: 'duration-15', naturalPlay: false, tailWaitSec: TAIL_WAIT.position };
    case 'watchtime': return { ok: false, target: null, naturalPlay: true, tailWaitSec: TAIL_WAIT.watchtime };
    case 'tick': return { ok: true, target: 'duration-90', naturalPlay: true, tailWaitSec: TAIL_WAIT.tick };
    case 'settle': return { ok: false, target: null, naturalPlay: true, tailWaitSec: TAIL_WAIT.settle };
    default: return { ok: false, target: null, naturalPlay: false, tailWaitSec: 0 };
  }
}

const BLOCKER_TEXT = {
  'captcha-sms': { need: 'human', why: '短信码只能由人接收' },
  'captcha-face': { need: 'human', why: '人脸校验只能由人完成' },
  'captcha-session-bound': { need: 'human', why: '每次会话一条新码，自动化只能读到图，读不了真值' },
  'face-on-finish': { need: 'human', why: 'endFace==1 时站点改为 LoadQrCode()，不保存学时' },
  'sso-double': { need: 'auto', why: '必须按 navOrder，整页导航必丢鉴权' },
  'detect-high': { need: 'auto', why: '注入降级为 cdp-only' },
  'no-profile': { need: 'auto', why: '该平台没有 profile 块，已退化为读 constraints，数值可信度低' },
};

const mkBlocker = (code) => ({ code, need: BLOCKER_TEXT[code].need, why: BLOCKER_TEXT[code].why });

/**
 * 数字或 null。
 * 不能用 `Number.isFinite(Number(v))` 直接判：`Number(null) === 0`、`Number('') === 0`，
 * 于是 constraints 里一个 null 会被当成「0 倍速」，再把 rate 压成 0。
 * 这个坑在 smartedu-cn 上真实发生过（rate 该是 2，算成了 1）。
 */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────
// 核心：单平台决策
// ─────────────────────────────────────────────────────────────

/**
 * @param {string} key            平台 key
 * @param {object} [opts]
 * @param {number} [opts.duration] 内容时长（秒）；给了才可能算出 wallClockSec
 * @returns {object} 决策结果（形状见 §5.2）
 */
export function planFor(key, opts = {}) {
  const p = find(key);
  if (!p) throw new Error('未知平台「' + key + '」，可用：' + keys().join(' / '));
  return decide(key, p, opts);
}

/**
 * 纯决策体：吃「平台配置对象」，不碰 registry。
 * 单独导出是为了让 plan.selftest.mjs 能喂合成 fixture（比如「没有 profile 的 legacy 平台」），
 * 而不必为了测一个分支去改 config。
 *
 * @param {string} key
 * @param {object} p     platforms.json 里的单个平台块
 * @param {object} [opts]
 */
export function decide(key, p, opts = {}) {
  if (!p || typeof p !== 'object') throw new Error('decide(' + key + ') 需要平台配置对象');

  const warnings = [];
  const blockers = [];
  const cs = p.constraints || {};
  const prof = p.profile || null;
  const confidence = profileConfidence(prof);

  if (confidence === 'legacy') {
    warnings.push('缺 profile 块，已退化为读 constraints（rateMax / accountingMaxRate / maxParallel）');
    if (!blockers.some((b) => b.code === 'no-profile')) blockers.push(mkBlocker('no-profile'));
  }

  // ── L：记账模型 ────────────────────────────────────────
  const ac = (prof && prof.accounting) || null;
  const model = ac ? ac.model : null;
  if (!model) warnings.push('accounting.model 未知（无 profile）');

  // ── 并行 ───────────────────────────────────────────────
  const parallel = Number.isFinite(Number(cs.maxParallel)) ? Number(cs.maxParallel) : 1;

  // ── A：准入（先算，blockers 与 rate 的 warning 都要用）──
  const ax = (prof && prof.access) || null;
  const captcha = ax && ax.captcha ? ax.captcha : (p.auth && p.auth.captcha) || 'none';
  const sso = ax && ax.sso ? ax.sso : 'single';
  const faceOnFinish = !!(ax && ax.faceOnFinish);
  const navOrder = Array.isArray(ax && ax.navOrder) ? ax.navOrder.slice() : [];

  // ── R：倍速 ────────────────────────────────────────────
  const rt = (prof && prof.rate) || null;
  const declaredMax = rt && numOrNull(rt.declaredMax) !== null ? numOrNull(rt.declaredMax) : numOrNull(cs.rateMax);
  const accountingMax = rt && rt.accountingMax !== undefined && rt.accountingMax !== null
    ? numOrNull(rt.accountingMax)
    : numOrNull(cs.accountingMaxRate);
  const hardKill = !!(rt && rt.hardKill === true);

  let rate;
  if (declaredMax === null) {
    // 没有视频能力的平台（webtrn）本来就没有倍速概念
    rate = 1;
    if (Array.isArray(p.capabilities) && p.capabilities.includes('video')) {
      warnings.push('profile.rate.declaredMax 与 constraints.rateMax 都缺失，rate 保守取 1');
    }
  } else {
    rate = Math.min(
      declaredMax,
      accountingMax === null ? declaredMax : accountingMax,
      hardKill ? 1 : Infinity,
    );
  }
  if (!Number.isFinite(rate) || rate <= 0) { rate = 1; warnings.push('rate 计算异常，保守取 1'); }

  // 站点档位表 → 不超过有效倍速的候选（升序）
  const table = rt && Array.isArray(rt.rateTable) ? rt.rateTable.filter((v) => Number.isFinite(v)) : [];
  const rateCandidates = table.length
    ? table.filter((v) => v <= rate + 1e-9)
    : [rate];
  if (!rateCandidates.length) rateCandidates.push(rate);
  // 有效倍速不在站点档位表里 → 用档位表推出来的值可能不被站点接受
  if (table.length && !table.some((v) => Math.abs(v - rate) < 1e-9)) {
    warnings.push(`有效倍速 ${rate} 不在站点档位表 [${table.join(',')}] 中`);
  }

  if (parallel > 1 && captcha === 'session-bound') {
    warnings.push('多路需要多账号 + 多 profile，session-bound 验证码使自动登录成本上升');
  }

  // ── seek ───────────────────────────────────────────────
  const seek = seekForModel(model);
  // 手工覆盖优先（§5.2：「accounting.seekOk / seekTarget 有值时以它为准」）
  if (ac) {
    if (typeof ac.seekOk === 'boolean') seek.ok = ac.seekOk;
    if (ac.seekTarget !== undefined && ac.seekTarget !== null) seek.target = ac.seekTarget;
    else if (seek.ok === false) seek.target = null;
    if (typeof ac.naturalPlay === 'boolean') seek.naturalPlay = ac.naturalPlay;
  }
  // settle 额外要「跑完再验一次」
  const verifyAtEnd = model === 'settle';

  // ── 注入 / 点击 ────────────────────────────────────────
  const dt = (prof && prof.detect) || null;
  const level = dt && dt.level ? dt.level : 'C0';
  const inject = dt && dt.inject ? dt.inject : injectByLevel(level);
  const probes = dt && Array.isArray(dt.probes) ? dt.probes : [];
  const click = dt && dt.click ? dt.click : (probes.includes('isTrusted') ? 'cdp' : 'dom');

  // 显式 inject 与规则表不一致时提示（huayi 就是这种情况）
  if (dt && dt.inject && dt.inject !== injectByLevel(level)) {
    warnings.push(`detect.inject=${dt.inject} 与「${level} → ${injectByLevel(level)}」的规则不一致（按显式声明执行）`);
  }

  // ── settleLag ──────────────────────────────────────────
  const settleLagSec = ac && Number.isFinite(ac.settleLagSec) ? ac.settleLagSec : 0;

  // ── blockers ───────────────────────────────────────────
  if (captcha === 'sms') blockers.push(mkBlocker('captcha-sms'));
  if (captcha === 'face') blockers.push(mkBlocker('captcha-face'));
  if (captcha === 'session-bound') blockers.push(mkBlocker('captcha-session-bound'));
  if (faceOnFinish) blockers.push(mkBlocker('face-on-finish'));
  if (sso === 'double') blockers.push(mkBlocker('sso-double'));
  if (level === 'C4' || level === 'C5') blockers.push(mkBlocker('detect-high'));

  // ── wallClock ──────────────────────────────────────────
  const content = Number.isFinite(Number(opts.duration)) ? Number(opts.duration) : null;
  let wallClockSec;
  if (seek.ok && model === 'position') {
    wallClockSec = seek.tailWaitSec;                       // 跳尾：只花尾段
  } else if (content === null) {
    wallClockSec = null;                                   // 不知道内容长度 → 不编
    warnings.push('未提供 --duration，wallClockSec 无法计算');
  } else {
    wallClockSec = Math.round(content / rate / parallel + seek.tailWaitSec + settleLagSec);
  }

  return {
    platform: key,
    cdp: Number(p.cdp),
    confidence,
    model,
    rate,
    rateCandidates,
    parallel,
    inject,
    click,
    clickMode: click,          // §5.2 的输出示例同时给了 click 与 clickMode，保持一致
    seek,
    verifyAtEnd,
    settleLagSec,
    navOrder,
    wallClockSec,
    blockers,
    warnings,
    // 供驱动直接用的常量（P3 消费）
    tailWaitSec: seek.tailWaitSec,
    contentSec: content,
  };
}

/** 全部平台 */
export function planAll(opts = {}) {
  return keys().map((k) => planFor(k, opts));
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const argVal = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n) => argv.includes('--' + n);

  try {
    const duration = argVal('duration');
    const opts = duration !== undefined ? { duration: Number(duration) } : {};
    const asJson = has('json');

    if (has('all')) {
      const rows = planAll(opts);
      if (asJson) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        const hdr = ['platform', 'model', 'rate', 'par', 'inject', 'click', 'seek.target', 'tail', 'lag', 'wall', 'conf'];
        const w = [12, 9, 5, 4, 9, 6, 13, 5, 4, 7, 10];
        const pad = (s, n) => String(s).padEnd(n);
        console.log(hdr.map((h, i) => pad(h, w[i])).join(' '));
        console.log(w.map((n) => '-'.repeat(n)).join(' '));
        for (const r of rows) {
          console.log([
            pad(r.platform, w[0]),
            pad(r.model ?? '—', w[1]),
            pad(r.rate, w[2]),
            pad(r.parallel, w[3]),
            pad(r.inject, w[4]),
            pad(r.click, w[5]),
            pad(r.seek.target ?? 'null', w[6]),
            pad(r.seek.tailWaitSec, w[7]),
            pad(r.settleLagSec, w[8]),
            pad(r.wallClockSec === null ? '—' : r.wallClockSec, w[9]),
            pad(r.confidence, w[10]),
          ].join(' '));
        }
        console.log('\n' + rows.length + ' 个平台');
        // 硬指标：不许出现 undefined / NaN
        const bad = JSON.stringify(rows).match(/undefined|NaN/g);
        if (bad) { console.error('\n❌ 输出里出现 ' + [...new Set(bad)].join('/') + '，拒绝通过'); process.exit(1); }
      }
      process.exit(0);
    }

    const key = argVal('platform');
    if (!key) {
      console.error('用法：node scripts/plan.mjs --platform <key> [--duration N] [--json]');
      console.error('      node scripts/plan.mjs --all [--json]');
      console.error('可用平台：' + keys().join(' / '));
      process.exit(2);
    }
    const r = planFor(key, opts);
    if (asJson) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log('平台      ' + r.platform + '   cdp=' + r.cdp + '   confidence=' + r.confidence);
      console.log('记账模型  ' + r.model);
      console.log('倍速      ' + r.rate + '   候选=' + JSON.stringify(r.rateCandidates) + '   并行=' + r.parallel);
      console.log('注入/点击 ' + r.inject + ' / ' + r.click);
      console.log('seek      ' + (r.seek.ok ? r.seek.target : '不可 seek') + '   naturalPlay=' + r.seek.naturalPlay + '   tailWait=' + r.seek.tailWaitSec + 's');
      console.log('记账滞后  ' + r.settleLagSec + 's');
      console.log('导航顺序  ' + (r.navOrder.length ? r.navOrder.join(' → ') : '（无）'));
      console.log('预估墙钟  ' + (r.wallClockSec === null ? '（需要 --duration）' : r.wallClockSec + 's'));
      if (r.blockers.length) {
        console.log('人工介入点：');
        for (const b of r.blockers) console.log('  · ' + b.code + '  [' + b.need + ']  ' + b.why);
      } else {
        console.log('人工介入点：（无）');
      }
      if (r.warnings.length) {
        console.log('警告：');
        for (const w2 of r.warnings) console.log('  ! ' + w2);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(1);
  }
}
