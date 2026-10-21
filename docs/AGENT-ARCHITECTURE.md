# NetClass Agent 化改造 —— 接口与骨架设计

> 目标：把现有的「自动化系统」升级成真正的「Agent」。
> 补齐三个缺失层，**不重写已有能力**（适配器/驱动器/守护全部复用）。

---

## 0. 现状与目标（为什么需要这三层）

```
现在：人/LLM 读 course-order-desk 技能判型 → 手工起对应驱动 → 看日志
目标：用户说一句话 → 系统自己判型 → 自己排队 → 自己登录 → 自己跑 → 自己验收
```

| 层 | 现状 | 补齐后 |
|---|---|---|
| **意图** | 靠技能（提示词）+ LLM 在环路 | `nl-dispatch` 出**结构化任务单** |
| **编排** | `supervisor.mjs` **硬编码 6 条** | `orchestrator` **数据驱动注册表** + 队列 + 验收 |
| **登录** | 靠浏览器持久 profile 的 cookie | `auth` **账号池 + 自动登录 + 保活** |

---

## 1. 核心数据契约（三层共用的唯一真相）

**所有模块只认这一个结构。** 落在 `runs\tasks\<taskId>.json`。

```jsonc
{
  // ── 身份 ────────────────────────────────────
  "id": "t_20261019_1030_cc01",        // 稳定 id，用作文件名与幂等键
  "createdAt": "2026-10-19T10:30:00+08:00",
  "source": "nl",                       // nl | api | manual | cron
  "rawInput": "帮我把长春那 90 学时刷完",   // ★ 原始自然语言，永不丢（可回溯/重判）
  "confidence": 0.92,                   // 判型的自评置信度；<0.7 要人确认

  // ── 要做什么 ────────────────────────────────
  "platform": "ccjyxy",                 // 必须是 registry 里的 key
  "taskType": "video",                  // video | quiz | homework | post | exam
  "target": {
    "scope": "all",                     // all | category | course | item
    "category": null,                   // "小初高公需" | "初中学段通识" | null
    "course": null,                     // 课程名（scope=course 时）
    "goal": { "kind": "credit", "value": 90, "unit": "学时" }
    //   goal.kind: credit（学时）| count（门数）| ratio（百分比）| finish（做完即可）
  },

  // ── 怎么跑 ──────────────────────────────────
  "constraints": {
    "rate": 2,                          // 期望倍速（平台允许范围内自动钳位）
    "maxParallel": 1,                   // ★ 单会话平台强制 1
    "windowStart": null,                // "22:00" 只在某时段跑
    "windowEnd": null,
    "deadline": null                    // 超过就放弃并报告
  },

  // ── 登录 ────────────────────────────────────
  "auth": {
    "accountRef": "cc-main",            // 账号池里的 key，不存明文
    "mode": "auto",                     // auto（自动登录）| manual（等人）| reuse（只用现有会话）
    "onCaptcha": "pause"                // pause（暂停等人工）| fail（直接失败）
  },

  // ── 产出 ────────────────────────────────────
  "deliverable": {
    "evidenceDir": "runs/orders/ccjyxy-20261019/",
    "reportPath": "runs/orders/ccjyxy-20261019/03_验收报告.md",
    "screenshots": true
  },

  // ── 状态机（orchestrator 独占写）──────────────
  "state": "queued",                    // queued|authing|running|paused|verifying|done|failed|blocked
  "stateHistory": [
    { "at": "...", "from": null, "to": "queued", "by": "nl-dispatch" }
  ],
  "progress": {
    "startedAt": null, "updatedAt": null,
    "metric": { "kind": "credit", "now": 71.1, "goal": 90 },
    "current": null                     // { category, course, segment, videoCur, videoDur }
  },
  "result": {
    "ok": null,
    "achieved": null,                   // 实际达成（学时/门数）
    "evidence": [],                     // 证据文件路径
    "notes": "",                        // 卡点、人工介入记录
    "blockedReason": null               // state=blocked 时必填
  },
  "driver": { "script": "cc-cycle.mjs", "pid": null, "args": [] }
}
```

