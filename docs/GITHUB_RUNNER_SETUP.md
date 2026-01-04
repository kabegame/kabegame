# GitHub Actions Runner 本地设置指南

本指南将帮助你在本地 Windows 机器上设置 GitHub Actions Runner，用于测试和调试 GitHub Actions workflows。

## 前置要求

- Windows 10/11 或 Windows Server
- 管理员权限（用于安装服务）
- Git（如果 workflow 需要 checkout 代码）
- 其他开发工具（Node.js、Rust 等，根据你的 workflow 需求）

## 快速开始

### 1. 获取 Runner Token

1. 访问你的 GitHub 仓库
2. 进入 **Settings** -> **Actions** -> **Runners**
3. 点击 **New self-hosted runner**
4. 选择 **Windows** 和 **x64**
5. 复制显示的配置命令中的 **URL** 和 **TOKEN**

### 2. 运行设置脚本

使用项目提供的 PowerShell 脚本自动设置：

```powershell
.\scripts\setup-github-runner.ps1 -RepoUrl "https://github.com/kabegame" -Token "AVD7LPYPVSJ2NP656ZX33FLJLHVQM"
```

或者交互式运行：

```powershell
.\scripts\setup-github-runner.ps1
```

脚本会自动：
- 下载最新版本的 GitHub Actions Runner
- 解压到 `actions-runner` 目录
- 配置 runner 连接到你的仓库

### 3. 运行 Runner

#### 方式一：前台运行（用于测试和调试）

```powershell
cd actions-runner
.\run.cmd
```

Runner 会一直运行，直到你按 `Ctrl+C` 停止。

#### 方式二：作为 Windows 服务运行（推荐用于持续运行）

```powershell
cd actions-runner

# 安装服务（需要管理员权限）
.\svc.cmd install

# 启动服务
.\svc.cmd start

# 查看服务状态
.\svc.cmd status

# 停止服务
.\svc.cmd stop

# 卸载服务
.\svc.cmd uninstall
```

## 测试 Workflow

### 使用测试 Workflow

项目包含一个测试用的 workflow 文件 `.github/workflows/test-local-runner.yml`，它使用 `self-hosted` runner。

触发方式：
1. 手动触发：在 GitHub 仓库的 Actions 标签页，选择 "Test Local Runner" workflow，点击 "Run workflow"
2. 自动触发：当该 workflow 文件被推送到 main 分支时

### 修改现有 Workflow 使用 Self-Hosted Runner

如果你想测试现有的 workflow（如 `release-windows.yml`），可以：

#### 选项 1：临时修改 workflow 文件

在 workflow 文件中将 `runs-on: windows-latest` 改为 `runs-on: self-hosted`

#### 选项 2：使用矩阵策略同时支持两种 runner

```yaml
strategy:
  matrix:
    runner: [self-hosted, windows-latest]
runs-on: ${{ matrix.runner }}
```

#### 选项 3：创建条件判断

```yaml
runs-on: ${{ github.event_name == 'workflow_dispatch' && github.event.inputs.use_local_runner == 'true' && 'self-hosted' || 'windows-latest' }}
```

## 注意事项

### 安全考虑

- **Self-hosted runner 具有完全访问权限**：可以访问仓库的代码和 secrets
- **只在可信的机器上运行**：不要在不安全的环境中运行
- **限制 runner 标签**：可以为 runner 添加标签，并在 workflow 中使用标签限制运行位置

### 性能考虑

- Self-hosted runner 使用本地资源，不会消耗 GitHub Actions 的免费额度
- 但会占用本地机器的 CPU、内存和磁盘空间
- 确保机器有足够的资源运行构建任务

### 环境差异

- Self-hosted runner 的环境可能与 GitHub-hosted runner 不同
- 某些预装的工具可能不存在，需要手动安装
- 建议在 workflow 中添加环境检查和工具安装步骤

## 常见问题

### Q: Runner 无法连接到 GitHub

**A**: 检查：
- 网络连接是否正常
- 防火墙是否阻止连接
- Token 是否过期（Token 通常有效期为 1 小时，需要重新获取）

### Q: 如何更新 Runner？

**A**: 
1. 停止 runner（`.\svc.cmd stop` 或按 `Ctrl+C`）
2. 删除 `actions-runner` 目录
3. 重新运行设置脚本

或者手动更新：
1. 下载新版本的 runner
2. 解压覆盖现有文件（保留 `config.cmd` 和 `.credentials` 文件）
3. 重启 runner

### Q: 如何移除 Runner？

**A**:
1. 在 GitHub 仓库的 Settings -> Actions -> Runners 中移除 runner
2. 如果作为服务运行，先卸载服务：`.\svc.cmd uninstall`
3. 删除 `actions-runner` 目录

### Q: Runner 显示为离线状态

**A**: 
- 确保 runner 正在运行（`.\run.cmd` 或服务已启动）
- 检查网络连接
- 查看 runner 日志文件 `_diag/Runner_*.log`

## 调试技巧

### 查看 Runner 日志

Runner 日志位于 `actions-runner/_diag/` 目录下：
- `Runner_*.log`: Runner 运行日志
- `Worker_*.log`: Job 执行日志

### 在 Workflow 中添加调试步骤

```yaml
- name: Debug environment
  run: |
    Write-Host "OS Version: $($PSVersionTable.OS)"
    Write-Host "Node version: $(node --version)"
    Write-Host "Rust version: $(cargo --version)"
    Get-ChildItem Env: | Sort-Object Name
```

### 测试单个步骤

可以创建一个简化的 workflow，只测试特定的步骤，而不是运行完整的构建流程。

## 相关链接

- [GitHub Actions Runner 官方文档](https://docs.github.com/en/actions/hosting-your-own-runners)
- [Runner 发布页面](https://github.com/actions/runner/releases)
- [Self-hosted runner 最佳实践](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners)


