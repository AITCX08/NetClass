# NetClass 交接文档

> 面向接手这套代码的人。README 讲「这是什么」，本文档讲**「怎么接着干活」**：
> 架构、代码地图、部署、排障手册、以及**每个坑的成因**（最有价值的部分）。
>
> 最后更新：2026-10-14（随代码同 PR 更新；完整病历见 `git log`）

---

## 0. 三分钟上手

**这是什么**：跑在用户 Windows 笔记本（`192.168.1.8`，用户 `WJX`）上的浏览器自动化，
用来在两个网课平台上自动播放课程、处理随堂题、逐级推进课程。

**代码在哪**：

```
开发（本机）  C:\Users\Administrator\Desktop\Vibe\_opensource\artifacts\TaskMesh\netclass-20261013
部署（笔记本）%APPDATA%\OCS Desktop\downloads\extensions\netclass-loader\   ← 加载器扩展
              %LOCALAPPDATA%\TaskMesh\netclass\                            ← 脚本文件
```

**跑起来**：

```powershell
cd <开发目录>
node scripts/build.mjs          # 构建 netclass.user.js
node scripts/build-loader.mjs   # 构建 loader-ext/bundled.js
node scripts/nc.mjs run --file runs\remote\status-check.ps1   # 看状态
node scripts/nc.mjs run --file runs\remote\start-visible.ps1  # 重启两个可见窗口
```

**看当前在干什么**：

```powershell
node scripts/tile-verify.mjs                    # 两窗口位置 + 页面状态
node scripts/probe-page.mjs 9224 shengshengketang   # shengsheng 详情
node scripts/ss-logs.mjs --port 9224 --secs 8      # 控制台日志
```

---

## 1. 系统架构

### 1.1 三层执行链

```
┌─ 加载器扩展 (loader-ext/) ────────────────────────────────────┐
│  MV3 service worker，随 OCS 启动浏览器自动加载                  │
│  · 定期从 http://127.0.0.1:17800 拉最新脚本（拉不到用内置副本）  │
│  · chrome.userScripts.register() 注册到两个课程域               │
│  · 对已打开的标签页做补注入（解决页面比扩展先加载的竞态）         │
└──────────────────────┬───────────────────────────────────────┘
                       │ chrome.userScripts（world: MAIN）
                       ▼
┌─ 脚本壳 (netclass.shell.user.js) ─────────────────────────────┐
│  页面里最先跑；负责启动 + 热加载实现模块（30s 比对一次）          │
└──────────────────────┬───────────────────────────────────────┘
                       ▼
┌─ 实现模块 (userscript/App.js) ────────────────────────────────┐
│  · 平台适配器（shengsheng / qiyang）                            │
│  · 视频策略：就绪闸门 → 静音 → 倍速 → 防暂停 → 结束推进          │
│  · 卡死看门狗 / 顺序校验看护 / 随堂题三态处理                     │
│  · 弹题作答：先问 DeepSeek（key 由加载器注入页面），答错用站点给的答案补交 │
│  · 控制面板（右下角）+ 提示横幅（顶部，可关闭）                    │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 为什么不用油猴

OCS 内置 Chrome 137 + 未打包扩展 + 计划任务启动这套环境下，**Tampermonkey 装得上但不执行任何用户脚本**
（连 3 行 hello world 都不跑；已验证 `chrome.userScripts` 能力本身正常，是 TM 这条链不可靠）。

所以自研了 `loader-ext`。交付形态不变：放进 OCS 的扩展目录，OCS 每次启动浏览器会
`getExtensionPaths(extensionsFolder)` 扫描全量加载。

**注意**：`chrome.userScripts.register()` 在这个 Chrome 版本只接受 `js: [{code}]` 对象，
**不接受裸字符串**。

### 1.3 站点层级（shengsheng 三层）

```
/home                                 两门课（.classify-card）
 └─ /record/sub/<id>?classifyId=…      子课程列表（span.state-tag 显示 学习中/未开始/已完成）
     └─ /course/v2/<id>                课时目录（.lesson-item）
```

`App.js` 里的 `ssLevel()` 按路径判定层级，`poll()` 按层级分派：
L1 挑未做过的课 → L2 挑未完成的子课程 → L3 处理课时。

**课程完成后不要直接 `markAllDone`**，要逐级回退：L3 跑完 → 回 L2 → L2 跑完 → 回 L1 → L1 跑完才算全部完成。

### 1.4 qiyang 两层

```
/agent/Goods/courses        课程页（章节列表）
 └─ /agent/Goods/Courses?goodscourses_id=<id>   章节页（内联变量 isEnd / current_time / getUrl）
