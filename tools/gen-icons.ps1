# 生成插件图标：圆形渐变背景 + 白色下载箭头（避免 GDI+ 浮点重载问题）
Add-Type -AssemblyName System.Drawing

function New-Pt([double]$x, [double]$y) {
    return New-Object System.Drawing.PointF([float]$x, [float]$y)
}

function New-VideoIcon([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # 背景：圆形（深蓝到青色渐变）
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 30, 90, 220),
        [System.Drawing.Color]::FromArgb(255, 20, 170, 160),
        [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
    $g.FillEllipse($brush, $rect)

    $u = $size / 100.0
    $white = [System.Drawing.Brushes]::White

    # 下载箭头：竖杆（占中上部）
    $barW = 14 * $u
    $barX = 50 * $u - $barW / 2
    $barRect = New-Object System.Drawing.RectangleF([float]$barX, [float](18 * $u), [float]$barW, [float](30 * $u))
    $g.FillRectangle($white, $barRect)

    # 箭头三角头
    $triPts = [System.Drawing.PointF[]]@(
        (New-Pt (27 * $u) (46 * $u)),
        (New-Pt (73 * $u) (46 * $u)),
        (New-Pt (50 * $u) (72 * $u))
    )
    $g.FillPolygon($white, $triPts)

    # 底部托盘线
    $penW = [Math]::Max(1.5, 9 * $u)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]$penW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, (New-Pt (25 * $u) (84 * $u)), (New-Pt (75 * $u) (84 * $u)))

    $g.Dispose()
    $outDir = Split-Path $outPath -Parent
    if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "saved: $outPath"
}

$root = "d:\SourceCode\T002\brower-video-down-plugin"
New-VideoIcon 16  "$root\icons\icon16.png"
New-VideoIcon 48  "$root\icons\icon48.png"
New-VideoIcon 128 "$root\icons\icon128.png"
