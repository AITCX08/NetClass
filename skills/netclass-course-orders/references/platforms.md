# 平台登记表（已知平台事实）

> 事实来源：2026-10-14 实机核对 + `docs/HANDOVER.md`。改站点后回来更新本表。

## 运行环境

| 项 | 值 |
|---|---|
| 笔记本 | **`config/local.json` 的 `ssh.target`**（不要写死在文档里：2026-11-21 从 `192.168.1.8` 换到 `192.168.100.133`，同一局域网）。密钥 `C:/Users/Administrator/.ssh/taskmesh_windows_laptop_ed25519`，`HostKeyAlias=192.168.1.10`（按这个别名 pin，换 IP 不用重新 accept） |
| 浏览器 | OCS Desktop 内置 Chrome 137（`--no-sandbox` 必需；计划任务 `/IT` 才在登录会话出窗口）；Chrome for Testing 137 固定在 `C:\Users\WJX\AppData\Local\NetClass\browser\137.0.7151.55\chrome-win64\chrome.exe` |
| 本机脚本服务 | 笔记本 `http://127.0.0.1:17800`（计划任务 `NetClassServer`）：`/netclass.user.js`、`/App.js`、`/ping`、`/status` |
| 本机隧道 | 控制端 `127.0.0.1:<端口>` ← `ssh -L`（`pwsh -File scripts/tunnel.ps1 -Port <端口>`） |
| 部署目录（笔记本） | 脚本/部署产物 **`E:\Desktop\NetClass\app`**（2026-11-21 从 `%LOCALAPPDATA%\TaskMesh\netclass` 迁入，`server.ps1 -Root` 指这里）；扩展 `%APPDATA%\OCS Desktop\downloads\extensions\netclass-loader\` |
| 每单做单记录 | 笔记本 **`E:\Desktop\NetClass\orders\<yyyy-MM-dd>-<单位简称>\`**（`README.md` + `artifacts\` + `evidence\`，规范见 `orders\README.md`） |
| 远程执行器 | `scripts/ssh-exec.ps1 -File <ps1> -Arg '<ps 语句>'`：scp + `-File` 执行，UTF-8 BOM 落盘（PS 5.1 才能读中文），参数注入在 `param()` 之后（避开 `$Profile` 等自动变量） |
| Session 1 截图 | `scripts/remote/capture-screen.ps1`：SSH 在 Session 0 看不到/截不到用户桌面，脚本自查会话后经 Interactive 计划任务自转 Session 1 |

## 平台对照

| | shengsheng | qiyang | webtrn | **huayi** | **smartedu-cn** |
|---|---|---|---|---|---|
| 域名 | `edu.shengshengketang.com` | `study.bjqiyang.com` | `tea.webtrn.cn` | **`jcpxkh.91huayi.com`** | **`basic.smartedu.cn`**（登录走 `auth.smartedu.cn`） |
| 调试端口 | **9224** | **9225** | **9226** | **9231 / 9250**（多实例） | **9260** |
| profile 目录 | `b33d3127b601404c8d0f694bb02939fa` | `3a6e9e389f794785bb5048d4bf39a36c` | `7c4f1a92d3b64e0f8a5c2d6e9b1f4a37` | 每实例独立 | `E:\Desktop\NetClass\instances\smartedu` |
| 计划任务 | `NetClassVis-shengsheng` | `NetClassVis-qiyang` | `NetClassVis-webtrn` | `NetClassVis-huayi` / `-huayi2` | `NCVis-smartedu` |
| 内容形态 | 视频课 + 随堂弹题（单选/多选/判断） | 录播 MP4 章节（+36 个直播课，跳过） | 研修活动（发帖/回帖）+ 研修作业（含论文） | **直播回放（长视频）+ 录播 50 学时 + 调研问卷** | **教师研修录播课**（1~N 个资源/课），需实名认证 |
| 当前自动化 | ✅ 全自动（播放/倍速/弹题/逐级推进） | ✅ 全自动（逐章播放/跳过已完成） | ⚠️ **只读监看**（提交类动作未接，需订单方授权） | ✅ 登录 + 开播 + 1x 保活 + 播完轮转（`huayi-watch.mjs`） | ✅ 人工登录接管会话 + 逐资源跳尾 + 卡片截图 |
| 适配器 | `ADAPTER_SHENGSHENG`（App.js:698 起） | `ADAPTER_QIYANG`（App.js:927 起） | `ADAPTER_WEBTRN`（只读；App.js 内搜 id: 'webtrn'） | 无适配器对象，走 `PLATFORM_RATES.huayi=[1]` + 驱动器脚本 | 无适配器对象，走 `scripts/smartedu-*.mjs` 驱动器 |
| 倍速 | 站点自带最高 **1.5x**（强设 2x/2.5x/3x/4x **都会被立即拉回 1.5x**；想更快只能多标签并行） | **2x**（播放器档位表含 2x） | — | **严格 1x**（连 1.25x 都杀播放器，见下） | **不必倍速**：记账按播放位置，跳尾即可 |
| 多路并行 | ✅ 同账号多标签各自推进 | — | — | ❌ **单账号单路**（第二个播放页被掐）；多账号 + 多端口才行 | ❌ **必须串行**（记账按播放器当前持有的课） |
| 扩展开发者模式 | 已开 | 已开 | ❌ **未开** → 先 `node scripts\ensure-devmode.mjs --port 9226` | 不需要（走 CDP 注入 + `inject-guard`） | 不需要（纯 CDP 驱动） |


## shengsheng 站点事实

**多标签并行 ✅（2026-10-14 实测）**：同一浏览器里同时打开同一账号的两个大课程目录，**两边会各自独立推进**
（40s 观察：A 推进 93.3s=1.53x，B 推进 91.1s=1.50x，都 playing、都静音、都照常上报，无互踢/无互相暂停）。
机制：模块是**每标签一个实例**（各自的 `window.NetClass`），进度上报各页自发、站点按课时记，所以互不干扰。
代价：两路 MSE 同时解码占带宽/CPU，且两页都要保持不被浏览器冻结。
看多页状态：`node scripts/ss-multi-state.mjs 9224`；测并行与倍速：`node scripts/ss-parallel-speed.mjs 9224 40`。

三层结构：`/home`（课）→ `/record/sub/<id>?classifyId=…`（子课程）→ `/course/v2/<id>`（课时）。
**逐级回退**：L3 跑完回 L2，L2 跑完回 L1，不许跳级（否则把"子课完成"误当"全部完成"）。

| 用途 | 选择器 |
|---|---|
| 课程卡（L1） | `.classify-card` / `.card-title` |
| 子课程状态（L2） | `span.state-tag`（学习中/未开始/已完成） |
| 课时项（L3） | `.lesson-item` / `.lesson-status-container` / 当前 `.active-lesson` |
| 播放器 | `.video-player`（xgplayer，走 MSE） |
| 弹题 | `.pop-quiz-dialog`；答错页 `.result-section.incorrect` → 答案在 `.correct-answer-text` |
| 站点 toast | `.van-toast__text`（**常驻 DOM**，必须查可见性才算"弹出"） |

接口：`/api/course/vod/getPlayInfo?videoId&currId`（播放地址）、
`GET /api/exam/popQuiz/getByCourseAndNodeId?courseId&nodeId`（拿题）、
`POST /api/exam/popQuiz/insertUserAnswer`（`state:2`=对 `3`=错，**错时回包带正确答案**）。
防跳：跳下一课前必须等目录里当前课时变「已完成」（`waitLessonDone`，最多 90s），否则弹「请按顺序观看视频」。

## qiyang 站点事实

两层：`/agent/Goods/courses?goods_id=<id>&store_id=<id>` → 章节页 `?goodscourses_id=<id>`。

页内内联变量（适配器用 `siteVars()` 读）：`isEnd`（本章完成）、`current_time`（上次位置）、
`getUrl`（站点自己的上报端点 `/agent/MemberGoodscourses/finish?goodscourses_id=X`）、`source`（MP4 直链）。
播放器 `window.player`（Aliplayer，`setSpeed()`）。**站点自己上报**（每 300s / 拖动 >60s / 播放结束），脚本不代发。
循环防护：`sessionStorage` 记「本轮进过」（`nc.qy.done`）与「已确认完成」（`nc.qy.completed`），
兜底的 `|| items.find(...)` 会绕回列表开头 → 别写回退式挑选。

## webtrn 站点事实（教师培训）

- 登录页 `/center/loginSmall.jsp`：`#loginId` / `#passwd` / `#authCode`（验证码默认隐藏）。
- 研修活动页 `/project/template/guopei/newTeam/activity_view.jsp?activityId=…&teamId=…`：
  4 个活动项通过 `setTab('tabs',N,4,'<id>')` 切换 —— 前两个**研讨类**（评论/讨论，正文在子 iframe
  `taolun/learn/courseTopicAction.action?itemId=…`），后两个**上传类**（研修心得 / 教学设计稿，带
  `input[type=file]` 与 `intro_*`/`des_*` 文本域）。
