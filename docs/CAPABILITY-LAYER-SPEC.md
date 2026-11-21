# 能力补全层开发规格（CAPABILITY-LAYER-SPEC）

> 状态：待开发
> 基线：`config/platforms.json` 2026-10-19 版 / 8 个平台 / `scripts/` 68 个文件
> 本文档是**开发规格**，不是现状说明。第 1 章是现状取证，第 3 章起是要建的东西。
> 拿这份文档去开发的人：先读第 0 章，再读第 7 章（迁移计划），最后才回头读规格细节。

---

## 0. 一句话目标

把「加一个平台要改 3 处代码」降到「加一个平台只填 1 个 JSON 块」，方法是补一个**决策层**：
注册表里已经有防护事实（`rateMax` / `accountingMaxRate` / `maxParallel` / `hardConstraints`），
但**没有任何代码读它做决策**；真正的值硬编码在各平台驱动里，形成 4 份人肉同步的副本。

```
现在：  platforms.json（事实，无人读） ──✗──> 各驱动（硬编码常数）
目标：  platforms.json ──> plan.mjs（决策） ──> 各驱动（读 plan）──> verify.mjs（统一验收）
                                  ↑
                        detect.mjs（探测回写）
```

---

## 1. 现状取证（开发前必须先复现这三条）

### 1.1 事实库：完备

`config/platforms.json` 705 行，8 个平台，每块含
`capabilities` / `driver` / `watchers` / `categories` / `completion` / `constraints` / `auth` / `heal`。
华医网一块就有 20 条 `hardConstraints`，全部带实测日期。

### 1.2 决策层：不存在（决定性证据）

```powershell
cd D:\Vibe\NetClass
Get-ChildItem -Recurse -File -Include *.mjs,*.js,*.ps1,*.json |
  Select-String 'accountingMaxRate|rateMax' |
  Where-Object { $_.Path -notlike '*platforms.json' }
```

输出（去掉 md 文档）：

```
scripts/registry.mjs:385     ← 唯一一处，而且是格式校验：Number.isFinite(...)
```

**即：注册表只检查它是不是数字，没有任何代码拿它做决策。**

真实生效的值硬编码在各驱动里：

| 文件 | 行 | 硬编码 | config 声明 | 一致性 |
|---|---|---|---|---|
| `scripts/cc-auto.mjs` | 159 | `if (s.video.rate < 1.2)` → 目标 1.25 | `accountingMaxRate: 1.25` | 巧合相同 |
| `scripts/huayi-watch.mjs` | 156 | `v.playbackRate = 1` | `rateMax: 1` | 巧合相同 |
| `scripts/cx-rate.js` | — | 1.499 | `rateMax: 1.5` | 巧合相同 |
| `userscript/App.js` | `PLATFORM_RATES` | `ccjyxy:[1,1.25,1.5,2]` | `rateMax: 2` | 巧合相同 |

四份副本，改 config 不改变任何行为。`maxParallel` 稍好：`nl-dispatch.mjs:249` 与
`orchestrator.mjs:358` 会读它，但**只是透传成 task.constraints，没有编排器真按它扩实例**。

### 1.3 加平台流程：没闭环

`node scripts/registry.mjs validate` 当前输出：

```
注册表校验：❌ 失败  (ok=false, errors=4)
  ✗ [huayi] watchers[0].args 必须是数组
  ✗ [huayi] watchers[0].script 缺失
  ✗ [huayi] completion.kind 非法：videoEnd（合法：pageText/api/domClass/domAbsent）
  ✗ [huayi] auth.probe 字段缺失（没有就写 null）
```

华医网是**最近接入、最难接入**的一个平台，README 级的 20 条约束都写了、驱动也跑通了，
但**没跑 validate**。说明「加完平台 → 跑校验 → 修到 0 error」这一步目前靠人记，不是流程。

### 1.4 平台表还漏了一个

`scripts/smartedu-course.mjs` / `smartedu-batch.mjs` 打的域名是
`x-study-record-api.ykt.eduyun.cn`（智慧中小学），而 `platforms.json` 里的
`smartedu` 是 **青海智慧教育** `basic.qh.smartedu.cn` —— **两个不同的站点**。
前者有 4 个脚本、跑通过真实订单（15 秒记 1067 秒那个），却**没有 registry 块**。
这是「脚本先行、注册表后补」的典型遗留，P1 要补。

---

## 2. 问题定义：把「防护等级」变成可计算的

平台的验证不是一根标尺，是**四个独立维度**。随机加强某一维不会让其它维变难，
所以「这站难不难」这个问法本身没有可操作性；可操作的是**逐维定级**。

### 2.1 四维分级

| 维度 | 代号 | 分级 | 含义 |
|---|---|---|---|
| 记账模型 | **L** | L0 纯客户端声明 / L1 绝对位置制 / L2 时长制（服务端钳位）/ L3 tick+窗口 / L4 结算制 | 服务端到底信什么 |
| 放行约束 | **R** | R0 无 / R1 前端顺序 / R2 倍速软上限 / R3 倍速硬杀 / R4 单会话单路 | 允许多快、几路、能不能跳 |
| 检测强度 | **C** | C0 无 / C1 原生函数指纹 / C2 合成事件 / C3 行为一致性 / C4 多特征组合 / C5 设备指纹与会话绑定 | 检测不检测「你不是人 / 被注入」 |
| 身份准入 | **A** | A0 账号密码 / A1 静态图形码 / A2 会话绑定图形码 / A3 短信码 / A4 人脸 / A5 双层 SSO + 会话内鉴权 | 登录与提交的可信链路有多长 |

