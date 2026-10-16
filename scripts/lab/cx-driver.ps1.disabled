# cx-driver.ps1 — 学习通驱动守护（在笔记本上以计划任务方式常驻，脱离会话生命周期）
#   每 30 秒检查 cx-auto.mjs 是否在跑，不在就重新拉起；日志追加到 runs/cx-driver.log
$ErrorActionPreference = 'Continue'
$Repo = 'C:\Users\Administrator\Desktop\Vibe\_opensource\artifacts\TaskMesh\netclass-20261013'
$Node = 'C:\Coding\node\node.exe'
$Log  = Join-Path $Repo 'runs\cx-driver.log'
$Script = Join-Path $Repo 'scripts\cx-auto.mjs'
$Lock = Join-Path $Repo 'runs\cx-driver.lock'

if (-not (Test-Path $Node)) { $Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $Node) { "[cx-driver] node not found" | Add-Content -LiteralPath $Log -Encoding UTF8; exit 1 }

while ($true) {
  # 判活：① 锁文件里的 PID 还活着 ② 命令行里含 cx-auto 的 node 进程
  $alive = $false
  if (Test-Path $Lock) {
    try {
      $pid_ = [int]((Get-Content -LiteralPath $Lock -Raw).Trim())
      $p = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -eq 'node') { $alive = $true }
    } catch { }
  }
  if (-not $alive) {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
               Where-Object { $_.CommandLine -and $_.CommandLine -match 'cx-auto' }
    if ($running) { $alive = $true }
  }
  if (-not $alive) {
    "[cx-driver] $(Get-Date -Format 'HH:mm:ss') 未运行 → 重新拉起" | Add-Content -LiteralPath $Log -Encoding UTF8
    try {
      $proc = Start-Process -FilePath $Node -ArgumentList @($Script, '--port', '9227', '--secs', '10', '--maxmins', '600') `
        -WorkingDirectory $Repo -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $Repo 'runs\cx-driver.out.log') `
        -RedirectStandardError  (Join-Path $Repo 'runs\cx-driver.err.log')
      Set-Content -LiteralPath $Lock -Value $proc.Id -Encoding ASCII
    } catch {
      "[cx-driver] 拉起失败: $($_.Exception.Message)" | Add-Content -LiteralPath $Log -Encoding UTF8
    }
  }
  Start-Sleep -Seconds 30
}
