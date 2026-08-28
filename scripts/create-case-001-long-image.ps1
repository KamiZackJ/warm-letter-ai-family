[CmdletBinding()]
param(
  [ValidateNotNullOrEmpty()]
  [string]$InputRoot = 'D:\tmp\warm-letter-ai-family\controlled-case-001',

  [ValidateNotNullOrEmpty()]
  [string]$OutputName = 'warm-letter-case-001-recommended-a.png',

  # Keep the original CASE-001 output byte-compatible by default. The generic
  # confirmedDraft adapter opts into these display/manifest labels explicitly.
  [ValidateNotNullOrEmpty()]
  [string]$HeaderLabel = 'CASE-001 · 推荐 A',

  [ValidateNotNullOrEmpty()]
  [string]$Disclosure = '队友固定审核稿 / 非实时 OpenAI / 由写信人确认',

  [ValidateNotNullOrEmpty()]
  [string]$PhotoCaption = '生活照片 · 商店货架、商品与 9.9 元价签',

  [ValidateNotNullOrEmpty()]
  [string]$PackageKind = 'warm-letter-case-001-long-image',

  [switch]$AllowAnyCaseId,
  [switch]$AllowNonColonGreeting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$allowedInputRoot = [System.IO.Path]::GetFullPath('D:\tmp').TrimEnd('\') + '\'
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$requiredDisclosure = $Disclosure
$canvasWidth = 1080
$maximumCanvasHeight = 12000
$paperColor = '#FBFAF7'
$inkColor = '#2D302D'
$sageColor = '#435D57'
$wineColor = '#783F42'
$lineColor = '#D8D1C5'
$mutedColor = '#686E69'

function Get-RequiredProperty {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    throw "demo-case.json is missing required property: $Name"
  }
  return $property.Value
}

function Get-LowerSha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  return (Get-FileHash -Algorithm SHA256 -LiteralPath $LiteralPath).Hash.ToLowerInvariant()
}

function Get-TextSha256 {
  param([Parameter(Mandatory = $true)][string]$Value)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha.ComputeHash($utf8WithoutBom.GetBytes($Value))
    return ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Assert-NoReparsePoint {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $fullPath = [System.IO.Path]::GetFullPath($LiteralPath)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  $current = $root.TrimEnd('\')
  $remainder = $fullPath.Substring($root.Length)
  foreach ($part in $remainder.Split('\', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $part
    if (-not (Test-Path -LiteralPath $current)) {
      continue
    }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Reparse points are not allowed in the controlled input/output path: $current"
    }
  }
}

function Resolve-ControlledRelativeFile {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativeUrl
  )

  if (
    -not $RelativeUrl.StartsWith('./', [System.StringComparison]::Ordinal) -or
    $RelativeUrl.Contains('\') -or
    $RelativeUrl.Contains(':') -or
    $RelativeUrl.Contains('?') -or
    $RelativeUrl.Contains('#') -or
    $RelativeUrl.Split('/') -contains '..'
  ) {
    throw 'The controlled photo must use a local POSIX-style relative path without a query or fragment.'
  }

  $relativePath = $RelativeUrl.Substring(2).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $resolved = [System.IO.Path]::GetFullPath((Join-Path $Root $relativePath))
  $rootPrefix = $Root.TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The controlled photo path escaped InputRoot.'
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "The controlled photo does not exist: $RelativeUrl"
  }
  Assert-NoReparsePoint -LiteralPath $resolved
  return $resolved
}

function Resolve-FontFamilyName {
  param(
    [Parameter(Mandatory = $true)][string[]]$Candidates,
    [Parameter(Mandatory = $true)][string]$Fallback
  )

  $installed = [System.Drawing.Text.InstalledFontCollection]::new()
  try {
    $available = @{}
    foreach ($family in $installed.Families) {
      $available[$family.Name.ToLowerInvariant()] = $family.Name
    }
    foreach ($candidate in $Candidates) {
      $key = $candidate.ToLowerInvariant()
      if ($available.ContainsKey($key)) {
        return [string]$available[$key]
      }
    }
    return $Fallback
  } finally {
    $installed.Dispose()
  }
}

function New-TextFormat {
  param(
    [System.Drawing.StringAlignment]$Alignment = [System.Drawing.StringAlignment]::Near
  )

  $format = [System.Drawing.StringFormat]::new([System.Drawing.StringFormat]::GenericTypographic)
  $format.Alignment = $Alignment
  $format.LineAlignment = [System.Drawing.StringAlignment]::Near
  $format.Trimming = [System.Drawing.StringTrimming]::None
  $format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
  return $format
}

function Measure-LineWidth {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][System.Drawing.Font]$Font,
    [Parameter(Mandatory = $true)][System.Drawing.StringFormat]$Format
  )

  if ($Text.Length -eq 0) {
    return 0.0
  }
  return $Graphics.MeasureString($Text, $Font, 20000, $Format).Width
}

