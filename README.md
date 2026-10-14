# NetClass — 笔记本网课自动处理（自研用户脚本 + OCS 脚本列表自动安装）

> **接手这套代码请先读 [docs/HANDOVER.md](docs/HANDOVER.md)** —— 架构、代码地图、部署流程、
> 排障手册、20 个坑的成因（按症状索引）。本文档偏「现状快照」，可能滞后于代码；
> 以 HANDOVER 和 `git log` 为准。

> 目标：接管 Windows 笔记本（`192.168.1.8`，用户 `WJX`）上 OCS Desktop 里跑的两门网课，
> 用**自研用户脚本**在页面内自动处理：自动播放 / 静音 / 倍速 / 掉速纠正 / 自动下一节 / 随堂弹题自动作答 / 本地题库。
>
> **交付形态**：脚本已注册进 OCS 的「脚本列表」，每次从 OCS 启动浏览器都会自动安装/更新（实测通过）。

---

## 0. 现在是什么状态（2026-10-13 实测）

| 项目 | 状态 |
|---|---|
| **脚本运行方式** | ✅ **自研加载器扩展**（`loader-ext/`）用 `chrome.userScripts` 直接注册并执行；**不依赖油猴** |
| 自动加载链路 | ✅ 扩展放在 `OCS Desktop\downloads\extensions\netclass-loader\`，OCS 每次启动浏览器自动扫描加载 |
| shengsheng 自动化 | ✅ 实测：自动进入未完成课时 → 静音播放 → **实测 1.00x** → 播完自动下一节；随堂弹题自动作答 |
| qiyang 自动化 | ✅ 实测：自动遍历章节 → 跳过已完成 → **实测 1.95~2.00x** → 播完自动下一章 |
| 随堂弹题 | ✅ **答案由 DeepSeek 给**（`ds-key.mjs` 配 key）；答错时用站点回传的正确答案补交；DS 不可用才回退本地题库/启发式 |
| 本机模块服务 | ✅ 登录自启计划任务 `NetClassServer`（`http://127.0.0.1:17800`）；加载器每 2 分钟拉最新脚本 |

**用户无需任何操作**：浏览器一起来，加载器扩展自动注册脚本，两站自动开跑。

### 0.1 两个关键坑（都踩过并已修）

**坑 1：Tampermonkey 在 OCS 内置 Chrome 137 里「装得上、不执行」**

排查链：`chrome.userScripts` API 可用 → TM 桥接脚本已注册且确实在页面里跑起来（存在名为「篡改猴」的 isolated world）
→ TM 存储里有脚本且启用 → **但任何用户脚本都不注入**（连 3 行 hello world 都不跑）。
用 `chrome.userScripts.register({js:[{code:'...'}]})` 自己注册却能自动注入 —— 证明能力没问题，是 TM 这条链在
「未打包扩展 + 计划任务启动 + `--no-sandbox`」这套环境下不可靠。

→ 解决：**写自己的加载器扩展**，把「注册 + 执行」这层自己做掉。OCS 会扫描扩展目录自动加载，交付方式不变。

**坑 2：脚本在播放器初始化阶段调 `video.play()` 会打断起播**

xgplayer / Aliplayer 走 MSE，装载期间对 `<video>` 动手会让播放器卡在 `xgplayer-isloading`，
`readyState` 永远 0、`duration` 为 null —— 这正是最初「shengsheng 视频不起播」的真凶。
（隔离验证：关掉脚本 → 手动点课时 → 视频正常 `readyState=4, duration=921`。）

→ 解决：`mediaReady(v)` 就绪判定，只有 `readyState>=2 && duration>0` 之后才接管播放/倍速/续播。

### 0.2 运行现状

- 两台浏览器跑在**用户登录会话**里（窗口可见）：`--no-sandbox` 是必须的（计划任务上下文里 Chrome 沙箱起不来，会秒退 exit=3）
- shengsheng 走 **1.5x**、qiyang 走 **2x** —— 都用各自站点播放器**自带的最高档**
- 脚本只做页面内正常播放 + 页面自身表单作答，不伪造学时、不跳课（站点有「请按顺序观看视频」防跳校验）


---

## 1. 两门课的现场事实

### 1.1 宿主环境

| 项目 | 事实 |
|---|---|
| 浏览器 | OCS Desktop 2.9.24 内置 Chrome for Testing **137.0.7151.55** |
| 用户脚本宿主 | Tampermonkey **5.4.0**（未打包扩展，OCS 用 `--load-extension` 加载；OCS 启动时自动开扩展开发者模式） |
| 课程 A（shengsheng） | `https://edu.shengshengketang.com/course/v2/1955104870025424897` 心理学导论；profile `b33d3127…`（= OCS 里的「知道1」） |
| 课程 B（qiyang） | `https://study.bjqiyang.com/agent/Goods/index?goods_id=46789&store_id=1` 三级实务观摩课程；profile `3a6e9e38…`（=「知道2」） |
| 账号 | 两站同一手机号账号（真实号码不出现在仓库里；凭据只留在笔记本本地） |

