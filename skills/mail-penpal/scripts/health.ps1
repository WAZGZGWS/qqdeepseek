# mail-penpal 体检：一次看清她现在的状态
$ErrorActionPreference = 'SilentlyContinue'
$dir = if ($env:MAILBOT_DIR) { $env:MAILBOT_DIR } else { Join-Path $env:USERPROFILE 'mailbot' }   # 用环境变量 MAILBOT_DIR 指过去

Write-Host "== 进程 ==" -ForegroundColor Cyan
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mailbot.mjs' })
if ($procs.Count -eq 0) {
  Write-Host "  服务没在跑！" -ForegroundColor Red
} else {
  foreach ($p in $procs) { Write-Host "  pid $($p.ProcessId)  启动于 $($p.CreationDate)" }
}

Write-Host "== 心跳 ==" -ForegroundColor Cyan
$hb = Join-Path $dir 'heartbeat'
if (Test-Path $hb) {
  $last = [int64]((Get-Content $hb -Raw).Trim())
  $age = [math]::Round((([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $last) / 1000))
  $color = if ($age -gt 600) { 'Red' } elseif ($age -gt 180) { 'Yellow' } else { 'Green' }
  Write-Host "  ${age} 秒前" -ForegroundColor $color
} else { Write-Host "  没有心跳文件" -ForegroundColor Red }

Write-Host "== 状态 ==" -ForegroundColor Cyan
$stateFile = Join-Path $dir 'state.json'
if (Test-Path $stateFile) {
  $s = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "  今天已回：$($s.count) 封"
  Write-Host "  今天花费：$([math]::Round([double]$s.costToday, 4)) 元"
  Write-Host "  待发队列：$(@($s.outbox).Count) 封"
  Write-Host "  长期事实：$(@($s.facts).Count) 条（最近审计 $(if ($s.lastFactsAudit) { ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$s.lastFactsAudit).LocalDateTime.ToString('MM-dd HH:mm')) } else { '从没' })）"
  Write-Host "  悬着的事：$(@($s.openLoops).Count) 条"
  Write-Host "  上一封情绪：$($s.lastEmotion)"
  Write-Host "  余额缓存：$($s.bal) 元"
  if ($s.me) {
    Write-Host "  她的档案：生日 $(if ($s.me.birthday) { $s.me.birthday } else { '未定' }) / 喜欢 $($s.me.likes -join '、')"
  }
} else { Write-Host "  没有 state.json" -ForegroundColor Red }

Write-Host "== 记忆 ==" -ForegroundColor Cyan
$mem = Join-Path $dir 'memory.jsonl'
if (Test-Path $mem) { Write-Host "  索引 $(@(Get-Content $mem).Count) 条" }
$raw = Join-Path $dir 'memory.raw.jsonl'
if (Test-Path $raw) { Write-Host "  原文 $(@(Get-Content $raw).Count) 条" }

Write-Host "== 最近日志 ==" -ForegroundColor Cyan
$log = Join-Path $dir 'mailbot.log'
if (Test-Path $log) { Get-Content $log -Tail 6 -Encoding UTF8 | ForEach-Object { "  $_" } }

Write-Host "== 计划任务 ==" -ForegroundColor Cyan
Get-ScheduledTask | Where-Object { $_.TaskName -match 'MailBot' } | ForEach-Object {
  "  $($_.TaskName)  [$($_.State)]  $(($_.Actions | ForEach-Object { $_.Execute }) -join ',')"
}

Write-Host "== 白名单检查 ==" -ForegroundColor Cyan
if ($s.strangers) { Write-Host "  陌生人：$(@($s.strangers.PSObject.Properties).Count) 个地址" } else { Write-Host "  陌生人：0 个" }
exit 0
