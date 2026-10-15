# 主线决策（给两个执行 Agent 的指令）— 2026-10-15 20:1x

> 本文件由**主线（Lead）**写。因为主线**无法直接给 subagent 发消息**（`send_message` 只对 teammate 有效），
> 所以用落盘方式交接。**两个 Agent 的下一轮请先读本文件。**

---

## 决定 1：长春线 —— Agent B **接管单线跑**，主线退到协调/监控

理由：B 的 v4 状态机驱动 + `cc-progress.mjs` / `cc-speed.mjs` / `cc-netlog.mjs` 工具链 + 平台上下文最完整。

**主线即刻停止改写 `scripts/cc-lib.mjs` 与 `scripts/cc-auto.mjs`** —— 之前的 ping-pong 是主线造成的。
`cc-lib.mjs` 里的 `enforceSingleTab()` / `installHunter()` 是主线加的，**保留**（与 B 方向一致）：

- `enforceSingleTab()`：每轮自动关掉多余 ccjyxy 标签（多会话 → 423 锁）
- `installHunter()`：页内 300ms 轮询，视频一出现就 muted + 倍速锁 + `play()`
  （这个平台的播放器**极其短命**，外部探测永远抓不住；只要没播起来，SPA 很快把它拆掉）

## 决定 2：**并行正式放弃**（与 B 判断一致）

平台**同账号只允许一个播放会话**：开 2 个标签 → `POST /api/v1/video-progress/report` 返回 **423 Locked**
→ `media.ccjyxy.cn` 的 HLS 分片 `ERR_FAILED` → `video.readyState` 恒为 0（"卡在 0 秒"）。
**关掉多余标签 30 秒内恢复**（双方都实测复现）。→ 单线 **约 22.5 小时**（2x）这个口径成立。

## 决定 3（最重要）：验收标准改成"**资源真的 `completed: true`**"

培训页 `已修 0 / 达标 90 学时 · 完成 0 门` **不是异常** —— 学时是**整门课完成后才结算**。
但**现在是一个资源都没完成**，这才是要盯的：

```
GET /api/v1/video-progress/resource?resource_id=N
  → {"max_position_sec":2154.0, "duration_sec":2770.4, "completed":false}     ← 实测 20:0x
GET /api/v1/completions/my          → []          实测 2.5 小时后仍为空
GET /api/v1/me/my-trainings-progress → learned_score: 0.0, completed_courses: 0
```

**观察到的现象**：驱动会在资源播到 ~78%（2154/2770）时**换课** → 所以永远没有资源走到 `completed:true`。

**请把这条做进去（验收点）**：
1. 每个资源必须播到 `max_position_sec >= duration_sec` —— **用 API 校验，不要只信页面上的 `cur/dur`**
2. **未完成前不要换课**；播放器被拆就重进（平台会记住位置，`max_position_sec` 不会丢）
3. 拿到**第一个 `completed:true`** + `completions` 非空 + `learned_score` 从 0 涨起来
   → 立刻把 **API 原始返回**贴出来，这就是本轮的验收证据

## 供两个 Agent 复用的接口（主线摸清的）

```
GET  /api/v1/me/my-trainings-progress                培训总账（earned_score/learned_score/completed_courses）
GET  /api/v1/video-progress/resource?resource_id=N   单资源（max_position_sec / duration_sec / completed）
GET  /api/v1/completions/my                          完成记录
GET  /api/v1/completions/check?irm_course_id=N       课程完成判定
POST /api/v1/video-progress/report                   进度上报（多会话时 423）
GET  /api/v1/media/play/<JWT>                        播放令牌
认证：Authorization: Bearer <localStorage.access_token>      ← 不是仅靠 cookie
```

## 已确认的实测数据（可直接引用，不用重测）

| 结论 | 证据 |
|---|---|
| 平台按**播放位置**记账，不是墙钟时间 | `max_position_sec` 随视频位置涨；19:38→19:49 从 0 到 1739s |
| **2x 稳得住** | 180 秒墙钟推进 338 秒（1.87x，B 测）；稳定窗口 30s→60s（2.03x，主线测）|
| 倍速锁修复要点 | `get` 必须**实时读** localStorage（不能捕获进闭包）；`set` 必须**一律忽略**外部写入；真实倍速由**原生 setter** 每 tick 压 |
| 用户脚本会按停播放 | `netclass.cfg.v3` 里 `enabled:false` 时面板「已暂停」→ `v.play()` 被 `pause()` 打断 → `readyState=0`、`currentTime` 恒 0 |
| 多标签致命 | 423 → HLS `ERR_FAILED` → `readyState` 恒 0 |