### 1.2 关于「万能脚本 451356」的核查结论（为什么不用它）

- 本地文本副本 605,199 B（SHA256 `82dd1939…b96f55`），`@match *://*/*`。
- **正文里没有任何 `qiyang` / `shengshengketang` 的站点适配**（grep 命中 0）。
- 查题走服务端 `https://tiku168.net`（卡密/积分服务端校验，本地只有登录壳）——拆壳也拿不到答案，且不支持这两站。
- 结论：**自研脚本 + 本地题库**是唯一可行路线（已按此实现）。

### 1.3 shengsheng 接口地图（实测抓取）

```
GET  /api/user/login/info                                   登录态
GET  /api/course/curriculum/tourist/selectDetail/{currId}    课程详情（章节目录 .lesson-item）
GET  /api/course/vod/getVideoPlayAuth?videoId&currId         播放凭证
GET  /api/course/vod/getPlayInfo?videoId&currId              播放地址（播放器实际走这个）
POST /api/course/viewing/records/addCourseViewingRecords     观看进度上报
GET  /api/exam/popQuiz/getByCourseAndNodeId?courseId&nodeId  随堂弹题（题库）
POST /api/exam/popQuiz/record/insertUserAnswer               随堂弹题作答
     body: {popQuizId, questionId, userAnswer}
     resp: {code:200, data:{state:2 正确 | 3 错误, answer:"平台给出的正确答案"}}
```

弹题数据结构（从站点 chunk 反解并核对）：

```js
item = { id, isSkip:1|2, isMustRight:1|2,
         question: { id, type /*1单选 2多选 3判断 4填空 5简答 6不定项*/,
                     name, optionList:[{name:'A', data:'选项文本'}, ...] } }
```

> 关键点：**平台答错时会回传正确答案**（`data.answer`）——脚本把它写回本地题库（`localStorage: netclass.bank.v3`），同题下次直接命中。

### 1.4 qiyang 接口/页面机制（从站点 `video.js` 反解）

页面内联变量（每个章节页都有）：

```js
var source = 'https://oss.bjqiyang.com/kms/.../xxx.mp4?UCloudPublicKey=...';  // 视频直链
var goodscourses_exper = '0';      // 试看秒数（0 = 无试看限制）
var isEnd = '0'|'1';              // 本章是否已完成
var current_time = '1234.56';     // 上次观看位置（站点自动 seek 续播）
var getUrl = "/agent/MemberGoodscourses/finish?goodscourses_id=XXXX";  // 进度上报端点
```

- 播放器：Aliyun Aliplayer（`window.player`，方法 `getCurrentTime/getDuration/play/pause/seek/setSpeed/getStatus`）。
- 站点自己的上报：`$.getJSON(getUrl + "&current_time=" + 秒)`，在 **播放中每 300s / 拖动>60s / 播放结束** 时触发。
- 章节列表：`.chapter-list a[href*=goodscourses_id]`；分「直播课」与「新章节（录播）」，脚本只处理录播。
- 直播课（36 个）是定时直播，未开始/已结束的无法当录播看，脚本跳过。

---

## 2. 目录结构

```
netclass-20261013/
├─ README.md                      本文件
├─ dist/netclass.user.js          构建产物：自包含脚本（加载器注册的就是它）
├─ loader-ext/                    ★ 加载器扩展（真正干活的执行宿主）
│  ├─ manifest.json               MV3，permissions: userScripts
│  ├─ background.js               启动/每2分钟：拉最新脚本 → chrome.userScripts 注册 → 补注入已开标签页
│  └─ bundled.js                  构建产物：内置脚本副本（拉不到服务时用）
├─ userscript/
│  ├─ netclass.shell.user.js      壳源码
│  └─ App.js                      实现模块（两站适配 / 弹题 / 题库 / 面板 / 播放就绪判定）
├─ scripts/
│  ├─ build.mjs                   打包：壳 + App.js → dist/netclass.user.js
│  ├─ build-loader.mjs            生成 loader-ext/bundled.js
│  ├─ ocs-install.mjs             复刻 OCS 安装流程（往油猴装脚本；现在只作备用通道）
│  ├─ ocs-register.mjs            把脚本注册进 OCS 脚本列表（备用通道）
│  ├─ ensure-devmode.mjs          开扩展开发者模式（诊断用）
│  ├─ nc.mjs                      PC 侧控制台：up/tabs/new/eval/run/watch/probe
│  ├─ status.mjs                  一条命令监控总览（隧道/页面/窗口/加载器/笔记本侧）
│  ├─ ds-key.mjs                  DeepSeek key 管理（set/status/test；key 只进笔记本的扩展存储）
│  ├─ tunnel.ps1                  SSH 端口转发（CDP 用）
│  ├─ netclass-server.ps1         笔记本本机服务（17800）：提供最新脚本 + 回传
│  ├─ netclass-deploy.ps1         上传/启停本机服务
│  ├─ measure.mjs                 实测播放速度
│  ├─ probe-page.mjs              通用页面探针（视频/脚本状态）
│  ├─ ss-*.mjs / qy-*.mjs         两站的探查与观测脚本
│  └─ tm-*.mjs                    Tampermonkey 存储/注册/安装/诊断工具
└─ runs/                          实测记录、远端脚本
```

