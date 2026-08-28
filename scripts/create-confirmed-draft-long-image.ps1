[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ConfirmedDraftPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PhotoPath,

  [ValidateNotNullOrEmpty()]
  [string]$OutputRoot = 'D:\tmp\warm-letter-ai-family\confirmed-draft-long-image',

  [ValidateNotNullOrEmpty()]
  [string]$OutputName = 'warm-letter-confirmed-draft.png'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$allowedInputRoot = [System.IO.Path]::GetFullPath('D:\tmp').TrimEnd('\') + '\'
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$utf8Strict = [System.Text.UTF8Encoding]::new($false, $true)
$packageKind = 'warm-letter-confirmed-draft-long-image'
$canvasWidth = 1080
$maximumCanvasHeight = 12000

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

function Assert-UnderDTemp {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $resolved = [System.IO.Path]::GetFullPath($LiteralPath)
  if (-not $resolved.StartsWith($allowedInputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a child path of D:\\tmp."
  }
  Assert-NoReparsePoint -LiteralPath $resolved
  return $resolved
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Content
  )

  [System.IO.File]::WriteAllText($LiteralPath, $Content, $utf8WithoutBom)
}

function Get-PropertyValue {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    throw "$Context is missing required property: $Name"
  }
  return $property.Value
}

function Get-OptionalPropertyValue {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Assert-AllowedProperties {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string[]]$Allowed,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $allowedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($name in $Allowed) { [void]$allowedSet.Add($name) }
  foreach ($property in $Object.PSObject.Properties) {
    if (-not $allowedSet.Contains($property.Name)) {
      throw "$Context contains an unsupported property: $($property.Name)"
    }
  }
}

function Get-ContractString {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$MaximumLength,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $value = Get-PropertyValue -Object $Object -Name $Name -Context $Context
  if ($value -isnot [string]) {
    throw "$Context.$Name must be a string."
  }
  if ($value.Contains([char]0)) {
    throw "$Context.$Name contains a null character."
  }
  $trimmed = $value.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.Length -gt $MaximumLength) {
    throw "$Context.$Name must contain 1-$MaximumLength non-whitespace characters."
  }
  return $trimmed
}

function Assert-ContractUuid {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $parsed = [Guid]::Empty
  if (-not [Guid]::TryParse($Value, [ref]$parsed)) {
    throw "$Context must be a UUID."
  }
}

function Assert-ContractTimestamp {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($Value -notmatch '(?i)(Z|[+-]\d{2}:\d{2})$') {
    throw "$Context must include an explicit UTC offset."
  }
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($Value, [ref]$parsed)) {
    throw "$Context must be an ISO timestamp."
  }
}

function Find-ConfirmedDraft {
  param([Parameter(Mandatory = $true)][object]$Root)

  $directProperties = @('version', 'title', 'greeting', 'paragraphs', 'closing', 'signature', 'provider', 'generatedAt')
  $hasDirectDraftShape = $true
  foreach ($name in $directProperties) {
    if ($null -eq $Root.PSObject.Properties[$name]) {
      $hasDirectDraftShape = $false
      break
    }
  }
  if ($hasDirectDraftShape) {
    return $Root
  }

  $confirmedDraft = Get-OptionalPropertyValue -Object $Root -Name 'confirmedDraft'
  if ($null -ne $confirmedDraft) {
    return $confirmedDraft
  }
  $letter = Get-OptionalPropertyValue -Object $Root -Name 'letter'
  if ($null -ne $letter) {
    $confirmedDraft = Get-OptionalPropertyValue -Object $letter -Name 'confirmedDraft'
    if ($null -ne $confirmedDraft) {
      return $confirmedDraft
    }
  }
  $data = Get-OptionalPropertyValue -Object $Root -Name 'data'
  if ($null -ne $data) {
    $dataLetter = Get-OptionalPropertyValue -Object $data -Name 'letter'
    if ($null -ne $dataLetter) {
      $confirmedDraft = Get-OptionalPropertyValue -Object $dataLetter -Name 'confirmedDraft'
      if ($null -ne $confirmedDraft) {
        return $confirmedDraft
      }
    }
  }
  throw 'Input JSON must be a LetterDraft, an object with confirmedDraft, or an API response containing letter.confirmedDraft.'
}

