# GitHub Actions Runner 使用指南

## 运行 run.cmd 后的步骤

当你运行 `.\run.cmd` 后，runner 会连接到 GitHub 服务器并保持运行状态。以下是具体的操作步骤：

## 1. 确认 Runner 已连接

运行 `run.cmd` 后，你应该看到类似以下的输出：

```
Connecting to GitHub...

Connected to GitHub

2024-01-01 12:00:00Z: Listening for Jobs
```

此时，runner 正在等待 GitHub Actions 的作业。

### 在 GitHub 上确认状态

1. 打开你的 GitHub 仓库页面
2. 进入 **Settings** -> **Actions** -> **Runners**
3. 你应该能看到你的 runner 显示为 **Idle**（空闲）状态，表示已连接并等待作业

## 2. 触发 Workflow 测试

### 方式一：使用测试 Workflow（推荐）

项目已经包含了测试用的 workflow 文件 `.github/workflows/test-local-runner.yml`。

**手动触发：**
1. 在 GitHub 仓库页面，点击 **Actions** 标签页
2. 在左侧工作流列表中选择 **"Test Local Runner"**
3. 点击 **"Run workflow"** 按钮
4. 选择分支（通常是 `main`）
5. 点击 **"Run workflow"** 确认

**自动触发：**
- 当你推送代码到 `main` 分支，并且修改了 `.github/workflows/test-local-runner.yml` 文件时，会自动触发

### 方式二：测试现有的 Workflow

如果你想测试现有的 workflow（如 `release-windows.yml`），需要临时修改它：

**临时修改 workflow 文件：**

```yaml
# 在 .github/workflows/release-windows.yml 中
jobs:
  build-and-release:
    name: Build Windows Installer
    runs-on: self-hosted  # 将 windows-latest 改为 self-hosted
```

⚠️ **注意：** 测试完后记得改回来，或者创建分支进行测试。

## 3. 查看运行状态

### 在 GitHub 上查看

1. 进入 **Actions** 标签页
2. 点击正在运行的 workflow
3. 点击对应的 job（如 "Test Self-Hosted Runner"）
4. 查看各个步骤的执行状态和日志

### 在本地终端查看

运行 `run.cmd` 的终端窗口会显示实时日志：

```
2024-01-01 12:00:00Z: Running job: test-runner
2024-01-01 12:00:01Z: Job test-runner completed with result: Succeeded
```

### 查看详细日志文件

Runner 的详细日志保存在 `actions-runner/_diag/` 目录下：

- `Runner_*.log` - Runner 连接和运行日志
- `Worker_*.log` - Job 执行详细日志

查看最新日志：
```powershell
Get-Content actions-runner\_diag\Runner_*.log -Tail 50
Get-Content actions-runner\_diag\Worker_*.log -Tail 50
```

## 4. 监控作业执行

当 workflow 被触发后：

1. **Runner 开始执行作业**
   - 终端会显示 "Running job: [job-name]"
   - GitHub Actions 页面显示作业状态为 "In progress"

2. **查看步骤执行**
   - 每个步骤的执行结果会实时显示在 GitHub Actions 页面
   - 可以展开每个步骤查看详细输出

3. **作业完成**
   - 成功：终端显示 "Job [job-name] completed with result: Succeeded"
   - 失败：显示 "Job [job-name] completed with result: Failed"，并显示错误信息

## 5. 停止 Runner

### 前台运行模式（run.cmd）

在运行 `run.cmd` 的终端窗口中：
- 按 `Ctrl+C` 停止 runner
- Runner 会优雅地关闭当前作业（如果有正在运行的）并断开连接

### 服务模式（svc.cmd）

如果 runner 作为 Windows 服务运行：

```powershell
cd actions-runner

# 停止服务
.\svc.cmd stop

# 查看服务状态
.\svc.cmd status

# 启动服务
.\svc.cmd start
```

## 6. 常见操作场景

### 场景 1：测试构建流程

```powershell
# 1. 确保 runner 正在运行
cd actions-runner
.\run.cmd

# 2. 在另一个终端或 GitHub 网页上触发 workflow

# 3. 观察终端输出和 GitHub Actions 页面

# 4. 测试完成后按 Ctrl+C 停止
```

### 场景 2：调试失败的步骤

1. 在 GitHub Actions 页面查看失败的步骤
2. 展开步骤查看错误日志
3. 如果需要，在本地手动运行相同的命令进行调试
4. 修复问题后，重新触发 workflow

### 场景 3：长时间运行（作为服务）

```powershell
cd actions-runner

# 安装为服务（需要管理员权限）
.\svc.cmd install

# 启动服务
.\svc.cmd start

# 现在 runner 会在后台运行，即使关闭终端也会继续

# 查看服务状态
.\svc.cmd status

# 停止服务
.\svc.cmd stop

# 卸载服务（如果不再需要）
.\svc.cmd uninstall
```

## 7. 故障排查

### Runner 显示为离线

- 检查 `run.cmd` 是否还在运行
- 查看 `actions-runner/_diag/Runner_*.log` 日志文件
- 检查网络连接
- 确认 Token 是否过期（Token 通常有效 1 小时，如果过期需要重新配置）

### 作业未分配到 Runner

- 确认 workflow 中的 `runs-on` 设置为 `self-hosted`
- 检查 runner 标签是否匹配（如果 workflow 中指定了标签）
- 查看 GitHub Actions 页面的错误信息

### 作业执行失败

- 查看 GitHub Actions 页面的错误日志
- 检查本地环境是否满足要求（Node.js、Rust、pnpm 等）
- 查看 `actions-runner/_diag/Worker_*.log` 获取详细错误信息
- 尝试在本地手动运行相同的命令

### 重新配置 Runner

如果 runner 出现问题，可以重新配置：

```powershell
# 1. 停止 runner（Ctrl+C 或 svc.cmd stop）

# 2. 删除配置并重新配置
cd actions-runner
.\config.cmd remove --token <NEW_TOKEN>
.\config.cmd --url https://github.com/YOUR_USERNAME/YOUR_REPO --token <NEW_TOKEN> --name local-windows-runner

# 3. 重新启动
.\run.cmd
```

## 8. 最佳实践

1. **测试环境隔离**：建议在测试分支或单独的分支上测试，避免影响主分支
2. **资源管理**：长时间运行时，考虑使用服务模式，避免占用终端窗口
3. **日志管理**：定期清理 `_diag` 目录下的旧日志文件
4. **安全考虑**：只在可信的机器上运行 self-hosted runner
5. **环境准备**：确保本地环境与 workflow 要求一致（工具、依赖等）

## 下一步

- 查看 [GitHub Runner 设置指南](./GITHUB_RUNNER_SETUP.md) 了解安装和配置
- 查看 [GitHub Actions 工作流文档](https://docs.github.com/en/actions) 了解更多功能
- 查看项目的 workflow 文件了解具体的构建流程

