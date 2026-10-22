# NetClass — 网课自动化 Agent

> **把「网页自动化」做成工程化系统，再把「工程化系统」升级成 Agent。**
>
> 它不只刷课 —— 它给出的是一套**可复用的架构**：
> 页面内模块 + MV3 加载器 + 外部驱动器 + 自愈守护 + **一层真正的 Agent 编排**。
> 让你在**几小时内**把一个全新平台接进来，而不是从零趟坑。
>
> **已适配**：学习通（超星）· 长春教师培训 · 生生课堂 · 智慧树知到 · 齐阳 · webtrn
> **适配一个新平台 ≈ 写一个 `ADAPTER_*` 对象 + 往 `config/platforms.json` 加一个块。**

---

## 🔑 使用契约：**你登录，我干活**

```
你做的事:  在浏览器里自己登录一次（持久 profile 会记住）
我们做的事: 探测"登录了没有" → 接管已登录的页面 → 自动处理 → 报告结果
```

**本项目【不做自动登录】，也【不保存任何账号密码】：**

| 不做 | 为什么 |
|---|---|
| 代填账号密码 | 不存密码 = 没有密码泄露风险；责任边界清晰 |
| 过验证码 / 短信 / 人脸 | 这类验证本就该由本人完成 |
| 自动注册账号 | 自建账号不算你的真实学习记录 |
| 记住/上传你的凭据 | 仓库与配置里永远没有密码字段 |

**掉登录了怎么办？** `auth.ensure()` 会把登录页打开、打印提示、等最多 180 秒。
登完自动继续；超时就明确报错停下 —— **绝不假装登录成功继续往下跑**。

```bash
node scripts/auth.mjs probe --platform ccjyxy    # 现在登录了吗？
node scripts/auth.mjs ensure --platform ccjyxy   # 没登录就提示我登
```

---

## 目录