### 2.2 八个平台（+1 未注册）现在落在哪一格

| 平台 key | L | R | 并行 | C | A | 判据来源 |
|---|---|---|---|---|---|---|
| `smartedu`（青海） | L2+L4：`addStudyDuration {id, studyDuration:60}` 累计秒数、后端异步分账，滞后 5–8 分钟 | 自适应 1.0–2.0（受媒体栈瓶颈） | 1 | C0 | A0（Ant Design，必须真鼠标点焦点） | `platforms.json` smartedu.hardConstraints |
| `smartedu`（eduyun **未注册**） | **L0 + L1**：`POST /v1/study_details` 客户端报 progress/status；`PUT resource_learning_positions` 存绝对 position | — | — | C0 | — | `scripts/smartedu-course.mjs:6-17` |
| `ccjyxy` | L2 时长制（设 927s，服务端只收 296→536） | **R3** 记账硬卡 1.25（播 2x 只记 1.25x） | **R4** 第二标签 423 Locked | C2 近似：MUI/React 不吃合成 click | A0 持久 profile | `platforms.json` ccjyxy.constraints |
| `chaoxing` | L2/L4 任务点（`span.roundpoint.blue`） | R2 上限 1.5（ratechange 同 tick 写回 1x） | 1 | **C1 变体**：禁 `Emulation.setDeviceMetricsOverride`（改指纹触发 `detect.chaoxing.com` 风控） | A1 图形码；字段 `#phone/#pwd/#loginBtn` | `platforms.json` chaoxing.constraints |
| `shengsheng` | L4 结算（`domAbsent`：连续 10 轮无 `<video>` 判学完） | R2 上限 1.5（属性可设 8x，但吞吐 6x 封顶更慢） | **2（实测可并行）** | C0 | A0 持久 profile | `platforms.json` shengsheng.constraints |
| `zhihuishu` | **L1 位置制 + 累加**（`studyTotalTime` 330→657；`watchState===1` 判完成，DOM 的 ✓ 全是装饰） | R2 三档 1/1.25/1.5，**必须走站点 UI** | 1 | **C4**：`isNative(XHR.open)` + `!e.isTrusted` + `window.OCS` 黑名单；命中 3 秒踢回门户 | A1（当前登录态已丢） | `App.js:188-276`、`skills/.../platforms.md` |
| `qiyang` | L1（`isEnd` / `current_time`；站点自己每 300s / 拖动>60s / 播完上报） | R2 2x | 1 | C0 | A0 | `platforms.json` qiyang |
| `webtrn` | L4（成绩构成 40/40/20/20） | — | 1 | C0 | A1（图形码默认隐藏） | `platforms.json` webtrn |
| `huayi` | **L3 tick+窗口**：`(playTime+10) >= playTotalTime` 那一个 tick 才 `SaveLearningTime` | **R3 硬杀**：1.25x 即 `video` 元素销毁 | **R4** 同账号第二播放页被掐 | **C3**：`ratechange` → 三个 0x0 隐藏 iframe 上报 → 播放器自杀；+ C1 隐藏校验 iframe | **A2 + A4 + A5**：会话绑定图形码、结束人脸（`endFace==1` 则不保存）、双层 SSO（整页导航必踢） | `platforms.json` huayi.constraints（20 条） |

**这张表就是 P1 要落进 `profile` 块的内容。** 不许新造事实：每个格子必须能指回上表的来源。

### 2.3 现状的覆盖度（诚实版）

| 已验证 | 平台 |
|---|---|
| L0 | eduyun 智慧中小学 |
| L1 | eduyun、zhihuishu（累加式）、qiyang |
| L2 | ccjyxy、chaoxing、smartedu（青海） |
| L3 | huayi（唯一） |
| L4 | shengsheng、chaoxing、webtrn、smartedu |
| C1–C2 | zhihuishu、ccjyxy、chaoxing |
| C3 | huayi |
| C4 | zhihuishu（唯一） |
| A1 | chaoxing、webtrn、zhihuishu |
| A2 | huayi（唯一） |
| A4 | huayi（未处理，仅识别） |
| A5 | huayi（唯一） |

**没覆盖的**：L3 变体（tick 间隔方差校验、随机窗口）、C5（设备/指纹绑定）、A3 短信自动过、多人脸比对。
样本是「经历过的」，不是「枚举过的」。因此本规格的目标**不是**造一个万能的策略生成器，
而是：**把已知事实变成机器可读、可计算、可自动迁移的形状**；没遇到过的等级由 `detect.mjs` 去发现并在数据层留位。

---

## 3. 目标架构

