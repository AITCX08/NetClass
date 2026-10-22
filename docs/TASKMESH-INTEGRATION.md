# 与 TaskMesh 控制面的集成（薄适配层）

> 版本：2026-10-22 · 适用 NetClass ≥ 0.5.8
> 结论先说：**NetClass 仍是唯一的"执行者"，TaskMesh 只在外面包了一层"看得见 / 叫得醒"的接口**。
> 本次集成**没有修改 NetClass 的运行时代码**（`server.ps1`、`App.js`、`userscript/*`、`scripts/*` 均未改动），
> 只在 TaskMesh 侧新增了 4 个 worker action，并在本文档登记契约。若后续需要改 NetClass 代码，改动会追加到文末「变更记录」。

---

## 1. 为什么这样做

| 方案 | 说明 | 取舍 |
|---|---|---|
| 把课程逻辑改写成 TaskMesh worker | 平台 DOM/登录/视频速率全部重做 | ❌ 高回归风险，NetClass 已有 30+ 测试与真实平台适配 |
| **薄适配层（本方案）** | TaskMesh 只提供 status / logs / progress / restart | ✅ 零侵入，立刻获得远程可见与一键重启 |

---

## 2. TaskMesh 侧提供的动作

| Action | 版本 | 作用 |
|---|---|---|
| `netclass.status@1` | 1 | 17800 服务是否在听、9224-9229 各平台 Chrome 是否在听、NetClass*/TaskMesh-OCS-*/TaskMesh-Learning-* 计划任务状态与上次结果、ingest 尾部 |
| `netclass.logs@1` | 1 | 读 `logs/serve.log` 或 `logs/ingest.jsonl` 尾部（`kind` / `lines`） |
| `netclass.progress@1` | 1 | 直连本机 CDP（127.0.0.1:<port>）读取当前页面 URL/标题/视频进度/是否完成；`match` 可按 URL 子串选标签页 |
| `netclass.restart@1` | 1 | 重启 `NetClassServer` 计划任务，或指定某个 `NetClassVis-*` 任务 |

调用示例（在装有 TaskMesh operator 的机器上）：

```bash
node apps/cli/dist/main.js task start netclass.status@1   --input status.json   --node windows-browser-laptop
node apps/cli/dist/main.js task start netclass.logs@1     --input logs.json     --node windows-browser-laptop
node apps/cli/dist/main.js task start netclass.progress@1 --input progress.json --node windows-browser-laptop
node apps/cli/dist/main.js task start netclass.restart@1  --input restart.json  --node windows-browser-laptop
```

```jsonc
// status.json
{ "ingestLines": 3 }
// logs.json
{ "kind": "serve", "lines": 50 }
// progress.json（match 用于多标签页时选中课程页）
{ "port": 9228, "match": "col.ccjyxy.cn" }
// restart.json（target=task 时必须给 name）
{ "target": "server" }
```

---

## 3. 契约（TaskMesh 依赖这些约定，改之前请先看这里）

| 项 | 约定值 | 备注 |
|---|---|---|
| 部署目录 | `%LOCALAPPDATA%\TaskMesh\netclass` | `server.ps1` / `App.js` / `logs/` 所在处 |
| 本机模块服务端口 | **17800**（仅 127.0.0.1） | `server.ps1` 默认值 |
| 平台 Chrome 调试端口 | 9224 shengsheng / 9225 qiyang / 9226 webtrn / 9227 chaoxing / 9228 ccjyxy / 9229 zhihuishu | 与 `config/platforms.json` 保持一致 |
| 服务任务名 | **NetClassServer** | `netclass.restart --target server` 用它 |
| 其它任务前缀 | `NetClass*` / `TaskMesh-OCS*` / `TaskMesh-Learning*` | 状态查询按前缀匹配 |
| 日志 | `logs/serve.log`、`logs/ingest.jsonl` | 后者每行一条 JSON |

> 如果 NetClass 以后要改端口/任务名，请在本文档「变更记录」里登记，并同步 TaskMesh 侧
> `workers/netclass-ops` 的 `serverPort` / `serverTaskName` / `taskPrefixes` 默认值（或通过 agent 配置覆盖）。

---

## 4. 启用方式（TaskMesh 侧）

笔记本的 agent 配置 `%LOCALAPPDATA%\TaskMesh\agent\config.json` 增加：

```json
{ "netclass": { "enabled": true } }
```

可选覆盖项：`root` / `serverPort` / `chromiumPorts` / `taskPrefixes` / `serverTaskName`。
保存后重启 `TaskMeshService`，agent 心跳里应出现 `netclass.status / logs / progress / restart`。

---

## 5. 首次联调记录（2026-10-22，LAPTOP-NL8QQD15）

| 动作 | 结果 |
|---|---|
| `netclass.status` | 17800 在听；9228(ccjyxy)、9229(zhihuishu) 在听；20 个相关计划任务状态与上次结果全部返回 |
| `netclass.logs` | `serve.log` 尾部可见 `GET App.js` 实时请求（说明浏览器侧模块在拉取） |
| `netclass.progress` (9228) | URL `https://col.ccjyxy.cn/`，标题「长春市中小学教师全员培训平台」，`allDone=true` |
| `netclass.restart` (server) | 任务 `NetClassServer` 重启后 `Running`，17800 重新监听 |

---

## 6. 变更记录

| 日期 | 变更 | 影响 |
|---|---|---|
| 2026-10-22 | 新增本文档；README 增加入口链接 | 无代码改动，仅文档 |
| 2026-10-22 | TaskMesh 侧新增 `workers/netclass-ops`（status/logs/progress/restart） | 不改 NetClass 代码；只读 + 重启计划任务 |

---

## 7. 已知边界

- `netclass.progress` 只读页面状态，**不驱动**课程（驱动仍由页面内模块/驱动器负责）。
- CDP 端口是"打开着的浏览器"才有；浏览器没起时返回 `ok:false`。
- TaskMesh 侧的 `progress` 走本机 127.0.0.1，**不再依赖 PC→笔记本的 SSH 隧道**；旧隧道方案仍可用，两者不冲突。
