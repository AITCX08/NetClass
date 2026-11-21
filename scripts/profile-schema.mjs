#!/usr/bin/env node
/**
 * scripts/profile-schema.mjs —— platforms.json 的 `profile` 块：枚举 + 校验
 *
 * 为什么单独一个文件
 * ------------------
 * registry.mjs 已经 477 行，把枚举和校验再塞进去会让它继续膨胀；而且 P2 的 plan.mjs
 * 也要用同一套枚举。所以枚举只有这一份，registry 与 plan 都 import 这里，**不再各长一套**
 * （规格 §5.1「registry.mjs 只 import 本文件，不自己长枚举」）。
 *
 * 设计原则
 * --------
 * 1. **缺 profile 不算错**：规格 §4.3 要求 P1 可以分平台灰度，老平台没有 profile 时
 *    plan.mjs 退化为读 constraints（confidence: legacy）。所以 validateProfile 在
 *    profile 为空时返回空 errors / 空 warnings。
 * 2. **不猜**：字段缺失就报 warning 让它显式缺失，绝不填默认值冒充事实。
 * 3. **只报不改**：本文件是纯校验，不写任何文件。
 *
 * 字段契约见 docs/CAPABILITY-LAYER-SPEC.md §4.1 / §4.2。
 */

/** 记账模型（对应规格 §2.1 的 L0–L4 五级压缩成 4 个可计算取值） */
export const ACCOUNTING_MODELS = ['position', 'watchtime', 'tick', 'settle'];

/** 检测强度 */
export const DETECT_LEVELS = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'];

/** 注入方式 */
export const INJECT_MODES = ['full', 'minimal', 'cdp-only'];

/** 身份准入：验证码形态 */
export const CAPTCHA_KINDS = ['none', 'image', 'session-bound', 'sms', 'face'];

/** 单层 / 双层 SSO */
export const SSO_MODES = ['single', 'double'];

/** 登记过的探针（detect.mjs 只跑登记过的；未登记的在 validate 里报 warning） */
export const PROBE_IDS = [
  'plugin-blacklist',     // passive：静态搜页面 JS 里的 window.XXX 判据
  'xhr-open-native',      // active ：包 open vs 不包，A/B 看是否被踢
  'isTrusted',            // active ：合成 click 探针，看是否弹窗/跳转
  'rate-ladder',          // active ：复用 test-rate-ladder.mjs
  'seek-readback',        // active ：设末尾后抓上报体，看服务端是否钳位
];

/** seek 目标（枚举，规格 §4.2） */
export const SEEK_TARGETS = ['duration-15', 'duration-90'];

/**
 * 点击方式。
 * 规格 §5.2 只按「probes 含 isTrusted」推导，但有两个平台的实测事实覆盖不到：
 *   - smartedu（青海）：Ant Design 的 focus() 完全无效，必须 Input.dispatchMouseEvent
 *     （HANDOVER §5.62）
 *   - huayi：13 次验证码失败换来的结论同上（HANDOVER §5.71）
 * 所以 profile 允许显式声明 click，plan 优先用它，没有才按 probes 推导。
 */