- 作业列表 `/project/template/guopei/homework/student_homework_list.jsp`（正文 AJAX 加载）。
- 交付物是**内容**：研修活动正文走 `course-order-desk`，论文走 `paperwriter-api`；
  提交由模块的写路径 API 完成（见下）。

### webtrn 写路径 API（`window.NetClass.webtrn`，2026-10-14 实测）

| 方法 | 用途 |
|---|---|
| `frames()` / `frame(i)` | 讨论区 iframe 列表（同源，可直接操作 DOM） |
| `posts(i)` | 读第 i 个讨论区的帖子：`{postId, text}` —— 回帖前先读，才能回得对口 |
| `reply(i, postId, text)` | 回帖；**异步点击**（同步 XHR 会卡死标签，见 HANDOVER §5.23） |
| `newTopic(i, text)` | 发帖（顶层编辑器 + `#editor_area`） |
| `check(i)` | 回执自检：`{counter:'我的回帖(N条)', replyBoxes}` |
| `autoConfirm(true)` | 接管 `confirm/alert`（顶层 + 各 iframe），不然保存/提交会卡在确认框 |
| `homework()` | 上传类活动的正文域（`intro_<itemId>`/`des_<itemId>`）与附件位 |
| `fillHomework(ref, text)` / `clickByText(label)` | 填正文 / 按文字点按钮 |

**回帖的判定**：不能只看「我的回帖(N条)」（刷新才更新）——要在**非输入框元素**里搜回复正文的
特征串，命中且带 `时间 + 姓名` 才算落库成功。

### 作业上传：链路与断点（下次从这里接着做）

```powershell
# 1) 文件推到笔记本（浏览器在笔记本上跑，路径必须本地存在）
scp -i <key> <本地 docx> WJX@192.168.1.8:C:/Users/WJX/AppData/Local/TaskMesh/netclass/orders/<name>.docx
# 2) 列上传区 / 塞文件
node scripts\webtrn-attach.mjs --port 9226 --list
node scripts\webtrn-attach.mjs --port 9226 --index 0 --file "<笔记本绝对路径>" [--save]
```

- **已打通**：`DOM.setFileInputFiles` → uploadify 隐藏 input（`.act_uploadArea input[type=file]`，id 随机）
  → 分片上传成功（`200 https://yunpan.sdk.webtrn.cn/api/chunkupload`，界面 100%）。
- **还差**：元数据 + 保存。面板是**隐藏容器**（直接找可见输入框一无所获），字段按 `itemId` 组织：
  `select[name=subject_<itemId>]` / `select[name=stage_<itemId>]` / `select[name=type_<itemId>]` /
  `input[name=title_<itemId>]` / `input[name=metaId_<itemId>]`；
  保存走平台自己的函数 `saveResource('<themeId>')`，它会校验
  `#resourceSubject_<themeId>`、`#resourceStage_<themeId>` 不等于「选择学科/选择学段」。
  平台侧还有 `showResource` / `uploadResource` / `deleteResource` 可用。
- **副作用（要清）**：2026-10-14 的测试在「专业发展规划（研修心得）」下留了 **2 条重复的暂存资源**
  （`div.a_u_row0.res_<itemId>_o_<uploadId>`，各带 `#cancleResUpload_<itemId>` 取消链接，未保存）。
  重传前先点「取消」清掉，否则保存时两份会一起提交。
- webtrn 上**油猴也装了同名壳**，会去 fetch `http://127.0.0.1:17800/App.js` 被 CORS 拦掉（控制台噪音），
  最后回退 stub；不影响加载器注入的模块，要干净就在 OCS 脚本列表里停用 webtrn 那条。

### 学习平台（learnspace）的研修作业：完整流程（2026-10-14 打通）

研修作业**不在 tea 站**，在另一个域名 `zjdx-kfkc.webtrn.cn/learnspace/`，从 tea 站「查看作业」SSO 过去。
**SSO 入口必须带全参数**（缺 `domain`/`classId` 会把页面主线程卡死，连截图都失败）：

```
https://zjdx-kfkc.webtrn.cn/learnspace/sign/signLearn.action
  ?courseId=<课程id>&loginType=true&loginId=<学号>&sign=3&siteCode=zjdx
  &domain=<encodeURIComponent(主站域名)>&classId=<班级id>
```

流程（一条命令一步，都已脚本化）：

```powershell
# 1) 打开作业入口（带全参数）→ 落到 homework_index
node scripts\webtrn-hw2.mjs 9226 <courseId> 14
# 2) 进作业并提交（附件 → 保存草稿 → 提交 → 真实鼠标点确认）
node scripts\ls-homework-submit.mjs --port 9226 --item <doing页URL里的itemId片段> \
     --file "C:\Users\WJX\AppData\Local\TaskMesh\netclass\orders\<订单>\<要求的文件名>.docx" --submit
```

**三条硬规则**（踩过才写下来的）：
1. **文件名照抄详情的《…》**：详情写"上传提交一份《我的研修心得》"→ 文件必须叫 `我的研修心得.docx`。
   传成别的名字虽然能上传成功，但**不符合要求**。重传前先点附件旁的「删除」。
2. **提交确认框是站内自绘的**：`DIV.small_pop > DIV.small_pop_in > DIV.small_submit > DIV.small_submit_comfirm`，
   `el.click()` 和覆盖 `window.confirm` 都无效 → 必须用 **CDP `Input.dispatchMouseEvent` 点它的中心坐标**。
3. **验收看平台状态**：`homework_complete.action` + 正文出现「作业提交成功！」「附件：<名字>」；
   index 页显示「教师批改中」才算数（列表页可能是缓存，别拿它当唯一判据）。

**提交不可撤销**（页面原文："作业一旦确定提交，则不可更改"）→ 提交前核对：文件名、字数、姓名单位、是否残留占位符。

### 抓「课程事实」的命令（生成论文/心得之前必做）

论文/心得要落地到这门课，就必须先把课程事实抓出来（否则 paperwriter 只能写空话）：

```powershell
# 1) 课程清单（tea 站首页）
node scripts/webtrn-nav.mjs --port 9226 --match "generalControl_index" --dump
#    → 「课程学习」表：课程名称 / 模块 / 层次 / 操作（温故知新｜继续学习）

# 2) 单门课的章节与小节（进课程页后 dump，含每节标题与时长）
node scripts/page-dump.mjs 9226 "<课程页URL里的关键字>" 20000
#    或直接在页面里取目录树：
node scripts/nc.mjs eval --port 9226 --target "<域名子串>" --expr "JSON.stringify(Array.from(document.querySelectorAll('[class*=chapter],[class*=lesson],[class*=catalog]')).map(function(e){return (e.innerText||'').replace(/\s+/g,' ').slice(0,60)}).filter(Boolean).slice(0,40))"

# 3) 课程简介/讲师/案例（视频页与简介区）
node scripts/nc.mjs eval --port 9226 --target "<域名子串>" --expr "(document.body.innerText||'').replace(/\s+/g,' ').slice(0,1500)"
```

**把结果写进订单目录 `00_课程事实.md`**，再用它当 `paperwriter --requirements` 的输入；
生成后用同一份词表校验命中数（<3 视为无课程痕迹，重生成）。

## 其它已登记事实