```
                    ┌──────────────────────────────┐
                    │ config/platforms.json        │
                    │  ├ profile.*      ← 新增     │  防护事实（四维定级）
                    │  ├ constraints.*  ← 保留     │  旧字段，兼容
                    │  ├ completion.*   ← 扩展     │  判据
                    │  └ auth.*         ← 扩展     │  准入
                    └──────────┬───────────────────┘
                               │ registry.mjs（读 + 校验）
                               ▼
                    ┌──────────────────────────────┐
                    │ scripts/plan.mjs   ← 新增     │
                    │  纯函数：profile → 策略       │
                    └──────────┬───────────────────┘
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        cc-auto.mjs      huayi-watch.mjs    xx-auto.mjs
        （改 3 行）        （改 2 行）        （新平台只读 plan）
              │                │                │
              └────────────────┼────────────────┘
                               ▼
                    ┌──────────────────────────────┐
                    │ scripts/verify.mjs  ← 新增    │
                    │  5 种 completion.kind 适配器   │
                    └──────────┬───────────────────┘
                               ▼
                    progress-report.mjs / supervisor.mjs
                               ▲
                    ┌──────────┴───────────────────┐
                    │ scripts/detect.mjs  ← 新增    │
                    │  探针 → 回写 profile           │
                    └──────────────────────────────┘
```

### 3.1 新增文件清单

| 文件 | 行数量级 | 职责 |
|---|---|---|
| `scripts/plan.mjs` | ~200 | 决策器。纯函数，不碰浏览器、不读 runs/、不写任何东西 |
| `scripts/detect.mjs` | ~300 | 探测器。跑探针，产出 profile 建议值；`--write` 才回写 config |
| `scripts/verify.mjs` | ~250 | 统一验收。5 种 kind 的适配器，全部返回 `{done,total,pct,evidence[]}` |
| `scripts/profile-schema.mjs` | ~120 | profile 块的枚举与校验（供 registry.mjs 调用，避免 registry 膨胀） |

### 3.2 改动文件清单

| 文件 | 改动 | 风险 |
|---|---|---|
| `config/platforms.json` | 8 块各加 `profile`；修 4 个 huayi 错误；新增 eduyun 块 | 低（纯数据） |
| `scripts/registry.mjs` | `COMPLETION_KINDS` 加 `videoEnd`；`CAPABILITIES` 加 `live_replay`；`validate()` 加 profile 检查 | 低 |
| `scripts/cc-auto.mjs` | 行 159 的 `1.2` → `plan.rate` | **中**（在跑） |
| `scripts/huayi-watch.mjs` | 行 156 的 `1` → `plan.rate` | **中**（在跑） |
| `scripts/cx-rate.js` | 1.499 → 由 plan 注入 | **中**（在跑） |
| `scripts/progress-report.mjs` | 内部改调 `verify.mjs`（行为不变，输出结构不变） | 低 |

---

## 4. 数据契约：`platforms.json` 的 `profile` 块

### 4.1 完整形状

```jsonc
"profile": {
  "accounting": {
    "model": "position",              // position | watchtime | tick | settle
    "seekOk": true,                   // 能不能靠 seek 推进
    "seekTarget": "duration-15",      // duration-15 | duration-90 | null
    "naturalPlay": true,              // 是否需要自然播完（L3 必需）
    "settleLagSec": 0,                // 服务端记账滞后（青海实测 5-8 分钟 = 300-480）
    "verified": "2026-10-23"
  },
  "rate": {
    "declaredMax": 1.5,               // 站点 UI 允许的最高档
    "accountingMax": 1.25,            // 记账真正认的最高档
    "hardKill": false,                // 超速是否杀播放器
    "rateTable": [1, 1.25, 1.5]       // 站点档位表（空 = 由 detect 探）
  },
  "detect": {
    "level": "C4",                    // C0..C5
    "probes": ["xhr-open-native", "isTrusted", "plugin-blacklist"],
    "inject": "minimal",              // full | minimal | cdp-only
    "kickDelaySec": 3,                // 命中后多久被踢（用于判断是否已被判）
    "verified": "2026-10-15"
  },
  "access": {
    "captcha": "session-bound",       // none | image | session-bound | sms | face
    "sso": "double",                  // single | double
    "navOrder": ["ProjectList", "point:进入", "ExerciseHome/index", "new:CoursePlay"],
    "faceOnFinish": true,
    "verified": "2026-10-23"
  }
}
```

### 4.2 字段级说明

| 路径 | 类型 | 枚举 / 缺省 | 谁消费 |
|---|---|---|---|
| `accounting.model` | enum | `position`（缺省）；`watchtime` / `tick` / `settle` | `plan.mjs` |
| `accounting.seekOk` | bool | 缺省按 model 推导 | `plan.mjs` |
| `accounting.seekTarget` | string\|null | `duration-15` / `duration-90` / `null` | `plan.mjs` → 驱动 |
| `accounting.naturalPlay` | bool | `true` for tick | `plan.mjs` |
| `accounting.settleLagSec` | number | `0` | `verify.mjs`（决定轮询等待） |
| `rate.declaredMax` | number | 必填 | `plan.mjs` |
| `rate.accountingMax` | number\|null | 缺省 = declaredMax | `plan.mjs` |
| `rate.hardKill` | bool | `false` | `plan.mjs`（true 则 rate 强制 1） |
| `rate.rateTable` | number[] | `[]` | `App.js` 的 `PLATFORM_RATES`（P3 改为读它） |
| `detect.level` | enum | `C0` | `plan.mjs`（决定 inject / click） |
| `detect.probes` | string[] | `[]` | `detect.mjs`（只跑登记过的） |
| `detect.inject` | enum | `full` | 各驱动的注入路径 |
| `detect.kickDelaySec` | number | `0` | `detect.mjs`（等多久才判定"被踢"） |
| `access.captcha` | enum | 必填 | `plan.mjs`（决定 blockers）、`auth.mjs` |
| `access.sso` | enum | `single` | 驱动（导航顺序） |
| `access.navOrder` | string[] | `[]` | 驱动（`new:` 前缀 = 开新标签，`point:` = 真鼠标点文字） |
| `access.faceOnFinish` | bool | `false` | `plan.mjs`（进 blockers） |

