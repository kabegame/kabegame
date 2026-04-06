# 虚拟盘（VD）架构与路径语义

## 当前架构（Phase 7）

虚拟盘已完成 Provider 重构，核心模型如下：

- 统一入口：`ProviderRuntime`（全局单例，path-only API）
- 统一根：`UnifiedRootProvider`
  - `gallery/...`：画廊路径（`SimplePage` 模式）
  - `vd/{locale}/...`：虚拟盘路径（`Greedy` 模式，目录名随 locale 翻译）
- 虚拟盘语义层：`VfsSemantics`
  - `vd/{locale}` 段与 UI 语言一致：由设置中的语言映射到 `zh` / `en` / `ja` / `ko` / `zhtw`（与 `kabegame-i18n` 解析规则一致），不再写死为某一 locale。
  - 目录读取：`provider.list_entries()`
  - 文件解析：从父目录 `ListEntry::Image` 匹配文件名并打开 `ImageEntry.local_path`
  - 说明文件：`provider.get_note()` 注入为虚拟文本文件
  - 写操作：父节点上的 `add_child` / `rename_child` / `can_delete_child` / `delete_child`；语义层暴露 `can_delete_child_at` / `commit_delete_child_at`（Dokan `delete_on_close` 在 handler 侧完成两阶段）
  - 画册 / 按任务等策略：通过解析得到的 `ProviderDescriptor::Group { kind }` 判断，**不**再依赖硬编码的中文目录名

不再使用旧的 `RootProvider`、`VdOpsContext`、以及 Provider 模块内的 `DeleteChildMode` / `ResolveResult`（后者已迁至 `VfsSemantics`）。

## 路径与 i18n

虚拟盘路径固定为：

- 根：`vd/{locale}`
- 示例：`vd/zh/...`、`vd/en/...`（子目录名为各语言下的显示名，如「画册」/ `Albums`）

`VdRootProvider` 下列出 `zh` / `en` / `ja` / `ko` / `zhtw` 子根；挂载到盘符后，Explorer 所见的一级目录对应当前 UI 语言对应的那一支。`ProviderConfig.locale` 继承到整棵子树：

- 列表名翻译：`display_name()`（数据来自 **`kabegame-i18n`** `vd.*` 键，与 `ProviderConfig` 内 canonical key 对应）
- 路径反查：`canonical_name()`

即同一 provider 在不同 locale 下可使用不同目录显示名，但内部仍映射到同一 canonical 语义。

## Explorer 刷新（Windows）

`driver_service` 中通知资源管理器刷新的路径使用 **`vd_display_name_for_settings_sync(canonical)`**（内部与 `VfsSemantics` 同源 locale），不再写死 `画册`、`按任务` 等某一语言的常量。

## 与 browse 的对应

前端 browse 与 VD 都建立在同一 provider 树之上：

- browse：`provider_rt.resolve("gallery/" + path)`
- VD：`provider_rt.resolve("vd/{locale}/" + path)`

两者差异仅在：

- 分页语义（`SimplePage` vs `Greedy`）
- 目录名称本地化（VD 有 locale，gallery 默认 canonical）

## 平台范围

- 支持：Windows / macOS / Linux / Android（应用整体）
- 虚拟盘功能：桌面平台（Windows、macOS、Linux）
- iOS：不支持
