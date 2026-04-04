# 虚拟盘 Provider 与多级路径

## 现状

`src-tauri/core/src/providers/albums.rs` 中：

- `AlbumsProvider::list` 列出所有画册名为**一层目录**。
- `get_child` 按名称解析到 `AlbumProvider`（单册内为图片文件）。

即虚拟盘上为 `画册\<画册名>\` 的扁平结构。

## 嵌套后

- 与前端一致（见 [00-product-decisions.md](./00-product-decisions.md) §2）：进入某一画册目录时，列出 **子画册子文件夹** + **本层图片文件**，**不**把子孙画册内图片全部摊平到当前目录。
- 目录结构需变为 **多级**，例如 `画册\父\子\`，与数据库中的父子关系一致。
- **`mkdir` / 删除目录** 等 VD 语义（见 `can_create_child_dir`、`create_child_dir`、`delete_child`）是否映射为「创建子画册」「删除画册」，需与 Storage 创建/删除 API 对齐。
- 名称解析：路径分段需映射到**唯一画册节点**（注意重名仅在不同父下允许时的查找逻辑）。
- `VirtualDriveService::bump_albums` 等缓存失效时机：树变更时仍应触发刷新。

桌面 **Light** 模式无虚拟盘；**Android** 当前不参与 VD，实现时按条件编译分支处理。