**设计要点**
- `rawInput` 永不丢 → 判型错了可以**重判**（改 `taskType` 重跑），不用让用户重说
- `confidence` < 0.7 时 `nl-dispatch` **必须**返回 `needsConfirm: true`，不自动执行
- `state` 只由 `orchestrator` 写（单一写者，避免竞态）
- `driver` 记录实际起的脚本/参数 → **可复现**

---

## 2. 平台注册表（数据驱动，替代硬编码）

**文件**：`config/platforms.json`（**新**，现在这些散在 supervisor 里）

```jsonc
{
  "ccjyxy": {
    "label": "长春教师培训",
    "host": "col.ccjyxy.cn",
    "cdp": 9228,
    "tunnel": { "target": "user@host", "remotePort": 9228 },

    // ★ 能力声明：决定 nl-dispatch 能不能把任务派给它
    "capabilities": ["video"],           // video|quiz|homework|post|exam
    "driver": {
      "script": "cc-cycle.mjs",
      "args": ["--port", "{cdp}"],
      "singleton": true                  // ★ 单会话硬保护：同时只允许 1 个
    },
    "watchers": [
      { "script": "cc-watch.mjs", "args": ["--port", "{cdp}", "--every=180"] }
    ],

    // ★ 分类模型（长春特有：三个手风琴分类，必须一个个来）
    "categories": [
      { "key": "小初高公需",     "goal": 30 },
      { "key": "初中学段通识",   "goal": 15 },
      { "key": "专业课-初中数学", "goal": 45 }
    ],

    // ★ 完成判据（唯一可靠口径）
    "completion": {
      "kind": "pageText",                // pageText | api | domClass
      "pattern": "已修\\s*([\\d.]+)\\s*/\\s*达标\\s*(\\d+)\\s*学时",
      "verified": "2026-10-18"           // 最后验证日期
    },

    // ★ 硬约束（orchestrator 据此排班）
    "constraints": {
      "maxParallel": 1,
      "creditsPerHour": 2.1,             // 实测换算：1 学时 ≈ 28min 墙钟 @1.5x
      "accountingMaxRate": 1.25          // 平台记账上限（超过要重播补录）
    },

    "auth": {
      "loginUrl": "https://col.ccjyxy.cn/",
      "probe": "location.href.indexOf('login')<0",   // 登录态判据（页面内 JS）
      "fields": null,                    // null = 用持久 profile，不自动填表
      "captcha": "none"                  // none | image | sms | face
    }
  },

  "chaoxing": { "label": "学习通", "host": "mooc1.chaoxing.com", "cdp": 9227, "capabilities": ["video","quiz"], "..." : "..." }
}
```

**设计要点**
- **一个平台一条**，字段即契约 → 加平台 = 加一个 JSON 块（不改代码）
- `capabilities` 让 `nl-dispatch` 能**直接判断**"这个平台能不能做这类任务"
- `categories` 只对有多分类的平台写（长春）；单分类平台留 `null`
- `constraints.creditsPerHour` 给 **ETA 估算**用
- `auth.probe` 是**登录态的机器判据**，不是靠"看起来像登录了"

---

## 3. ① `scripts/nl-dispatch.mjs` —— 自然语言 → 任务单

### 接口

```js
/**
 * 把一句自然语言变成 0..N 个任务单。
 * @param {string} input        用户的原始话
 * @param {object} [ctx]        上下文（当前时间、上次任务、活跃账号…）
 * @param {object} [opts]
 * @param {string} [opts.model] LLM 模型（默认读 CFG）
 * @param {boolean} [opts.dryRun] 只判型不落盘
 * @returns {Promise<{
 *   tasks: Task[],                    // 见 §1 契约
 *   needsConfirm: boolean,            // confidence<0.7 或歧义
 *   questions: string[],              // 需要问用户的话（needsConfirm 时）
 *   warnings: string[]                // 例如"该平台不支持 homework"
 * }>}
 */
export async function dispatch(input, ctx = {}, opts = {}) { ... }

/** 单独判型（不生成任务单），用于调试/测试 */
export async function classify(input, ctx = {}) { ... }

/** 把已存在的任务单重判（rawInput 还在，改 type 重跑） */
export async function reclassify(taskId, newType) { ... }
```

