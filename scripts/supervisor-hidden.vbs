' supervisor-hidden.vbs — 无窗口启动 netclass 系统主管
' 为什么单独写一个 VBS：计划任务直接跑 node 会**闪出控制台窗口**（用户明确要求"不要弹窗"）。
' WScript.Shell.Run 的第 2 参数 0 = 窗口隐藏且不激活；第 3 参数 False = 不等待。
' 路径写死在这里，避免经 schtasks/Start-Process 传参时的引号嵌套地狱。
Option Explicit
Dim sh, repo, node, cmd
repo = "D:\Vibe\NetClass"
node = "C:\Coding\node\node.exe"
cmd = """" & node & """ scripts/supervisor.mjs --interval=60"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = repo
sh.Run cmd, 0, False