- 报告上报：`CFG.reportBase = http://192.168.1.6:17999`，**仓内没有 17999 服务端**，`report:false`（默认关）。
- 加载器匹配域：`MATCHES`（background.js）+ `host_permissions`（manifest）两处都要加；改完必须
  `loader-reload.mjs <端口>`。
- DeepSeek：key 存扩展 `chrome.storage.local`（`scripts/ds-key.mjs`），由 SW 注入页面内存供页面直连。

---

## chaosxing（学习通 超星）

| 项 | 值 |
|---|---|
| 域名 | `*.chaoxing.com`（courseId=266554494 / clazzId=153244493）|
| 调试端口 | **9227**（隧道 `scripts\tunnel.ps1 -Port 9227`）|
| 适配器 | `ADAPTER_CHAOXING`（App.js 内搜，约 1366 行起）|
| 驱动 | `scripts/cx-auto.mjs --port=9227 --secs=10`；计划任务 `NetClass-CxDriver` 守护 |
| 答题 | `scripts/cx-answer-quiz.mjs --port 9227 --submit --limit N` |
| 提交看门狗 | `scripts/cx-submit-watch.mjs --interval=30`（填了没提交时自动交）|
| 当前自动化 | ✅ 全自动（视频 1.5x / 章测试答题+提交 / 资料阅读 / PPT 翻页）|

### ★ 完成判据（唯一可靠的那个）

树上每个任务点里有个 `span.roundpoint`，**类名**就是状态：
```js
"roundpoint blue"              → 已完成
"roundpoint orange01 jobCount" → 未完成
```
**⚠️ 不要用 `.jobUnfinishCount`** —— 那元素虽然存在（59 个），但 **innerText 全是空的、且是 hidden**，
按它计数只会得到 `0/59` 这种没意义的结果（面板和驱动日志都因此错过）。

### 坑（都踩过）

| 现象 | 原因 | 做法 |
|---|---|---|
| 面板进度恒显示 `0% (0/91)` | `progressInfo()` 用了 `a[href*="studentstudy"]`（实际树是 `[onclick^=getTeacherAjax]`，**JS 渲染无 href**）+ 要求节点自身带编号文本（文字在祖先 `.ncells` 里）| 改用上面的 `roundpoint` 判据（2026-10-15 已修，实测 21/67）|
| 判断题选项取不到文本 → `askDs` 报"题目没有可读选项" | 「对/错」渲染成 `<b class="ri">/<b class="wr">` **图标**，`li.innerText` 为空 → 旧代码 `if (txt)` 把两个选项都丢掉 | 从 `input.value` 的 `true/false` 反推「对/错」并归一成 A/B（已修）|
| 直接开 `studentstudy?chapterId=` 报 `enc校验失败` | 缺站点加密上下文 | 用站内 AJAX：`window.getTeacherAjax(courseId, clazzId, chapterId)` |
| 提交后只"保存"不"提交" | `#enc` 由异步 `validateTimeNew` 写入，空 enc = 只保存 | 提交后**等 ~16 秒**看 `enc` 是否写入（已修，实测拿到 `enc:74014caa...`）|
| 章节测试 `enc` 写入被 alert 打断 | 原生 `alert` 阻塞 JS 线程 → 所有 `Runtime.evaluate` 超时 | hook `Page.javascriptDialogOpening` 自动关闭 |
| 有任务点永远不完成 | "资料阅读/PPT"里**没有题**的那种，旧逻辑 45 秒就 `skip`，回补时走同样逻辑 → 永远漏 | 加"**停留+复查**"：延长到 120 秒，每 8 秒复查 blue 数是否增加（2026-10-15 已修）|
| AJAX 切点后视频不下载（`readyState=0`）| 媒体没开始 | **显式 `video.load()`**（超星是普通 mp4）。但**只在 rs=0 且 duration=0 时用**，有数据/在播时调它会清空媒体 |
| 页面冻住（所有 eval 超时）| 疑似原生 alert 阻塞 | `Page.reload`（走浏览器进程，JS 线程卡住也能生效）|

### 任务点形态（顺序推进）

`视频` / `章测试`（答题+提交）/ `资料阅读`（有题的走答题；无题的走停留计时）/ `PPT`（34~52 张 img + 页码导航，无翻页按钮 → 逐页点页码）

---

## ccjyxy（长春教师培训）

| 项 | 值 |
|---|---|
| 域名 | `col.ccjyxy.cn` |
| 调试端口 | **9228**（隧道 `scripts\tunnel.ps1 -Port 9228`）|
| 适配器 | `ADAPTER_CCJYXY`（2026-10-15 补：此前 `P_ADAPTER` 对它**是 null**，所以面板"进度"永远显示 `—`）|
| 驱动 | `scripts/cc-auto.mjs --port=9228 --tab=0 --secs=10`（仓库内另有 `--tag` 参数支持多实例认领）|
| 当前自动化 | ✅ 全自动（逐门课逐段播放 / 换段换课 / 学时自动结算）|

### ★★ 三条硬约束（实测，别试）

1. **同账号只能一个播放会话**：开第二个标签 → `POST /api/v1/video-progress/report` 返回 **423 Locked** → HLS 全 `ERR_FAILED`、`readyState` 恒 0。**并行加速这条路是死的。**
2. **进度上报被服务端钳位**：把 `currentTime` 设到 927s，服务端只收到 296→536 —— **按真实观看秒数记账**；跳到尾部只会触发播放器从头重播。
3. **记账硬卡 1.25x**：视频播 2x/3x 都只记 **1.25x**（实测 +75s/分）。→ **想不浪费就要用 1.25x**（视频与记账同步到终点，一次过）；用 2x 时每段要重播约 1.6 次。

### 接口地图

```
GET  /api/v1/me/my-trainings-progress        → learned_score / required_score / completed_courses / total_courses
GET  /api/v1/video-progress/resource?resource_id=N  → max_position_sec / duration_sec / completed
GET  /api/v1/completions/my                  → 已结算的课程（带 completed_at）
GET  /api/v1/completions/check?irm_course_id=N
GET  /api/v1/media/play/<JWT>                → 播放令牌（payload 含 training_id/course_id/resource_id）
POST /api/v1/video-progress/report
鉴权：Authorization: Bearer <localStorage.access_token>   ← 只带 cookie 会 401
```
口径：**学时进度**（`learned_score / required_score`），不是资源数 —— 平台是"整门课全部看完才结算学时"。

### 坑

| 现象 | 原因 | 做法 |
|---|---|---|
| 面板"进度"永远 `—` | `P_ADAPTER` 的链条里 ccjyxy 落到 `null`（只定义了 4 个平台）| 补 `ADAPTER_CCJYXY`；`progressInfo()` 是**同步**的，不能发 fetch → 用 `poll()` 30s 刷缓存 |
| **卡在同一段无限重播**（实测 27 分钟）| 平台播放器**自己循环**，采样抓不到 `cur>=dur-1.5` 那一瞬 | `waitSegment` 加"**回卷判据**"：历史最高位置到过末尾且已回卷 → 判播完 |
| **视频停在末尾时死循环**（每 4 秒一行日志、永不换段）| 分支只 `log+sleep+continue` **无状态改变**；且只设 `mode='COURSE'` 也没用（COURSE 分支要求 `s.onCourse`，而页面还在播放器）| **真的点「返回课程列表」**离开播放器，找不到则回培训页兜底 |
| 一直重播已完成的段 | 段选择按 DOM 顺序取第一个 | **两轮优选**：先找 `播放/继续`，没有才退到 `重播` |
| 页面播放器被 SPA 拆掉 | 播放器短命 | **页内 300ms 猎捕器**（`installHunter`），不是刷新 |
| 倍速被拉回 1x 且无人察觉 | `setInterval` **静默死亡**但 `__ccHunt` 残留旧 ID → `installHunter` 误判 `already` | 加**心跳自检** `__ccHuntBeat`（>5s 没跳就重装）|
| 面板"倍速修正"数字疯涨（424→1732）| **模块 `effRate()` 与猎捕器 `ncCc:rate` 目标值不一致** → 模块每 tick"纠正"一次但被 setter 忽略 → 假计数 | 两边对齐同一值；并把 `ccinject.mjs` 改为 import `cc-lib.mjs` 的 `HUNTER_JS`（单一来源）|

