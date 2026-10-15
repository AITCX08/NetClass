# 长春教师培训（col.ccjyxy.cn）实况与约束 — 2026-10-15 20:00 更新

来源：本机实测（本会话）+ 现场另一个驱动进程留下的注释。
**这份文件是交接给下一个接手的智能体的"事实清单"，请以它为准，不要重复踩坑。**

## 一、平台硬约束（最重要）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **同一个账号只能有一个播放会话** | 同账号开 2 个标签 → `/api/v1/video-progress/report` 返回 **423 Locked** → `media.ccjyxy.cn` 的 HLS 分片 `ERR_FAILED` → `video.readyState` 恒为 0（"视频卡在 0 秒"）。关掉多余标签 30 秒内恢复到 `readyState=4` 并正常推进。 |
| 2 | **`/json/new` 能开新标签**，但开着就是 423 | 实测 `PUT /json/new?url` 返回 200，标签出现；同时播放两个标签 ≈ 两边一起废 |
| 3 | 结论 | **不要并行**。老老实实单标签单驱动跑。想并行只能上第二个浏览器 profile + 同账号（同样会 423 锁死），或用第二个账号（没有）。 |

## 二、播放与倍速

| # | 事实 | 证据 |
|---|---|---|
| 4 | **2x 是稳的**（能一直保持，不会被打回 1x） | `cc-speed.mjs` 实测 180 秒：视频推进 338 秒，平均实速 **1.87x**，`playbackRate` 一直报 `2`（此时用户脚本 `cfg.enabled=false`） |
| 5 | 早期"倍速锁死 1x"的结论是**误判** | 当时 `netclass.cfg.v3` 里 `enabled:false`，脚本的倍速纠正没跑；且 `playbackRate` 被站点监听改写时看起来"被打回"。现在的实测是 2x 稳住 |
| 6 | `小时数` 与真实时长 | 一门课 = 2~4 段，单段 40~50 分钟（例如 2770 秒 / 2403 秒）。**90 学时 ≈ 45 小时视频墙钟**（2x 下约 22.5 小时纯播放） |
| 7 | 起播方式 | 课程详情页的「播放/继续」按钮用 **DOM `.click()`** 能起播；CDP 真实鼠标点在按钮上有时不触发（点列表项左侧文字也行） |
| 8 | 看到 `<video>` 但 `readyState=0` 且 `buffered` 空 | 就是 423 锁 / 会话被抢；不是网络慢，别去调代理或超时 |

## 三、用户脚本（Tampermonkey）

| # | 事实 | 证据 |
|---|---|---|
| 9 | 脚本在 ccjyxy **没有适配器**（`P_ADAPTER = null`） | `window.NetClass` 面板显示 v0.5.0 + 平台名，但 `cfg` 里没有 ccjyxy 专属项 |
| 10 | `cfg.autoNext=true` 会**盲点站点的「下一节」** | 实测：SPA 在「培训页 ↔ 课程页」之间来回 ping-pong，每 14~20 秒一次，`__ccTrace` 记录到 `CLICK on <DIV> "XX课程 编码:..."` 反复出现 |
| 11 | `cfg.enabled=false` 会让面板显示「已暂停」，并**按停播放** | 播放器页日志刷 `[NetClass] 已停用/已完成：按停播放`，`v.play()` 报 `interrupted by a call to pause()` |
| 12 | 正确配置 | `enabled=true`（保留倍速纠正）、`autoNext=false`（防 ping-pong）、`autoQuiz=false`、`antiPause=false`。已写进 `scripts/cc-lib.mjs` 的 `killUserscript()` |

## 四、页面状态机与选择器

| 状态 | 判据 | 关键元素 |
|---|---|---|
| T 培训页 | 文本含「学习总进度」/「本培训须完成」 | 三个 `h3.MuiAccordion-heading`；课程卡 = `li.MuiListItem-root` 里 `/编码[:：]/ && /学时/`；**只渲染展开分类里的卡片（懒加载）** |
| C 课程详情页 | 有按钮「返回培训内容列表」 | 段条目 = `li.MuiListItem-root` 里含 `button` 文本 `播放|继续|重播`，且不含「编码」 |
| P 播放器页 | 有按钮「返回课程列表」+ `<video>` | 进度文本 `NN%`；`vjs-play-control` |
| M 我的培训页 | 有「进入」按钮且无「学习总进度」 | 点「进入」进培训页 |

- 展开分类：真鼠标点 `.MuiAccordionSummary-root` 的**左侧区域**（`x = left+22`）。点按钮正中偶尔不生效。
- 课程名长度可达 40+ 字，**别按长度过滤**（`>60` 会丢掉课）。
- 「已修 X / 达标 Y 学时 · 完成 Z 门」是**页面级**进度；单个课程卡的状态文字是 `未学习/已学习`，**不显示百分比**；百分比只出现在课程详情页的段条目/播放页。
- 段进度会**断点续播**（`继续` 按钮 + `NN%`），中途停下不丢分。

## 五、当前进度基线（2026-10-15 20:06）

- 培训页：`已修 0 / 达标 90 学时 · 完成 0 门`
- 正在做：专业课-初中数学 →「初中数学-新课标视角下教学目标的设计与实践」
  - 播放页 `485/2703s @2x`，页面显示 `18%`
- 说明：**学时还没入账**（预期在单段完播、平台上报后才会涨）。下一次验收要盯「已修」是否 > 0。

## 六、能用的工具（本会话产出）

| 脚本 | 用途 |
|---|---|
| `scripts/cc-lib.mjs` | 共享库：CDP 原语、页面状态探针、`ensureTraining/expand/enumerate/openCourse/playFirstSegment/backToTraining/killUserscript`、跨进程认领 `claimCourse/touchClaims`、单标签收敛 `closeExtraTabs` |
| `scripts/cc-auto.mjs` | v4 状态机驱动（HOME/PLAY/COURSE/PICK），自己完成导航+播放；一个实例一个标签 |
| `scripts/cc-progress.mjs` | 进度快照（培训页学时/门数 + 播放页 cur/dur/rate/pct），可 `--watch 600 --every 300` 存 `runs/cc-progress.jsonl` |
| `scripts/cc-speed.mjs` | 实测真实倍速（视频秒/墙钟秒） |
| `scripts/cc-eval.mjs` | 对第 N 个/全部 ccjyxy 标签执行一段 JS（支持 `--file`） |
| `scripts/cc-state.mjs` | 周期打印各标签状态（找"谁在乱跳"用） |
| `scripts/cc-netlog.mjs` | 抓 console + 网络（诊断 423 / HLS 失败） |
| `scripts/cc-launch.ps1` | 杀旧驱动 + 重启（**注意：并行启动两个实例会触发 423，别用 -Restart 起第二个**） |

## 七、别再做的事（血泪）

1. **不要开第二个标签/第二个实例"并行加速"** —— 423 锁会把两个都废掉。
2. **不要 `NetClass.dispose()`** —— 会把倍速一起关掉。用 `killUserscript()`（只关 autoNext/autoQuiz/antiPause）。
3. **不要把"枚举到 0 门"当全部完成** —— 分类折叠 + 懒加载；返回培训页后要重新展开、等渲染。
4. **不要用 `Get-CimInstance ... | Where-Object CommandLine` 杀进程时把变量命名成 `$pid`** —— PowerShell 里 `$PID` 只读，会静默失败。
5. **不要相信"倍速锁死 1x"的旧结论** —— 现在实测 2x 稳。
