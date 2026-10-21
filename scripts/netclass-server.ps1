<#
  netclass-server.ps1 — 笔记本本机模块服务（给 OCS 脚本列表 + 油猴壳用）
  用途：
    1) /netclass.user.js  → 完整的自包含用户脚本（OCS 脚本列表里填这个 URL，启动浏览器时自动安装）
    2) /App.js            → 实现模块（已装脚本运行时可热加载最新版，不必等下次安装）
    3) /ingest            → 接收脚本回传的探测/结果数据
    4) /ping, /status     → 健康检查
  目录约定（部署到笔记本）：C:\Users\YOURNAME\AppData\Local\TaskMesh\netclass\
      server.ps1 / App.js / netclass.user.js / logs\
  仅监听 127.0.0.1:17800，不对外网开放。
#>
param(
  [int]$Port = 17800,
  [string]$Root = "$env:LOCALAPPDATA\TaskMesh\netclass"
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Root, "$Root\logs" | Out-Null

$appJs = Join-Path $Root 'App.js'
$userJs = Join-Path $Root 'netclass.user.js'
$logFile = Join-Path $Root 'logs\serve.log'
$ingest = Join-Path $Root 'logs\ingest.jsonl'

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch { Write-Host "启动失败：$($_.Exception.Message)"; exit 1 }
Write-Log "listening $prefix root=$Root"

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $req = $ctx.Request; $res = $ctx.Response
  $path = $req.Url.AbsolutePath
  try {
    switch ($path) {
      '/ingest' {
        if ($req.HttpMethod -eq 'POST') {
          $sr = New-Object System.IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
          $body = $sr.ReadToEnd(); $sr.Close()
          Add-Content -Path $ingest -Value $body -Encoding UTF8
          $res.StatusCode = 200
          $out = [Text.Encoding]::UTF8.GetBytes('{"ok":true}')
          $res.OutputStream.Write($out, 0, $out.Length)
          Write-Log "ingest $($body.Length)B"
        } else { $res.StatusCode = 405 }
      }
      '/netclass.user.js' {
        if (Test-Path $userJs) {
          $bytes = [IO.File]::ReadAllBytes($userJs)
          $res.StatusCode = 200
          $res.ContentType = 'text/javascript; charset=utf-8'
          $res.Headers.Add('Cache-Control', 'no-store')
          $res.OutputStream.Write($bytes, 0, $bytes.Length)
          Write-Log "GET user.js $($bytes.Length)B"
        } else {
          $res.StatusCode = 404
          $out = [Text.Encoding]::UTF8.GetBytes('netclass.user.js not found')
          $res.OutputStream.Write($out, 0, $out.Length)
          Write-Log 'GET user.js 404'
        }
      }
      '/App.js' {
        if (Test-Path $appJs) {
          $bytes = [IO.File]::ReadAllBytes($appJs)
          $res.StatusCode = 200
          $res.ContentType = 'text/javascript; charset=utf-8'
          $res.Headers.Add('Cache-Control', 'no-store')
          $res.OutputStream.Write($bytes, 0, $bytes.Length)
          Write-Log "GET App.js $($bytes.Length)B"
        } else {
          $res.StatusCode = 404
          $out = [Text.Encoding]::UTF8.GetBytes('App.js not found')
          $res.OutputStream.Write($out, 0, $out.Length)
          Write-Log 'GET App.js 404'
        }
      }
      '/ping' {
        $res.StatusCode = 200
        $res.ContentType = 'application/json'
        $json = "{`"ok`":true,`"userJs`":$([bool](Test-Path $userJs)),`"appJs`":$([bool](Test-Path $appJs)),`"at`":$([DateTimeOffset]::Now.ToUnixTimeSeconds())}"
        $out = [Text.Encoding]::UTF8.GetBytes($json)
        $res.OutputStream.Write($out, 0, $out.Length)
      }
      '/status' {
        $res.StatusCode = 200
        $res.ContentType = 'application/json'
        $uSize = if (Test-Path $userJs) { (Get-Item $userJs).Length } else { 0 }
        $aSize = if (Test-Path $appJs) { (Get-Item $appJs).Length } else { 0 }
        $json = "{`"ok`":true,`"userJsBytes`":$uSize,`"appJsBytes`":$aSize}"
        $out = [Text.Encoding]::UTF8.GetBytes($json)
        $res.OutputStream.Write($out, 0, $out.Length)
      }
      default {
        $res.StatusCode = 404
        $out = [Text.Encoding]::UTF8.GetBytes('not found')
        $res.OutputStream.Write($out, 0, $out.Length)
      }
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
