# NetClass skills

网课业务的两个技能，**本目录是唯一来源**，同步到全局 `$DSH_HOME/skills/`。

| 技能 | 作用 |
|---|---|
| `course-order-desk` | 网课订单**统一入口**：自动判型（视频/问答/论文/讨论帖/未知），再调度到对应执行技能。混合类型任务、没见过的平台都从这里进 |
| `netclass-course-orders` | 平台**执行层**：三平台注册表（shengsheng / qiyang / webtrn）的 CDP + loader 部署链，与写路径（reply / newTopic / attach）；也管新平台适配器 |

两者关系：入口判型 → 执行落地。`course-order-desk` 出正文与调度，`netclass-course-orders` 负责在实验笔记本上真跑。

## 为什么在这里

2026-10-24 之前，这两个技能**直接创建在全局目录**（`~/.dsh/skills/`）里，
既没有项目源、也没有任何 git 跟踪——改了没法回滚，换机器就丢。

现在正本清源：源码在 `NetClass/skills/`，纳入本仓库 git；全局目录只是同步产物。

## 同步

```powershell
cd D:\Vibe\NetClass\skills\_tools
node sync-skills.mjs              # 增量同步到全局
node sync-skills.mjs --check      # 只报差异（有差异退出码 1）
node sync-skills.mjs --status     # 漂移检测：全局被手工改过的文件
node sync-skills.mjs --install-hook   # 装 git pre-commit 提示
```

工具与 AI-Paper 的 `skills/_tools/sync-skills.mjs` 同源，支持增量（sha256 比对）、
`.sync-state.json` 清单、漂移检测。**两个项目的清单互相独立**，各管各的技能，不会误删对方的。

## 边界

- 本目录只管**技能文档与脚本**，不含平台运行时产物（那些在 `dist/`、`runs/`、`loader-ext/`）。
- 技能里的平台细节以 [netclass-course-orders/references/platforms.md](netclass-course-orders/references/platforms.md) 为准，改平台行为先改那里。
