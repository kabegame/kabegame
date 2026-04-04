# Tauri 命令、IPC 与 CLI

## 原则：扩展而非堆命令

- **不新增**独立的画册类 Tauri 命令；在现有命令上 **扩展参数**（例如 `get_albums` 增加 `parent_id`，`add_album` 增加 `parent_id` 等），与 [02-storage-api.md](./02-storage-api.md) 一致。
- 主进程：`src-tauri/app-main/src/commands/album.rs`；注册处 `src-tauri/app-main/src/lib.rs` 仅更新已有命令的签名/载荷，而非增加一批新 command 名。

## IPC（CLI 与主进程通信）

- `src-tauri/app-main/src/ipc/handlers/storage/albums.rs` 及 `CliIpcRequest` / 响应：对既有 **Storage* 画册** 请求扩展字段，**不**为同一操作再平行增加一套 IPC 变体（除非类型系统强制拆分）。
- `src-tauri/core/src/ipc/ipc.rs` 与 `src-tauri/core/src/ipc/client/client.rs` 中的 `storage_*_album*` 与上述扩展保持一致。

## CLI 路径与名称约束

### 正斜线路径

- CLI 在将**用户输入的画册路径**解析为画册 id 时，支持 **`/` 分隔** 的多级路径（例如 `旅行/2024/精选`），从根起依次解析每一段对应的**直接子画册**名称，直到找到目标节点。
- 路径分隔符约定为 **正斜线 `/`**（与常见 URL/跨平台习惯一致）；**反斜线 `\` 是否作为分隔符**：建议不采纳，避免与 Windows 路径混淆；若需写进文档再单独定。

### 画册名称禁止包含 `/`

- **创建、重命名**画册时校验：`name` **不得包含字符 `/`**，否则与路径语法冲突。
- Storage / Tauri / CLI 三层规则一致；错误信息需对用户可读（如「名称不能包含 /」）。

## 与 UI 的一致性

- 应用内若展示「路径字符串」，建议使用同一套 **`/` 分段** 与同一套**禁 `/` 的名称规则**，避免 CLI 与 GUI 解析结果不一致。
