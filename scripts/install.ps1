<#
.SYNOPSIS
  NetClass 一键安装 —— 从零到「扩展装好、等你登录」。

.DESCRIPTION
  这个脚本只做四件事：
    ① 前置检查（Node 版本、目录结构、可选依赖）
    ② 问清你的环境（浏览器在本机还是另一台机器 / CDP 端口 / 部署目录）
    ③ 生成 config/local.json + 构建 + 部署
    ④ 打印接下来要你手动做的事（装扩展 / 开开发者模式 / 自己登录）

  ★ 它【不碰账号密码】，也【不做自动登录】—— 登录由你自己在浏览器里完成。

.PARAMETER Yes
  全部用默认值，不交互（适合脚本化 / CI）。

.PARAMETER BuildOnly
  只构建不部署（浏览器在另一台机器、还没配好 SSH 时用）。

.EXAMPLE
  # 交互式安装（推荐）
  pwsh -NoProfile -File scripts/install.ps1

.EXAMPLE
  # 全默认，只构建
  pwsh -NoProfile -File scripts/install.ps1 -Yes -BuildOnly

.NOTES
  2026-10-20 新增。之前只有 netclass-deploy.ps1（给已有环境用的），
  新用户照着 README 要手工拼 8 步才能跑起来，这个脚本把那 8 步收成 1 条命令。
#>