### 骨架

```js
#!/usr/bin/env node
// scripts/nl-dispatch.mjs
// 自然语言 → 结构化任务单。判型走"规则优先 + LLM 兜底"，规则命中就不花 token。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { callLLM } from './llm.mjs';          // ★ 待建：统一 LLM 调用（现在散在各处）

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const REG = JSON.parse(readFileSync(join(ROOT, 'config/platforms.json'), 'utf8'));
const TASKS_DIR = join(ROOT, 'runs/tasks');

// ── 规则层：常见说法直接命中，不调模型 ────────────────
const RULES = [
  { re: /(刷|看完|学完|做完).*(课|视频|学时)/,            type: 'video' },
  { re: /(弹题|随堂|测验|答题)/,                          type: 'quiz' },
  { re: /(作业|论文|心得|总结|报告)/,                      type: 'homework' },
  { re: /(发帖|回帖|讨论|研讨|发言)/,                      type: 'post' },
  { re: /(考试|期末|测评)/,                               type: 'exam' },
];

// ── 平台识别：别名表 + host 反查 ──────────────────────
const ALIAS = {
  '长春': 'ccjyxy', '长春教师': 'ccjyxy', '长春师范': 'ccjyxy',
  '学习通': 'chaoxing', '超星': 'chaoxing',
  '知到': 'zhihuishu', '智慧树': 'zhihuishu',
  '生生': 'shengsheng', 'shengsheng': 'shengsheng',
};

export async function dispatch(input, ctx = {}, opts = {}) {
  const warnings = [];

  // 1) 平台
  let platform = null;
  for (const [alias, key] of Object.entries(ALIAS)) {
    if (input.includes(alias)) { platform = key; break; }
  }
  if (!platform) {
    // 兜底：LLM 判 + 也可以从 URL 里提
    platform = await llmPickPlatform(input);
  }
  if (!platform || !REG[platform]) {
    return { tasks: [], needsConfirm: true, questions: ['要处理哪个平台？'], warnings };
  }

  // 2) 任务类型（规则优先）
  let taskType = null, confidence = 0.9;
  for (const r of RULES) { if (r.re.test(input)) { taskType = r.type; break; } }
  if (!taskType) {
    const r = await llmClassify(input, REG[platform].capabilities);
    taskType = r.type; confidence = r.confidence;
  }

  // 3) 能力校验 —— ★ 这是防止"派了做不了的任务"的关键
  if (!REG[platform].capabilities.includes(taskType)) {
    warnings.push(`${REG[platform].label} 不支持 ${taskType}（支持：${REG[platform].capabilities.join('/')}）`);
    return { tasks: [], needsConfirm: true, questions: [`${REG[platform].label} 做不了「${taskType}」，要换平台吗？`], warnings };
  }

  // 4) goal 抽取（学时/门数/百分比）
  const goal = extractGoal(input, REG[platform]);

  // 5) 组装
  const task = {
    id: `t_${dateStamp()}_${platform.slice(0,2)}${seq()}`,
    createdAt: new Date().toISOString(),
    source: 'nl',
    rawInput: input,
    confidence,
    platform,
    taskType,
    target: { scope: 'all', category: null, course: null, goal },
    constraints: {
      rate: 2,
      maxParallel: REG[platform].constraints.maxParallel ?? 1,
      windowStart: null, windowEnd: null, deadline: null,
    },
    auth: { accountRef: `${platform}-main`, mode: 'auto', onCaptcha: 'pause' },
    deliverable: {
      evidenceDir: `runs/orders/${platform}-${ymd()}/`,
      reportPath: `runs/orders/${platform}-${ymd()}/03_验收报告.md`,
      screenshots: true,
    },
    state: 'queued',
    stateHistory: [{ at: new Date().toISOString(), from: null, to: 'queued', by: 'nl-dispatch' }],
    progress: { startedAt: null, updatedAt: null, metric: goal, current: null },
    result: { ok: null, achieved: null, evidence: [], notes: '', blockedReason: null },
    driver: { script: REG[platform].driver.script, pid: null, args: [] },
  };

  if (!opts.dryRun) {
    mkdirSync(TASKS_DIR, { recursive: true });
    writeFileSync(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  return { tasks: [task], needsConfirm: confidence < 0.7, questions: [], warnings };
}

// ── 占位实现（要补）──────────────────────────────
async function llmPickPlatform(input) { /* TODO: 用统一 LLM 调用，返回 registry key */ }
async function llmClassify(input, caps) { /* TODO: 返回 {type, confidence} */ }
function extractGoal(input, reg) {
  // "刷完 90 学时" → {kind:'credit', value:90, unit:'学时'}
  // "把这门课看完" → {kind:'finish'}
  // 默认：用平台 completion 里声明的目标总和
  /* TODO */
}

// ── CLI ─────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv.slice(2).join(' ');
  const r = await dispatch(input, {}, { dryRun: process.argv.includes('--dry') });
  console.log(JSON.stringify(r, null, 2));
}
```

