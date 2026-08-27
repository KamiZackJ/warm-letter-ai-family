[CmdletBinding()]
param(
  [string]$MediaDirectory,
  [int]$Port = 4173,
  [switch]$ForceSynthetic
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repositoryRoot 'apps\web'
$tmpRoot = if ($env:WARM_LETTER_TMP_DIR) { $env:WARM_LETTER_TMP_DIR } else { 'D:\tmp\warm-letter-ai-family' }

$expectedPhotoHash = 'e09c8091a6676398d81ba40cd28d11c2f598e846748cfe2a069a09666ee6706b'
$expectedAudioHash = 'f9ec48c022bc98d9cc5ac3ff061c65108fe4827ccd8aac9ef1aca15ff88ea4dc'
$expectedDemoCaseHashes = @(
  '15486a762c5531fbd5ba51177f9dd66ddc1731c4fafc48bb29c2dfd629409e36'
  '179a804a6e68b933162471c44ebd633faea0420cb03b44437cebf3149ab9962e'
)

if (-not (Test-Path -LiteralPath $webRoot -PathType Container)) {
  throw "找不到 Web 应用目录：$webRoot"
}

# Prefer the locally verified teammate package so the default team demo does
# not silently show the synthetic cooking/voice assets.
$candidateDirectories = if (-not [string]::IsNullOrWhiteSpace($MediaDirectory)) {
  @($MediaDirectory)
} else {
  @(
    'D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28\media',
    'D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-08-28-r2\media',
    'D:\tmp\warm-letter-ai-family\team-materials-current\media'
  )
}

$selectedMediaDirectory = $null
if (-not $ForceSynthetic) {
  foreach ($candidate in $candidateDirectories) {
    $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate)
    $photo = Join-Path $resolvedCandidate 'case-001-photo-crop.jpg'
    $audio = Join-Path $resolvedCandidate 'case-001-audio.m4a'
    $caseData = Join-Path (Split-Path -Parent $resolvedCandidate) 'demo-case.json'
    if (
      (Test-Path -LiteralPath $resolvedCandidate -PathType Container) -and
      (Test-Path -LiteralPath $photo -PathType Leaf) -and
      (Test-Path -LiteralPath $audio -PathType Leaf) -and
      (Test-Path -LiteralPath $caseData -PathType Leaf)
    ) {
      $photoHash = (Get-FileHash -LiteralPath $photo -Algorithm SHA256).Hash.ToLowerInvariant()
      $audioHash = (Get-FileHash -LiteralPath $audio -Algorithm SHA256).Hash.ToLowerInvariant()
      $caseDataHash = (Get-FileHash -LiteralPath $caseData -Algorithm SHA256).Hash.ToLowerInvariant()
      if (
        $photoHash -eq $expectedPhotoHash -and
        $audioHash -eq $expectedAudioHash -and
        $expectedDemoCaseHashes -contains $caseDataHash
      ) {
        $selectedMediaDirectory = $resolvedCandidate
        break
      }
    }
  }
}

$env:VITE_APP_ENV = 'demo'
$env:VITE_DEMO_ENABLED = 'true'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:8787/v1'
$env:WARM_LETTER_TMP_DIR = [System.IO.Path]::GetFullPath($tmpRoot)
$env:TEMP = $env:WARM_LETTER_TMP_DIR
$env:TMP = $env:WARM_LETTER_TMP_DIR
New-Item -ItemType Directory -Force -Path $env:WARM_LETTER_TMP_DIR | Out-Null

if ($null -ne $selectedMediaDirectory) {
  $env:VITE_DEMO_CASE = 'case-001'
  $env:WARM_LETTER_CASE_001_MEDIA_DIR = $selectedMediaDirectory
  Write-Host "启动暖笺受控团队演示：http://127.0.0.1:$Port/"
  Write-Host "队友媒体：$selectedMediaDirectory"
  Write-Host '启动时会校验受控照片、原始 m4a 和固定审核稿 SHA-256。'
} else {
  $env:VITE_DEMO_CASE = 'synthetic'
  Remove-Item Env:WARM_LETTER_CASE_001_MEDIA_DIR -ErrorAction SilentlyContinue
  Write-Host "未找到受控 CASE-001 包，启动脱敏演示：http://127.0.0.1:$Port/"
  Write-Host '页面会明确标注未加载队友真实媒体；拿到受控包后可传入 -MediaDirectory 重新启动。'
}

Push-Location $webRoot
try {
  & pnpm exec vite --host 127.0.0.1 --mode demo --port $Port
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
