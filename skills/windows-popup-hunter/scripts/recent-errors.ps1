# 最近的应用错误 / 崩溃 / 错误报告，按来源聚合（弹窗、闪退、后台崩溃都先看这里）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File recent-errors.ps1 -Minutes 60
param([int]$Minutes = 60)

$since = (Get-Date).AddMinutes(-$Minutes)
Write-Host ("== 最近 " + $Minutes + " 分钟的 Application 错误 ==") -ForegroundColor Cyan

$ev = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $since; Level = 2 } -ErrorAction SilentlyContinue
if (-not $ev) { Write-Host "  没有错误事件" -ForegroundColor Green; exit 0 }

Write-Host ("  共 " + $ev.Count + " 条，按来源聚合：")
$ev | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {
  Write-Host ("  " + $_.Count.ToString().PadLeft(5) + "  " + $_.Name)
}

Write-Host ""
Write-Host "注意：Application Error 多半是某程序反复崩溃；Windows Error Reporting 是崩溃后的上报（会弹框）。"
Write-Host "看具体是谁在崩："
$names = @{}
foreach ($e in $ev) {
  if ($e.Message -match 'Faulting application name: ([^,]+)') { $n = $matches[1].Trim(); $names[$n] = 1 + [int]$names[$n] }
}
if ($names.Count) {
  $names.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
    Write-Host ("  崩溃 " + $_.Value + " 次：" + $_.Key) -ForegroundColor Yellow
  }
} else {
  Write-Host "  （事件里没有 Faulting application name，可能是驱动或服务）"
}
exit 0