```

---

## 2. 代码地图

### 2.1 源码（要改的就是这些）

| 文件 | 大小 | 职责 |
|---|---|---|
| `userscript/App.js` | 59 KB | **主要工作文件**。平台适配器、视频策略、弹题、导航、面板、横幅全在这 |
| `userscript/netclass.shell.user.js` | 6 KB | 外壳：启动 + 热加载实现模块 |
| `userscript/netclass.user.js` | 25 KB | 单文件打包版（油猴备用通道用） |
| `loader-ext/background.js` | 8.6 KB | 加载器：拉脚本、注册、补注入、日志 |
| `loader-ext/bundled.js` | 68 KB | 由 `scripts/build-loader.mjs` 生成的脚本副本 |
| `loader-ext/manifest.json` | 0.4 KB | MV3 清单（v1.1.0） |

### 2.2 scripts/ 里真正有用的（110 个文件，大部分是历史调试残留）

**日常必用**
| 脚本 | 用途 |
|---|---|
| `status.mjs` | **一条命令看全貌**：隧道/CDP、两站页面状态（模块版本/开关/视频/弹题）、窗口布局、加载器去重签名、笔记本侧进程与服务与计划任务；有告警时退出码 1。加 `--no-ssh` 可跳过笔记本侧 |
| `nc.mjs` | 远程执行总入口。`run --file/--script [--args '-Apply']` 在笔记本跑 PS；`eval --port --target --expr` 在页面里跑 JS；`new/tabs` 管标签页 |
| `ds-key.mjs` | DeepSeek key 管理：`set --key sk-xxx` / `status` / `test`（key 只进笔记本的扩展存储，不进仓库、不进页面 localStorage） |
| `build.mjs` / `build-loader.mjs` | 构建两个产物 |
| `netclass-deploy.ps1 -Action push` | 一次推齐：server.ps1 / App.js / dist 产物 / 加载器扩展三件（改 background.js 后仍需 `loader-reload.mjs`） |
| `tile.mjs` / `tile-verify.mjs` | 左右半屏平铺 / 复核窗口与页面状态 |
| `probe-page.mjs` | 通用页面探针（视频状态、模块状态、弹题计数） |
| `measure.mjs` | **实测播放倍速**（按媒体时钟走速算，不是读 `playbackRate` 属性） |

**加载器诊断**
| 脚本 | 用途 |
|---|---|
| `loader-reload.mjs` | 触发 `chrome://extensions` 的「重新加载」（**改 background.js 后必须做**） |
| `loader-log.mjs` / `loader-tail.mjs` | 读加载器日志环 + 注册状态 |
| `loader-inject-test.mjs` | 手动向已打开标签补注入当前版本 |

**专项诊断（出问题时现用）**
| 脚本 | 用途 |
|---|---|
| `ss-logs.mjs` | shengsheng 控制台日志 |
| `ss-structure.mjs` / `ss-home.mjs` | 三层 DOM 结构 |
| `nav-trace.mjs` | 追踪页面导航序列（查刷屏/死循环） |
| `refresh-diag.mjs` | 查「频繁刷新」 |
| `quiz-state.mjs` | 弹题三种状态的 DOM |
| `rate-ceiling.mjs` | 逐档测平台能接受的最高倍速 |
| `order-guard-watch.mjs` | 盯「请按顺序观看视频」 |
| `pause-guard-check.mjs` | 确认「已完成」后不会自播 |
| `ss-stream-test.mjs` | 直接测流（m3u8 + 分片）是否健康 |
| `panel-shot.mjs` | 截图 + 面板计算样式 |
| `refresh-diag.mjs` / `win-titles.mjs` | 刷新诊断 / 窗口标题 |

**笔记本侧（`runs/remote/*.ps1`，纯 ASCII）**
| 脚本 | 用途 |
|---|---|
| `start-visible.ps1` | 一键重启两个可见窗口（杀进程 → 清 Singleton → 计划任务 `/IT` 启动 → 等端口） |
| `start-webtrn.ps1` | 起第三个浏览器（教师培训平台，端口 9226） |
| `status-check.ps1` | 进程数、端口、计划任务状态 |
| `find-webtrn-profile.ps1` / `list-chrome-instances.ps1` | 环境盘点 |

### 2.3 runs/

| 子目录 | 内容 |
|---|---|
| `remote/` | 在笔记本上执行的 PowerShell 脚本（**新脚本必须纯 ASCII**，见 §5.10）。2026-10-14 起**已纳入版本控制**（此前只存在于本地快照） |
| `laptop-runtime/` `ssjs/` `qy/` | 站点采样与运行时转储（第三方代码、体积大、可重抓）→ **不入库**；说明与重抓方法见 `runs/README.md` |
| 顶层 `panel-shot.png` / `tm-install-payload.json` / `tm-storage-analysis.md` | 截图证据 / 脚本依赖的数据 / 静态分析 → 入库 |

---

## 3. 部署链路

### 3.1 完整流程

```powershell
cd <开发目录>

# 1) 构建
node scripts/build.mjs           # → dist/netclass.user.js
node scripts/build-loader.mjs    # → loader-ext/bundled.js

# 2) 推到笔记本（SSH + scp，密钥见下）
#    loader-ext/{bundled.js,background.js} → %APPDATA%\OCS Desktop\downloads\extensions\netclass-loader\
#    dist/netclass.user.js + userscript/App.js → %LOCALAPPDATA%\TaskMesh\netclass\

# 3) 让加载器重新读代码（改 background.js 后必须）
node scripts/loader-reload.mjs 9224

# 4) 页面生效：刷新页面，或手动补注入
node scripts/loader-inject-test.mjs 9224
```

`scripts/deploy.mjs` 封装了上面大部分步骤。

### 3.5 部署一致性核对（改完代码「不生效」时先做这个）

远端跑的东西和仓库里的产物**必须逐字节一致**，否则你在改一份没人执行的代码。核对方法：

```powershell
# ① 本地哈希
Get-FileHash loader-ext\background.js, loader-ext\bundled.js, loader-ext\manifest.json, dist\netclass.user.js, userscript\App.js -Algorithm SHA256
# ② 远端哈希（扩展目录 + %LOCALAPPDATA%\TaskMesh\netclass  + 17800 实际服务的那份）
node scripts\nc.mjs run --file <列目录并 Get-FileHash 的脚本>
```

判据（2026-10-14 实测通过的状态）：

