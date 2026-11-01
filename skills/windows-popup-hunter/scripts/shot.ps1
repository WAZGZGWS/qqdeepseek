# 按标题截取一个窗口（弹窗内容看不清时用；截完用图片查看器/模型看）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File shot.ps1 -Title "关键字" -Out "%TEMP%\popup.png"
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Out = "$env:TEMP\window-shot.png"
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Title)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

if (-not $win) {
  # 找不到精确标题就按包含匹配
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    if ($e.Current.Name -like "*$Title*") { $win = $e; break }
  }
}

if (-not $win) { Write-Host "没找到标题包含 '$Title' 的窗口" -ForegroundColor Red; exit 1 }

Write-Host ("窗口：" + $win.Current.Name)
Write-Host ("类型：" + $win.Current.ControlType.ProgrammaticName)

# 控件树（原生控件才有用；Electron 页面通常只有标题栏按钮）
$desc = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$i = 0
foreach ($e in $desc) {
  if ($i -ge 30) { break }
  $n = $e.Current.Name
  if ($n) { Write-Host ("  [" + $e.Current.ControlType.ProgrammaticName + "] " + $n); $i++ }
}

$r = $win.Current.BoundingRectangle
if ($r.Width -le 0 -or $r.Height -le 0) { Write-Host "窗口没有可截取区域" -ForegroundColor Red; exit 1 }
$bmp = New-Object System.Drawing.Bitmap([int]$r.Width, [int]$r.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("已截图：" + $Out) -ForegroundColor Green
Write-Host ("位置 " + $r.X + "," + $r.Y + " 大小 " + $r.Width + "x" + $r.Height)
exit 0
