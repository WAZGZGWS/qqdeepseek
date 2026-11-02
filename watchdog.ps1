# mailbot watchdog: restart the mailing service when it stops beating.
# Runs every 10 minutes via scheduled task MailBotWatchdog (launched through run-watchdog.vbs so no window flashes).
$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot   # 脚本就放在 mailbot 目录里
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

# Heartbeat is the source of truth. Get-CimInstance can report no process even
# while she is alive (it happened twice on 2026-11-01: alive=False fresh=True,
# and the watchdog restarted a second copy). Only restart when the beat is old.
if ($fresh) { exit 0 }

Write-Log ("stale detected: alive=$alive fresh=$fresh lastbeat=$last")

foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run-loop.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Remove-Item (Join-Path $dir 'lock') -Force
# 通过 VBS 启动：窗口样式 0 = 完全隐藏，不会闪黑框
Start-Process -FilePath 'wscript.exe' -ArgumentList (Join-Path $dir 'run-mailbot.vbs') -WindowStyle Hidden
Write-Log 'restarted via run-mailbot.vbs'
Start-Sleep -Seconds 5