| 文件 | 远端位置 |
|---|---|
| `loader-ext/{background.js,bundled.js,manifest.json}` | `%APPDATA%\OCS Desktop\downloads\extensions\netclass-loader\` |
| `userscript/App.js` | `%LOCALAPPDATA%\TaskMesh\netclass\App.js` |
| `dist/netclass.user.js` | `%LOCALAPPDATA%\TaskMesh\netclass\netclass.user.js`，并且 **17800 的 `/netclass.user.js` 必须与它同哈希**（加载器注册的就是这份） |

顺带一条：`dist` 产物是可复现的——重跑 `build.mjs` + `build-loader.mjs` 后 `git status` 应保持干净；
不干净说明有源码没被构建进去。

### 3.2 SSH 连接参数

```
主机    WJX@192.168.1.8
密钥    C:/Users/Administrator/.ssh/taskmesh_windows_laptop_ed25519
特殊    HostKeyAlias=192.168.1.10（known_hosts 里按这个名记的）
```

`scripts/nc.mjs` 已内置这些参数，不用手写。

### 3.3 调试端口与 profile

| 端口 | 平台 | profile | 计划任务 |
|---|---|---|---|
| 9224 | shengsheng | `b33d3127b601404c8d0f694bb02939fa` | `NetClassVis-shengsheng` |
| 9225 | qiyang | `3a6e9e389f794785bb5048d4bf39a36c` | `NetClassVis-qiyang` |
| 9226 | webtrn（教师培训） | `7c4f1a92d3b64e0f8a5c2d6e9b1f4a37` | `NetClassVis-webtrn` |
| 17800 | 本机脚本服务 | — | `NetClassServer` |

（另有历史残留任务 `NetClassFreshTM` / `NetClassMatrix` / `NetClassProbe1-4`，可清理。）

### 3.4 关键启动参数

```
--no-sandbox                              计划任务上下文里 Chrome 沙箱起不来（exit=3 秒退），必需
--hide-crash-restore-bubble               去掉「Chromium 未正确关闭」气泡
--autoplay-policy=no-user-gesture-required 允许自动播放
--user-data-dir / --load-extension / --remote-debugging-port=92xx
--window-size=960,1032 --window-position=0,0|960,0   左右半屏
```

---

## 4. 运行手册

### 4.1 改代码后怎么生效

| 改了什么 | 生效方式 |
|---|---|
| `userscript/App.js` | 构建 → scp → **刷新页面**（或 `loader-inject-test.mjs` 补注入） |
| `loader-ext/background.js` | scp → **`loader-reload.mjs`（必须）**，Chrome 会缓存扩展脚本 |
| `loader-ext/bundled.js` | 同上（它是 background 依赖的副本） |

### 4.2 状态存储（排障时会用到）

| 键 | 位置 | 内容 |
|---|---|---|
| `netclass.cfg.v3` | localStorage | 配置（enabled / 倍速 / 各开关） |
| `netclass.bank.v3` | localStorage | 本地题库（题目 → 正确答案） |
| `netclass.done.<platform>` | localStorage | 「已刷完」标记（**刷新后仍显示提示且不自动跑**） |
| `nc.qy.done` | sessionStorage | qiyang 本轮已进过的章节（防重复跳转） |
| `nc.qy.completed` | sessionStorage | qiyang 站点确认完成（isEnd=1）的章节 |
| `nc.ss.parentUrl` / `nc.ss.currentCourse` | sessionStorage | shengsheng 层级返回地址 |
| `nc.ss.coursesDone` | sessionStorage | shengsheng 已完成的课程 |
| `lastSig` / `logRing` | chrome.storage.local | 加载器去重签名 / 日志环 |
| `deepseekKey` / `deepseekModel` | chrome.storage.local（扩展） | DeepSeek 凭据与模型名（`scripts/ds-key.mjs set` 写入；每个 profile 各一份） |
| `window.__NC_DS_KEY__` | 页面内存（MAIN world） | 由加载器随脚本注入的同上 key —— **只进内存**，刷新即消失，换 key 后重新 `set` 即可 |

**要重跑一遍**：删掉 `netclass.done.<platform>`，或在面板点「启动」（会一并清掉）。

### 4.3 常见症状 → 排查命令

| 症状 | 先看什么 |
|---|---|
| **想知道现在什么状态（先跑这个）** | `node scripts/status.mjs` —— 一屏给出隧道、两站页面、窗口、加载器、笔记本侧与告警 |
| 页面完全没反应 | `loader-log.mjs`（有没有 `registered`）+ `probe-page.mjs`（`module` 是否 true） |
| 视频不动 | `probe-page.mjs`（`readyState`/`duration`）+ `ss-logs.mjs`（有无报错） |
| 卡在某一课 | `ss-logs.mjs` 看有无「卡在结尾」「尚未被站点确认完成」 |
| 窗口不见 | `win-titles.mjs` + `status-check.ps1`（session 1 才有窗口） |
| 页面反复刷新 | `nav-trace.mjs`（看导航序列） |
| 弹题不答 | `quiz-state.mjs`（看是哪种状态）+ `ss-logs.mjs` |
| 加载器日志每 60s 一条 `registered` / 模块反复重启 | `status.mjs` 会直接点名「重复注册」；根因与修法见 §5.21 |
| 改完代码不生效 | 先核对部署一致性（§3.5）：`nc.mjs run --file <哈希脚本>` 比对远端与本地 SHA-256 |
| 倍速不对 | `measure.mjs`（实测速度，别信 `playbackRate` 属性） |
| 站点改了 | `ss-structure.mjs` / `ss-home.mjs` 重新摸 DOM |

---

## 5. 踩过的坑（按症状索引）★

这一节是这套代码最值钱的部分——每个坑都真实发生过。

### 5.1 油猴装得上但不执行
**症状**：脚本已注册、已启用，页面里就是不跑（连 hello world 都不跑）。
**根因**：TM 这条链在「OCS 内置 Chrome 137 + 未打包扩展 + 计划任务启动」下不可靠。
**修法**：自研 `loader-ext`，直接用 `chrome.userScripts` 注册。`ab7f566`

### 5.2 视频永不起播（`readyState` 恒为 0）
**症状**：播放器停在 `xgplayer-isloading`，`duration` 为 null。
**根因**：xgplayer/Aliplayer 走 MSE，**装载期间对 `<video>` 动手（尤其 `play()`）会打断起播**。
**修法**：`mediaReady(v)` 就绪闸门（`readyState>=2 && duration>0`），未就绪只静音不接管。`ab7f566`
**注意**：这个闸门后来造成过死锁（见 5.6），两个坑是一对。

### 5.3 弹题从不提交
**症状**：抓到了题、选了选项，但从不提交；`state.errors` 里刷 20 条。
**根因**：`pendingQuiz is not defined`（漏了声明，ReferenceError）。
**修法**：补声明。`614b4c8`

### 5.4 弹题永远不答
**症状**：弹窗挂着不动。
**根因**：`poll()` 在「没有视频」时提前 `return`，走不到答题分支。
**修法**：**弹题优先**——`poll()` 里先查弹窗，有就先答掉再管别的。`856b920`

### 5.5 加载器改了不生效
**症状**：`manifest.json` 版本已升，但 `background.js` 里的新函数全都不存在。
**根因**：**Chrome 缓存扩展脚本**。
**修法**：改完必须触发 `chrome://extensions` 的「重新加载」（`loader-reload.mjs`）。`e995b42`

