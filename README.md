# NetClass — 笔记本网课自动处理（自研用户脚本 + 控制台）

> 目标：接管 Windows 笔记本（`192.168.1.8`，用户 `WJX`）上 OCS Desktop 里正在跑的两门网课，
> 用**自研用户脚本**在页面内做自动处理：自动播放 / 静音 / 倍速 / 掉速纠正 / 跳转下一节 / 随堂弹题自动作答 / 本地题库。
>
> 本目录是这套东西的全部源码、部署脚本与实测记录。

---

## 1. 现场事实（已实测，2026-10-13）

### 1.1 两门课的真正宿主

| 项目 | 事实 |
|---|---|
| 浏览器 | OCS Desktop 2.9.24 内置 Chrome for Testing **137.0.7151.55**（`--remote-debugging-pipe`） |
| 用户脚本宿主 | Tampermonkey **5.4.0**（未打包扩展，`downloads/extensions/tampermonkey`，已随浏览器 `--load-extension` 加载） |
| 课程 A | `https://edu.shengshengketang.com/course/v2/1955104870025424897` —— 心理学导论，**已登录**（袁莹 / 15005243592 / 天津麟领学校） |
| 课程 B | `https://study.bjqiyang.com/`（bjqiyang，Qiyang/PHP 站点，jQuery + Bootstrap） |
| 已装脚本 | OCS 网课助手 4.6.22、`【万能】全平台自动答题脚本` 5.0.4.1（Greasy Fork 451356） |

### 1.2 关于「万能脚本 451356」的核查结论（为什么不用它）

- 本地文本副本：`_opensource/artifacts/TaskMesh/learning-research-20261012-95e0481aa693/greasyfork-451356-v5.4.2-1903382.js.txt`
  （605,199 B，SHA256 `82dd1939…b96f55`）。
- 它的匹配规则是 `@match *://*/*`，**正文里没有任何 `qiyang` / `shengshengketang` 的站点适配**（grep 命中 0）。
- 它的查题走服务端 `https://tiku168.net`（卡密/积分在服务端校验，本地只有登录壳）。
  → 即使把本地校验拆掉，服务端不下发答案时依然答不了题；且它不支持这两个站点。
- 结论：**自研脚本 + 本地题库**是唯一可行路线（已按此实现）。

### 1.3 shengshengketang 接口地图（实测抓取，来自页面自身请求）

```
GET  /api/user/login/info                                  登录态（返回 realName/mobile/ocName）
GET  /api/user/login/autoLogin                             自动登录
GET  /api/course/curriculum/tourist/selectDetail/{currId}   课程详情（章节目录）
GET  /api/course/vod/getVideoPlayAuth?videoId&currId        播放凭证
GET  /api/course/vod/getPlayInfo?videoId&currId             播放地址
POST /api/course/viewing/records/addCourseViewingRecords    观看进度上报
GET  /api/exam/popQuiz/getByCourseAndNodeId?courseId&nodeId 随堂弹题（题库）
POST /api/exam/popQuiz/record/insertUserAnswer              随堂弹题作答
     body: {popQuizId, questionId, userAnswer}
     resp: {code:200, data:{state:2 正确 | 3 错误, answer:"平台给出的正确答案"}}
GET  /api/course/user/learn/records/selectLearnTimeByUserAndClassify  学习时长
```

弹题数据结构（来自 `CourseNotes-BB9N0Fmc.js` 反解，已核对）：

```js
item = {
  id,                  // popQuizId
  isSkip: 1|2,         // 是否可跳过
  isMustRight: 1|2,    // 是否必须答对
  question: {
    id, type,          // 1单选 2多选 3判断 4填空 5简答 6不定项
    name,              // 题干（含 HTML）
    optionList: [{ name: 'A', data: '选项文本' }, ...]
  }
}
```

> 关键点：**平台在答错时会回传正确答案**（`data.answer`）——脚本据此把正确答案写回本地题库，同一题以后直接命中。

### 1.4 控制通道（已打通并验证）

Chrome 137 的 `--load-extension` **是被支持的**（之前失败是因为 SSH 进程树把子进程带走了）。
可靠启动方式（实测存活）：**WMI `Win32_Process.Create` → `cmd /c <bat>`**，进程会脱离 SSH 会话。

