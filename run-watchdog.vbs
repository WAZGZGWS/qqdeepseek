' run-watchdog.vbs —— 隐藏窗口跑看门狗脚本（不闪黑框）
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""E:\1\qq-stack\mailbot\watchdog.ps1""", 0, False
