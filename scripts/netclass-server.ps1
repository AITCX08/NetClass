<#
  netclass-server.ps1 — 笔记本本机模块服务
  用途：给油猴「壳」提供热加载的 App.js，并接收脚本回传的探测/结果数据。
  目录约定（部署到笔记本）：
      C:\Users\WJX\AppData\Local\TaskMesh\netclass\
          server.ps1     本文件
          App.js         实现模块（由 PC 侧上传）
          logs\serve.log 访问日志
          logs\ingest.jsonl 脚本回传数据
  启动： powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
  停止： Ctrl+C 或 Stop-Process（端口 17800）
  仅监听 127.0.0.1，不对外网开放。
#>
param(
  [int]$Port = 17800,
  [string]$Root = "$env:LOCALAPPDATA\TaskMesh\netclass"
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Root, "$Root\logs" | Out-Null

$appJs = Join-Path $Root 'App.js'
$logFile = Join-Path $Root 'logs\serve.log'
$ingest = Join-Path $Root 'logs\ingest.jsonl'

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch { Write-Host "启动失败：$($_.Exception.Message)"; exit 1 }
Write-Log "listening $prefix root=$Root"

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $req = $ctx.Request
  $res = $ctx.Response
  $path = $req.Url.AbsolutePath
  try {
    if ($path -eq '/ingest' -and $req.HttpMethod -eq 'POST') {
      $sr = New-Object System.IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
      $body = $sr.ReadToEnd(); $sr.Close()
      Add-Content -Path $ingest -Value $body -Encoding UTF8
      $res.StatusCode = 200
      $out = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
      $res.OutputStream.Write($out, 0, $out.Length)
      Write-Log "ingest $($body.Length)B"
    }
    elseif ($path -eq '/App.js' -or $path -eq '/') {
      if (Test-Path $appJs) {
        $bytes = [IO.File]::ReadAllBytes($appJs)
        $res.StatusCode = 200
        $res.ContentType = 'text/javascript; charset=utf-8'
        $res.Headers.Add('Cache-Control', 'no-store')
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        Write-Log "GET $path $($bytes.Length)B"
      } else {
        $res.StatusCode = 404
        $out = [Text.Encoding]::UTF8.GetBytes('App.js not found')
        $res.OutputStream.Write($out, 0, $out.Length)
        Write-Log "GET $path 404"
      }
    }
    elseif ($path -eq '/ping') {
      $res.StatusCode = 200
      $res.ContentType = 'application/json'
      $out = [Text.Encoding]::UTF8.GetBytes("{`"ok`":true,`"app`":$([bool](Test-Path $appJs)),`"at`":$([DateTimeOffset]::Now.ToUnixTimeSeconds())}")
      $res.OutputStream.Write($out, 0, $out.Length)
    }
    else {
      $res.StatusCode = 404
      $out = [Text.Encoding]::UTF8.GetBytes('not found')
      $res.OutputStream.Write($out, 0, $out.Length)
    }
  } catch {
    Write-Log "ERR $($_.Exception.Message)"
    try { $res.StatusCode = 500 } catch { }
  } finally {
    try { $res.Close() } catch { }
  }
}
$listener.Stop()
Write-Log 'stopped'
