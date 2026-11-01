# 弹窗 / 后台骚扰排查：列出当前所有带标题的窗口
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File windows.ps1
Get-Process | Where-Object { $_.MainWindowTitle } |
  Select-Object ProcessName, Id, MainWindowTitle,
    @{ n = '启动'; e = { try { $_.StartTime.ToString('HH:mm:ss') } catch { '' } } } |
  Sort-Object ProcessName | Format-Table -AutoSize | Out-String -Width 160
exit 0
