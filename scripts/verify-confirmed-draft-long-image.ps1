[CmdletBinding()]
param(
  [string]$TestRoot = '',
  [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$renderer = Join-Path $PSScriptRoot 'create-confirmed-draft-long-image.ps1'
$legacyPackage = 'D:\tmp\warm-letter-ai-family\controlled-case-001'
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)

function Get-LowerSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
}

function Assert-Equal {
  param(
    [Parameter(Mandatory = $true)][object]$Actual,
    [Parameter(Mandatory = $true)][object]$Expected,
    [Parameter(Mandatory = $true)][string]$Message
  )

  if ($Actual -ne $Expected) {
    throw "$Message (actual: $Actual; expected: $Expected)"
  }
}

function New-SyntheticPhoto {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  Add-Type -AssemblyName System.Drawing
  $bitmap = [System.Drawing.Bitmap]::new(720, 1020, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $brushes = @()
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(248, 246, 240))
    $brushes = @(
      [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(67, 93, 87)),
      [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(120, 63, 66)),
      [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(214, 187, 104))
    )
    for ($index = 0; $index -lt $brushes.Count; $index += 1) {
      $x = 40 + ($index * 215)
      $graphics.FillRectangle($brushes[$index], $x, 120, 160, 740)
      $graphics.FillRectangle($brushes[$index], $x, 900, 160, 36)
    }
    $bitmap.Save($LiteralPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  } finally {
    foreach ($brush in $brushes) { $brush.Dispose() }
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Invoke-Renderer {
  param(
    [Parameter(Mandatory = $true)][string]$DraftPath,
    [Parameter(Mandatory = $true)][string]$PhotoPath,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$OutputName
  )

  & $renderer -ConfirmedDraftPath $DraftPath -PhotoPath $PhotoPath -OutputRoot $OutputRoot -OutputName $OutputName
  $manifestPath = Join-Path (Join-Path $OutputRoot 'exports') (([System.IO.Path]::GetFileNameWithoutExtension($OutputName)) + '.manifest.json')
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Renderer did not create a manifest: $manifestPath"
  }
  return Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

if ([string]::IsNullOrWhiteSpace($TestRoot)) {
  $TestRoot = Join-Path 'D:\tmp\warm-letter-ai-family' ('confirmed-draft-long-image-verify-' + [Guid]::NewGuid().ToString('N'))
}
$testRoot = [System.IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
$dTempPrefix = [System.IO.Path]::GetFullPath('D:\tmp').TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($dTempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'TestRoot must be a child directory of D:\\tmp.'
}
$rootCreated = $false
$fixedPng = Join-Path $legacyPackage 'exports\warm-letter-case-001-recommended-a.png'
$fixedManifest = Join-Path $legacyPackage 'exports\warm-letter-case-001-recommended-a.manifest.json'
$fixedPngBefore = if (Test-Path -LiteralPath $fixedPng -PathType Leaf) { Get-LowerSha256 -LiteralPath $fixedPng } else { $null }
$fixedManifestBefore = if (Test-Path -LiteralPath $fixedManifest -PathType Leaf) { Get-LowerSha256 -LiteralPath $fixedManifest } else { $null }

try {
  New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
  $rootCreated = $true
  $photoPath = Join-Path $testRoot 'synthetic-photo.jpg'
  New-SyntheticPhoto -LiteralPath $photoPath

  $draft = [ordered]@{
    version = 4
    title = '给家里人的周三'
    greeting = '亲爱的家里人：'
    paragraphs = @(
      [ordered]@{
        id = 'a0010000-0000-4000-8000-000000000101'
        text = '今天上午开会后有点累。'
        sourceRefs = @('a0010000-0000-4000-8000-000000000001')
        sourceAttribution = 'ai'
      },
      [ordered]@{
        id = 'a0010000-0000-4000-8000-000000000102'
        text = '中午的一小瓶饮品让我轻松了一点。'
        sourceRefs = @('a0010000-0000-4000-8000-000000000001')
        sourceAttribution = 'sources-confirmed'
      }
    )
    closing = '愿你们今天也平安。'
    signature = '想念你们的我'
    provider = 'verify-fixture'
    generatedAt = '2026-08-28T08:00:00.000Z'
    aiDisclosure = [ordered]@{ isAiGenerated = $true; label = '固定审核稿' }
  }
  $draftPath = Join-Path $testRoot 'confirmed-draft.json'
  [System.IO.File]::WriteAllText($draftPath, (($draft | ConvertTo-Json -Depth 20) + "`n"), $utf8WithoutBom)
  $directManifest = Invoke-Renderer -DraftPath $draftPath -PhotoPath $photoPath -OutputRoot (Join-Path $testRoot 'direct') -OutputName 'direct.png'
  Assert-Equal -Actual $directManifest.packageKind -Expected 'warm-letter-confirmed-draft-long-image' -Message 'Direct LetterDraft package kind mismatch'
  Assert-Equal -Actual $directManifest.output.width -Expected 1080 -Message 'Direct output width mismatch'
  Assert-Equal -Actual $directManifest.confirmedDraft.version -Expected 4 -Message 'Direct confirmedDraft version mismatch'
  Assert-Equal -Actual $directManifest.confirmedDraft.paragraphCount -Expected 2 -Message 'Direct paragraph count mismatch'
  Assert-Equal -Actual $directManifest.confirmedDraft.closingIncluded -Expected $true -Message 'Direct closing was not recorded'
  Assert-Equal -Actual $directManifest.controls.absolutePathsIncluded -Expected $false -Message 'Direct manifest contains absolute paths'

  $nested = [ordered]@{ letter = [ordered]@{ confirmedDraft = $draft } }
  $nestedPath = Join-Path $testRoot 'api-response.json'
  [System.IO.File]::WriteAllText($nestedPath, (($nested | ConvertTo-Json -Depth 20) + "`n"), $utf8WithoutBom)
  $nestedManifest = Invoke-Renderer -DraftPath $nestedPath -PhotoPath $photoPath -OutputRoot (Join-Path $testRoot 'nested') -OutputName 'nested.png'
  Assert-Equal -Actual $nestedManifest.confirmedDraft.draftSha256 -Expected $directManifest.confirmedDraft.draftSha256 -Message 'Nested confirmedDraft hash differs from direct draft'
  Assert-Equal -Actual $nestedManifest.bodySha256 -Expected $directManifest.bodySha256 -Message 'Nested body hash differs from direct draft'
  Assert-Equal -Actual $nestedManifest.output.width -Expected 1080 -Message 'Nested output width mismatch'

  $longParagraphs = @()
  for ($index = 1; $index -le 6; $index += 1) {
    $longParagraphs += [ordered]@{
      id = ('a0010000-0000-4000-8000-0000000002{0:D2}' -f $index)
      text = (('这是用于排版回归的较长中文段落，确认稿内容应完整保留并自动换行。' * 8).Trim())
      sourceRefs = @('a0010000-0000-4000-8000-000000000001')
      sourceAttribution = 'sources-confirmed'
    }
  }
  $longDraft = [ordered]@{
    version = 8
    title = '给家里人的一封很长很长的周三记录与近况分享'
    greeting = '亲爱的家里人：'
    paragraphs = $longParagraphs
    closing = '愿你们在每一个普通的日子里都平安、舒心。'
    signature = '一直想念你们的我'
    provider = 'verify-long-fixture'
    generatedAt = '2026-08-28T08:00:00.000Z'
    aiDisclosure = [ordered]@{ isAiGenerated = $true; label = '固定审核稿' }
  }
  $longPath = Join-Path $testRoot 'long-confirmed-draft.json'
  [System.IO.File]::WriteAllText($longPath, (($longDraft | ConvertTo-Json -Depth 20) + "`n"), $utf8WithoutBom)
  $longManifest = Invoke-Renderer -DraftPath $longPath -PhotoPath $photoPath -OutputRoot (Join-Path $testRoot 'long') -OutputName 'long.png'
  Assert-Equal -Actual $longManifest.output.width -Expected 1080 -Message 'Long output width mismatch'
  if ([int]$longManifest.output.height -le [int]$directManifest.output.height -or [int]$longManifest.output.height -gt 12000) {
    throw "Long output height did not scale within the supported range (actual: $($longManifest.output.height))."
  }
  Assert-Equal -Actual $longManifest.confirmedDraft.paragraphCount -Expected 6 -Message 'Long paragraph count mismatch'
  Assert-Equal -Actual $longManifest.confirmedDraft.signature -Expected '一直想念你们的我' -Message 'Long signature mismatch'

  $oversizedDraft = [ordered]@{}
  foreach ($entry in $longDraft.GetEnumerator()) { $oversizedDraft[$entry.Key] = $entry.Value }
  $oversizedDraft.paragraphs = @($longParagraphs)
  $oversizedDraft.paragraphs[0].text = (('这是用于上限拒绝回归的超长中文段落。' * 60).Trim())
  $oversizedPath = Join-Path $testRoot 'oversized-confirmed-draft.json'
  [System.IO.File]::WriteAllText($oversizedPath, (($oversizedDraft | ConvertTo-Json -Depth 20) + "`n"), $utf8WithoutBom)
  $oversizedOutput = Join-Path $testRoot 'oversized'
  $oversizedRejected = $false
  try {
    Invoke-Renderer -DraftPath $oversizedPath -PhotoPath $photoPath -OutputRoot $oversizedOutput -OutputName 'oversized.png' | Out-Null
  } catch {
    $oversizedRejected = $true
  }
  Assert-Equal -Actual $oversizedRejected -Expected $true -Message 'Oversized long image was not rejected'
  Assert-Equal -Actual (Test-Path -LiteralPath $oversizedOutput) -Expected $false -Message 'Oversized render left an output directory'

  $invalid = [ordered]@{}
  foreach ($entry in $draft.GetEnumerator()) { $invalid[$entry.Key] = $entry.Value }
  $invalid['unexpected'] = 'reject-me'
  $invalidPath = Join-Path $testRoot 'invalid-draft.json'
  [System.IO.File]::WriteAllText($invalidPath, (($invalid | ConvertTo-Json -Depth 20) + "`n"), $utf8WithoutBom)
  $invalidOutput = Join-Path $testRoot 'invalid-output'
  $rejected = $false
  try {
    Invoke-Renderer -DraftPath $invalidPath -PhotoPath $photoPath -OutputRoot $invalidOutput -OutputName 'invalid.png' | Out-Null
  } catch {
    $rejected = $true
  }
  Assert-Equal -Actual $rejected -Expected $true -Message 'Invalid confirmedDraft was not rejected'
  Assert-Equal -Actual (Test-Path -LiteralPath $invalidOutput) -Expected $false -Message 'Invalid render left an output directory'

  if ($null -ne $fixedPngBefore) {
    Assert-Equal -Actual (Get-LowerSha256 -LiteralPath $fixedPng) -Expected $fixedPngBefore -Message 'CASE-001 fixed PNG changed during generic verification'
  }
  if ($null -ne $fixedManifestBefore) {
    Assert-Equal -Actual (Get-LowerSha256 -LiteralPath $fixedManifest) -Expected $fixedManifestBefore -Message 'CASE-001 fixed manifest changed during generic verification'
  }
  Write-Host 'confirmedDraft direct/nested input, long Chinese text, height-cap rejection, contract rejection, 1080px output, manifest consistency, synthetic-media boundary, and CASE-001 preservation: PASS'
} finally {
  if ($rootCreated -and -not $KeepArtifacts -and (Test-Path -LiteralPath $testRoot)) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