### 4.3 兼容与优先级

- `constraints.*` **保留原样，不改不删**。`profile` 是语义层，`constraints` 是历史事实层。
- 两者冲突时 **`profile` 优先**，且 `registry.validate()` 报一条 warning 说明冲突值。
- `constraints.hardConstraints[]` 里的自由文本**不动**，它是病历，不是配置。
- 缺 `profile` 的平台：`plan.mjs` 退化为读 `constraints`（`rateMax` / `accountingMaxRate` / `maxParallel`），
  并在输出里标 `"confidence": "legacy"`。**这样 P1 可以分平台灰度，不需要一次全填。**

---

## 5. 模块规格

### 5.1 `scripts/profile-schema.mjs`

```js
export const ACCOUNTING_MODELS = ['position', 'watchtime', 'tick', 'settle'];
export const DETECT_LEVELS     = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5'];
export const INJECT_MODES      = ['full', 'minimal', 'cdp-only'];
export const CAPTCHA_KINDS     = ['none', 'image', 'session-bound', 'sms', 'face'];
export const SSO_MODES         = ['single', 'double'];
export const PROBE_IDS = [
  'plugin-blacklist',     // passive：静态搜页面 JS 里的 window.XXX 判据
  'xhr-open-native',      // active ：包 open vs 不包，A/B 看是否被踢
  'isTrusted',            // active ：合成 click 探针，看是否弹窗/跳转
  'rate-ladder',          // active ：复用 test-rate-ladder.mjs
  'seek-readback',        // active ：设末尾后抓上报体，看服务端是否钳位
];

/** 校验一块 profile；返回 {errors[], warnings[]}。缺 profile 不算错（legacy 兼容）。 */
export function validateProfile(key, profile, legacyConstraints) { ... }
```

**约束**：`registry.mjs` 只 import 本文件，不自己长枚举。

### 5.2 `scripts/plan.mjs` —— 决策器（本规格的核心）

#### 输入 / 输出

```bash
node scripts/plan.mjs --platform huayi          # 单个
node scripts/plan.mjs --all                     # 8 行表
node scripts/plan.mjs --platform ccjyxy --json   # 机器可读
node scripts/plan.mjs --platform huayi --duration 20664
```

```jsonc
{
  "platform": "huayi",
  "cdp": 9231,
  "confidence": "verified",          // verified | legacy | unverified
  "model": "tick",
  "rate": 1,
  "rateCandidates": [1],
  "parallel": 1,
  "inject": "cdp-only",
  "click": "cdp",
  "seek": { "ok": true, "target": "duration-90", "naturalPlay": true, "tailWaitSec": 100 },
  "settleLagSec": 0,
  "clickMode": "cdp",
  "navOrder": ["ProjectList", "point:进入", "ExerciseHome/index", "new:CoursePlay"],
  "wallClockSec": 20764,
  "blockers": [
    { "code": "captcha-session-bound", "need": "human", "why": "每次会话一条新码，自动化只能读到图，读不了真值" },
    { "code": "face-on-finish", "need": "human", "why": "endFace==1 时站点改为 LoadQrCode()，不保存学时" }
  ],
  "warnings": []
}
```

#### 决策规则（纯查表 + 算术，**不含 LLM、不含网络**）

```
── rate ─────────────────────────────────
rate = min(
  rate.declaredMax,
  rate.accountingMax ?? rate.declaredMax,
  rate.hardKill ? 1 : +∞
)

── parallel ─────────────────────────────
parallel = constraints.maxParallel ?? 1
if (parallel > 1 && access.captcha === 'session-bound')
    warnings += '多路需要多账号 + 多 profile，session-bound 验证码使自动登录成本上升'

── accounting / seek ────────────────────
switch (accounting.model) {
  case 'position':  seek = { ok: true,  target: 'duration-15', naturalPlay: false, tailWaitSec: 15 }
  case 'watchtime': seek = { ok: false, target: null,          naturalPlay: true,  tailWaitSec: 0 }
  case 'tick':      seek = { ok: true,  target: 'duration-90', naturalPlay: true,  tailWaitSec: 100 }
  case 'settle':    seek = 按上面任一种；额外 verifyAtEnd = true
}
// 手工覆盖优先：accounting.seekOk / seekTarget 有值时以它为准

── inject（检测强度 → 注入方式）──────────
level C0..C2  → 'full'      // 可包 XHR/fetch + 挂面板
level C3      → 'minimal'   // 只包 XHR.prototype.send，不挂面板，不伪装 toString
level C4..C5  → 'cdp-only'  // 完全不注入；页面态一律 Runtime.evaluate 拉

── click ────────────────────────────────
probes 含 'isTrusted'  → 'cdp'（Input.dispatchMouseEvent）
否则                    → 'dom'（el.click() 可用）

── blockers（人工介入点，必须显式列出）──
captcha === 'sms'            → { code:'captcha-sms',            need:'human' }
captcha === 'face'           → { code:'captcha-face',           need:'human' }
access.faceOnFinish === true → { code:'face-on-finish',         need:'human' }
access.sso === 'double'      → { code:'sso-double', need:'auto', why:'必须按 navOrder，整页导航必丢鉴权' }
detect.level === 'C4'|'C5'   → { code:'detect-high', need:'auto', why:'注入降级为 cdp-only' }

── wallClock ────────────────────────────
content = --duration ?? (driver 侧传入)
wallClockSec = seek.ok && model === 'position'
             ? tailWaitSec                                  // 十几秒
             : content / rate / parallel + tailWaitSec + settleLagSec
```