### 判完成

**只认平台 API 的 `completed` 标志**（`/api/v1/video-progress/resource`）+ `/api/v1/completions/my`；
**不要**只信页面 `cur/dur`。整课结算的证据：`learned_score` 从 0 变 2.0、`completions` 里出现带 `completed_at` 的记录。

---

## zhihuishu（智慧树 / 知到）— 2026-10-15 接入

| 项 | 值 |
|---|---|
| 域名 | `studyvideoh5.zhihuishu.com`（学习页）/ `login.zhihuishu.com` / `www.zhihuishu.com`（门户）/ 学堂页在新域名 `hike-teaching-center.polymas.com` |
| 学习页 | `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=<hex>`（大学生安全教育：recruitId=471743 / courseId=1000007048 / classId=13316156）|
| 调试端口 | **9229**（隧道 `scripts\tunnel.ps1 -Port 9229`）|
| 启动器 / 计划任务 | `runs/remote/start-zhihuishu.ps1` → `NetClassVis-zhihuishu`（/IT 登录会话）；profile `…\userDataDirs\zh9f3c2a1b8d7e6504` |
| 适配器 | `ADAPTER_ZHIHUISHU`（App.js 内搜；`ZHS_MINIMAL` 见下方"反检测"）|
| 当前自动化 | ✅ 只读监看+进度统计；✅ **弹题识别/解析/决策**（`NetClass.zhs.popupInfo()`）；✅ **作业/考试卷子解析**（`NetClass.zhs.examInfo()`）；▶️ 点击由 CDP 侧驱动（`runs/zhs-quiz.mjs` 弹题、`runs/zhs-exam.mjs` 作业/考试）|

### 入口铁律（踩过 3 次）

1. **必须从"我的学堂"点课程卡片新开标签**进学习页；**直接 `location.href=` 或 F5 刷新** → 站点 404 → 跳回 `www.zhihuishu.com`（实测多次，URL 一模一样也不行）。
2. 学堂页点卡片**单击**即可（`runs/cdp-click.mjs --once 1`）；双击会开两个学习页标签（两个标签都跑会被平台判重）。
3. 页面加载会弹两个打扰弹窗（`el-dialog`：`talk-later-btn`=下次再说 / `rlready-bound-btn`=已绑定不再提示）与一个**弹题弹窗**（`aria-label="弹题测验"`，`.btn` 里是"关闭"）。关打扰弹窗用 `runs/zhs-dismiss.mjs`；**别把"弹题"当普通弹窗关掉**（关了视频会停在题目点不动）。

### ★★ 完成判据（页面 DOM 里没有！只能取接口）

```
页面上的三个标记全是"装饰"，73 个小节一模一样，不能用来数进度：
  .time_icofinish（蓝底白勾 5b3134c2….png）/ .time_ico_half（灰底播放）/ .Sectionmark-em（11×11 灰杠）
→ 数勾永远得到 73/73。**这点与学习通的 span.roundpoint 完全不同，别照搬。**

唯一可靠来源（两条 POST，参数 secretStr 由页面 crypto 模块签，别自己造）：
  POST studyservice-api.zhihuishu.com/gateway/t/v1/learning/videolist
       → data.videoChapterDtos[]：章{name,videoLessons[]}；节里 ishaveChildrenLesson=1 时有 videoSmallLessons[]
  POST studyservice-api.zhihuishu.com/gateway/t/v1/learning/queryStuyInfo
       → data.lesson{lessonId:{studyTotalTime,watchState}}（无小节的节）
         data.lv{smallLessonId:{studytotalTime,watchState}}（小节）
       **watchState === 1 = 该视频已完成**（studyTotalTime 已到 videoSec）
口径：本门课 = 35 节 + 38 小节 = **73 个视频单元**（与目录里 li.clearfix.video 的 73 行对得上）
⚠️ 不要用 videolist 里的 isStudiedLesson：已看完的课它也是 0（导论 id=1000110424 就是）。
```
App.js 用**已有的 XHR 钩子旁路**拿这两条回包（不需要自己签 secretStr），`ADAPTER_ZHIHUISHU.onResponse` 解析 → `progressInfo()` 同步返回 `{total,done,pct,remainSec,etaSec,rate}`（实测：`总 73 / 已完成 73 / 100%`，与平台数据一致）。

### ★★ 反检测（本平台最大的坑，已定位并绕过）

站点 `stuStudy.js` 里有一段"异常脚本"检测，命中就弹
「**检测到异常脚本，为保证您的正常学习进度，请您关闭插件后，回到学堂重新进入视频学习页正常学习**」（不可关）并在 **3 秒后把页面跳回门户**。三处判据（混淆串已解码）：

```js
// ① checkout()：进页面 1 秒后跑一次，之后每 60 秒一次
isNative(window.XMLHttpRequest)
  && isNative(XMLHttpRequest.prototype.open)        // ← 注意是 .open（不是 .send）
  && !window['OCS']                                  // ← 站点的"黑名单里的插件"判断
  && isNative(Element.prototype.addEventListener)
// ② videoClick / 元素监听：e instanceof Event && !e.isTrusted → 判"合成事件"
// ③ isNative 的判据 = /^function .*\(\) \{ \[native code\] \}$/.test(Function.prototype.toString.call(fn))
```

**实测结论（2026-10-15，A/B 都做过）**：
- 注入 NetClass（包 XHR/fetch + 挂面板）→ **~1 秒必被判**，3~4 秒后被踢回门户；
- 把模块 `dispose()`（撤钩子/面板）→ 连续 8 秒无检测；**不注入 → 完全不检测**；
- 单把 `Function.prototype.toString` 伪装成原生（四个 isNative 全部 true）**仍然会被判** → 说明站点还看别的（DOM/事件）。

**当前的做法（可用，已验证）**：zhihuishu 走 **`ZHS_MINIMAL` 最小侵入**：
1. **只包 `XMLHttpRequest.prototype.send`**，不碰 `.open` / `.setRequestHeader`（站点的检查只看 `.open`），URL 从 `this.responseURL` 取；
2. **不做 `Function.prototype.toString` 伪装**（少一个可疑点）；
3. **不挂面板**（`mountPanel()` 对 zhihuishu 直接 return；要看面板得 `localStorage.setItem('netclass.panel.force','1')`）；
4. 播放/倍速一律走**站点自己的 UI**（`.speedBox` 悬停 → `.speedList [rate="1.5"|"1.25"|"1.0"]`），**绝不直接改 `video.playbackRate`**；
5. 驱动侧用**真实鼠标事件**（CDP `Input.dispatchMouseEvent`，`isTrusted=true`），**不要 `el.click()` 打播放器**。
结果：注入后连续 12 秒无检测、无跳转，`NetClass.platform == 'zhihuishu'`、`state.zhs.progress = {total:73,done:73,pct:100}` ✓

### 倍速与播放（实测）

- 站点倍速**只有 1.0 / 1.25 / 1.5**（`.speedList` 里就这三档）。
- 起播：真实点击播放器（`.able-player-container` 中心 = `#playButton` 区域）；`video.play()` 在已有用户手势时不报错，但**不要**用它替代点击（站点盯 `playbackRate`/事件来源）。
- **弹题会暂停视频**：`popupAnswer/loadVideoPointerInfo` 给出 `questionPoint[{timeSec,questionIds}]`（导论 = 151s/16228913），到点弹 `aria-label="弹题测验"` 的 dialog（判断题两个选项 `.topic-option-item`，正确答案直接写在 `.answer` 里：`正确答案：A`）。**不答就别关它**（关了视频停在原地，脚本以为卡死）。
- 平台**按视频位置记账**、且**重复观看会继续累加**：实测同一节（导论 id=1000110424）从 `studyTotalTime:330` → **657**（+327 秒），而没播的 1.1 保持 410 不变 —— 这就是"被平台记账"的取证口径。

### ★★ 弹题（popup quiz）—— 2026-10-15 接完（含实测数据）

