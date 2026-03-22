//! MainProvider 体系：前端简单分页（与 DiskProvider 的贪心分解分离）
//!
//! - MainRootProvider：根目录，提供 all/plugin/date/date-range/album/task 入口
//! - MainGroupProvider 系列：各分组的动态子目录解析

use std::sync::Arc;

use crate::providers::common::{CommonProvider, PaginationMode, SimplePageProvider};
use crate::providers::date_group::parse_range_name;
use crate::providers::main_date_browse::{list_main_date_browse_root_entries, main_date_child_provider};
use crate::providers::descriptor::{MainGroupKind, ProviderDescriptor};
use crate::providers::provider::{FsEntry, Provider, ResolveChild};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// MainProvider 根目录
#[derive(Clone, Default)]
pub struct MainRootProvider;

impl MainRootProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Provider for MainRootProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::MainRoot
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir("all"),
            FsEntry::dir("wallpaper-order"),
            FsEntry::dir("plugin"),
            FsEntry::dir("date"),
            FsEntry::dir("date-range"),
            FsEntry::dir("album"),
            FsEntry::dir("task"),
            FsEntry::dir("surf"),
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match name {
            "all" => Some(Arc::new(MainAllProvider::new()) as Arc<dyn Provider>),
            "wallpaper-order" => {
                Some(Arc::new(MainWallpaperOrderProvider::new()) as Arc<dyn Provider>)
            }
            "plugin" => Some(Arc::new(MainPluginGroupProvider::new()) as Arc<dyn Provider>),
            "date" => Some(Arc::new(MainDateGroupProvider::new()) as Arc<dyn Provider>),
            "date-range" => Some(Arc::new(MainDateRangeRootProvider::new()) as Arc<dyn Provider>),
            "album" => Some(Arc::new(MainAlbumsProvider::new()) as Arc<dyn Provider>),
            "task" => Some(Arc::new(MainTaskGroupProvider::new()) as Arc<dyn Provider>),
            "surf" => Some(Arc::new(MainSurfGroupProvider::new()) as Arc<dyn Provider>),
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
        Self {
            inner: CommonProvider::with_query_and_mode(
                ImageQuery::all_recent(),
                PaginationMode::SimplePage,
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
}

impl MainWallpaperOrderProvider {
    pub fn new() -> Self {
        Self {
            inner: CommonProvider::with_query_and_mode(
                ImageQuery::all_by_wallpaper_set(),
                PaginationMode::SimplePage,
            ),
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
        Ok(vec![FsEntry::dir("desc")])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name != "desc" {
            return None;
        }
        let query = ImageQuery::all_by_wallpaper_set().to_desc();
        Some(Arc::new(CommonProvider::with_query_and_mode(
            query,
            PaginationMode::SimplePage,
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// MainPluginGroupProvider：按插件分组
pub struct MainPluginGroupProvider;

impl MainPluginGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MainPluginGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainPluginGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::MainGroup {
            kind: MainGroupKind::Plugin,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(Vec::new()) // 插件列表通过 resolve_child 动态提供
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
            PaginationMode::SimplePage,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
    }
}

/// MainDateGroupProvider：`date/` 根为**年份**目录，子级为 `MainDateScopedProvider`（与画廊 `date/*` 一致）。
pub struct MainDateGroupProvider;

impl MainDateGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MainDateGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainDateGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::MainGroup {
            kind: MainGroupKind::Date,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        list_main_date_browse_root_entries()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        main_date_child_provider(name)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        match main_date_child_provider(name) {
            Some(p) => ResolveChild::Dynamic(p),
            None => ResolveChild::NotFound,
        }
    }
}

/// MainDateRangeRootProvider：按日期范围分组
pub struct MainDateRangeRootProvider;

impl MainDateRangeRootProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MainDateRangeRootProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainDateRangeRootProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::MainGroup {
            kind: MainGroupKind::DateRange,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(Vec::new()) // 日期范围通过 resolve_child 动态提供
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        // name: "YYYY-MM-DD~YYYY-MM-DD"
        let Some((start, end)) = parse_range_name(name) else {
            return ResolveChild::NotFound;
        };

        let provider = CommonProvider::with_query_and_mode(
            ImageQuery::by_date_range(start, end),
            PaginationMode::SimplePage,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
    }
}

/// MainAlbumsProvider：画册分组
pub struct MainAlbumsProvider;

impl MainAlbumsProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MainAlbumsProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainAlbumsProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::MainGroup {
            kind: MainGroupKind::Album,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(Vec::new()) // 画册列表通过 resolve_child 动态提供
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
            Arc::new(MainAlbumEntryProvider::new(id.to_string())) as Arc<dyn Provider>,
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
pub struct MainAlbumEntryProvider {
    album_id: String,
}

impl MainAlbumEntryProvider {
    pub fn new(album_id: String) -> Self {
        Self { album_id }
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
            FsEntry::dir("desc"),
            FsEntry::dir("album-order"),
            FsEntry::dir("wallpaper-order"),
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match name {
            "desc" => {
                let q = ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::sort_by_crawled_at(false));
                Some(Arc::new(CommonProvider::with_query_and_mode(
                    q,
                    PaginationMode::SimplePage,
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
            _ => None,
        }
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        match name {
            "desc" => {
                let q = ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::sort_by_crawled_at(false));
                ResolveChild::Dynamic(Arc::new(CommonProvider::with_query_and_mode(
                    q,
                    PaginationMode::SimplePage,
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
pub struct MainTaskGroupProvider;

impl MainTaskGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MainTaskGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainTaskGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::MainGroup {
            kind: MainGroupKind::Task,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(Vec::new()) // 任务列表通过 resolve_child 动态提供
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
            PaginationMode::SimplePage,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
    }
}

/// MainSurfGroupProvider：按畅游记录分组
pub struct MainSurfGroupProvider;

impl MainSurfGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MainSurfGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MainSurfGroupProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::MainGroup {
            kind: MainGroupKind::Surf,
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(Vec::new()) // 畅游列表通过 resolve_child 动态提供
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        let id = name.trim();
        if id.is_empty() {
            return ResolveChild::NotFound;
        }
        if !Storage::global().surf_record_exists(id).unwrap_or(false) {
            return ResolveChild::NotFound;
        }
        ResolveChild::Dynamic(Arc::new(MainSurfRecordProvider::new(id.to_string())) as Arc<dyn Provider>)
    }
}

/// MainSurfRecordProvider：单个畅游记录，支持 desc 子目录与 page 动态子路径
pub struct MainSurfRecordProvider {
    query: ImageQuery,
    inner: CommonProvider,
}

impl MainSurfRecordProvider {
    pub fn new(surf_record_id: String) -> Self {
        let query = ImageQuery::by_surf_record(surf_record_id);
        Self {
            inner: CommonProvider::with_query_and_mode(query.clone(), PaginationMode::SimplePage),
            query,
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
        Ok(vec![FsEntry::dir("desc")])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name != "desc" {
            return None;
        }
        Some(
            Arc::new(CommonProvider::with_query_and_mode(
                self.query.to_desc(),
                PaginationMode::SimplePage,
            )) as Arc<dyn Provider>,
        )
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

