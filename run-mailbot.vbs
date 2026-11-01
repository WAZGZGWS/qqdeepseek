' run-mailbot.vbs —— 用完全隐藏的窗口启动邮件服务（不闪黑框）
' 放在 mailbot 目录里，路径跟着脚本走，换目录不用改
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd /c """ & here & "\run-loop.cmd""", 0, False