function Get-WrappedLines {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][System.Drawing.Font]$Font,
    [Parameter(Mandatory = $true)][float]$MaximumWidth,
    [Parameter(Mandatory = $true)][System.Drawing.StringFormat]$Format
  )

  $result = [System.Collections.Generic.List[string]]::new()
  $explicitLines = ($Text -replace "`r`n", "`n" -replace "`r", "`n").Split("`n")
  foreach ($explicitLine in $explicitLines) {
    if ($explicitLine.Length -eq 0) {
      $result.Add('')
      continue
    }

    $current = ''
    $enumerator = [System.Globalization.StringInfo]::GetTextElementEnumerator($explicitLine)
    while ($enumerator.MoveNext()) {
      $element = [string]$enumerator.GetTextElement()
      $candidate = $current + $element
      if ($current.Length -gt 0 -and (Measure-LineWidth -Graphics $Graphics -Text $candidate -Font $Font -Format $Format) -gt $MaximumWidth) {
        $result.Add($current)
        $current = $element
      } else {
        $current = $candidate
      }
    }
    if ($current.Length -gt 0) {
      $result.Add($current)
    }
  }

  if ($result.Count -eq 0) {
    $result.Add('')
  }
  return @($result)
}

function Draw-Lines {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Graphics]$Graphics,
    [Parameter(Mandatory = $true)][string[]]$Lines,
    [Parameter(Mandatory = $true)][System.Drawing.Font]$Font,
    [Parameter(Mandatory = $true)][System.Drawing.Brush]$Brush,
    [Parameter(Mandatory = $true)][float]$X,
    [Parameter(Mandatory = $true)][float]$Y,
    [Parameter(Mandatory = $true)][float]$Width,
    [Parameter(Mandatory = $true)][float]$LineHeight,
    [Parameter(Mandatory = $true)][System.Drawing.StringFormat]$Format
  )

  $currentY = $Y
  foreach ($line in $Lines) {
    if ($line.Length -gt 0) {
      $rectangle = [System.Drawing.RectangleF]::new($X, $currentY, $Width, $LineHeight)
      $Graphics.DrawString($line, $Font, $Brush, $rectangle, $Format)
    }
    $currentY += $LineHeight
  }
  return $currentY
}

function Assert-SafeGeneratedManifest {
  param([Parameter(Mandatory = $true)][string]$Json)

  $forbiddenPatterns = [ordered]@{
    'HTTP URL' = '(?i)https?://'
    'drive-qualified path' = '(?i)\b[a-z]:[\\/]'
    'share or media token field' = '(?i)(share|media)[ _-]?token'
    'authorization credential' = '(?i)authorization\s*[:=]|bearer\s+[a-z0-9._-]+'
    'OpenAI-style secret' = '(?i)\bsk-[a-z0-9_-]{8,}'
  }
  foreach ($entry in $forbiddenPatterns.GetEnumerator()) {
    if ($Json -match $entry.Value) {
      throw "Generated manifest contains forbidden data: $($entry.Key)."
    }
  }
}