### 设计要点
- **规则优先**：常见说法（"刷课"/"交作业"）命中就不花 token
- **能力校验**：`capabilities` 不匹配 → **拒绝派单**，不是跑起来才发现做不了
- **`rawInput` 存原文** → 判错了能重判
- **`--dry`** 只判型不落盘 → 调试友好

---

## 4. ② `scripts/orchestrator.mjs` —— 任务单 → 执行 → 验收

### 接口

```js
/**
 * 主循环：每次 tick 扫一遍队列，推进能推进的任务。
 * @param {object} [opts]
 * @param {number} [opts.interval]   tick 间隔（默认 30s）
 * @param {boolean} [opts.once]      只跑一轮（debug）
 */
export async function run(opts = {}) { ... }

/** 提交一个任务（api/agent 调用入口） */
export async function submit(task) { ... }

/** 查询：单个 / 列表 / 汇总 */
export async function get(taskId) { ... }
export async function list({ state, platform } = {}) { ... }
export async function summary() { ... }

/** 人工干预 */
export async function pause(taskId, reason) { ... }
export async function resume(taskId) { ... }
export async function cancel(taskId, reason) { ... }
export async function confirm(taskId) { ... }   // needsConfirm 的任务被人工确认后
```

### 骨架

```js
#!/usr/bin/env node
// scripts/orchestrator.mjs
// 唯一的"大脑"：读队列 → 排班 → 起驱动 → 盯进度 → 验收 → 收尾。
// ★ 单一写者：只有它改 task.state。

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = ...;
const REG = JSON.parse(readFileSync(join(ROOT,'config/platforms.json'),'utf8'));
const TASKS_DIR = join(ROOT,'runs/tasks');
const LOCK_DIR  = join(ROOT,'runs/locks');     // 每平台一把锁（singleton 平台用）

// ── 平台占用表：platform → { taskId, pid } ─────────────
const OCCUPIED = new Map();

export async function run({ interval = 30, once = false } = {}) {
  for (;;) {
    const tasks = loadAll();

    for (const t of tasks) {
      try { await tick(t); } catch (e) { log(`[${t.id}] tick 异常: ${e.message}`); }
    }

    if (once) return;
    await sleep(interval * 1000);
  }
}

async function tick(t) {
  switch (t.state) {

    // ── 排队 → 该不该现在跑 ──────────────────────────
    case 'queued': {
      if (t.needsConfirm && !t.confirmed) return;             // 等人确认
      if (!inWindow(t)) return;                                // 时间窗
      if (!slotFree(t)) return;                                // 平台被占（singleton）
      await setState(t, 'authing', 'orchestrator');
      return;
    }

    // ── 登录 ─────────────────────────────────────
    case 'authing': {
      const r = await authEnsure(t);                           // ③ 的入口
      if (r.ok) { await setState(t, 'running', 'orchestrator', { progress: { startedAt: now() } }); startDriver(t); }
      else if (r.blocked) { await setState(t, 'blocked', 'orchestrator', { result: { blockedReason: r.reason } }); }
      else { await backoff(t, r.reason); }                     // 可重试的错误
      return;
    }

    // ── 运行中 → 盯进度 ──────────────────────────────
    case 'running': {
      const alive = driverAlive(t);
      const prog = await readProgress(t);                      // 从 registry.completion 的口径读

      t.progress.metric.now = prog.now;
      t.progress.current = prog.current;
      t.progress.updatedAt = now();

      // 目标达成？
      if (reachedGoal(t, prog)) { stopDriver(t); await setState(t, 'verifying', 'orchestrator'); return; }

      // 死了但没达成 → 重启（带退避）
      if (!alive) {
        t.restarts = (t.restarts || 0) + 1;
        if (t.restarts > 5) { await setState(t, 'failed', 'orchestrator', { result: { ok: false, notes: '驱动连续 5 次退出' } }); return; }
        log(`[${t.id}] 驱动不在 → 第 ${t.restarts} 次拉起`);
        startDriver(t);
        return;
      }

      // 卡住检测（判据来自 registry，不是硬编码）
      if (prog.now === t.lastNow && Date.now() - (t.lastChangeAt || 0) > STALL_MS) {
        await setState(t, 'paused', 'orchestrator');
        await heal(t);                                          // 清表/重启/reload
        await setState(t, 'running', 'orchestrator');
      }
      if (prog.now !== t.lastNow) { t.lastNow = prog.now; t.lastChangeAt = Date.now(); }

      persist(t);
      return;
    }

    // ── 验收 ─────────────────────────────────────
    case 'verifying': {
      const ok = await verify(t);                               // ★ 只认平台口径
      await setState(t, ok ? 'done' : 'failed', 'orchestrator', {
        result: { ok, achieved: t.progress.metric.now, evidence: await collectEvidence(t) },
      });
      return;
    }

    // ── 终态不动 ────────────────────────────────
    default: return;
  }
}

// ── 排班 ────────────────────────────────────────
function slotFree(t) {
  const reg = REG[t.platform];
  if (!reg.driver.singleton) return true;
  return !OCCUPIED.has(t.platform);
}

// ── 起驱动（复用现有脚本，不改它们）──────────────────
function startDriver(t) {
  const reg = REG[t.platform];
  const args = reg.driver.args.map(a => a.replace('{cdp}', reg.cdp));
  const p = spawn(process.execPath, [join(ROOT,'scripts',reg.driver.script), ...args], {
    cwd: ROOT, windowsHide: true, stdio: 'ignore', detached: true,
  });
  p.unref();
  t.driver.pid = p.pid;
  OCCUPIED.set(t.platform, { taskId: t.id, pid: p.pid });
  persist(t);
}

// ── 自愈（复用现有手段）──────────────────────────
async function heal(t) {
  const reg = REG[t.platform];
  // 1) 清僵尸状态表（各平台自己的坑，写在 registry.heal 里）
  for (const f of (reg.heal?.resetOn === 'stall' ? ['runs/cc-skip.json','runs/cc-claim.json'] : [])) {
    writeFileSync(join(ROOT, f), f.endsWith('skip.json') ? '[]' : '{}');
  }
  // 2) 重启驱动
  stopDriver(t); startDriver(t);
}

// ── 验收（只认平台口径）────────────────────────────
async function verify(t) {
  const reg = REG[t.platform];
  // 用 completion 的口径重读一次页面（不信驱动自己的计数）
  const now = await readProgress(t);
  const goal = t.progress.metric.goal;
  return now.now >= goal;
}
```