export const CLICK_MODES = ['cdp', 'dom'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 校验一块 profile。
 *
 * @param {string} key               平台 key（只用于错误信息前缀）
 * @param {object|null|undefined} profile  profile 块；空 → 视为 legacy，直接放行
 * @param {object|null} legacyConstraints 同平台的 constraints（用于 §4.3 冲突检测）
 * @param {object} [ctx]             附加上下文：{ capabilities?: string[] }
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateProfile(key, profile, legacyConstraints, ctx = {}) {
  const errors = [];
  const warnings = [];
  const tag = `[${key}]`;

  // ── legacy 兼容：没有 profile 不是错 ──────────────────
  if (profile === undefined || profile === null) return { errors, warnings };
  if (!isPlainObject(profile)) {
    errors.push(`${tag} profile 必须是对象（或整体省略）`);
    return { errors, warnings };
  }

  const caps = Array.isArray(ctx.capabilities) ? ctx.capabilities : null;
  const hasVideo = caps ? caps.includes('video') : true;   // 无 capabilities 时按「有视频」从严要求

  // ══════════════════════════════════════════════════════
  // accounting
  // ══════════════════════════════════════════════════════
  const ac = profile.accounting;
  if (!isPlainObject(ac)) {
    errors.push(`${tag} profile.accounting 必须是对象`);
  } else {
    if (!ACCOUNTING_MODELS.includes(ac.model)) {
      errors.push(`${tag} profile.accounting.model 非法：${ac.model}（合法：${ACCOUNTING_MODELS.join('/')}）`);
    }
    if (ac.seekOk !== undefined && typeof ac.seekOk !== 'boolean') {
      errors.push(`${tag} profile.accounting.seekOk 必须是布尔`);
    }
    if (ac.seekTarget !== undefined && ac.seekTarget !== null && !SEEK_TARGETS.includes(ac.seekTarget)) {
      errors.push(`${tag} profile.accounting.seekTarget 非法：${ac.seekTarget}（合法：${SEEK_TARGETS.join('/')} 或 null）`);
    }
    if (ac.naturalPlay !== undefined && typeof ac.naturalPlay !== 'boolean') {
      errors.push(`${tag} profile.accounting.naturalPlay 必须是布尔`);
    }
    if (ac.settleLagSec !== undefined) {
      if (!isNum(ac.settleLagSec) || ac.settleLagSec < 0) {
        errors.push(`${tag} profile.accounting.settleLagSec 必须是 >=0 的数字`);
      }
    }
    dateCheck(errors, `${tag} profile.accounting.verified`, ac.verified);

    // model 与显式 seekOk 的语义冲突：watchtime 说不能 seek，却写 seekOk:true
    if (ac.model === 'watchtime' && ac.seekOk === true) {
      warnings.push(`${tag} accounting.model=watchtime 但 seekOk=true：时长制下 seek 一般不加速记账，确认是否实测过`);
    }
    // tick 必须自然播完，否则记账窗口永远不触发
    if (ac.model === 'tick' && ac.naturalPlay === false) {
      warnings.push(`${tag} accounting.model=tick 但 naturalPlay=false：tick 模型靠「自然播到尾」触发记账（HANDOVER §5.84）`);
    }
    // settle 模型的滞后值缺失 → 验收侧不知道等多久
    if (ac.model === 'settle' && ac.settleLagSec === undefined) {
      warnings.push(`${tag} accounting.model=settle 但没写 settleLagSec：verify 侧只能按 0 等待，可能误判未完成`);
    }
  }

  // ══════════════════════════════════════════════════════
  // rate —— 没有视频能力的平台可以不写（webtrn 就是这种）
  // ══════════════════════════════════════════════════════
  const rt = profile.rate;
  if (rt === undefined || rt === null) {
    if (hasVideo) warnings.push(`${tag} profile.rate 缺失：有 video 能力的平台应显式声明 declaredMax`);
  } else if (!isPlainObject(rt)) {
    errors.push(`${tag} profile.rate 必须是对象`);
  } else {
    if (!isNum(rt.declaredMax) || rt.declaredMax <= 0) {
      errors.push(`${tag} profile.rate.declaredMax 必填且必须是 >0 的数字`);
    }
    if (rt.accountingMax !== undefined && rt.accountingMax !== null && (!isNum(rt.accountingMax) || rt.accountingMax <= 0)) {
      errors.push(`${tag} profile.rate.accountingMax 必须是 >0 的数字或 null`);
    }
    if (rt.hardKill !== undefined && typeof rt.hardKill !== 'boolean') {
      errors.push(`${tag} profile.rate.hardKill 必须是布尔`);
    }
    if (rt.rateTable !== undefined) {
      if (!Array.isArray(rt.rateTable)) errors.push(`${tag} profile.rate.rateTable 必须是数组`);
      else {
        for (const [i, v] of rt.rateTable.entries()) {
          if (!isNum(v) || v <= 0) errors.push(`${tag} profile.rate.rateTable[${i}] 必须是 >0 的数字`);
        }
        if (rt.rateTable.some((v, i, a) => i > 0 && v <= a[i - 1])) {
          warnings.push(`${tag} profile.rate.rateTable 不是严格升序：${rt.rateTable.join(',')}`);
        }
      }
    }
    // hardKill 的语义就是「超速杀播放器」→ 有效倍速只能是 1
    if (rt.hardKill === true && isNum(rt.declaredMax) && rt.declaredMax > 1) {
      warnings.push(`${tag} rate.hardKill=true 却声明 declaredMax=${rt.declaredMax}：硬杀平台的有效倍速会被 plan 压回 1，declaredMax 只反映站点 UI 档位`);
    }
    if (isNum(rt.declaredMax) && isNum(rt.accountingMax) && rt.accountingMax > rt.declaredMax) {
      warnings.push(`${tag} rate.accountingMax(${rt.accountingMax}) > declaredMax(${rt.declaredMax})：记账上限不该超过站点档位`);
    }
  }

  // ══════════════════════════════════════════════════════
  // detect
  // ══════════════════════════════════════════════════════
  const dt = profile.detect;
  if (dt === undefined || dt === null) {
    warnings.push(`${tag} profile.detect 缺失：plan 将按 C0 处理，检测强度未知`);
  } else if (!isPlainObject(dt)) {
    errors.push(`${tag} profile.detect 必须是对象`);
  } else {
    if (dt.level !== undefined && !DETECT_LEVELS.includes(dt.level)) {
      errors.push(`${tag} profile.detect.level 非法：${dt.level}（合法：${DETECT_LEVELS.join('/')}）`);
    }
    if (dt.level === undefined) warnings.push(`${tag} profile.detect.level 未写：plan 按 C0 处理`);
    if (dt.inject !== undefined && !INJECT_MODES.includes(dt.inject)) {
      errors.push(`${tag} profile.detect.inject 非法：${dt.inject}（合法：${INJECT_MODES.join('/')}）`);
    }
    if (dt.click !== undefined && !CLICK_MODES.includes(dt.click)) {
      errors.push(`${tag} profile.detect.click 非法：${dt.click}（合法：${CLICK_MODES.join('/')}）`);
    }
    if (dt.kickDelaySec !== undefined && (!isNum(dt.kickDelaySec) || dt.kickDelaySec < 0)) {
      errors.push(`${tag} profile.detect.kickDelaySec 必须是 >=0 的数字`);
    }
    if (dt.probes !== undefined) {
      if (!Array.isArray(dt.probes)) errors.push(`${tag} profile.detect.probes 必须是数组`);
      else for (const p of dt.probes) {
        if (!PROBE_IDS.includes(p)) {
          warnings.push(`${tag} profile.detect.probes 含未登记探针「${p}」（已登记：${PROBE_IDS.join('/')}）`);
        }
      }
    }
    dateCheck(errors, `${tag} profile.detect.verified`, dt.verified);
  }

  // ══════════════════════════════════════════════════════
  // access
  // ══════════════════════════════════════════════════════
  const ax = profile.access;
  if (ax === undefined || ax === null) {
    errors.push(`${tag} profile.access 必须是对象（captcha 是必填）`);
  } else if (!isPlainObject(ax)) {
    errors.push(`${tag} profile.access 必须是对象`);
  } else {
    if (ax.captcha === undefined) errors.push(`${tag} profile.access.captcha 必填（none/image/session-bound/sms/face）`);
    else if (!CAPTCHA_KINDS.includes(ax.captcha)) {
      errors.push(`${tag} profile.access.captcha 非法：${ax.captcha}（合法：${CAPTCHA_KINDS.join('/')}）`);
    }
    if (ax.sso !== undefined && !SSO_MODES.includes(ax.sso)) {
      errors.push(`${tag} profile.access.sso 非法：${ax.sso}（合法：${SSO_MODES.join('/')}）`);
    }
    if (ax.navOrder !== undefined) {
      if (!Array.isArray(ax.navOrder)) errors.push(`${tag} profile.access.navOrder 必须是数组`);
      else for (const [i, s] of ax.navOrder.entries()) {
        if (typeof s !== 'string' || !s.trim()) errors.push(`${tag} profile.access.navOrder[${i}] 必须是非空字符串`);
      }
    }
    if (ax.faceOnFinish !== undefined && typeof ax.faceOnFinish !== 'boolean') {
      errors.push(`${tag} profile.access.faceOnFinish 必须是布尔`);
    }
    dateCheck(errors, `${tag} profile.access.verified`, ax.verified);

    // 双层 SSO 不给 navOrder，等于让驱动自己猜导航顺序（HANDOVER §5.74 整页导航必踢）
    if (ax.sso === 'double' && (!Array.isArray(ax.navOrder) || !ax.navOrder.length)) {
      warnings.push(`${tag} access.sso=double 但没有 navOrder：整页导航会丢鉴权，驱动无从下手`);
    }
  }

  // ══════════════════════════════════════════════════════
  // §4.3 profile 与 constraints 的冲突检测（profile 优先，但要报出来）
  // ══════════════════════════════════════════════════════
  const lc = isPlainObject(legacyConstraints) ? legacyConstraints : {};
  if (isPlainObject(rt)) {
    if (isNum(rt.declaredMax) && isNum(lc.rateMax) && rt.declaredMax !== lc.rateMax) {
      warnings.push(`${tag} 冲突：profile.rate.declaredMax=${rt.declaredMax} ≠ constraints.rateMax=${lc.rateMax}（按 profile 优先）`);
    }
    if (isNum(rt.accountingMax) && isNum(lc.accountingMaxRate) && rt.accountingMax !== lc.accountingMaxRate) {
      warnings.push(`${tag} 冲突：profile.rate.accountingMax=${rt.accountingMax} ≠ constraints.accountingMaxRate=${lc.accountingMaxRate}（按 profile 优先）`);
    }
  }

  return { errors, warnings };
}

function dateCheck(errors, label, v) {
  if (v === undefined) return;                    // 缺失只由各段自己决定要不要 warning
  if (typeof v !== 'string' || !DATE_RE.test(v)) errors.push(`${label} 必须是 YYYY-MM-DD：${v}`);
}

/**
 * 判定一块 profile 的可信度（plan.mjs 用）。
 *   verified   —— 四段里至少 accounting 与 access 都标了 verified 日期
 *   unverified —— 有 profile 但关键段没标日期
 *   legacy     —— 没有 profile，退化为读 constraints
 * @returns {'verified'|'unverified'|'legacy'}
 */
export function profileConfidence(profile) {
  if (!isPlainObject(profile)) return 'legacy';
  const ac = isPlainObject(profile.accounting) && !!profile.accounting.verified;
  const ax = isPlainObject(profile.access) && !!profile.access.verified;
  return (ac && ax) ? 'verified' : 'unverified';
}
