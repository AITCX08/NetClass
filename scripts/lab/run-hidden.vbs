' run-hidden.vbs — 以【完全无窗口】方式启动命令
' 用途：计划任务里直接跑 node 会闪出一个控制台窗口（用户反馈"不要弹窗"）
'   用 WScript.Shell.Run 的第 2 参数 = 0 表示窗口隐藏且不激活
' 用法：wscript.exe run-hidden.vbs <工作目录> <命令>
Set args = WScript.Arguments
If args.Count < 2 Then WScript.Quit 1
workDir = args(0)
cmd = args(1)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = workDir
' 0 = 隐藏窗口；False = 不等待
sh.Run cmd, 0, False