#### 硬性要求

1. **纯函数**：不 `fetch`、不 `readFile`（除 registry）、不写文件、不读 `runs/`、不起浏览器。
2. **可单测**：`scripts/plan.selftest.mjs`，用 8 个平台的 profile 做 fixture，断言输出表与
   本文档 §5.2 的规则表逐字段一致。**没有 selftest 不算完成。**
3. **不猜**：`profile` 缺失的字段一律回落 `constraints` 或报 warning，**不许填默认值冒充事实**。

### 5.3 `scripts/detect.mjs` —— 探测闭环

#### 探针分级（默认只跑 passive）

| probe | 等级 | 风险 | 做法 | 写回字段 |
|---|---|---|---|---|
| `plugin-blacklist` | passive | 无 | `Runtime.evaluate` 拉页面内联 JS 文本，正则搜 `window.OCS` / `window.XXX` 式判据；**不发请求、不改页面** | `detect.level` 下限、`detect.probes` |
| `xhr-open-native` | active | 中（可能被踢） | 在**临时实例**里 A/B：包 `open` vs 不包，各停留 `kickDelaySec+3` 秒，看是否弹窗/跳转 | `detect.level` |
| `isTrusted` | active | 中 | 临时实例里对探针元素 `dispatchEvent(new MouseEvent(...))`，看是否弹告警/跳转 | `detect.probes` += `isTrusted` |
| `rate-ladder` | active | 低（华医网可无损恢复） | 复用 `scripts/test-rate-ladder.mjs` | `rate.declaredMax` / `rate.hardKill` |
| `seek-readback` | active | 低 | 设 `currentTime=duration-2`，抓后续上报体，比对 `position` 是原值还是被钳 | `accounting.model` / `accounting.seekOk` |

#### 硬性要求

1. **绝不碰正在跑的标签**。`detect.mjs` 必须自己 `netclass up --platform <key> --mode offscreen`
   起一个**临时实例**（新端口、新 profile 临时目录），跑完 `netclass stop`。
2. **默认不写回**。`--write` 才改 `platforms.json`，且只改它探到的字段，其余原样（保留 `verified` 日期）。
3. **单平台单次**。不要 `--all` 跑 active 探针（8 平台 × A/B × 等待 = 小时级 + 被风控）。
4. **输出建议值而非直接结论**：

```bash
node scripts/detect.mjs --platform zhihuishu --passive
# 建议：detect.level=C4  probes=['plugin-blacklist','xhr-open-native','isTrusted']  inject=minimal
# 依据：页面 JS 命中 window.OCS 判据（偏移 3 处）；XHR.prototype.open 被 isNative 检查（1 处）
# 未测：rate-ladder / seek-readback（需 --active）
```

### 5.4 `scripts/verify.mjs` —— 统一验收

```bash
node scripts/verify.mjs --platform ccjyxy            # 人读
node scripts/verify.mjs --platform ccjyxy --json     # progress-report 用
```

统一返回：

```jsonc
{ "platform":"ccjyxy", "done": 71.1, "total": 90, "pct": 79,
  "unit": "学时", "kind": "pageText", "source": "trainingPage",
  "evidence": ["已修 71.1 / 达标 90 学时"], "lagSec": 0, "verifiedAt":"2026-10-23T.."
}
```

5 种 `completion.kind` 的适配器：

| kind | 实现 | 现有分散在 |
|---|---|---|
| `pageText` | `innerText.match(pattern)`，`scope` 决定取哪个页面的正文 | `cc-lib.readCcStats`、`qh-final.mjs` |
| `api` | 调 `completion.endpoint`，对回包取 `pattern` 里的表达式 | `App.js` 的 zhihuishu 适配器、`progress-report.mjs` |
| `domClass` | `querySelectorAll(pattern)`，按 `classes.done` / `classes.todo` 计数 | `progress-report.mjs` 的 `CX_EXPR` |
| `domAbsent` | 元素不存在 = 完成（shengsheng 的 `<video>`） | `ss-watch.mjs:33-36` |
| `videoEnd` | `video.currentTime / video.duration >= 0.995` | `huayi-watch.mjs` |

**注意**：`verify.mjs` 只做**读取与判定**，不推进度。推进仍是驱动的活。
`progress-report.mjs` 改为调它之后，`runs/progress.jsonl` 的字段必须**逐字段不变**（见 §7 P5 验收）。

### 5.5 驱动消费改造

| 文件 | 现在 | 改成 |
|---|---|---|
| `cc-auto.mjs:157-160` | `const TARGET_RATE = 1.25`（近似） | `const TARGET_RATE = plan.rate` |
| `huayi-watch.mjs:156` | `v.playbackRate = 1` | `v.playbackRate = plan.rate` |
| `cx-rate.js` 注入值 | 调用方传 `1.499` | 调用方传 `plan.rate` |
| `App.js PLATFORM_RATES` | 硬编码表 | P3 之后读 `plan.rateTable`；**P1–P2 不动它** |