function Convert-AndValidateConfirmedDraft {
  param([Parameter(Mandatory = $true)][object]$Draft)

  Assert-AllowedProperties -Object $Draft -Allowed @('version', 'title', 'greeting', 'paragraphs', 'closing', 'signature', 'provider', 'generatedAt', 'aiDisclosure') -Context 'confirmedDraft'
  $versionValue = Get-PropertyValue -Object $Draft -Name 'version' -Context 'confirmedDraft'
  if ($versionValue -isnot [int] -and $versionValue -isnot [long] -and $versionValue -isnot [double]) {
    throw 'confirmedDraft.version must be a positive integer.'
  }
  $version = [int]$versionValue
  if ($version -le 0 -or [double]$versionValue -ne [double]$version) {
    throw 'confirmedDraft.version must be a positive integer.'
  }
  $title = Get-ContractString -Object $Draft -Name 'title' -MaximumLength 100 -Context 'confirmedDraft'
  $greeting = Get-ContractString -Object $Draft -Name 'greeting' -MaximumLength 500 -Context 'confirmedDraft'
  $closing = Get-ContractString -Object $Draft -Name 'closing' -MaximumLength 500 -Context 'confirmedDraft'
  $signature = Get-ContractString -Object $Draft -Name 'signature' -MaximumLength 30 -Context 'confirmedDraft'
  $provider = Get-ContractString -Object $Draft -Name 'provider' -MaximumLength 100 -Context 'confirmedDraft'
  $generatedAt = Get-ContractString -Object $Draft -Name 'generatedAt' -MaximumLength 80 -Context 'confirmedDraft'
  Assert-ContractTimestamp -Value $generatedAt -Context 'confirmedDraft.generatedAt'

  $paragraphsValue = @(Get-PropertyValue -Object $Draft -Name 'paragraphs' -Context 'confirmedDraft')
  if ($paragraphsValue -isnot [System.Collections.IEnumerable] -or $paragraphsValue -is [string]) {
    throw 'confirmedDraft.paragraphs must be an array.'
  }
  $paragraphs = @($paragraphsValue)
  if ($paragraphs.Count -lt 1 -or $paragraphs.Count -gt 30) {
    throw 'confirmedDraft.paragraphs must contain 1-30 items.'
  }
  $normalizedParagraphs = [System.Collections.Generic.List[object]]::new()
  foreach ($paragraph in $paragraphs) {
    Assert-AllowedProperties -Object $paragraph -Allowed @('id', 'text', 'sourceRefs', 'sourceAttribution') -Context 'confirmedDraft.paragraph'
    $id = Get-ContractString -Object $paragraph -Name 'id' -MaximumLength 100 -Context 'confirmedDraft.paragraph'
    Assert-ContractUuid -Value $id -Context 'confirmedDraft.paragraph.id'
    $text = Get-ContractString -Object $paragraph -Name 'text' -MaximumLength 4000 -Context 'confirmedDraft.paragraph'
    $sourceRefsValue = @(Get-PropertyValue -Object $paragraph -Name 'sourceRefs' -Context 'confirmedDraft.paragraph')
    if ($sourceRefsValue -isnot [System.Collections.IEnumerable] -or $sourceRefsValue -is [string]) {
      throw 'confirmedDraft.paragraph.sourceRefs must be an array.'
    }
    $sourceRefs = @($sourceRefsValue)
    if ($sourceRefs.Count -gt 30) {
      throw 'confirmedDraft.paragraph.sourceRefs must contain at most 30 items.'
    }
    $normalizedRefs = [System.Collections.Generic.List[string]]::new()
    foreach ($sourceRef in $sourceRefs) {
      if ($sourceRef -isnot [string]) {
        throw 'confirmedDraft.paragraph.sourceRefs items must be UUID strings.'
      }
      Assert-ContractUuid -Value $sourceRef -Context 'confirmedDraft.paragraph.sourceRefs'
      [void]$normalizedRefs.Add($sourceRef)
    }
    $sourceAttribution = Get-OptionalPropertyValue -Object $paragraph -Name 'sourceAttribution'
    if ($null -ne $sourceAttribution) {
      if ($sourceAttribution -isnot [string] -or @('ai', 'sources-confirmed', 'user-supplied', 'needs-review') -notcontains $sourceAttribution) {
        throw 'confirmedDraft.paragraph.sourceAttribution is invalid.'
      }
    }
    [void]$normalizedParagraphs.Add([ordered]@{
        id = $id
        text = $text
        sourceRefs = @($normalizedRefs)
        sourceAttribution = $sourceAttribution
      })
  }

  $aiDisclosureValue = Get-OptionalPropertyValue -Object $Draft -Name 'aiDisclosure'
  $normalizedAiDisclosure = $null
  if ($null -ne $aiDisclosureValue) {
    Assert-AllowedProperties -Object $aiDisclosureValue -Allowed @('isAiGenerated', 'label') -Context 'confirmedDraft.aiDisclosure'
    $isAiGenerated = Get-PropertyValue -Object $aiDisclosureValue -Name 'isAiGenerated' -Context 'confirmedDraft.aiDisclosure'
    if ($isAiGenerated -ne $true) {
      throw 'confirmedDraft.aiDisclosure.isAiGenerated must be true.'
    }
    $disclosureLabel = Get-ContractString -Object $aiDisclosureValue -Name 'label' -MaximumLength 80 -Context 'confirmedDraft.aiDisclosure'
    $normalizedAiDisclosure = [ordered]@{ isAiGenerated = $true; label = $disclosureLabel }
  }

  $normalized = [ordered]@{
    version = $version
    title = $title
    greeting = $greeting
    paragraphs = @($normalizedParagraphs)
    closing = $closing
    signature = $signature
    provider = $provider
    generatedAt = $generatedAt
  }
  if ($null -ne $normalizedAiDisclosure) {
    $normalized['aiDisclosure'] = $normalizedAiDisclosure
  }
  return $normalized
}