### 设计要点
- **单一写者**：只有 orchestrator 改 `state` → 无竞态
- **平台锁**：`singleton` 平台靠 `OCCUPIED` 表 + `runs/locks/` 双重保险（423 事故的根治）
- **能力/约束全从 registry 读** → 加平台不改代码
- **验收不信驱动**：用 `registry.completion` 的口径**重新读页面**
- **heal() 的参数也来自 registry**（哪个平台卡了该清什么表）

---

## 5. ③ `scripts/auth.mjs` —— 账号池 + 自动登录 + 保活

### 接口

```js
/** 确保某平台的会话可用。幂等：已登录就直接返回 ok。 */
export async function ensure(task) { ... }        // → { ok, blocked?, reason?, account? }

/** 只探测登录态，不登录 */
export async function probe(platform) { ... }     // → { loggedIn, who?, url }

/** 主动登录（填表 / 复用 cookie / 通知人工） */
export async function login(platform, accountRef, opts = {}) { ... }

/** 保活：定时探测，快过期就续（长时间任务用） */
export async function keepAlive(platform, { every = 600 } = {}) { ... }

/** 账号池管理 */
export async function listAccounts(platform) { ... }
export async function addAccount(platform, { user, secretRef, note }) { ... }
```

### 骨架

```js
#!/usr/bin/env node
// scripts/auth.mjs
// 三层策略：reuse（现有 cookie）→ auto（自动填表）→ manual（通知人工）

import { readFileSync } from 'node:fs';
import { cdpEval, cdpNav } from './cdp.mjs';

export async function ensure(task) {
  const reg = REG[task.platform];
  const mode = task.auth.mode;          // auto | manual | reuse

  // ① 先探：已经登录就不折腾
  const p = await probe(task.platform);
  if (p.loggedIn) return { ok: true, account: p.who };

  // ② reuse 模式：不登录，直接报没登录
  if (mode === 'reuse') return { ok: false, reason: '需要登录但 mode=reuse' };

  // ③ 平台声明了验证码 → 按 onCaptcha 决定
  if (reg.auth.captcha !== 'none' && task.auth.onCaptcha === 'pause') {
    await notifyHuman(task, `需要人工过${reg.auth.captcha}验证`);
    return { ok: false, blocked: true, reason: `captcha:${reg.auth.captcha}` };
  }

  // ④ auto：有字段配置就填表，没有就只打开登录页等人
  if (reg.auth.fields) {
    const acct = await getAccount(task.auth.accountRef);
    const r = await fillLogin(task.platform, acct);
    if (!r.ok) return { ok: false, reason: r.reason };
    await sleep(3000);
    return await probe(task.platform).then(x => x.loggedIn ? { ok: true } : { ok: false, reason: '填表后仍未登录' });
  }

  // ⑤ 兜底：开登录页 + 等（最多 N 分钟）
  await cdpNav(reg.cdp, reg.auth.loginUrl);
  const ok = await waitLogin(reg, 180);
  return ok ? { ok: true } : { ok: false, blocked: true, reason: '等待人工登录超时' };
}

export async function probe(platform) {
  const reg = REG[platform];
  const url = await cdpEval(reg.cdp, 'location.href');
  const loggedIn = await cdpEval(reg.cdp, `!!(${reg.auth.probe})`);
  const who = loggedIn ? await cdpEval(reg.cdp, '(document.body.innerText.match(/[\\u4e00-\\u9fa5]{2,4}(?=\\s*学号)/)||[])[0]||null') : null;
  return { loggedIn, who, url };
}

// ── 账号池：只存引用，不存明文 ────────────────────────
// config/accounts.json（gitignored）
// { "cc-main": { "platform":"ccjyxy", "user":"186****1157", "secretRef":"env:CC_PASS" } }
// secretRef 支持：env:VAR | file:path | wincred:target
```

