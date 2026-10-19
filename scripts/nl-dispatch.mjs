#!/usr/bin/env node
/**
 * scripts/nl-dispatch.mjs —— 自然语言 → 结构化任务单（P2）
 *
 * 设计原则（见 docs/AGENT-ARCHITECTURE.md §3）：
 *   1. **规则优先**：常见说法直接命中，不花 token、不依赖网络。
 *   2. **能力校验**：注册表里 capabilities 不匹配 → 直接拒绝派单，不是跑起来才发现做不了。
 *   3. **原文永存**：rawInput 落进任务单，判错了可以重判，不用让用户重说。
 *   4. **不确定就反问**：confidence < 0.7 或平台/类型识别失败 → needsConfirm，绝不瞎猜着执行。
 *
 * 当前状态：**纯规则版，零外部依赖**（项目里没有统一 LLM 调用层）。
 *   LLM 兜底留在 `classifyByLLM()` 里，是**可选钩子**：
 *   没配置就返回 null → 上层退回 needsConfirm（正确行为，不是失败）。
 *
 * CLI：
 *   node scripts/nl-dispatch.mjs "帮我把长春那 90 学时刷完"       判型并建单
 *   node scripts/nl-dispatch.mjs --dry "把知到的作业交了"          只判型不落盘
 *   node scripts/nl-dispatch.mjs --json "..."                      输出机器可读结果
 *   node scripts/nl-dispatch.mjs --test                            跑内置用例（自检）
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as registry from './registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TASKS_DIR = join(ROOT, 'runs', 'tasks');

// ══════════════════════════════════════════════════════
// 知识表：平台别名 / 任务类型 / 目标
// ══════════════════════════════════════════════════════

/** 平台别名 → 注册表 key。顺序有意义：更长的别名放前面（避免"长春教师"被"长春"抢先）。 */
const PLATFORM_ALIASES = [
  // 长春
  ['长春教师培训', 'ccjyxy'], ['长春师范', 'ccjyxy'], ['长春教育', 'ccjyxy'],
  ['长春', 'ccjyxy'], ['ccjyxy', 'ccjyxy'], ['col.ccjyxy', 'ccjyxy'],
  // 学习通 / 超星
  ['学习通', 'chaoxing'], ['超星', 'chaoxing'], ['chaoxing', 'chaoxing'], ['mooc1', 'chaoxing'],
  // 知到 / 智慧树
  ['智慧树', 'zhihuishu'], ['知到', 'zhihuishu'], ['zhihuishu', 'zhihuishu'], ['zhs', 'zhihuishu'],
  // 生生课堂
  ['生生课堂', 'shengsheng'], ['生生', 'shengsheng'], ['shengsheng', 'shengsheng'],
  ['shengshengketang', 'shengsheng'],
  // 齐阳
  ['齐阳', 'qiyang'], ['职业培训', 'qiyang'], ['qiyang', 'qiyang'], ['bjqiyang', 'qiyang'],
  // webtrn
  ['webtrn', 'webtrn'], ['教师培训平台', 'webtrn'], ['tea.webtrn', 'webtrn'],
];

/**
 * 任务类型规则。**顺序有意义**：更具体的放前面。
 * 每条：{ type, re, why }
 */
const TYPE_RULES = [
  // 考试（要先于 quiz 判，否则"期末测试"会被 quiz 抢走）
  { type: 'exam', re: /(期末考试|期末|考试|测评|结业考)/, why: '含"考试/期末/测评"字样' },
  // 作业
  { type: 'homework', re: /(作业|论文|心得|总结|报告|研修作业|提交文档|交论文)/, why: '含"作业/论文/心得/报告"' },
  // 发帖回帖
  { type: 'post', re: /(发帖|回帖|跟帖|讨论|研讨|发言|回复|顶帖|参加讨论)/, why: '含"发帖/回帖/讨论/研讨"' },
  // 弹题（要先于 video 判）
  { type: 'quiz', re: /(弹题|随堂题|随堂测|随堂测验|答题|做题|测验)/, why: '含"弹题/随堂题/答题/测验"' },
  // 视频（最宽，放最后）
  { type: 'video', re: /(刷课|刷课|看课|看完|看完视频|学完|学习|上课|视频|课时|学时|进度|刷)/, why: '含"刷课/看完/视频/学时"等视频特征词' },
];

