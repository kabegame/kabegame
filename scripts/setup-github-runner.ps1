# GitHub Actions Runner 设置脚本
# 用于在本地 Windows 机器上设置 self-hosted runner

param(
    [string]$RepoUrl = "",
    [string]$Token = "",
    [string]$RunnerName = "local-windows-runner"
)

# 设置 PowerShell 编码为 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$ErrorActionPreference = "Stop"

Write-Host "🚀 GitHub Actions Runner 设置脚本" -ForegroundColor Cyan
Write-Host ""

# 检查参数
if ([string]::IsNullOrWhiteSpace($RepoUrl) -or [string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "📋 使用说明:" -ForegroundColor Yellow
    Write-Host "  1. 访问 GitHub 仓库 -> Settings -> Actions -> Runners -> New self-hosted runner" -ForegroundColor White
    Write-Host "  2. 选择 Windows 和 x64"
    Write-Host "  3. 复制显示的配置命令中的 URL 和 TOKEN"
    Write-Host ""
    Write-Host "然后运行:" -ForegroundColor Yellow
    Write-Host "  .\scripts\setup-github-runner.ps1 -RepoUrl 'https://github.com/YOUR_USERNAME/YOUR_REPO' -Token 'YOUR_TOKEN'" -ForegroundColor Green
    Write-Host ""
    
    $RepoUrl = Read-Host "请输入仓库 URL (例如: https://github.com/username/repo)"
    $Token = Read-Host "请输入 Token"
}

if ([string]::IsNullOrWhiteSpace($RepoUrl) -or [string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "❌ URL 和 Token 不能为空" -ForegroundColor Red
    exit 1
}

# 创建 runner 目录
$RunnerDir = Join-Path $PSScriptRoot "..\actions-runner"
if (Test-Path $RunnerDir) {
    Write-Host "⚠️  Runner 目录已存在: $RunnerDir" -ForegroundColor Yellow
    $response = Read-Host "是否删除并重新安装? (y/n)"
    if ($response -eq "y" -or $response -eq "Y") {
        Remove-Item -Path $RunnerDir -Recurse -Force
        Write-Host "✅ 已删除旧目录" -ForegroundColor Green
    }
    else {
        Write-Host "ℹ️  使用现有目录" -ForegroundColor Blue
        Set-Location $RunnerDir
        Write-Host ""
        Write-Host "🔧 配置 runner..." -ForegroundColor Yellow
        .\config.cmd --url $RepoUrl --token $Token --name $RunnerName --unattended
        Write-Host ""
        Write-Host "✅ 配置完成！" -ForegroundColor Green
        Write-Host ""
        Write-Host "运行 runner:" -ForegroundColor Cyan
        Write-Host "  .\run.cmd" -ForegroundColor Green
        exit 0
    }
}

# 创建目录
New-Item -ItemType Directory -Path $RunnerDir -Force | Out-Null
Set-Location $RunnerDir

# 下载 runner
Write-Host "📥 下载 GitHub Actions Runner..." -ForegroundColor Yellow
$RunnerVersion = "2.315.0"  # 使用最新稳定版本，可以从 https://github.com/actions/runner/releases 获取
$DownloadUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip"
$ZipFile = "actions-runner-win-x64-$RunnerVersion.zip"

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ZipFile
    Write-Host "✅ 下载完成" -ForegroundColor Green
}
catch {
    Write-Host "❌ 下载失败: $_" -ForegroundColor Red
    Write-Host "💡 提示: 请手动从以下地址下载:" -ForegroundColor Yellow
    Write-Host "   https://github.com/actions/runner/releases/latest" -ForegroundColor White
    Write-Host "   选择 actions-runner-win-x64-*.zip" -ForegroundColor White
    exit 1
}

# 解压
Write-Host "📦 解压文件..." -ForegroundColor Yellow
Expand-Archive -Path $ZipFile -DestinationPath . -Force
Remove-Item $ZipFile
Write-Host "✅ 解压完成" -ForegroundColor Green

# 配置 runner
Write-Host "🔧 配置 runner..." -ForegroundColor Yellow
.\config.cmd --url $RepoUrl --token $Token --name $RunnerName --unattended

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ 配置完成！" -ForegroundColor Green
    Write-Host ""
    Write-Host "📝 下一步:" -ForegroundColor Cyan
    Write-Host "  1. 运行 runner: .\run.cmd" -ForegroundColor Green
    Write-Host "  2. 或者作为服务运行: .\svc.cmd install 然后 .\svc.cmd start" -ForegroundColor Green
    Write-Host ""
    Write-Host "💡 提示:" -ForegroundColor Yellow
    Write-Host "  - 运行 runner 后，可以在 GitHub 仓库的 Actions -> Runners 中看到它"
    Write-Host "  - 要测试 workflow，需要修改 workflow 文件中的 runs-on 为 'self-hosted'"
    Write-Host "  - 或者创建一个测试用的 workflow 文件"
}
else {
    Write-Host "❌ 配置失败" -ForegroundColor Red
    exit 1
}

