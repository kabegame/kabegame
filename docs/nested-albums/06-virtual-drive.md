# 虚拟盘（VD）架构与路径语义

## 当前架构（Phase 7）

虚拟盘已完成 Provider 重构，核心模型如下：

- 统一入口：`ProviderRuntime`（全局单例，path-only API）
- 统一根：`UnifiedRootProvider`
  - `gallery/...`：画廊路径（`SimplePage` 模式）
  - `vd/{locale}/...`：虚拟盘路径（`Greedy` 模式，目录名随 locale 翻译）
- 虚拟盘语义层：`VfsSemantics`
  - 目录读取：`provider.list_entries()`
  - 文件解析：从父目录 `ListEntry::Image` 匹配文件名并打开 `ImageEntry.local_path`
  - 说明文件：`provider.get_note()` 注入为虚拟文本文件
  - 写操作：仅使用新接口 `add_child` / `rename_child` / `delete_child_v2`

不再使用旧的 `RootProvider`、`VdOpsContext`、`delete_child(kind, mode, ctx)` 等 VD-only 兼容接口。

## 路径与 i18n

虚拟盘路径固定为：

- 根：`vd/{locale}`
- 示例：`vd/zh/全部/...`、`vd/en/all/...`

`locale` 由 `VdRootProvider` 选择，随后通过 `ProviderConfig.locale` 继承到整棵子树，实现：

- 列表名翻译（`display_name`）
- 路径反查（`canonical_name`）

即同一 provider 在不同 locale 下可使用不同目录显示名，但内部仍映射到同一 canonical 语义。

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