### 5.6 播放器等一个点击、我的闸门在等数据 → 死锁
**症状**：播放器停在 `xgplayer-nostart`，视频永不加载。
**根因**：`mediaReady` 闸门要等有数据才播，但播放器要一次点击才去拉流。
**修法**：`kickStart()` —— 未开始态时点播放器**自己的开始按钮**（且仅在按钮可见时点）。
**不要**在这种情况下直接 `video.play()`，会重新踩 5.2。`e995b42`

### 5.7 「已完成」后视频自己又播起来
**症状**：标记完成后视频仍在播放。
**根因**：`kickStart()` 没检查 `CFG.enabled` / `state.allDone`，页面刚加载时会把视频踢起来。
**修法**：`kickStart` 首行加闸；tick 里已完成/已停用时**主动按停**；`markAllDone` 在 3/8/15 秒后再各按一次。`4f96f21`

### 5.8 shengsheng 倍速看起来「被站点禁止」
**症状**：设 2x，约 600ms 后被拉回 1x，持续不了多久。
**根因**：**我自己造成的**。配置里 `rateShengsheng: 1`，而 `ratechange` 监听里有段
「600ms 后强制拉回脚本目标倍速」的逻辑——**603ms 那个时间点就是我自己那个 600ms 定时器**。
**修法**：把脚本目标倍速对齐站点档位（shengsheng 1.5x / qiyang 2x，都用各自播放器自带的最高档）。
**教训**：排查「谁在改我的倍速」时，先把自己的定时器排除掉。`9568011`

### 5.9 窗口看不见
**症状**：浏览器起来了、端口通，但桌面上看不到。
**根因**：SSH 在 **session 0**，用户桌面是 **session 1**。从 SSH 直接启的进程落在 session 0。
**修法**：计划任务 + `/IT` 参数，才在 session 1 出可见窗口。`4d6a514`

### 5.10 PS 脚本报语法错误
**症状**：`Missing closing '}'`。
**根因**：脚本里的**中文注释经传输被打乱**，破坏了语法。
**修法**：`runs/remote/*.ps1` **新脚本一律纯 ASCII**（提交前校验 `non-ascii bytes = 0`）。`4d6a514`
**更正（2026-10-14 实测）**：历史脚本里**只有 22/68 个是纯 ASCII**，其余 46 个含非 ASCII（其中 36 个的非 ASCII 落在代码行）——
所以这条规则此前被写成了「全部已纯 ASCII」，与实际不符。现状是「没炸」而不是「已清干净」：
凡是改到某个远程脚本，顺手把它的非 ASCII 清掉（`status-check.ps1:10` 就是残留例子）。

### 5.11 弹窗卡在「回答错误」页
**症状**：弹窗停在「回答错误 / 正确答案：B / [再试一次][跳过]」，既不提交也不关闭，挡住播放器。
**根因**：只实现了「作答态」，没实现**答错态**（答错后平台换成结果页，脚本认不出来就干等）。
**修法**：`answerQuiz` 按三态分支：作答态 / 答错态（读 `.correct-answer-text` 吃答案 → 点「再试一次」）/ 答对态。`d9f11c8`

### 5.12 qiyang 章节无限跳转（看起来像疯狂刷新）
**症状**：窗口每 ~6 秒换一个页面，停不下来。
**根因**：`nextChapter()` 的兜底 `|| items.find(x => x.id !== curId)` **会绕回列表开头**；
若绕回的章节也是 `isEnd=1`，就永远绕圈。
**修法**：按「本轮已进过」清单只走没进过的，走完即停。`be9c72d`

### 5.13 `Cannot read properties of undefined (reading 'catch')`
**症状**：`applyPolicy` 里抛错，脚本半死。
**根因**：`pickVideo()` 把 **Aliplayer 的内部对象**（`window.aliplayer._video`）当成 `<video>` 返回了。
它不是 DOM 元素，`play()` 返回 undefined。
**修法**：`isMediaEl()` 校验（必须有 `play` 且含 `readyState`/`currentTime`）；`play()` 调用全加防御。`be9c72d`
**教训**：`err()` 记录调用栈前 3 帧，这个 bug 是靠它一枪命中的——排障函数里加栈很值。

### 5.14 倍速每 tick 都被重设（日志刷屏）
**症状**：`rateFixes` 数值恰好等于 `ticks`。
**根因**：判据用的是 Aliplayer 的 `getStatus().speed`，**该字段取不到**，于是永远判为「需要纠正」。
**修法**：改以 `<video>.playbackRate` 为准。`be9c72d`

