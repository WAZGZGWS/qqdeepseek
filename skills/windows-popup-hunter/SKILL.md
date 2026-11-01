---
name: windows-popup-hunter
description: "排查 Windows 上莫名其妙的弹窗、打断、闪窗、后台崩溃：列出窗口/截图读内容、查事件日志与崩溃计数、翻计划任务与自启动项、定位进程并处置。含编码与引号坑（PS5.1 BOM、中文乱码、字符串拼接翻车）。触发词：又弹窗了、老打断我、闪窗、这是什么东西、查一下这个弹窗、电脑老弹东西。"
user-invocable: true
---

> 作者和 d 老师的一点思想火花。

> 文中的 <工作区>\... 是路径示例，换成你自己项目的目录即可。

# windows-popup-hunter（弹窗猎手）

用户说“老弹东西烦死了”时用这个。**先定位到具体是谁，再动手**，别猜。

## 第 0 步：问一句，或者直接看

如果弹窗还在屏幕上，最快的路是**标题**。看当前所有窗口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\.dsh\skills\windows-popup-hunter\scripts\windows.ps1
```

看输出里有没有可疑的标题（今天抓到的：`EmOSDFunction`、`打开文件 - 安全警告`、桌宠气泡、`explorer → Window Dialog`）。

## 第 1 步：看清内容

原生对话框（Win32）能用 UIA 读控件；Electron/网页窗口只有标题栏按钮，**必须截图看**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ...\scripts\shot.ps1 -Title "无法验证发布者" -Out %TEMP%\popup.png
```

截完用 `read_image` 看。**今天就是靠这一步翻案的**——原以为是应用弹窗，截图发现那串字其实只是会话标题。

## 第 2 步：查是不是崩溃在刷屏

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ...\scripts\recent-errors.ps1 -Minutes 60
```

会按来源聚合，并列出 `Faulting application name` 的崩溃次数。今天抓到 `EmOSDFunction.exe` **623 次/小时**——每崩一次 Windows 弹一次错误报告。

崩溃处置：停服务 + 禁用 + 取消故障重启：

```powershell
sc.exe config <服务名> start= disabled
sc.exe stop <服务名>
cmd /c 'sc failure <服务名> reset= 0 actions= ""'   # 注意：PowerShell 会吞空字符串，得套 cmd /c
```

## 第 3 步：查自启动来源

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ...\scripts\autoruns.ps1
```

看三处：**Highest 权限的计划任务**（会弹 UAC）、**动作指向非系统路径的任务**、**注册表 Run**。

今天两个典型：

- `QQStackDoctor` 每 2 分钟跑一次、最高权限 → 每两分钟一个 UAC 框
- `HKCU\...\Run :: QQKeepAwake` 启动一个 VBS，顺手把旧脚本带起来 → “无法验证发布者”

## 第 4 步：处置与复验

| 情况 | 处置 |
|---|---|
| 计划任务（自己的） | `schtasks /Delete /TN "名字" /F`；权限不够就说明要管理员 |
| 注册表 Run | `Remove-ItemProperty -Path 'Registry::HKEY_CURRENT_USER\...\Run' -Name '名字'` |
| 服务崩溃 | 停用 + 禁用 + 取消重启（见上）|
| 文件被反复调用 | **删掉那个文件**——比找调用者快，删除后谁调都是“文件不存在” |
| 安全软件弹窗 | 加信任区（火绒：`主界面 → 三条杠 → 信任区`）|

处置后**必须复验**：再跑一次第 1、2 步，确认窗口没了、崩溃计数归零。

## 编码与引号坑（这一节的每条都踩过）

| 坑 | 现象 | 对策 |
|---|---|---|
| `.ps1` 存成无 BOM 的 UTF-8 | PS5.1 按 ANSI 读，中文乱码 + `字符串缺少终止符` | 存 **UTF-8 with BOM**；改完检查 BOM |
| 用 PowerShell 拼 JS/HTML 带引号 | `$`、反引号、`"` 连环炸，报 `Unexpected token` | **别拼**：写成 `.mjs` 文件再 `node` 跑 |
| `.cmd`/`.bat` 里写中文注释 | cmd 窗口显示乱码 | 注释用英文 |
| `Get-Content` 读 UTF-8 日志 | 中文乱码，`Select-String` 匹配不到 | 加 `-Encoding UTF8` |
| `sc failure ... actions= ""` | 报“无效选项” | `cmd /c 'sc failure ... reset= 0 actions= ""'` |
| `Get-ScheduledTask` 删除/改最高权限任务 | `Access is denied` | 需要管理员；让用户开一次管理员终端 |

## 输出格式

查完给用户三段话就够：

1. **是谁**（进程名 / 任务名 / 服务名 + 证据：窗口标题、崩溃次数、注册表项）
2. **为什么**（每 2 分钟的最高权限任务 / 服务崩了 623 次 / 旧脚本被 Run 项拉起）
3. **怎么办**（已经做了什么 + 让他做的那一两步 + 怎么复验）

别把排查过程倒给用户，他要的是“没了”。
