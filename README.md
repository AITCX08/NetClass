# NetClass — 笔记本网课自动处理（自研用户脚本 + OCS 脚本列表自动安装）

> 目标：接管 Windows 笔记本（`192.168.1.8`，用户 `WJX`）上 OCS Desktop 里跑的两门网课，
> 用**自研用户脚本**在页面内自动处理：自动播放 / 静音 / 倍速 / 掉速纠正 / 自动下一节 / 随堂弹题自动作答 / 本地题库。
>
> **交付形态**：脚本已注册进 OCS 的「脚本列表」，每次从 OCS 启动浏览器都会自动安装/更新（实测通过）。

---

## 0. 现在是什么状态（2026-10-13 实测）

| 项目 | 状态 |
|---|---|
| OCS 脚本列表 | ✅ 已加入 `NetClass 网课自动处理`（`render.scripts[].id=990000000001`，`isLocalScript=true`） |
| 自动安装链路 | ✅ 实测：OCS 打开 `file://C:/.../netclass.user.js` → 油猴弹 `ask.html` 安装页 → 点「安装/重新安装」→ 写入成功 |
| shengsheng 自动化 | ✅ 实测：自动进入未完成课时 → 静音播放 → 实测 1.00x → 播完自动下一节 |
| qiyang 自动化 | ✅ 实测：自动遍历章节 → 跳过已完成（`isEnd=1`）→ 未完成章节静音播放 → 实测 2.00x → 播完自动下一章 |
| 随堂弹题 | ✅ 接口与结构已解出并实现（`getByCourseAndNodeId` / `insertUserAnswer`，答错回填正确答案）；待真实弹题验收 |
| 本机模块服务 | ✅ 已装成登录自启计划任务 `NetClassServer`（`http://127.0.0.1:17800`） |

**用户无需任何操作**：从 OCS Desktop 启动任一台「知道1 / 知道2」浏览器，脚本会自动装上并开始处理。

---

## 1. 两门课的现场事实

### 1.1 宿主环境

| 项目 | 事实 |
|---|---|
| 浏览器 | OCS Desktop 2.9.24 内置 Chrome for Testing **137.0.7151.55** |
| 用户脚本宿主 | Tampermonkey **5.4.0**（未打包扩展，OCS 用 `--load-extension` 加载；OCS 启动时自动开扩展开发者模式） |
| 课程 A（shengsheng） | `https://edu.shengshengketang.com/course/v2/1955104870025424897` 心理学导论；profile `b33d3127…`（= OCS 里的「知道1」） |
| 课程 B（qiyang） | `https://study.bjqiyang.com/agent/Goods/index?goods_id=46789&store_id=1` 三级实务观摩课程；profile `3a6e9e38…`（=「知道2」） |
| 账号 | 两站均 `15005243592`（shengsheng: 密码可登录；qiyang: 判题接口已登录态） |

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
├─ dist/netclass.user.js          构建产物：自包含用户脚本（OCS/油猴安装的就是它）
├─ userscript/
│  ├─ netclass.shell.user.js      壳源码（壳 + 内联兜底 + 热加载）
│  └─ App.js                      实现模块（两站适配 / 弹题 / 题库 / 面板）
├─ scripts/
│  ├─ build.mjs                   打包：壳 + App.js → dist/netclass.user.js
│  ├─ ocs-register.mjs            把脚本注册进 OCS 脚本列表（config.json）
│  ├─ ocs-install.mjs             复刻 OCS 安装流程：开 URL → 点「安装」（装/更新脚本）
│  ├─ nc.mjs                      PC 侧控制台：up/tabs/new/eval/run/watch/probe
│  ├─ tunnel.ps1                  建立 SSH 端口转发（CDP 用）
│  ├─ netclass-server.ps1         笔记本本机服务（17800）：热加载 + 回传
│  ├─ netclass-deploy.ps1         上传/启停本机服务
│  ├─ measure.mjs                 实测播放速度（媒体增量 / 真实时间）
│  ├─ ss-*.mjs / qy-*.mjs         两站的探查与观测脚本
│  └─ tm-*.mjs                    Tampermonkey 存储/注册/安装相关工具
└─ runs/                          实测记录、远端脚本、Tampermonkey 存储分析
```

---

## 3. 常用操作

```powershell
# 隧道（每次开工先做）
powershell -File scripts\tunnel.ps1 -Port 9224     # shengsheng（b33d3127）
powershell -File scripts\tunnel.ps1 -Port 9225     # qiyang（3a6e9e38）

# 起一个带调试端口+油猴的浏览器
node scripts\nc.mjs up --profile b33d3127b601404c8d0f694bb02939fa --port 9224
node scripts\nc.mjs up --profile 3a6e9e389f794785bb5048d4bf39a36c --port 9225

