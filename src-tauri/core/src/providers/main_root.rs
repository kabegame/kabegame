//! MainProvider 体系：前端简单分页（与 DiskProvider 的贪心分解分离）
//!
//! - MainRootProvider：根目录，提供 all/plugin/date/date-range/album/task/media-type 入口
//! - MainGroupProvider 系列：各分组的动态子目录解析

use std::sync::Arc;

use crate::providers::common::{CommonProvider, PaginationMode, SimplePageProvider};
use crate::providers::config::ProviderConfig;
use crate::providers::main_date_browse::{list_main_date_browse_root_entries, main_date_child_provider};
use crate::providers::descriptor::{ProviderDescriptor, ProviderGroupKind};
use crate::providers::provider::{FsEntry, Provider, ResolveChild};
use crate::providers::vd_names::parse_date_range_name;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// MainProvider 根目录
#[derive(Clone)]
pub struct MainRootProvider {
    pub(crate) config: ProviderConfig,
}

impl MainRootProvider {
    pub fn new() -> Self {
        Self {
            config: ProviderConfig::gallery_default(),
        }
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> ProviderConfig {
        self.config
    }
}

impl Default for MainRootProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainRootProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::GalleryRoot
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir(self.config.display_name("all")),
            FsEntry::dir(self.config.display_name("wallpaper-order")),
            FsEntry::dir(self.config.display_name("plugin")),
            FsEntry::dir(self.config.display_name("date")),
            FsEntry::dir(self.config.display_name("date-range")),
            FsEntry::dir(self.config.display_name("album")),
            FsEntry::dir(self.config.display_name("task")),
            FsEntry::dir(self.config.display_name("surf")),
            FsEntry::dir(self.config.display_name("media-type")),
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match self.config.canonical_name(name) {
            "all" => Some(Arc::new(MainAllProvider::new_with_config(self.config)) as Arc<dyn Provider>),
            "wallpaper-order" => {
                Some(Arc::new(MainWallpaperOrderProvider::new_with_config(self.config)) as Arc<dyn Provider>)
            }
            "plugin" => Some(Arc::new(MainPluginGroupProvider::new_with_config(self.config)) as Arc<dyn Provider>),
            "date" => Some(Arc::new(MainDateGroupProvider::new_with_config(self.config)) as Arc<dyn Provider>),
            "date-range" => Some(Arc::new(MainDateRangeRootProvider::new_with_config(self.config)) as Arc<dyn Provider>),
            "album" => Some(
                Arc::new(MainAlbumsProvider::new_with_config(self.config)) as Arc<dyn Provider>
            ),
            "task" => Some(
                Arc::new(MainTaskGroupProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            ),
            "surf" => Some(
                Arc::new(MainSurfGroupProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            ),
            "media-type" => Some(Arc::new(MainMediaTypeGroupProvider::new_with_config(self.config)) as Arc<dyn Provider>),
            _ => None,
        }
    }
}

/// MainAllProvider：处理 all 和 all/desc
pub struct MainAllProvider {
    inner: CommonProvider,
}

impl MainAllProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self {
            inner: CommonProvider::with_query_and_mode(
                ImageQuery::all_recent(),
                config.pagination_mode,
            ),
        }
    }
}

impl Provider for MainAllProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.inner.descriptor()
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        self.inner.list()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// MainWallpaperOrderProvider：按「最后一次设为壁纸」时间排序（正序根节点，子目录 desc 为倒序）
pub struct MainWallpaperOrderProvider {
    inner: CommonProvider,
    config: ProviderConfig,
}

impl MainWallpaperOrderProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self {
            inner: CommonProvider::with_query_and_mode(
                ImageQuery::all_by_wallpaper_set(),
                config.pagination_mode,
            ),
            config,
        }
    }
}

