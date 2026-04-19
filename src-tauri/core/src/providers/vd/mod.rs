//! VD Provider 系统：将画廊映射为虚拟文件系统目录结构（7 个 canonical 入口）。
//! 目录名按 locale 翻译（canonical key → 显示名），路径由框架递归解析。
//!
//! ```text
//! K:\  (canonical key → zh-CN 示例)
//! ├── 全部\                       <- VdAllProvider（扁平分页，id ASC）
//! ├── 按任务\                     <- VdByTaskProvider（{插件展示名} - {task_id}）
//! │   └── {插件名} - {id}\
//! ├── 按插件\                     <- VdByPluginProvider
//! │   └── {plugin}\
//! ├── 按时间\                     <- VdByTimeProvider（年 → 月 i18n → 日 i18n → 分页）
//! │   └── 2024\
//! │       └── 一月\
//! │           └── 1日\
//! ├── 按畅游\                     <- VdBySurfProvider（按 host）
//! │   └── {host}\
//! ├── 按类型\                     <- VdByTypeProvider（图片 / 视频）
//! │   ├── 图片\
//! │   └── 视频\
//! └── 画册\                       <- VdAlbumsProvider
//!     └── {画册名}\               <- VdAlbumProvider（含 sub_album_gate 子画册入口）
//! ```

pub mod albums;
pub mod all;
pub mod by_plugin;
pub mod by_surf;
pub mod by_task;
pub mod by_time;
pub mod by_type;
pub mod notes;
pub mod plugin_names;
pub mod root;
pub mod sub_album_gate;