### 5.15 视频卡在结尾，整课卡死
**症状**：视频停在 `duration - 0.2s`，播放器 `isloading`，`ended` 事件永不触发。
**根因**：`ended` 不触发 → 「结束→下一节」等不到。
**修法（两级）**：
1. 先 `v.currentTime = duration - 0.04` + `play()` —— **推过终点线**，让站点自己完成完播上报；
2. 推完 12 秒仍不完播，才走自行推进做兜底。
**注意**：**不能直接跳下一课**——站点会拦（见 5.16）。`3428d14`

### 5.16 弹窗「请按顺序观看视频」
**症状**：脚本切下一课时，站点弹 `van-toast`「请按顺序观看视频」。
**根因**：`goNext()` **从不检查当前课时是否已被站点确认完成**。视频一 ended 就立刻点下一课，
但站点是「先收完播上报 → 再刷新目录状态」，中间有几秒延迟，**抢跳就判为跳课**。
**修法**：跳转前轮询等当前课时在目录里变成「已完成」（`waitLessonDone`，最多 90s）；
`goNext()` 加硬校验；删掉「回到首个未完成」那条往回跳的兜底。`5414890`
**原则**：这是**遵守**站点的顺序校验，不是绕过它。

### 5.17 toast 误判（以为站点一直在拦）
**症状**：观察脚本报「出现弹窗 64 次」，但实际只拦过两三次。
**根因**：**Vant 的 toast 节点常驻 DOM**，隐藏后文案还在。直接读 `innerText` 会把历史提示当成本次拦截。
**修法**：`toastText()` 检查可见性（`offsetWidth/Height` + `display/visibility/opacity`）。`92be7b5`

### 5.18 加载器每 20~30 秒重复注册
**症状**：日志被 `registered remote ... build=xxxx` 刷满；页面里脚本反复重启（`壳已启动`/`旧实例已回收`），
**弹题要等好几分钟才答**（模块内存状态被反复清零）。
**根因**：`ensure()` **无条件调 `register()`**。虽然注入侧有版本比对（`已是最新版，跳过`），
但反复调用 `userScripts.register` 仍会让 Chrome 在各匹配文档重跑脚本。
**修法**：加内容签名（djb2 hash + source）持久化 `lastSig`，一致且非 `installed/startup/boot/manual` 就直接 return。`13ca9b2`

### 5.19 「全部完成」误报
**症状**：报「共 57 课全完成」，实际还有没看的课。
**根因**：课时列表**渲染有延迟**，读早了会把「还没渲染出状态」当成「全部已完成」。
**修法**：隔 4 秒**二次确认**，两次都干净才跳走。`2f64ea5`

### 5.20 单课完成 ≠ 全部完成
**症状**：跑完「心理学导论」就宣告全部完成并暂停，但账号下还有 12 个子课程、另一门课。
**根因**：脚本只在第三层循环，层级概念缺失。
**修法**：`ssLevel()` 三层分派 + 逐级回退（见 §1.3）。`2f64ea5`

### 5.21 去重「修好了」但只在一半配置上生效（加载器每 60s 重复注册）
**症状**：`loader-tail.mjs` 看某个 profile 的日志环，`registered remote ... build=xxxx` 每 60 秒一条，
页面模块反复重启（弹题要等好几分钟才答）；另一个 profile 却完全正常——**同一个扩展、同一份代码**。
**根因**：写入顺序。`register()` 里先落 `lastSource/lastAt/lastLen/lastBuildId`，
而 `lastSig` 是在 `register()` **返回之后**才写的（`background.js:143`），中间隔着
`injectIntoOpenTabs()` 一串 await。MV3 的 Service Worker 会在这个空档被回收：
**存储里其它四个键都在、唯独缺 `lastSig`**，下一个 alarm 读不到签名 → 再次注册 → 无限循环。
（2026-10-14 实测：qiyang 配置刷了一整晚 60 次，shengsheng 配置因为有早先写成功的一条而幸免。）
**修法**：把 `lastSig` 并进 `register()` 里紧跟 `userScripts.register()` 的那次 `storage.local.set`
（见 `loader-ext/background.js` 注释）；同时把 alarm 周期从 1 分钟改回 2 分钟，与本文档/README 对齐。
**识别手段**：`node scripts/status.mjs` 会直接报「重复注册」（判据：`lastSig` 缺失 + 日志里 ≥2 次 `registered`）。
**注意**：改完 `background.js` 必须重载扩展（§5.5），否则跑的还是缓存里的旧代码。

### 5.22 让页面「问大模型」比想象中难：四条路全被环境堵死
**背景**：弹题改成先问 DeepSeek（2026-10-14）。答题在页面里（要读 DOM、点选项、看站点回包），
但请求不能直接把 key 摊在页面里，于是试了四种"干净"走法，**全部实测失败**：

| # | 走法 | 结果 |
|---|---|---|
| ① | 自定义 world：`configureWorld({worldId:'netclass'})` + `register(world:'netclass')` | 抛 `Value must be one of MAIN, USER_SCRIPT`，**整批注册失败**，页面连脚本都没有（顺带把 §5.21 的去重也带崩：签名在 register 之后才写） |
| ② | `USER_SCRIPT` 世界 + `messaging:true` + CustomEvent 桥接 | 桥能跑，但隔离世界里 `chrome.runtime.sendMessage` **仍是 undefined**（Chrome 137） |
| ③ | manifest `externally_connectable` + 页面 `sendMessage`/`connect` | 页面里 API 确实出现了（`typeof === 'function'`），一发就 `Could not establish connection. Receiving end does not exist.`；**重启浏览器也一样** |
| ④ | 页面 fetch `http://127.0.0.1:17800` 让本机服务中转 | `Failed to fetch`（mixed-content / Private Network Access 拦死） |

**最后落地**：**SW 把 key 注入页面 + 页面直连 DeepSeek**。
- SW 从 `chrome.storage.local` 取 key，随脚本一起下发：`register()` 时拼在脚本前面，
  已开页面用 `userScripts.execute` 单独补一次（`window.__NC_DS_KEY__` / `window.__NC_DS_MODEL__`）；
