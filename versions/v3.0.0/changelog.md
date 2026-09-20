# v3.0.0 changelog

## Added

- linux plasma 支持（原生壁纸设置以及壁纸插件模式）
- linux plasma wallpaper plugin 子仓库

## Changed

- 架构迁移到一个daemon负责底层数据，其他前端与之通过ipc交互（windows 命令管道，unix 用 UDS）
- cli 不常驻，与daemon交互操作
- **plugin-editor 迁移到 IPC 架构**：插件编辑器现在通过 IPC 与 daemon 通信，而不是直接访问本地 State
  - 添加 `daemon_client.rs` 模块统一管理 IPC 客户端
  - 存储相关命令（任务、图片）迁移到 IPC
  - 设置相关命令迁移到 IPC
  - 启动时自动确保 daemon 已就绪
  - 本地仅保留运行临时任务所需的组件（TaskScheduler、DownloadQueue）
- **cli 的输出画册参数改为使用画册名称**：`--output-album-id` 改为 `--output-album`，因为画册名称已经固定。CLI 会自动将画册名称转换为 ID（不区分大小写）