**触发**：视频播到 `popupAnswer/loadVideoPointerInfo` 给的点位才弹（导论 = **151 秒**，questionId `16228913`）。
弹窗是 `.el-dialog__wrapper.dialog-test > .el-dialog[aria-label="弹题测验"]`，**弹出时视频被暂停**，不答就一直停。

**题目数据（`popupAnswer/lessonPopupExam` 回包，模块用 XHR 旁路读，不钩 JSON.parse）**：
```
data.lessonTestQuestionUseInterfaceDtos[0]
  .testQuestion.name          "<span style=\"color:#000000;\" >安全教育…</span>"   ← 带 HTML，要剥标签
  .testQuestion.questionId    16228913
  .testQuestion.questionType  {id:14, name:"判断题", inputType:"radio"}
  .testQuestion.questionOptions[]
        {id:53715220, content:"对", sort:1, result:"1"}      ← ★ result==1 = 正确选项
        {id:53715221, content:"错", sort:2, result:"0"}
  .zAnswer                    {answer:"53715220"}             ← ★ 是"我上次选的**选项 id**"（不是字母）
```
**语义（交叉验证过）**：`result==1` 标正确选项；`zAnswer` 有值 = 这题**本人答过**，此时站点把选项**锁住**
（实测点 B 无任何反应、无请求）→ 重看视频时只要**关掉弹窗**让视频继续。

**弹窗 DOM（可直接用）**：
| 元素 | 说明 |
|---|---|
| `li.topic-item` | 选项行（可点目标；含 `.topic-option-item` 字母 + `.item-topic` 文本）|
| `.topic-option-item.active` / `.item-topic.active` | 选中态 |
| `.topic-title .title-tit` | 【判断题】/【单选题】/【多选题】 |
| `.topic-title .right` | 答后角标：`正确` / `错误` |
| `.answer` | 答后出现 `正确答案：X`（**兜底校验就用它**）|
| `.el-dialog__footer .btn` | 「关闭」（footer 在视口外时要先滚动/放大视口）|
| `.el-dialog__headerbtn` | 右上角 X（备用关闭）|
| `.el-pagination .btn-next` | 多题时的翻页（本题组只有 1 题，disabled）|

**★★ 铁律：点击只能用 CDP 真鼠标**（`Input.dispatchMouseEvent`，`isTrusted=true`）。
合成事件（`el.click()` / `dispatchEvent(new MouseEvent(...))`）被站点元素级监听判为"合成事件"→ 弹 warn 弹窗 →
**3 秒后跳回门户**（2026-10-15 实测踩中一次，整页回 `www.zhihuishu.com`）。
所以分工是：**页面侧只识别/解析/决策**（`NetClass.zhs.popupInfo()`），**点击由驱动器做**（`runs/zhs-quiz.mjs`）。

**小窗口会挡住关闭按钮**：弹窗 630x480，而 9229 的页面视口只有 500x237（窗口 512x384 减浏览器 chrome）→
footer 的「关闭」在视口外。两种解法：① CDP `Emulation.setDeviceMetricsOverride` 把**页面**视口放大到 1280x800
（只影响渲染，不动窗口位置；站点未检测）；② `el.scrollIntoView()` 把按钮滚进视口（脚本里用的是两种都用）。

**实测成绩（2026-10-15，导论 16228913）**：弹题在 t=151s 出现 → 视频暂停 → 按站点 `result==1`/`.answer` 选中
A（正确）→ 角标「正确」、`正确答案：A` 与所选一致 → 点「关闭」→ **视频恢复播放（151s → 159s 继续走）**。

### 作业/考试（在线学堂）—— 2026-10-15 接完

**入口**：学习页目录里的 `li.chapter-test`（文本「平时测试」，`title="点击测试"`）——**真鼠标点**（`window.open` 需要
用户手势，合成点击会被静默拦掉）。开出来的新标签形如：
```
https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/{checkHomework|dohomework|doexamination}/
        <recruitId>/<tok1>/<tok2>/<courseId>/<examId>
```
- `checkHomework` = **已提交**（结果页：题目 + 得分 + 每题「正确」+ 学生作答落在 `input.checked` 上）；
- `dohomework` / `doexamination` = 待做 / 考试中（答完要提交）。

**★★ 考试页有 CSP（本轮最重要的坑）**：`onlineexamh5new` 的 HTML 里带
`Content-Security-Policy: connect-src 'self' *.zhihuishu.com …` → **页面内 fetch 不到 api.deepseek.com**
（报 `Failed to fetch`）。所以**考试页不能用 `NetClass.askDs`**；答案必须由**驱动器在 PC 侧**调模型
（`runs/zhs-exam.mjs` 从加载器 SW 读 key → 自己 POST DeepSeek）。
页面侧 `inferAnswer` 在 CSP 失败后会**回退到本地启发式 `guess()`** —— 看到"准确率 30%"别慌，那是启发式，不是模型。

**卷子回包（模块 XHR 旁路已接，见 `state.zhsExam`）**：
| 接口 | 内容 |
|---|---|
| `student/lookHomework` | `rt.examBase.questionDtos[]`：`{id,name,questionType.name,questionOptions[{id,content}],questionChildrens[]}` |
| `answer/getStuAnswerInfo` | `rt{questionId: 作答}`（复习页用）|
| `answer/checkAnswerSheetInfo` | `rt{questionId: ...}`（判分状态）|

**DOM 选择器（万能脚本那套实测有效）**：
```
题：    .examPaper_subject[data-questionid]       题干： .subject_describe
题型：  .subject_type（形如「【多选题】(2分)」）    选项行：.subject_node .nodeLab
选项 id：.nodeLab input[value=<选项id>]            选项文本：.nodeLab .node_detail
选项字母：.nodeLab .fl span（形如「A.」）          复习页选中：input.checked
```

**实测成绩（2026-10-15，第一章单元测试 10 题真卷）**：驱动器侧 `deepseek-chat` + 模块现有 system prompt =
**10/10 全对**（`runs/zhs-exam-verify.json`、`runs/zhs-ds-lab2.json`）；同一批题 `deepseek-reasoner` 只有 6/10
（还有空答）→ **用 deepseek-chat，不要换 reasoner**。

**现场事实（订单相关）**：本门课（大学生安全教育）13 个「平时测试」**全部已提交**（逐个点开都是 `checkHomework`，
绪论 6/6、第一章 20/20 …），**没有可提交项**；期末 **2026-12-14 开考**。
另一门课（中国饮食文化）在旧版 `wisdom-mooc.zhihuishu.com/study/index`，树上的「测试」入口（`.test-box`）在
**后台标签**里布局错位、被章节行盖住，真鼠标点不到（合成点击又没有用户手势 → `window.open` 被拦）——需要先
把窗口/标签前景化再点，留给后续。

### 坑

| 现象 | 原因 | 做法 |
|---|---|---|
| 刷新学习页 → 跳回门户 | 站点 404 兜底（缺入口上下文）| 重走"我的学堂"点卡片 |
| 注入后被判"异常脚本" | 见上方 ①②③ | ZHS_MINIMAL + 真实鼠标 + 站点 UI 倍速 |
| 目录里的勾看着像"完成" | `.time_icofinish` 是静态装饰 | 用 `queryStuyInfo.watchState` |
| `.jobUnfinishCount` 那类计数（学习通）| — | 本平台没有等价物，别找 |
| 弹题关掉后视频不动 | 站点等作答 | 答（`.topic-option-item`）或按 `.answer` 提示选，再点"关闭" |
| **弹题点了没反应，随后整页回门户** | **页面内合成点击**（`el.click()`/`dispatchEvent`）被 `!e.isTrusted` 判异常脚本 | 点击一律用 **CDP 真鼠标**；页面侧只决策（`NetClass.zhs.popupInfo()`）|
| **考试页 `NetClass.askDs` 报 Failed to fetch** | 考试页 CSP `connect-src` 只放行 `*.zhihuishu.com` | 答案在**驱动器 PC 侧**调 DeepSeek（`runs/zhs-exam.mjs`）|
| **弹窗「关闭」点不到** | 弹窗 630x480 > 页面视口 500x237 | `Emulation.setDeviceMetricsOverride` 放大页面视口，或先 `scrollIntoView` |
| 学习页目录里的「平时测试」点开是"作业结果" | `checkHomework` = 已提交 | 只有 `dohomework`/`doexamination` 才是待做 |

