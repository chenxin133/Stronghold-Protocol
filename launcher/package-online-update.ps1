param([string]$OutDirectory = (Join-Path $PSScriptRoot 'dist'))
$ErrorActionPreference = 'Stop'
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') | ConvertFrom-Json).version
$out = [IO.Path]::GetFullPath($OutDirectory)
New-Item -ItemType Directory -Path $out -Force | Out-Null
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$temporary = Join-Path $temporaryRoot ('stronghold-online-update-' + [guid]::NewGuid().ToString('N'))
if (-not [IO.Path]::GetFullPath($temporary).StartsWith($temporaryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected update staging path' }
try {
  $stage = Join-Path $temporary 'Stronghold-PWA-Server'
  $launcher = Join-Path $stage 'launcher'
  New-Item -ItemType Directory -Path $launcher -Force | Out-Null
  foreach ($name in @('online.mjs', 'package.json', 'package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $launcher $name)
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\Join-Game.cmd') -Destination (Join-Path $stage 'Join-Game.cmd')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\docs\PWA-SUBSCRIPTIONS.md') -Destination (Join-Path $stage 'README.md')
  $zip = Join-Path $out "Stronghold-PWA-Server-$version-Online-Update.zip"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Fastest, $true)
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($name in @('Join-Game.cmd', 'launcher/online.mjs', 'launcher/package.json', 'launcher/package-lock.json', 'README.md')) {
      if ($null -eq $archive.GetEntry("Stronghold-PWA-Server/$name")) { throw "Missing update file: $name" }
    }
  } finally { $archive.Dispose() }
  $hash = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($zip)
  try {
    $digest = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally { $stream.Dispose(); $hash.Dispose() }
  $checksum = $digest + '  ' + [IO.Path]::GetFileName($zip) + "`n"
  [IO.File]::WriteAllText($zip + '.sha256', $checksum)
  Write-Output $zip
  Write-Output $checksum.Trim()
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
