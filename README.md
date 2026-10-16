# NetClass — 网课自动化 Agent 框架

> **把「网页自动化」做成工程化系统的 Agent 项目。**
>
> 不只是刷课 —— 它给出的是一套**可复用的架构**：页面内模块 + MV3 加载器 + 外部驱动器 + 守护体系。
> 让你在**几小时内**把一个全新平台接进来，而不是从零趟坑。
>
> **已适配**：学习通（超星）· 长春教师培训 · 生生课堂 · 智慧树知到 · 齐阳 · webtrn
> **适配一个新平台 ≈ 写一个 100 行左右的 `ADAPTER_*` 对象 + 两处域名声明。**

---

## 目录

- [这是什么](#这是什么)
- [为什么值得看](#为什么值得看)
- [架构：四层](#架构四层)
- [快速开始](#快速开始)
- [**适配一个新平台**](#适配一个新平台核心价值)
- [沉淀的工具箱](#沉淀的工具箱)
- [已踩过的坑](#已踩过的坑)
- [文档地图](#文档地图)
- [免责声明](#免责声明)

---

## 这是什么

一套**浏览器端网页自动化的工程化骨架**，用于处理"需要在网页里按步骤推进长流程"的任务（在线课程、培训平台、表单流程……）。

**它解决的核心问题不是「怎么点按钮」，而是：**

| 问题 | 本项目的答案 |
|---|---|
| 自动化脚本**被站点检测**怎么办？ | 模块**注入页面内**（等价用户脚本，无 CDP 特征）；**点击一律用 CDP 真鼠标事件**（`isTrusted=true`） |
| 跑几小时就**静默卡死**怎么办？ | 四层守护体系 + **可自愈判据**（实测出两条：模块失能、切节链断裂） |
| **跨 iframe / 跨状态机**怎么稳定推进？ | 「页态判定 → 状态机」模型（`HOME / PLAY / COURSE / PICK` 四态） |
| 换个新平台要**重写一遍**吗？ | **不用** —— 平台差异被收敛进一个 `ADAPTER_*` 对象 |
| 怎么知道**真的做完了**？ | 每个平台探出**唯一可靠的完成判据**（见下文），不靠"看起来在跑" |

---

## 为什么值得看

### 1. 它是"实战踩出来的"，不是玩具

代码里每个反直觉的地方都标了**成因 + 实测证据**。举几个真实的：

```js
// 学习通禁用 Emulation.setDeviceMetricsOverride —— 改设备指标 = 改指纹
// 实测触发风控：detect.chaoxing.com 报"您的账号于00:56在一台谷歌内核浏览器设备登录章节页面"
// 截图改用 Page.captureScreenshot 的 clip.scale（纯渲染参数）

// 知到检测 XHR.prototype.open 的 native 性：
//   isNative(window.XMLHttpRequest) && isNative(XHR.prototype.open) && !window['OCS']
//   && isNative(Element.prototype.addEventListener)
// → 所以只包 send（不碰它检查的 .open），URL 从 responseURL 取

// 长春：同账号第二个播放页会让旧页显示"本播放页已停止" + report 接口 423 Locked
// → 平台单会话硬保护，并行必废

// 知到考试页有 CSP（connect-src 'self'）→ 页面内问不了 LLM（Failed to fetch）
//   而失败被静默吞掉 → 看起来像"模型不行"（第一版准确率 30% 的真因）
// → 答案改由外部驱动器在 PC 侧调模型，准确率回到 10/10
```

### 2. 它沉淀了"快速适配新平台"的方法论

不是"我有六个平台的脚本"，而是**"我有一套让你快速接第七个的流程"**。

---

## 架构：四层

```
┌─────────────────────────────────────────────────────────────────────┐
│ ① 页面内模块    userscript/App.js                                    │
│    跑在目标页面里（chrome.userScripts 注入，等价 Tampermonkey）        │
│    · PLATFORM 判定 → 选对应 ADAPTER_*                                │
│    · 面板 UI（进度/暂停/倍速/答题/下一节/设置）                        │
│    · 视频策略：自动播放 / 静音 / 倍速纠正 / 掉速重试 / 结束下一节        │
│    · 随堂题自动作答（LLM 给答案 + 提交前校验）                         │
│    · **反检测**：只碰站点不检查的东西                                 │
├─────────────────────────────────────────────────────────────────────┤
│ ② 扩展加载层    loader-ext/（MV3）                                   │
│    · host_permissions / MATCHES —— 声明注入哪些站点                   │
│    · 从本机服务拉模块代码并注入                                       │
│    · 转发 LLM 请求（绕 mixed-content / CSP）                          │
├─────────────────────────────────────────────────────────────────────┤
│ ③ 驱动器层      scripts/*-auto.mjs（Node + CDP）                     │
│    · **平台无关**的状态机：页态判定 → 认领任务 → 推进 → 结算            │
│    · 每个平台一个驱动器 + 一个共享库（选择器 / 页态 / 工具）            │
│    · 通过 CDP 与页面内模块配合：模块决策，驱动器发真实输入              │
├─────────────────────────────────────────────────────────────────────┤
│ ④ 守护层        scripts/supervisor.mjs + watchdog + 计划任务          │
│    · 每 60s 全量体检：端口、隧道、进程、重复实例                       │
│    · 进程死了自动补、隧道断了自动重建                                  │
│    · **自愈判据**（实测出来的）：模块失能 / 切节链断裂 → 自动重载页面     │
└─────────────────────────────────────────────────────────────────────┘
```

**分层的好处**：加平台只动 ①③ 的**适配器部分**；②④ 完全不用改。

---

## 快速开始

### 前置

- Windows（守护层用了计划任务 / VBS 无窗口启动）
- Node.js 18+
- 一个 Chrome / Chromium（可用带调试口的发行版）
- （可选）任意 OpenAI 兼容 LLM 的 API Key（用于自动答题）

### 部署

```powershell
git clone https://github.com/AITCX08/netclass.git
cd netclass

# 1) 构建模块 + 加载器
node scripts/build.mjs
node scripts/build-loader.mjs

# 2) 把扩展推到浏览器所在机器的部署目录
pwsh -File scripts/netclass-deploy.ps1 -Action push

# 3) 打开扩展的「开发者模式」
#    ★ MV3 的 chrome.userScripts 必须在开发者模式下才可用
#    不开的话：注册静默失败，页面上什么都不出现（不报错）
node scripts/ensure-devmode.mjs --port <调试端口>

# 4) 起守护
node scripts/supervisor.mjs --interval=60
```

### 健康检查

```powershell
node scripts/status.mjs                    # 全局体检
node scripts/nc.mjs eval --port 9227 --target chaoxing --expr "location.href"
```

---

## 适配一个新平台（核心价值）

**流程是固定的，照做就行：**

### Step 1 · 侦察（半天）

```powershell
# 用统一入口在页面里做任意探测（无需写文件）
node scripts/nc.mjs eval --port <PORT> --target <host> --expr "document.title"

# 页面结构快照
node scripts/probe-page.mjs <PORT> <host>
```

**要弄清四件事：**
1. **页态怎么判定？**（列表页 / 详情页 / 播放页…各有什么特征）
2. **「完成」怎么判定？** ← **最难，必须探对**（见 Step 2）
3. **推进怎么触发？**（点什么按钮、走什么流程）
4. **有什么硬约束？**（单会话？限速？反检测？）

### Step 2 · 探出唯一可靠的完成判据（关键）

**经验**：**前端能看到的"✓"标记经常不可靠**。

| 平台 | 踩过的坑 | 最终判据 |
|---|---|---|
| 学习通 | `.jobUnfinishCount` 有 59 个元素但值全是空的 | `span.roundpoint` 的类名（`blue`=已完成 / `orange01 jobCount`=未完成）|
| 知到 | DOM 里的 ✓ 在 **73 个小节上完全一致**，数出来永远 73/73 | `POST learning/queryStuyInfo` 的 **`watchState===1`** |
| 长春 | — | 培训页原文「已修 N 学时」（**平台自己的口径**）|

**判据要满足**：① 能区分"完成/未完成" ② 可重复读 ③ **是平台自己的口径**，不是你的推测。

### Step 3 · 写适配器（1-4 小时）

在 `userscript/App.js` 里加一个对象：

```js
const ADAPTER_XX = {
  key: 'xx',
  pageKind() { /* 当前是列表页/详情页/播放页？ */ },
  player() { return document.querySelector('video'); },
  progressInfo() { /* 返回 {total, done, pct, remainSec} —— 用 Step 2 的判据 */ },
  poll() { /* 定时推进：下一步该做什么 */ },
  onResponse() { /* 可选：拦截接口拿数据 */ },
};
```

**然后把域名加进两处**（唯一容易漏的地方）：
```
loader-ext/manifest.json → host_permissions
loader-ext/background.js → MATCHES
```

### Step 4 · 探硬约束（容易被忽略，但决定方案）

| 要测什么 | 怎么测 | 为什么重要 |
|---|---|---|
| **能不能多开？** | 开第二个标签，看第一个是否被踢 / 接口是否 423 | 长春**单会话硬保护** → 并行方案直接废 |
| **能不能跳转？** | 改 `currentTime` 看服务端收到多少 | 长春**服务端钳位** `position_sec` → 跳不过去 |
| **倍速上限？** | 逐步调高，看是否被改回 | 知到只有 1.0/1.25/1.5 且**必须走站点 UI** |
| **有没有反检测？** | 注入后观察是否被踢 | 知到 1 秒内判定、3 秒踢回门户 |
| **记账速率？** | 播 N 秒看平台记了多少 | 长春**硬卡 1.25x** → 播 2x 反而要重播补录 |

### Step 5 · 接驱动器 + 守护（半天）

复制一个现成的 `*-auto.mjs` 改选择器；**守护层不用改** —— 加进 `supervisor.mjs` 的目标列表即可。

---

## 沉淀的工具箱

### 通用（平台无关）

| 工具 | 作用 |
|---|---|
| `scripts/nc.mjs` | **CDP 统一入口**：`eval` / `run` / `shot`，不用为每个小测试写文件 |
| `scripts/supervisor.mjs` | 系统主管：进程保活、隧道重建、去重 |
| `scripts/status.mjs` | 全局体检 |
| `scripts/tile-4-cdp.mjs` | 多窗口 2×2 平铺（**必须用 CDP 的 `Browser.setWindowBounds`** —— Win32 `MoveWindow` 找不到这些窗口）|
| `scripts/hide-infra-windows.ps1` | 把基础设施进程的控制台窗口藏起来（不干扰用户） |
| `scripts/tunnel.ps1` | SSH 隧道（远程浏览器 ↔ 本机控制） |

### 反检测 / 底层技巧

| 技巧 | 位置 |
|---|---|
| **CDP 真鼠标事件**（`Input.dispatchMouseEvent`）绕过 `!e.isTrusted` | 各驱动器 |
| **只包 XHR.send 不碰 .open** | 知到适配 |
| **字体子集解密**（`font-cxsecret` → 轮廓点光栅化 → 字形匹配） | `scripts/build-glyph-lib.mjs` |
| **播放器倍速压制**（替换 `playbackRate` 访问器 + 原生 setter 周期压回） | `cc-lib.mjs` 的 `installHunter()` |
| **跨 iframe 坐标累加**（`getBoundingClientRect()` 是 frame 相对的） | 学习通适配 |

---

## 已踩过的坑

> 完整版在 [`docs/HANDOVER.md`](docs/HANDOVER.md)，按症状索引。

| 症状 | 成因 |
|---|---|
| 页面上什么都没注入，**也不报错** | MV3 的 `chrome.userScripts` 需要**开发者模式**，否则注册静默失败 |
| 面板"点了没反应" | MUI/React 的按钮不响应合成 `click()`，要真实鼠标事件 |
| 完成度永远是 100%（明明是 0） | 数了不可靠的 ✓ 标记（知到 73 个小节的类名完全一致） |
| 视频播到末尾就停住，不切下一节 | **模块实例卡死**（`state.video.seen === 0`）→ `Page.reload` 恢复 |
| 自动化跑几小时就静默不动了 | `setInterval` 死了但变量还在 → **判存活要看心跳时间戳**，不是变量存在性 |
| 改了代码但"没生效" | 版本常量没变 → 注入检查只测"存在性"就永不再注入（**版本号必须一起改**） |
| 点"提交"实际只"保存了" | 两个按钮**共用 class**，`querySelectorAll[0]` 拿到的是保存 |
| 截图后账号被风控 | 用了 `Emulation.setDeviceMetricsOverride` —— **改设备指标 = 改指纹** |
| 守护进程会**静默死亡** | 磁盘写满 → 日志写失败 → 进程异常退出（**磁盘满的连带伤害，不易察觉**）|

---

## 文档地图

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构梳理（本文的详细版）|
| [`docs/HANDOVER.md`](docs/HANDOVER.md) | **全平台病历本**：20+ 条坑，按症状索引 ★ |
| [`docs/OCS-万能-源码逆向对照.md`](docs/OCS-万能-源码逆向对照.md) | 与两个成熟实现的对照分析 |
| [`docs/FINAL-HANDOVER.md`](docs/FINAL-HANDOVER.md) | 交接模板（四平台达成度 / 恢复命令 / 教训）|

---

## 免责声明

本项目**仅用于学习浏览器自动化、反检测与长流程任务编排的技术研究**。

**使用者需自行确保**：对目标平台的访问与操作符合该平台的服务条款及所在地法律法规。
**作者不对任何滥用行为负责。**

仓库中**不包含任何真实凭据**（账号、密码、API Key 均从环境变量 / 本地存储读取）；
第三方参考源码（OCS Desktop 等）**未纳入版本库**，仅作本地对照。