---

## 华医网（91huayi）站点事实（2026-10-23 实测）

> 第 8 个平台，也是**最反自动化的一个**：严格 1x + 单账号单路 + 双层 SSO + 会话绑定验证码 + 导航即丢鉴权。
> 本次踩了 13 次登录失败才摸清，根因全都记在下面 —— 下次别重复。

### 域名分工（别串）

| 域名 | 用途 |
|---|---|
| `www.91huayi.com` | 主站门户 |
| `hysslogin.91huayi.com` | 登录页宿主 |
| `hysso` | SSO 接口 |
| **`jcpxkh.91huayi.com`** | **本次靶标**：基层卫生人员能力训练平台（项目 / 直播间 / 课程） |
| `xuexi.91huayi.com` | 学习平台（要手机绑定，本次未用） |
| `cme28.91huayi.com` | 继续教育 |
| `xkjspc.91huayi.com` | 直播 |

### 运行参数

| 项 | 值 |
|---|---|
| 调试端口 | **9231**（实例1）/ **9250**（实例2，动态池分配） |
| 计划任务 | `NetClassVis-huayi` / `NetClassVis-huayi2`（`/IT` 交互会话才出可见窗口） |
| 启动脚本 | `runs/remote/start-huayi-visible.ps1` / `start-huayi-second.ps1`（**纯 ASCII**） |
| 浏览器 | **Chrome for Testing 137.0.7151.55**（必须；机器自带 Edge 155 缺 H.264/AAC） |
| 实例2 陷阱 | `netclass up` 读 `platforms.json` 的 `huayi.cdp: 9231`，**9231 未 LISTEN 时实例2 会去抢 9231 → `WMI 启动失败: 251100`** → 先确认 9231 LISTEN 再 fire 实例2 |
| 实例记录 | 杀浏览器后必须删 `%LOCALAPPDATA%\NetClass\instances\huayi--*.json`，否则 `ps` 一直显示 dead |

### 硬约束①：严格 1x —— 连 1.25x 都杀播放器

阶梯实测（`node runs/test-rate-ladder.mjs --port 9250 --rates 1,1.25,1.5,1.75,2 --secs 20`）：

| 设置 | 实际推进 | 页面反馈 |
|---|---|---|
| **1.00x** | 20.1s / 20.2s = **1.00** | 正常 ✅ |
| 1.25x | **0.0s** | 「播放行为异常，视频已停止播放」❌ |
| 1.50x | 0.0s | 同上 ❌ |
| 1.75x | 0.0s | 同上 ❌ |
| 2.00x | 0.0s | 同上 ❌ |

**机制**：设 `video.playbackRate > 1` 后 **`video` 元素直接被销毁**（探针返回 `r=undefined`，整个播放器换成错误界面）。
不是「降速」而是「自杀」：`ratechange` 被抓 → 三个 0x0 隐藏 iframe（`#jj_Iframe` / `#pf_Iframe` / `.threeIframe`）上报 → 播放器自杀。
**重载可完全恢复且进度不丢**（服务端记着）→ 测倍速没有代价。

→ `platforms.json`：`huayi.rateMax = 1`、`accountingMaxRate = 1`；`App.js` 的 `PLATFORM_RATES.huayi = [1]`。
**这单没有加速空间，只能 1x 实播。**

### 硬约束②：单账号单路 —— 同账号第二个播放页被掐

同账号同 profile 开两个 `CoursePlay` 标签 → 第二个报
「您有其他课程正在播放，当前课程已暂停播放！」且 `video` 被销毁。
→ **一行 = 一路**。要多路必须**多账号 + 多 profile + 多端口**
（本次 9231 白云晴 + 9250 陈金泽并行，75s 采样两路 `eff` 均 `1.00`，无互踢）。

### 登录：双层 SSO + 会话绑定验证码（最耗时的部分）

**登录页两套模式的验证码框 placeholder 同名，必须按 id 定位：**

| 模式 | 账号框 | 验证码框 | 验证码图 | 取图函数 |
|---|---|---|---|---|
| 密码登录 | `#user_name` | `#userCode` | `#user_yzm` | `LoadCode()` → `/code/ImageSecond` |
| 短信登录 | `#mobile` | `#mobileCode` | `#moblie_yzm` | `LoadMobileCode()` → `/code/IdentifyingCode` |

两个验证码输入框 placeholder **都是**「请输入验证码」→ **按 placeholder 定位一定打错**。

**正确的自动登录顺序（`runs/login-again.mjs` 已固化）**

1. 清 layui 遮罩：`[class*="layui-layer-shade"], [class*="layui-layer-page"], [class*="layui-layer-dialog"]` 全 `remove()`
2. 点「密码登录」tab，**轮询等 `#user_yzm` 的 `offsetParent && width>0`）**
3. **真鼠标点 `#user_name`** + `Input.insertText` 输账号
4. **真鼠标点 `#password`** + `Input.insertText` 输密码
5. 勾协议 checkbox
6. **真鼠标点 `#user_yzm`** → 触发 `onclick="LoadCode();"` → **必须断言 `src` 前后不同**
7. canvas 导原始 100×100 → 6x 最近邻放大 → 人读
8. 原生 `value` setter 填 `#userCode`（+ `input`/`change` 事件）
9. 回读三字段确认（**密码会被站点自己清空**）
10. `document.querySelector('button.login').click()`

**★★ 三个致命坑**

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| **用已消费的旧图** | 填的码和图上完全一致，服务端一律 `{"state":2,"msg":"验证码错误！"}` | 图是上一轮提交用掉的，`LoadCode()` 没真刷 | **真鼠标点图** + 断言 `src` 变了；直接调 `LoadCode()` 函数有时不发请求 |
| **每个字符敲两遍** | 读图 `Z8UV`，填进去变 `ZZ88UUVV` | `Input.dispatchKeyEvent` 的 `keyDown` **同时带 `text` 和 `char`** | `keyDown` **不带 `text`**；或直接用 `Input.insertText` |
| **密码框被清空** | 回读 `value.length=9`，截图上却是空白 | 勾协议 + 等码的几十秒里站点自己清空 | 提交前回读，空了立刻用真鼠标 + `insertText` 补填 |

**★★ 站点先校验账号密码，失败也报「验证码错误！」**
所以「一直报验证码错误」**不等于**验证码有问题 —— 账号锁定 / 密码错 也是这个回包。本次因此误判很久。
**判别法**：拿另一个已知能登的账号跑**同一个脚本** —— 一次过说明脚本对，问题在被怀疑的那个账号。

**★★ 图在隐藏容器里时，换 `src` 浏览器可能不发请求**
`#user_yzm` 祖先链：
```
IMG#user_yzm → SPAN → DIV.mess → DIV.login_box_item → DIV.card_box(display:none) → DIV.box_right → DIV.login_item
```
未切 tab 时 `card_box` 是 `display:none`。此状态下 hash 六次采样全同（`5f93323bc5`）**也说明不了问题** ——
必须先切 tab 让容器可见，再刷新图。

**★★ 读验证码：canvas 导原始像素，不要用 CDP clip**

```js
// ✅ 正确：导 naturalWidth×naturalHeight（100×100），再 6x 最近邻放大
const c = document.createElement('canvas');
c.width = img.naturalWidth; c.height = img.naturalHeight;
const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
x.drawImage(img, 0, 0, c.width * 6, c.height * 6);
```
```js
// ❌ 错误：Page.captureScreenshot({ clip, scale: 8 })
// 图实际显示尺寸 120×48，会被横向拉伸，字符糊成一团认不出
```
`runs/refresh-canvas.mjs <port> <name>` 已固化（点图刷新 + 双导出）。

### 开播放器：必须先「进入项目」

`jcpxkh` 的鉴权挂在当前会话的内存态上，**整页导航会丢**。四种顺序实测：

