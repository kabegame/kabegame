//! Gallery Provider 系统：将画廊映射为前端 URL 路径树（canonical 路径，11 个顶层入口）。
//!
//! `hide/` 与 `search/` 均采用"**路由壳 + 代理 shared 纯查询组件**"模式:
//! gallery 侧的路由壳负责 `list_children` / `get_child` / `list_images`,
//! `apply_query` 代理 shared 侧的纯查询组件做 WHERE/JOIN/ORDER 变换。
//! 这和 `album/` 下 `GalleryAlbumsProvider` 代理 `AlbumsProvider`、
//! `GalleryAlbumMediaFilterShell` 代理 `ImageQuery::media_type_filter(...)` 是同一范式。
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
//! ├── hide/                         <- GalleryHideShell（路由壳；apply_query 代理 shared::HideProvider 注入 WHERE，
//! │                                    list_children/get_child/list_images 委派 GalleryRootProvider）
//! └── search/                       <- GallerySearchShell（路由壳；前两层 apply_query noop，
//!     └── display-name/<q>/              叶子壳代理 shared::SearchDisplayNameProvider merge LIKE，
//!         ├── all/ (带搜索过滤)           list_children/get_child/list_images 委派 GalleryRootProvider，
//!         ├── plugin/{id}/                故下游暴露完整 gallery 树，支持嵌套 AND 与任意维度组合）
//!         └── ...
//! ```

pub mod album;
pub mod all;
pub mod date;
pub mod date_range;
pub mod hide;
pub mod media_type;
pub mod plugin;
pub mod root;
pub mod search;
pub mod surf;
pub mod task;