- [现在能做什么](#现在能做什么)
- [这是什么](#这是什么)
- [架构：五层](#架构五层)
- [快速开始](#快速开始)
- [**适配一个新平台**](#适配一个新平台核心价值)
- [沉淀的工具箱](#沉淀的工具箱)
- [已踩过的坑](#已踩过的坑)
- [设计取舍（为什么这么做）](#设计取舍为什么这么做)
- [文档地图](#文档地图)
- [免责声明](#免责声明)

---

## 现在能做什么

### 一句自然语言 → 结构化任务单

```bash
node scripts/nl-dispatch.mjs --dry "帮我把长春那 90 学时刷完"
```

```
🔍【dry-run 未落盘】
  平台   ccjyxy（长春教师培训）  依据：alias「长春」
  类型   video  依据：含"刷课/看完/视频/学时"等视频特征词
  范围   all     依据：未指明范围 → 默认全部
  目标   credit:90学时  依据：未指定 → 取注册表声明的总目标 90
  置信   0.8
```

**能力不匹配会直接拒单，并告诉你谁能做**：

```bash
node scripts/nl-dispatch.mjs "长春的作业交了"
```
```
⚠ 长春教师培训 不支持「homework」—— 它当前支持：video
❓ 长春教师培训 做不了「homework」。支持这个任务的有：智慧树知到 / 教师培训平台（webtrn）。要换吗？
exit=1
```

### 任务编排与监控

```bash
node scripts/orchestrator.mjs list        # 所有任务单 + 推导状态 + 告警
node scripts/orchestrator.mjs tick        # 跑一轮推导（写观测字段，不动 state）
node scripts/orchestrator.mjs run         # 主循环（只读）
node scripts/orchestrator.mjs run --manage --yes   # 会起驱动（四道保险，见下）
```

输出示例：
```
[t_20261019021258_cc] ccjyxy/video → 推导=running（驱动在跑（pid=63504））
  · 学时 71.1/90(缓存20min)
  · 小初高公需 30.9/30✅ | 初中学段通识 0.4/15 | 专业课-初中数学 39.8/45
```

### 登录态探测

```bash
node scripts/auth.mjs probe               # 全平台三态探测
node scripts/auth.mjs probe --platform ccjyxy
node scripts/auth.mjs ensure --platform ccjyxy
node scripts/auth.mjs keepalive --platform ccjyxy --every 600
node scripts/auth.mjs accounts            # 账号池（只显示脱敏 user，永不显示密码）
node scripts/auth.mjs selftest            # 三态自检
```

```
✅ ccjyxy       长春教师培训     loggedIn     via=registry-probe
⚠ chaoxing     学习通           unreachable  CDP 9227 连不上（浏览器没开 / 隧道断）
```

### 平台注册表

```bash
node scripts/registry.mjs validate        # 真校验：必填字段/端口冲突/脚本存在性
node scripts/registry.mjs list            # 6 个平台一览
node scripts/registry.mjs ports           # 端口占用表
node scripts/registry.mjs procs           # 每个平台该跑哪些进程
```

### 维护

```bash
node scripts/status.mjs                   # 全局体检
node scripts/nc.mjs eval --port 9228 --target ccjyxy --expr "location.href"   # 页面里跑 JS
node scripts/converge-supervisor.mjs      # 收敛重复的 supervisor（默认 dry-run）
```

---

## 这是什么

一套**浏览器端网页自动化的工程化骨架 + Agent 编排层**，用于处理"需要在网页里按步骤推进长流程"的任务（在线课程、培训平台、表单流程……）。

**它解决的核心问题不是「怎么点按钮」，而是：**

| 问题 | 本项目的答案 |
|---|---|
| 自动化脚本**被站点检测**怎么办？ | 模块**注入页面内**（等价用户脚本，无 CDP 特征）；**点击一律用 CDP 真鼠标事件**（`isTrusted=true`） |
| 跑几小时就**静默卡死**怎么办？ | 四层守护 + **可自愈判据**（模块失能 / 切节链断裂 / 学时 40 分钟不动） |
| 换个新平台要**重写一遍**吗？ | **不用** —— 平台差异收敛进 `ADAPTER_*` + `config/platforms.json` 的一个块 |
| 怎么知道**真的做完了**？ | 每平台探出**唯一可靠的完成判据**（平台口径，不是 DOM 猜测） |
| 用户说一句话，系统能自己**判断做什么**吗？ | ✅ **能** —— `nl-dispatch` 规则判型（平台/类型/范围/目标）+ 能力校验 |
| 10 小时的长任务**谁盯着**？ | `orchestrator` 推导状态 + `cc-watch` 每 3 分钟采样 + `supervisor` 自愈 |

---

## 架构：五层

```
┌─────────────────────────────────────────────────────────────────────┐
│ ⓪ Agent 层（新增）                                                   │
│   nl-dispatch.mjs     自然语言 → 结构化任务单（规则优先，LLM 可选钩子）  │
│   orchestrator.mjs    任务单 → 排班 → 监控 → 验收（唯一写 task.state）   │
│   auth.mjs            登录态三态探测 + 三层降级 + 保活 + 账号池          │
│   registry.mjs        平台注册表读取器（数据驱动，加平台不改代码）        │
│   config/platforms.json  ← 平台能力的唯一真相                          │
├─────────────────────────────────────────────────────────────────────┤
│ ① 页面内模块    userscript/App.js（144KB）                           │
│   HOST 判定 → P_ADAPTER 自动选 6 个适配器之一                          │
│   面板 UI / 视频策略 / 弹题作答 / 字体解密 / 设置 Schema                │
│   **反检测**：只碰站点不检查的东西                                     │
├─────────────────────────────────────────────────────────────────────┤
│ ② 扩展加载层    loader-ext/（MV3）                                    │
│   host_permissions + MATCHES · 注入模块 · 转发 LLM 请求（绕 CSP）       │
├─────────────────────────────────────────────────────────────────────┤
│ ③ 驱动器层      scripts/*-auto.mjs / *-cycle.mjs（Node + CDP）        │
│   平台无关状态机：页态判定 → 认领 → 推进 → 结算                         │
│   每平台一个驱动器 + 一个共享库                                       │
├─────────────────────────────────────────────────────────────────────┤
│ ④ 守护层        supervisor.mjs + watchdogs + 计划任务                 │
│   每 60s 体检：端口 / 隧道 / 进程 / 重复实例                          │
│   自愈判据：模块失能 · 切节链断裂 · 流卡死                             │
└─────────────────────────────────────────────────────────────────────┘
```

**分层的好处**：加平台只动 ①③ 的适配器 + 一个 JSON 块；②④ 完全不用改。

### 数据驱动：`config/platforms.json`

**一个平台 = 一个 JSON 块。** 这是「加平台不改代码」的关键。

```jsonc
"ccjyxy": {
  "label": "长春教师培训",
  "host": "col.ccjyxy.cn",
  "cdp": 9228,
  "capabilities": ["video"],                    // ★ 能力声明 → 派单前校验
  "driver": { "script": "cc-cycle.mjs", "args": ["--port", "{cdp}"], "singleton": true },
  "watchers": [{ "script": "cc-watch.mjs", "args": ["--port", "{cdp}", "--every=180"] }],
  "categories": [                                // 多分类平台才需要
    { "key": "小初高公需", "goal": 30 },
    { "key": "初中学段通识", "goal": 15 },
    { "key": "专业课-初中数学", "goal": 45 }
  ],
  "completion": {                                // ★ 唯一可靠的完成判据
    "kind": "pageText",
    "pattern": "已修\\s*([\\d.]+)\\s*/\\s*达标\\s*(\\d+)\\s*学时",
    "verified": "2026-10-19"
  },
  "constraints": {
    "maxParallel": 1,
    "creditsPerHour": 2.1,
    "hardConstraints": [
      "单会话硬保护：同账号第二个播放页 → 旧页「本播放页已停止」+ report 接口 423 Locked",
      "MUI/React 按钮不响应合成 click()，必须 CDP 真鼠标事件",
      "记录上限 = 1.25 × 该资源累计墙钟（实测比值恒 1.25）→ 就该按 1.25x 播：同样墙钟、一趟记满；播 2x 只进账 62.5%，是负优化",
      "MUI Accordion 手风琴：展开一个分类，另外两个从 DOM 消失 → 必须一个分类一个进程"
    ]
  },
  "auth": { "loginUrl": "...", "probe": "<页面内 JS>", "captcha": "none" },
  "heal": { "resetOnStall": ["runs/cc-skip.json", "runs/cc-claim.json"] }
}
```

**`supervisor.mjs` 已经改成从这里读 `TARGETS`** —— 等价性有脚本证明：

```bash
node runs/p0-parity-check.mjs
# ✅ 逐字段等价（name/match/uniq/args/out/err/watchOnly 全一致）
```

---

## 快速开始

### 前置

- Windows（守护层用了计划任务 / VBS 无窗口启动）
- Node.js 18+
- 一个 Chrome / Chromium（可用带调试口的发行版）
- （可选）任意 OpenAI 兼容 LLM 的 API Key（自动答题用；`nl-dispatch` 目前不需要）

### 部署

```powershell
git clone https://github.com/AITCX08/NetClass.git
cd NetClass

# 1) 构建模块 + 加载器
node scripts/build.mjs
node scripts/build-loader.mjs

# 2) 推到浏览器所在机器的部署目录
pwsh -File scripts/netclass-deploy.ps1 -Action push

# 3) 打开扩展「开发者模式」
#    ★ MV3 的 chrome.userScripts 必须在开发者模式下才可用
#    不开的话：注册静默失败，页面上什么都不出现（不报错）
node scripts/ensure-devmode.mjs --port <调试端口>

# 4) 校验注册表 + 起守护
node scripts/registry.mjs validate
node scripts/supervisor.mjs --interval=60
```

### 第一次跑一个任务

```powershell
# 判型（不落盘）
node scripts/nl-dispatch.mjs --dry "把长春的课刷完"

# 真派单
node scripts/nl-dispatch.mjs "把长春的课刷完"

# 看编排器怎么推导的
node scripts/orchestrator.mjs list

# 确认登录态
node scripts/auth.mjs probe --platform ccjyxy
```

---

## 适配一个新平台（核心价值）

**流程固定，照做就行。**

### Step 1 · 侦察（半天）

```powershell
node scripts/nc.mjs eval --port <PORT> --target <host> --expr "document.title"
node scripts/probe-page.mjs <PORT> <host>
```

**要弄清四件事**：
1. **页态怎么判定？**（列表页 / 详情页 / 播放页…各有什么特征）
2. **「完成」怎么判定？** ← **最难，必须探对**
3. **推进怎么触发？**（点什么按钮、走什么流程）
4. **有什么硬约束？**（单会话？限速？反检测？）

### Step 2 · 探出唯一可靠的完成判据

**经验**：**前端能看到的"✓"标记经常不可靠。**

| 平台 | 踩过的坑 | 最终判据 |
|---|---|---|
| 学习通 | `.jobUnfinishCount` 有 59 个元素但值全是空的 | `span.roundpoint` 的类名（`blue`=已完成 / `orange01 jobCount`=未完成）|
| 知到 | DOM 里的 ✓ 在 **73 个小节上完全一致**，数出来永远 73/73 | `POST learning/queryStuyInfo` 的 **`watchState===1`** |
| 长春 | 平台只在**培训页**渲染学时，播放器页读不到 | 培训页原文「已修 N 学时」（**平台自己的口径**）|

**判据要满足**：① 能区分"完成/未完成" ② 可重复读 ③ **是平台自己的口径**

### Step 3 · 写适配器 + 加注册表块

```js
// userscript/App.js
const ADAPTER_XX = {
  pageKind() { /* 列表页/详情页/播放页？ */ },
  player() { return document.querySelector('video'); },
  progressInfo() { /* {total, done, pct, remainSec} —— 用 Step 2 的判据 */ },
  poll() { /* 定时推进 */ },
};
```

```jsonc
// config/platforms.json —— 加一个块
"xx": {
  "label": "...", "host": "...", "cdp": 9230,
  "capabilities": ["video"],
  "driver": { "script": "xx-auto.mjs", "args": ["--port", "{cdp}"] },
  "completion": { "kind": "pageText", "pattern": "...", "verified": null },
  "auth": { "loginUrl": "...", "probe": null, "captcha": "none" }
}
```

**然后把域名加进两处**（唯一容易漏的地方）：
```
loader-ext/manifest.json  → host_permissions
loader-ext/background.js  → MATCHES
```

### Step 4 · 探硬约束（决定方案成败）

| 要测什么 | 怎么测 | 为什么重要 |
|---|---|---|
| **能不能多开？** | 开第二个标签，看第一个是否被踢 / 接口是否 423 | 长春**单会话硬保护** → 并行方案直接废 |
| **能不能跳转？** | 改 `currentTime` 看服务端收到多少 | 长春**服务端钳位** `position_sec` |
| **倍速上限？** | 逐步调高，看是否被改回 | 知到只有 1.0/1.25/1.5 且**必须走站点 UI** |
| **有没有反检测？** | 注入后观察是否被踢 | 知到 1 秒内判定、3 秒踢回门户 |
| **记账速率？** | 播 N 秒看平台记了多少，算 `记账秒数 / 墙钟秒数` | 长春的比值**恒为 1.25** → **记录上限 = 1.25 × 累计墙钟**。所以【就该按 1.25x 播】：同样墙钟、一趟记满；**播 2x 只进账 62.5%，是负优化** |

**这些结论全部写进 `constraints.hardConstraints`** —— 下一个人接手时不用重新踩。

### Step 5 · 接驱动器 + 守护

复制一个现成的 `*-auto.mjs` 改选择器；**守护层不用改** —— 注册表里加了 `driver` 就会自动被 `supervisor` 管起来。

---

## 沉淀的工具箱

### Agent 层（新）

| 工具 | 作用 |
|---|---|
| `scripts/nl-dispatch.mjs` | 自然语言 → 任务单（19 例自检：`--test`）|
| `scripts/orchestrator.mjs` | 任务编排 / 排班 / 监控 / 验收 |
| `scripts/auth.mjs` | 登录态三态探测 + 三层降级 + 保活 + 账号池 |
| `scripts/registry.mjs` | 平台注册表读取器（mtime 热重载 + 真校验）|
| `scripts/converge-supervisor.mjs` | 收敛重复 supervisor（dry-run 默认，断链自愈）|

### 通用（平台无关）

| 工具 | 作用 |
|---|---|
| `scripts/nc.mjs` | **CDP 统一入口**：`eval` / `run` / `shot` |
| `scripts/supervisor.mjs` | 系统主管：进程保活、隧道重建、去重 |
| `scripts/status.mjs` | 全局体检 |
| `scripts/tile-4-cdp.mjs` | 多窗口 2×2 平铺（**必须用 CDP `Browser.setWindowBounds`** —— Win32 `MoveWindow` 找不到这些窗口）|
| `scripts/hide-infra-windows.ps1` | 藏掉基础设施的控制台窗口 |
| `scripts/tunnel.ps1` | SSH 隧道（远程浏览器 ↔ 本机控制）|

### 反检测 / 底层技巧

| 技巧 | 位置 |
|---|---|
| **CDP 真鼠标事件**（`Input.dispatchMouseEvent`）绕过 `!e.isTrusted` | 各驱动器 |
| **只包 XHR.send 不碰 .open** | 知到适配 |
| **字体子集解密**（`font-cxsecret` → 轮廓点光栅化 → 字形匹配） | `scripts/build-glyph-lib.mjs` |
| **播放器倍速压制**（替换 `playbackRate` 访问器 + 每 tick 校验归属） | `cc-lib.mjs` 的 `installHunter()` |
| **跨 iframe 坐标累加**（`getBoundingClientRect()` 是 frame 相对的） | 学习通适配 |

---

## 已踩过的坑

> 完整版在 [`docs/HANDOVER.md`](docs/HANDOVER.md)，按症状索引。

| 症状 | 成因 |
|---|---|
| 页面上什么都没注入，**也不报错** | MV3 的 `chrome.userScripts` 需要**开发者模式** |
| 面板"点了没反应" | MUI/React 按钮不响应合成 `click()`，要真实鼠标事件 |
| 完成度永远是 100%（明明是 0） | 数了不可靠的 ✓ 标记（知到 73 个小节类名完全一致）|
| 视频播到末尾就停住，不切下一节 | **模块实例卡死**（`state.video.seen === 0`）→ `Page.reload` |
| 自动化跑几小时就静默不动 | `setInterval` 死了但变量还在 → **判存活要看心跳时间戳** |
| 改了代码但"没生效" | 版本常量没变 → 注入检查只测"存在性"就永不再注入 |
| 点"提交"实际只"保存了" | 两个按钮**共用 class**，`querySelectorAll[0]` 拿到的是保存 |
| 截图后账号被风控 | 用了 `Emulation.setDeviceMetricsOverride` —— **改设备指标 = 改指纹** |
| 守护进程**静默死亡** | 磁盘写满 → 日志写失败 → 进程异常退出 |
| **枚举只看到一部分课程** | MUI Accordion 手风琴：折叠的分类**不渲染**；展开一个，**另外两个从 DOM 消失** |
| **52 门课被误判"打不开"** | 折叠卡宽 0 → `openCourse()` 判"列表里找不到" → 写进持久化跳过表 → 永远无课可做 |
| **分类达标了却不切换** | `readCcStats()` 只读 `tabs[0]`，驱动在播放器页时拿不到分类明细 |
| **隧道突然全断** | 笔记本换了 SSH 主机密钥 → `StrictHostKeyChecking=yes` 直接拒连 |

---

## 设计取舍（为什么这么做）

### 1. 为什么 `orchestrator` 默认只读？

```
长春正跑 10 小时任务时，接管进程管理必须先证明状态机对。
只读版把【真实状态】和【推导状态】摆在同一个任务单里对比 —— 逻辑对不对比一下就知道，
且推导有 bug 也不会影响正在跑的自动化。
```

**`manage` 模式有四道保险**：

```
保险1  绝不 kill 任何进程（只做"没在跑就拉起来"）
保险2  平台级互斥：有驱动在跑 → 只观察，绝不重复拉起（防 423）
保险3  状态门：只处理 state=queued 且 needsConfirm=false 且 confirmed
保险4  双开关：--manage 单独给 → 等同只读并提示
```

### 2. 为什么 `nl-dispatch` 不接 LLM？

```
项目里没有统一 LLM 调用层；硬接会引入"没 key 就完全不能用"的脆弱性。
规则版覆盖常见说法，立刻可用；LLM 留 classifyByLLM() 钩子
（现在故意返回 null → 上层退回 needsConfirm，这是正确行为而不是失败）。
```

### 3. 为什么 `auth.probe` 要分三态？

```
loggedIn / notLoggedIn / unreachable
混成一个 false 的话，"浏览器没开"会被误判成"掉登录"，然后去乱登录。
这是两类完全不同的问题，处理方式也不同。
```

### 4. 明确不做的

| 不做 | 原因 |
|---|---|
| 通用浏览器 Agent（能操作任何网站） | 那是另一个产品；本项目只做**网课域**，靠 `capabilities` 收敛 |
| 自动过验证码（OCR/打码平台） | 能力边界写清楚（`onCaptcha: pause`），**不假装能过** |
| 多账号并发抢同一平台 | 平台单会话硬保护（423），并发必废 |
| 自动注册账号 | 自建账号不算成果 |
| 分布式多机 | 单机够用，分布式只增加故障面 |

---

## 文档地图

| 文档 | 内容 |
|---|---|
| [`docs/AGENT-ARCHITECTURE.md`](docs/AGENT-ARCHITECTURE.md) | **Agent 化设计**：任务单契约 / 注册表 schema / 三层接口与骨架 / 落地顺序 |
| [`docs/HANDOVER.md`](docs/HANDOVER.md) | **全平台病历本**：20+ 条坑，按症状索引 ★ |
| [`docs/OCS-万能-源码逆向对照.md`](docs/OCS-万能-源码逆向对照.md) | 与两个成熟实现的对照分析 |
| [`docs/FINAL-HANDOVER.md`](docs/FINAL-HANDOVER.md) | 交接模板（四平台达成度 / 恢复命令 / 教训）|
| [`docs/TASKMESH-INTEGRATION.md`](docs/TASKMESH-INTEGRATION.md) | **与 TaskMesh 控制面集成契约**（status / logs / progress / restart，端口与任务名约定）|
| `runs/p0-parity-check.mjs` | supervisor 数据驱动化的**等价性证明脚本** |

---

## 免责声明

本项目**仅用于学习浏览器自动化、反检测与长流程任务编排的技术研究**。

**使用者需自行确保**：对目标平台的访问与操作符合该平台的服务条款及所在地法律法规。
**作者不对任何滥用行为负责。**

仓库中**不包含任何真实凭据**（账号、密码、API Key 均从环境变量 / 本地存储读取，
账号池只存 `secretRef` 形如 `env:CC_PASS`）；
第三方参考源码（OCS Desktop 等）**未纳入版本库**，仅作本地对照。