| 操作 | 结果 |
|---|---|
| `Page.navigate` → `/Exercise/ExerciseCourse/LiveStreaming` | ❌ 踢回 `VerifySSOCode` |
| 同标签 `Page.navigate` → `CoursePlay?courseware_id=…` | ❌ 踢回 |
| `PUT /json/new?<CoursePlay>`（当前停在 `ProjectList`） | ❌ 踢回 |
| **`ProjectList` 点「进入」→ `ExerciseHome/index` → `PUT /json/new?<CoursePlay>`** | ✅ **成功** |

固定流程：

1. 登录后停在 `/exercise/ExerciseHome/ProjectList`
2. **真鼠标点「进入」（`input`，约 (1398,316)）** → 落到 `/exercise/ExerciseHome/index`
3. `PUT /json/new?<CoursePlay URL>` 开播放器
4. 播放页里 `video.playbackRate = 1` + `video.play()`

`runs/enter-project-then-open.mjs <port> <courseware_id> <shotPrefix>` 已固化。

**浮层**：点「进入」后弹「我已知悉以上内容」（复选框 + 「我知道了」按钮，约 (960,600)），
**不关掉它后续点击全被遮**。关完还要**重新点一次「直播间」** —— 内容区是 AJAX 渲染的，
浮层挡着时列表根本不加载（`items=0`、`innerText` 里连「直播回放」都没有）。

### 页面侧探针

```js
播放器   document.querySelector('video')
面板     window.NetClass          // v0.5.9 显示「华医网」
反作弊   /播放行为异常|已停止播放/.test(document.body.innerText)
倍速记录 <input id="video_speed_state">
隐藏校验 #jj_Iframe / #pf_Iframe / .threeIframe   // 均 0x0
验证码图 document.getElementById('user_yzm')      // 密码登录
```

### 会话与注入

**CDP 注入是 per-target**：`LiveOpenVideoPlay()` / `window.open` 开的新标签拿不到预注入脚本 → 面板不出现。
用 `scripts/inject-guard.mjs --port <p> --every 3` 长驻轮询补齐（**带 mtime 热重载**，
否则改了 dist 也不生效 —— 踩过「日志正常但页面还是老版本」）。

`brand.js` 必须包 IIFE（`scripts/build.mjs` 已改）—— 否则二次注入报
`Uncaught SyntaxError: Identifier 'BRAND' has already been declared`，整段脚本死掉、面板消失。

**标签数会失控**：`netclass up --login` 每次导航开一个新标签，本次 9231 一度攒到 **33 个**、9250 攒到 **29 个**；
批量关标签会把浏览器搞僵（端口还 LISTEN 但 CDP 连不上，需杀进程重启实例）。
→ 任何批量操作前先 `node runs/cleanup-for-manual.mjs` 清到 1 个标签。

### 内容与工作量

项目「2026年第五届全国基层卫生人员能力提升培训项目」（培训期 2026-10-10 → 11-30）。
结业要**同时**完成 3 项（首页原文）：① 直播课学习（可回放）② 录播课学习（选学 50 学时）③ 项目调研问卷（截止 11-30）。

直播回放（`CoursePlay?courseware_id=<uuid>`）：

| 场次 | courseware_id | 时长 |
|---|---|---|
| 10月10日 | `b65f246f-25df-44a7-84a1-bf791c520469` | 20664s = 5:44:24 |
| 10月11日 | `825ac6fd-1c77-449b-9abd-081c0d1e2e67` | 21202s = 5:53:22 |

单账号 11.6h × 2 账号 = 23.2h 内容；两账号并行 → **墙钟 11.6h**。
`scripts/huayi-watch.mjs --ports 9231,9250 --every 30`：保 1x、掉暂停就 `play()`、
出现「播放行为异常」就重载、`pct>=99.5` 标记完成并自动轮转到另一集。

**验收只认平台 UI 的进度**（`CoursePlay` 里的 `video.currentTime/duration` 与「学习记录」页），
不认「脚本跑过」。

### 华医网专属 / 通用脚本（**都已入库到 `scripts/`**）

> 原先写在 `runs/` 下的版本**会被 gitignore 掉**，已全部搬到 `scripts/`。输出统一进 `runs/shots/`（自动建目录）。

| 脚本 | 用途 | 通用性 |
|---|---|---|
| `scripts/huayi-login.mjs --port <p> --user <u> --pass <p>` | 自动登录（真鼠标 + `insertText` 填账号密码，setter 填码） | 华医网 |
| `scripts/captcha-read.mjs <port> <name>` | 真鼠标点图刷新 + canvas 导原图 / 6x 放大 | **通用**（任何验证码） |
| `scripts/captcha-submit.mjs <port> <code> <name>` | 填码 + 提交 + 抓请求体与响应 + 提交前后截图 | **通用** |
| `scripts/test-rate-ladder.mjs --port <p> --rates <list> --secs N` | 倍速阶梯硬探测（判定"最高可用倍速"） | **通用**（任何平台） |
| `scripts/clean-tabs.mjs` | 清标签到 1 个（交接人工 / 防标签爆炸） | **通用** |
| `scripts/huayi-open-player.mjs <port> <cw_id> <pfx>` | 点「进入」→ 开 CoursePlay（唯一能过的顺序） | 华医网 |
| `scripts/huayi-check.mjs` | 双端口状态巡检并压回 1x | 华医网 |
| `scripts/huayi-dual-test.mjs` | 双账号并行采样（`eff` / `dlg` / `err` / `panel`） | 华医网 |
| `scripts/huayi-watch.mjs --ports 9231,9250 --every 30` | 1x 保活 + 反作弊重载 + 播完自动轮转 | 华医网 |
| `scripts/inject-guard.mjs --port <p> --every 3` | 新 target 补注入（带 mtime 热重载） | **通用** |

---

## 国家中小学智慧教育平台（`basic.smartedu.cn`）站点事实（2026-11-22 实测）

> ⚠️ 别和 `smartedu`（青海租户 `basic.qh.smartedu.cn`）搞混。同品牌不同实现：
> 青海是 `addStudyDuration` 累计秒数、服务端异步分账、滞后 5-8 分钟；
> **国家级是 `study_details` 按播放位置直接上报、即时生效。** 两者约束不能互相套用。

### 域名分工

| 域名 | 作用 |
|---|---|
| `basic.smartedu.cn` | 主站（课程、教师研修、我的学习） |
| `auth.smartedu.cn/uias/login` | 登录页「智教中国通行证」 |
| `x-api.ykt.eduyun.cn/proxy/...` | 业务网关（record_configs 等） |
| `x-study-record-api.ykt.eduyun.cn` | **学分上报**（study_details / resource_learning_positions） |
| `data-collect-service.ykt.eduyun.cn` | 埋点（神策），与学分无关，看网络时会刷屏 |
| `sso.basic.smartedu.cn` | SSO 附属主机（有 HWWAFSESID 等 WAF cookie） |

### 运行参数

| 项 | 值 |
|---|---|
| 端口 | `9260` |
| profile | `E:\Desktop\NetClass\instances\smartedu` |
| 启动 | `scripts/ssh-exec.ps1 -File scripts/remote/launch-visible-chrome.ps1 -Arg '$Port = 9260; $TaskName = "NCVis-smartedu"'` |
| 隧道 | `pwsh -NoProfile -File scripts\tunnel.ps1 -Port 9260` |
| 播放器 | video.js + MSE blob（`currentSrc` 是 `blob:`），`seekable` 覆盖全片 |

### ★★ 记账模型：按「播放位置」，不是「累计时长」

```
POST https://x-study-record-api.ykt.eduyun.cn/v1/study_details
{ user_id, resource_id, resource_name, resource_type:"t_course",
  catalog_type:"teacherTraining", topic_type:<channelId>, progress, status, ext_info }

PUT  https://x-study-record-api.ykt.eduyun.cn/v1/resource_learning_positions/<resUuid>/<userId>
{ "position": <秒> }        ← 只影响续播，与学分无关
```

| 字段 | 语义 |
|---|---|
| `progress` | 0-100，**按资源时长加权**累加 |
| `status` | `0` 未开始 / `1` 部分完成 / `2` 完成 |

**做法：把 `currentTime` 设到 `duration - 12`，让它自然播完最后 12 秒。**
实测（3 资源课，1067 + 718 + 885 = 2670 秒）：`40/1` → `67/1` → `100/2`，整门课约 50 秒。
单资源课：`0/0` → `100/2`。

