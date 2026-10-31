# mail-penpal watchdog (Windows, optional)
# 每 10 分钟检查一次：15 分钟没有心跳、或进程不在了，就重新拉起 run-loop.cmd。
# 注册（普通权限即可）：
#   schtasks /Create /TN "MailBotWatchdog" /SC MINUTE /MO 10 /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"<本文件完整路径>\" /F"
$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot
$hb = Join-Path $dir 'heartbeat'
$log = Join-Path $dir 'watchdog.log'
$staleMs = 15 * 60 * 1000

function Write-Log($m) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  Add-Content -Path $log -Value $line -Encoding UTF8
}

$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$last = 0
if (Test-Path $hb) {
  $raw = (Get-Content $hb -Raw).Trim()
  if ($raw -match '^\d+$') { $last = [int64]$raw }
}

$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*mailbot.mjs*' })
$alive = ($procs.Count -gt 0)
$fresh = (($now - $last) -lt $staleMs)

if ($alive -and $fresh) { exit 0 }

Write-Log ("stale detected: alive=$alive fresh=$fresh lastbeat=$last")

foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run-loop.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Remove-Item (Join-Path $dir 'lock') -Force
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', (Join-Path $dir 'run-loop.cmd') -WindowStyle Hidden
Write-Log 'restarted run-loop.cmd'
Start-Sleep -Seconds 5
