[CmdletBinding()]
param(
  [string]$MediaDirectory = 'D:\tmp\warm-letter-ai-family\暖笺_CASE-001_受控团队成果包_2026-09-02-r3\media',
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $repositoryRoot 'apps\web'
$resolvedMediaDirectory = [System.IO.Path]::GetFullPath($MediaDirectory)

if (-not (Test-Path -LiteralPath $webRoot -PathType Container)) {
  throw "找不到 Web 应用目录：$webRoot"
}

if (-not (Test-Path -LiteralPath $resolvedMediaDirectory -PathType Container)) {
  throw "找不到 CASE-001 受控媒体目录：$resolvedMediaDirectory。请解压受控成果包，或用 -MediaDirectory 指定其 media 目录。"
}

$photoPath = Join-Path $resolvedMediaDirectory 'case-001-photo-crop.jpg'
$audioPath = Join-Path $resolvedMediaDirectory 'case-001-audio.m4a'
$caseDataPath = Join-Path (Split-Path -Parent $resolvedMediaDirectory) 'demo-case.json'
foreach ($requiredPath in @($photoPath, $audioPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "受控媒体目录缺少文件：$requiredPath"
  }
}
if (-not (Test-Path -LiteralPath $caseDataPath -PathType Leaf)) {
  throw "受控成果包缺少审核稿：$caseDataPath"
}

# 这些变量只注入本次 Vite 子进程；不会写入仓库或用户配置。
$env:VITE_APP_ENV = 'demo'
$env:VITE_DEMO_ENABLED = 'true'
$env:VITE_DEMO_CASE = 'case-001'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:8787/v1'
$env:WARM_LETTER_CASE_001_MEDIA_DIR = $resolvedMediaDirectory
$env:WARM_LETTER_TMP_DIR = if ($env:WARM_LETTER_TMP_DIR) { $env:WARM_LETTER_TMP_DIR } else { 'D:\tmp\warm-letter-ai-family' }
$env:TEMP = $env:WARM_LETTER_TMP_DIR
$env:TMP = $env:WARM_LETTER_TMP_DIR
New-Item -ItemType Directory -Force -Path $env:WARM_LETTER_TMP_DIR | Out-Null

Write-Host "启动暖笺 CASE-001 受控阅读页：http://127.0.0.1:$Port/"
Write-Host "媒体目录：$resolvedMediaDirectory"
Write-Host 'Vite 会在启动时校验受控照片、原始语音和 demo-case.json 审核稿的 SHA-256。'

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
