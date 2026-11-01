---
name: sanitize-and-publish
description: "把本地项目脱敏后发到 GitHub：扫邮箱/key/token/本机路径/手机号，改掉隐私，用 Contents API 推文件（没 git、连不上 github.com 也行），推完复扫与撤销 token。触发词：开源、公开仓库、脱敏、推到 GitHub、去掉个人信息、发布项目。"
user-invocable: true
---

> 作者和 d 老师的一点思想火花。

> 文中的 E:\1\... 是路径示例，换成你自己项目的目录即可。

# sanitize-and-publish（脱敏发布）

前提常常是：**这台机器没有 git，也连不上 github.com:443**。所以走 GitHub Contents API，用用户给的 token。

## 第 1 步：扫描

```powershell
node %USERPROFILE%\.dsh\skills\sanitize-and-publish\scripts\scan.mjs E:\1\你的项目
```

查：模型 key、GitHub token、云 key、疑似密码、邮箱、本机绝对路径、内网地址、手机号、身份证。

退出码 1 = 有命中。**逐条看，分成三类**：

| 类 | 例子 | 处理 |
|---|---|---|
| 真凭据 | `sk-...`、`ghp_...`、`authCode=...` | 必须删/换占位符，不能只改注释 |
| 个人信息 | 邮箱、手机号、QQ 号、用户名 | 删或换 `you@example.com` |
| 本机路径 | `E:\1\...`、`C:\Users\姓名\...` | 能改相对路径就改；改不了就在 README 注明“路径按本机布局” |

## 第 2 步：脱敏

常见手法，按有效性排序：

1. **挪出仓库**：凭据/状态/记忆文件放仓库外，`.gitignore` 挡住（`config.json`、`*.dat`、`state.json`、`memory*.jsonl`）
2. **改成配置**：硬编码路径 → `path.dirname(import.meta.url)`；硬编码邮箱 → `config.email`
3. **双向同步脚本**：写一个 `repo-sync.mjs`，把生产代码按固定替换表生成仓库副本；替换失配（MISS）就报错不写文件
4. **改完再扫一遍**，必须 `命中 0 处`

同步脚本的坑：**锚点会随源码变化失效**。改源码时如果动了被替换的那几行，`repo-sync` 会报 MISS —— 顺手更新它的 from 串，别让副本悄悄变旧。

## 第 3 步：推送（无 git）

```powershell
$env:GITHUB_TOKEN = "ghp_用户给你的"
node %USERPROFILE%\.dsh\skills\sanitize-and-publish\scripts\push.mjs `
  --repo 用户名/仓库名 --dir E:\1\你的项目 --files README.md,src/a.mjs --message "初次上传"
```

- 已存在的文件会自动取 `sha` 更新，新文件直接创建
- 二进制、大文件不建议走这条（API 单文件上限 100 MB）
- 一次推多个文件用逗号分隔

## 第 4 步：复验

1. **远端再扫一遍**：用 API 拉回文件内容，跑同样的规则（别只信本地）
2. 打开仓库页面看 README 渲染、文件数
3. 检查有没有误传：`state.json`、`*.dat`、`node_modules`、日志

## 第 5 步：收尾（重要）

**提醒用户立刻撤销 token**：`https://github.com/settings/tokens` → Delete。

token 一旦贴进对话就已经算泄露，推完就该删。如果他没删，下次再提一句。

## 今天这个项目的实际做法（可照抄）

| 步骤 | 做法 |
|---|---|
| 副本 | `E:\1\mail-penpal`（生产在 `E:\1\qq-stack\mailbot`）|
| 同步 | `node E:\1\repo-sync.mjs`：替换路径/邮箱/key/用户名，MISS 就不写文件 |
| 扫描 | `scan.mjs` + 一次“远端文件逐个拉回再扫” |
| 推送 | `push.mjs`，一次推一批 |
| 教训 | 有两次差点把 `E:\1` 路径和示例邮箱写进仓库，都是扫描抓出来的 |

## 别做的事

- 别把 token 写进脚本或命令行参数（会进 PowerShell 历史），用环境变量
- 别对“看起来没问题的私有仓库”掉以轻心——公开前一秒才扫，往往来不及
- 别用 `git filter-branch` 补救：这台机器没有 git，而且历史里的东西删不干净，重开仓库更实在
