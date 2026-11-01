---
name: mail-penpal-dev
description: "改「邮件妹妹」（mailbot）的省 token 工作流：先查 MAP.md 定位、按行号局部读、用 patch 脚本改、跑自测、隐藏重启、脱敏同步、走 API 推仓库。触发词：改她、优化她、给她加功能、修 mailbot、她说话怪、改她的记忆、邮件的代码。"
user-invocable: true
---

> 作者和 d 老师的一点思想火花。

# mail-penpal-dev（改她的代码时用）

目标是**不整文件读、不瞎试、一次改对**。mailbot.mjs 已经 1300+ 行，整读一次约 2 万 token，读完还没定位到要改的地方。

## 三条铁律

1. **先读 `MAP.md`（本目录，约 2.5k token），再按行号局部读 30~60 行。** 绝不整文件读。
2. **改代码一律写 `patch.mjs` 再 `node patch.mjs`。** 不要用 PowerShell 拼字符串改源码——引号、`$`、反引号、编码（BOM/GBK）会连环出事，这个坑踩过四次。
3. **一次只改一件事，改完立刻验证**（见下面流程）；验证不过就回滚，别叠加第二处改动。

## 标准流程

```powershell
# 0. 定位
Get-Content C:\Users\ZhuanZ1\.dsh\skills\mail-penpal-dev\MAP.md -TotalCount 60

# 1. 看目标区域（只读 40 行）
#    read E:\1\qq-stack\mailbot\mailbot.mjs offset=<行号> limit=40

# 2. 写补丁（放 E:\1\patch-xxx.mjs，别放仓库目录）
#    模板见下面

# 3. 应用 + 语法检查
cd E:\1; node patch-xxx.mjs
cd E:\1\qq-stack\mailbot; node --check mailbot.mjs

# 4. 跑自测（42 项，不连网、不花钱）
cd E:\1\mail-penpal; node test/selftest.mjs

# 5. 同步脱敏副本（锚点失效会报 MISS，那就顺手更新 repo-sync.mjs）
cd E:\1; node repo-sync.mjs

# 6. 隐藏重启（不要用 cmd 起，会闪黑框）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mailbot.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item E:\1\qq-stack\mailbot\lock -ErrorAction SilentlyContinue
Start-Process wscript.exe -ArgumentList 'E:\1\qq-stack\mailbot\run-mailbot.vbs'
Start-Sleep 8; Get-Content E:\1\qq-stack\mailbot\mailbot.log -Tail 3 -Encoding UTF8

# 7. 推仓库（要用户给 token；推完提醒他删）
```

## 补丁模板

```js
import fs from 'node:fs';
const P = 'E:/1/qq-stack/mailbot/mailbot.mjs';
let s = fs.readFileSync(P, 'utf8');
let bad = 0;
const rep = (from, to, tag) => {
  if (!s.includes(from)) { console.log('MISS', tag); bad += 1; return; }
  s = s.split(from).join(to); console.log('ok  ', tag);
};
rep(`原文片段`, `新片段`, '说明');
if (bad) { console.log(bad + ' 处没改上，未写入'); process.exit(1); }
fs.writeFileSync(P, s);
console.log('已更新');
```

要点：锚点取**唯一且有辨识度**的行；替换时把锚点原文也写回（否则会把函数签名吃掉，出过 `Illegal return statement`）。

## 验证矩阵：改哪里 → 看什么

| 改了 | 必须看 |
|---|---|
| 任何函数 | `node --check` + `node test/selftest.mjs` |
| 记忆/检索 | selftest 的 `[9] 记忆库` 段 + 手动 `--memory` |
| 提示词/rules | 一次 `--say "<一句测试>"`（约 0.001 元），读输出 |
| 状态池/时段 | selftest 的「状态配额」「时段禁语」段 |
| 收发/轮询 | 重启后日志前三行 + `--status` |
| 配置项 | `config.example.json` 和 README 的表格要同步 |

## 坑清单（都是真踩过的）

| 坑 | 现象 | 对策 |
|---|---|---|
| PowerShell 改源码 | 中文变乱码、语法错误 | 永远用 `patch.mjs` |
| `.ps1` 无 BOM | PS5.1 读成 ANSI，中文乱、字符串未终止 | 存 UTF-8 **带 BOM** |
| `.cmd` 写中文注释 | cmd 窗口显示乱码 | 注释用英文 |
| 手动起第二个实例 | 两个进程抢同一信箱、重复回信 | 只通过 `run-mailbot.vbs` 或计划任务起 |
| `--status` 报“已有实例” | 单实例锁在生效，不是 bug | 先停服务再跑命令 |
| repo-sync 报 MISS | 它按固定原文匹配，改了锚点就失配 | 更新 `E:\1\repo-sync.mjs` 里的 from 串 |
| 仓库推不上去 | 这台机器连不上 github.com:443 | 走 GitHub API + 用户给 token |
| 火绒弹窗 | 脚本执行被问 | 让用户把 `E:\1\qq-stack\mailbot` 加信任区 |
| 日志读成乱码 | 文件是 UTF-8，不是 ANSI | `Get-Content -Encoding UTF8` |

## 省 token 的账

| 做法 | 代价 |
|---|---|
| 整读 mailbot.mjs | ≈ 20,000 token |
| 读 MAP.md 定位 + 局部读 40 行 | ≈ 2,500 + 500 token |
| 用 patch 脚本代替「读全文件→整文件重写」 | 省掉一次 15k+ 的输出 |

## 什么时候先停下来问人

- 要动**收信/发信主流程**（`tick`、`flushOutbox`）——影响面大，先说明再改
- 要动**人设/规则的数量级**（比如一次加十条 rules）——她会明显变样
- 要**删数据**（`--purge`、`--memory-clear`）——必须用户明确点头
- 要**花钱**的改动（换模型、加调用）——先说一年多少钱
