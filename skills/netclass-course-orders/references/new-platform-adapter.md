# 新平台接入（八步）

> 订单给的是**没见过的平台**时走这里。目标：把它变成"已知平台"，沉淀进 `platforms.md` 与 `docs/HANDOVER.md`。
> 全程在 netclass 仓库内改，**不新建脚手架**。

## 第 0 步：先查 `platforms.md`，别急着适配

**已经适配过 8 个平台**（shengsheng / qiyang / webtrn / zhihuishu / chaoxing / smartedu / 长春 / **华医网**）。
新订单先 `grep` 域名关键词，命中就直接用已有事实，跳过本文件。

```powershell
Select-String -Path <skills>\netclass-course-orders\references\platforms.md -Pattern '91huayi|chaoxing|<域名片段>'
```

同域名不同子域也要查 —— 华医网这次就是 `www.91huayi.com` 没记录，但 `jcpxkh.91huayi.com` 才是真靶标。

---

## ★ 铁律：用真实截屏判断，不要只信 DOM 查询

**本次最大的效率损失来自「代码说没有、截图说有的是」。**

| 症状 | 代码看到的 | 截图看到的 |
|---|---|---|
| 「直播回放」tab 找不到 | `document.body.innerText` 正则不匹配、`querySelectorAll('div.contentItem').length === 0` | **tab 明明就在那儿，只是被浮层挡住 / AJAX 还没渲染** |
| 验证码图「没变」 | 6 次采样 hash 全同 | 图在 `display:none` 容器里，根本不会真刷 |
| 密码「填进去了」 | `el.value.length === 9` | 界面上是**空的**（站点自己清空了） |

**操作纪律**：

1. **每个关键步骤后 `Page.captureScreenshot`**，看一眼页面真实状态，再决定下一步。
2. **判断「元素存不存在」用截图，不要只用 `innerText`** —— 正则受换行/空白/字符编码影响，
   `display:none` 的元素 `innerText` 为空但 `getBoundingClientRect()` 有值，两种探测都会漏。
3. **元素能给真实坐标就用真鼠标点**（`Input.dispatchMouseEvent` mousePressed/mouseReleased），
   合成 `el.click()` 在部分站点被 `!e.isTrusted` 判为脚本。拿不到坐标就**从截图读坐标**。
4. **长流程（登录 / 开播放器）每步截图留证**，出错能看出是哪一步断的。

**判读验证码/小元素：用 canvas 导原始像素 + 整数倍最近邻放大，不要用 CDP `clip`**

```js
// ✅ 导 naturalWidth×naturalHeight，再 6x，imageSmoothingEnabled=false
const c = document.createElement('canvas');
c.width = img.naturalWidth; c.height = img.naturalHeight;
const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
x.drawImage(img, 0, 0, c.width * 6, c.height * 6);
```
```js
// ❌ Page.captureScreenshot({ clip, scale: 8 })
// 元素显示尺寸常被 CSS 拉伸（如 120×48），8x 后字符糊成一团，认不出
```

---

## ★ 三条硬约束 + 四条打法约束，必须在写适配器之前探测出来

新平台先花 20 分钟把下面这些测死，否则写出来的适配器方向就是错的。
**探测脚本都已有，直接跑，别手搓。**

| # | 要测什么 | 影响到哪 |
|---|---|---|
| ① | 最高倍速 | 提速手段（倍速 or 多标签） |
| ② | 能否多路并行 | 排班与端口数 |
| ③ | 整页导航会不会丢鉴权 | 导航路径写进适配器 |
| ④ | **记账模型：位置制 vs 时长制** | **整个打法：跳尾 or 真播** |
| ⑤ | 完成判据（哪个信号作数） | 验收与交付截图 |
| ⑥ | SPA 入口渲染竞态 | 入口要不要轮询 |
| ⑦ | 入口按钮有几态 | 已完成课程会不会被误判 |
| ⑧ | 卡片有没有 `href` | 怎么取课程 URL |

### ① 最高倍速：阶梯硬探测

```powershell
node runs\test-rate-ladder.mjs --port <端口> --rates 1,1.25,1.5,1.75,2 --secs 20
```

每档测：设置 `playbackRate` → 观察 20 秒 → 记录「墙钟 vs `currentTime` 推进量」算实际倍率 →
同时检测页面异常文案（`/播放行为异常|已停止播放|非法|加速/`）。

