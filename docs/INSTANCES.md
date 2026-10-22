# 多实例模型

> 这份文档回答：**多个平台 / 多个账号怎么并行跑，为什么不会打架。**

---

## 1. 模型

```
1 实例 = 1 浏览器进程 = 1 个独占 user-data-dir = 1 个 CDP 端口
```

**同一平台可以开多个实例**（不同账号，各用一份 profile 副本）。

```jsonc
// %LOCALAPPDATA%\NetClass\instances\<id>.json
{
  "id": "ccjyxy--a1b2",              // platform + 4 位短哈希
  "platform": "ccjyxy",
  "port": 9228,                       // 首实例用平台默认位，额外实例走动态池
  "profile": "%LOCALAPPDATA%\\NetClass\\profiles\\ccjyxy--a1b2",
  "mode": "offscreen",
  "state": "running",                // starting|needs_login|running|idle|blocked|dead
  "pid": 217036,
  "url": "https://col.ccjyxy.cn/",
  "task": { "kind": "video", "progress": "71.1/90" },
  "startedAt": "2026-10-22T12:00:00Z",
  "lastHeartbeat": "2026-10-22T12:03:21Z"
}
```

---

## 2. 端口分配

```
9224–9249   静态默认位（7 个平台各占一格）
9250–9399   动态池（额外实例取第一个空闲）
```

**为什么保留静态位**：现有的 `NetClassVis-*` 计划任务、`tunnel.ps1 -Port 9228`、
`registry.mjs byCdp` 全都锚在静态端口上。**改掉等于自毁**，所以只做向后兼容的扩展。

**分配规则**：

```
平台有默认位 && 默认位没被【活着的】实例占 && 默认位没在监听
  → 用默认位
否则
  → 从 9250 起找第一个空闲
```

> ⚠️ 踩过一个坑：最初把**已死实例**的端口也算进"占用"，导致刚 `stop` 掉的默认位
> 永远拿不回来（实测：9227 释放后新实例仍被分到 9251）。现在只统计 `pidAlive()` 的。

---

## 3. Profile 隔离（硬规则）

```
一实例一 profile，绝不共享 —— Chrome 有单实例锁
```

```
%LOCALAPPDATA%\NetClass\profiles\
├── ccjyxy--a1b2\      ← 账号 A
├── ccjyxy--e5f6\      ← 账号 B（同平台第二个实例）
└── smartedu--c3d4\    ← 另一个平台
```

### 同平台多账号的正确姿势

```bash
# 1) 起一个实例，摆到前台
node scripts/netclass.mjs up --platform ccjyxy --login
#    ↑ 你在窗口里自己登录，我们完全不碰账号密码

# 2) 关掉（登录态写进 profile）
node scripts/netclass.mjs stop ccjyxy

# 3) 复制 profile 出 N 份
#    （或用 netclass up 建新 profile，在里面再登一次）

# 4) N 个实例并行
node scripts/netclass.mjs up --platform ccjyxy
node scripts/netclass.mjs up --platform ccjyxy
```

---

## 4. 资源闸门

实测（Windows，Chrome for Testing 137）：

| 状态 | 单实例内存 |
|---|---|
| 空闲（空白页） | ~180–250MB |
| 播视频中 | ~450–700MB |

```
8GB 机器安全上限：4–6 实例
```

**默认 `maxConcurrent = 4`**，超出直接拒绝而不是硬起：

```bash
node scripts/netclass.mjs up --platform ccjyxy
# ⛔ 已达并发上限 4/4（NETCLASS_MAX_INSTANCES 可调）。
#    先 netclass stop <id> 释放，或等其中一个跑完。
```

```bash
NETCLASS_MAX_INSTANCES=6 node scripts/netclass.mjs up --platform ccjyxy
```

---

## 5. 三态显示

| 模式 | 抢焦点 | 媒体栈 | 用在哪 |
|---|---|---|---|
| `headless`（`--headless=new`） | 否 | 可能被节流 | 纯抓取 |
| **`offscreen`（默认）** | 否 | 完整 | 正常跑课 |
| `headed` | 是 | 完整 | 登录 / 人工验证 |

`offscreen` 的实现：`--window-position=-32000,-32000` —— 有窗口（完整媒体栈），
但在屏幕外，用户看不见、不抢焦点。

> 实测依据：SSH 起的浏览器在 Session 0 没有可见窗口，CDP 照样工作、视频照样播。
> 长春那个窗口其实一直在 `(-32000,-32000)` 正常工作。
> **「看不见」不等于「跑不动」**，但完全 headless 确实可能被节流。

---

## 6. ⚠️ Windows 上启动必须用 WMI

