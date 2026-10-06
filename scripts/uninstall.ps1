<#
  dsh-user-style 卸载（uninstall.bat 调用的实际逻辑）

  做三件事：
    1. 删掉 profile\node_modules\dsh-user-style 这个 junction（只删链接，不动你的仓库）
    2. 从 profile 的 package.json 里移除依赖与 bundle 选择（先备份）
    3. 提示重启

  不会删：你的风格档案（<DSH_HOME>\dsh-user-style\store.json）——那是你的数据。

  与 install.ps1 同源的坑：变量名不区分大小写（用 $ManifestPath 存路径）、
  方法参数里不能写管道表达式、本文件必须是 UTF-8 带 BOM、删链接不能用 Remove-Item -Recurse。
#>
param()

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red }

$PACKAGE_NAME = 'dsh-user-style'
$PROFILE_NAME = 'desktop'
$UTF8 = New-Object System.Text.UTF8Encoding($false)

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$PROFILE_NAME"
$ManifestPath = Join-Path $ProfileDir 'package.json'
Info "DSH 主目录：$DshHome"

if (-not (Test-Path $ManifestPath)) {
  Fail "找不到 profile 清单：$ManifestPath"
  exit 1
}

# ------------------------------------------------------------------ 1. 删除链接
$LinkPath = Join-Path $ProfileDir "node_modules\$PACKAGE_NAME"
if (Test-Path $LinkPath) {
  # 只删链接本身。绝不用 Remove-Item -Recurse：旧版 PowerShell 会顺着 junction 删掉真实目录。
  [System.IO.Directory]::Delete($LinkPath, $false)
  if (Test-Path $LinkPath) { Warn "链接仍然存在，请手动删除：$LinkPath" } else { Ok "已移除链接：$LinkPath" }
} else {
  Info '链接不存在，跳过'
}

# ------------------------------------------------------------ 2. 清理 profile 清单
$raw = [System.IO.File]::ReadAllText($ManifestPath, $UTF8)
$manifest = $raw | ConvertFrom-Json
$changed = $false

if ($manifest.dependencies -and ($manifest.dependencies.PSObject.Properties.Name -contains $PACKAGE_NAME)) {
  $manifest.dependencies.PSObject.Properties.Remove($PACKAGE_NAME)
  $changed = $true
}
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
  $remaining = @(@($manifest.dsh.profile.bundles) | Where-Object { $_ -ne $PACKAGE_NAME })
  $manifest.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue ([string[]]$remaining) -Force
  $changed = $true
}

if ($changed) {
  $backupPath = "$ManifestPath.bak-uninstall-$PACKAGE_NAME"
  try { [System.IO.File]::WriteAllText($backupPath, $raw, $UTF8) } catch { }
  $serialized = $manifest | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($ManifestPath, $serialized, $UTF8)
  Ok '已从 profile 清单移除依赖与 bundle 选择'
} else {
  Info 'profile 清单里没有它的记录，跳过'
}

Write-Host ''
Info '卸载完成。接下来：'
Info '  1) 完全退出 DeepSeek Harness，再重新打开（插件才会真正停止加载）'
Info "  2) 风格档案仍保留在：$DshHome\dsh-user-style\"
Info '     里面 store.json 存的是你的风格设定；确认不再需要就手动删除该目录。'
exit 0