**三种典型结果**（都在 `platforms.md` 有实例）：

| 结果 | 含义 | 处置 |
|---|---|---|
| `eff ≈ 目标值`，无异常 | 站点允许 | 写进 `PLATFORM_RATES`，可多档 |
| `eff` 被拉回某个固定值（如 1.5） | 站点有自己的上限，强设更高会被**改回去** | 记为站点上限；**多开标签并行**才是提速手段 |
| `eff = 0`，`video` 元素消失 / 报错 | **反作弊**：`ratechange` 被抓 → 播放器自杀 | 该档不可用；`rateMax = 1`。注意**重载能恢复且进度不丢**，测不亏 |

### ② 单账号能否多路并行

同一账号开两个播放页，观察 40 秒：两边 `currentTime` 是否**各自**推进、有没有被暂停、有没有互斥弹窗。

- 各自推进 → 平台按课时记，可多标签并行（如 shengsheng）
- 一边被掐 / 弹「您有其他课程正在播放」→ **一行只能一路**，要多路必须多账号 + 多 profile + 多端口（如华医网）

### ③ 鉴权能撑多远：整页导航会不会丢登录态

**这是最容易低估的一条。** 依次试四种，记下哪一步开始被踢回登录页：

```
A. Page.navigate 到另一个业务路径
B. 同标签 Page.navigate 到播放页
C. PUT /json/new?<播放页 URL>（当前停在列表页）
D. 先点站点 UI「进入」到项目首页，再 PUT /json/new?<播放页 URL>
```

华医网的答案：**A/B/C 全被踢，只有 D 能过**。所以「导航路径」是适配器的一部分，不是随便走。

**附带要摸的**：点击后是否弹「我已知悉 / 我同意」浮层 —— 有的话**不关掉后续点击全被遮**，
且关完要**重新触发一次列表渲染**（AJAX 列表在浮层遮挡下根本不加载）。

### ④ 记账模型：按「位置」还是按「时长」—— 这是最关键的一条

**决定整个打法，而且两个平台可能完全相反。** 先抓 30 秒网络，找到学分上报的那个 POST，看清楚它带什么：

```powershell
node scripts\cdp-cli.mjs <端口> net 20000 > runs\net-<平台>.json
```

| 模型 | 上报字段长什么样 | 打法 | 实例 |
|---|---|---|---|
| **位置制** | 带 `progress: 0-100`，且随 `currentTime` 变化 | **跳尾**：`currentTime = duration - 12`，自然播完最后 12 秒 | 国家中小学智慧教育平台（`study_details`） |
| **时长制** | 带 `studyDuration: 60` 之类固定秒数，不带章节 id | **必须真播**，服务端按累计秒数异步分账，还要留滞后窗口 | 华医网（`UpdatePlayTime`）/ 青海智慧教育（`addStudyDuration`） |

**验证方法（唯一可信的）**：把 `currentTime` 设到 `duration - 15`，让它播完 → 看上报值 / 看平台徽章。

> ⚠️ 别凭平台品牌推断。`basic.smartedu.cn`（国家级）是位置制、跳尾有效；
> `basic.qh.smartedu.cn`（青海）是时长制、跳尾无效。**同品牌 ≠ 同实现。**

### ⑤ 完成判据：哪个信号才作数

按可信度排序，**越靠前越优先**：

1. **平台 UI 自己显示的百分比/徽章**（如 `100%已学习`）—— 交付物也是照这个截的，最一致
2. 上报接口里的 `progress == 100` / `status == 2`
3. 页面上的「已完成」文案
4. ❌ **不要用** 「播放器播到结尾了」当判据 —— 播放完成 ≠ 记账完成

**两个常见陷阱**：

- **徽章会提前"变绿"**：国家平台在 `progress≈40%` 就显示「已学习」三个字，只有 100% 才算完。
  判完成必须看**百分比**，不能只看文字。
- **只读接口可能被 CORS 挡**：国家平台的 `x-study-record-api` GET 从页面里 fetch 报
  `TypeError: Failed to fetch`（页面自己的 POST 却是通的）。**遇到这种就只读界面，别硬查接口。**

### ⑥ SPA 渲染竞态：入口按钮要轮询，不要只看一眼

