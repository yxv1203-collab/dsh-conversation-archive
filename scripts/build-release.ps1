[CmdletBinding()]
param([string]$SourceRoot = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$SourceRoot = if ($SourceRoot) { $SourceRoot } else { Split-Path $PSScriptRoot -Parent }
$root = (Resolve-Path -LiteralPath $SourceRoot).Path
$manifestPath = Join-Path $root 'release-manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$relativeFiles = @(
  'LICENSE', 'README.md', 'docs/ACCEPTANCE.md',
  'host/package.json', 'host/README.md', 'host/lib/core.js', 'host/lib/dsh-adapter.js', 'host/lib/index.js', 'host/lib/update-check.js',
  'client/package.json', 'client/lib/client.js', 'client/lib/index.js',
  'scripts/build-release.ps1', 'scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/verify-release.mjs'
) | Sort-Object
foreach ($relative in $relativeFiles) { if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) { throw "release-file-missing: $relative" } }
$hashes = [ordered]@{}
foreach ($relative in $relativeFiles) { $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $root $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
$output = [ordered]@{
  name = [string]$manifest.name; version = [string]$manifest.version; platform = [string]$manifest.platform
  dsh = [ordered]@{ minVersion = [string]$manifest.dsh.minVersion; maxTestedVersion = [string]$manifest.dsh.maxTestedVersion }
  release = [ordered]@{ repository = [string]$manifest.release.repository; apiUrl = [string]$manifest.release.apiUrl; pageUrl = [string]$manifest.release.pageUrl }
  files = $hashes
}
$utf8 = New-Object Text.UTF8Encoding($false)
$manifestJson = ($output | ConvertTo-Json -Depth 8).Replace("`r`n", "`n").Replace("`r", "`n") + "`n"
[IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8)

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zip = Join-Path $dist ("dsh-conversation-archive-$($manifest.version)-windows.zip")
$checksum = "$zip.sha256"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
if (Test-Path -LiteralPath $checksum) { Remove-Item -LiteralPath $checksum -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($zip, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
$stamp = New-Object DateTimeOffset(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
try {
  foreach ($relative in @('release-manifest.json') + $relativeFiles) {
    $entry = $archive.CreateEntry(($relative -replace '\\','/'), [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $stamp
    $input = [IO.File]::OpenRead((Join-Path $root $relative))
    $target = $entry.Open()
    try { $input.CopyTo($target) } finally { $target.Dispose(); $input.Dispose() }
  }
} finally { $archive.Dispose(); $stream.Dispose() }
$sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($checksum, "$sha  $([IO.Path]::GetFileName($zip))`n", [Text.Encoding]::ASCII)
Write-Output $zip
Write-Output $checksum