function Get-PixelEvidence {
  param(
    [Parameter(Mandatory = $true)][System.Drawing.Bitmap]$Bitmap,
    [Parameter(Mandatory = $true)][System.Drawing.Color]$Background
  )

  $sampleStep = 12
  $sampleCount = 0
  $nonBackgroundCount = 0
  $minimumLuminance = 255
  $maximumLuminance = 0
  $colors = [System.Collections.Generic.HashSet[int]]::new()
  for ($y = 0; $y -lt $Bitmap.Height; $y += $sampleStep) {
    for ($x = 0; $x -lt $Bitmap.Width; $x += $sampleStep) {
      $pixel = $Bitmap.GetPixel($x, $y)
      [void]$colors.Add($pixel.ToArgb())
      $sampleCount += 1
      if (
        [Math]::Abs([int]$pixel.R - [int]$Background.R) -gt 3 -or
        [Math]::Abs([int]$pixel.G - [int]$Background.G) -gt 3 -or
        [Math]::Abs([int]$pixel.B - [int]$Background.B) -gt 3
      ) {
        $nonBackgroundCount += 1
      }
      $luminance = [int][Math]::Round((0.2126 * $pixel.R) + (0.7152 * $pixel.G) + (0.0722 * $pixel.B))
      $minimumLuminance = [Math]::Min($minimumLuminance, $luminance)
      $maximumLuminance = [Math]::Max($maximumLuminance, $luminance)
    }
  }

  if ($sampleCount -eq 0 -or $nonBackgroundCount -lt [Math]::Ceiling($sampleCount * 0.08)) {
    throw 'Generated PNG pixel verification failed: the image is blank or nearly blank.'
  }
  if ($colors.Count -lt 64 -or ($maximumLuminance - $minimumLuminance) -lt 80) {
    throw 'Generated PNG pixel verification failed: insufficient color or luminance variation.'
  }

  return [ordered]@{
    sampleStep = $sampleStep
    sampledPixels = $sampleCount
    nonBackgroundPixels = $nonBackgroundCount
    distinctSampledColors = $colors.Count
    minimumLuminance = $minimumLuminance
    maximumLuminance = $maximumLuminance
  }
}

