$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'build-release.ps1') -SourceRoot $root | Out-Null
$manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'release-manifest.json') | ConvertFrom-Json
$zip = Join-Path $root "dist\dsh-conversation-archive-$($manifest.version)-windows.zip"
$first = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
& (Join-Path $PSScriptRoot 'build-release.ps1') -SourceRoot $root | Out-Null
$second = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
if ($first -ne $second) { throw 'release-zip-is-not-deterministic' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try { $entries = @($archive.Entries | ForEach-Object { $_.FullName }) } finally { $archive.Dispose() }
$expected = @('release-manifest.json') + @($manifest.files.psobject.Properties.Name | Sort-Object)
if ((Compare-Object $entries $expected) -or ($entries -match '(^|/)(test|node_modules|\.git|\.worktrees|state|storages)(/|$)')) { throw 'release-zip-contents-invalid' }
& node (Join-Path $PSScriptRoot 'verify-release.mjs')
if ($LASTEXITCODE -ne 0) { throw 'release-verification-failed' }
& node (Join-Path $root 'host\test\release-contract.mjs')
if ($LASTEXITCODE -ne 0) { throw 'release-contract-failed' }
Write-Output "release tests passed: $second"
