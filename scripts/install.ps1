<#
  dsh-user-style 一键安装（install.bat 调用的实际逻辑）

  做三件事：
    1. 优先用官方 `dsh plugin` CLI 安装（它会顺带同步 pnpm 锁文件）；
       找不到 CLI 时退回手动方式：在 profile 的 node_modules 里建 junction。
    2. 把 dsh-user-style 写进 profile 的 package.json（依赖 + bundle 选择），
       写之前备份成 package.json.bak-dsh-user-style。
    3. 打印重启提示——宿主侧改动不热更新，必须重启应用才会加载。

  踩过的坑（改这个脚本前先读）：
    · PowerShell 变量名不区分大小写：$ManifestPath（路径）与 $manifest（对象）
      必须用不同的名字，否则后者会覆盖前者，备份名会变成对象的字符串形式。
    · 方法调用的参数里不能直接写管道表达式：
      [IO.File]::WriteAllText($p, ($o | ConvertTo-Json), $enc) 会报
      「Cannot find an overload ... argument count: 3」，必须先赋值给变量。
    · 本文件必须保存为 **UTF-8 带 BOM**：Windows PowerShell 5.1 读无 BOM 的 .ps1
      会按系统 ANSI 解码，中文全变乱码乃至语法错误。
    · 删除已存在的链接用 [System.IO.Directory]::Delete，绝不用 Remove-Item -Recurse：
      后者会顺着 junction 删掉它指向的真实目录。
#>
param(
  # 手动指定 dsh CLI 路径（自动探测失败时用）
  [string]$DshCli = '',
  # 跳过官方 CLI，直接用 junction + 清单写入（探测误报、或不想跑 pnpm 时用）
  [switch]$Manual
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red }