impl Provider for MainWallpaperOrderProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: ImageQuery::all_by_wallpaper_set(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![FsEntry::dir(self.config.display_name("desc"))])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.config.canonical_name(name) != "desc" {
            return None;
        }
        let query = ImageQuery::all_by_wallpaper_set().to_desc();
        Some(Arc::new(CommonProvider::with_query_and_mode(
            query,
            self.config.pagination_mode,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// MainPluginGroupProvider：按插件分组
pub struct MainPluginGroupProvider {
    config: ProviderConfig,
}

impl MainPluginGroupProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }
}

impl Default for MainPluginGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainPluginGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::Plugin,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let groups = Storage::global().get_gallery_plugin_groups()?;
        Ok(groups.into_iter().map(|g| FsEntry::dir(g.plugin_id)).collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name.trim().is_empty() {
            return None;
        }
        let groups = Storage::global().get_gallery_plugin_groups().ok()?;
        let exists = groups.iter().any(|g| g.plugin_id.eq_ignore_ascii_case(name));
        if !exists {
            return None;
        }
        Some(Arc::new(CommonProvider::with_query_and_mode(
            ImageQuery::by_plugin(name.to_string()),
            self.config.pagination_mode,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        // name 就是 plugin_id
        if name.trim().is_empty() {
            return ResolveChild::NotFound;
        }
        // 验证插件是否存在
        let groups = match Storage::global().get_gallery_plugin_groups() {
            Ok(groups) => groups,
            Err(_) => return ResolveChild::NotFound,
        };
        let exists = groups
            .iter()
            .any(|g| g.plugin_id.eq_ignore_ascii_case(name));
        if !exists {
            return ResolveChild::NotFound;
        }

        let provider = CommonProvider::with_query_and_mode(
            ImageQuery::by_plugin(name.to_string()),
            self.config.pagination_mode,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
    }
}

/// MainMediaTypeGroupProvider：`media-type/` 下按 `image` / `video` 分子目录
pub struct MainMediaTypeGroupProvider {
    config: ProviderConfig,
}

impl MainMediaTypeGroupProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }
}

impl Default for MainMediaTypeGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainMediaTypeGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::MediaType,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir(self.config.display_name("image")),
            FsEntry::dir(self.config.display_name("video")),
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let canonical = self.config.canonical_name(name);
        if canonical != "image" && canonical != "video" {
            return None;
        }
        Some(Arc::new(CommonProvider::with_query_and_mode(
            ImageQuery::by_media_type(canonical),
            self.config.pagination_mode,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        let canonical = self.config.canonical_name(name);
        if canonical != "image" && canonical != "video" {
            return ResolveChild::NotFound;
        }
        let provider = CommonProvider::with_query_and_mode(
            ImageQuery::by_media_type(canonical),
            self.config.pagination_mode,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
    }
}

/// MainDateGroupProvider：`date/` 根为**年份**目录，子级为 `MainDateScopedProvider`（与画廊 `date/*` 一致）。
pub struct MainDateGroupProvider {
    config: ProviderConfig,
}

impl MainDateGroupProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }
}

impl Default for MainDateGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainDateGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::Date,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        list_main_date_browse_root_entries()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        main_date_child_provider(self.config.canonical_name(name))
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        match main_date_child_provider(self.config.canonical_name(name)) {
            Some(p) => ResolveChild::Dynamic(p),
            None => ResolveChild::NotFound,
        }
    }
}

/// MainDateRangeRootProvider：按日期范围分组
pub struct MainDateRangeRootProvider {
    config: ProviderConfig,
}

impl MainDateRangeRootProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }
}

impl Default for MainDateRangeRootProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainDateRangeRootProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::DateRange,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(Vec::new()) // 日期范围通过 resolve_child 动态提供
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        // name: "YYYY-MM-DD~YYYY-MM-DD"
        let Some((start, end)) = parse_date_range_name(name) else {
            return ResolveChild::NotFound;
        };

        let provider = CommonProvider::with_query_and_mode(
            ImageQuery::by_date_range(start, end),
            self.config.pagination_mode,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
    }
}

/// MainAlbumsProvider：画册分组
pub struct MainAlbumsProvider {
    config: ProviderConfig,
}

impl MainAlbumsProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }
}

