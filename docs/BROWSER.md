# 浏览器供应与版本锁定

> 这份文档回答一个问题：**为什么我们自己带浏览器，以及它怎么落到用户机器上。**

---

## 1. 为什么不用用户自带的浏览器

实测（2026-10-22，Windows 笔记本）：

| 环境 | 现象 |
|---|---|
| 用户装了 360 / QQ / 搜狗 | 都是魔改 Chromium，CDP 能力残缺，行为不可复现 |
| 用户 Chrome 版本老旧 | 可能缺 `--headless=new`（112+）、缺新 CDP 方法 |
| 用户机器只有 Edge 155 | 能用，但和开发机 137 不是同一个东西 → 出问题无法复现 |
| 用户装的是 Chromium 快照 | **没有 H.264/AAC 解码器** → 网课 mp4 直接放不出来 |

最后一条是硬伤：Chromium 开源构建的 `ffmpeg_branding="Chromium"`，剥掉了专有编解码。
网课视频几乎全是 `mp4 (H.264 + AAC)` —— 用 Chromium 快照等于整个项目废掉。

**所以选 `Chrome for Testing`**：Google 官方为自动化发布的 Chrome 构建，**带完整专有编解码**，
和 Playwright / Puppeteer 下载的是同一个东西。

---

## 2. 为什么锁 137.0.7151.55

```
整个技术栈都是在这个版本上实测出来的：
  长春 ccjyxy · 青海 smartedu · 生生 · 超星 · 知到 · 齐阳 · webtrn
  全部跑在 137.0.7151.55 上
```

换任何别的版本都要把 7 个平台重测一遍。**`autoUpdate: false` 是硬规则** ——
升级必须主动改配置 + 重新验证，绝不自动升。

---

## 3. 镜像与可达性（实测 2026-10-22）

```
storage.googleapis.com/chrome-for-testing-public   →  ❌ 国内不可达（SSL 失败）
registry.npmmirror.com/-/binary/chrome-for-testing →  ✅ 200，171,065,107 bytes（163MB）
```

所以 `config/browser.json` 里 **npmmirror 排第一**，官方源只作为境外用户兜底。

**下载速度实测**：163MB / 约 60 秒（约 2.7 MB/s）。

---

## 4. 校验链

Google 的 `known-good-versions-with-downloads.json` **本身不带 per-file SHA256**，
npmmirror 也不提供 `.sha256` 文件。所以用**功能性验证**，比单纯比哈希更实在：

```
① 字节数 == 镜像目录给出的 size（171,065,107）
② zip 能解压（tar / Expand-Archive）
③ 同目录的 <version>.manifest 文件名 == 锁定版本     ← 最硬的一条
④ 解压出的 chrome.exe 的 PE 版本信息 == 锁定版本     ← 兜底
⑤ SHA256 记进 cacheDir/sha256-<ver>.txt（TOFU，供将来检测损坏/篡改）
```

第 ③ 条来自 Chrome for Testing 解压目录里的 `137.0.7151.55.manifest` —— 这是 Google 打进去的，
不是我们自己写的，所以可信。

### ⚠️ 一个必须记住的坑：Windows 上 `chrome --version` 没有输出

```
chrome.exe --version           →  无输出（而且会真的开一个窗口）
chrome.exe --product-version   →  同样无输出
```

原因：`chrome.exe` 是 GUI 子系统程序（`/SUBSYSTEM:WINDOWS`），不挂父控制台，**没有 stdout**。

**所以版本探测分三层**：

| 平台 | 方法 |
|---|---|
| Windows | 读同目录的 `<version>.manifest` 文件名（纯文件系统，最快） |
| Windows 兜底 | `(Get-Item chrome.exe).VersionInfo.ProductVersion` |
| Unix | `chrome --version`（正常打到 stdout） |

---

## 5. 缓存布局：一份二进制，多开不吃多份

```
%LOCALAPPDATA%\NetClass\
├── browser\
│   ├── 137.0.7151.55\chrome-win64\chrome.exe    ← 一份，所有实例共用
│   └── sha256-137.0.7151.55.txt
└── profiles\                                     ← 每个实例独占一个（几十 MB）
    ├── ccjyxy--a1b2\
    ├── smartedu--c3d4\
    └── ccjyxy--e5f6\
```

**开 4 个实例 = 一份浏览器 + 4 个 profile。** 不是 4 × 163MB。

---

## 6. 降级策略

```
镜像全部失败（无网 / 被墙 / 镜像挂）
        ↓
探测系统 Edge → Chrome → Chromium → OCS 内置 chrome
        ↓
找到 → 用，但打印：
  ⚠ 下载失败，降级到系统浏览器：Edge 155.0.4283.45
  ⚠ 版本未锁定，可能出现 --headless=new 缺失、编解码差异、CDP 行为不同
        ↓
全都没有 → 明确报错，给三条出路
```

**环境变量覆盖**（调试/应急）：

| 变量 | 作用 |
|---|---|
| `NETCLASS_BROWSER_DIR` | 换缓存根目录 |
| `NETCLASS_BROWSER_PATH` | 直接指定可执行文件，跳过一切探测 |
| `NETCLASS_USE_SYSTEM_BROWSER=1` | 强制降级到系统浏览器 |

---

## 7. 离线包（给网络差的用户）

GitHub Release 附带可选附件：

```
netclass-browser-win64-137.0.7151.55.zip
```

解压到 `%LOCALAPPDATA%\NetClass\browser\`，程序识别到已存在就跳过下载。

**主仓库仍然只有几 MB** —— 大文件走 Release 附件，不污染 `git clone`。

---

## 8. 已知限制（诚实地写在这）

| 限制 | 说明 |
|---|---|
| **企业组策略 `RemoteDebuggingAllowed=false`** | 挡不住 —— 同一个二进制照样读策略 |
| **杀软拦截 `--remote-debugging-port`** | 便携路径可能少些误报，但不能保证 |
| 首次运行需下载 163MB | 无网环境走离线包 |

前两条给一条出路：

```bash
node scripts/netclass.mjs status     # 会报出浏览器是否可用
```

---

## 9. CLI

```bash
node scripts/browser.mjs status      # 当前用的哪个、版本、来源、SHA256
node scripts/browser.mjs install     # 下载 + 校验 + 解压（幂等）
node scripts/browser.mjs path        # 打印可执行文件路径（必要时自动装）
node scripts/browser.mjs which       # 报告最终会解析到哪个 + 来源
node scripts/browser.mjs use-system  # 强制降级到系统浏览器（调试用）
```
