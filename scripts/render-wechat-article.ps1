param(
    [string]$ArticlePath = "",
    [string]$OutputDir = "",
    [switch]$NoCopyImages
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-Utf8File {
    param([Parameter(Mandatory = $true)] [string]$Path)

    $encoding = New-Object System.Text.UTF8Encoding($false)
    return [System.IO.File]::ReadAllText($Path, $encoding)
}

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [string]$Value
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Escape-Html {
    param([AllowNull()] [object]$Value)

    if ($null -eq $Value) {
        return ""
    }
    return [System.Net.WebUtility]::HtmlEncode([string]$Value)
}

function Escape-Attribute {
    param([AllowNull()] [object]$Value)

    if ($null -eq $Value) {
        return ""
    }
    return (Escape-Html $Value).Replace("'", "&#39;")
}

function Get-LatestArticlePath {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $root = Join-Path $repoRoot "ignore\wechat-daily-codex"
    $latest = Get-ChildItem -Path $root -Recurse -Filter article.json -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $latest) {
        throw "No article.json found under $root"
    }
    return $latest.FullName
}

function Get-AssetFileName {
    param(
        [Parameter(Mandatory = $true)] [object]$Image,
        [Parameter(Mandatory = $true)] [int]$Index
    )

    $ext = ".jpg"
    if ($Image.local_path) {
        $pathExt = [System.IO.Path]::GetExtension([string]$Image.local_path)
        if (-not [string]::IsNullOrWhiteSpace($pathExt)) {
            $ext = $pathExt
        }
    }
    return "{0:D2}-{1}{2}" -f $Index, $Image.id, $ext
}

function New-FileUri {
    param([Parameter(Mandatory = $true)] [string]$Path)

    return ([System.Uri]::new((Resolve-Path -LiteralPath $Path).Path)).AbsoluteUri
}

function Make-MarkdownImagePath {
    param(
        [Parameter(Mandatory = $true)] [object]$Image,
        [Parameter(Mandatory = $true)] [string]$ImageSrc
    )

    if ($ImageSrc -match "^[A-Za-z]:\\") {
        return (New-FileUri -Path $ImageSrc)
    }
    return $ImageSrc.Replace("\", "/")
}

if ([string]::IsNullOrWhiteSpace($ArticlePath)) {
    $ArticlePath = Get-LatestArticlePath
}

$articlePathResolved = (Resolve-Path -LiteralPath $ArticlePath).Path
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Split-Path -Parent $articlePathResolved
}
$outputDirResolved = (Resolve-Path -LiteralPath $OutputDir).Path

$article = Read-Utf8File -Path $articlePathResolved | ConvertFrom-Json -ErrorAction Stop

$assetsDir = Join-Path $outputDirResolved "assets"
if (-not $NoCopyImages) {
    New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
}

$images = @($article.selected_images)
$renderItems = New-Object System.Collections.Generic.List[object]
$uploadItems = New-Object System.Collections.Generic.List[object]

for ($i = 0; $i -lt $images.Count; $i++) {
    $image = $images[$i]
    $assetName = Get-AssetFileName -Image $image -Index ($i + 1)
    $localPath = if ($image.local_path) { [string]$image.local_path } else { "" }
    $imageSrc = $image.image_uri
    $copiedPath = $null
    $exists = $false

    if (-not [string]::IsNullOrWhiteSpace($localPath) -and (Test-Path -LiteralPath $localPath)) {
        $exists = $true
        if (-not $NoCopyImages) {
            $copiedPath = Join-Path $assetsDir $assetName
            Copy-Item -LiteralPath $localPath -Destination $copiedPath -Force
            $imageSrc = "assets/$assetName"
        } else {
            $imageSrc = New-FileUri -Path $localPath
        }
    }

    $renderItems.Add([ordered]@{
        image = $image
        index = $i + 1
        image_src = $imageSrc
        markdown_image_src = Make-MarkdownImagePath -Image $image -ImageSrc $imageSrc
        local_exists = $exists
        copied_path = $copiedPath
    }) | Out-Null

    $uploadItems.Add([ordered]@{
        id = [string]$image.id
        local_path = $localPath
        copied_path = $copiedPath
        exists = $exists
        caption = [string]$image.caption
        source_url = $image.source_url
        author = $image.author
        risk_level = [string]$image.risk_level
        risk_notes = @($image.risk_notes)
    }) | Out-Null
}

$markdown = New-Object System.Text.StringBuilder
[void]$markdown.AppendLine("# $($article.title)")
[void]$markdown.AppendLine()
[void]$markdown.AppendLine("> $($article.digest)")
[void]$markdown.AppendLine()
[void]$markdown.AppendLine([string]$article.opening)
[void]$markdown.AppendLine()

foreach ($item in $renderItems) {
    $image = $item.image
    [void]$markdown.AppendLine("![$($image.caption)]($($item.markdown_image_src))")
    [void]$markdown.AppendLine()
    [void]$markdown.AppendLine($image.caption)
    if ($image.author -or $image.source_url) {
        $sourceParts = @()
        if ($image.author) {
            $sourceParts += "Author: $($image.author)"
        }
        if ($image.source_url) {
            $sourceParts += "Source: $($image.source_url)"
        }
        [void]$markdown.AppendLine()
        [void]$markdown.AppendLine(($sourceParts -join " | "))
    }
    [void]$markdown.AppendLine()
}

