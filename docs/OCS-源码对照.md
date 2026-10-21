# OCS（全能脚本）源码对照文档

> **用途**：把 OCS Desktop 内置的网课适配器源码整理成"照着就能复刻"的参考。
> **来源**：笔记本 `C:\Users\YOURNAME\AppData\Local\Programs\OCS Desktop\resources\app\lib\src\scripts\`（OCS Desktop 安装目录里的 Electron 应用源码，未混淆）。
> **本地副本**：`reference/ocs-scripts/`（**已 gitignore，绝不入库**）。
> **⚠️ 合规**：这是第三方商业软件源码，只作**思路与选择器对照**；我们自己的实现必须重写代码，不复粘。

---

## 一、架构（三层）

```
script.js            基类链：Script → AutomationScript → ConfigsRequiredAutomationScript → PlaywrightScript
interface.js         TypedEventEmitter（脚本发事件：script-error 等）
index.js             scripts 数组：注册所有脚本（平台适配器都是往这里挂）
utils/index.js       工具：slowType / breakVerifyCode / breakSliderVerify / getBase64
automation/common/   通用脚本（NewPageScript「通用-新建页面」：label 网页链接）
automation/wk/       各平台适配器：cx(超星) / zhs(智慧树) / zjy(职教云) / icve(智慧职教)
collector/           采集脚本（空）
```

**脚本契约**（`ConfigsRequiredAutomationScript`）：
```js
new PlaywrightScript(
  { field: { label: '界面显示名', value: '' }, ... },       // ① 配置字段（渲染成 UI 输入框）
  { name: '超星-手机密码登录', run(page, configs, options) { /* ② 执行体 */ } }
)
```
要点：**配置字段 + 执行体**分离；`options` 里传的是用户自配的 API（`ocrApiUrl` 等）；出错走 `emit('script-error', msg)`。

---

## 二、平台适配器速查（选择器全表）

| 平台 | 文件 | 登录字段 | 关键选择器 / URL |
|---|---|---|---|
| **超星/学习通** | `cx.js` | 手机号+密码；或 学校机构+学号+密码 | `#phone` `#pwd` `#loginBtn`；机构登录：`#otherlogin` → `#inputunitname` → `.filter-list > ul > li` → `#uname` `#password`；登录态判定 `http://i.chaoxing.com/`（**必须 http**） |
| **智慧树** | `zhs.js` | 学校+学号+密码；或 手机号+密码 | `#qStudentID`（学校）→ `#schoolListCode li`（选第一个结果）→ `#clCode` `#clPassword` → `.wall-sub-btn` |
| **职教云** | `zjy.js` | 账号+密码 | `https://zjy2.icve.com.cn/study/index`；`[placeholder="请输入账号"]` `[placeholder="请输入密码"]`；协议 `.agreement .el-checkbox__input`；登录按钮 `.ri .login`（**带 `position:{x:10,y:10}` 点左上角**，避免点到子元素） |
| **智慧职教** | `icve.js` | 账号+密码 | 同款 placeholder 选择器；协议 `.agreement label.el-checkbox`；`form .login`；SSO：`https://sso.icve.com.cn/sso/auth?mode=simple&source=2&redirect=…` |

---

## 三、可复用工具（复刻重点）

### 1. `slowType(page, selector, text)` —— 逐字输入，`delay: 100ms`
避免"瞬间填表"被风控识别。我们的 `cx-login.mjs` 是一次性赋值 + 派发事件，**建议改成逐字输入**。

### 2. `breakVerifyCode(page, imgEl, inputEl, {ocrApiUrl, ocrApiImageKey})` —— 图形验证码
```
① 截图验证码元素 → base64
② POST { [ocrApiImageKey]: base64 } 到用户的 ocrApiUrl
③ 返回 { code, canOCR, error }：canOCR=false → 抛"未装识别模块"；code → 填入输入框
```