### 设计要点
- **三层降级**：reuse → auto → manual，**每层都有明确出口**
- **不存明文**：账号池只存 `secretRef`（`env:` / `file:` / `wincred:`）
- **`auth.probe` 是机器判据**（页面内 JS），不是"看起来像"
- **`keepAlive`** 解决"跑 10 小时后 cookie 过期"（现在的痛点）
- **验证码**：按 `onCaptcha` 决定 **暂停等人** 还是 **直接失败** —— 不假装能过

---

## 6. 三者怎么串起来

```
用户: "帮我把长春那 90 学时刷完"
   │
   ├─ ① nl-dispatch.mjs
   │    规则命中"刷...学时" → type=video
   │    别名命中"长春"     → platform=ccjyxy
   │    capabilities 校验  → ccjyxy 支持 video ✓
   │    goal 抽取           → {kind:'credit', value:90}
   │    → 写 runs/tasks/t_xxx.json (state=queued)
   │
   ├─ ② orchestrator.mjs（每 30s tick）
   │    queued → slotFree? yes → authing
   │    authing → ③ ensure()
   │                  probe → 已登录 ✓
   │              → running
   │    running → startDriver() 起 cc-cycle.mjs
   │              每 tick 读平台学时 → 更新 progress
   │              达成 90 → verifying
   │    verifying → 用 completion 口径重读 → done
   │              → 写 03_验收报告.md + 截图
   │
   └─ ③ auth.mjs
         probe/ensure/keepAlive —— 只被 ② 调用
```