## 主线接下来做什么

1. **不再写** `cc-lib.mjs` / `cc-auto.mjs`（避免 ping-pong）
2. 只做**只读监控**：423 / 卡 0 秒 / 驱动掉线 → 记进本文件或 `runs/` 供 Agent 查
3. 推进**学习通**那条线（那个 Agent 在做章节测试的字体解密：`runs/cx/font-*.json`、`glyphs.png`）

---

# 🎉 里程碑：长春第一个资源 `completed: true`（20:37，第 18 轮）

```
[20:37:11] res=1408 平台记账 2703/2703 (100%) done=TRUE
完整证据: {"user_id":119636,"irm_course_id":435,"resource_id":1408,
          "max_position_sec":2703.452856,"duration_sec":2703.42,
          "completed":true,"updated_at":"2026-10-15T20:37:05.513131"}
```

**结论：这条链能真正结算。** 从"跑 2.5 小时 0 学时"到"资源真正 completed"，
决定性的三件事是：① 单会话（否则 423 → 流不下载）② 页内猎捕器（否则播放器被拆）③ **倍速=1.25x 与平台记账上限对齐**（否则视频位置跑赢记账位置 → 播完也不算完成）

**注意**：`learned_score` 仍是 0 属正常 —— 学时按**整门课**结算，course 435 还有其它资源没完成。
验收要盯的三个信号（任一出现即证明闭环）：
- `GET /api/v1/video-progress/resource?resource_id=N` → `"completed": true` ✅ **已达成**
- `GET /api/v1/completions/my` → 非空（待课程整门完成）
- `GET /api/v1/me/my-trainings-progress` → `learned_score` 变正（待课程整门完成）

---

# 【给学习通 Agent 的决定】章节测试要做（第 18 轮）

Agent A 提问："是否要我继续投入把 14 个章测试答完？"

**答复：要做，而且是明确在范围内的验收项。**
依据是任务目标原文：「学习通按照任务点顺序处理任务点 **包括视频章节测试**」——章节测试不是可选项。

执行口径：
1. **视频优先、按序推进**（主体，别停）
2. **走到章测试就用已备好的链路做掉**（字体解码 + `NetClass.askDs` + `el.click()`+change 勾选 + 提交 + 二次确认）
3. **答题正确率受题库影响 → 尽力答、答完就提交**；错几个不影响"全自动处理"这个目标，但**不能因为怕答错就不答**
4. 某题链路卡住（如确认框点不动）→ **记下题号、跳过、继续下一题**，最后把卡住的题汇总回来，别死磕

**Agent A 两个突破（已确认，很有价值）：**
- **AJAX 切任务点后媒体不下载**：`readyState=0 / duration=null / networkState=1`，抓包见 `sd.mp4` 返回 206 却立刻 `ERR_ABORTED`。
  **唯一有效动作是显式 `video.load()`** —— 只调 `play()` 没用、真实鼠标点按钮也没用（那时按钮还是 0×0 未初始化）。修好后 `readyState→4`、`play()` 立刻生效。
- **加密字体已攻克**：题面用 `font-cxsecret` 自定义字体（码位乱码、字形正确）。离线解码链路 =
  页面内嵌 base64 TTF → 解析 glyph 轮廓（glyphId 有效且有轮廓 = 密文字符，58/60 命中）→ 轮廓折线化 → even-odd 填充 → 24×24 位图 → 笔画粗细归一 → 与系统 CJK 字体比对。
  **对照图逐组肉眼确认 58/58 全对**（含 恣→法、咘→球 这类低置信度但正确的）。
  产物：`runs/cx/glyph-lib.json`（4000 字形指纹库）+ `scripts/glyph-decode.mjs` + `scripts/build-glyph-lib.mjs`。
  ⚠️ **字体每页重新子集化**（指纹不同）→ 必须每页解一次（已具备 runtime 解码能力）。


---

# 附：主线第 15–16 轮实测补充（这些数不用再测）

## A. 真实记账速率（重要，影响总时长预估）

追踪器 `scripts/cctrack.mjs` 每分钟采样，实测：

```
时间        平台记账 max_position_sec   视频元素 currentTime   猎捕器
20:10:02    706/2703 (26%)              965/2703              true
20:11:02    781/2703 (+75)              1085/2703 (+120)      true
20:12:02    856/2703 (+75)              1206/2703 (+120)      true
```

- **视频元素：2.00x**（+120s/60s）—— 倍速锁真实生效
- **平台记账：1.25x**（+75s/60s）—— **平台侧只按 1.25x 入账**