### 3. `breakSliderVerify(page, 滑块元素, 拼图base64, 背景base64, {ocrApiUrl, detTargetKey, detBackgroundKey, offset})` —— 滑块
```
① POST { [detTargetKey]: 拼图, [detBackgroundKey]: 背景 } → { canOCR, det: { target: [x, ...] } }
② 取滑块 getBoundingClientRect()
③ mouse.move(x1,y1) → down() → down()（他们连按两次，估计是兼容某些实现）→ move(x2,y2,{steps:10}) → up()
④ x2 = 滑块x + target[0] + offset（默认 offset: 25）
⑤ 等 3s 导航（waitForNavigation timeout 3000，失败即忽略）
⑥ 失败抛「滑块验证识别失败，请尝试手动登录」
```

### 4. `getBase64(url)` —— 抓图片转 base64（拼图元素是 `<img src>`，需要先抓下来）

---

## 四、cx.js 里最值得抄的 4 个"经验值"

| # | 事实 | 为什么重要 |
|---|---|---|
| 1 | **登录态判定用 `http://i.chaoxing.com/`，不能用 https** | 源码原注释：「不能使用 https，这里如果使用 https 在登录后会导致某些同学的课程无法访问」——**照做** |
| 2 | 滑块出现前要先**删遮挡**：`document.querySelectorAll('.u-opacity').forEach(el => el.remove())`，并把拼图 `.cx_imgBtn` 临时 `display:none` 再截背景 | 不删遮挡/不隐藏拼图，OCR 拿到的背景图是错的 |
| 3 | 滑块重试 **5 次**，用尽后抛错交人工 | 自动化边界要写死，别死循环 |
| 4 | 验证码/滑块能力**全部走用户自配 API**（`ocrApiUrl` / `ocrApiImageKey` / `detTargetKey` / `detBackgroundKey`） | 与我们"做题自配 DeepSeek key"是同一模式，可统一到同一个配置面板 |

---

## 五、对我们的复刻清单（映射到 netclass）

| OCS 做的事 | 我们的等价物 | 状态 |
|---|---|---|
| 配置字段渲染成 UI 输入框 | `CFG`（chrome.storage.local）+ 面板 | ✅ 已有，需补"OCR API 地址/字段名"三项 |
| `PlaywrightScript` 的 `run(page, configs)` | `ADAPTER_<平台>` 的方法集（页内 JS，不需要 Playwright） | ✅ 已有骨架（`ADAPTER_CHAOXING` 目前只读） |
| `scripts` 数组注册各平台 | `PLATFORM` 映射 + `MATCHES`/`host_permissions` | ✅ 已有（4 个平台） |
| 登录脚本（4 个平台） | `scripts/cx-login.mjs`（已有）；zhs/zjy/icve 待写 | 🟡 学习通已通 |
| 图形验证码 / 滑块 | **待实现**：照第三节的协议调用户自配 OCR | ❌ |
| 课程处理主体 | `ADAPTER_CHAOXING.taskPoints()` 遍历 + 播放 + 测验 | ❌ **下一步主攻** |

**下一步要再扒一层**：`cx.js` 只有登录；课程遍历/播放/测验在他们的**主 bundle**里（`resources\app\public\assets\*.js`，已编译）。
找法：在那批 assets 里搜 `cx_obstacle` / `taskPoint` / `chapter` / `answering` 之类关键字，命中文件里就有课程处理逻辑。

---

## 六、复刻时的三条纪律（避免踩坑/侵权）

1. **只学思路与选择器，代码自己写**：选择器是事实（不受版权保护），但整段逻辑照抄有风险；我们的实现语言/架构本来就不同（页内 JS vs Playwright）。
2. **`reference/` 永不入库**（已 gitignore）；开源版文档里**不要**出现对方的文件路径与函数原文。
3. **能力（验证码/滑块/答题）一律用户自配 API**：代码里永远不内置任何 key —— 既是合规底线，也是你定的产品模式。
