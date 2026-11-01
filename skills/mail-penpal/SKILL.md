---
name: mail-penpal
description: "邮件妹妹（mailbot）的运维手册：查看状态与健康、读日志排障、翻/删记忆与长期事实、改配置、重启服务、跑自测。触发词：邮件妹妹、她怎么不回、邮箱机器人、mailbot、看看她、她的记忆、她记错了。"
user-invocable: true
---

> 作者和 d 老师的一点思想火花。

> 文中的 E:\1\... 是路径示例，换成你自己项目的目录即可。

# mail-penpal（邮件妹妹运维）

一台 Windows 笔记本上跑的「邮箱笔友」服务：收主人的邮件 → 调 DeepSeek 生成回信 → 用她的邮箱发回去。

## 位置

| 项 | 路径 |
|---|---|
| 服务目录 | `E:\1\qq-stack\mailbot` |
| 主程序 | `mailbot.mjs`（Node ≥ 20）|
| 记忆模块 | `memory.mjs` |
| 状态 | `state.json` / `state.bak.json` |
| 记忆库 | `memory.jsonl`（索引）/ `memory.raw.jsonl`（原文）|
| 日志 | `mailbot.log`（UTF-8）、`out.log`、`err.log` |
| 人格 | `persona.md` |
| 公开仓库副本 | `E:\1\mail-penpal`（脱敏，用 `E:\1\repo-sync.mjs` 同步）|

进程：单个 `node mailbot.mjs`，由 `run-loop.cmd` 守着，`MailBotWatchdog` 每 10 分钟看心跳（`heartbeat` 文件）。

## 先跑体检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.dsh\skills\mail-penpal\scripts\health.ps1"
```

它会一次打出：进程、心跳秒数、今天回了几封/花了多少、待发队列、事实与悬事条数、记忆条数、最近日志、计划任务、陌生人计数。

（这个脚本是 UTF-8 **带 BOM** 的，改完别丢 BOM，否则 PowerShell 5.1 会把中文读成乱码。）

或者直接读：

```powershell
cd E:\1\qq-stack\mailbot
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mailbot.mjs' }
Get-Content heartbeat; Get-Content mailbot.log -Tail 5 -Encoding UTF8
node mailbot.mjs --status   # 注意：会要锁；服务在跑时会提示"已有实例"，属正常
```

## 常用命令

| 想做 | 命令 |
|---|---|
| 看今天回了多少、花了多少、队列、余额、口令状态 | `node mailbot.mjs --status` |
| 看她记得什么 | `node mailbot.mjs --memory` |
| 删某条记忆 | `node mailbot.mjs --memory-del 12` |
| 导出可读版 | `node mailbot.mjs --memory-export`（生成 `memory.md`）|
| 看长期事实（带出处） | `node mailbot.mjs --facts` |
| 删某条事实 | `node mailbot.mjs --facts-del 3` |
| 手动审一次事实 | `node mailbot.mjs --facts-audit` |
| 试一句她的回法（不写信） | `node mailbot.mjs --say "在吗"` |
| 立刻跑一轮收信 | `node mailbot.mjs --once` |
| 测 IMAP/SMTP/余额 | `node mailbot.mjs --test` |
| 写周记/年记（dry 不发） | `node mailbot.mjs --weekly --dry` |
| 清空记忆 | `node mailbot.mjs --memory-clear --yes` |
| 彻底重置 | `node mailbot.mjs --purge --yes` |
| 跑自测（42 项，不连网） | `cd E:\1\mail-penpal; node test/selftest.mjs` |

**注意**：`--status`、`--memory` 等命令启动时会抢单实例锁，服务在跑时会打印“已有实例在跑 pid …”然后退出。要跑这些命令，先停服务循环（`Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | ? { $_.CommandLine -match 'run-loop' } | Stop-Process -Force`），用完再 `Start-Process wscript.exe -ArgumentList 'E:\1\qq-stack\mailbot\run-mailbot.vbs'`。

## 排障清单

| 现象 | 先看 | 可能原因 |
|---|---|---|
| 她不回信 | 日志有没有“收到来信正文” | 信没到（规则/垃圾箱）、或轮询卡住 |
| 回信很慢 | `replyDelay`（默认 fast 20~90 秒）+ 轮询 100 秒 | 正常；凌晨 2~5 点会 5~15 分钟 |
| 收到两封一样的 | 有没有两个 node 实例 | 第二个实例抢锁失败会退，但别手动再起 |
| 她说从没说过的事 | `--facts` 看出处 | 记忆污染，删掉即可 |
| 同一件事反复问 | `state.openLoops` 的 `asked` | 设计上限 2 次 |
| 弹“无法验证发布者” | 框里的文件名 | 旧 QQ 栈残留脚本；已删 `napcat-boot.bat` 等 |
| 火绒弹窗 | 火绒 → 信任区 | 加 `E:\1\qq-stack\mailbot` 和 `E:\nodejs\node.exe` |
| 服务不在 | `--status`、`heartbeat` 时间戳 | 手动 `wscript.exe run-mailbot.vbs` 起 |

## 配置（`config.json`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `owner` | 必填 | 只回这个地址，陌生人一律忽略 |
| `dailyCap` | 35 | 每天最多回几封 |
| `dailyCostCap` | 0.05 | 每天最多花多少元 |
| `replyDelay` | fast | `instant`(2~8s) / `fast`(20~90s) / `human`(2~30min) |
| `timezone` | Asia/Shanghai | 她判断时间用 |
| `memory` | true | `false` = 完全不记、不检索 |
| `facts` | true | `false` = 不产长期事实、不做审计 |
| `secret` | 空 | 一次性口令，验过即免 |
| `mailMaxAgeHours` | 24 | 超过就不回 |
| `proactive` | 见文件 | 主动来信：每天最多一封，要有由头 |

## 禁忌

1. **别同时起两个实例**——会抢同一个信箱、重复回信（踩过）。
2. **别删 `E:\1\qq-stack\dsh-qq`**——DSH 的 MCP 服务在那跑。
3. 改完 `mailbot.mjs` 后：`node --check` → 起服务 → 看日志第一行；要公开就 `node E:\1\repo-sync.mjs` 再推仓库。
4. 仓库推送要 GitHub token（用户会给），用完提醒他删。

## 她的行为规则（改之前先读）

- 时间护栏：按钟点禁语，出现冲突句整句删
- 状态池：`EXTRA_TABLE`，时段 + 当天配额 + `next` 状态链（等外卖→在吃饭→刚吃完）
- 自我档案：`state.me`（生日/喜欢/受不了/小习惯），不许编“我同事”这类来历
- 记忆检索：同义词扩展 + BM25 + 45 天半衰期 + 权重
- 事实：入库要 40% 词重合；每天审计一次，没依据的自动清并留档 `factsDropped`