- 页面 `dsSend()` 直接 `fetch('https://api.deepseek.com/chat/completions')` —— **DeepSeek 放行 CORS**（实测：
  带假 key 返回 401 而不是 CORS 报错）；
- key 只进页面内存：不写 localStorage、不落盘、不进仓库。

**代价与前提**：key 出现在 MAIN world，站点脚本理论上能读到（这是本环境里唯一跑得通的组合）。
要在意这点，就得先换一个 `messaging` 正常的 Chrome。

**key 管理**：`node scripts/ds-key.mjs set --key sk-xxx`（写进三个 profile 的扩展存储）、
`status`（看是否已配置，掩码显示）、`test`（走 SW 直连打一发，验证 key 与网络）。
换 key 后**不用**改任何文件，重新 `set` 一次即可（签名里带了 key 指纹，会自动重新下发）。

### 5.23 点一次「发表」把整个标签卡死（同步 XHR）
**症状**：`nc.mjs eval` 调 `NetClass.webtrn.reply(...)` 之后，CDP `Runtime.evaluate` 全部超时；
用另一个标签看，**回帖并没有落库**（「我的回帖(9条)」没变），而那个标签的 JS 线程一直是忙的。
`Page.handleJavaScriptDialog` 报 `No dialog is showing` —— 不是原生弹窗。
**根因**：站点的提交处理里有**同步 XHR**（`checkAndSaveReply` → 同步提交）。
同步请求会把渲染进程的主线程占住，于是调用方（我们的 `Runtime.evaluate`）一起被拖死。
**修法**：**异步点击** ——
```js
w.setTimeout(function(){ btn.click(); }, 30);   // 求值立刻返回，提交在下一个任务里跑
```
提交结果改用**轮询**判定（`NetClass.webtrn.check(idx)` 看计数/正文），不要指望点击同步返回（实测 4 秒内落库）。
**救活卡死的标签**：`Page.navigate({url: 原 URL})`（浏览器进程处理，卡死的渲染进程会被换掉）。
**顺带**：`autoConfirm(true)` 把 `confirm` 换成恒真、`alert` 只记日志（顶层 + 各讨论区 iframe 都装）——
这个站点的保存/提交路径会弹确认框，不接管就会卡在对话框上（同样是主线程忙）。

### 5.24 回帖按钮的匹配规则（第一次写错的地方）
`checkAndSaveReply(a, b)` 的 **第一个参数是"帖子 id 本身"**，不是回复框的 id：
回复框叫 `replyContent_<postId>`，而按钮 onclick 里写的是 `<postId>`。
同一个按钮**兼"展开回复框"和"提交"两用**：框里没内容就展开、有内容就提交 —— 所以必须**先填值再点**。
（2026-10-14 实测：按 `replyContent_` 去匹配按钮会一个都找不到。）
**验证回帖是否真落库**：别只看计数（「我的回帖(N条)」刷新才更新），要查**渲染出来的楼层**——
在非输入框元素里搜回复里的特征串，能搜到且带 `2026.10.14 13:50 <姓名>` 这样的时间戳才算成功。

### 5.25 webtrn 作业上传的链路与断点
**已打通**：`scripts/webtrn-attach.mjs` 用 CDP `DOM.setFileInputFiles` 把文件塞进
`.act_uploadArea` 里那个**隐藏的 uploadify input**（id 随机，如 `html5_1k4sf8u3t1csf1cn122tgb1ae23`）。
实测文件确实分片上传成功：`200 https://yunpan.sdk.webtrn.cn/api/chunkupload`，界面进度 100%。
**注意**：webtrn 的上传区在**笔记本**上跑，所以 `--file` 必须是笔记本本地绝对路径
（先 `scp` 推上去；`orders/` 目录要自己建）。
**还差最后一步**：上传完成后资源处于"待补元数据"状态。
平台自己的保存函数是 **`saveResource('<themeId>')`**，它先校验
`#resourceSubject_<themeId>` / `#resourceStage_<themeId>` 不能是「选择学科/选择学段」；
元数据字段按 itemId 组织：`select[name=subject_<itemId>]`、`select[name=stage_<itemId>]`、
`select[name=type_<itemId>]`、`input[name=title_<itemId>]`、`input[name=metaId_<itemId>]`。
**这些域都在隐藏容器里**（`offsetParent === null`），按"找可见输入框"的思路会一无所获 ——
直接按 name/id 赋值即可（隐藏元素照样能写值），再调 `saveResource('<themeId>')`。
同页还有 `showResource` / `uploadResource` / `deleteResource` 可用。
保存成功后「已有 N 份资源上传成功」才会 +1。
**副作用要清**：2026-10-14 的测试在「专业发展规划（研修心得）」下留了 **2 条重复的暂存资源**
（`div.a_u_row0.res_<itemId>_o_<uploadId>`，每条带 `#cancleResUpload_<itemId>` 取消链接，均未保存）；
下次重传前先点该链接清掉，否则保存时会两份一起提交。
**顺带**：webtrn 上**油猴也装了同名壳**，它会去 fetch `http://127.0.0.1:17800/App.js` 并被 CORS 拦掉
（控制台每几秒一条 `ERR_FAILED`），最后回退到内置 stub。不影响加载器注入的模块，但噪音很大；
要干净就把 OCS 脚本列表里 webtrn 那条停用。

### 5.26 webtrn 资源保存的真实字段与三条校验（2026-10-14 续查）
把 §5.25 的断点又推进一步，**记录已确认的事实**（下次从这里接着做，不要再从头猜）：

