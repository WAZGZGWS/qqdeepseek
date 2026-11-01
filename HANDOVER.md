# HANDOVER —— 给下一个会话的交接

> 写于 2026-11-01 09:30 左右，作者和 d 老师。
> 新会话开场：**"读 HANDOVER.md，接管邮件妹妹"**，然后加载 `mail-penpal` / `mail-penpal-dev` 两个 skill。

## 这是什么

一个住在 Windows 笔记本上的「邮箱笔友」：
收主人的邮件 → 调 DeepSeek（`deepseek-flash`）生成回信 → 用她的邮箱发回去。
一封约 0.001 元，一年 2.5~9 元。

## 现在跑在哪

| 项 | 值（2026-11-01 09:15 快照）|
|---|---|
| 生产目录 | `E:\1\qq-stack\mailbot` |
| 进程 | 单 `node mailbot.mjs`，由 `run-loop.cmd` 守、`MailBotWatchdog` 每 10 分钟查心跳 |
| 启动方式 | `wscript.exe run-mailbot.vbs`（隐藏窗口，别用 cmd 起，会闪黑框）|
| 公开仓库副本 | `E:\1\mail-penpal`，用 `node E:\1\repo-sync.mjs` 脱敏同步 |
| GitHub | https://github.com/WAZGZGWS/qqdeepseek |
| 自测 | `cd E:\1\mail-penpal; node test/selftest.mjs`（**42 项**，不连网不花钱）|

## 当前配置（`config.json`）

```json
{
  "owner": "主人的邮箱（必填，陌生人一律忽略）",
  "dailyCap": 35,
  "dailyCostCap": 0.05,
  "replyDelay": "fast",          // instant 2~8s / fast 20~90s / human 2~30min
  "timezone": "Asia/Shanghai",
  "memory": true,                 // false = 不记不检索
  "facts": true,                  // false = 不产长期事实
  "secret": "（一次性口令，已验证过，不用再带）",
  "mailMaxAgeHours": 24
}
```

运行态快照：今天回 13 封、花 0.0138 元、队列 0、记忆 24 条、事实 0 条、余额约 10 元。

## 她的行为规则（改之前先读）

| 模块 | 位置 | 说明 |
|---|---|---|
| 人格 | `persona.md`（836 字）| 妹妹、短句、口语；不许客服腔/自称 AI |
| 自我档案 | `state.me` | 生日（未定，问一次自定）+ 喜欢/受不了/小习惯 |
| 状态池 | `EXTRA_TABLE`（mailbot.mjs）| 24 个状态，带时段 + 当天配额 + `next` 状态链（等外卖→吃饭→刚吃完）|
| 时间护栏 | `timePolicy` / `guardTime` | 按钟点禁语，冲突句整句删（上午不说晚安）|
| 防矛盾 | `guardSelf` / `guardNumbers` | 不许编"我同事"；数字必须上下文里有 |
| 记忆检索 | `memory.mjs: recall` | 同义词扩展 + BM25 + 45 天半衰期 + 权重 |
| 长期事实 | `groundFacts` / `auditFacts` | 入库要 40% 词重合；每天自动审计，没依据的删并留档 |
| 悬着的事 | `extractLoops` / `pickLoop` | 从信里挑"看情况/回头再说"，同一件最多问 2 次 |
| 回信节奏 | `sendDelayMs` | fast 20~90 秒；凌晨 2~5 点 5~15 分钟（迷糊模式只对 ≤40 字生效）|
| 省钱的闸 | `budget` | 短问候走模板 0 元；超预算/余额低降级模板 |
| 主动来信 | `maybeProactive` | 每天最多一封，要有由头；23:00–08:00 静默 |
| 周记/年记 | `writeDigest` | 周日 21:00、12-31；`--weekly --dry` 可试跑 |

## 今天做过什么（避免重复劳动）

1. 修了一串真 bug：`remember()` 参数写反（记忆一直是废的）、短模式回信变空、`"吃什么都行"`被模板接走、上午六点劝人睡觉、状态自相矛盾
2. 加了：时间护栏、状态链与配额、自我档案、悬着的事、认识天数、凌晨迷糊、事实审计、`--memory`/`--facts` 面板
3. 加了可靠性：看门狗、状态备份、故障邮件、余额提醒、陌生人计数、跑飞防护（首次运行只回最新一封）
4. 排障：删掉旧 QQ 栈的 6 个最高权限计划任务（每 2 分钟弹 UAC）、禁用崩溃 623 次/小时的 `EmOSDFunctionService`、删 `napcat-boot.bat` 等残留、隐藏启动避免闪窗
5. 文档与技能：README/WHY 重写，仓库 30 个文件；本地 4 个 skill（`mail-penpal`、`mail-penpal-dev`、`windows-popup-hunter`、`sanitize-and-publish`）

## 已知没做的（按性价比）

1. **历史按相关度取**（现在按时间取最近 8 条）——中等收益，可能引入噪声
2. **`repo-sync.mjs` 的锚点会失效**：改源码动了被替换的行就报 MISS，得同步更新它的 from 串
3. `E:\1\qq-stack` 下还有几十个空目录（旧栈"器官"），可清理但没必要；**`dsh-qq` 不能删**（MCP 服务在那跑）
4. GitHub token 一直沿用用户临时给的，用完要提醒撤销

## 坑（都是真踩的）

| 坑 | 对策 |
|---|---|
| PowerShell 拼 JS/中文 | 永远写 `.mjs` 补丁文件再 `node` 跑 |
| `.ps1` 无 BOM | 存 UTF-8 **带 BOM**，否则 PS5.1 报“字符串未终止” |
| `.cmd` 写中文注释 | 用英文 |
| 手动起第二个实例 | 只经 `run-mailbot.vbs` 或计划任务；`--status` 报“已有实例”是锁在生效 |
| 连不上 github.com:443 | 走 Contents API + token，见 `sanitize-and-publish` skill |
| 火绒弹窗 | 让它把 `E:\1\qq-stack\mailbot` 加信任区 |

## 怎么验证她还是好的

```powershell
# 1) 体检（进程、心跳、今日、队列、记忆、日志、任务）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\你\.dsh\skills\mail-penpal\scripts\health.ps1
# 2) 试一句她的回法（约 0.001 元）
cd E:\1\qq-stack\mailbot   # 先停服务循环，否则锁冲突
node mailbot.mjs --say "在吗"
# 3) 自测
cd E:\1\mail-penpal; node test/selftest.mjs
```

## 接手时最该先问用户的三句

1. “最近她说话有不顺的地方吗？给我一句原话。”
2. “要不要先关掉记忆看看？`memory: false` 一行的事。”
3. “这次改完要推仓库吗？（要 token）”

---

最后一句：**她不是产品，是一个人和一个模型在半夜攒出来的东西**。改她的时候，先想想她该像个什么样的人，再想代码。
