[CmdletBinding()]
param([switch]$RemoveUserData, [string]$TestRoot = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Without-OwnedBlock([string]$text) {
  if ($text -notmatch '(?m)^# BEGIN dsh-conversation-archive \(managed by installer\)$') { return $text }
  $clean = [regex]::Replace($text, '(?ms)\r?\n?\# BEGIN dsh-conversation-archive \(managed by installer\)\r?\n.*?\# END dsh-conversation-archive \(managed by installer\)\r?\n?', "`r`n").TrimEnd()
  if (-not $clean.Trim()) { return "[]`r`n" }
  return $clean + "`r`n"
}

function Move-Recoverable([string]$target, [string]$testRoot) {
  if (-not (Test-Path -LiteralPath $target)) { return }
  if ($testRoot) {
    $recycle = Join-Path $testRoot 'recycled'
    New-Item -ItemType Directory -Path $recycle -Force | Out-Null
    Move-Item -LiteralPath $target -Destination (Join-Path $recycle ((Split-Path $target -Leaf) + '-' + [guid]::NewGuid().ToString('N'))) -Force
    return
  }
  Add-Type -AssemblyName Microsoft.VisualBasic
  if (Test-Path -LiteralPath $target -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin') }
}

function Test-NoReparse([string]$target) {
  $current = [IO.Path]::GetFullPath($target)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    }
    $parent = Split-Path $current -Parent
    if (-not $parent -or $parent -eq $current) { return $true }
    $current = $parent
  }
}

function Test-PhysicalChild([string]$target, [string]$parent) {
  $child = [IO.Path]::GetFullPath($target).TrimEnd('\')
  $root = [IO.Path]::GetFullPath($parent).TrimEnd('\')
  if (-not $child.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { return $false }
  return (Test-NoReparse $child) -and (Test-NoReparse $root)
}

function Test-StateOwnership([string]$stateRoot) {
  foreach ($name in @('state.json','status.json','retained.json','backups.json')) {
    $file = Join-Path $stateRoot $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    try { if ((Get-Content -Raw -LiteralPath $file | ConvertFrom-Json).schemaVersion -eq 1) { return $true } } catch { }
  }
  return $false
}

function Test-RetainedOwnership([string]$target) {
  if (-not (Test-Path -LiteralPath $target -PathType Container) -or -not (Test-NoReparse $target)) { return $false }
  $marker = Join-Path $target '.dsh-conversation-archive-owned.json'
  try {
    $value = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
    return $value.schemaVersion -eq 1 -and $value.owner -eq 'dsh-conversation-archive' -and $value.kind -eq 'retained-library'
  } catch { return $false }
}

$dshHome = if ($TestRoot) { Join-Path ([IO.Path]::GetFullPath($TestRoot)) 'dsh-home' } elseif ($env:DSH_HOME) { [IO.Path]::GetFullPath($env:DSH_HOME) } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
$profile = Join-Path $dshHome 'profiles\web'
$patch = Join-Path $profile 'cordis.patch.yml'
$packageRoot = Join-Path $profile 'node_modules\dsh-conversation-archive'
$backupRoot = Join-Path $dshHome (Join-Path 'plugin-backups\dsh-conversation-archive' ('uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
if (Test-Path -LiteralPath $patch) {
  $patchText = Get-Content -Raw -LiteralPath $patch
  if ($patchText -match '(?m)^# BEGIN dsh-conversation-archive \(managed by installer\)$') {
    Copy-Item -LiteralPath $patch -Destination (Join-Path $backupRoot 'cordis.patch.yml') -Force
    Without-OwnedBlock $patchText | Set-Content -LiteralPath $patch -Encoding utf8
  }
}
if (Test-Path -LiteralPath $packageRoot) { Move-Item -LiteralPath $packageRoot -Destination (Join-Path $backupRoot 'package') -Force }

if ($RemoveUserData) {
  $stateRoot = Join-Path $dshHome 'storages\conversation-archive'
  $targets = [Collections.Generic.List[string]]::new()
  $stateOwned = Test-StateOwnership $stateRoot
  $configPath = Join-Path $stateRoot 'config.json'
  if ($stateOwned -and (Test-Path -LiteralPath $configPath)) {
    try {
      $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
      if ($config.harnessRoot -and [IO.Path]::IsPathRooted([string]$config.harnessRoot)) {
        $retainedTarget = Join-Path ([string]$config.harnessRoot) '重要文件保护'
        if ((Test-PhysicalChild $retainedTarget ([string]$config.harnessRoot)) -and (Test-RetainedOwnership $retainedTarget)) { $targets.Add($retainedTarget) } else { Write-Warning "跳过无插件所有权证据的保留库: $retainedTarget" }
      }
      if ($config.backup -and $config.backup.targetDir -and [IO.Path]::IsPathRooted([string]$config.backup.targetDir)) {
        $catalog = Join-Path $stateRoot 'backups.json'
        if (Test-Path -LiteralPath $catalog) {
          $backups = (Get-Content -Raw -LiteralPath $catalog | ConvertFrom-Json).backups
          foreach ($record in @($backups)) {
            if ([string]$record.fileName -match '^conversation-archive-backup-[A-Za-z0-9-]+\.zip$') {
              $backupTarget = Join-Path ([string]$config.backup.targetDir) ([string]$record.fileName)
              if ((Split-Path ([IO.Path]::GetFullPath($backupTarget)) -Parent) -eq [IO.Path]::GetFullPath([string]$config.backup.targetDir) -and (Test-PhysicalChild $backupTarget ([string]$config.backup.targetDir))) { $targets.Add($backupTarget) }
              else { Write-Warning "跳过不安全的备份路径: $backupTarget" }
            }
          }
        }
      }
    } catch { Write-Warning '无法安全解析用户数据清单；仅回收插件状态目录。' }
  }
  if ($stateOwned -and (Test-PhysicalChild $stateRoot $dshHome)) { $targets.Add($stateRoot) } else { Write-Warning '跳过无插件所有权证据的状态目录。' }
  Write-Output 'The following plugin-owned user data will be moved to the Windows Recycle Bin:'
  $targets | Select-Object -Unique | ForEach-Object { Write-Output "  $_" }
  foreach ($target in ($targets | Select-Object -Unique)) { if (Test-NoReparse $target) { Move-Recoverable $target $TestRoot } else { Write-Warning "跳过重解析点路径: $target" } }
} else {
  Write-Output "User state, retained files, and backups were preserved under $dshHome and configured workspace paths."
}
Write-Output "Uninstalled dsh-conversation-archive. Recoverable code/profile backup: $backupRoot"