**兼容垫片**：驱动里统一写法，保证 `plan.mjs` 挂了也不影响在跑的单子：

```js
let PLAN;
try { PLAN = (await import('./plan.mjs')).planFor(PLATFORM_KEY); }
catch { PLAN = null; }
const RATE = PLAN?.rate ?? 1;   // 兜底回落保守值，绝不报错退出
```

---

## 6. 非目标（明确不做）

| 不做 | 理由 |
|---|---|
| 改 `userscript/App.js` 的适配器行为 | 4 个平台的订单在跑，改它是纯风险；P3 之后单独评估 |
| 把 `hardConstraints[]` 的自由文本结构化 | 它是病历，不是配置；结构化会丢信息 |
| 给 detect.mjs 加 LLM 判定 | 探针结果是确定性的；LLM 引入不可复现 |
| 一次把 8 个平台的驱动全迁完 | 灰度，一个平台一次，每步比对 `progress-report` 基线 |
| 造「任意平台自动适配」 | 本文档只解决「已知事实 → 可计算」，没见过的等级由 detect 发现并在数据层留位 |

---

## 7. 迁移计划（P0 → P5）

每阶段**独立可交付、独立可回滚**。做完一个阶段停下，跑该阶段的验收命令，贴输出，再进下一个。

### P0 · 修校验（0.5 天）

**做**：
1. `COMPLETION_KINDS` 加 `videoEnd`
2. `CAPABILITIES` 加 `live_replay`
3. `huayi.watchers[0]` 从 `{name, cmd}` 改成 `{script:'huayi-watch.mjs', args:['--ports','9231,9250','--every','30']}`
4. `huayi.auth` 补 `"probe": null`
5. 顺手：`huayi.completion` 补 `"verified": "2026-10-23"`

**验收**：
```bash
node scripts/registry.mjs validate
# 期望：✅ 通过  errors=0
# 允许保留 warning（_probeUnverified 是有意的），但要在交付说明里逐条列出
```

### P1 · 数据层（1 天）

**做**：
1. 新建 `scripts/profile-schema.mjs`
2. `registry.mjs` 的 `validate()` 接入 `validateProfile()`
3. 8 个平台各加 `profile` 块，**值只从 §2.2 的表反推**，每格带 `verified` 日期（日期用 `completion.verified` 或 `hardConstraints` 的实测日期，不许新造）
4. 新增第 9 个平台块 `eduyun`：
   - `label`: 国家中小学智慧教育
   - `host`: `basic.smartedu.cn`（**注意与青海的 `basic.qh.smartedu.cn` 是两个站**，`registry.byHost()` 的长度优先后缀匹配不会串）
   - `cdp`: **9260**（`scripts/smartedu-*.mjs` 的默认端口；registry 现有 9224–9231 未占用）
   - `capabilities`: `["video"]`；`driver.script`: `null`（现有脚本是一次性工具，产品化另议）
   - `completion`: `kind:"pageText"`，`pattern` 按 `smartedu-cards.mjs` 的角标解析；`verified` 用真实跑通日期
   - `profile`: `accounting.model:"position"` / `seekOk:true` / `seekTarget:"duration-15"` / `rate.declaredMax:2` / `detect.level:"C0"` / `access.captcha:"none"`

**验收**：
```bash
node scripts/registry.mjs validate            # errors=0
node scripts/registry.mjs show huayi | Select-String 'profile' -Context 0,20
node scripts/plan.mjs --all                   # 此时 plan 未写 → 跳过
```

**人工核对**：把 `node scripts/registry.mjs list` 的输出与 §2.2 的表逐格比对，不一致就改表（表错则文档错，以现场为准）。

### P2 · 决策器（1 天）

**做**：
1. `scripts/plan.mjs`（纯函数）
2. `scripts/plan.selftest.mjs`（8+1 个 fixture，断言规则表）
3. 不接任何驱动

**验收**：
```bash
node scripts/plan.mjs --all
# 期望：9 行表，无 undefined、无 NaN
node scripts/plan.mjs --platform huayi --json
# 期望：rate=1, parallel=1, inject='cdp-only', seek.target='duration-90', seek.tailWaitSec=100
#      blockers 含 captcha-session-bound / face-on-finish
node scripts/plan.selftest.mjs
# 期望：全部 pass
```

### P3 · 驱动接入（0.5 天/平台，灰度）

**顺序**：`cc-auto`（长春，记账 1.25 的语义最清楚）→ `huayi-watch`（1x）→ `cx-rate`（1.499）。
**每次只改一个平台**，改完：

```bash
# 改前抓基线
node scripts/progress-report.mjs --every=0 | Tee-Object runs\baseline-<key>.json
# 改后跑一轮（至少 10 分钟）
node scripts/progress-report.mjs --every=0 | Tee-Object runs\after-<key>.json
# 逐字段比对：进度数字必须一致（容差 0）
```

**失败即回滚**：`git checkout -- scripts/xx.mjs`，不需要改 config。

### P4 · 探测器（1 天）

