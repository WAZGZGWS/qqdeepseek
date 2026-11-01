' run-watchdog.vbs —— 隐藏窗口跑 watchdog.ps1
' 放在 mailbot 目录里，路径跟着脚本走
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\watchdog.ps1""", 0, False