$inputRootFull = [System.IO.Path]::GetFullPath($InputRoot).TrimEnd('\')
if (-not $inputRootFull.StartsWith($allowedInputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "InputRoot must be a child directory of $($allowedInputRoot.TrimEnd('\'))."
}
if (-not (Test-Path -LiteralPath $inputRootFull -PathType Container)) {
  throw "InputRoot is not an existing controlled package directory: $inputRootFull"
}
Assert-NoReparsePoint -LiteralPath $inputRootFull

if (
  [System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or
  [System.IO.Path]::GetExtension($OutputName) -ine '.png'
) {
  throw 'OutputName must be a plain PNG filename without directory components.'
}

$casePath = Join-Path $inputRootFull 'demo-case.json'
if (-not (Test-Path -LiteralPath $casePath -PathType Leaf)) {
  throw 'The controlled package is missing demo-case.json.'
}
Assert-NoReparsePoint -LiteralPath $casePath

$caseHashBefore = Get-LowerSha256 -LiteralPath $casePath
try {
  $caseJson = [System.IO.File]::ReadAllText($casePath, [System.Text.UTF8Encoding]::new($false, $true))
  $demoCase = $caseJson | ConvertFrom-Json
} catch {
  throw "demo-case.json is not valid strict UTF-8 JSON: $($_.Exception.Message)"
}

$schemaVersion = [int](Get-RequiredProperty -Object $demoCase -Name 'schemaVersion')
$caseId = [string](Get-RequiredProperty -Object $demoCase -Name 'caseId')
$recommendedDraftId = [string](Get-RequiredProperty -Object $demoCase -Name 'recommendedDraftId')
$drafts = @(Get-RequiredProperty -Object $demoCase -Name 'drafts')
$photoUrl = [string](Get-RequiredProperty -Object $demoCase -Name 'photoUrl')
$photoCrop = Get-RequiredProperty -Object $demoCase -Name 'photoCrop'
$titleProperty = $demoCase.PSObject.Properties['title']
$title = if ($null -ne $titleProperty -and -not [string]::IsNullOrWhiteSpace([string]$titleProperty.Value)) {
  [string]$titleProperty.Value
} else {
  '写给家里人的今天'
}

if ($schemaVersion -ne 1 -or ((-not $AllowAnyCaseId) -and $caseId -ne 'NUANJIAN-CASE-001')) {
  throw 'The input is not the supported CASE-001 schema version, or generic mode was not enabled.'
}
if ([string]::IsNullOrWhiteSpace($recommendedDraftId)) {
  throw 'recommendedDraftId must not be empty.'
}
$recommendedDrafts = @($drafts | Where-Object { [string](Get-RequiredProperty -Object $_ -Name 'id') -ceq $recommendedDraftId })
if ($recommendedDrafts.Count -ne 1) {
  throw "recommendedDraftId must select exactly one reviewed draft; matched $($recommendedDrafts.Count)."
}
$recommendedDraft = $recommendedDrafts[0]
$draftName = [string](Get-RequiredProperty -Object $recommendedDraft -Name 'name')
$body = [string](Get-RequiredProperty -Object $recommendedDraft -Name 'body')
$normalizedBody = ($body -replace "`r`n", "`n" -replace "`r", "`n").Trim()
if ([string]::IsNullOrWhiteSpace($normalizedBody) -or $normalizedBody.Contains([char]0)) {
  throw 'The recommended reviewed body is empty or contains a null character.'
}
$bodyBlocks = @([System.Text.RegularExpressions.Regex]::Split($normalizedBody, "`n[ `t]*`n+") | ForEach-Object { $_.Trim() })
if ($bodyBlocks.Count -lt 3 -or $bodyBlocks | Where-Object { [string]::IsNullOrWhiteSpace($_) }) {
  throw 'The recommended body must contain a greeting, at least one paragraph, and a signature separated by blank lines.'
}
$greeting = $bodyBlocks[0]
$paragraphs = @($bodyBlocks[1..($bodyBlocks.Count - 2)])
$signature = $bodyBlocks[$bodyBlocks.Count - 1]
if (-not $AllowNonColonGreeting -and $greeting -notmatch '[:：]$') {
  throw 'The first reviewed body block must be a greeting ending in a colon.'
}
if ($signature.Length -gt 40) {
  throw 'The final reviewed body block is too long to be treated as a signature.'
}

$photoPath = Resolve-ControlledRelativeFile -Root $inputRootFull -RelativeUrl $photoUrl
$photoHashBefore = Get-LowerSha256 -LiteralPath $photoPath
$expectedPhotoHash = [string](Get-RequiredProperty -Object $photoCrop -Name 'derivativeSha256')
if ($photoHashBefore -cne $expectedPhotoHash.ToLowerInvariant()) {
  throw 'The physical crop SHA-256 does not match demo-case.json.'
}

Add-Type -AssemblyName System.Drawing
$displayFamilyName = Resolve-FontFamilyName -Candidates @('KaiTi', 'STKaiti', '楷体', 'Microsoft YaHei') -Fallback ([System.Drawing.FontFamily]::GenericSerif.Name)
$uiFamilyName = Resolve-FontFamilyName -Candidates @('Microsoft YaHei', 'PingFang SC', 'Segoe UI') -Fallback ([System.Drawing.FontFamily]::GenericSansSerif.Name)

$measurementBitmap = [System.Drawing.Bitmap]::new(1, 1, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$measurementGraphics = [System.Drawing.Graphics]::FromImage($measurementBitmap)
$photo = $null
$brandFont = $null
$titleFont = $null
$disclosureFont = $null
$captionFont = $null
$bodyFont = $null
$footerFont = $null
$nearFormat = $null
$centerFormat = $null
$farFormat = $null
$temporaryPng = $null
$temporaryManifest = $null
try {
  $measurementGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $brandFont = [System.Drawing.Font]::new($uiFamilyName, 29, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $titleFont = [System.Drawing.Font]::new($displayFamilyName, 61, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $disclosureFont = [System.Drawing.Font]::new($uiFamilyName, 25, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $captionFont = [System.Drawing.Font]::new($uiFamilyName, 25, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $bodyFont = [System.Drawing.Font]::new($displayFamilyName, 43, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $footerFont = [System.Drawing.Font]::new($uiFamilyName, 23, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $nearFormat = New-TextFormat
  $centerFormat = New-TextFormat -Alignment ([System.Drawing.StringAlignment]::Center)
  $farFormat = New-TextFormat -Alignment ([System.Drawing.StringAlignment]::Far)

  $titleLines = @(Get-WrappedLines -Graphics $measurementGraphics -Text $title -Font $titleFont -MaximumWidth 880 -Format $nearFormat)
  $disclosureLines = @(Get-WrappedLines -Graphics $measurementGraphics -Text $requiredDisclosure -Font $disclosureFont -MaximumWidth 820 -Format $nearFormat)
  $greetingLines = @(Get-WrappedLines -Graphics $measurementGraphics -Text $greeting -Font $bodyFont -MaximumWidth 816 -Format $nearFormat)
  $paragraphLineGroups = @($paragraphs | ForEach-Object {
    ,@(Get-WrappedLines -Graphics $measurementGraphics -Text $_ -Font $bodyFont -MaximumWidth 816 -Format $nearFormat)
  })
  $signatureLines = @(Get-WrappedLines -Graphics $measurementGraphics -Text $signature -Font $bodyFont -MaximumWidth 816 -Format $nearFormat)

  $photo = [System.Drawing.Image]::FromFile($photoPath)
  $expectedPhotoWidth = [int](Get-RequiredProperty -Object $photoCrop -Name 'width')
  $expectedPhotoHeight = [int](Get-RequiredProperty -Object $photoCrop -Name 'height')
  if ($photo.Width -ne $expectedPhotoWidth -or $photo.Height -ne $expectedPhotoHeight) {
    throw "The physical crop dimensions do not match demo-case.json: expected ${expectedPhotoWidth}x${expectedPhotoHeight}; received $($photo.Width)x$($photo.Height)."
  }

  $contentX = 108
  $contentWidth = 864
  $bodyX = 132
  $bodyWidth = 816
  $photoWidth = 840
  $photoHeight = [int][Math]::Round($photo.Height * ($photoWidth / [double]$photo.Width))
  $photoX = [int](($canvasWidth - $photoWidth) / 2)
  $titleLineHeight = 82
  $disclosureLineHeight = 38
  $bodyLineHeight = 72
  $signatureLineHeight = 72

  $y = 72
  $brandY = $y
  $y += 52
  $topRuleY = $y
  $y += 51
  $titleY = $y
  $y += ($titleLines.Count * $titleLineHeight) + 35
  $disclosureY = $y
  $disclosureHeight = ($disclosureLines.Count * $disclosureLineHeight) + 38
  $y += $disclosureHeight + 52
  $photoY = $y
  $y += $photoHeight + 18
  $captionY = $y
  $y += 42 + 65
  $bodyRuleY = $y
  $y += 57
  $greetingY = $y
  $y += ($greetingLines.Count * $bodyLineHeight) + 38
  $paragraphLayouts = [System.Collections.Generic.List[object]]::new()
  for ($index = 0; $index -lt $paragraphLineGroups.Count; $index += 1) {
    $lines = @($paragraphLineGroups[$index])
    $paragraphLayouts.Add([pscustomobject]@{ y = $y; lines = $lines })
    $y += ($lines.Count * $bodyLineHeight) + 42
  }
  $signatureY = $y + 10
  $y = $signatureY + ($signatureLines.Count * $signatureLineHeight) + 74
  $footerRuleY = $y
  $footerY = $y + 35
  $canvasHeight = [int]($footerY + 64)
  if ($canvasHeight -le 0 -or $canvasHeight -gt $maximumCanvasHeight) {
    throw "The calculated long-image height $canvasHeight is outside the supported range (1-$maximumCanvasHeight)."
  }

  $exportsRoot = Join-Path $inputRootFull 'exports'
  New-Item -ItemType Directory -Force -Path $exportsRoot | Out-Null
  Assert-NoReparsePoint -LiteralPath $exportsRoot
  $outputPath = Join-Path $exportsRoot $OutputName
  $manifestName = [System.IO.Path]::GetFileNameWithoutExtension($OutputName) + '.manifest.json'
  $manifestPath = Join-Path $exportsRoot $manifestName
  $operationId = [System.Guid]::NewGuid().ToString('N')
  $temporaryPng = Join-Path $exportsRoot ".$OutputName.$operationId.tmp"
  $temporaryManifest = Join-Path $exportsRoot ".$manifestName.$operationId.tmp"

  $canvas = [System.Drawing.Bitmap]::new($canvasWidth, $canvasHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    $canvas.SetResolution(96, 96)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    $inkBrush = $null
    $sageBrush = $null
    $wineBrush = $null
    $mutedBrush = $null
    $paperBrush = $null
    $whiteBrush = $null
    $linePen = $null
    $winePen = $null
    try {
      $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml($paperColor))
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

      $inkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($inkColor))
      $sageBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($sageColor))
      $wineBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($wineColor))
      $mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($mutedColor))
      $paperBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($paperColor))
      $whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
      $linePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($lineColor), 2)
      $winePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($wineColor), 5)

      $graphics.DrawString('暖笺', $brandFont, $sageBrush, [System.Drawing.RectangleF]::new($contentX, $brandY, 300, 45), $nearFormat)
      $graphics.DrawString($HeaderLabel, $footerFont, $mutedBrush, [System.Drawing.RectangleF]::new($contentX, $brandY + 6, $contentWidth, 40), $farFormat)
      $graphics.DrawLine($linePen, $contentX, $topRuleY, $contentX + $contentWidth, $topRuleY)

      [void](Draw-Lines -Graphics $graphics -Lines $titleLines -Font $titleFont -Brush $inkBrush -X $contentX -Y $titleY -Width $contentWidth -LineHeight $titleLineHeight -Format $centerFormat)
      $graphics.FillRectangle($sageBrush, $contentX, $disclosureY, $contentWidth, $disclosureHeight)
      [void](Draw-Lines -Graphics $graphics -Lines $disclosureLines -Font $disclosureFont -Brush $whiteBrush -X ($contentX + 22) -Y ($disclosureY + 19) -Width ($contentWidth - 44) -LineHeight $disclosureLineHeight -Format $centerFormat)

      $photoRectangle = [System.Drawing.Rectangle]::new($photoX, $photoY, $photoWidth, $photoHeight)
      $graphics.DrawImage($photo, $photoRectangle)
      $graphics.DrawRectangle($linePen, $photoRectangle)
      $graphics.DrawString($PhotoCaption, $captionFont, $mutedBrush, [System.Drawing.RectangleF]::new($photoX, $captionY, $photoWidth, 38), $centerFormat)

      $graphics.DrawLine($linePen, $contentX, $bodyRuleY, $contentX + $contentWidth, $bodyRuleY)
      [void](Draw-Lines -Graphics $graphics -Lines $greetingLines -Font $bodyFont -Brush $inkBrush -X $bodyX -Y $greetingY -Width $bodyWidth -LineHeight $bodyLineHeight -Format $nearFormat)
      foreach ($layout in $paragraphLayouts) {
        $lineCount = @($layout.lines).Count
        $railBottom = [float]$layout.y + ($lineCount * $bodyLineHeight) - 17
        $graphics.DrawLine($winePen, $bodyX - 24, [float]$layout.y + 8, $bodyX - 24, $railBottom)
        [void](Draw-Lines -Graphics $graphics -Lines @($layout.lines) -Font $bodyFont -Brush $inkBrush -X $bodyX -Y ([float]$layout.y) -Width $bodyWidth -LineHeight $bodyLineHeight -Format $nearFormat)
      }
      [void](Draw-Lines -Graphics $graphics -Lines $signatureLines -Font $bodyFont -Brush $wineBrush -X $bodyX -Y $signatureY -Width $bodyWidth -LineHeight $signatureLineHeight -Format $farFormat)

      $graphics.DrawLine($linePen, $contentX, $footerRuleY, $contentX + $contentWidth, $footerRuleY)
      $footerText = "$draftName · 内容来自 recommendedDraftId=$recommendedDraftId"
      $graphics.DrawString($footerText, $footerFont, $mutedBrush, [System.Drawing.RectangleF]::new($contentX, $footerY, $contentWidth, 38), $centerFormat)
    } finally {
      foreach ($resource in @($inkBrush, $sageBrush, $wineBrush, $mutedBrush, $paperBrush, $whiteBrush, $linePen, $winePen)) {
        if ($null -ne $resource) { $resource.Dispose() }
      }
      $graphics.Dispose()
    }

    $canvas.Save($temporaryPng, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $canvas.Dispose()
  }

  $verificationBitmap = [System.Drawing.Bitmap]::new($temporaryPng)
  try {
    if ($verificationBitmap.Width -ne $canvasWidth -or $verificationBitmap.Height -ne $canvasHeight) {
      throw "Generated PNG dimensions are incorrect: $($verificationBitmap.Width)x$($verificationBitmap.Height)."
    }
    $pixelEvidence = Get-PixelEvidence -Bitmap $verificationBitmap -Background ([System.Drawing.ColorTranslator]::FromHtml($paperColor))
  } finally {
    $verificationBitmap.Dispose()
  }

  $pngBytes = [System.IO.File]::ReadAllBytes($temporaryPng)
  $pngAsAscii = [System.Text.Encoding]::ASCII.GetString($pngBytes)
  foreach ($sentinel in @('http://', 'https://', 'mediaToken', 'shareToken', 'authorization', 'sk-', 'case-001-photo-crop.jpg')) {
    if ($pngAsAscii.IndexOf($sentinel, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      throw "Generated PNG unexpectedly contains a credential/path sentinel: $sentinel"
    }
  }

  if ((Get-LowerSha256 -LiteralPath $casePath) -cne $caseHashBefore) {
    throw 'demo-case.json changed while the long image was being generated.'
  }
  if ((Get-LowerSha256 -LiteralPath $photoPath) -cne $photoHashBefore) {
    throw 'The physical crop changed while the long image was being generated.'
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    packageKind = $PackageKind
    caseId = $caseId
    recommendedDraftId = $recommendedDraftId
    draftName = $draftName
    draftBodySha256 = Get-TextSha256 -Value $normalizedBody
    bodyStructure = [ordered]@{
      greetingIncluded = $true
      paragraphCount = $paragraphs.Count
      signatureIncluded = $true
    }
    disclosure = $requiredDisclosure
    sourcePhoto = [ordered]@{
      sha256 = $photoHashBefore
      width = $photo.Width
      height = $photo.Height
    }
    output = [ordered]@{
      fileName = $OutputName
      mediaType = 'image/png'
      bytes = $pngBytes.Length
      sha256 = Get-LowerSha256 -LiteralPath $temporaryPng
      width = $canvasWidth
      height = $canvasHeight
      pixelEvidence = $pixelEvidence
    }
    typography = [ordered]@{
      displayFamily = $bodyFont.FontFamily.Name
      uiFamily = $footerFont.FontFamily.Name
    }
    controls = [ordered]@{
      inputRestrictedToDTemp = $true
      bodyReadFromRecommendedDraft = $true
      physicalCropUsedWithoutAdditionalCropping = $true
      sourceFilesUnchanged = $true
      absolutePathsIncluded = $false
      credentialsIncluded = $false
    }
  }
  $manifestJson = ($manifest | ConvertTo-Json -Depth 10) + "`n"
  Assert-SafeGeneratedManifest -Json $manifestJson
  [System.IO.File]::WriteAllText($temporaryManifest, $manifestJson, $utf8WithoutBom)

  Move-Item -LiteralPath $temporaryPng -Destination $outputPath -Force
  Move-Item -LiteralPath $temporaryManifest -Destination $manifestPath -Force

  Write-Host "Created long image: $outputPath"
  Write-Host "Created verification manifest: $manifestPath"
  Write-Host "PNG dimensions: ${canvasWidth}x${canvasHeight}"
  Write-Host "PNG SHA-256: $($manifest.output.sha256)"
  Write-Host "Recommended draft, disclosure, source integrity, pixel, URL/token, and read-only checks: PASS"
} finally {
  foreach ($temporaryFile in @($temporaryPng, $temporaryManifest)) {
    if (-not [string]::IsNullOrWhiteSpace($temporaryFile) -and (Test-Path -LiteralPath $temporaryFile -PathType Leaf)) {
      Remove-Item -LiteralPath $temporaryFile -Force
    }
  }
  foreach ($resource in @($brandFont, $titleFont, $disclosureFont, $captionFont, $bodyFont, $footerFont, $nearFormat, $centerFormat, $farFormat, $photo)) {
    if ($null -ne $resource) { $resource.Dispose() }
  }
  $measurementGraphics.Dispose()
  $measurementBitmap.Dispose()
}