function Assert-NoUnsafeText {
  param(
    [Parameter(Mandatory = $true)][string]$Json,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $forbiddenPatterns = [ordered]@{
    'HTTP URL' = '(?i)https?://'
    'drive-qualified path' = '(?i)\b[a-z]:[\\/]'
    'share or media token field' = '(?i)(share|media)[ _-]?token'
    'authorization credential' = '(?i)authorization\s*[:=]|bearer\s+[a-z0-9._-]+'
    'OpenAI-style secret' = '(?i)\bsk-[a-z0-9_-]{8,}'
  }
  foreach ($entry in $forbiddenPatterns.GetEnumerator()) {
    if ($Json -match $entry.Value) {
      throw "$Context contains forbidden data: $($entry.Key)."
    }
  }
}

function Get-ImageDimensions {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  Add-Type -AssemblyName System.Drawing
  $image = $null
  try {
    $image = [System.Drawing.Image]::FromFile($LiteralPath)
    return [ordered]@{ width = $image.Width; height = $image.Height }
  } finally {
    if ($null -ne $image) { $image.Dispose() }
  }
}

function Assert-GeneratedPng {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  Add-Type -AssemblyName System.Drawing
  $bitmap = $null
  try {
    $bitmap = [System.Drawing.Bitmap]::new($LiteralPath)
    if ($bitmap.Width -ne $canvasWidth -or $bitmap.Height -le 0 -or $bitmap.Height -gt $maximumCanvasHeight) {
      throw "Generated PNG dimensions are invalid: $($bitmap.Width)x$($bitmap.Height)."
    }
    $sampleStep = 12
    $sampleCount = 0
    $nonBackgroundCount = 0
    $background = [System.Drawing.ColorTranslator]::FromHtml('#FBFAF7')
    for ($y = 0; $y -lt $bitmap.Height; $y += $sampleStep) {
      for ($x = 0; $x -lt $bitmap.Width; $x += $sampleStep) {
        $pixel = $bitmap.GetPixel($x, $y)
        $sampleCount += 1
        if ([Math]::Abs([int]$pixel.R - [int]$background.R) -gt 3 -or [Math]::Abs([int]$pixel.G - [int]$background.G) -gt 3 -or [Math]::Abs([int]$pixel.B - [int]$background.B) -gt 3) {
          $nonBackgroundCount += 1
        }
      }
    }
    if ($sampleCount -eq 0 -or $nonBackgroundCount -lt [Math]::Ceiling($sampleCount * 0.08)) {
      throw 'Generated PNG is blank or nearly blank.'
    }
  } finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
  }
  $actualSha256 = Get-LowerSha256 -LiteralPath $LiteralPath
  if ($actualSha256 -cne $ExpectedSha256) {
    throw 'Generated PNG SHA-256 changed after rendering.'
  }
  $pngAsAscii = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($LiteralPath))
  foreach ($sentinel in @('http://', 'https://', 'mediaToken', 'shareToken', 'authorization', 'sk-')) {
    if ($pngAsAscii.IndexOf($sentinel, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      throw "Generated PNG unexpectedly contains a credential/path sentinel: $sentinel"
    }
  }
}