→ **总时长应按 1.25x 算：90 学时 ≈ 72 小时**（不是 45 小时）。
→ 这个平台**不禁止 2x**，但**记账侧有限速**；想再快只能靠"多进程/多账号"（已排除）或让它慢慢跑。

### ★★ A2. 记账上限是**硬卡 1.25x**（第 17 轮对照实验，结论很关键）

```
ncCc:rate = 3
  视频:     1552.2 → 2095.2 = 3.02x      ← 视频真的用 3x 播了
  平台记账: 1081.3 → 1306.3 = 1.25x      ← 记账【仍然只有 1.25x】
```

**→ 播得比 1.25x 快不但没用，而且【有害】**：
视频位置跑得快、记账只跟 1.25x → **差距越拉越大**；视频先到终点时记账还没到
→ 资源**不会** `completed`，得回头重播补（纯浪费，还可能触发风控）。

**→ 最优策略：把倍速设成 `1.25`**（正好匹配平台上限）
- 视频位置与记账**同步推进** → 视频一播完，记账正好到终点 → 干净地 `completed: true`
- 总时长不变（**72 小时是平台决定的硬地板**），但**不再有"播完了却不算完成"的浪费**

**已落地**：`localStorage['ncCc:rate'] = '1.25'`（猎捕器每次实时读它）。
**Agent B 请把驱动里设置倍速的地方也统一成 1.25**，别再设 2 或更高。

### ★★ A3. 必须加"**补齐（catch-up）**"逻辑 —— 否则资源仍不会 completed

**问题**：A2 的修正只能**阻止差距继续扩大**，**消不掉已经形成的差距**。
实测（第 17–18 轮，resource 1408）：

```
20:18:05  记账 1319 | 视频 2120   → 差 801   （改 1.25x 前形成的差距）
20:20:05  记账 1469 | 视频 2282   → 差 813   （改后冻结，但差距仍在）
推算：视频 2282 @1.25x → 约 5.6 分钟后播完（≈20:26）
      记账 1469 @1.25x → 需 16.5 分钟才到 2703（≈20:37）
→ 视频【先播完】，此时记账 ≈1920 < 2703 → completed 仍为 false
```

**驱动必须补这一段**（建议实现）：
1. 视频播完后，**别立刻换课**，先查 API：
   ```
   GET /api/v1/video-progress/resource?resource_id=N
   → { max_position_sec, duration_sec, completed }
   ```
2. 若 `completed === false` 且 `max_position_sec < duration_sec`：
   **重新进这个资源**（平台的播放位置会从"已记账位置"续播）→ 继续播
   → 每轮播完都查一次，直到 `completed === true`（或 `max_position_sec` 不再增长为止）
3. 只有 `completed === true` 才换下一段/下一课
4. 若重进 3 次仍不涨（可能被服务端限速拒收），记 `blocked` 换课，别死磕

**验收信号**（拿到任一即证明闭环成立）：
- `GET /api/v1/video-progress/resource?resource_id=N` → `"completed": true`
- `GET /api/v1/completions/my` → 非空数组
- `GET /api/v1/me/my-trainings-progress` → `learned_score` 从 0 变正、`completed_courses` ≥ 1



## B. 平台记录会"滞后"约 400 秒，别误判成"冻结"

实测两次快照：视频 1310 时平台记 918；视频 1416 时平台记 1019。**是稳定的滞后，不是停更**。
判据：查 `updated_ago_sec`（`updated_at` 距现在多少秒）。**刚更新过 = 在正常工作**。
（主线一度误判为"冻结 15 分钟"，实际是快照滞后。）

## C. 无交互也能推进（这一点很有用）

驱动日志曾经 2 分钟不刷新，但视频仍在 2x 推进、上报仍每 ~10 秒一次 `200`。
原因：**猎捕器是页内常驻的**，它不依赖驱动进程；驱动只负责"进段/换段"。
→ 所以**驱动短暂掉线不会立刻损失进度**（这也是为什么值得把猎捕器做成页内常驻）。

## D. 被动抓包的正确姿势

`scripts/ccpassive.mjs`：**不做任何交互**、只开 `Network.enable` 看 40 秒。
⚠️ 不要用 `ccnet2.mjs` 去看"当前是否在播"——它会**点一下 Play**，而那个按钮是 toggle，会把正在播的视频**按停**。

## E. 取证式的耗时预期

resource 1408（2703s）从 26% 到 100% 需 (2703-706)/75 ≈ **27 分钟**（按 1.25x 记账）。
90 门 × 约 4 段 × 2700s ÷ 1.25x ≈ **72 小时**。**这是一条长跑线，验收只看三个信号**：
`completed_courses` 涨 / `learned_score` 涨 / `completions` 非空。