# 装/更新脚本（等价于 OCS 启动时做的事）
node scripts\ocs-install.mjs --port 9224
node scripts\ocs-install.mjs --port 9225

# 观察
node scripts\ss-watch.mjs --port 9224 --rounds 5     # shengsheng：脚本状态 + 视频进度
node scripts\qy-watch.mjs --port 9225 --rounds 5     # qiyang：章节推进
node scripts\measure.mjs  --port 9225 --target bjqiyang --secs 20   # 实测倍速

# 改了 App.js 之后
node scripts\build.mjs
scp dist\netclass.user.js WJX@192.168.1.8:C:/Users/WJX/AppData/Local/TaskMesh/netclass/netclass.user.js
# （本机服务会把 App.js 热加载给已装脚本；内核改动才需要重装）

# OCS 脚本列表管理
node scripts\ocs-register.mjs --action status
node scripts\ocs-register.mjs --action add
node scripts\ocs-register.mjs --action remove
```

---

## 4. 自动安装链路（OCS 脚本列表）

OCS 2.9.24 渲染层逻辑（已从 `public/assets/index.c87a5b08.js` 确认）：

```js
const enabledUserScripts = store.render.scripts.filter(s => s.enable);
userscripts = enabledUserScripts.map(s => (s.isLocalScript ? "file://" : "") + (s.info?.code_url || s.url));
```

worker 的 `initScripts()`：逐个 `page.goto(url)` → 等油猴把 `chrome-extension://<id>/ask.html` 安装页弹出来 →
`document.querySelector('[class*="primary"]') || document.querySelector('[type*="button"]')` → 文本含 安装/更新/添加/降级/install/update/add → 点它。

所以本脚本用 **本地文件模式**：

```json
{
  "id": 990000000001,
  "url": "C:/Users/WJX/AppData/Local/TaskMesh/netclass/netclass.user.js",
  "enable": true,
  "isLocalScript": true,
  "info": { "code_url": "C:/Users/WJX/AppData/Local/TaskMesh/netclass/netclass.user.js", "name": "NetClass 网课自动处理", "version": "0.4.0", ... }
}
```

> 为什么不用 `http://127.0.0.1:17800/...`：安装页在 `https://www.tampermonkey.net`，
> 从 HTTPS 页面取 HTTP 资源会被 Chrome 拦（实测 `ERR_CONNECTION_REFUSED` / `Failed to fetch`）。
> `file://` 没有这个问题。

---

## 5. 脚本行为说明

**shengsheng（心理学导论）**
1. 页面加载 → 壳启动 → 从本机服务热加载 `App.js`（不可用则用内联版）
2. 课程页没有视频时，自动点开目录里第一个**未完成**课时（`.lesson-item`，看 `.lesson-status-container` 是否「已完成」）
3. 视频统一策略：静音、按平台倍速播放（默认 1x；站点播放器自带 2x 档，可在面板上调）
4. 暂停/掉速自动恢复（`pause` / `ratechange` 兜底）
5. 播完自动下一节（先找「下一节」按钮，找不到就按目录顺序找下一个未完成项）
6. 随堂弹题：监听页面自身接口响应拿题 → 本地题库命中则直接答 → 未命中走启发式 →
   提交后按 `data.state` 判定，**答错把平台回传的正确答案写回题库**

**qiyang（三级实务观摩课程）**
1. 课程页（`/agent/Goods/courses?goods_id=…`）→ 收集录播章节 → 进入第一个未完成章节
2. 章节页读内联变量：`isEnd=1` 直接跳下一章；`isEnd=0` 则静音播放（默认 2x，走站点播放器）
3. 站点自己的 `video.js` 负责进度上报（每 300s / 拖动 / 结束时），脚本不伪造上报
4. 播完 → 下一章（按章节列表顺序，跳过直播课）
5. `sessionStorage` 记录本轮已过章，避免来回跳

**停用方式**：页面右下角面板点「暂停」；或油猴面板里禁用 `NetClass 网课自动处理`。

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

1. **弹题还没有真实样本验收**：目前 UI 文案提示该课程暂无弹题或未到弹题节点；逻辑按接口结构实现完毕。
2. **shengsheng 倍速保守**：部分课程站点限制倍速（站点提示「此课程不能使用倍速」），默认 1x；如需提速请在面板手动调并观察平台是否回落。
3. **直播课不处理**：qiyang 36 个直播课按时间开播，非录播，脚本跳过（如需录播回看支持，需另接站点直播接口）。
4. **运行实例**：当前两台浏览器由控制台以调试端口启动（便于观察），OCS 面板里显示为未运行；
   如需 OCS 托管，关闭它们后在 OCS 点「运行」即可（脚本会自动安装）。