现代平台（vue/react）打开课程页是**先出骨架、后出按钮**。单次查询会在按钮出现前就判定
「没有播放器/没有入口」并失败。

固定写法：**轮询约 16 × 1.2s**，看到按钮就点，点完再校验 `video.duration > 0`；
点不进去就重试，不要一次失败就放弃。

### ⑦ 入口按钮可能有三态，别只认两种

| 文案 | 含义 | 处理 |
|---|---|---|
| `开始学习` / `进入学习` | 未开始 | 点进播放器 |
| `继续学习` / `继续观看` | 有进度 | 点进播放器 |
| `复习回顾` / `已完成` | **本来就做完了** | **直接判完成**，不要继续找视频 |

漏掉第三态会把「本来已完成的课」误判成失败，白跑一遍还可能把进度搞乱。

### ⑧ 课程卡片可能没有 `href`

分类页/列表页的卡片常是 `<a>` 但 `href` 为空，靠 JS `onClick` 跳转
（`a[href*="course"]` 一条都抓不到）。拿课程 URL 只能：

1. 真鼠标点卡片 → 读 `location.href`；或
2. 从课程详情页的**面包屑**反推。

### ⑨ 交付截图：先找"锚"，再上溯容器

订单要求通常是「每门课一张，含 XX% 已完成」。给定一张示例图时，按这个顺序复刻构图：

1. **锚** = 徽章/百分比元素。取**面积最小的匹配元素**（
   `querySelectorAll('*')` 过滤掉 `SCRIPT/STYLE/NOSCRIPT/TEMPLATE` + 要求 `getClientRects().length>0`
   + 文本长度 < 24 + 含关键字，然后按面积排序取第一个）。
   —— 只认叶子节点会漏（徽章容器往往有子元素）；不排除 `SCRIPT` 会把打包的 JS 当成徽章。
2. **容器** = 从锚往上走，找第一个「够宽但占不满整页」的祖先（如 `width > 55% 视口 && height 在 120~95% 视口之间`）。
3. **补上下文** = 面包屑那行（同样是"面积最小的匹配元素"，因为它也是容器）。
4. `Page.captureScreenshot({ clip: {...}, scale: 2 })` —— 2x 出来文字才清晰。

### ⑩ 需要"用户桌面"的截图：SSH 在 Session 0 截不到

SSH 起的进程在 **Session 0（服务会话）**：`EnumWindows` 看不到用户窗口、
`Graphics.CopyFromScreen` 截出**空白图**、`Process.MainWindowHandle` 返回 `0x0`。

所以任何"整屏截图 / 窗口置顶状态 / 真实可见性"的验证，都必须在 **Session 1** 里做：
用 Interactive 计划任务（`LogonType=Interactive`）把脚本自己重新拉起来一次。
现成的实现：`scripts/remote/capture-screen.ps1`（自查会话 → 自转 Session 1 → 截图 + 窗口清单）。

> 反过来说：**从 Session 0 查到的「没有可见窗口」是不可信的**，别据此判断浏览器没起来。
> 可靠信号是 `Get-Process chrome | Select SessionId`（等于登录会话 id 就对）和 CDP `/json/version` 通。

---

## ★ 验证码类平台的通用打法

登录带图形验证码时的固定套路（华医网 13 次失败换来的）：

1. **先确认验证码框和图的对应关系** —— 同一页面常有多套登录（密码/短信/扫码），
   **验证码框的 placeholder 往往一模一样**，必须按 `id` 定位。
   找出取图函数（`typeof LoadCode === 'function' ? LoadCode.toString() : …`）确认哪个图对应哪个框。
2. **切到目标登录方式后，轮询等图容器真正可见**（`offsetParent && width > 0`）——
   在 `display:none` 里换 `src`，浏览器可能不发请求。
3. **用真鼠标点图刷新**，并**断言 `src` 前后不同**。直接调页面函数有时不触发请求。
4. **canvas 导原始像素 + 放大读码**，人读，不要上 OCR。
5. **提交前回读所有字段** —— 密码框被站点自动清空是常见行为，空了立刻补填。
6. **区分「验证码错」和「账号密码错」**：很多站点密码错也回「验证码错误」来防探测。
   **判别法：拿另一个已知能登的账号跑同一个脚本** —— 一次过说明脚本对，问题在被怀疑的账号。