1. **平台限制每个活动项最多 1 份资源**。多传了不会报错，保存时弹 `提示 × 最多上传1个资源！`
   —— 上传前先点掉多余暂存行（`div.a_u_row0.res_<itemId>_o_<uploadId>` 里的「取消」）。
2. **保存校验读的是表单字段，不是列表行字段**：
   - 列表行（上传行自己的属性）：`select[name=subject_<itemId>]` / `stage_` / `type_`、`input[name=title_<itemId>]`
   - **保存真正读的**：`#resourceSubject_<itemId>`(`bean.peSubject.id`)、`#resourceStage_<itemId>`(`bean.peStage.id`)、
     `#resourceType_<itemId>`(`bean.enumConstByFlagResourceType.code`)、`#resourceTitle_<itemId>`(`bean.name`)、`#des_<itemId>`(`bean.intro`)
   - 学科/学段要填**选项 value**（形如 `8a85829983605d3c01836335a9`），类别填 code（研修作业=4），标题填文字。
3. **直接给 `bean.*` 赋值会被 UI 重置**（实测：刚写完 `resourceSubject_` 有值，保存前再查就空了），
   正确路径是**先打开该行的「属性」面板**（面板里是可见表单），在面板上填、用面板的「保存」提交。
   `showResource(themeId,count,flag,myResourceCount,myResource,themeType,ifStuUpload)` 是资源列表渲染函数，
   **不能只传 themeId 当"打开面板"用**（实测只传一个参数只会重渲染出空列表）。
4. 校验顺序（逐个出现，逐个补）：`请选择学科！` → `请选择学段！` → … → `标题不能为空！`
   —— 看到哪个提示就说明前一个字段已过，**按提示顺序补即可定位缺哪个字段**。
5. 上传本身没问题：`DOM.setFileInputFiles` **必须先点「上传我的资源」再塞**，塞完补发 input/change，
   否则 uploadify 不触发（进度恒 0）。成功时出现暂存行 `... 100% 取消`，云盘端点
   `200 https://yunpan.sdk.webtrn.cn/api/chunkupload`。

### 5.27 学习平台（zjdx-kfkc）的 SSO 入口必须带全参数
「查看作业」按钮的链接是拼出来的：
`https://zjdx-kfkc.webtrn.cn/learnspace/sign/signLearn.action?courseId=<课>&loginType=true&loginId=<学号>&sign=3&siteCode=zjdx&domain=<协议+主站域名>&classId=<班级>`
**少传 `domain` / `classId` 会让该页主线程直接卡死**（实测：无对话框、无网络活动、连 `Page.captureScreenshot` 都失败，
只能关标签重开）。带上完整参数后会正常 302 到
`/learnspace/learn/homework/blue/student/homework_index.action?...` —— 作业在那边交。
作业形态：`homework_doing.action?params.itemId=<id>`，「以附件形式上传」，有 `保存草稿` 与 `提交`（提交后不可改）。

### 5.28 webtrn 上传类活动的正确提交姿势（2026-10-14 打通）
**上传控件只给「当前步骤」初始化**：页面上 8 个 `.act_uploadArea`，但通常只有 1 个真正绑定了 uploadify
（`input[type=file]` 挂在 `#container_<itemId>` 里）。要传某个活动项，先点它的步骤 TAB
（`setTab('tabs',N,4,'<itemId>')`），必要时再手动 `showUpload(itemId,0,1,0,'',true)` + `initUpload(itemId)` 把控件唤起来。

**提交入口是 `uploadResource(themeId)`，不是 `saveResource(themeId)`**：后者是"编辑已有资源"用的
（要 `resourceId`，新传的没有 → 报"修改资源时出错"）。正确顺序：
① 点「上传我的资源」→ ② `DOM.setFileInputFiles` 塞文件 → ③ 补发 input/change →
④ 出现暂存行（`div.a_u_row0.res_<itemId>_o_<uploadId>`，显示 100%）后**立刻**填行级字段
`select[name=subject_/stage_/type_<itemId>]` + `input[name=title_<itemId>]` → ⑤ 调 `uploadResource(themeId)`。
成功后平台弹 **「上传成功！」**，活动页「资源数」+1（实测 68 → 70，两项都成）。
一条命令：`node scripts/webtrn-upload-submit.mjs --port 9226 --item <itemId> --file <笔记本绝对路径> --title "…"`

### 5.29 learnspace 作业提交的最后一下：`div.small_submit_comfirm`
作业页（`homework_doing.action`）点「提交」后弹**站内自绘**对话框：
`DIV.small_pop > DIV.small_pop_in > DIV.small_submit > DIV.small_submit_comfirm`
（文案"作业提交后，不能修改 是否提交？ 确认 取消"）。它不吃 `window.confirm` 覆盖，
也不一定吃 `el.click()`（实测点了仍停在对话框）→ 下一手改 **CDP `Input.dispatchMouseEvent` 真实鼠标点击**
该元素坐标。附件与保存草稿都正常（上传后显示 `附件：xxx.docx（40.36K）`）。

---

## 6. 站点事实速查

### 6.1 shengsheng（`edu.shengshengketang.com`）

**三层结构**见 §1.3。

**关键选择器**
| 用途 | 选择器 |
|---|---|
| 课程卡（L1） | `.classify-card`，标题 `.card-title` |
| 子课程状态（L2） | `span.state-tag`（文：学习中/未开始/已完成） |
| 课时项（L3） | `.lesson-item`，状态 `.lesson-status-container` |
| 当前课时 | `.lesson-item.active-lesson` |
| 播放器 | `.video-player`（xgplayer） |
| 弹窗 | `.pop-quiz-dialog` |
| 答错结果页 | `.result-section.incorrect` → 答案在 `.correct-answer-text` |
| 站点 toast | `.van-toast__text` |

