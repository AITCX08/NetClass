# 架构梳理 & 开源清理清单

> 生成于 2026-10-16。用途：**开源前的架构交底 + 必做清理项**。

---

## 一、项目是什么

**NetClass** —— 网课平台的自动化刷课栈。用一个 MV3 浏览器扩展把「网课自动化模块」注入目标站点，模块在**页面内**完成播放/答题/跳转；外部用 Node 脚本通过 **CDP** 做驱动与看护。

**支持平台**：学习通（超星）· 长春教师培训（ccjyxy）· 生生课堂（shengsheng）· 智慧树知到 · 齐阳 · webtrn

---

## 二、四层架构

```
┌─────────────────────────────────────────────────────────────┐
│ ① 用户脚本层  userscript/App.js（144KB，核心）                │
│    一个文件 = 全部平台逻辑。跑在页面内（chrome.userScripts 注入）│
│    · PLATFORM 判定 → P_ADAPTER 选适配器（每平台一个 ADAPTER_*）  │
│    · 面板 UI（进度/暂停/倍速/答题/下一节/设置）                  │
│    · 视频策略（自动播放/静音/倍速纠正/结束下一节/掉速重试）        │
│    · 随堂题自动作答（DeepSeek 给答案）                          │
│    · 字体解密（学习通 font-cxsecret）                          │
│    · 设置 Schema（13 项）+ 跨进程同步（写 localStorage 给驱动器读）│
├─────────────────────────────────────────────────────────────┤
│ ② 扩展加载层  loader-ext/（MV3）                              │
│    manifest.json  host_permissions（8 个域名）                 │
│    background.js  · MATCHES 列表 + 从本机服务拉 CODE_URL 注入   │
│                   · 转发 DeepSeek 请求（绕 mixed-content）      │
│    bundled.js     build-loader.mjs 生成的打包副本               │
├─────────────────────────────────────────────────────────────┤
│ ③ 驱动层  scripts/（Node + CDP）                              │
│    nc.mjs              CDP 统一入口（eval/run/shot）           │
│    cc-auto.mjs         长春驱动（状态机：HOME/PLAY/COURSE/PICK） │
│    cx-auto.mjs         学习通驱动                              │
│    cx-answer-quiz.mjs  学习通答题器（整卷作答 + 提交前校验）      │
│    各平台 *-lib.mjs     共享库（选择器/状态机/工具）              │
├─────────────────────────────────────────────────────────────┤
│ ④ 守护层  scripts/（保活 + 自愈）                              │
│    supervisor.mjs      系统主管：每 60s 体检、补进程、重建隧道    │
│    ss-watch.mjs        流卡死/模块失能自愈（判据见下）            │
│    cx-submit-watch.mjs 填了没提交时自动交                        │
│    progress-report.mjs 每 5 分钟三平台进度快照                   │
│    tunnel.ps1          SSH 隧道（本机 ↔ 笔记本）                 │
│    计划任务 NetClass-Supervisor（唯一启动器，MultipleInstances=IgnoreNew）│
└─────────────────────────────────────────────────────────────┘
```

**运行位置**：浏览器在**笔记本电脑**上（`WJX@192.168.1.8`），桌面通过 SSH 隧道连 CDP 端口
```
9224 shengsheng · 9227 学习通 · 9228 长春 · 9229 知到
```

---

## 三、关键设计（开源时要讲清的）

### 1. 为什么模块跑页面内，而不是靠 CDP 驱动？
**反检测**。知到的站点脚本会检查：
```js
isNative(window.XMLHttpRequest) && isNative(XHR.prototype.open) &&
!window['OCS'] && isNative(Element.prototype.addEventListener)
```
外加元素级 `!e.isTrusted` 判合成事件 → 弹「检测到异常脚本」+ 3 秒跳回门户。
**所以**：页面侧只识别/解析/决策，**点击一律用 CDP 真鼠标事件**（`isTrusted=true`）。

### 2. 完成判据**必须逐平台探**（没有通用的）
| 平台 | 唯一可靠的判据 |
|---|---|
| 学习通 | `span.roundpoint` 的类名（`blue`=已完成 / `orange01 jobCount`=未完成）|
| 长春 | 培训页原文「已修 N 学时」 |
| 知到 | `POST learning/queryStuyInfo` 的 `watchState===1`（DOM 里的 ✓ 在 73 个小节上完全一致，数不出来）|
| shengsheng | 视频位置 + 「已完成」标记 |