---

## 3. 部署与常用操作

### 3.1 首次/更新部署

```powershell
# 1) 构建
node scripts\build.mjs          # → dist/netclass.user.js
node scripts\build-loader.mjs   # → loader-ext/bundled.js

# 2) 上传到笔记本（加载器扩展目录 + 本机服务目录）
#    loader-ext\* → %APPDATA%\OCS Desktop\downloads\extensions\netclass-loader\
#    dist\netclass.user.js + userscript\App.js → %LOCALAPPDATA%\TaskMesh\netclass\
```

### 3.2 启动浏览器（可见窗口，登录会话内）

```powershell
node scripts\nc.mjs run --file runs\remote\launch-loader.ps1
```

要点（少一个都不行）：
- 用**计划任务 + `/IT`** 启动，才能在用户桌面会话里出窗口（SSH 里直接起是 session 0，看不见）
- 必须 **`--no-sandbox`**（计划任务上下文里 Chrome 沙箱起不来 → exit=3 秒退）
- `--load-extension` 传**逗号分隔的两个目录**：tampermonkey + netclass-loader

### 3.3 观察与验证

```powershell
node scripts\status.mjs                              # ★ 一条命令看全貌（有告警时退出码 1）
node scripts\probe-page.mjs 9224 shengshengketang    # 视频/脚本状态
node scripts\probe-page.mjs 9225 bjqiyang
node scripts\measure.mjs --port 9224 --target shengshengketang --secs 15   # 实测倍速
node scripts\nc.mjs run --file runs\remote\launch-loader.ps1               # 重启两站
```

### 3.4 改了 App.js 之后

两种生效方式：
- **快**：`build.mjs` + `build-loader.mjs` → scp `bundled.js` 到扩展目录 → 页面刷新（或等加载器 2 分钟轮询）
- **自动**：scp 新的 `netclass.user.js` 到 %LOCALAPPDATA%\TaskMesh\netclass\ → 加载器 2 分钟内拉取并重新注册 →
  新开的页面自动用新版


---

## 4. 执行宿主：自定义加载器扩展

### 4.1 为什么不用油猴

排查过的事实：`chrome.userScripts` API 可用、油猴桥接脚本已注册且确实在页面里执行（存在名为「篡改猴」的
isolated world）、存储里脚本存在且启用、开发者模式已开、「允许运行用户脚本」开关已开、站点访问权限正常
—— **但任何用户脚本都不注入**（连 3 行 hello world 都不跑）。

同时验证：自己调 `chrome.userScripts.register({js:[{code:'...'}]})` **能**自动注入。
结论：能力没问题，是油猴这条链在 OCS 内置 Chrome 137 + 未打包扩展 + 计划任务启动这套环境下不可靠。

### 4.2 加载器怎么工作

```js
// background.js 核心
await chrome.userScripts.configureWorld({ worldId: 'netclass', csp: "...", messaging: false });
await chrome.userScripts.register([{
  id: 'netclass-user-script',
  matches: ['https://edu.shengshengketang.com/*', 'https://study.bjqiyang.com/*'],
  js: [{ code }],                 // ← 注意：这个 Chrome 只接受 {code} 对象，不接受裸字符串
  runAt: 'document_start',
  allFrames: false,
  world: 'MAIN'                   // 必须在主世界，才能操作页面 DOM 和站点播放器
}]);
```

- 启动 / 安装 / **每 2 分钟**：从 `http://127.0.0.1:17800/netclass.user.js` 拉最新脚本；拉不到就用 `bundled.js` 内置副本
- 注册后还会**补注入已打开的标签页**（解决「页面比扩展先加载」的竞态）
- OCS 每次启动浏览器会 `getExtensionPaths(extensionsFolder)` **扫描扩展目录全量加载**，所以放进去即生效，无需改配置

### 4.3 备用通道：OCS 脚本列表

`render.scripts` 里仍保留 `NetClass 网课自动处理`（`isLocalScript=true`，指向本地 `netclass.user.js`），
油猴能正常工作时也会装上。当前它不执行，实际执行由加载器承担。