/** 目标抽取的正则（按优先级） */
const GOAL_PATTERNS = [
  { kind: 'credit', re: /(\d+(?:\.\d+)?)\s*(?:个)?\s*学时/, unit: '学时', why: '显式学时数' },
  { kind: 'count', re: /(\d+)\s*门(?:课|课程)?/, unit: '门', why: '显式门数' },
  { kind: 'ratio', re: /(\d+(?:\.\d+)?)\s*%/, unit: '%', why: '显式百分比' },
];

// ══════════════════════════════════════════════════════
// 判型主逻辑
// ══════════════════════════════════════════════════════

/**
 * 从自然语言里识别平台。
 * @returns {{ key: string|null, via: string, matched: string|null }}
 */
export function detectPlatform(input) {
  const s = String(input || '');
  const lower = s.toLowerCase();
  for (const [alias, key] of PLATFORM_ALIASES) {
    if (lower.includes(alias.toLowerCase())) {
      return { key, via: 'alias', matched: alias };
    }
  }
  // 兜底：话里直接带了域名
  const m = s.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  if (m) {
    const k = registry.byHost(m[1]);
    if (k) return { key: k, via: 'host', matched: m[1] };
  }
  return { key: null, via: 'none', matched: null };
}

/**
 * 识别任务类型。
 * @returns {{ type: string|null, confidence: number, why: string }}
 */
export function detectType(input) {
  const s = String(input || '');
  for (const r of TYPE_RULES) {
    if (r.re.test(s)) {
      // 命中更具体的规则 → 置信度更高
      const idx = TYPE_RULES.indexOf(r);
      const conf = idx <= 1 ? 0.95 : (idx <= 3 ? 0.88 : 0.8);
      return { type: r.type, confidence: conf, why: r.why };
    }
  }
  return { type: null, confidence: 0, why: '没有任何类型关键词命中' };
}

/** 抽目标（学时/门数/百分比）；抽不到返回 {kind:'finish'} */
export function extractGoal(input) {
  const s = String(input || '');
  for (const p of GOAL_PATTERNS) {
    const m = s.match(p.re);
    if (m) return { kind: p.kind, value: Number(m[1]), unit: p.unit, why: p.why, matched: m[0] };
  }
  return { kind: 'finish', value: null, unit: null, why: '没说具体目标 → 做到平台判定的"完成"' };
}

/** 抽范围（全部 / 某分类 / 某课程） */
export function extractScope(input, reg) {
  const s = String(input || '');
  const all = /(全部|所有|都|整个|全部课程)/.test(s);
  // 分类名匹配（只有注册表里声明了 categories 的平台才有）
  if (reg && Array.isArray(reg.categories)) {
    for (const c of reg.categories) {
      if (s.includes(c.key)) return { scope: 'category', category: c.key, why: `命中分类名「${c.key}」` };
    }
    // 常见简写
    if (/公需/.test(s)) {
      const hit = reg.categories.find(c => c.key.includes('公需'));
      if (hit) return { scope: 'category', category: hit.key, why: '命中「公需」简写' };
    }
    if (/通识/.test(s)) {
      const hit = reg.categories.find(c => c.key.includes('通识'));
      if (hit) return { scope: 'category', category: hit.key, why: '命中「通识」简写' };
    }
  }
  if (all) return { scope: 'all', category: null, why: '含"全部/所有"' };
  return { scope: 'all', category: null, why: '未指明范围 → 默认全部' };
}

/**
 * LLM 兜底（可选钩子）。
 * 项目里目前没有统一的 LLM 调用层，所以这里**故意返回 null**：
 * 上层会退回 needsConfirm，让用户换个说法或人工建单 —— 这是正确行为，不是失败。
 *
 * 将来接 LLM 时，只需在这里调用并把结果规范化成 { platform, taskType, confidence, goal }。
 * @returns {Promise<null|object>}
 */