**职责边界**
```
nl-dispatch  : 只判型，不执行、不碰浏览器
orchestrator : 只排班/监控/验收，不判型、不登录
auth         : 只登录/探测，不排班、不执行任务
```
**三层互相不 import**（只 import 公共的 `cdp.mjs` / `llm.mjs` / `registry.mjs`）→ 可单独测、可单独替换。

---

## 7. 落地顺序（建议）

| 阶段 | 做什么 | 能不能验证 |
|---|---|---|
| **P0** | 抽 `config/platforms.json`（把 supervisor 硬编码搬出来）+ `registry.mjs` 读取器 | ✅ 跑起来行为不变 |
| **P1** | `orchestrator.mjs` 接管 supervisor 的平台部分（先只支持 video） | ✅ 长春跑一轮 |
| **P2** | `nl-dispatch.mjs` + `--dry` 调试 | ✅ 给 10 句话看判型对不对 |
| **P3** | `auth.mjs` 的 `probe`（只探测，不登录） | ✅ 各平台探一遍 |
| **P4** | `auth.mjs` 的 `login`（先只做长春的持久 profile 复用） | ✅ 手动登出后测自动恢复 |
| **P5** | 补 LLM 调用（`llm.mjs` 统一）| ✅ 生僻说法也能判 |

**P0 是最值钱的一步** —— 不改任何行为，但把"加平台要改代码"变成"加一个 JSON 块"。**这一步做完，开源项目的"框架感"就立住了。**

---

## 8. 明确不做的（避免过度设计）

| 不做 | 原因 |
|---|---|
| 通用浏览器 Agent（能操作任何网站） | 那是另一个产品；本项目只做**网课域**，靠 registry 的 `capabilities` 收敛 |
| 自动过验证码（OCR/打码平台） | 能力边界写清楚（`onCaptcha: pause`），**不假装能过** |
| 多账号并发抢同一平台 | 平台单会话硬保护（423），并发必废 |
| 自动注册账号 | 自建账号不算成果，也没意义 |
| 分布式（多机多进程） | 单机够用，分布式只会增加故障面 |

---

## 附：与现有代码的复用关系（**一行都不浪费**）

```
nl-dispatch  ── 新
orchestrator ── 新（替代 supervisor 的平台调度部分；supervisor 保留做"系统级体检"）
auth         ── 新（现有 captureLogin() 只观测，升级成决策）

复用：
  userscript/App.js 的 6 个 ADAPTER_*        ← 不动
  scripts/cc-auto.mjs / cc-cycle.mjs         ← 不动（orchestrator 只是 spawn 它们）
  scripts/cx-auto.mjs / ss-watch.mjs         ← 不动
  scripts/nc.mjs（CDP 入口）                  ← 不动，auth/orchestrator 都用它
  scripts/supervisor.mjs                     ← 保留，降级为"进程/隧道体检"，不再管平台排班
  scripts/cc-watch.mjs / progress-report.mjs ← 不动
  四层守护的判据与自愈手段                     ← 全部复用（heal() 调用它们）
```
