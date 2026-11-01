# 自启动项全景：计划任务（含最高权限）、注册表 Run、启动文件夹
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File autoruns.ps1
Write-Host "== 计划任务：会弹 UAC 的（Highest）==" -ForegroundColor Cyan
Get-ScheduledTask | Where-Object { $_.Principal.RunLevel -eq 'Highest' -and $_.State -ne 'Disabled' } |
  Select-Object TaskPath, TaskName, State | Format-Table -AutoSize | Out-String -Width 140 | Write-Host

Write-Host "== 计划任务：动作指向非系统路径的 ==" -ForegroundColor Cyan
Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' } | ForEach-Object {
  $t = $_
  foreach ($a in $t.Actions) {
    $line = ($a.Execute + ' ' + $a.Arguments)
    if ($line -match '[A-Za-z]:\\' -and $line -notmatch 'system32|SysWOW64|Program Files\\Windows') {
      Write-Host ("  " + $t.TaskPath + $t.TaskName + " -> " + $line.Trim())
    }
  }
}

Write-Host ""
Write-Host "== 注册表 Run / RunOnce ==" -ForegroundColor Cyan
foreach ($k in 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run',
  'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\RunOnce',
  'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Run',
  'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\RunOnce') {
  $p = Get-ItemProperty $k -ErrorAction SilentlyContinue
  if ($p) {
    $p.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object {
      Write-Host ("  " + $k.Split('\')[0] + " :: " + $_.Name + " = " + $_.Value)
    }
  }
}

Write-Host ""
Write-Host "== 启动文件夹 ==" -ForegroundColor Cyan
$dirs = @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup")
foreach ($d in $dirs) {
  if (Test-Path $d) {
    Get-ChildItem $d | ForEach-Object { Write-Host ("  " + $d + "  ==>  " + $_.Name) }
  }
}

Write-Host ""
Write-Host "== 高频自启服务（Auto 且非微软目录）==" -ForegroundColor Cyan
Get-CimInstance Win32_Service | Where-Object {
  $_.StartMode -eq 'Auto' -and $_.State -eq 'Running' -and $_.PathName -and
  $_.PathName -notmatch 'system32|SysWOW64|Program Files\\Windows'
} | Select-Object Name, @{ n = '路径'; e = { $_.PathName } } | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
exit 0