export async function classifyByLLM(_input, _caps) {
  return null;
}

/**
 * 主入口：一句话 → 0..N 个任务单。
 * @param {string} input
 * @param {object} [ctx]   上下文（预留：上次任务、活跃账号、当前时间窗）
 * @param {object} [opts]  { dryRun, allowLLM }
 */
export async function dispatch(input, ctx = {}, opts = {}) {
  const text = String(input || '').trim();
  const warnings = [];
  const questions = [];

  if (!text) {
    return { tasks: [], needsConfirm: true, questions: ['要说做什么？（例："把长春的课刷完"）'], warnings: ['输入为空'] };
  }

  // ── 1) 平台 ──────────────────────────────
  let plat = detectPlatform(text);
  if (!plat.key && opts.allowLLM) {
    const r = await classifyByLLM(text);
    if (r && r.platform) { plat = { key: r.platform, via: 'llm', matched: null }; warnings.push('平台由 LLM 判定（低置信）'); }
  }
  if (!plat.key) {
    return {
      tasks: [], needsConfirm: true,
      questions: [`识别不出平台。要处理哪个？（可用：${registry.keys().join(' / ')}）`],
      warnings: ['平台未识别'],
    };
  }
  const reg = registry.get(plat.key);

  // ── 2) 类型 ──────────────────────────────
  let ty = detectType(text);
  if (!ty.type && opts.allowLLM) {
    const r = await classifyByLLM(text, reg.capabilities);
    if (r && r.taskType) { ty = { type: r.taskType, confidence: r.confidence || 0.6, why: 'LLM 判定' }; warnings.push('类型由 LLM 判定（低置信）'); }
  }
  if (!ty.type) {
    return {
      tasks: [], needsConfirm: true,
      questions: [`识别不出要做什么（视频/弹题/作业/发帖/考试）。原话：「${text}」`],
      warnings: ['任务类型未识别'],
    };
  }

  // ── 3) ★ 能力校验（最关键的一条）────────────
  if (!reg.capabilities.includes(ty.type)) {
    const caps = reg.capabilities.length ? reg.capabilities.join(' / ') : '无（尚未适配）';
    warnings.push(`${reg.label} 不支持「${ty.type}」—— 它当前支持：${caps}`);
    // 看看哪个平台支持这个类型，给个建议
    const others = registry.keys().filter(k => k !== plat.key && registry.get(k).capabilities.includes(ty.type));
    if (others.length) {
      questions.push(`${reg.label} 做不了「${ty.type}」。支持这个任务的有：${others.map(k => registry.get(k).label).join(' / ')}。要换吗？`);
    } else {
      questions.push(`${reg.label} 做不了「${ty.type}」，且没有其它平台支持这个类型。`);
    }
    return { tasks: [], needsConfirm: true, questions, warnings };
  }

  // ── 4) 目标 / 范围 ─────────────────────────
  const goal = extractGoal(text);
  const scope = extractScope(text, reg);
  if (goal.kind === 'finish' && reg.completion?.kind) {
    // 没显式目标 → 用注册表声明的总目标（如长春 90 学时）
    const total = reg.categories ? reg.categories.reduce((s, c) => s + (c.goal || 0), 0) : null;
    if (total) { goal.kind = 'credit'; goal.value = total; goal.unit = '学时'; goal.why = `未显式指定 → 取注册表声明的总目标 ${total}`; }
  }

  // ── 5) 组装任务单 ──────────────────────────
  const id = `t_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${plat.key.slice(0, 2)}`;
  const task = {
    id,
    createdAt: new Date().toISOString(),
    source: 'nl',
    rawInput: text,                                  // ★ 原文永存
    confidence: Math.min(ty.confidence, plat.via === 'alias' ? 0.95 : 0.7),
    platform: plat.key,
    taskType: ty.type,
    target: {
      scope: scope.scope,
      category: scope.category,
      course: null,
      goal: { kind: goal.kind, value: goal.value, unit: goal.unit },
    },
    constraints: {
      rate: 2,
      maxParallel: reg.constraints?.maxParallel ?? 1,
      windowStart: null, windowEnd: null, deadline: null,
    },
    auth: { accountRef: `${plat.key}-main`, mode: 'auto', onCaptcha: 'pause' },
    deliverable: {
      evidenceDir: `runs/orders/${plat.key}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}/`,
      reportPath: `runs/orders/${plat.key}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}/03_验收报告.md`,
      screenshots: true,
    },
    state: 'queued',
    stateHistory: [{ at: new Date().toISOString(), from: null, to: 'queued', by: 'nl-dispatch' }],
    progress: { startedAt: null, updatedAt: null, metric: { kind: goal.kind, now: null, goal: goal.value }, current: null },
    result: { ok: null, achieved: null, evidence: [], notes: '', blockedReason: null },
    driver: { script: reg.driver?.script ?? null, pid: null, args: [] },

    // 判型依据（可追溯，不是黑盒）
    _derivation: {
      platform: plat, type: ty, goal, scope,
      registryRef: { label: reg.label, capabilities: reg.capabilities, categories: reg.categories?.map(c => c.key) ?? null },
    },
  };

  const needsConfirm = task.confidence < 0.7 || warnings.length > 0;

  // ── 6) 落盘（除非 dryRun）──────────────────
  if (!opts.dryRun) {
    mkdirSync(TASKS_DIR, { recursive: true });
    writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  return { tasks: [task], needsConfirm, questions, warnings };
}

// ══════════════════════════════════════════════════════
// 自检用例（--test）
// ══════════════════════════════════════════════════════
const CASES = [
  // ── 正例：能力匹配，应生成任务单 ──────────────
  { in: '帮我把长春那 90 学时刷完', wantPlatform: 'ccjyxy', wantType: 'video', wantGoal: 90, wantScope: 'all' },
  { in: '长春的公需科目还差多少？帮我刷完', wantPlatform: 'ccjyxy', wantType: 'video', wantScope: 'category', wantCat: '小初高公需' },
  { in: '把长春的初中学段通识学完', wantPlatform: 'ccjyxy', wantType: 'video', wantScope: 'category', wantCat: '初中学段通识' },
  { in: '学习通的课看完', wantPlatform: 'chaoxing', wantType: 'video' },
  { in: '学习通随堂测验做一下', wantPlatform: 'chaoxing', wantType: 'quiz' },      // chaoxing 支持 quiz
  { in: '知到的作业交了', wantPlatform: 'zhihuishu', wantType: 'homework' },
  { in: '知到期末考试做了', wantPlatform: 'zhihuishu', wantType: 'exam' },
  { in: '知到的视频刷到 80%', wantPlatform: 'zhihuishu', wantType: 'video', wantGoalKind: 'ratio', wantGoal: 80 },
  { in: '生生课堂的课看完', wantPlatform: 'shengsheng', wantType: 'video' },
  { in: '生生课堂弹题做了', wantPlatform: 'shengsheng', wantType: 'quiz' },         // shengsheng 支持 quiz
  { in: 'webtrn 交研修作业', wantPlatform: 'webtrn', wantType: 'homework' },
  { in: 'webtrn 讨论区发个帖', wantPlatform: 'webtrn', wantType: 'post' },          // webtrn 支持 post
  { in: '齐阳的视频刷完', wantPlatform: 'qiyang', wantType: 'video' },              // qiyang 支持 video

  // ── 负例：能力不匹配 / 识别不出，必须被拒 ─────────
  { in: '长春的作业交了', wantReject: true },        // ccjyxy = ["video"]，不做 homework
  { in: '长春随堂弹题帮我做了', wantReject: true },   // ccjyxy 不做 quiz
  { in: '生生课堂的讨论区发个帖', wantReject: true },  // shengsheng = video/quiz，不做 post
  { in: '齐阳的作业交了', wantReject: true },        // qiyang = ["video"]，不做 homework
  { in: '随便弄点什么', wantReject: true },           // 平台/类型都识别不出
  { in: '', wantReject: true },                      // 空输入
];

async function selfTest() {
  let pass = 0, fail = 0;
  console.log('=== nl-dispatch 自检（' + CASES.length + ' 例）===\n');
  for (const c of CASES) {
    const r = await dispatch(c.in, {}, { dryRun: true });
    const t = r.tasks[0];
    const problems = [];

    if (c.wantReject) {
      if (t) problems.push('应该被拒但生成了任务单');
    } else {
      if (!t) { problems.push('没生成任务单（needsConfirm=' + r.needsConfirm + '）'); }
      else {
        if (c.wantPlatform && t.platform !== c.wantPlatform) problems.push(`平台 ${t.platform} ≠ ${c.wantPlatform}`);
        if (c.wantType && t.taskType !== c.wantType) problems.push(`类型 ${t.taskType} ≠ ${c.wantType}`);
        if (c.wantGoal && t.target.goal.value !== c.wantGoal) problems.push(`目标 ${t.target.goal.value} ≠ ${c.wantGoal}`);
        if (c.wantGoalKind && t.target.goal.kind !== c.wantGoalKind) problems.push(`目标类型 ${t.target.goal.kind} ≠ ${c.wantGoalKind}`);
        if (c.wantScope && t.target.scope !== c.wantScope) problems.push(`范围 ${t.target.scope} ≠ ${c.wantScope}`);
        if (c.wantCat && t.target.category !== c.wantCat) problems.push(`分类 ${t.target.category} ≠ ${c.wantCat}`);
      }
    }

    const ok = problems.length === 0;
    if (ok) { pass++; console.log(`  ✅ 「${c.in}」`); }
    else { fail++; console.log(`  ❌ 「${c.in}」\n       ${problems.join('；')}`); }
    if (t) console.log(`       → ${t.platform}/${t.taskType} · scope=${t.target.scope}${t.target.category ? '(' + t.target.category + ')' : ''} · goal=${t.target.goal.kind}:${t.target.goal.value ?? '-'} · conf=${t.confidence}`);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

// ══════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const json = argv.includes('--json');
  const test = argv.includes('--test');
  const noLLM = argv.includes('--no-llm');
  const text = argv.filter(a => !a.startsWith('--')).join(' ');

  try {
    if (test) { await selfTest(); }
    else if (!text) {
      console.log('用法：node scripts/nl-dispatch.mjs [--dry] [--json] [--test|--no-llm] "<自然语言>"');
      console.log('\n例：');
      console.log('  node scripts/nl-dispatch.mjs --dry "帮我把长春那 90 学时刷完"');
      console.log('  node scripts/nl-dispatch.mjs "把知到的作业交了"');
      console.log('  node scripts/nl-dispatch.mjs --test');
      process.exit(2);
    } else {
      const r = await dispatch(text, {}, { dryRun: dry, allowLLM: !noLLM });
      if (json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        if (r.tasks.length) {
          const t = r.tasks[0];
          console.log((dry ? '🔍【dry-run 未落盘】' : '✅ 已建单：' + t.id));
          console.log(`  平台   ${t.platform}（${t._derivation.registryRef.label}）  依据：${t._derivation.platform.via}「${t._derivation.platform.matched}」`);
          console.log(`  类型   ${t.taskType}  依据：${t._derivation.type.why}`);
          console.log(`  范围   ${t.target.scope}${t.target.category ? ' / ' + t.target.category : ''}  依据：${t._derivation.scope.why}`);
          console.log(`  目标   ${t.target.goal.kind}:${t.target.goal.value ?? '-'}${t.target.goal.unit || ''}  依据：${t._derivation.goal.why}`);
          console.log(`  置信   ${t.confidence}`);
          if (t._derivation.registryRef.categories) console.log(`  分类   ${t._derivation.registryRef.categories.join(' / ')}`);
        }
        if (r.warnings.length) { console.log('\n⚠ 警告：'); r.warnings.forEach(w => console.log('  · ' + w)); }
        if (r.questions.length) { console.log('\n❓ 需要确认：'); r.questions.forEach(q => console.log('  · ' + q)); }
        if (r.needsConfirm && !r.tasks.length) process.exit(1);
      }
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(1);
  }
}