impl Default for MainAlbumsProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainAlbumsProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::Album,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let albums = Storage::global().get_albums()?;
        Ok(albums.into_iter().map(|a| FsEntry::dir(a.id)).collect())
    }

    fn get_child(&self, id: &str) -> Option<Arc<dyn Provider>> {
        if id.trim().is_empty() {
            return None;
        }
        if !Storage::global().album_exists(id).ok()? {
            return None;
        }
        Some(Arc::new(MainAlbumEntryProvider::new_with_config(
            id.to_string(),
            self.config,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, id: &str) -> ResolveChild {
        // 只接受画册 id（画廊/前端传的是 id）
        if id.trim().is_empty() {
            return ResolveChild::NotFound;
        }
        if !Storage::global().album_exists(id).unwrap_or(false) {
            return ResolveChild::NotFound;
        }

        ResolveChild::Dynamic(
            Arc::new(MainAlbumEntryProvider::new_with_config(
                id.to_string(),
                self.config,
            )) as Arc<dyn Provider>,
        )
    }
}

/// 单个画册下的浏览根：与画廊「全部 / 设置过壁纸」一致，支持按抓取时间排序、「按设壁纸」过滤、按画册内加入顺序排序。
///
/// 路径片段（`album/<id>/...`）：
/// - `<page>`：按抓取时间升序
/// - `desc/<page>`：按抓取时间降序
/// - `album-order/<page>`：按画册内 `order`（加入顺序）升序
/// - `album-order/desc/<page>`：同上，降序
/// - `wallpaper-order/<page>`：仅曾设为壁纸，按设壁纸时间升序
/// - `wallpaper-order/desc/<page>`：同上，降序
/// - `image-only` / `video-only`：仅图片或仅视频，子路径与上面对齐
pub struct MainAlbumEntryProvider {
    album_id: String,
    config: ProviderConfig,
}

impl MainAlbumEntryProvider {
    pub fn new(album_id: String) -> Self {
        Self::new_with_config(album_id, ProviderConfig::gallery_default())
    }

    pub fn new_with_config(album_id: String, config: ProviderConfig) -> Self {
        Self { album_id, config }
    }

    fn time_asc_query(&self) -> ImageQuery {
        ImageQuery::album_source(self.album_id.clone()).merge(&ImageQuery::sort_by_crawled_at(true))
    }
}

impl Provider for MainAlbumEntryProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: self.time_asc_query(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir(self.config.display_name("desc")),
            FsEntry::dir("album-order"),
            FsEntry::dir(self.config.display_name("wallpaper-order")),
            FsEntry::dir("image-only"),
            FsEntry::dir("video-only"),
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match self.config.canonical_name(name) {
            "desc" => {
                let q = ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::sort_by_crawled_at(false));
                Some(Arc::new(CommonProvider::with_query_and_mode(
                    q,
                    self.config.pagination_mode,
                )) as Arc<dyn Provider>)
            }
            "album-order" => Some(
                Arc::new(MainAlbumJoinOrderProvider::new(self.album_id.clone()))
                    as Arc<dyn Provider>,
            ),
            "wallpaper-order" => Some(
                Arc::new(MainAlbumWallpaperOrderProvider::new(self.album_id.clone()))
                    as Arc<dyn Provider>,
            ),
            "image-only" => Some(
                Arc::new(MainAlbumMediaEntryProvider::new(self.album_id.clone(), "image"))
                    as Arc<dyn Provider>,
            ),
            "video-only" => Some(
                Arc::new(MainAlbumMediaEntryProvider::new(self.album_id.clone(), "video"))
                    as Arc<dyn Provider>,
            ),
            _ => None,
        }
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        match self.config.canonical_name(name) {
            "desc" => {
                let q = ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::sort_by_crawled_at(false));
                ResolveChild::Dynamic(Arc::new(CommonProvider::with_query_and_mode(
                    q,
                    self.config.pagination_mode,
                )) as Arc<dyn Provider>)
            }
            "album-order" => ResolveChild::Dynamic(
                Arc::new(MainAlbumJoinOrderProvider::new(self.album_id.clone()))
                    as Arc<dyn Provider>,
            ),
            "wallpaper-order" => ResolveChild::Dynamic(
                Arc::new(MainAlbumWallpaperOrderProvider::new(self.album_id.clone()))
                    as Arc<dyn Provider>,
            ),
            "image-only" => ResolveChild::Dynamic(
                Arc::new(MainAlbumMediaEntryProvider::new(self.album_id.clone(), "image"))
                    as Arc<dyn Provider>,
            ),
            "video-only" => ResolveChild::Dynamic(
                Arc::new(MainAlbumMediaEntryProvider::new(self.album_id.clone(), "video"))
                    as Arc<dyn Provider>,
            ),
            _ => {
                if let Ok(page) = name.parse::<usize>() {
                    if page > 0 {
                        let q = self.time_asc_query();
                        return ResolveChild::Dynamic(
                            Arc::new(SimplePageProvider::new(q, page)) as Arc<dyn Provider>,
                        );
                    }
                }
                ResolveChild::NotFound
            }
        }
    }
}