7. **人工闸门**：确实过不去就转人工（把浏览器窗口摆好、切到目标 tab、截图给订单方），
   不要反复试到把账号/浏览器搞坏。

---

## 诊断清单：症状 → 先查什么

| 症状 | 先查（按序） |
|---|---|
| 面板不出现 | ① 页面是 new target 吗（`window.open`/`LiveOpenVideoPlay` 开的）→ 用 `inject-guard` ② 是否二次注入报 `Identifier already declared` → 检查 `build.mjs` 是否给非主脚本包 IIFE ③ `probe-page.mjs` 看 `window.NetClass` |
| 面板显示「未知平台」 | `PLATFORM` 正则没覆盖新域名 → 这是**最危险**的：会走通用路径乱设倍速触发反作弊 |
| 视频自己暂停 / 元素消失 | 实际倍速 > 站点上限 → 查 `PLATFORM_RATES` 和站点自己的 `ratechange` 处理 |
| 列表读不到条目 | ① 浮层没关 ② AJAX 没渲染完（等 6-10s）③ 选择器写错 → **先截图看页面到底有没有** |
| 点不动 / 点了没反应 | ① 有遮罩层 ② 需要真鼠标 ③ 元素在 `display:none` 容器里 |
| 一导航就回登录页 | 见上文「鉴权能撑多远」，按 D 路径走 |
| 标签数暴涨 | `netclass up --login` 每次导航开新标签 → 用 `cleanup-for-manual.mjs` 清到 1 个；批量关标签后 CDP 可能失联，需重启实例 |

---

## 步骤

### 1. 起一个专用浏览器实例

复制 `runs/remote/start-visible.ps1` → `runs/remote/start-<平台>.ps1`，改四处：

```powershell
$PORT   = 9227                                            # 新端口，别撞 9224/9225/9226
$PROFILE= 'C:\Users\WJX\AppData\Roaming\OCS Desktop\userDataDirs\<新uid>'   # 专用 profile
$URL    = 'https://<新平台>/<入口页>'
# --load-extension 里必须带上 netclass-loader；窗口尺寸/位置沿用 960x1032 左右半屏
```

**两个必须改掉的坑**：
- 原脚本里有 `Get-Process chrome | Stop-Process -Force`（**杀全部 Chrome**）→ 改成
  按端口杀：`Where-Object { $_.CommandLine -match "remote-debugging-port=$PORT" }`；
- 纯 ASCII（中文注释过 `nc.mjs` 分块传输会乱码，见 HANDOVER §5.10）。

建计划任务（`/IT` 才在登录会话出可见窗口）：

```powershell
schtasks /Create /TN NetClassVis-<平台> /SC ONLOGON /RL LIMITED /IT /F /TR "powershell -NoProfile -WindowStyle Hidden -File <bat或ps1路径>"
```

起隧道：`powershell -File scripts\tunnel.ps1 -Port 9227`

### 2. 开扩展开发者模式

```powershell
node scripts\ensure-devmode.mjs --port 9227
```
不开的话 `chrome.userScripts` 不可用，加载器注册必失败（日志：
`'userScripts' API is only available for users in developer mode`）。

### 3. 探测页面（拿真实事实，别猜）

```powershell
node scripts\nc.mjs probe --port 9227 --url "https://<新平台>/<入口>"   # 通用探针：DOM/视频/按钮/全局对象
node scripts\nc.mjs eval  --port 9227 --target <域名子串> --expr "JSON.stringify({
  title: document.title,
  loggedIn: !document.querySelector('#loginId,#username,input[type=password]'),
  lists: Array.from(document.querySelectorAll('[class*=list] li,[class*=item],[class*=chapter]')).slice(0,15)
          .map(e => ({cls:(e.className||'').slice(0,40), t:(e.innerText||'').trim().slice(0,40)})),
  videos: Array.from(document.querySelectorAll('video')).map(v => ({src:(v.currentSrc||'').slice(0,60), dur:v.duration})),
  players: Object.keys(window).filter(k => /player|video|ali|prism|dplayer/i.test(k)),
  frames: Array.from(document.querySelectorAll('iframe')).map(f => (f.src||'').slice(0,70)),
  fileInputs: document.querySelectorAll('input[type=file]').length
})"
```
再抓接口：DevTools Network（`ss-logs.mjs` 看控制台）× 页面里 hook XHR（仓库里 `App.js` 已有 XHR hook 可复用）。
**要捞的三类接口**：播放/进度、题目、提交 —— 新平台适配的成败基本取决于能不能看清这三类。