**接口**
```
GET  /api/user/login/info                                        登录态
GET  /api/course/curriculum/tourist/selectDetail/{currId}         课程详情
GET  /api/course/vod/getPlayInfo?videoId&currId                   播放地址
POST /api/course/viewing/records/addCourseViewingRecords          观看进度上报（站点自己发）
GET  /api/exam/popQuiz/getByCourseAndNodeId?courseId&nodeId       随堂题
POST /api/exam/popQuiz/insertUserAnswer                           作答（回包 state: 2=对 3=错，附答案）
```

**其它事实**
- 视频走 MSE（HLS 分片），流来自 `video.mengkezaixian.com`
- 站点自带倍速菜单只有 1x / 1.25x / 1.5x（**1.5x 就是它自己的上限**）
- 实测播放器能接受 8x 属性值，但实际吞吐 **6x 封顶**，再高反而更慢（分片跟不上）
- 「请按顺序观看视频」是它的防跳校验（见 5.16）
- 有「当前视频不允许快进」的防拖拽提示

### 6.2 qiyang（`study.bjqiyang.com`）

- 章节页内联变量：`isEnd` / `current_time` / `getUrl`
- 站点自己的 `video.js` 负责上报：播放中每 300s / 拖动 >60s / 播放结束时，
  调 `getUrl + "&current_time=" + 秒`（`getUrl=/agent/MemberGoodscourses/finish?goodscourses_id=X`）
- 播放器全局对象 `player`，有 `setSpeed()`
- **倍速档位表本来含 2x**
- 36 个直播课脚本跳过（非录播）
- 视频是直链 MP4，媒体时钟能真的跑到 16x（Chrome 上限）

### 6.3 webtrn（`tea.webtrn.cn`，教师培训）

- 登录页 `/center/loginSmall.jsp`，字段 `#loginId` / `#passwd` / `#authCode`（验证码默认隐藏）
- 成绩构成：课程学习 40% / 研修作业 40% / 研修活动 20% / 资源共享 20%
- 研修活动页 `/project/template/guopei/newTeam/activity_view.jsp?activityId=…&teamId=…`
  四个标签页（`setTab('tabs',N,4,'<id>')`），前两个是评论类，后两个是上传类
- 作业列表 `/project/template/guopei/homework/student_homework_list.jsp`（正文 AJAX 加载）

---

## 7. 已知限制 / 未完成

1. **`--no-sandbox` 是必需的妥协**：计划任务上下文里 Chrome 沙箱起不来（exit=3 秒退）。
   若改从 OCS 面板点「运行」启动则不需要，但窗口就归 OCS 管。
2. **油猴仍然是坏的**：本环境里它不执行任何用户脚本。OCS 脚本列表里的条目仅作备用。
3. **多选题：类型识别单点依赖 `.question-type` 的文案**。作答路径本身是通的（多选会按
   `join(',')` 全部点击），2026-10-14 起答案由 DeepSeek 给（见 §5.22），**但"是不是多选"仍靠
   页面里 `.question-type` 是否渲染出「多选/不定项」**：取不到就会退成单选，DeepSeek 也只会给一个字母。
   拿到一道真实多选题时，日志里核对 `type` 与最终点击的选项数即可确认。
4. **DeepSeek 答题的边界**：key 由加载器注入页面内存（§5.22），所以**key 在页面里可见**；
   模型答错时仍走原有兜底——站点回传正确答案 → 点「再试一次」→ 用平台答案补交；
   DeepSeek 不可用（无 key / 网络不通 / 超时 20s）时自动回退到本地题库与启发式，不会卡住弹窗。
5. **直播课不处理**（qiyang 36 个）。
6. **窗口归属**：当前浏览器由计划任务在登录会话里启动（可见），OCS 面板显示为未运行。
   要让 OCS 托管：关掉窗口，在 OCS 点「运行」。
7. **历史残留计划任务**：`NetClassProbe*` / `NetClassUIA*` / `NetClassFreshTM` / `NetClassMatrix` /
   `NetClassTestNoExcept` 共 15 个已于 2026-10-14 清理，清理脚本固化在
   `runs/remote/cleanup-residue-tasks.ps1`（默认 dry run，`--args '-Apply'` 才真删；
   不碰 `NetClassVis-*`、`NetClassServer` 与任何 `TaskMesh-*`）。
   笔记本上 `TaskMesh-*` 侧仍有若干残留任务（`TaskMesh-Learning-Probe-*` 等），**属另一个项目，未处理**。
8. **webtrn 配置没开扩展开发者模式**：9226 那个 profile 的加载器日志是
   `'userScripts' API is only available for users in developer mode`，注册必失败；当前 `MATCHES`
   只有两个课程域，所以不影响现状。要在 webtrn 上跑脚本，先用 `ensure-devmode.mjs` 给它开。
9. **README 部分内容已过时**（仍写 shengsheng 1.00x、缺后面 10 来个修复）。
   以本文档和 `git log` 为准。

---

## 8. 排障心法

1. **先看日志，别先猜**。`ss-logs.mjs` + `loader-log.mjs` 基本能定位 80% 的问题。
2. **区分「我的代码」和「站点的行为」**。5.8 和 5.17 都是我把自己的行为/残留 DOM 当成了站点在拦。
   隔离方法：把 `CFG.enabled` 设 false 刷新，看站点自己表现如何。
3. **`err()` 记调用栈**。5.13 就是靠它一枪命中的，别删这几行。
4. **时序问题占大多数**。5.16 / 5.19 / 5.15 全是「读早了」或「写早了」。
   凡是「读页面状态做决策」的地方，都要考虑渲染延迟，宁可二次确认。
5. **站点改版后**：先用 `ss-structure.mjs` / `ss-home.mjs` 重新摸 DOM，再改选择器。
6. **每修一个坑，写清根因再提交**。`git log` 里那 21 条提交信息就是这套系统的病历本，
   比代码注释有用。