/// 画册内仅图片或仅视频：子路径语义与 [`MainAlbumEntryProvider`] 一致
pub struct MainAlbumMediaEntryProvider {
    album_id: String,
    media_type: &'static str,
}

impl MainAlbumMediaEntryProvider {
    pub fn new(album_id: String, media_type: &'static str) -> Self {
        Self {
            album_id,
            media_type,
        }
    }

    fn time_asc_query(&self) -> ImageQuery {
        ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::media_type_filter(self.media_type))
            .merge(&ImageQuery::sort_by_crawled_at(true))
    }
}

impl Provider for MainAlbumMediaEntryProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: self.time_asc_query(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir("desc"),
            FsEntry::dir("album-order"),
            FsEntry::dir("wallpaper-order"),
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match name {
            "desc" => {
                let q = ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::media_type_filter(self.media_type))
                    .merge(&ImageQuery::sort_by_crawled_at(false));
                Some(Arc::new(CommonProvider::with_query_and_mode(
                    q,
                    PaginationMode::SimplePage,
                )) as Arc<dyn Provider>)
            }
            "album-order" => Some(
                Arc::new(MainAlbumMediaJoinOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                )) as Arc<dyn Provider>,
            ),
            "wallpaper-order" => Some(
                Arc::new(MainAlbumMediaWallpaperOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                )) as Arc<dyn Provider>,
            ),
            _ => None,
        }
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        match name {
            "desc" => {
                let q = ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::media_type_filter(self.media_type))
                    .merge(&ImageQuery::sort_by_crawled_at(false));
                ResolveChild::Dynamic(Arc::new(CommonProvider::with_query_and_mode(
                    q,
                    PaginationMode::SimplePage,
                )) as Arc<dyn Provider>)
            }
            "album-order" => ResolveChild::Dynamic(
                Arc::new(MainAlbumMediaJoinOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                )) as Arc<dyn Provider>,
            ),
            "wallpaper-order" => ResolveChild::Dynamic(
                Arc::new(MainAlbumMediaWallpaperOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                )) as Arc<dyn Provider>,
            ),
            _ => {
                if let Ok(page) = name.parse::<usize>() {
                    if page > 0 {
                        let q = self.time_asc_query();
                        return ResolveChild::Dynamic(
                            Arc::new(SimplePageProvider::new(q, page)) as Arc<dyn Provider>,
                        );
                    }
                }
                ResolveChild::NotFound
            }
        }
    }
}

/// 画册内「仅某媒体类型」+ 按加入顺序排序
pub struct MainAlbumMediaJoinOrderProvider {
    album_id: String,
    media_type: &'static str,
    inner: CommonProvider,
}

impl MainAlbumMediaJoinOrderProvider {
    pub fn new(album_id: String, media_type: &'static str) -> Self {
        let q = ImageQuery::album_source(album_id.clone())
            .merge(&ImageQuery::media_type_filter(media_type))
            .merge(&ImageQuery::sort_by_album_order(true));
        Self {
            album_id,
            media_type,
            inner: CommonProvider::with_query_and_mode(q, PaginationMode::SimplePage),
        }
    }