> 权重就是资源时长占比：1067/2670 = 40.0%，再加 718/2670 = 66.9%≈67%，最后 100%。
> **所有资源都要做，少一个就卡在中间值。**

> ⚠️ 与华医网**完全相反**：华医网跳到结尾一分不记，因为它的记账 tick 只在
> `(played + 窗口) >= total` 时触发。**同一个动作在两个平台上结果相反 —— 新平台一律先量再写。**

### ★★ 完成判据：`courseIndex` 徽章

课程页右侧圆形徽章，DOM 是
`div[class*=course-progress] > div[class*=progress-info]`，文本形如 `"100%已学习"`。

- 三个层级**都有子元素**，所以「取叶子节点」找不到它；正确做法是取**面积最小的匹配元素**。
- 徽章 `progress≈40%` 时就会显示「已学习」三个字，**只有到 100% 才满足「100%已学习」**。
  判完成必须看百分比，不能只看「已学习」。

### ★ 入口按钮三态 + SPA 竞态

| 文案 | 含义 | 处理 |
|---|---|---|
| `开始学习` | 未开始 | 点它进播放器 |
| `继续学习` | 有进度 | 点它进播放器 |
| `复习回顾` | **已 100%** | 直接判完成，不要继续找视频 |

`courseIndex` 的 SPA 是**先渲染分类骨架、入口按钮晚一拍**。单次查询会在按钮出现前
就判定「无视频」并失败。入口必须轮询（约 16 × 1.2s），出现就点，点完再校验 `video.duration > 0`。

### ★ 拿课程 URL：卡片没有 href

分类页 / 子栏目页的课程卡片是 **`<a>` 但没有 `href`**，靠 JS 点击跳转。
`a[href*="courseIndex"]` 抓到 0 条。要 URL 只能：
1. 真鼠标点卡片（`scripts/cdp-cli.mjs <port> click "<课程名>"`）再读 `location.href`；或
2. 从课程详情页的面包屑反推。

### ★ 列表是二级目录

`教师研修 → 栏目（师德师风 / 通识研修 / 学科研修 / 幼教研修 / 特教研修 / 国培示范 / 院士讲堂 / 名师名校长 / 在线教研）→ 子栏目（如 游戏案例、《指南》解读）→ 课程卡片`。

直接拿一个「分类选课」URL 打开，往往只看到子栏目清单，要**连点两级**才出课程卡片。

### ★ CORS：接口只能由页面自己调

`x-study-record-api` 的 **GET 被 CORS 挡**（页面内 `fetch` 报 `TypeError: Failed to fetch`），
但页面自己的 POST 正常。**结论：不要试图直接查接口核对进度，只读界面徽章。**

### 登录：UC SSO 三件套（人工登录 + 接管会话）

标准姿势：前台可见浏览器打开 → **客户手动输入账号密码** → 抓会话 → 之后全程自动化。

| 位置 | 名字 | 说明 |
|---|---|---|
| cookie | `UC_TOKEN-<appid>-ncet-xedu` | JWT，约 1.1 KB，7 天 |
| cookie | `UC_SSO_TGC-<appid>-product` | SSO ticket grant，httpOnly |
| localStorage | `ND_UC_AUTH-<appid>&ncet-xedu&token` | JSON 字符串，里面是 `access_token` |
| localStorage | `X-EDU-WEB-USER` | `{real_name, user_id, avatar}` |
| localStorage | `X-EDU-WEB-ROLE` | `{"<userId>":"TEACHER","allRoles":[...]}` |
| localStorage | `new_area_site_code_user_<userId>_<ROLE>` | 地区码，如 `gd` |

抓取：`node scripts/smartedu-session.mjs 9260` → `evidence/session.json`。
**三者缺一不可复用**，只存 cookie 或只存 access_token 都不够。

登录页字段：`#username`（通行证ID/手机号/学生号）、`#tmpPassword`（密码）、
`#agreementCheckbox`（用户协议，**默认未勾选，不勾选点登录会失败**）、
`input[name=captchaCode]`（未交互时 `display:none`，需要时才出现）。

平台侧还需**实名认证**才计学时。

### 安全操作

| 动作 | 安全吗 |
|---|---|
| `Page.navigate` 到任意课程页 | ✅ 安全（不像华医网会丢鉴权），进度在服务端，刷新/重进不丢 |
| 同账号开两个播放器 | ❌ 会互相覆盖 `study_details`，必须串行 |
| 跳尾（`currentTime = dur - 12`） | ✅ 有效，这就是正解 |

### 平台专属 / 通用脚本

| 脚本 | 作用 | 归属 |
|---|---|---|
| `scripts/cdp-cli.mjs <port> eval\|nav\|click\|type\|shot\|cookies\|storage\|net` | 通用 CDP 驱动 | **通用** |
| `scripts/smartedu-session.mjs <port>` | 抓 UC SSO 三件套 + 身份，落 `evidence/session.json` | smartedu |
| `scripts/smartedu-course.mjs <port> <courseUrl> [--offset 12] [--shot-dir d]` | 跑完单门课的全部资源（含入口三态、跳尾、进度核对） | smartedu |
| `scripts/smartedu-batch.mjs <port> --set core\|hot\|key\|--list f.json [--only 1,3-7]` | 串行跑一批，逐门复核登录态 | smartedu |
| `scripts/smartedu-cards.mjs <port> --list f.json --out d [--scale 2]` | 出交付截图：面包屑 + 课程卡片 + 圆形徽章 | smartedu |
| `scripts/smartedu-list.mjs <port> "<listUrl>"` | 抓分类页课程卡片（无限滚动） | smartedu |
| `scripts/smartedu-parse-courses.mjs <附件3.html> -o courses.json` | 从「区域定制课程」静态导航页 HTML 抽课程清单 | smartedu |
| `scripts/remote/launch-visible-chrome.ps1` | 前台可见 Chrome（Interactive 计划任务，Session 1，断言非 topmost） | **通用** |
| `scripts/remote/capture-screen.ps1` | Session 1 真实桌面截图 + 窗口清单 | **通用** |
| `scripts/ssh-exec.ps1 -File <ps1> -Arg '<语句>'` | 远程执行（scp + `-File`，UTF-8 BOM，参数注入在 `param()` 后） | **通用** |

### 交付截图构图

附件类文档通常要求「每类一张，含 `100% 已学习`」。示例图尺寸约 1267×319，构图是
**面包屑 + 课程卡片（封面/标题/课程来源/资源数）+ 右侧圆形 `100%已学习` 徽章 + 复习回顾按钮**。

`smartedu-cards.mjs` 已经按这个构图裁：找徽章（面积最小的匹配元素）→ 上溯到卡片容器 →
上方补面包屑 → 2x 缩放（输出约 1416×337）。

---

## 运维：系统级主管（2026-10-15 新增）

`scripts/supervisor.mjs --interval=60` —— 长跑必需，因为任何一环挂了都是**静默失效**：

| 它做什么 | 为什么 |
|---|---|
| 探 9224/9227/9228 是否有页面 | 端口不通 = 平台完全停摆，但驱动进程还在、日志还在写 |
| **端口不通 → 自动重建隧道** | 实测三端口会同时断（网络瞬断）|
| 检查 5 个守护进程（ss看门狗/提交看门狗/进度记录/长春驱动/学习通驱动）| 缺了就补 |
| **重复实例自动清理**（保留最早启动的）| 两个驱动抢同一标签会互相干扰 |
| 启动一律用 **Node `spawn` + 文件 fd**（不走 PowerShell 中转）| `powershell.exe Start-Process` 实测会 `ETIMEDOUT` → "以为修了其实没修" |
| 匹配进程时**排除作业运行器**（`runner.js`/`subprocess-local`）| 它的命令行含"启动命令全文"，会把所有脚本名都匹配上（同一 pid 出现在三个清单里）|

**配套**：`scripts/progress-report.mjs --every=300` —— 三平台统一进度快照（落 `runs/progress.jsonl` + 一行摘要）。
**用途**：任何"静默卡死"都会在 5 分钟内从"数字不涨"上暴露出来（本会话靠它抓到两次）。
