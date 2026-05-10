param(
    [datetime]$Date = (Get-Date),
    [string]$BasePath = "hide/date",
    [string]$TargetPath = "",
    [int]$MinImages = 6,
    [int]$MaxImages = 10,
    [int]$PageSize = 40,
    [int]$MaxFallbackDays = 7,
    [string]$OutputRoot = "ignore\wechat-daily-codex",
    [string]$CodexCommand = "codex",
    [string]$Model = "",
    [switch]$SkipMcpCheck,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Join-ProviderPath {
    param([string[]]$Segments)

    return ($Segments |
        ForEach-Object { $_.Trim("/") } |
        Where-Object { $_ -ne "" }) -join "/"
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)] [object]$Value,
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $json = $Value | ConvertTo-Json -Depth 32
    Write-Utf8NoBomFile -Path $Path -Value $json
}

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory = $true)] [string]$Path,
        [Parameter(Mandatory = $true)] [string]$Value
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Read-Utf8File {
    param(
        [Parameter(Mandatory = $true)] [string]$Path
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    return [System.IO.File]::ReadAllText($Path, $encoding)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dateSegment = "{0:yyyy}y/{0:MM}m/{0:dd}d" -f $Date
if ([string]::IsNullOrWhiteSpace($TargetPath)) {
    $TargetPath = Join-ProviderPath @($BasePath, $dateSegment)
} else {
    $TargetPath = $TargetPath.Trim("/")
}

$runDate = "{0:yyyy-MM-dd}" -f $Date
$runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDir = Join-Path $repoRoot (Join-Path $OutputRoot "$runDate-$runStamp")
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$schemaPath = Join-Path $outputDir "daily-wechat.schema.json"
$promptPath = Join-Path $outputDir "daily-wechat.prompt.md"
$articlePath = Join-Path $outputDir "article.json"

$schemaObject = [ordered]@{
    '$schema' = "https://json-schema.org/draft/2020-12/schema"
    type = "object"
    additionalProperties = $false
    required = @(
        "status",
        "run_date",
        "target_path",
        "source_paths",
        "mcp_reads",
        "fallback_used",
        "fallback_reason",
        "candidate_count",
        "usable_count",
        "title",
        "digest",
        "theme",
        "cover_image_id",
        "opening",
        "selected_images",
        "closing",
        "risk_summary",
        "article_markdown",
        "error_message"
    )
    properties = [ordered]@{
        status = [ordered]@{
            type = "string"
            enum = @("ok", "insufficient_data", "mcp_error")
        }
        run_date = [ordered]@{ type = "string" }
        target_path = [ordered]@{ type = "string" }
        source_paths = [ordered]@{
            type = "array"
            items = [ordered]@{ type = "string" }
        }
        mcp_reads = [ordered]@{
            type = "array"
            items = [ordered]@{ type = "string" }
        }
        fallback_used = [ordered]@{ type = "boolean" }
        fallback_reason = [ordered]@{ type = @("string", "null") }
        candidate_count = [ordered]@{ type = "integer"; minimum = 0 }
        usable_count = [ordered]@{ type = "integer"; minimum = 0 }
        title = [ordered]@{ type = "string" }
        digest = [ordered]@{ type = "string" }
        theme = [ordered]@{ type = "string" }
        cover_image_id = [ordered]@{ type = @("string", "null") }
        opening = [ordered]@{ type = "string" }
        selected_images = [ordered]@{
            type = "array"
            minItems = 0
            maxItems = $MaxImages
            items = [ordered]@{
                type = "object"
                additionalProperties = $false
                required = @(
                    "id",
                    "image_uri",
                    "provider_path",
                    "display_name",
                    "plugin_id",
                    "local_path",
                    "metadata_summary",
                    "source_url",
                    "author",
                    "caption",
                    "selection_reason",
                    "risk_level",
                    "risk_notes"
                )
                properties = [ordered]@{
                    id = [ordered]@{ type = "string" }
                    image_uri = [ordered]@{ type = "string" }
                    provider_path = [ordered]@{ type = "string" }
                    display_name = [ordered]@{ type = @("string", "null") }
                    plugin_id = [ordered]@{ type = @("string", "null") }
                    local_path = [ordered]@{ type = @("string", "null") }
                    metadata_summary = [ordered]@{ type = "string" }
                    source_url = [ordered]@{ type = @("string", "null") }
                    author = [ordered]@{ type = @("string", "null") }
                    caption = [ordered]@{ type = "string" }
                    selection_reason = [ordered]@{ type = "string" }
                    risk_level = [ordered]@{
                        type = "string"
                        enum = @("ok", "review", "reject")
                    }
                    risk_notes = [ordered]@{
                        type = "array"
                        items = [ordered]@{ type = "string" }
                    }
                }
            }
        }
        closing = [ordered]@{ type = "string" }
        risk_summary = [ordered]@{
            type = "array"
            items = [ordered]@{ type = "string" }
        }
        article_markdown = [ordered]@{ type = "string" }
        error_message = [ordered]@{ type = @("string", "null") }
    }
}

Write-JsonFile -Value $schemaObject -Path $schemaPath

$prompt = @"
You are the daily editor for a WeChat Official Account that shares curated visual-asset/image posts from a local Kabegame gallery.

Use the configured Kabegame MCP server. Read only. Do not run shell commands, do not edit files, do not call WeChat APIs, and do not publish anything.

Your output must be valid JSON matching the provided schema. Do not wrap it in Markdown fences.

Run settings:
- run_date: $runDate
- target_path: $TargetPath
- minimum useful images: $MinImages
- maximum selected images: $MaxImages
- page size for MCP image reads: $PageSize
- maximum fallback date folders to scan: $MaxFallbackDays

Kabegame MCP provider rules:
- Use provider:// paths.
- The shorthand provider://hide/date/... maps to the gallery path /gallery/hide/date/... and excludes hidden images.
- To get image entries from a dated path, use an explicit paged image slice:
  provider://<path>/desc/x${PageSize}x/1/?without=children
- To inspect folders only, use:
  provider://<path>/?without=images
- Directory names are date segments such as 2026y, 05m, 09d. Sort them numerically, not lexicographically by the whole string.
- For selected images, read image://{id}/metadata to summarize source/author/tags when available.
- Do not request provider://plugin/*.

Workflow:
1. First read:
   provider://$TargetPath/desc/x${PageSize}x/1/?without=children
2. If this path has fewer than $MinImages usable images, discover the latest available date folders yourself:
   - read provider://$BasePath/?without=images for years
   - read provider://$BasePath/{year}/?without=images for months
   - read provider://$BasePath/{year}/{month}/?without=images for days
   - scan newest days first with provider://$BasePath/{year}/{month}/{day}/desc/x${PageSize}x/1/?without=children
   - stop once you have enough good candidates or after $MaxFallbackDays day folders
3. Prefer images that are local, exist locally, are type=image, have reasonable dimensions, and have usable source metadata.
4. Exclude or mark as reject/review anything that appears unsafe for a public WeChat post, has missing or suspicious source data, appears NSFW, or looks like it may involve minors.
5. Do not invent author names, source URLs, titles, or licensing. Use null when unknown.
6. Produce a concise Chinese article plan:
   - natural title, not clickbait
   - digest under 54 Chinese characters when possible
   - opening paragraph
   - one short caption per selected image
   - closing paragraph
   - article_markdown that can later be rendered into WeChat HTML
7. Include every MCP URI you read in mcp_reads. Include every dated provider image path that contributed candidates in source_paths.

If MCP access fails, output status="mcp_error" and put the error in error_message. If there are not enough acceptable images after fallback scanning, output status="insufficient_data", keep the usable selections, and explain the shortfall in fallback_reason.
"@

Write-Utf8NoBomFile -Path $promptPath -Value $prompt

Write-Host "Prompt: $promptPath"
Write-Host "Schema: $schemaPath"
Write-Host "Output: $articlePath"

if ($DryRun) {
    Write-Host "Dry run only. Codex was not invoked."
    exit 0
}

$codex = Get-Command $CodexCommand -ErrorAction Stop

if (-not $SkipMcpCheck) {
    $mcpInfo = & $codex.Source mcp get kabegame 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not confirm Codex MCP server 'kabegame'. Codex may fail to read Kabegame resources."
        Write-Warning ($mcpInfo -join [Environment]::NewLine)
    }
}

$codexArgs = @(
    "--ask-for-approval", "never",
    "exec",
    "-C", $repoRoot,
    "--sandbox", "read-only",
    "--ephemeral",
    "--color", "never",
    "--output-schema", $schemaPath,
    "-o", $articlePath
)

if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $codexArgs += @("-m", $Model)
}

$codexArgs += "-"

Get-Content -LiteralPath $promptPath -Raw | & $codex.Source @codexArgs
if ($LASTEXITCODE -ne 0) {
    throw "codex exec failed with exit code $LASTEXITCODE"
}

try {
    $article = Read-Utf8File -Path $articlePath | ConvertFrom-Json -ErrorAction Stop
} catch {
    $errorPath = Join-Path $outputDir "article.validation-error.txt"
    Write-Utf8NoBomFile -Path $errorPath -Value $_.Exception.Message
    throw "Codex wrote a non-JSON result to $articlePath. Parser details were saved to $errorPath"
}

$selectedCount = @($article.selected_images).Count
if ($article.status -eq "ok" -and $selectedCount -lt $MinImages) {
    Write-Warning "Codex returned status=ok but selected only $selectedCount images; expected at least $MinImages."
}

Write-Host "Codex article status: $($article.status)"
Write-Host "Selected images: $selectedCount"
Write-Host "Article JSON: $articlePath"