**做**：`scripts/detect.mjs` 的 5 个探针，**先只实现 passive 的那个**（`plugin-blacklist`）并跑通；
active 四个探针只实现 `rate-ladder`（复用现成脚本，零新逻辑），其余三个留 `TODO(probe)` 并明确写原因。

**验收**：
```bash
node scripts/detect.mjs --platform zhihuishu --passive
# 期望：建议 detect.level=C4，不写回，不改 config
node scripts/detect.mjs --platform huayi --active rate-ladder
# 期望：建议 rate.declaredMax=1, rate.hardKill=true（与现有 hardConstraints 一致 → 交叉验证成功）
```

### P5 · 统一验收（1 天）

**做**：`scripts/verify.mjs` + `progress-report.mjs` 改调它。

**验收**：
```bash
node scripts/verify.mjs --platform ccjyxy --json
# 期望：{done:71.1, total:90, pct:79, unit:'学时', kind:'pageText'}
node scripts/progress-report.mjs --every=0
# 期望：runs/progress.jsonl 新行与旧行的字段集合完全一致（键名、类型、顺序不要求，集合必须一致）
```

> **2026-11-22 修订（现场 vs 本文档）**：
> `{done:71.1, total:90}` 这两个数字**来自 ccjyxy 的页面正则**
> （`completion.pattern` = `已修\s*([\d.]+)\s*/\s*达标\s*(\d+)\s*学时`），
> **不能从 `progress.jsonl` 反推**。
> JSONL 里 `cc` 的字段是 `learned` / `done` / `total`，其中：
> `learned` = 学时（`learned_score`）、`done` = **已完成课程数**（`completed_courses`）、`total` = 总课程数。
> 现场实测值是 `learned=94.4, done=68, total=90` —— 和上面的 71.1/90 不是同一维度。
> 因此：
> · `verify.mjs` 负责产出「学时口径」的 `{done,total,pct}`（读页面）；
> · `progress-report.mjs` 的 JSONL **保持原有字段不动**，只在控制台追加一行 `verify=` 判读。
> 两者不做数值对齐，也不应做。

### 2026-11-22 落地时的现场修订（本规格与现实的差异，已按现场为准）

| 规格原文 | 现场事实 | 处理 |
|---|---|---|
| §1.3「当前 errors=4」 | 实际 **errors=8**：huayi 4 条 + `smartedu-cn` 4 条（该块在本规格写完之后才新增） | P0 一并修到 0 |
| P1「新增第 9 个平台块 `eduyun`」 | 第 9 个块已经存在，名叫 `smartedu-cn`，host/cdp 与规格要求完全一致 | **保留 `smartedu-cn` 不改名**（改名会打断引用、与 platforms.md/HANDOVER 脱节）；`--all` 仍是 9 行 |
| §1.2 / §5.5「`cx-rate.js` 硬编码 1.499」 | **没有 1.499 这个字面量**：`1.499` 是实测 wallRate；真实硬编码是 `getRate()` 的默认 `1.5`，且**全仓没有任何代码写 `ncCx:rate`** | 真正的注入点在 `cx-auto.mjs`（**不在 §8 允许改的文件里**）；本次只加了 `window.__ncPlanRate` 读取通道，默认值 1.5 不动 |
| §5.2「C3 → inject=minimal」，同章输出示例与 P2 验收却是 `cdp-only` | 规格内部自相矛盾 | 取验收值，写进 `huayi.profile.detect.inject` 显式声明；`plan` 输出 warning 指出这处不一致 |
| §5.2「settle：按上面任一种」 | 没指定哪一种 | 取**保守分支**＝等同 watchtime（不可 seek、必须自然播），依据是三个 settle 平台的实测都指向「必须真播」 |
| §8 允许改 `runs/cx/cx-rate.js` | 该文件在 `runs/` 下，被 `.gitignore` 整体忽略 → **永远不进版本库**，`git checkout` 回滚不了 | 已挪到 **`scripts/cx-rate.js`**，`cx-auto.mjs` 加旧路径兜底 |
| §7 P3 回滚用 `git checkout -- scripts/huayi-watch.mjs` | 该文件落地时是 **untracked**，没有可还原的版本 | 已 `git add` 进索引（未提交；要真正可回滚还需一次 commit） |
| §8「改动只允许出现在 6 个文件 + 新增 5 个」 | 开工前工作树已有 23 个脏文件（上一轮适配 + 9 个 `.ps1` 的 BOM 修复） | 提供 P0 起点快照 `runs/platforms.before-p0.json` 做隔离证据 |
| §7 P4 验收要求 `detect huayi --active rate-ladder` 得 `declaredMax=1/hardKill=true` | 现场**无已登录实例**，临时实例是新 profile、没有播放页 | 解析器对**已记录的华医网阶梯实测值**复算，得到同样结论（交叉验证成立）；live 运行待有会话时补 |
| §5.3「detect 起临时实例用新端口」 | `netclass up` 默认优先绑平台的**规范端口**（9229/9231） | `netclass up` 新增 `--port`；`detect.mjs` 固定从 9280 起找空位 |

---

## 8. 全局验收（全部做完才算完成）

