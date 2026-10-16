' cxdriver-hidden.vbs — 无窗口启动学习通驱动（并带上守护语义）
' 计划任务里直接跑 node 会闪控制台窗口；这里用 Run(..., 0, ...) 完全隐藏。
Option Explicit
Dim sh, repo, node, cmd
repo = "C:\Users\Administrator\Desktop\Vibe\netclass"
node = "C:\Coding\node\node.exe"
cmd = """" & node & """ scripts/cx-auto.mjs --port=9227 --secs=10 --maxmins=600"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = repo
sh.Run cmd, 0, False
