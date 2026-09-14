# 一键打包上架 zip：
# 生成仅包含运行所需文件的压缩包，用于提交 Edge / Chrome 商店
# 用法：powershell -ExecutionPolicy Bypass -File tools\package.ps1

$root = Split-Path $PSScriptRoot -Parent
$releaseDir = Join-Path $root 'release'
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

# 读取版本号命名产物（manifest.json 为 UTF-8 无 BOM，必须显式指定编码）
$manifestRaw = [IO.File]::ReadAllText((Join-Path $root 'manifest.json'), [Text.Encoding]::UTF8)
$manifest = $manifestRaw | ConvertFrom-Json
$zip = Join-Path $releaseDir ("video-sniffer-downloader-v{0}.zip" -f $manifest.version)

# 商店包只需运行文件；README/PRIVACY 一并放入（对商店无害，且自述完整）
$items = @('manifest.json', 'links.js', 'icons', 'background', 'content', 'popup', 'options', 'offscreen', 'README.md', 'PRIVACY.md')
$paths = $items | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }

Compress-Archive -Path $paths -DestinationPath $zip -Force
Write-Output "打包完成: $zip"
Write-Output "提交商店时直接上传该文件即可。"