[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

# ── 输出小工具 ───────────────────────────────────
function Say   ($m) { Write-Host $m }
function Step  ($m) { Write-Host ""; Write-Host "━━━ $m " -ForegroundColor Cyan; Write-Host ("━" * ([Math]::Min(72, 70))) -ForegroundColor DarkCyan }
function Ok    ($m) { Write-Host "  ✅ $m" -ForegroundColor Green }
function Warn  ($m) { Write-Host "  ⚠  $m" -ForegroundColor Yellow }
function Bad   ($m) { Write-Host "  ❌ $m" -ForegroundColor Red }
function Info  ($m) { Write-Host "     $m" -ForegroundColor DarkGray }

function Ask($prompt, $default) {
  if ($Yes) { return $default }
  $v = Read-Host ("  " + $prompt + $(if ($default) { " [$default]" } else { "" }))
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}
function AskYN($prompt, $default) {
  if ($Yes) { return $default }
  $d = if ($default) { 'Y' } else { 'N' }
  $v = Read-Host ("  " + $prompt + " (Y/N) [$d]")
  if ([string]::IsNullOrWhiteSpace($v)) { $v = $d }
  return ($v.Trim().ToUpper() -eq 'Y')
}

Say ""
Say "  ╔══════════════════════════════════════════════════════════╗"
Say "  ║   NetClass 一键安装                                      ║"
Say "  ║   你登录，我干活 —— 不存账号密码，不做自动登录            ║"
Say "  ╚══════════════════════════════════════════════════════════╝"
Say ""
Info ("repo = " + $Repo)

# ══════════════════════════════════════════════
# ① 前置检查
# ══════════════════════════════════════════════
Step "① 前置检查"

$fail = 0

# Node
try {
  $nv = (& node --version) -replace '^v', ''
  $major = [int](($nv -split '\.')[0])
  if ($major -ge 18) { Ok "Node $nv" } else { Bad "Node $nv 太旧（需要 ≥18）"; $fail++ }
} catch {
  Bad "找不到 Node —— 请先安装 Node.js 18+（https://nodejs.org）"; $fail++
}

# 目录结构
foreach ($p in @('scripts', 'userscript', 'config', 'loader-ext')) {
  if (Test-Path (Join-Path $Repo $p)) { Ok ("目录 " + $p + "/") }
  else { Bad ("缺少目录 " + $p + "/ —— 请确认在完整仓库里运行"); $fail++ }
}

# 关键文件
foreach ($f in @('scripts/build.mjs', 'scripts/build-loader.mjs', 'userscript/App.js', 'config/platforms.json')) {
  if (Test-Path (Join-Path $Repo $f)) { Ok $f } else { Bad ("缺少 " + $f); $fail++ }
}

# 可选：ssh / scp（跨机部署才需要）
$sshExe = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (Test-Path $sshExe) { Ok "OpenSSH（跨机部署可用）" } else { Warn "没找到 OpenSSH —— 仅影响「浏览器在另一台机器」的场景" }

if ($fail -gt 0) {
  Say ""
  Bad "前置检查未通过（$fail 项），先修好再来。"
  exit 1
}

# ══════════════════════════════════════════════
# ② 问清环境
# ══════════════════════════════════════════════
Step "② 环境配置"

$remote = AskYN "浏览器在【另一台机器】上吗？（本机运行浏览器选 N）" $false

$cfg = [ordered]@{
  '_comment' = '由 scripts/install.ps1 生成；已在 .gitignore，不会入库'
  ssh        = [ordered]@{ target = ''; port = 22; keyPath = ''; hostKeyAlias = ''; knownHostsFile = '' }
  browser    = [ordered]@{ remoteRoot = ''; extRoot = '' }
  cdp        = [ordered]@{}
  brand      = [ordered]@{ wechatQrSrc = 'userscript/assets/wechat.jpg'; donateQrSrc = 'userscript/assets/donate.png'; sponsorUrl = '' }
}

if ($remote) {
  $target = Ask "浏览器主机（形如 user@192.168.1.100）" "user@192.168.1.100"
  $sshPort = Ask "SSH 端口" "22"
  $keyPath = Ask "SSH 私钥路径" ("C:/Users/" + $env:USERNAME + "/.ssh/id_ed25519")
  $hkAlias = Ask "HostKeyAlias（无特殊需求就填主机 IP）" (($target -split '@')[-1])
  $knownHosts = Ask "known_hosts 路径" ("C:/Users/" + $env:USERNAME + "/.ssh/known_hosts")

  $cfg.ssh.target = $target
  $cfg.ssh.port = [int]$sshPort
  $cfg.ssh.keyPath = $keyPath
  $cfg.ssh.hostKeyAlias = $hkAlias
  $cfg.ssh.knownHostsFile = $knownHosts

  $remoteRoot = Ask "浏览器那台机器上，NetClass 部署到哪个目录" ("C:/Users/" + (($target -split '@')[0]) + "/AppData/Local/TaskMesh/netclass")
  $extRoot = Ask "扩展目录（Chrome 装扩展的位置）" ("C:/Users/" + (($target -split '@')[0]) + "/AppData/Local/TaskMesh/netclass-loader")
  $cfg.browser.remoteRoot = $remoteRoot
  $cfg.browser.extRoot = $extRoot
} else {
  $cfg.ssh.target = ''
  $cfg.browser.remoteRoot = Join-Path $env:LOCALAPPDATA 'TaskMesh\netclass'
  $cfg.browser.extRoot = Join-Path $env:LOCALAPPDATA 'TaskMesh\netclass-loader'
  Info ("本机部署目录: " + $cfg.browser.remoteRoot)
}

# CDP 端口：默认沿用注册表里的映射（本机端口 = 远端端口）
Say ""
Say "  CDP 端口（一般不用改；只有做了端口映射才需要）:"
foreach ($p in @(9224, 9227, 9228, 9229)) {
  $cfg.cdp["$p"] = $p
}
Info "9224 / 9227 / 9228 / 9229 → 同名本机端口"

# 写 config/local.json
$localPath = Join-Path $Repo 'config/local.json'
if (Test-Path $localPath) {
  $backup = $localPath + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $localPath $backup
  Warn ("已存在 config/local.json，备份为 " + (Split-Path -Leaf $backup))
}
($cfg | ConvertTo-Json -Depth 6) | Set-Content $localPath -Encoding UTF8
Ok ("已生成 " + $localPath)

# ══════════════════════════════════════════════
# ③ 构建
# ══════════════════════════════════════════════
Step "③ 构建"

Say "  构建 userscript..."
& node scripts/build.mjs
if ($LASTEXITCODE -ne 0) { Bad "build.mjs 失败"; exit 1 }
Ok "dist/netclass.user.js"

Say "  构建 loader 扩展..."
& node scripts/build-loader.mjs
if ($LASTEXITCODE -ne 0) { Bad "build-loader.mjs 失败"; exit 1 }
Ok "loader-ext 构建完成"

Say "  校验平台注册表..."
& node scripts/registry.mjs validate
if ($LASTEXITCODE -ne 0) { Warn "注册表校验有错误，详见上面输出" } else { Ok "注册表校验通过" }

# ══════════════════════════════════════════════
# ④ 部署（可选）
# ══════════════════════════════════════════════
Step "④ 部署"

if ($BuildOnly) {
  Warn "-BuildOnly 已指定 → 跳过部署"
} elseif ($remote) {
  Say "  跨机部署（scp 到 $($cfg.ssh.target)）..."
  $deployArgs = @('-Action', 'push')
  & pwsh -NoProfile -File (Join-Path $Repo 'scripts/netclass-deploy.ps1') @deployArgs
  if ($LASTEXITCODE -ne 0) { Warn "部署失败 —— 先确认 SSH 能通（ssh $($cfg.ssh.target)）" } else { Ok "部署完成" }
} else {
  Say "  本机部署..."
  $deployArgs = @('-Action', 'push')
  & pwsh -NoProfile -File (Join-Path $Repo 'scripts/netclass-deploy.ps1') @deployArgs
  if ($LASTEXITCODE -ne 0) { Warn "部署脚本返回非 0（可能本机模式还没适配，见下方手工步骤）" } else { Ok "部署完成" }
}

# ══════════════════════════════════════════════
# ⑤ 收尾：要你手动做的事
# ══════════════════════════════════════════════
Step "⑤ 接下来你要手动做的 4 件事"

Say ""
Say "  1) 让 Chrome 带调试端口启动（NetClass 靠 CDP 控制页面）"
Info 'chrome.exe --remote-debugging-port=9228 --user-data-dir="%LOCALAPPDATA%\TaskMesh\chrome-profile-cc"'
Info '（每个平台一个 profile，端口对应 9224/9227/9228/9229）'

Say ""
Say "  2) 装 loader 扩展"
Info ("扩展目录: " + $cfg.browser.extRoot)
Info "Chrome → chrome://extensions → 打开「开发者模式」→ 加载已解压的扩展程序 → 选上面这个目录"
Info "★ 开发者模式必须开：MV3 的 chrome.userScripts 不开就静默失败（页面上什么都不出现，也不报错）"

Say ""
Say "  3) 自己登录（★ 这是产品契约：我们不做自动登录）"
Info "在刚打开的 Chrome 里，逐个平台手工登录一次"
Info "登录态由浏览器 profile 记住，之后 NetClass 直接接管"
Info "查登录态: node scripts/auth.mjs probe"

Say ""
Say "  4) 起守护（可选，长任务才需要）"
Info "node scripts/supervisor.mjs --interval=60"

Say ""
Say "  ── 自查命令 ──────────────────────────────"
Info "node scripts/registry.mjs list        # 6 个平台 + 端口"
Info "node scripts/auth.mjs probe           # 现在登录了吗"
Info "node scripts/orchestrator.mjs list    # 任务单状态"
Info 'node scripts/nl-dispatch.mjs --dry "把长春的课刷完"   # 自然语言派单（不落盘）'

Say ""
Say "  ╔══════════════════════════════════════════════════════════╗"
Say "  ║   安装流程结束。上面 4 件事做完，就能跑了。                ║"
Say "  ╚══════════════════════════════════════════════════════════╝"
Say ""
