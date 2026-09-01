[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$SourceRoot = '',
  [string]$TestRoot = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$plugin = 'dsh-conversation-archive'
$SourceRoot = if ($SourceRoot) { $SourceRoot } else { Split-Path $PSScriptRoot -Parent }
$begin = '# BEGIN dsh-conversation-archive (managed by installer)'
$end = '# END dsh-conversation-archive (managed by installer)'

function Resolve-Dsh {
  $command = Get-Command dsh -ErrorAction Stop | Select-Object -First 1
  $source = $command.Source
  if (-not $source) { $source = $command.Path }
  if (-not $source) { throw 'dsh-command-path-unavailable' }
  $package = Join-Path (Split-Path $source -Parent) 'node_modules\@deepseek-ai\dsh\package.json'
  if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw 'dsh-package-not-found' }
  [pscustomobject]@{ Command = $source; Package = $package }
}

function Invoke-Dsh([string]$command, [string[]]$arguments, [string]$targetDshHome) {
  $prior = $env:DSH_HOME
  $priorPreference = $ErrorActionPreference
  try {
    $env:DSH_HOME = $targetDshHome
    $ErrorActionPreference = 'Continue'
    $output = & $command @arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "dsh-command-failed ($exitCode): $output" }
    return $output
  } finally { $ErrorActionPreference = $priorPreference; $env:DSH_HOME = $prior }
}

function Without-OwnedBlock([string]$text) {
  return [regex]::Replace($text, '(?ms)\r?\n?\# BEGIN dsh-conversation-archive \(managed by installer\)\r?\n.*?\# END dsh-conversation-archive \(managed by installer\)\r?\n?', "`r`n").TrimEnd()
}

function Install-Patch([string]$text) {
  $clean = Without-OwnedBlock $text
  if ($clean -match '(?m)^\s*-\s*id:\s*["'']?dsh-conversation-archive["'']?\s*$') { throw 'unmanaged-plugin-entry-conflict' }
  $clean = [regex]::Replace($clean, '(?m)^\s*\[\]\s*$', '').TrimEnd()
  $block = @"
$begin
- insert:
    - id: dsh-conversation-archive
      name: dsh-conversation-archive
$end
"@
  if (-not $clean.Trim()) { return $block.Trim() + "`r`n" }
  return $clean + "`r`n`r`n" + $block.Trim() + "`r`n"
}

function Assert-NoReparse([string]$target, [string]$stop) {
  $current = [IO.Path]::GetFullPath($target)
  $boundary = [IO.Path]::GetFullPath($stop)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "reparse-install-path: $current" }
    }
    if ($current.TrimEnd('\') -eq $boundary.TrimEnd('\')) { return }
    $parent = Split-Path $current -Parent
    if (-not $parent -or $parent -eq $current) { throw 'install-path-outside-profile' }
    $current = $parent
  }
}

$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$manifestPath = Join-Path $source 'release-manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.name -ne $plugin -or $manifest.platform -ne 'win32' -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'invalid-release-manifest' }
foreach ($item in $manifest.files.psobject.Properties) {
  $file = Join-Path $source $item.Name
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$item.Value) { throw "release-hash-mismatch: $($item.Name)" }
}