**这是本轮最大的坑，务必记住。**

```js
// ❌ 会死
spawn(exe, args, { detached: false })   // 父进程退出 → 一起死

// ❌ 还是会死
spawn(exe, args, { detached: true })    // 子进程仍继承父 console，SSH 关了就被带走

// ✅ 唯一可靠的
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
```

**原因**：`detached: true` 只创建新的进程组，**不解除 console 继承**。
SSH 会话关掉 → console 消失 → 子进程收到控制事件 → 退出。

WMI 的父进程是 `svchost`（WMI 服务），完全脱离我们的 shell，
会话结束、SSH 断开、CLI 退出都不影响。

**实测对照**：

```
detached:false  → up 打印"已就绪"，6 秒后端口消失
detached:true   → up 打印"已就绪"，6 秒后端口消失
WMI             → up 打印"已就绪"，10 秒后端口仍在，pid 一致 ✅
```

**实现细节**：`CommandLine` 里的引号必须成对。直接拼字符串会坏，
所以 `launch.mjs` 先写一个临时 `.ps1` 再跑，彻底避开引号地狱：

```js
const script = [
  '$ErrorActionPreference = "Stop"',
  '$cmd = @\'',
  cmdline,
  '\'@',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
  'if ($r.ReturnValue -ne 0) { Write-Output ("ERR:" + $r.ReturnValue); exit 1 }',
  'Write-Output $r.ProcessId',
].join('\n');
```

---

## 7. CLI

```bash
node scripts/netclass.mjs up --platform <key>             # 起实例（后台）
node scripts/netclass.mjs up --platform <key> --login     # 起可见窗口，你自己登录
node scripts/netclass.mjs ps                              # 看所有实例
node scripts/netclass.mjs stop <id|all>                   # 停
node scripts/netclass.mjs status                          # 浏览器 + 并发 + 实例总览
node scripts/netclass.mjs attach <id>                     # 探活一个实例
```

`ps` 输出：

```
ID              平台        端口    状态      任务/进度  PID     心跳
--------------  --------  ----  ------  -----  ------  --------
ccjyxy--a1b2    ccjyxy    9228  ▶ running  video 71.1/90  217036  12:03:21
smartedu--c3d4  smartedu  9250  ⏸ idle     —      225112  12:03:18
qiyang--6dff    qiyang    9225  ✖ dead     —      141184(死)  11:11:48
```

**`ps` 是「守管控」的可见性入口** —— 没有它，多实例就是黑箱。

---

## 8. 状态机

```
starting ──→ needs_login ──→ running ──→ idle
   │              │             │          │
   └──────────────┴─────────────┴──────────┴──→ dead
                                   │
                                   └──→ blocked（WAF / 验证码）
```

- **`needs_login`** 是给外部调用方看的信号（AI / MCP 读到就知道要提示用户去登录）
- **`blocked`** 表示被平台拦了，不自动重试，等人介入
- **`dead`** 由 `pidAlive(pid)` 实时判定，不依赖记录里的 `state`

---

## 9. 与 TaskMesh 控制面的关系

如果目标机器接了 TaskMesh，可以完全不用 SSH：

```powershell
$env:TASKMESH_CLIENT_CONFIG = "$env:APPDATA\TaskMesh\client.json"
node apps\cli\dist\main.js task start "netclass.status@1" --input status.json --node <nodeId>
```

| TaskMesh action | 用途 |
|---|---|
| `netclass.status@1` | root / server 端口 / chromium 端口存活 / 计划任务 |
| `netclass.progress@1` | 读课程进度（videoSeconds / durationSeconds / allDone） |
| `netclass.drive@1` | play / pause / next / reload / click |
| **`netclass.eval@1`** | **在页面里跑任意 JS（≤4000 字符）—— 最强** |
| `netclass.logs@1` | 读日志 |
| `netclass.restart@1` | 重启 server 或计划任务 |

设计原则（来自 TaskMesh 契约）：
> **只做生命周期与外设，不碰课程逻辑。**
> 课程怎么刷留在 NetClass，TaskMesh 只管「看得见、叫得醒、出事了能重启」。

**实测验证（2026-10-22）**：

```json
{
  "port": 9225, "ok": true,
  "value": "{\"url\":\"https://example.com/\",\"nc\":\"0.5.9\",\"panel\":true,\"qr\":1,
             \"brand\":{\"w\":81399,\"d\":0,\"label\":\"加我微信\"}}"
}
```

一条 `netclass.eval@1` 同时证明了：浏览器起来了、CDP 注入成功、NetClass 在跑、面板渲染、只显示一个二维码。