```bash
cd D:\Vibe\NetClass

# 1. 数据层
node scripts/registry.mjs validate
#    → ✅ 通过  errors=0

# 2. 决策层
node scripts/plan.mjs --all
#    → 9 行，无 undefined / NaN
node scripts/plan.selftest.mjs
#    → all pass

# 3. 执行层未受损
node scripts/status.mjs
#    → 与改造前一致（实例数、CDP 在线状态、看护进程清单不变）
node scripts/progress-report.mjs --every=0
#    → 与 P3 基线逐平台比对，进度数字一致

# 4. 验收层
node scripts/verify.mjs --all --json
#    → 9 个平台各一条，kind 与 platforms.json 一致

# 5. 硬指标
git diff --stat
#    → 改动只允许出现在：
#      config/platforms.json
#      scripts/registry.mjs
#      scripts/cc-auto.mjs        （≤5 行）
#      scripts/huayi-watch.mjs    （≤3 行）
#      scripts/cx-rate.js         （≤3 行）
#      scripts/progress-report.mjs（≤20 行）
#      新增 5 个文件
#    → 出现其它文件 = 超出范围，回滚
```

---

## 9. 红线（违反即返工）

1. **不重启浏览器**。`netclass stop` / `taskkill` / 杀 Chrome 一律禁止（除了 `detect.mjs` 自己起的临时实例）。
2. **不碰 `runs/` 下的状态文件**（`cc-claim.json` / `cc-skip.json` / `progress.jsonl` / `instances/`）。
3. **不加依赖**。只允许 Node 内置模块 + 仓库已有。
4. **不改 `userscript/App.js`**（P3 之后另议）。
5. **不猜数值**。profile 里每个字段必须能指回 `platforms.json` 现有字段、`hardConstraints` 原文、或某个脚本的注释行号。
6. **不一次性全做**。每阶段停下、跑验收、贴输出。
7. **不顺手重构**。看到别的烂代码记进文档的「发现」小节，不改。
8. **`plan.mjs` 不许联网、不许读 runs/**。它是纯函数，混进 IO 就失去可测性。
9. **`detect.mjs` 默认 `--write` 关闭**，且只改它探到的字段。
10. **与本文档冲突的现场事实优先**。以现场为准，并把文档改对（文档是资产，不是圣旨）。

---

## 10. 已知风险

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| 迁移驱动时改了在跑的单子 | P3 未灰度、未抓基线 | 一平台一次 + 抓 `progress-report` 基线 + `git checkout` 回滚 |
| `profile` 填了没验证的值 | 为了「填满」而编造 | 每条带 `verified` 日期；`plan` 输出 `confidence: unverified` 并在 CLI 黄字提示 |
| `detect.mjs` 的 active 探针把正式账号踢下线 | 在正式标签里跑 A/B | 强制临时实例 + 新 profile，禁止复用 `--platform` 的默认端口 |
| `plan.mjs` 变成第二个真相源 | 缺字段时悄悄填默认值 | 缺字段一律 `confidence: legacy` + warning，不填默认值 |
| huayi 的 `rate.hardKill=true` 被误改成 false | 手工编辑 config | `detect.mjs --active rate-ladder` 交叉验证 + selftest fixture 锁死 |

---

## 11. 附：本规格引用的现有证据索引

| 结论 | 证据位置 |
|---|---|
| `rateMax` / `accountingMaxRate` 无消费者 | `scripts/registry.mjs:385`（仅 `Number.isFinite`）+ 全仓 grep |
| huayi 4 个校验错误 | `node scripts/registry.mjs validate` 实跑输出 |
| eduyun 平台未注册 | `scripts/smartedu-course.mjs:6-17` vs `platforms.json` 的 `smartedu`（`basic.qh.smartedu.cn`） |
| ccjyxy L2 钳位 | `platforms.json` ccjyxy.constraints + `docs/HANDOVER.md §5.x` |
| huayi L3 tick 窗口 | `platforms.json` huayi.constraints；`runs/natural-finish.mjs` |
| huayi R3 硬杀倍速 | `platforms.json` huayi.constraints（阶梯实测表） |
| zhihuishu C4 检测 | `userscript/App.js:188-276`；`skills/netclass-course-orders/references/platforms.md` |
| chaoxing 禁 `setDeviceMetricsOverride` | `platforms.json` chaoxing.constraints |
| shengsheng 可 2 路并行 | `platforms.json` shengsheng.constraints（40s 采样 1.53x / 1.50x） |
| 5 种 completion.kind 的现有实现 | `cc-lib.readCcStats` / `progress-report.mjs` `CX_EXPR` / `ss-watch.mjs:33` / `huayi-watch.mjs` / `App.js` zhihuishu 适配器 |

---

## 12. 交付说明模板（开发完照这个写）

```md
## 交付：能力补全层 P0–P5

### 完成情况
| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 修校验 | ✅ | `registry validate` → errors=0 |
| P1 数据层 | ✅ | 9 个平台 × profile |
| P2 决策器 | ✅ | `plan.selftest.mjs` all pass |
| P3 驱动接入 | ⚠ 2/3 | cc-auto ✅ / huayi-watch ✅ / cx-rate 未做（原因：…） |
| P4 探测器 | ⚠ 2/5 | passive ✅ / rate-ladder ✅ / 其余 3 个 TODO |
| P5 统一验收 | ✅ | progress.jsonl 字段集合一致 |

### 发现的额外问题（未改，仅记录）
- …

### 回滚点
- P3 前：`git checkout -- scripts/cc-auto.mjs`
- 全量：`git checkout -- config scripts && rm scripts/{plan,detect,verify,profile-schema}*.mjs`
```