### 3. 平台硬约束（踩出来的，不是猜的）
| 平台 | 约束 |
|---|---|
| **长春** | ⛔ **单会话硬保护**（第二页 → 「本播放页已停止」+ `report` 返回 **423 Locked**）· MUI/React 按钮需真实鼠标事件 · 记账硬卡 1.25x（所以要重播补录）|
| **学习通** | ⛔ **禁改设备指标**（`Emulation.setDeviceMetricsOverride` 触发风控）· 测验页在 **3 层 iframe** |
| **知到** | ⛔ 站点检测 `XHR.prototype.open` 的 native 性 · 考试页有 CSP（`connect-src 'self'`）→ 页面内问不了 DeepSeek |

### 4. 守护体系（这是"能长期无人跑"的关键）
```
supervisor.mjs 每 60s：端口体检 → 隧道重建 → 进程缺了就补 → 清重复实例
ss-watch.mjs   两条新判据（实测踩过）：
               · NetClass.state.video.seen 持续为 0 → 模块失能
               · 视频在末尾且暂停连续 3 次 → 切节链断了
               两条都触发 Page.reload（**不是 load()** —— MSE 流会被打断）
```

---

## 四、🔴 开源前必做（按优先级）

### ① 手机号/账号脱敏 —— **5 个文件，含 README**

```
docs/CC-STATUS-LEAD.md
scripts/ss-structure.mjs
scripts/tokendiff.mjs
scripts/webtrn-login.mjs
README.md                 ← ★ 开源门面，最要紧
```

**改法**：全部替换成占位符（`13800000000` / `your_account`）。
**同时检查**：课程名、订单信息、真实姓名。

### ② `runs/` 有 **425 个文件被 git 跟踪** —— 必须从索引里移除

`runs/` 是运行产物（日志、快照、证据），含**课程名、进度、URL、token**。

```powershell
# 从 git 索引移除（保留本地文件）
git rm -r --cached runs
# 追加到 .gitignore
Add-Content .gitignore "runs/"
```

**要保留的极少数**（如果需要示例）：
```
runs/README.md                    说明这个目录是什么
runs/orders/zhihuishu-*/03_验收报告.md   如果要做示例（先脱敏）
```

### ③ `scripts/` 瘦身 —— 246 个文件，大量一次性调试脚本

**从文件名就能看出是一次性探索**：
```
tm-*.mjs       40+ 个   Tampermonkey 探索（早已确定用 MV3 loader，不再需要）
cc-*（无 auto/lib） 30+ 个   长春探索：cc-try / cc-go / cc-click1 / cc-exp / ccexp / cctest …
cx-*.mjs（无 auto/answer）  20+ 个   学习通探索：cx-enter / cx-enter2 / cx-loop …
webtrn-*.mjs   20+ 个   webtrn 探索
ss-*.mjs（无 watch/quiz-watch）  20+ 个   shengsheng 探索
qy-*.mjs / qiyang-*.mjs  8 个
```

**建议保留的核心（约 20 个）**：
```
nc.mjs                     CDP 统一入口          ★ 必备
supervisor.mjs             系统主管              ★ 必备
ss-watch.mjs               shengsheng 看门狗
progress-report.mjs        进度快照
status.mjs                 全局体检
build.mjs / build-loader.mjs   构建
netclass-deploy.ps1        部署
tunnel.ps1                 隧道
cc-auto.mjs + cc-lib.mjs   长春驱动
cx-auto.mjs + cx-answer-quiz.mjs   学习通驱动 + 答题器
tile-4-cdp.mjs             窗口平铺（可选）
hide-infra-windows.ps1     隐藏窗口（可选）
```

**其余可以移到 `scripts/lab/` 或直接删**（它们已经完成了历史使命）。

### ④ 检查 `docs/` 里的内部信息
```
docs/CC-STATUS-LEAD.md      64KB —— 主线与子智能体的交接流，含大量内部细节
docs/HANDOVER.md            69KB —— 全平台病历本，★ 这个是最有价值的，建议保留+脱敏
docs/LEAD-DECISIONS.md      13KB —— 决策记录
docs/OCS-万能-源码逆向对照.md 18KB —— ★ 建议保留（技术含金量高）
```
**建议**：`CC-STATUS-LEAD.md` 是过程性的，**开源时删掉或大幅精简**；`HANDOVER.md` 和 `OCS-万能-源码逆向对照.md` 保留。

### ⑤ License
`README.md` 里要写明。**注意**：`reference/` 下的 OCS（MIT）和万能脚本（无声明）**已被 gitignore**，开源时不要带进去。

---

## 五、一句话总结

**架构是干净的**：用户脚本（页面内）+ MV3 加载器 + CDP 驱动 + 守护体系，四层职责清晰；
**代码里没有密钥**；
**但开源前必须做三件事**：① 手机号脱敏（含 README）② `runs/` 从 git 移除 ③ `scripts/` 从 246 瘦到 ~20。