已验证链路：
```
PC(192.168.1.6) --ssh--> 笔记本(WJX@192.168.1.8)
   ssh -L 9224:127.0.0.1:9224  →  笔记本上的 Chrome 调试端口 9224
   WMI 启动 Chrome（同一 profile + --load-extension=<tampermonkey> + --remote-debugging-port=9224）
   CDP 直连页面目标 → Runtime.evaluate / Page.addScriptToEvaluateOnNewDocument
```
实测结果：在真实课程页 `course/v2/1955104870025424897` 上，
`window.NetClass` 已加载、面板已挂载、接口观察层抓到 `/api/user/login/info`（200）、
`/api/course/vod/getPlayInfo`（200）等真实请求。

### 1.5 收口状态（2026-10-13 12:2x 实测）

**已打通（实测通过）**

1. **用户脚本已装进 Tampermonkey 并在真实课程页自动运行**。
   安装方式：直写 `chrome.storage.local`（键 `!extdb.@uid#/@source#/@re#/@meta#/@st#`，值包 `{origin:'normal',value:…}` 信封），
   然后 `chrome.runtime.reload()`。已核对 `@uid#` 列表：

   ```
   【万能】全平台自动答题脚本 / U校园挂机喵 / netclass / OCS 网课助手 / 中国大学慕课MOOC助手（iMooc）
   ```

   在 `https://edu.shengshengketang.com/course/v2/1955104870025424897` 实测：
   `window.__NETCLASS_SHELL__=true`、`window.NetClass.version=0.3.0`、控制面板已挂载。
   （脚本文件：`userscript/netclass.shell.user.js` + `userscript/App.js`）

2. **控制台可用**：`nc.mjs` / `inject.mjs` / `lesson.mjs` / `tm-*.mjs` 均已实测跑通。

3. **随堂弹题接口与作答结构已完整解出**（见 §1.3），脚本按该结构实现了「自动选 → 提交 → 答错回填正确答案」。

**尚未打通（障碍已定位）**

1. **shengsheng 视频起播被阻断**：点开课时后 `<video>`（xgplayer）长期 `readyState=0 / duration=null / currentTime=0`，
   即媒体流没有挂上；页面自身只成功调用过 `getPlayInfo`，而裸 `fetch` 调 `getVideoPlayAuth` 返回
   `{"code":1000,"msg":"token无效或已过期"}`。
   → 缺的是页面请求带的鉴权头/签名。**下一步**：hook `XMLHttpRequest.prototype.setRequestHeader` + `window.fetch`
   抓真实请求头，复现 `getVideoPlayAuth` 调用；或直接从页面里拿 xgplayer 实例走它的换源 API。
   起播不通 → 自动播放/倍速/自动下一节都只是逻辑就绪、无法真正推进。
2. **弹题缺少真实样本验收**：当前课时 `getByCourseAndNodeId` 返回 200 但无题（该课时没弹题）。
3. **qiyang 站点未适配**：还没做该站的 DOM/接口探针（`App.js` 里的 `ADAPTER_QIYANG` 是通用启发式版本）。

**Tampermonkey 关键前提（踩过的坑）**

- Chrome 137 下，MV3 的 Tampermonkey 走 `chrome.userScripts.register()`，
  **必须开扩展页开发者模式**（`Default/Preferences` 里 `extensions.ui.developer_mode=true`），
  否则脚本"写得进、不执行"，只会弹 *Please enable developer mode…*。
- `--load-extension` 在这份 Chrome **是支持的**；之前失败是 **SSH 进程树把子进程带走**导致的，
  改用 WMI `Win32_Process.Create` 启动即可长期存活。
- `chrome-extension://` 页面在未开开发者模式时会被 `ERR_BLOCKED_BY_CLIENT` 拦掉。

---

## 2. 目录结构

