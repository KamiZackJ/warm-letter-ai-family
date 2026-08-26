param(
  [string]$OutputRoot = 'D:\tmp\warm-letter-ai-family'
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$packageName = "暖笺_产品体验展示包_$stamp"
$stage = Join-Path $OutputRoot $packageName
$archive = Join-Path $OutputRoot "$packageName.zip"

New-Item -ItemType Directory -Force -Path (Join-Path $stage '产品演示') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'evidence\2026-08-15') | Out-Null

Copy-Item -Recurse -Force (Join-Path $repositoryRoot 'docs\product-demo\*') (Join-Path $stage '产品演示')
Copy-Item -Force (Join-Path $repositoryRoot 'docs\evidence\2026-08-15\h5-1440x900.png') (Join-Path $stage 'evidence\2026-08-15\h5-1440x900.png')

$entryHtml = @'
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="refresh" content="0; url=产品演示/index.html" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>暖笺 | 互动产品演示</title>
  </head>
  <body>
    <p>正在打开暖笺互动产品演示...</p>
    <p><a href="产品演示/index.html">如果没有自动打开，请点击这里</a></p>
  </body>
</html>
'@
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage '暖笺_互动产品演示.html'), $entryHtml, $utf8WithoutBom)

Compress-Archive -LiteralPath $stage -DestinationPath $archive -CompressionLevel Optimal

Write-Host "Created: $archive"
Get-FileHash -Algorithm SHA256 -LiteralPath $archive | Format-List Algorithm,Hash,Path