---

## 5. 脚本行为说明

**shengsheng（心理学导论）**
1. 页面加载 → 壳启动 → 用内置实现（主世界下无法跨域拉本机服务）
2. 课程页没有视频时，自动点开目录里第一个**未完成**课时（`.lesson-item`，看 `.lesson-status-container`）；
   若点了没出播放器会**重试**（12 秒一次，最多 6 次）
3. **等播放器就绪**（`readyState>=2 && duration>0`）后才接管：静音、按平台倍速播放
4. 暂停/掉速自动恢复（就绪判定后生效）
5. 播完自动下一节（先找站点「下一节」按钮，找不到就按目录顺序找下一个未完成项；**排除自己的面板按钮**）
6. 随堂弹题：监听页面自身接口响应拿题 → **问 DeepSeek 拿答案**（key 由加载器注入）；
   按 `insertUserAnswer` 返回的 `state`（2 对/3 错）判定，**答错把平台回传的正确答案补交**；
   DeepSeek 不可用时才回退到本地题库/启发式

**qiyang（三级实务观摩课程）**
1. 课程页 → 收集录播章节 → 进入第一个未完成章节
2. 章节页读内联变量：`isEnd=1` 直接跳下一章；`isEnd=0` 则静音播放（默认 2x，走站点播放器 `setSpeed`）
3. 站点自己的 `video.js` 负责进度上报（每 300s / 拖动 / 结束时），脚本不伪造上报
4. 播完 → 下一章（按章节顺序，跳过直播课）
5. `sessionStorage` 记录本轮已过章，避免来回跳

**停用方式**：页面右下角面板点「暂停」；或在 `chrome://extensions` 里禁用 `NetClass Loader`。

---

## 6. 边界

- 脚本只做**页面内的正常播放与页面自身表单作答**：不伪造学时、不代考、不绕过验证码/人脸/短信；遇到这类页面会停下来等本人处理。
- 本地题库只存浏览器 `localStorage`（键 `netclass.bank.v3`），不上传任何题目到第三方。
- 倍速使用站点播放器**自带**的倍速档位（qiyang 站点播放器列表含 2x）；不修改播放器以外的任何东西。
- 所有远程操作只走既有 SSH 身份（`taskmesh_windows_laptop_ed25519`）与回环调试端口，不新开公网入口。
- 已做的持久化改动：`OCS config.json`（备份 `.netclass-bak`）、油猴存储（新增脚本条目）、
  `b33d3127` 的 `Preferences`（开发者模式，备份 `.netclass-bak`）、计划任务 `NetClassServer`。

---

## 7. 待办 / 已知限制

1. **`--no-sandbox` 是必需的妥协**：计划任务上下文里 Chrome 沙箱起不来（exit=3 秒退），只能关沙箱。
   若改为从 OCS 面板点「运行」启动，则不需要这个参数（但那样窗口由 OCS 管理）。
2. **油猴仍然是坏的**：本环境里它不执行任何用户脚本。加载器已完全替代它，OCS 脚本列表里的条目仅作备用。
3. **直播课不处理**：qiyang 36 个直播课按时间开播，非录播，脚本跳过（如需回看支持，需另接站点直播接口）。
4. **弹题判定回写待二次验证**：已实测「抓到题 → 作答 → 弹窗关闭」，平台判定回包与题库回填逻辑已实现，
   待再遇到新弹题时确认计分。
5. **窗口归属**：当前两台浏览器由计划任务在登录会话里启动（可见），OCS 面板显示为未运行。
   若要让 OCS 托管：关掉窗口，在 OCS 点「运行」即可（扩展会自动加载，脚本自动注册并运行）。
6. **随堂题作答依赖 DeepSeek**：key 用 `node scripts/ds-key.mjs set --key sk-xxx` 写进扩展存储
   （三个 profile 各一份），答题时由加载器把 key 注入页面内存供页面直连 api.deepseek.com。
   key 不进仓库、不写 localStorage；**但它在页面 MAIN world 里可见**（本环境唯一跑得通的组合，
   原因见 HANDOVER §5.22）。DeepSeek 超时/无 key 时会自动回退本地题库与启发式，不会卡住弹窗。
7. **webtrn（9226）配置没开扩展开发者模式**：那个 profile 里 `chrome.userScripts` 不可用，
   加载器注册必失败（日志：`only available for users in developer mode`）。当前不影响两门课，
   要在 webtrn 上跑脚本先用 `scripts/ensure-devmode.mjs` 给它开。
8. **加载器去重已在 2026-10-14 修好**（`lastSig` 写入时机 + 扫描周期回到 2 分钟）；
   以后遇到「日志每 60s 一条 registered」直接跑 `node scripts/status.mjs`，它会点名。
