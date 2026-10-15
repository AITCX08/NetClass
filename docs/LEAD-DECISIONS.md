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
