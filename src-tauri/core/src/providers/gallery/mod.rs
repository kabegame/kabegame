//! Gallery Provider 系统：将画廊映射为前端 URL 路径树（canonical 路径，11 个顶层入口）。
//!
//! ```text
//! gallery/
//! ├── all/                          <- GalleryAllProvider（全量，crawled_at ASC）
//! │   └── desc/                     <- SortProvider（时间倒序）
//! ├── wallpaper-order/              <- GalleryWallpaperOrderProvider（仅设过壁纸，set_at ASC）
//! ├── plugin/                       <- GalleryPluginGroupProvider（按插件）
//! │   └── {plugin}/
//! ├── task/                         <- GalleryTaskGroupProvider（按任务）
//! │   └── {task_id}/
//! ├── surf/                         <- GallerySurfGroupProvider（按畅游 host）
//! │   └── {host}/
//! ├── media-type/                   <- GalleryMediaTypeProvider（image / video）
//! │   └── {image|video}/
//! ├── date/                         <- GalleryDateGroupProvider（crawled_at，年→月→日）
//! │   └── {year}/
//! │       └── {month}/
//! │           └── {day}/
//! ├── date-range/                   <- GalleryDateRangeRootProvider（动态日期范围）
//! │   └── {YYYY-MM-DD~YYYY-MM-DD}/
//! ├── album/                        <- GalleryAlbumsProvider（画册列表）
//! │   └── {id}/                     <- GalleryAlbumProvider（+ desc/album-order/wallpaper-order/media-type 子路径）
//! ├── hide/                         <- HideGateProvider（隐藏图片入口）
//! └── search/                       <- GallerySearchRootProvider（前置搜索过滤器）
//!     └── display-name/<q>/         <- 叶子 apply WHERE LIKE，挂裁剪版 gallery root
//!         ├── all/ (带搜索过滤)
//!         ├── plugin/{id}/ (带搜索过滤)
//!         └── ...                   <- 所有其他 gallery 一等入口（不含 search）
//! ```

pub mod album;
pub mod all;
pub mod date;
pub mod date_range;
pub mod media_type;
pub mod plugin;
pub mod root;
pub mod search;
pub mod surf;
pub mod task;
