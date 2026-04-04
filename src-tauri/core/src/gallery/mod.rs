//! Gallery 模块：给 app-main 画廊复用 Provider 的查询能力（按 provider-path 浏览）。

pub mod browse;

pub use browse::{browse_gallery_provider, GalleryBrowseEntry, GalleryBrowseResult};
