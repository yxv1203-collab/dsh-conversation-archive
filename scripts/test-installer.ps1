$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('dca 安装测试 ' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $fixture 'bin'
$dshHome = Join-Path $fixture 'dsh-home'
$profile = Join-Path $dshHome 'profiles\web'
$state = Join-Path $dshHome 'storages\conversation-archive'
$oldPath = $env:PATH
try {
  New-Item -ItemType Directory -Path $bin,$state,(Join-Path $bin 'node_modules\@deepseek-ai\dsh') -Force | Out-Null
  '{"name":"@deepseek-ai/dsh","version":"0.1.1-rc.2"}' | Set-Content -LiteralPath (Join-Path $bin 'node_modules\@deepseek-ai\dsh\package.json') -Encoding utf8
  @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
if ($Rest -contains '--version') { Write-Output '0.1.1-rc.2'; exit 0 }
$profile = Join-Path $env:DSH_HOME 'profiles\web'
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$patch = Join-Path $profile 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patch)) { '[]' | Set-Content -LiteralPath $patch -Encoding utf8 }
if ($env:DSH_FAKE_FAIL -eq '1') { Write-Error 'injected loader failure'; exit 17 }
$text = Get-Content -Raw -LiteralPath $patch
if ($text -match 'id: dsh-conversation-archive') { Write-Output "- id: dsh-conversation-archive`n  name: dsh-conversation-archive" } else { Write-Output '[]' }
exit 0
'@ | Set-Content -LiteralPath (Join-Path $bin 'dsh.ps1') -Encoding utf8
  $env:PATH = "$bin$([IO.Path]::PathSeparator)$oldPath"
  [ordered]@{ schemaVersion = 1; sentinel = $true } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $state 'state.json') -Encoding utf8

  $dry = & (Join-Path $PSScriptRoot 'install.ps1') -SourceRoot $root -TestRoot $fixture -DryRun | Out-String
  if ($dry -notmatch 'Target:' -or (Test-Path -LiteralPath $profile)) { throw 'dry-run-wrote-or-omitted-plan' }
  $fake = Get-Content -Raw -LiteralPath (Join-Path $bin 'dsh.ps1')
  $fake.Replace("Write-Output '0.1.1-rc.2'", "Write-Output '9.9.9'") | Set-Content -LiteralPath (Join-Path $bin 'dsh.ps1') -Encoding utf8
  try { & (Join-Path $PSScriptRoot 'install.ps1') -SourceRoot $root -TestRoot $fixture -DryRun | Out-Null; throw 'dry-run-accepted-unsupported-dsh' } catch { if ($_.Exception.Message -eq 'dry-run-accepted-unsupported-dsh') { throw } }
  $fake | Set-Content -LiteralPath (Join-Path $bin 'dsh.ps1') -Encoding utf8
  & (Join-Path $PSScriptRoot 'install.ps1') -SourceRoot $root -TestRoot $fixture | Out-Null
  $package = Join-Path $profile 'node_modules\dsh-conversation-archive\package.json'
  $patch = Join-Path $profile 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $package) -or ([regex]::Matches((Get-Content -Raw $patch), '# BEGIN dsh-conversation-archive')).Count -ne 1) { throw 'install-failed' }
  $bytes = [IO.File]::ReadAllBytes($package)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { throw 'installed-package-json-has-bom' }
  & (Join-Path $PSScriptRoot 'install.ps1') -SourceRoot $root -TestRoot $fixture | Out-Null
  if (([regex]::Matches((Get-Content -Raw $patch), '# BEGIN dsh-conversation-archive')).Count -ne 1) { throw 'install-not-idempotent' }

  $sentinel = Join-Path (Split-Path $package -Parent) 'rollback-sentinel.txt'
  'before' | Set-Content -LiteralPath $sentinel
  $patchBefore = Get-Content -Raw $patch
  $env:DSH_FAKE_FAIL = '1'
  try { & (Join-Path $PSScriptRoot 'install.ps1') -SourceRoot $root -TestRoot $fixture | Out-Null; throw 'rollback-test-did-not-fail' } catch { if ($_.Exception.Message -eq 'rollback-test-did-not-fail') { throw } }
  $env:DSH_FAKE_FAIL = ''
  if (-not (Test-Path $sentinel) -or (Get-Content -Raw $patch) -ne $patchBefore) { throw 'rollback-did-not-restore' }

  & (Join-Path $PSScriptRoot 'uninstall.ps1') -TestRoot $fixture | Out-Null
  if (Test-Path $package) { throw 'uninstall-left-code' }
  if ((Get-Content -Raw $patch) -match 'dsh-conversation-archive') { throw 'uninstall-left-patch' }
  if (-not (Test-Path (Join-Path $state 'state.json'))) { throw 'uninstall-removed-user-state' }
  $patchAfterUninstall = Get-Content -Raw -LiteralPath $patch
  & (Join-Path $PSScriptRoot 'uninstall.ps1') -TestRoot $fixture | Out-Null
  if ((Get-Content -Raw -LiteralPath $patch) -ne $patchAfterUninstall) { throw 'repeated-uninstall-mutated-unowned-patch' }

  & (Join-Path $PSScriptRoot 'install.ps1') -SourceRoot $root -TestRoot $fixture | Out-Null
  $unownedHarness = Join-Path $fixture 'Unowned Harness'
  $unownedRetained = Join-Path $unownedHarness '重要文件保护'
  New-Item -ItemType Directory -Path $unownedRetained -Force | Out-Null
  'must survive' | Set-Content -LiteralPath (Join-Path $unownedRetained 'user-file.txt')
  [ordered]@{ schemaVersion = 1; harnessRoot = $unownedHarness; protectDirName = '重要文件保护'; backup = @{ targetDir = '' } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $state 'config.json') -Encoding utf8
  & (Join-Path $PSScriptRoot 'uninstall.ps1') -TestRoot $fixture -RemoveUserData | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $unownedRetained 'user-file.txt'))) { throw 'config-only-path-was-treated-as-owned' }

  & (Join-Path $PSScriptRoot 'install.ps1') -SourceRoot $root -TestRoot $fixture | Out-Null
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  '{"schemaVersion":1,"sentinel":true}' | Set-Content -LiteralPath (Join-Path $state 'state.json') -Encoding utf8
  $harness = Join-Path $fixture 'Harness 工作区'
  $retained = Join-Path $harness '重要文件保护'
  New-Item -ItemType Directory -Path $retained -Force | Out-Null
  [ordered]@{ schemaVersion = 1; owner = 'dsh-conversation-archive'; kind = 'retained-library' } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $retained '.dsh-conversation-archive-owned.json') -Encoding utf8
  [ordered]@{ schemaVersion = 1; harnessRoot = $harness; protectDirName = '重要文件保护'; backup = @{ targetDir = '' } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $state 'config.json') -Encoding utf8
  & (Join-Path $PSScriptRoot 'uninstall.ps1') -TestRoot $fixture -RemoveUserData | Out-Null
  if ((Test-Path $state) -or (Test-Path $retained) -or -not (Test-Path (Join-Path $fixture 'recycled'))) { throw 'remove-user-data-failed' }
  Write-Output 'installer tests passed'
} finally {
  $env:DSH_FAKE_FAIL = ''
  if ($oldPath) { $env:PATH = $oldPath }
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