    fn order_asc_query(&self) -> ImageQuery {
        ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::media_type_filter(self.media_type))
            .merge(&ImageQuery::sort_by_album_order(true))
    }
}

impl Provider for MainAlbumMediaJoinOrderProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: self.order_asc_query(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![FsEntry::dir("desc")])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name != "desc" {
            return None;
        }
        let q = ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::media_type_filter(self.media_type))
            .merge(&ImageQuery::sort_by_album_order(false));
        Some(Arc::new(CommonProvider::with_query_and_mode(
            q,
            PaginationMode::SimplePage,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// 画册内「仅某媒体类型」+ 仅设过壁纸
pub struct MainAlbumMediaWallpaperOrderProvider {
    album_id: String,
    media_type: &'static str,
    inner: CommonProvider,
}

impl MainAlbumMediaWallpaperOrderProvider {
    pub fn new(album_id: String, media_type: &'static str) -> Self {
        let q = ImageQuery::album_source(album_id.clone())
            .merge(&ImageQuery::media_type_filter(media_type))
            .merge(&ImageQuery::wallpaper_set_filter())
            .merge(&ImageQuery::sort_by_wallpaper_set_at(true));
        Self {
            album_id,
            media_type,
            inner: CommonProvider::with_query_and_mode(q, PaginationMode::SimplePage),
        }
    }

    fn wallpaper_asc_query(&self) -> ImageQuery {
        ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::media_type_filter(self.media_type))
            .merge(&ImageQuery::wallpaper_set_filter())
            .merge(&ImageQuery::sort_by_wallpaper_set_at(true))
    }
}

impl Provider for MainAlbumMediaWallpaperOrderProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: self.wallpaper_asc_query(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![FsEntry::dir("desc")])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name != "desc" {
            return None;
        }
        let q = ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::media_type_filter(self.media_type))
            .merge(&ImageQuery::wallpaper_set_filter())
            .merge(&ImageQuery::sort_by_wallpaper_set_at(false));
        Some(Arc::new(CommonProvider::with_query_and_mode(
            q,
            PaginationMode::SimplePage,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// 画册内按 `album_images.order`（加入顺序）排序
pub struct MainAlbumJoinOrderProvider {
    album_id: String,
    inner: CommonProvider,
}

impl MainAlbumJoinOrderProvider {
    pub fn new(album_id: String) -> Self {
        let q = ImageQuery::album_source(album_id.clone())
            .merge(&ImageQuery::sort_by_album_order(true));
        Self {
            album_id,
            inner: CommonProvider::with_query_and_mode(q, PaginationMode::SimplePage),
        }
    }

    fn order_asc_query(&self) -> ImageQuery {
        ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::sort_by_album_order(true))
    }
}

impl Provider for MainAlbumJoinOrderProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: self.order_asc_query(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![FsEntry::dir("desc")])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name != "desc" {
            return None;
        }
        let q = ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::sort_by_album_order(false));
        Some(Arc::new(CommonProvider::with_query_and_mode(
            q,
            PaginationMode::SimplePage,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// 画册内「仅设置过壁纸」分支（与 MainWallpaperOrderProvider 结构相同，查询限定在当前画册）
pub struct MainAlbumWallpaperOrderProvider {
    album_id: String,
    inner: CommonProvider,
}

impl MainAlbumWallpaperOrderProvider {
    pub fn new(album_id: String) -> Self {
        let q = ImageQuery::album_source(album_id.clone())
            .merge(&ImageQuery::wallpaper_set_filter())
            .merge(&ImageQuery::sort_by_wallpaper_set_at(true));
        Self {
            album_id,
            inner: CommonProvider::with_query_and_mode(q, PaginationMode::SimplePage),
        }
    }

    fn wallpaper_asc_query(&self) -> ImageQuery {
        ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::wallpaper_set_filter())
            .merge(&ImageQuery::sort_by_wallpaper_set_at(true))
    }
}

impl Provider for MainAlbumWallpaperOrderProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: self.wallpaper_asc_query(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![FsEntry::dir("desc")])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name != "desc" {
            return None;
        }
        let q = ImageQuery::album_source(self.album_id.clone())
            .merge(&ImageQuery::wallpaper_set_filter())
            .merge(&ImageQuery::sort_by_wallpaper_set_at(false));
        Some(Arc::new(CommonProvider::with_query_and_mode(
            q,
            PaginationMode::SimplePage,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// MainTaskGroupProvider：按任务分组
pub struct MainTaskGroupProvider {
    config: ProviderConfig,
}

impl MainTaskGroupProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }
}

impl Default for MainTaskGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainTaskGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::Task,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let tasks = Storage::global().get_tasks_with_images()?;
        Ok(tasks.into_iter().map(|(id, _)| FsEntry::dir(id)).collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name.trim().is_empty() {
            return None;
        }
        let task_exists = matches!(Storage::global().get_task(name), Ok(Some(_)));
        if !task_exists {
            return None;
        }
        Some(Arc::new(CommonProvider::with_query_and_mode(
            ImageQuery::by_task(name.to_string()),
            self.config.pagination_mode,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        // name 就是 task_id
        if name.trim().is_empty() {
            return ResolveChild::NotFound;
        }
        // 验证任务是否存在
        let task_exists = match Storage::global().get_task(name) {
            Ok(Some(_)) => true,
            _ => false,
        };
        if !task_exists {
            return ResolveChild::NotFound;
        }

        let provider = CommonProvider::with_query_and_mode(
            ImageQuery::by_task(name.to_string()),
            self.config.pagination_mode,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
    }
}

/// MainSurfGroupProvider：按畅游记录分组
pub struct MainSurfGroupProvider {
    config: ProviderConfig,
}

impl MainSurfGroupProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self { config }
    }
}

impl Default for MainSurfGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainSurfGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::Group {
            kind: ProviderGroupKind::Surf,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let records = Storage::global().get_surf_records_with_images()?;
        Ok(records.into_iter().map(|(id, _)| FsEntry::dir(id)).collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let id = name.trim();
        if id.is_empty() {
            return None;
        }
        if !Storage::global().surf_record_exists(id).ok()? {
            return None;
        }
        Some(
            Arc::new(MainSurfRecordProvider::new_with_config(id.to_string(), self.config))
                as Arc<dyn Provider>,
        )
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        let id = name.trim();
        if id.is_empty() {
            return ResolveChild::NotFound;
        }
        if !Storage::global().surf_record_exists(id).unwrap_or(false) {
            return ResolveChild::NotFound;
        }
        ResolveChild::Dynamic(
            Arc::new(MainSurfRecordProvider::new_with_config(id.to_string(), self.config))
                as Arc<dyn Provider>,
        )
    }
}

/// MainSurfRecordProvider：单个畅游记录，支持 desc 子目录与 page 动态子路径
pub struct MainSurfRecordProvider {
    query: ImageQuery,
    inner: CommonProvider,
    config: ProviderConfig,
}

impl MainSurfRecordProvider {
    pub fn new(surf_record_id: String) -> Self {
        Self::new_with_config(surf_record_id, ProviderConfig::gallery_default())
    }

    pub fn new_with_config(surf_record_id: String, config: ProviderConfig) -> Self {
        let query = ImageQuery::by_surf_record(surf_record_id);
        Self {
            inner: CommonProvider::with_query_and_mode(query.clone(), config.pagination_mode),
            query,
            config,
        }
    }
}

impl Provider for MainSurfRecordProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: self.query.clone(),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![FsEntry::dir(self.config.display_name("desc"))])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.config.canonical_name(name) != "desc" {
            return None;
        }
        Some(
            Arc::new(CommonProvider::with_query_and_mode(
                self.query.to_desc(),
                self.config.pagination_mode,
            )) as Arc<dyn Provider>,
        )
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