$confirmedDraftFull = Assert-UnderDTemp -LiteralPath $ConfirmedDraftPath -Label 'ConfirmedDraftPath'
$photoFull = Assert-UnderDTemp -LiteralPath $PhotoPath -Label 'PhotoPath'
$outputRootFull = [System.IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
if (-not $outputRootFull.StartsWith($allowedInputRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputRoot must be a child path of D:\\tmp.'
}
if ([System.IO.Path]::GetFileName($OutputName) -ne $OutputName -or [System.IO.Path]::GetExtension($OutputName) -ine '.png') {
  throw 'OutputName must be a plain PNG filename without directory components.'
}
Assert-NoReparsePoint -LiteralPath ([System.IO.Path]::GetDirectoryName($outputRootFull))
if (-not (Test-Path -LiteralPath $confirmedDraftFull -PathType Leaf)) {
  throw "ConfirmedDraftPath is not an existing JSON file: $confirmedDraftFull"
}
if (-not (Test-Path -LiteralPath $photoFull -PathType Leaf)) {
  throw "PhotoPath is not an existing image file: $photoFull"
}

$confirmedDraftFileSha256 = Get-LowerSha256 -LiteralPath $confirmedDraftFull
$photoFileSha256Before = Get-LowerSha256 -LiteralPath $photoFull
try {
  $inputJson = [System.IO.File]::ReadAllText($confirmedDraftFull, $utf8Strict)
  # PowerShell 7 otherwise coerces ISO timestamps to DateTime and loses the
  # original contract string. Keep JSON scalar values as strings when the
  # runtime exposes the DateKind switch (Windows PowerShell simply skips it).
  $convertFromJsonParameters = @{}
  if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
    $convertFromJsonParameters.DateKind = 'String'
  }
  $inputObject = $inputJson | ConvertFrom-Json @convertFromJsonParameters
} catch {
  throw "ConfirmedDraftPath is not strict UTF-8 JSON: $($_.Exception.Message)"
}
$confirmedDraft = Convert-AndValidateConfirmedDraft -Draft (Find-ConfirmedDraft -Root $inputObject)
$confirmedDraftCanonicalJson = $confirmedDraft | ConvertTo-Json -Depth 20 -Compress
Assert-NoUnsafeText -Json $confirmedDraftCanonicalJson -Context 'confirmedDraft'
$confirmedDraftSha256 = Get-TextSha256 -Value $confirmedDraftCanonicalJson
$bodyParts = [System.Collections.Generic.List[string]]::new()
[void]$bodyParts.Add($confirmedDraft.greeting)
foreach ($paragraph in $confirmedDraft.paragraphs) { [void]$bodyParts.Add($paragraph.text) }
[void]$bodyParts.Add($confirmedDraft.closing)
[void]$bodyParts.Add($confirmedDraft.signature)
$body = [string]::Join("`n`n", $bodyParts)
$bodySha256 = Get-TextSha256 -Value $body

$imageDimensions = Get-ImageDimensions -LiteralPath $photoFull
$operationId = [System.Guid]::NewGuid().ToString('N')
$temporaryRoot = Join-Path 'D:\tmp\warm-letter-ai-family' ".confirmed-draft-render-$operationId"
$stageRoot = Join-Path 'D:\tmp\warm-letter-ai-family' ".confirmed-draft-output-$operationId"
$backupRoot = "$outputRootFull.backup-$operationId"
$temporaryRootCreated = $false
$stageRootCreated = $false
$backupRootCreated = $false
$installed = $false

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $temporaryRoot 'media') | Out-Null
  $temporaryRootCreated = $true
  Assert-NoReparsePoint -LiteralPath $temporaryRoot
  $temporaryPhotoPath = Join-Path $temporaryRoot 'media\confirmed-photo.jpg'
  Copy-Item -LiteralPath $photoFull -Destination $temporaryPhotoPath -Force
  $temporaryPhotoSha256 = Get-LowerSha256 -LiteralPath $temporaryPhotoPath
  if ($temporaryPhotoSha256 -cne $photoFileSha256Before) {
    throw 'Temporary photo copy SHA-256 does not match PhotoPath.'
  }

  $caseId = 'CONFIRMED-DRAFT-' + $confirmedDraftSha256.Substring(0, 12).ToUpperInvariant()
  $disclosure = if ($null -ne $confirmedDraft.aiDisclosure) {
    "AI 内容标注：$($confirmedDraft.aiDisclosure.label) / confirmedDraft / 由写信人确认"
  } else {
    'confirmedDraft / 由写信人确认'
  }
  $headerLabel = "confirmedDraft · v$($confirmedDraft.version)"
  $photoCaption = '确认版本配图 · 仅展示已授权图片'
  $caseObject = [ordered]@{
    schemaVersion = 1
    caseId = $caseId
    mode = 'confirmed-draft-render'
    provenanceLabel = '服务端 confirmedDraft / 由写信人确认'
    disclosure = $disclosure
    title = $confirmedDraft.title
    photoUrl = './media/confirmed-photo.jpg'
    photoCrop = [ordered]@{
      sourceWidth = $imageDimensions.width
      sourceHeight = $imageDimensions.height
      x = 0
      y = 0
      width = $imageDimensions.width
      height = $imageDimensions.height
      jpegQuality = 0
      derivativeSha256 = $temporaryPhotoSha256
    }
    drafts = @([ordered]@{
        id = 'confirmed'
        name = "confirmedDraft · v$($confirmedDraft.version)"
        label = '服务端确认版本'
        body = $body
      })
    recommendedDraftId = 'confirmed'
  }
  Write-Utf8NoBom -LiteralPath (Join-Path $temporaryRoot 'demo-case.json') -Content (($caseObject | ConvertTo-Json -Depth 20) + "`n")

  $renderer = Join-Path $PSScriptRoot 'create-case-001-long-image.ps1'
  if (-not (Test-Path -LiteralPath $renderer -PathType Leaf)) {
    throw "Shared renderer not found: $renderer"
  }
  & $renderer `
    -InputRoot $temporaryRoot `
    -OutputName $OutputName `
    -HeaderLabel $headerLabel `
    -Disclosure $disclosure `
    -PhotoCaption $photoCaption `
    -PackageKind $packageKind `
    -AllowAnyCaseId `
    -AllowNonColonGreeting

  $rendererPng = Join-Path $temporaryRoot "exports\$OutputName"
  $rendererManifestPath = Join-Path $temporaryRoot "exports\$([System.IO.Path]::GetFileNameWithoutExtension($OutputName)).manifest.json"
  if (-not (Test-Path -LiteralPath $rendererPng -PathType Leaf) -or -not (Test-Path -LiteralPath $rendererManifestPath -PathType Leaf)) {
    throw 'Shared renderer did not produce both the PNG and verification manifest.'
  }
  $rendererManifest = Get-Content -LiteralPath $rendererManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $pngSha256 = Get-LowerSha256 -LiteralPath $rendererPng
  Assert-GeneratedPng -LiteralPath $rendererPng -ExpectedSha256 $pngSha256

  $stageExports = Join-Path $stageRoot 'exports'
  New-Item -ItemType Directory -Force -Path $stageExports | Out-Null
  $stageRootCreated = $true
  Copy-Item -LiteralPath $rendererPng -Destination (Join-Path $stageExports $OutputName) -Force
  $outputManifestName = [System.IO.Path]::GetFileNameWithoutExtension($OutputName) + '.manifest.json'
  $outputManifestPath = Join-Path $stageExports $outputManifestName
  $manifest = [ordered]@{
    schemaVersion = 1
    packageKind = $packageKind
    caseId = $caseId
    confirmedDraft = [ordered]@{
      inputFileSha256 = $confirmedDraftFileSha256
      draftSha256 = $confirmedDraftSha256
      version = $confirmedDraft.version
      title = $confirmedDraft.title
      provider = $confirmedDraft.provider
      generatedAt = $confirmedDraft.generatedAt
      paragraphCount = @($confirmedDraft.paragraphs).Count
      closingIncluded = $true
      signature = $confirmedDraft.signature
      aiDisclosure = if ($null -ne $confirmedDraft.aiDisclosure) { $confirmedDraft.aiDisclosure.label } else { $null }
    }
    bodySha256 = $bodySha256
    sourcePhoto = [ordered]@{
      sha256 = $photoFileSha256Before
      width = $imageDimensions.width
      height = $imageDimensions.height
    }
    output = [ordered]@{
      fileName = $OutputName
      mediaType = 'image/png'
      bytes = (Get-Item -LiteralPath (Join-Path $stageExports $OutputName)).Length
      sha256 = Get-LowerSha256 -LiteralPath (Join-Path $stageExports $OutputName)
      width = [int]$rendererManifest.output.width
      height = [int]$rendererManifest.output.height
      pixelEvidence = $rendererManifest.output.pixelEvidence
    }
    controls = [ordered]@{
      inputRestrictedToDTemp = $true
      confirmedDraftValidatedAgainst = 'packages/contracts/src/models.ts:LetterDraftSchema'
      bodyReadFromConfirmedDraft = $true
      sourceFilesUnchanged = $true
      sourcePhotoEmbeddedInOutput = $true
      sourcePhotoAuthorizationRequired = $true
      absolutePathsIncluded = $false
      credentialsIncluded = $false
    }
  }
  $manifestJson = ($manifest | ConvertTo-Json -Depth 20) + "`n"
  Assert-NoUnsafeText -Json $manifestJson -Context 'generated manifest'
  Write-Utf8NoBom -LiteralPath $outputManifestPath -Content $manifestJson

  if ((Get-LowerSha256 -LiteralPath $confirmedDraftFull) -cne $confirmedDraftFileSha256) {
    throw 'ConfirmedDraftPath changed while rendering.'
  }
  if ((Get-LowerSha256 -LiteralPath $photoFull) -cne $photoFileSha256Before) {
    throw 'PhotoPath changed while rendering.'
  }
  $outputManifestForCheck = Get-Content -LiteralPath $outputManifestPath -Raw -Encoding UTF8
  Assert-NoUnsafeText -Json $outputManifestForCheck -Context 'generated manifest'

  if (Test-Path -LiteralPath $outputRootFull) {
    if (-not (Test-Path -LiteralPath $outputRootFull -PathType Container)) {
      throw 'OutputRoot exists but is not a directory.'
    }
    Assert-NoReparsePoint -LiteralPath $outputRootFull
    $existingManifestPath = Join-Path (Join-Path $outputRootFull 'exports') $outputManifestName
    if (-not (Test-Path -LiteralPath $existingManifestPath -PathType Leaf)) {
      throw 'Refusing to replace an existing directory without this renderer manifest.'
    }
    $existingManifest = Get-Content -LiteralPath $existingManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existingManifest.packageKind -ne $packageKind) {
      throw 'Refusing to replace an output directory owned by another renderer.'
    }
    Move-Item -LiteralPath $outputRootFull -Destination $backupRoot
    $backupRootCreated = $true
  }
  Move-Item -LiteralPath $stageRoot -Destination $outputRootFull
  $stageRootCreated = $false
  $installed = $true
  if ($backupRootCreated) {
    Remove-Item -LiteralPath $backupRoot -Recurse -Force
    $backupRootCreated = $false
  }

  $finalManifest = Get-Content -LiteralPath (Join-Path $outputRootFull "exports\$outputManifestName") -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "Created confirmedDraft long image: $(Join-Path $outputRootFull "exports\$OutputName")"
  Write-Host "Created verification manifest: $(Join-Path $outputRootFull "exports\$outputManifestName")"
  Write-Host "PNG dimensions: $($finalManifest.output.width)x$($finalManifest.output.height)"
  Write-Host "PNG SHA-256: $($finalManifest.output.sha256)"
  Write-Host 'confirmedDraft contract, source integrity, 1080px width, pixel, URL/token, relative-path, and read-only checks: PASS'
} catch {
  if ($installed -and (Test-Path -LiteralPath $outputRootFull)) {
    Remove-Item -LiteralPath $outputRootFull -Recurse -Force
    $installed = $false
  }
  if ($backupRootCreated -and (Test-Path -LiteralPath $backupRoot) -and -not (Test-Path -LiteralPath $outputRootFull)) {
    Move-Item -LiteralPath $backupRoot -Destination $outputRootFull
    $backupRootCreated = $false
  }
  throw
} finally {
  if ($stageRootCreated -and (Test-Path -LiteralPath $stageRoot)) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
  if ($backupRootCreated -and (Test-Path -LiteralPath $backupRoot) -and -not (Test-Path -LiteralPath $outputRootFull)) {
    Move-Item -LiteralPath $backupRoot -Destination $outputRootFull
  }
  if ($temporaryRootCreated -and (Test-Path -LiteralPath $temporaryRoot)) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