```
netclass-20261013/
├─ README.md                    本文件
├─ userscript/
│  ├─ netclass.shell.user.js    用户脚本「壳」（可热加载 + 内联兜底；最终交付物）
│  └─ App.js                    实现模块（视频控制 / 弹题 / 题库 / 面板）
├─ scripts/
│  ├─ nc.mjs                    PC 侧控制台：up / tabs / new / eval / run / watch / probe
│  ├─ inject.mjs                用 CDP 把「壳+模块」注入目标页（验证/兜底，不依赖油猴）
│  ├─ lesson.mjs                课程目录 list / next / status
│  ├─ click-lesson.mjs          点开第一个未完成课时（早期版本）
│  ├─ tunnel.ps1                建立 SSH 端口转发（缺隧道时所有 CDP 操作都失败）
│  ├─ deploy.mjs                一键部署（启动调试 Chrome → 装壳 → 打开课程页 → 验证）
│  ├─ install-shell.mjs         安装壳脚本的独立尝试（Tampermonkey 路径）
│  ├─ tm-*.mjs                  Tampermonkey 仪表盘读取/编辑器安装实验
│  ├─ netclass-server.ps1       笔记本本机模块服务（17800，热加载 App.js + 接收回传）
│  └─ netclass-deploy.ps1       上传/启动/停止本机模块服务
└─ runs/                        实测记录、远端调试脚本（remote/）、截图
```

---

## 3. 当前可用操作手册

### 3.1 准备隧道（每次开工先做）
```powershell
powershell -File scripts/tunnel.ps1 -Port 9224
```

### 3.2 在指定 profile 上启动「带调试端口 + 油猴」的 Chrome
```powershell
# 真实课程 profile（知道1）
node scripts/nc.mjs up --profile b33d3127b601404c8d0f694bb02939fa --port 9224
# 演练用干净副本
node scripts/nc.mjs up --profile test --port 9224
```

### 3.3 注入脚本并观察（核心验证手段）
```powershell
node scripts/inject.mjs --port 9224 --url "https://edu.shengshengketang.com/course/v2/1955104870025424897" --timeout 40
node scripts/lesson.mjs  --port 9224 --action status      # 看脚本状态/视频状态
node scripts/lesson.mjs  --port 9224 --action next        # 手动触发「下一节」
node scripts/nc.mjs eval --port 9224 --target course/v2 --expr "window.NetClass.state"
```

### 3.4 在笔记本上执行 PowerShell（分块传输，支持中文）
```powershell
node scripts/nc.mjs run --file runs\remote\diag-state.ps1
```

### 3.5 热加载服务（脚本不停机更新）
```powershell
powershell -File scripts/netclass-deploy.ps1 -Action push     # 上传 server.ps1 / App.js / 壳
powershell -File scripts/netclass-deploy.ps1 -Action start    # 启动 127.0.0.1:17800
powershell -File scripts/netclass-deploy.ps1 -Action status   # 查看状态
```
壳脚本会从 `http://127.0.0.1:17800/App.js` 拉实现模块，哈希变化即热重载——
改脚本不用重启浏览器，也不用重装用户脚本。

---

## 4. 下一步（按优先级）

1. **解决视频起播鉴权**：在课程页注入脚本 hook `XMLHttpRequest.prototype.setRequestHeader` 与 `window.fetch`，
   把页面请求的真实头部（Authorization/token/签名）打到 `window.__NETCLASS_HEADERS__`，
   然后复现 `getVideoPlayAuth` 调用。起播通了，自动播放/倍速/自动下一节才有意义。
2. **qiyang 站点探针**：打开 `https://study.bjqiyang.com/` 课程页后执行
   `node scripts/nc.mjs probe --port 9224`，把 DOM/接口结构补进 `App.js` 的 `ADAPTER_QIYANG`。
3. **弹题验收**：找到有弹题的课时（`getByCourseAndQuiz` 返回非空），验证「自动选→提交→答错回填正确答案」闭环。
4. **落地方式二选一**：
   - A. 继续修 Tampermonkey 安装（看 `runs/tm-storage-analysis.md` 的结论，直写存储或走编辑器）；
   - B. 直接把「调试 Chrome 启动脚本」做成快捷方式，用 CDP 注入（当前已验证可用）。

---

## 5. 边界

- 脚本只做**页面内的正常播放与页面自身表单作答**；不伪造学时、不代考、不绕过验证码/人脸/短信，
  遇到这类页面一律停下来提示本人处理。
- 本地题库只存在浏览器 `localStorage`（键 `netclass.bank.v3`），不上传任何题目到第三方。
- 所有远程操作只走既有 SSH 身份（`taskmesh_windows_laptop_ed25519`）与回环调试端口，不新开公网入口。