### 4. 写适配器（改 `userscript/App.js`）

四处一起改，缺一处就不生效：

```js
// ① PLATFORM 映射（文件顶部）
const PLATFORM = /shengshengketang/i.test(HOST) ? 'shengsheng'
  : /bjqiyang/i.test(HOST) ? 'qiyang'
    : /webtrn\.cn/i.test(HOST) ? 'webtrn'
      : /<新域名片段>/i.test(HOST) ? '<新id>' : 'unknown';
const PLATFORM_LABEL = { ..., '<新id>': '<给订单方看的名字>' }[PLATFORM];

// ② 适配器对象（抄 ADAPTER_QIYANG 的骨架，按平台实际实现）
const ADAPTER_<新ID> = {
  id: '<新id>',
  pageKind() { },            // 我在哪一页（列表页/详情页/播放页）
  chapterList() { },         // 待处理项清单（含"已完成"判定依据）
  doneIds() { }, markDone(id) { },        // 本轮进过（防重复跳转）
  completedIds() { }, markCompleted(id) { },  // 站点确认完成（**验收只认这个**）
  goChapter(item) { }, nextChapter() { },
  player() { return null; },   // 有播放器就返回它，供共享的播放策略用
  box() { return null; },      // 有弹题就返回弹窗元素
  onResponse(url, body) { },   // 可选：站点接口回包钩子
  resetRound() { },
  async poll() { ... }         // ★必需：每 3s 调一次，内部自己决定做什么
};

// ③ 选择器
const P_ADAPTER = PLATFORM === 'shengsheng' ? ADAPTER_SHENGSHENG
  : PLATFORM === 'qiyang' ? ADAPTER_QIYANG
    : PLATFORM === '<新id>' ? ADAPTER_<新ID> : null;
```

适配器契约（共享代码会调这些）：
`poll()`（每 3s，**必须返回 promise**，用 `async`）、`onResponse`、`nextChapter`、`leaveSub`、
`resetRound`、`player` —— 其余名字自用。

### 5. 注册域名（两处）

```js
// loader-ext/background.js
const MATCHES = ['https://edu.shengshengketang.com/*', 'https://study.bjqiyang.com/*',
                 'https://tea.webtrn.cn/*', 'https://<新平台>/*'];
```
```json
// loader-ext/manifest.json → host_permissions 同样加上；改版本号（1.2.x → 1.3.0）
```

### 6. 构建 + 部署

```powershell
node scripts\build.mjs ; node scripts\build-loader.mjs
pwsh -NoProfile -File scripts\netclass-deploy.ps1 -Action push    # 一次推齐：脚本 + dist + 扩展三件
node scripts\loader-reload.mjs 9227                               # 改扩展后必须
```
页面生效：刷新页面，或 `node scripts\loader-inject-test.mjs 9227`。

### 7. 验证（不通过不许收工）

```powershell
node scripts\status.mjs                     # 新端口应出现：module=<版本> enabled=... 
node scripts\probe-page.mjs 9227 <域名子串>  # 页面里 window.NetClass 存在、state 与页面实际一致
node scripts\loader-tail.mjs 9227           # lastSig 有值、无重复注册
```
逐项核对：适配器读到的清单/状态**和页面肉眼看到的一致**（不一致 = 选择器写错）。
最后把新平台的事实补进 `references/platforms.md` 与 `docs/HANDOVER.md §6`，并按病历本风格提交。

## 收工前自检

- [ ] `MATCHES` 与 `host_permissions` 都加了，`manifest` 版本号升了
- [ ] `PLATFORM` 映射、`PLATFORM_LABEL`、适配器、`P_ADAPTER` 四处都改了
- [ ] 新脚本纯 ASCII；没有全量杀 Chrome 的语句
- [ ] `status.mjs` / `probe-page.mjs` / `loader-tail.mjs` 三项都过
- [ ] 平台事实写回 `platforms.md` + HANDOVER；commit message 写了根因
- [ ] 人工闸门（验证码/人脸/短信/考试）明确标注为 `human_required`，没有尝试绕过
