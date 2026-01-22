# 从 pnpm 迁移到 Bun 的迁移指南

本文档记录了从 pnpm workspace 迁移到 Bun workspace 的变更和注意事项。

## 迁移概述

项目已从 pnpm workspace 迁移到 Bun workspace。Bun 提供了与 pnpm 类似的 workspace 支持，并且具有更快的安装和运行速度。

## 主要变更

### 1. Workspace 配置

**之前 (pnpm-workspace.yaml):**
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'src-crawler-plugins'
```

**现在 (package.json):**
```json
{
  "workspaces": [
    "apps/*",
    "packages/*",
    "src-crawler-plugins"
  ]
}
```

### 2. 包管理器命令变更

| 操作 | pnpm 命令 | Bun 命令 |
|------|----------|---------|
| 安装依赖 | `pnpm install` | `bun install` |
| 运行脚本 | `pnpm -C <dir> <script>` | `bun --cwd <dir> <script>` |
| 运行根目录脚本 | `pnpm run <script>` | `bun run <script>` |

### 3. 更新的文件

- ✅ `package.json` - 添加 `workspaces` 字段，更新 `engines`，替换脚本命令
- ✅ `scripts/plugins/build-plugins.js` - 替换 `pnpm -C` 为 `bun --cwd`
- ✅ `src-tauri/app-main/tauri.conf.json` - 更新 beforeDevCommand 和 beforeBuildCommand
- ✅ `src-tauri/app-main/tauri.linux.conf.json` - 更新 beforeDevCommand 和 beforeBuildCommand
- ✅ `src-tauri/app-plugin-editor/tauri.conf.json` - 更新 beforeDevCommand 和 beforeBuildCommand
- ✅ `src-tauri/app-cli/tauri.conf.json` - 更新 beforeBuildCommand

### 4. 保留的文件

- `pnpm-workspace.yaml` - 可以保留作为参考，但不再使用
- `pnpm-lock.yaml` - Bun 会自动生成 `bun.lockb`，可以删除旧的 lockfile

## 迁移步骤

### 首次迁移

1. **安装 Bun**（如果尚未安装）:
   ```bash
   # macOS/Linux
   curl -fsSL https://bun.sh/install | bash
   
   # Windows (PowerShell)
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **清理旧的依赖和锁文件**:
   ```bash
   rm -rf node_modules
   rm -rf pnpm-lock.yaml
   # 可选：删除 pnpm-workspace.yaml（已迁移到 package.json）
   ```

3. **安装依赖**:
   ```bash
   bun install
   ```
   
   Bun 会自动：
   - 检测 workspace 配置
   - 安装所有依赖
   - 生成 `bun.lockb` 锁文件
   - 正确处理 workspace 之间的依赖关系（`workspace:*` 协议）

4. **验证安装**:
   ```bash
   bun run dev -c main
   ```

## Workspace 依赖协议

Bun 完全支持 `workspace:*` 协议，无需修改子项目的 `package.json`：

```json
{
  "dependencies": {
    "@kabegame/core": "workspace:*"
  }
}
```

## 注意事项

### 1. 锁文件

- Bun 使用 `bun.lockb`（二进制格式）而不是 `pnpm-lock.yaml`
- 确保将 `bun.lockb` 提交到版本控制

### 2. CI/CD 配置

如果使用 CI/CD，需要更新：

**之前:**
```yaml
- run: pnpm install
- run: pnpm build
```

**现在:**
```yaml
- uses: oven-sh/setup-bun@v1
  with:
    bun-version: latest
- run: bun install
- run: bun run build
```

### 3. 开发工具

- **VSCode**: Bun 的 TypeScript 支持很好，通常无需额外配置
- **Husky**: 如果使用 Git hooks，确保 hooks 脚本使用 `bun` 而不是 `pnpm`

### 4. 性能优势

Bun 相比 pnpm 的优势：
- 更快的安装速度（通常快 2-10 倍）
- 更快的脚本执行速度
- 内置 TypeScript 和 JSX 支持
- 内置测试运行器

## 回滚方案

如果需要回滚到 pnpm：

1. 恢复 `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - 'apps/*'
     - 'packages/*'
     - 'src-crawler-plugins'
   ```

2. 恢复 `package.json` 中的脚本和 engines

3. 运行 `pnpm install` 重新生成 `pnpm-lock.yaml`

## 常见问题

### Q: Bun 是否支持所有 pnpm 的功能？

A: Bun 支持大部分 pnpm workspace 功能，包括：
- ✅ Workspace 依赖解析
- ✅ `workspace:*` 协议
- ✅ 隔离的 node_modules（isolated linker）
- ✅ 依赖去重和共享

### Q: 是否需要修改子项目的 package.json？

A: 不需要。`workspace:*` 协议在 Bun 中完全兼容。

### Q: 如何确保团队所有成员使用相同的 Bun 版本？

A: 在 `package.json` 的 `engines` 字段中指定：
```json
{
  "engines": {
    "bun": ">= 1.0.0"
  }
}
```

## 参考资源

- [Bun 官方文档](https://bun.sh/docs)
- [Bun Workspace 文档](https://bun.sh/docs/install/workspaces)
- [Bun vs pnpm 对比](https://bun.sh/docs/install/workspaces)
