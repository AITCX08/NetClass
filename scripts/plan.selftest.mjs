#!/usr/bin/env node
/**
 * scripts/plan.selftest.mjs —— plan.mjs 的决策表逐字段自测
 *
 * 规格 §5.2 硬性要求 2：「没有 selftest 不算完成」。
 *
 * 三层测试：
 *   A. 9 个真实平台的**锁定期望值**（每列都要对上，改错一个数字就红）
 *   B. 规则级用例（用合成 fixture 打每一条规则：rate=min、hardKill、inject 映射、
 *      click 推导、blockers、legacy 退化），不依赖 config 现状
 *   C. 纯度守卫（静态扫 plan.mjs 源码：不许 fetch / 读写文件 / 碰 runs/ / 起子进程）
 *
 * 退出码 0 = 全过。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planFor, decide } from './plan.mjs';
import { all } from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

let pass = 0;
const fails = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${label}\n      actual   = ${a}\n      expected = ${e}`);
}
function ok(label, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? '\n      ' + detail : ''}`);
}

// ══════════════════════════════════════════════════════════════
// A. 9 个真实平台：锁定期望值
// ══════════════════════════════════════════════════════════════
const DURATION = 20664;
const EXPECTED = {
  ccjyxy: {
    model: 'watchtime', rate: 1.25, parallel: 1, inject: 'full', click: 'cdp',
    seekOk: false, seekTarget: null, tailWaitSec: 0, settleLagSec: 300,
    verifyAtEnd: false, confidence: 'verified', rateCandidates: [1, 1.25],
    wallClockSec: Math.round(20664 / 1.25 + 0 + 300),   // 16831
    blockerCodes: [],
  },
  chaoxing: {
    model: 'settle', rate: 1.5, parallel: 1, inject: 'full', click: 'dom',
    seekOk: false, seekTarget: null, tailWaitSec: 0, settleLagSec: 0,
    verifyAtEnd: true, confidence: 'verified', rateCandidates: [1.5],
    wallClockSec: Math.round(20664 / 1.5 + 0 + 0),      // 13776
    blockerCodes: [],
  },
  shengsheng: {
    model: 'settle', rate: 1.5, parallel: 2, inject: 'full', click: 'dom',
    seekOk: false, seekTarget: null, tailWaitSec: 0, settleLagSec: 0,
    verifyAtEnd: true, confidence: 'verified', rateCandidates: [1.5],
    wallClockSec: Math.round(20664 / 1.5 / 2 + 0 + 0),  // 6888
    blockerCodes: [],
  },
  zhihuishu: {
    model: 'position', rate: 1.5, parallel: 1, inject: 'cdp-only', click: 'cdp',
    seekOk: true, seekTarget: 'duration-15', tailWaitSec: 15, settleLagSec: 0,
    verifyAtEnd: false, confidence: 'verified', rateCandidates: [1, 1.25, 1.5],
    wallClockSec: 15,
    blockerCodes: ['detect-high'],
  },
  qiyang: {
    model: 'position', rate: 2, parallel: 1, inject: 'full', click: 'dom',
    seekOk: true, seekTarget: 'duration-15', tailWaitSec: 15, settleLagSec: 0,
    verifyAtEnd: false, confidence: 'unverified', rateCandidates: [2],
    wallClockSec: 15,
    blockerCodes: [],
  },
  webtrn: {
    model: 'settle', rate: 1, parallel: 1, inject: 'full', click: 'dom',
    seekOk: false, seekTarget: null, tailWaitSec: 0, settleLagSec: 0,
    verifyAtEnd: true, confidence: 'unverified', rateCandidates: [1],
    wallClockSec: Math.round(20664 / 1 + 0 + 0),        // 20664
    blockerCodes: [],
  },
  smartedu: {
    model: 'watchtime', rate: 2, parallel: 1, inject: 'full', click: 'cdp',
    seekOk: false, seekTarget: null, tailWaitSec: 0, settleLagSec: 480,
    verifyAtEnd: false, confidence: 'verified', rateCandidates: [1, 1.25, 1.5, 1.75, 2],
    wallClockSec: Math.round(20664 / 2 + 0 + 480),      // 10812
    blockerCodes: [],
  },
  'smartedu-cn': {
    model: 'position', rate: 2, parallel: 1, inject: 'full', click: 'cdp',
    seekOk: true, seekTarget: 'duration-15', tailWaitSec: 15, settleLagSec: 0,
    verifyAtEnd: false, confidence: 'verified', rateCandidates: [2],
    wallClockSec: 15,
    blockerCodes: [],
  },
  huayi: {
    model: 'tick', rate: 1, parallel: 1, inject: 'cdp-only', click: 'cdp',
    seekOk: true, seekTarget: 'duration-90', tailWaitSec: 100, settleLagSec: 0,
    verifyAtEnd: false, confidence: 'verified', rateCandidates: [1],
    wallClockSec: Math.round(20664 / 1 + 100 + 0),      // 20764
    blockerCodes: ['captcha-session-bound', 'face-on-finish', 'sso-double'],
  },
};

const cfg = all();
const realKeys = Object.keys(cfg);
eq('A0 平台集合', realKeys.sort(), Object.keys(EXPECTED).sort());

for (const [key, want] of Object.entries(EXPECTED)) {
  const r = planFor(key, { duration: DURATION });
  const p = `A[${key}]`;
  eq(`${p}.model`, r.model, want.model);
  eq(`${p}.rate`, r.rate, want.rate);
  eq(`${p}.rateCandidates`, r.rateCandidates, want.rateCandidates);
  eq(`${p}.parallel`, r.parallel, want.parallel);
  eq(`${p}.inject`, r.inject, want.inject);
  eq(`${p}.click`, r.click, want.click);
  eq(`${p}.clickMode`, r.clickMode, want.click);         // 与 click 同值（§5.2 示例两个字段都给了）
  eq(`${p}.seek.ok`, r.seek.ok, want.seekOk);
  eq(`${p}.seek.target`, r.seek.target, want.seekTarget);
  eq(`${p}.seek.naturalPlay`, r.seek.naturalPlay, want.model === 'tick' || want.model === 'watchtime' || want.model === 'settle');
  eq(`${p}.seek.tailWaitSec`, r.seek.tailWaitSec, want.tailWaitSec);
  eq(`${p}.tailWaitSec`, r.tailWaitSec, want.tailWaitSec);
  eq(`${p}.settleLagSec`, r.settleLagSec, want.settleLagSec);
  eq(`${p}.verifyAtEnd`, r.verifyAtEnd, want.verifyAtEnd);
  eq(`${p}.confidence`, r.confidence, want.confidence);
  eq(`${p}.wallClockSec`, r.wallClockSec, want.wallClockSec);
  eq(`${p}.blockers`, r.blockers.map((b) => b.code), want.blockerCodes);
  eq(`${p}.cdp`, r.cdp, Number(cfg[key].cdp));
  // 每个 blocker 都必须带 need + why
  for (const b of r.blockers) {
    ok(`${p}.blocker[${b.code}].need`, !!b.need);
    ok(`${p}.blocker[${b.code}].why`, typeof b.why === 'string' && b.why.length > 0);
  }
}

// ══════════════════════════════════════════════════════════════
// B. 规则级用例（合成 fixture，不依赖 config）
// ══════════════════════════════════════════════════════════════
const baseCaps = ['video'];
const mk = (over = {}) => ({
  label: 'synthetic', host: 'x.example.com', cdp: 9999, capabilities: baseCaps,
  driver: { script: null, args: [] }, watchers: [], categories: null,
  completion: { kind: 'pageText', pattern: 'x', verified: '2026-01-01' },
  constraints: { maxParallel: 1, rateMax: null, accountingMaxRate: null },
  auth: { loginUrl: 'https://x/', probe: null, fields: {}, captcha: 'none' },
  ...over,
});
const mkProfile = (over = {}) => ({
  accounting: { model: 'position', verified: '2026-01-01' },
  rate: { declaredMax: 2 },
  detect: { level: 'C0', probes: [], verified: '2026-01-01' },
  access: { captcha: 'none', sso: 'single', verified: '2026-01-01' },
  ...over,
});

// B1 rate = min(declaredMax, accountingMax, hardKill?1:∞)
eq('B1a rate=min 全开', decide('t', mk({ profile: mkProfile({ rate: { declaredMax: 2, accountingMax: 1.25 } }) })).rate, 1.25);
eq('B1b rate=declaredMax 当 accountingMax 缺省', decide('t', mk({ profile: mkProfile({ rate: { declaredMax: 1.75 } }) })).rate, 1.75);
eq('B1c hardKill 压回 1', decide('t', mk({ profile: mkProfile({ rate: { declaredMax: 2, hardKill: true } }) })).rate, 1);
eq('B1d hardKill 且 accountingMax 更低 → 仍取更小', decide('t', mk({ profile: mkProfile({ rate: { declaredMax: 2, accountingMax: 0.5, hardKill: true } }) })).rate, 0.5);
// ★ 回归：Number(null)===0 的老 bug（曾把 smartedu-cn 的 rate 压成 1）
{
  const r = decide('t', mk({
    profile: mkProfile({ rate: { declaredMax: 2, accountingMax: null } }),
    constraints: { maxParallel: 1, rateMax: null, accountingMaxRate: null },
  }));
  eq('B1e constraints 里 null 不当成 0', r.rate, 2);
  ok('B1e 无「rate 计算异常」warning', !r.warnings.some((w) => w.includes('rate 计算异常')));
}

// B2 rateCandidates：按档位表裁剪
eq('B2a 档位表裁剪', decide('t', mk({ profile: mkProfile({ rate: { declaredMax: 2, accountingMax: 1.25, rateTable: [1, 1.25, 1.5, 2] } }) })).rateCandidates, [1, 1.25]);
eq('B2b 无档位表 → [rate]', decide('t', mk({ profile: mkProfile({ rate: { declaredMax: 1.5 } }) })).rateCandidates, [1.5]);

// B3 模型 → seek
eq('B3a position', decide('t', mk({ profile: mkProfile({ accounting: { model: 'position', verified: '2026-01-01' } }) })).seek, { ok: true, target: 'duration-15', naturalPlay: false, tailWaitSec: 15 });
eq('B3b watchtime', decide('t', mk({ profile: mkProfile({ accounting: { model: 'watchtime', verified: '2026-01-01' } }) })).seek, { ok: false, target: null, naturalPlay: true, tailWaitSec: 0 });
eq('B3c tick', decide('t', mk({ profile: mkProfile({ accounting: { model: 'tick', verified: '2026-01-01' } }) })).seek, { ok: true, target: 'duration-90', naturalPlay: true, tailWaitSec: 100 });
eq('B3d settle 取保守分支', decide('t', mk({ profile: mkProfile({ accounting: { model: 'settle', verified: '2026-01-01' } }) })).seek, { ok: false, target: null, naturalPlay: true, tailWaitSec: 0 });
// 手工覆盖优先
eq('B3e seekTarget 覆盖', decide('t', mk({ profile: mkProfile({ accounting: { model: 'position', seekTarget: 'duration-90', verified: '2026-01-01' } }) })).seek.target, 'duration-90');
eq('B3f seekOk=false 覆盖（position）', decide('t', mk({ profile: mkProfile({ accounting: { model: 'position', seekOk: false, verified: '2026-01-01' } }) })).seek.ok, false);

// B4 inject 映射（§5.2 规则表）
for (const [lvl, want] of [['C0', 'full'], ['C1', 'full'], ['C2', 'full'], ['C3', 'minimal'], ['C4', 'cdp-only'], ['C5', 'cdp-only']]) {
  eq(`B4 inject(${lvl})`, decide('t', mk({ profile: mkProfile({ detect: { level: lvl, probes: [], verified: '2026-01-01' } }) })).inject, want);
}
eq('B4x 显式 inject 覆盖', decide('t', mk({ profile: mkProfile({ detect: { level: 'C3', inject: 'cdp-only', probes: [], verified: '2026-01-01' } }) })).inject, 'cdp-only');

// B5 click 推导
eq('B5a probes 含 isTrusted → cdp', decide('t', mk({ profile: mkProfile({ detect: { level: 'C0', probes: ['isTrusted'], verified: '2026-01-01' } }) })).click, 'cdp');
eq('B5b 无 isTrusted → dom', decide('t', mk({ profile: mkProfile({ detect: { level: 'C0', probes: ['plugin-blacklist'], verified: '2026-01-01' } }) })).click, 'dom');
eq('B5c 显式 click 覆盖', decide('t', mk({ profile: mkProfile({ detect: { level: 'C0', probes: [], click: 'cdp', verified: '2026-01-01' } }) })).click, 'cdp');

// B6 blockers
eq('B6a captcha=sms', decide('t', mk({ profile: mkProfile({ access: { captcha: 'sms', sso: 'single', verified: '2026-01-01' } }) })).blockers.map((b) => b.code), ['captcha-sms']);
eq('B6b captcha=face', decide('t', mk({ profile: mkProfile({ access: { captcha: 'face', sso: 'single', verified: '2026-01-01' } }) })).blockers.map((b) => b.code), ['captcha-face']);
eq('B6c captcha=session-bound', decide('t', mk({ profile: mkProfile({ access: { captcha: 'session-bound', sso: 'single', verified: '2026-01-01' } }) })).blockers.map((b) => b.code), ['captcha-session-bound']);
eq('B6d faceOnFinish', decide('t', mk({ profile: mkProfile({ access: { captcha: 'none', sso: 'single', faceOnFinish: true, verified: '2026-01-01' } }) })).blockers.map((b) => b.code), ['face-on-finish']);
eq('B6e sso=double', decide('t', mk({ profile: mkProfile({ access: { captcha: 'none', sso: 'double', navOrder: ['a'], verified: '2026-01-01' } }) })).blockers.map((b) => b.code), ['sso-double']);
eq('B6f C5 → detect-high', decide('t', mk({ profile: mkProfile({ detect: { level: 'C5', probes: [], verified: '2026-01-01' } }) })).blockers.map((b) => b.code), ['detect-high']);

// B7 legacy 退化（无 profile）
{
  const r = decide('legacy-x', mk({ profile: undefined, constraints: { maxParallel: 1, rateMax: 1.5, accountingMaxRate: 1.25 } }), { duration: 1000 });
  eq('B7a confidence=legacy', r.confidence, 'legacy');
  eq('B7b model=null', r.model, null);
  eq('B7c rate 回落 constraints', r.rate, 1.25);
  ok('B7d 有 no-profile blocker', r.blockers.some((b) => b.code === 'no-profile'));
  ok('B7e 有退化 warning', r.warnings.some((w) => w.includes('缺 profile')));
}

// B8 wallClock 公式
eq('B8a position → 只花尾段', decide('t', mk({ profile: mkProfile({ accounting: { model: 'position', verified: '2026-01-01' } }) }), { duration: 9999 }).wallClockSec, 15);
eq('B8b tick → content/rate/par + tail + lag', decide('t', mk({ profile: mkProfile({ accounting: { model: 'tick', settleLagSec: 7, verified: '2026-01-01' }, rate: { declaredMax: 2 } }) }), { duration: 1000 }).wallClockSec, Math.round(1000 / 2 / 1 + 100 + 7));
eq('B8c 无 duration → null（不编数）', decide('t', mk({ profile: mkProfile({ accounting: { model: 'tick', verified: '2026-01-01' } }) })).wallClockSec, null);
ok('B8d 无 duration 有 warning', decide('t', mk({ profile: mkProfile({ accounting: { model: 'tick', verified: '2026-01-01' } }) })).warnings.some((w) => w.includes('--duration')));

// B9 并行 + session-bound 的 warning
ok('B9 多路 + session-bound 有 warning',
  decide('t', mk({
    profile: mkProfile({ access: { captcha: 'session-bound', sso: 'single', verified: '2026-01-01' } }),
    constraints: { maxParallel: 3, rateMax: null, accountingMaxRate: null },
  })).warnings.some((w) => w.includes('session-bound')));

// B10 输出里不许有 undefined / NaN（全平台 × 两种 duration 形态）
for (const d of [undefined, DURATION]) {
  const rows = Object.keys(cfg).map((k) => planFor(k, d === undefined ? {} : { duration: d }));
  const s = JSON.stringify(rows);
  ok(`B10 输出无 undefined/NaN (duration=${d === undefined ? '未给' : d})`, !/undefined|NaN/.test(s));
}

// ══════════════════════════════════════════════════════════════
// C. 纯度守卫：plan.mjs 不许有 IO / 网络 / 子进程
// ══════════════════════════════════════════════════════════════
{
  const raw = readFileSync(join(REPO, 'scripts', 'plan.mjs'), 'utf8');
  // 纯度守卫要扫「代码」而不是注释：plan.mjs 的头注释里就写着「不读 runs/」，
  // 直接扫原文会把这句说明当成违规。先剥注释，再扫。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const src = stripComments(raw);
  const FORBIDDEN = [
    [/\bfetch\s*\(/, 'fetch('],
    [/\breadFileSync\b|\breadFile\b/, 'readFile*'],
    [/\bwriteFileSync\b|\bwriteFile\b|\bappendFileSync\b/, 'writeFile*/appendFile*'],
    [/\bchild_process\b/, 'child_process'],
    [/\bruns\//, 'runs/ 路径'],
    [/\bhttps?:\/\//, 'http(s):// URL'],
  ];
  for (const [re, name] of FORBIDDEN) {
    ok(`C 纯度：plan.mjs 代码里不含 ${name}`, !re.test(src));
  }
  ok('C 纯度：plan.mjs 只 import registry + profile-schema',
    (raw.match(/^import .* from '(\.\/[^']+)';$/gm) || []).every((l) => /\.\/(registry|profile-schema)\.mjs/.test(l)));
}

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log('plan.selftest');
console.log('  pass = ' + pass + '   fail = ' + fails.length);
if (fails.length) {
  console.log('');
  for (const f of fails) console.log('  ✗ ' + f);
  console.log('\n❌ 未通过');
  process.exit(1);
}
console.log('\n✅ all pass');
process.exit(0);