# junction 的 Target 在 PS 5.1 里可能带 Global\ 或 \\?\ 前缀，比较前统一剥掉。
function Normalize-Target([string]$value) {
  if (-not $value) { return '' }
  $v = $value
  foreach ($prefix in @('Global\', '\\?\', '\??\')) {
    if ($v.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { $v = $v.Substring($prefix.Length) }
  }
  return $v.TrimEnd('\')
}

$PACKAGE_NAME = 'dsh-user-style'
$PROFILE_NAME = 'desktop'
$UTF8 = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------- 1. 定位仓库根
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) { $RepoRoot = $PSScriptRoot }
if (-not (Test-Path (Join-Path $RepoRoot 'lib\index.js'))) {
  Fail "找不到插件文件：$RepoRoot\lib\index.js"
  Info '请保留整个仓库目录，不要只复制 install.bat。'
  exit 1
}
Info "插件目录：$RepoRoot"

# ------------------------------------------------------- 2. 定位 DSH 主目录与 profile
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$PROFILE_NAME"
$ManifestPath = Join-Path $ProfileDir 'package.json'
Info "DSH 主目录：$DshHome"
if (-not (Test-Path $ManifestPath)) {
  Fail "找不到 profile 清单：$ManifestPath"
  Info '请先启动一次 DeepSeek Harness 桌面端（它会初始化 profile），完全退出后再运行本脚本。'
  exit 1
}

# ------------------------------------------------------------------ 3. 探测 dsh CLI
function Find-DshCli {
  $found = New-Object System.Collections.Generic.List[string]
  if ($DshCli -and (Test-Path $DshCli)) { $found.Add($DshCli) }
  if ($env:DSH_CLI -and (Test-Path $env:DSH_CLI)) { $found.Add($env:DSH_CLI) }
  $cmd = Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $found.Add($cmd.Source) }
  # 典型安装位置：<安装目录>\resources\runtime\cli\bin\dsh.cmd
  $bases = @(
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  )
  foreach ($base in $bases) {
    if (-not $base -or -not (Test-Path $base)) { continue }
    foreach ($dir in (Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
      $candidate = Join-Path $dir.FullName 'resources\runtime\cli\bin\dsh.cmd'
      if (Test-Path $candidate) { $found.Add($candidate); continue }
      foreach ($sub in (Get-ChildItem -LiteralPath $dir.FullName -Directory -ErrorAction SilentlyContinue)) {
        $nested = Join-Path $sub.FullName 'resources\runtime\cli\bin\dsh.cmd'
        if (Test-Path $nested) { $found.Add($nested) }
      }
    }
  }
  foreach ($entry in $found) { if ($entry -and (Test-Path $entry)) { return $entry } }
  return ''
}

$cli = ''
if ($Manual) {
  Warn '按 -Manual 指定：跳过官方 CLI，直接用手动方式'
} else {
  $cli = Find-DshCli
}
if ($cli) {
  Info "找到 dsh CLI：$cli"
  try {
    & $cli plugin --profile $PROFILE_NAME add -w "link:$RepoRoot"
    if ($LASTEXITCODE -eq 0) {
      Ok '已通过官方 CLI 安装（pnpm 依赖与锁文件同步完成）'
    } else {
      Warn "官方 CLI 返回退出码 $LASTEXITCODE，改用手动方式继续"
    }
  } catch {
    Warn "官方 CLI 调用失败：$($_.Exception.Message)；改用手动方式继续"
  }
} elseif (-not $Manual) {
  Warn '没有找到 dsh CLI，使用手动方式（junction + 清单写入）'
}

# ------------------------------------------------------------ 4. 建立 node_modules 链接
$NodeModules = Join-Path $ProfileDir 'node_modules'
if (-not (Test-Path $NodeModules)) { New-Item -ItemType Directory -Force -Path $NodeModules | Out-Null }
$LinkPath = Join-Path $NodeModules $PACKAGE_NAME
$targetFull = (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd('\')

if (Test-Path $LinkPath) {
  $item = Get-Item -LiteralPath $LinkPath -Force
  $existingTarget = ''
  if ($item.Target) { $existingTarget = (@($item.Target)[0]) }
  if ((Normalize-Target $existingTarget) -ieq (Normalize-Target $targetFull)) {
    Ok "链接已存在且指向正确：$LinkPath"
  } else {
    Warn "已存在的链接指向别处（$existingTarget），将重建"
    [System.IO.Directory]::Delete($LinkPath, $false)
  }
}
if (-not (Test-Path $LinkPath)) {
  New-Item -ItemType Junction -Path $LinkPath -Target $targetFull | Out-Null
  Ok "已建立链接：$LinkPath  ->  $targetFull"
}

# ---------------------------------------------------------------- 5. 写入 profile 清单
$raw = [System.IO.File]::ReadAllText($ManifestPath, $UTF8)
$manifest = $raw | ConvertFrom-Json
$linkSpec = 'link:' + ($RepoRoot -replace '\\', '/')

if ($null -eq $manifest.dependencies) {
  $manifest | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue (New-Object psobject) -Force
}
$manifest.dependencies | Add-Member -NotePropertyName $PACKAGE_NAME -NotePropertyValue $linkSpec -Force

if ($null -eq $manifest.dsh) {
  $manifest | Add-Member -NotePropertyName 'dsh' -NotePropertyValue (New-Object psobject) -Force
}
if ($null -eq $manifest.dsh.profile) {
  $manifest.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue (New-Object psobject) -Force
}
$bundles = @()
if ($manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
$alreadySelected = $bundles -contains $PACKAGE_NAME
if (-not $alreadySelected) { $bundles += $PACKAGE_NAME }
$manifest.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue ([string[]]$bundles) -Force

$backupPath = "$ManifestPath.bak-$PACKAGE_NAME"
if (-not (Test-Path $backupPath)) {
  [System.IO.File]::WriteAllText($backupPath, $raw, $UTF8)
  Info "已备份原清单：$backupPath"
}
$serialized = $manifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($ManifestPath, $serialized, $UTF8)
if ($alreadySelected) { Ok 'bundle 选择已存在，无需改动' } else { Ok "已把 $PACKAGE_NAME 追加进 dsh.profile.bundles" }

# -------------------------------------------------------------------- 6. 复核并收尾
$check = [System.IO.File]::ReadAllText($ManifestPath, $UTF8) | ConvertFrom-Json
$okDep = $check.dependencies.PSObject.Properties.Name -contains $PACKAGE_NAME
$okBundle = @($check.dsh.profile.bundles) -contains $PACKAGE_NAME
$okLink = Test-Path $LinkPath
if ($okDep -and $okBundle -and $okLink) {
  Ok '复核通过：依赖、bundle 选择、链接三项齐备'
  Write-Host ''
  Info '安装完成。接下来：'
  Info '  1) 完全退出 DeepSeek Harness（不是最小化），再重新打开'
  Info '  2) 侧边栏 → 插件，确认 dsh-user-style 的运行状态是「已运行」'
  Info '  3) 工作页面右下角会出现「风格 · 未启用」的小药丸，点开挑一套即可'
  Info ''
  Info '插件默认不注入任何内容——不主动启用，它不会改变你现有对话的行为。'
  Info "档案与开关都在：$DshHome\dsh-user-style\store.json"
  exit 0
} else {
  Fail "复核未通过：依赖=$okDep bundle=$okBundle 链接=$okLink"
  Info '可把上面的输出发到仓库 Issues。'
  exit 1
}