$dsh = Resolve-Dsh
$dshHome = if ($TestRoot) { Join-Path ([IO.Path]::GetFullPath($TestRoot)) 'dsh-home' } elseif ($env:DSH_HOME) { [IO.Path]::GetFullPath($env:DSH_HOME) } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
$versionText = Invoke-Dsh $dsh.Command @('--version') $dshHome
$dshVersion = ([regex]::Match($versionText, '\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?')).Value
if (-not $dshVersion -or $dshVersion -ne [string]$manifest.dsh.minVersion -or $dshVersion -ne [string]$manifest.dsh.maxTestedVersion) { throw "unsupported-dsh-version: $dshVersion" }
$profile = Join-Path $dshHome 'profiles\web'
$patch = Join-Path $profile 'cordis.patch.yml'
$packageRoot = Join-Path $profile 'node_modules\dsh-conversation-archive'
$versionRoot = Join-Path $packageRoot (Join-Path 'versions' $manifest.version)
$backupRoot = Join-Path $dshHome (Join-Path 'plugin-backups\dsh-conversation-archive' ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N')))
Assert-NoReparse $packageRoot $profile
Assert-NoReparse $versionRoot $profile

Write-Output "DSH command: $($dsh.Command)"
Write-Output "DSH package: $($dsh.Package)"
Write-Output "Source: $source"
Write-Output "Target: $versionRoot"
Write-Output "Profile patch: $patch"
Write-Output "Rollback backup: $backupRoot"
Write-Output "Health: node --check <host/client>; dsh --profile web --dump-config"
if ($DryRun) { return }

$hadPackage = Test-Path -LiteralPath $packageRoot
$hadPatch = Test-Path -LiteralPath $patch
try {
  if (-not (Test-Path -LiteralPath $profile)) { [void](Invoke-Dsh $dsh.Command @('--profile', 'web', '--dump-default-config') $dshHome) }
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  if ($hadPackage) { Copy-Item -LiteralPath $packageRoot -Destination (Join-Path $backupRoot 'package') -Recurse -Force }
  if ($hadPatch) { Copy-Item -LiteralPath $patch -Destination (Join-Path $backupRoot 'cordis.patch.yml') -Force }

  New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
  foreach ($part in @('host', 'client')) {
    $destination = Join-Path $versionRoot $part
    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $source "$part\lib") -Destination $destination -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $source "$part\package.json") -Destination $destination -Force
    if (Test-Path -LiteralPath (Join-Path $source "$part\README.md")) { Copy-Item -LiteralPath (Join-Path $source "$part\README.md") -Destination $destination -Force }
  }
  Copy-Item -LiteralPath $manifestPath -Destination $versionRoot -Force
  if (Test-Path -LiteralPath (Join-Path $source 'README.md')) { Copy-Item -LiteralPath (Join-Path $source 'README.md') -Destination $versionRoot -Force }

  $wrapper = [ordered]@{
    name = $plugin; version = [string]$manifest.version; private = $true; type = 'module'
    main = "./versions/$($manifest.version)/host/lib/index.js"
    exports = [ordered]@{ '.' = "./versions/$($manifest.version)/host/lib/index.js"; './client' = "./versions/$($manifest.version)/client/lib/client.js"; './package.json' = './package.json' }
    dsh = [ordered]@{ client = [ordered]@{ platform = 'web' } }
  }
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $packageRoot 'package.json'), (($wrapper | ConvertTo-Json -Depth 8) + "`n"), $utf8)
  $currentPatch = if (Test-Path -LiteralPath $patch) { Get-Content -Raw -LiteralPath $patch } else { '[]' }
  Install-Patch $currentPatch | Set-Content -LiteralPath $patch -Encoding utf8

  & node --check (Join-Path $versionRoot 'host\lib\index.js')
  if ($LASTEXITCODE -ne 0) { throw 'host-syntax-check-failed' }
  & node --check (Join-Path $versionRoot 'client\lib\client.js')
  if ($LASTEXITCODE -ne 0) { throw 'client-syntax-check-failed' }
  $dump = Invoke-Dsh $dsh.Command @('--profile', 'web', '--dump-config') $dshHome
  if ($dump -notmatch '(?m)^- id: dsh-conversation-archive\s*$' -or $dump -notmatch "(?m)^\s*name: dsh-conversation-archive\s*$") { throw 'dsh-loader-health-check-failed' }
  Write-Output "Installed $plugin $($manifest.version). Restart DSH to activate it."
} catch {
  if (Test-Path -LiteralPath $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
  if ($hadPackage -and (Test-Path -LiteralPath (Join-Path $backupRoot 'package'))) { Copy-Item -LiteralPath (Join-Path $backupRoot 'package') -Destination $packageRoot -Recurse -Force }
  if ($hadPatch -and (Test-Path -LiteralPath (Join-Path $backupRoot 'cordis.patch.yml'))) { Copy-Item -LiteralPath (Join-Path $backupRoot 'cordis.patch.yml') -Destination $patch -Force }
  elseif (Test-Path -LiteralPath $patch) { Remove-Item -LiteralPath $patch -Force }
  throw
}
