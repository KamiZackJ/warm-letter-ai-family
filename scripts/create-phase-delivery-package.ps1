[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$ControlledPackageRoot = 'D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28',

  [ValidateNotNullOrEmpty()]
  [string]$ControlledArchivePath = 'D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28.zip',

  [ValidateNotNullOrEmpty()]
  [string]$ProductBriefPath = 'D:\tmp\warm-letter-ai-family\submission\暖笺_AI产品说明书_阶段版_2026-08-28-r2.pdf',

  [ValidateNotNullOrEmpty()]
  [string]$OutputDirectory = 'D:\tmp\warm-letter-ai-family',

  [ValidateNotNullOrEmpty()]
  [string]$PackageName = '暖笺_阶段汇报交付包_2026-08-28-r2',

  [ValidatePattern('^[a-fA-F0-9]{64}$')]
  [string]$ExpectedControlledArchiveSha256 = '1ce227e3b90734674dd128c0cbbbe650bb89ddd79bc1a00e2837db2cf4610954'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$allowedRoot = [System.IO.Path]::GetFullPath('D:\tmp').TrimEnd('\') + '\'
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$expectedPhotoSha256 = 'e09c8091a6676398d81ba40cd28d11c2f598e846748cfe2a069a09666ee6706b'
$expectedAudioSha256 = 'f9ec48c022bc98d9cc5ac3ff061c65108fe4827ccd8aac9ef1aca15ff88ea4dc'
$expectedLongImageSha256 = '24b72c0626e12435e50bdcf911dac55914b092bcff147cfb61cf3d17b582f0ed'
$expectedLongImageManifestSha256 = '281101bdd8aca3b90d865594ffa5b1e88ded9245fa94383df5ef9aa14f5baf8c'
$pdfOutputName = '暖笺_AI产品说明书_阶段版_2026-08-28-r2.pdf'

$interactiveEntries = @(
  'PROJECT_INTEGRATION.md',
  'README.md',
  'demo-case.js',
  'demo-case.json',
  'evidence/automated-acceptance-tests.json',
  'evidence/case-001-output.json',
  'evidence/content-safety-policy.json',
  'evidence/material-manifest.csv',
  'evidence/privacy-review.json',
  'exports/warm-letter-case-001-recommended-a.manifest.json',
  'exports/warm-letter-case-001-recommended-a.png',
  'index.html',
  'manifest.json',
  'media/case-001-audio.m4a',
  'media/case-001-photo-crop.jpg'
)

function Get-LowerSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
}

function Assert-UnderDTemp {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $resolved = [System.IO.Path]::GetFullPath($LiteralPath)
  if (-not $resolved.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a child path of D:\\tmp."
  }
  return $resolved
}

function Assert-NoReparsePoint {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  $current = $root.TrimEnd('\')
  foreach ($part in $fullPath.Substring($root.Length).Split('\', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $part
    if (-not (Test-Path -LiteralPath $current)) { continue }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are not allowed in controlled package paths: $current"
    }
  }
}

function Get-RelativeFileMap {
  param([Parameter(Mandatory = $true)][string]$Root)

  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $prefixLength = $rootFull.Length + 1
  $result = [ordered]@{}
  foreach ($file in Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring($prefixLength).Replace('\', '/')
    $result[$relative] = [ordered]@{
      bytes = $file.Length
      sha256 = Get-LowerSha256 -LiteralPath $file.FullName
    }
  }
  return $result
}

function Assert-ExactEntrySet {
  param(
    [Parameter(Mandatory = $true)][string[]]$Actual,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $difference = @(Compare-Object -ReferenceObject @($Expected | Sort-Object) -DifferenceObject @($Actual | Sort-Object))
  if ($difference.Count -gt 0) {
    $details = $difference | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }
    throw "$Label entry set differs from the approved whitelist: $($details -join '; ')"
  }
}

function Assert-ArchiveMatchesDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string[]]$ExpectedEntries
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $directoryMap = Get-RelativeFileMap -Root $Directory
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
    foreach ($entry in $entries) {
      if ($entry.FullName.Contains('\') -or $entry.FullName.StartsWith('/') -or $entry.FullName.Split('/') -contains '..') {
        throw "Controlled archive contains a non-portable entry: $($entry.FullName)"
      }
    }
    $entryNames = @($entries | ForEach-Object { $_.FullName })
    Assert-ExactEntrySet -Actual $entryNames -Expected $ExpectedEntries -Label 'Controlled archive'
    foreach ($entry in $entries) {
      $source = $entry.Open()
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $entryHash = ([System.BitConverter]::ToString($sha.ComputeHash($source))).Replace('-', '').ToLowerInvariant()
        if ($entryHash -cne [string]$directoryMap[$entry.FullName].sha256) {
          throw "Controlled archive entry differs from the approved directory: $($entry.FullName)"
        }
      } finally {
        $sha.Dispose()
        $source.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Assert-SafePortableText {
  param([Parameter(Mandatory = $true)][string]$Root)

  $textExtensions = @('.md', '.json', '.js', '.html', '.csv', '.txt', '.ps1', '.ts')
  $forbidden = [ordered]@{
    'C drive path' = '(?i)\bc:\\'
    'WeChat export path' = '(?i)xwechat'
    'raw transcript field' = '(?i)raw_asr'
    'private case input' = '(?i)case_001\.input'
    'private system prompt file' = '(?i)safe_generation_prompt'
    'authorization credential' = '(?i)authorization\s*[:=]|bearer\s+[a-z0-9._-]+'
    'OpenAI-style secret' = '(?i)\bsk-[a-z0-9_-]{8,}'
  }
  foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
    if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
    $text = [System.IO.File]::ReadAllText($file.FullName)
    foreach ($rule in $forbidden.GetEnumerator()) {
      if ($text -match $rule.Value) {
        $relative = $file.FullName.Substring(([System.IO.Path]::GetFullPath($Root).TrimEnd('\').Length + 1)).Replace('\', '/')
        throw "Portable package text contains forbidden data ($($rule.Key)): $relative"
      }
    }
  }
}

$controlledRootFull = Assert-UnderDTemp -LiteralPath $ControlledPackageRoot -Label 'ControlledPackageRoot'
$controlledArchiveFull = Assert-UnderDTemp -LiteralPath $ControlledArchivePath -Label 'ControlledArchivePath'
$productBriefFull = Assert-UnderDTemp -LiteralPath $ProductBriefPath -Label 'ProductBriefPath'
$outputDirectoryFull = Assert-UnderDTemp -LiteralPath $OutputDirectory -Label 'OutputDirectory'

foreach ($path in @($controlledRootFull, $controlledArchiveFull, $productBriefFull, $outputDirectoryFull)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required input does not exist: $path" }
  Assert-NoReparsePoint -LiteralPath $path
}
if (-not (Test-Path -LiteralPath $controlledRootFull -PathType Container)) { throw 'ControlledPackageRoot must be a directory.' }
if (-not (Test-Path -LiteralPath $controlledArchiveFull -PathType Leaf)) { throw 'ControlledArchivePath must be a ZIP file.' }
if (-not (Test-Path -LiteralPath $productBriefFull -PathType Leaf)) { throw 'ProductBriefPath must be a PDF file.' }

if ((Get-LowerSha256 -LiteralPath $controlledArchiveFull) -cne $ExpectedControlledArchiveSha256.ToLowerInvariant()) {
  throw 'Controlled CASE-001 archive SHA-256 mismatch.'
}
if ([System.IO.Path]::GetFileName($ProductBriefPath) -cne $pdfOutputName) {
  throw "ProductBriefPath must use the reviewed filename: $pdfOutputName"
}
$pdfMagic = [System.IO.File]::ReadAllBytes($productBriefFull)[0..4]
if ([System.Text.Encoding]::ASCII.GetString($pdfMagic) -cne '%PDF-') { throw 'ProductBriefPath is not a PDF file.' }

$controlledMap = Get-RelativeFileMap -Root $controlledRootFull
Assert-ExactEntrySet -Actual @($controlledMap.Keys) -Expected $interactiveEntries -Label 'Controlled package directory'
Assert-ArchiveMatchesDirectory -ArchivePath $controlledArchiveFull -Directory $controlledRootFull -ExpectedEntries $interactiveEntries

$controlledManifest = Get-Content -LiteralPath (Join-Path $controlledRootFull 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (
  $controlledManifest.packageKind -cne 'warm-letter-controlled-demo' -or
  $controlledManifest.materialId -cne 'NUANJIAN-CASE-001' -or
  -not [bool]$controlledManifest.controls.pathsAreRelative -or
  [bool]$controlledManifest.controls.originalPhotoIncluded -or
  [bool]$controlledManifest.controls.credentialsIncluded -or
  -not [bool]$controlledManifest.controls.sourceEvidenceCopiedVerbatim -or
  -not [bool]$controlledManifest.controls.longImageIncluded
) {
  throw 'Controlled package manifest does not satisfy the approved material and privacy boundary.'
}
if (
  [string]$controlledManifest.outputs.photo.sha256 -cne $expectedPhotoSha256 -or
  [int]$controlledManifest.outputs.photo.width -ne 720 -or
  [int]$controlledManifest.outputs.photo.height -ne 1020 -or
  [string]$controlledManifest.outputs.audio.sha256 -cne $expectedAudioSha256 -or
  [double]$controlledManifest.outputs.audio.durationSeconds -ne 8.895 -or
  [string]$controlledManifest.longImage.png.sha256 -cne $expectedLongImageSha256 -or
  [int]$controlledManifest.longImage.png.width -ne 1080 -or
  [int]$controlledManifest.longImage.png.height -ne 2631 -or
  [string]$controlledMap['exports/warm-letter-case-001-recommended-a.manifest.json'].sha256 -cne $expectedLongImageManifestSha256
) {
  throw 'Controlled package media or long-image evidence differs from the reviewed CASE-001 release.'
}

$gitStatus = & git -C $repositoryRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Unable to read repository status.' }
if (-not [string]::IsNullOrWhiteSpace(($gitStatus -join "`n"))) {
  throw 'Repository must be clean before creating a handoff package, so PACKAGE_MANIFEST.json can bind to a commit.'
}
$sourceCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
$sourceBranch = (& git -C $repositoryRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceCommit)) { throw 'Unable to resolve repository commit.' }

$finalDirectory = Join-Path $outputDirectoryFull $PackageName
$finalArchive = Join-Path $outputDirectoryFull "$PackageName.zip"
if ((Test-Path -LiteralPath $finalDirectory) -or (Test-Path -LiteralPath $finalArchive)) {
  throw 'Refusing to overwrite an existing phase delivery. Choose a new PackageName.'
}

$operationId = [Guid]::NewGuid().ToString('N')
$stage = Join-Path $outputDirectoryFull ".phase-delivery-stage-$operationId"
$archiveStage = Join-Path $outputDirectoryFull ".phase-delivery-$operationId.zip"
$stageExists = $false
$archiveStageExists = $false

try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  $stageExists = $true
  foreach ($directory in @('interactive', 'handoff', 'adapter', 'adapter\contracts', 'adapter\scripts')) {
    New-Item -ItemType Directory -Path (Join-Path $stage $directory) -Force | Out-Null
  }

  foreach ($item in Get-ChildItem -LiteralPath $controlledRootFull -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $stage 'interactive') -Recurse -Force
  }
  Copy-Item -LiteralPath $productBriefFull -Destination (Join-Path $stage $pdfOutputName)
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'docs\DELIVERY_PACKAGE_README_2026-08-28.md') -Destination (Join-Path $stage 'README.md')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'docs\PORTABLE_HANDOFF_2026-08-28.md') -Destination (Join-Path $stage 'handoff\README.md')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'docs\CONFIRMED_DRAFT_ADAPTER_PACKAGE_README.md') -Destination (Join-Path $stage 'adapter\README.md')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'docs\CONFIRMED_DRAFT_LONG_IMAGE.md') -Destination (Join-Path $stage 'adapter\CONFIRMED_DRAFT_LONG_IMAGE.md')
  Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\contracts\src\models.ts') -Destination (Join-Path $stage 'adapter\contracts\models.ts')
  foreach ($scriptName in @('create-confirmed-draft-long-image.ps1', 'create-case-001-long-image.ps1', 'verify-confirmed-draft-long-image.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $scriptName) -Destination (Join-Path $stage "adapter\scripts\$scriptName")
  }

  $copiedInteractiveMap = Get-RelativeFileMap -Root (Join-Path $stage 'interactive')
  Assert-ExactEntrySet -Actual @($copiedInteractiveMap.Keys) -Expected $interactiveEntries -Label 'Packaged interactive directory'
  foreach ($entry in $interactiveEntries) {
    if ([string]$copiedInteractiveMap[$entry].sha256 -cne [string]$controlledMap[$entry].sha256) {
      throw "Packaged interactive file differs from the reviewed controlled source: $entry"
    }
  }

  $packageEntries = Get-RelativeFileMap -Root $stage
  $manifest = [ordered]@{
    schemaVersion = 1
    packageKind = 'warm-letter-phase-delivery'
    packageName = $PackageName
    repository = [ordered]@{
      branch = $sourceBranch
      sourceCommit = $sourceCommit
    }
    controlledCase = [ordered]@{
      materialId = 'NUANJIAN-CASE-001'
      archiveSha256 = Get-LowerSha256 -LiteralPath $controlledArchiveFull
      interactiveEntryCount = $interactiveEntries.Count
      photoDerivativeSha256 = $expectedPhotoSha256
      audioSha256 = $expectedAudioSha256
      longImageSha256 = $expectedLongImageSha256
    }
    productBrief = [ordered]@{
      path = $pdfOutputName
      bytes = (Get-Item -LiteralPath $productBriefFull).Length
      sha256 = Get-LowerSha256 -LiteralPath $productBriefFull
    }
    entries = $packageEntries
    controls = [ordered]@{
      pathsAreRelative = $true
      controlledInteractiveCopiedByteForByte = $true
      originalPhotoIncluded = $false
      originalTranscriptIncluded = $false
      privatePromptIncluded = $false
      credentialsIncluded = $false
      historicalSyntheticScreenshotsIncluded = $false
      teammateMediaRestrictedToInteractive = $true
      handoffAndAdapterIncluded = $true
    }
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $stage 'PACKAGE_MANIFEST.json'),
    (($manifest | ConvertTo-Json -Depth 20) + "`n"),
    $utf8WithoutBom
  )

  Assert-SafePortableText -Root $stage

  Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stage -Force | ForEach-Object { $_.FullName }) -DestinationPath $archiveStage -CompressionLevel Optimal
  $archiveStageExists = $true

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archiveStage)
  try {
    $rawNames = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) } | ForEach-Object { $_.FullName })
    foreach ($name in $rawNames) {
      if ($name.Contains('\') -or $name.StartsWith('/') -or $name.Split('/') -contains '..' -or $name -match '^[A-Za-z]:') {
        throw "Generated phase archive contains a non-portable entry: $name"
      }
    }
    $expectedArchiveEntries = @((Get-RelativeFileMap -Root $stage).Keys)
    Assert-ExactEntrySet -Actual $rawNames -Expected $expectedArchiveEntries -Label 'Generated phase archive'
  } finally {
    $archive.Dispose()
  }

  Move-Item -LiteralPath $stage -Destination $finalDirectory
  $stageExists = $false
  Move-Item -LiteralPath $archiveStage -Destination $finalArchive
  $archiveStageExists = $false
} finally {
  if ($stageExists -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
  if ($archiveStageExists -and (Test-Path -LiteralPath $archiveStage)) { Remove-Item -LiteralPath $archiveStage -Force }
}

Write-Host "Created phase delivery: $finalDirectory"
Write-Host "Created archive: $finalArchive"
Write-Host "Archive SHA-256: $(Get-LowerSha256 -LiteralPath $finalArchive)"
Write-Host 'Controlled teammate media, current interactive, product brief, handoff, adapter, relative-path, and sensitive-text checks: PASS'
