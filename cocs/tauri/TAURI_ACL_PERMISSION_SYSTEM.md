# Tauri ACL 与权限系统（kabegame）

本文记录 `src-tauri/kabegame` 的 Tauri v2 ACL（capability + permission）机制、常见坑位，以及一次“所有命令都找不到”的故障复盘。

## 适用场景

- 需要给某个窗口（如 `surf`）新增 IPC 权限。
- 出现 `invoke` 命令被拒绝、提示命令不可用/找不到。
- 调整 `capabilities/*.json`、`permissions/*.toml`、`tauri.conf.json` 时做变更评估。

## 涉及文件

- `src-tauri/kabegame/tauri.conf.json`
- `src-tauri/kabegame/tauri.conf.json.handlebars`
- `src-tauri/kabegame/capabilities/main.json`
- `src-tauri/kabegame/capabilities/main.json.handlebars`
- `src-tauri/kabegame/capabilities/crawler.json`
- `src-tauri/kabegame/build.rs`
- `src-tauri/kabegame/src/lib.rs`

参考（工作区 Tauri 源码）：

- `/Users/cmtheit/code/tauri/crates/tauri/src/webview/mod.rs`
- `/Users/cmtheit/code/tauri/crates/tauri-build/src/acl.rs`
- `/Users/cmtheit/code/tauri/crates/tauri-utils/src/acl/build.rs`
- `/Users/cmtheit/code/tauri/crates/tauri-utils/src/acl/mod.rs`

## 本工程当前 ACL 结构

### 1) capability 入口

`tauri.conf.json` / `tauri.conf.json.handlebars` 中 `app.security.capabilities` 指定启用的 capability 集合。

当前桌面端核心是：

- `main-capability`
- `crawler-capability`

### 2) capability 定义

- `capabilities/main.json`：主窗口权限（`main` / `wallpaper`）。
- `capabilities/crawler.json`：爬虫窗口权限（`crawler`）+ remote URL 访问范围。

### 3) build 入口

`src-tauri/kabegame/build.rs` 当前使用 `tauri_build::build()`。

这意味着 ACL 的行为由 Tauri 默认机制驱动：读取 capability 文件、处理 permission 文件，并生成运行时授权数据。

## 核心机制（必须理解）

在 Tauri 运行时，是否对“应用命令”（非 `plugin:xxx|yyy`）进行 ACL 检查，关键在 `has_app_acl_manifest`。

来自 `tauri/src/webview/mod.rs`（工作区 Tauri 源码）：

```rust
// we only check ACL on plugin commands or if the app defined its ACL manifest
if (plugin_command.is_some() || has_app_acl_manifest) && invoke.acl.is_none() {
  // reject
}
```

结论：

- 只要应用侧出现 `app ACL manifest`，应用命令就会进入 ACL 校验路径。
- 若 capability/permission 未完整覆盖已有命令，原本可用的命令会被整体拒绝。

## 故障复盘：为什么会“所有命令都找不到”

### 现象

- 画廊数据加载失败。
- 多个 `invoke` 命令统一报“找不到/不可用”。

### 触发链路

1. 新增了 app 级 `permissions/*.toml`（仅为单个命令放行）。
2. 新增了只覆盖某个窗口的 capability（如 `surf-capability`）。
3. Tauri 构建后识别到 app ACL，`has_app_acl_manifest` 从 false 变为 true。
4. 应用命令整体进入 ACL 校验，但没有为 `main` 窗口全面授予权限。
5. 结果就是大量命令被拒绝，看起来像“全部命令失效”。

### 已采用修复策略

- 删除此次临时新增的 app 级手写 permission / surf capability。
- 恢复到原本 capability 结构（`main` + `crawler`）。
- 让 `has_app_acl_manifest` 回到原先行为预期，避免影响全局命令路径。

## 变更建议（后续新增权限时）

### 推荐做法

1. 先评估是否必须引入新的 app 级 ACL 条目。
2. 若必须引入，必须按“窗口 + 命令全集”设计，不要只放行单个新命令。
3. 先在 capability 中明确 `windows` / `webviews` / `remote.urls` 的边界，再补权限项。

### 不推荐做法

- 仅为单个新命令快速加一条 app 级 permission，就立刻挂到全局 capability。
- 未评估 `main` 窗口现有命令集合就切换到严格 ACL。

## 快速排查清单

出现“命令都不可用”时，优先检查：

1. `tauri.conf` 的 `app.security.capabilities` 是否新增/变更。
2. `capabilities/*.json` 是否限制了 `windows` / `webviews`。
3. 是否引入了新的 app 级 `permissions/*.toml`。
4. 结合 Tauri 源码中的 `has_app_acl_manifest` 路径判断是否进入了 ACL 强校验。
