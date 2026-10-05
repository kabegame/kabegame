# v3.0.0 changelog

## Added

- linux plasma 支持（原生壁纸设置以及壁纸插件模式）
- linux plasma wallpaper plugin 子仓库

## Changed

- 底层数据与业务服务内嵌于 Kabegame 主应用，外部集成通过 IPC 交互（Windows 命名管道，Unix 使用 UDS）
- CLI 按需运行，在自身进程内完成命令
- **plugin-editor 迁移到 IPC 架构**：插件编辑器通过 IPC 与 Kabegame 主应用通信
  - 添加 `ipc_client.rs` 模块统一管理 IPC 客户端
  - 存储相关命令（任务、图片）迁移到 IPC
  - 设置相关命令迁移到 IPC
  - 启动时检查 Kabegame 主应用 IPC 服务是否就绪
  - 本地仅保留运行临时任务所需的组件（TaskScheduler、DownloadQueue）
- **cli 的输出画册参数改为使用画册名称**：`--output-album-id` 改为 `--output-album`，因为画册名称已经固定。CLI 会自动将画册名称转换为 ID（不区分大小写）