[void]$markdown.AppendLine([string]$article.closing)

$markdownPath = Join-Path $outputDirResolved "article.draft.md"
Write-Utf8NoBomFile -Path $markdownPath -Value $markdown.ToString()

$bodySections = New-Object System.Text.StringBuilder
[void]$bodySections.AppendLine("<p>$(Escape-Html $article.opening)</p>")

foreach ($item in $renderItems) {
    $image = $item.image
    $riskClass = if ($image.risk_level -eq "ok") { "risk-ok" } else { "risk-review" }
    $riskText = Escape-Html $image.risk_level
    if (@($image.risk_notes).Count -gt 0) {
        $riskText = "$riskText - $(Escape-Html (@($image.risk_notes) -join '; '))"
    }
    [void]$bodySections.AppendLine("<section class='image-block'>")
    [void]$bodySections.AppendLine("  <img src='$(Escape-Attribute $item.image_src)' alt='$(Escape-Attribute $image.caption)' />")
    [void]$bodySections.AppendLine("  <p class='caption'>$(Escape-Html $image.caption)</p>")
    [void]$bodySections.AppendLine("  <p class='source'>Author: $(Escape-Html $image.author) | Source: $(Escape-Html $image.source_url)</p>")
    [void]$bodySections.AppendLine("  <p class='risk $riskClass'>Risk: $riskText</p>")
    [void]$bodySections.AppendLine("</section>")
}

[void]$bodySections.AppendLine("<p>$(Escape-Html $article.closing)</p>")

$riskItems = @($article.risk_summary) | ForEach-Object {
    "<li>$(Escape-Html $_)</li>"
}

$html = @"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>$(Escape-Html $article.title)</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f5f3; color: #222; }
    main { max-width: 720px; margin: 0 auto; background: #fff; min-height: 100vh; padding: 32px 22px 56px; box-sizing: border-box; }
    h1 { font-size: 28px; line-height: 1.32; margin: 0 0 12px; font-weight: 700; }
    .digest { color: #666; font-size: 15px; line-height: 1.7; margin: 0 0 24px; }
    p { font-size: 16px; line-height: 1.9; margin: 0 0 18px; }
    .meta { font-size: 13px; color: #777; border-top: 1px solid #eee; border-bottom: 1px solid #eee; padding: 12px 0; margin-bottom: 24px; }
    .image-block { margin: 28px 0 34px; }
    img { display: block; width: 100%; height: auto; border-radius: 6px; background: #eee; }
    .caption { margin: 12px 0 6px; color: #333; }
    .source { margin: 0 0 6px; font-size: 13px; color: #777; word-break: break-all; }
    .risk { margin: 0; font-size: 13px; }
    .risk-ok { color: #4f7d4a; }
    .risk-review { color: #a66600; }
    .review-box { margin-top: 36px; padding: 16px; background: #fff8e5; border: 1px solid #f0d28a; border-radius: 6px; }
    .review-box h2 { font-size: 16px; margin: 0 0 10px; }
    .review-box ul { margin: 0; padding-left: 20px; color: #6f5200; line-height: 1.7; }
  </style>
</head>
<body>
  <main>
    <h1>$(Escape-Html $article.title)</h1>
    <p class="digest">$(Escape-Html $article.digest)</p>
    <div class="meta">
      Date: $(Escape-Html $article.run_date)<br>
      Theme: $(Escape-Html $article.theme)<br>
      Status: $(Escape-Html $article.status), candidates: $(Escape-Html $article.candidate_count), usable: $(Escape-Html $article.usable_count)
    </div>
    $($bodySections.ToString())
    <aside class="review-box">
      <h2>Pre-publish review</h2>
      <ul>
        $($riskItems -join [Environment]::NewLine)
      </ul>
    </aside>
  </main>
</body>
</html>
"@

$previewPath = Join-Path $outputDirResolved "preview.html"
Write-Utf8NoBomFile -Path $previewPath -Value $html

$wechatBody = @"
<h1>$(Escape-Html $article.title)</h1>
<p>$(Escape-Html $article.opening)</p>
$($bodySections.ToString())
"@
$wechatHtmlPath = Join-Path $outputDirResolved "wechat-content.html"
Write-Utf8NoBomFile -Path $wechatHtmlPath -Value $wechatBody

$manifest = [ordered]@{
    title = [string]$article.title
    digest = [string]$article.digest
    run_date = [string]$article.run_date
    cover_image_id = [string]$article.cover_image_id
    article_json = $articlePathResolved
    preview_html = $previewPath
    draft_markdown = $markdownPath
    wechat_content_html = $wechatHtmlPath
    images = $uploadItems.ToArray()
}

$manifestPath = Join-Path $outputDirResolved "upload-manifest.json"
Write-Utf8NoBomFile -Path $manifestPath -Value ($manifest | ConvertTo-Json -Depth 32)

Write-Host "Rendered article draft:"
Write-Host "  Markdown: $markdownPath"
Write-Host "  Preview:  $previewPath"
Write-Host "  WeChat HTML body: $wechatHtmlPath"
Write-Host "  Upload manifest: $manifestPath"
