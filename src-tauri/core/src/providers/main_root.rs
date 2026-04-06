//! MainProvider 体系：前端简单分页（与 DiskProvider 的贪心分解分离）
//!
//! - MainRootProvider：根目录，提供 all/plugin/date/date-range/album/task/media-type 入口
//! - MainGroupProvider 系列：各分组的动态子目录解析

use std::sync::Arc;

use crate::providers::common::{CommonProvider, PaginationMode, SimplePageProvider};
use crate::providers::config::ProviderConfig;
use crate::providers::main_date_browse::{list_main_date_browse_root_entries, main_date_child_provider};
use crate::providers::descriptor::{ProviderDescriptor, ProviderGroupKind};
use crate::providers::provider::{ListEntry, Provider};
use crate::providers::vd_names::parse_date_range_name;
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// VD 下「按插件」目录名：`{manifest 展示名} - {plugin_id}`；画廊 API 仍为纯 `plugin_id`。
fn vd_plugin_dir_name(config: ProviderConfig, plugin_id: &str) -> String {
    if config.locale.is_none() {
        return plugin_id.to_string();
    }
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    {
        if let Some(plugin_name) = crate::providers::plugin_display_name_from_manifest(plugin_id) {
            let n = plugin_name.trim();
            if !n.is_empty() {
                return format!("{} - {}", n, plugin_id);
            }
        }
    }
    plugin_id.to_string()
}

fn vd_resolve_plugin_id_from_dir_name(config: ProviderConfig, name: &str) -> &str {
    if config.locale.is_none() {
        return name.trim();
    }
    name.rsplit_once(" - ")
        .map(|(_, id)| id)
        .unwrap_or(name)
        .trim()
}

/// VD 下「按任务」目录名：`{插件展示名} - {task_id}`。
fn vd_task_dir_name(config: ProviderConfig, task_id: &str, plugin_id: &str) -> String {
    if config.locale.is_none() {
        return task_id.to_string();
    }
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    {
        let plugin_name = crate::providers::plugin_display_name_from_manifest(plugin_id)
            .unwrap_or_else(|| plugin_id.to_string());
        let n = plugin_name.trim();
        if n.is_empty() {
            task_id.to_string()
        } else {
            format!("{} - {}", n, task_id)
        }
    }
    #[cfg(any(kabegame_mode = "light", target_os = "android"))]
    {
        let _ = plugin_id;
        task_id.to_string()
    }
}

fn vd_resolve_task_id_from_dir_name(config: ProviderConfig, name: &str) -> &str {
    if config.locale.is_none() {
        return name.trim();
    }
    name.rsplit_once(" - ")
        .map(|(_, id)| id)
        .unwrap_or(name)
        .trim()
}

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
        ProviderDescriptor::GalleryRoot {
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn get_note(&self) -> Option<(String, String)> {
        self.config.locale?;
        let s = "在这里你可以自由查看图片.txt".to_string();
        Some((s.clone(), s))
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        Ok(vec![
            ListEntry::Child {
                name: self.config.display_name("all"),
                provider: Arc::new(MainAllProvider::new_with_config(self.config)) as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("wallpaper-order"),
                provider: Arc::new(MainWallpaperOrderProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("plugin"),
                provider: Arc::new(MainPluginGroupProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("date"),
                provider: Arc::new(MainDateGroupProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("date-range"),
                provider: Arc::new(MainDateRangeRootProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("album"),
                provider: Arc::new(MainAlbumsProvider::new_with_config(self.config)) as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("task"),
                provider: Arc::new(MainTaskGroupProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("surf"),
                provider: Arc::new(MainSurfGroupProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("media-type"),
                provider: Arc::new(MainMediaTypeGroupProvider::new_with_config(self.config))
                    as Arc<dyn Provider>,
            },
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
            inner: CommonProvider::with_query_and_config(
                ImageQuery::all_recent(),
                config,
            ),
        }
    }
}

impl Provider for MainAllProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.inner.descriptor()
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        self.inner.list_entries()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

}

/// MainWallpaperOrderProvider：按「最后一次设为壁纸」时间排序（正序根节点含图片；子目录为倒序，与旧 VD CommonProvider 一致）
pub struct MainWallpaperOrderProvider {
    inner: CommonProvider,
}

impl MainWallpaperOrderProvider {
    pub fn new() -> Self {
        Self::new_with_config(ProviderConfig::gallery_default())
    }

    pub fn new_with_config(config: ProviderConfig) -> Self {
        Self {
            inner: CommonProvider::with_query_and_config(
                ImageQuery::all_by_wallpaper_set(),
                config,
            ),
        }
    }
}

impl Provider for MainWallpaperOrderProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        self.inner.descriptor()
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        self.inner.list_entries()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
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
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn get_note(&self) -> Option<(String, String)> {
        self.config.locale?;
        let s = "这里记录了不同插件安装的所有图片.txt".to_string();
        Some((s.clone(), s))
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let groups = Storage::global().get_gallery_plugin_groups()?;
        Ok(groups
            .into_iter()
            .filter_map(|g| {
                let name = vd_plugin_dir_name(self.config, &g.plugin_id);
                self.get_child(&name)
                    .map(|provider| ListEntry::Child { name, provider })
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name.trim().is_empty() {
            return None;
        }
        let plugin_id = vd_resolve_plugin_id_from_dir_name(self.config, name);
        let groups = Storage::global().get_gallery_plugin_groups().ok()?;
        let exists = groups
            .iter()
            .any(|g| g.plugin_id.eq_ignore_ascii_case(plugin_id));
        if !exists {
            return None;
        }
        Some(Arc::new(CommonProvider::with_query_and_config(
            ImageQuery::by_plugin(plugin_id.to_string()),
            self.config,
        )) as Arc<dyn Provider>)
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
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        Ok(vec![
            ListEntry::Child {
                name: self.config.display_name("image"),
                provider: Arc::new(CommonProvider::with_query_and_config(
                    ImageQuery::by_media_type("image"),
                    self.config,
                )) as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("video"),
                provider: Arc::new(CommonProvider::with_query_and_config(
                    ImageQuery::by_media_type("video"),
                    self.config,
                )) as Arc<dyn Provider>,
            },
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let canonical = self.config.canonical_name(name);
        if canonical != "image" && canonical != "video" {
            return None;
        }
        Some(Arc::new(CommonProvider::with_query_and_config(
            ImageQuery::by_media_type(canonical),
            self.config,
        )) as Arc<dyn Provider>)
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
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn get_note(&self) -> Option<(String, String)> {
        self.config.locale?;
        let s = "这里按抓取时间归档图片（年→月→日，与画廊一致）.txt".to_string();
        Some((s.clone(), s))
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        list_main_date_browse_root_entries(self.config)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        main_date_child_provider(self.config.canonical_name(name), self.config)
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
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        Ok(Vec::new()) // 日期范围通过 get_child 动态提供
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let (start, end) = parse_date_range_name(name)?;
        Some(Arc::new(CommonProvider::with_query_and_config(
            ImageQuery::by_date_range(start, end),
            self.config,
        )) as Arc<dyn Provider>)
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
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let albums = Storage::global().get_albums(None)?;
        Ok(albums
            .into_iter()
            .filter_map(|a| {
                let name = if self.config.locale.is_some() {
                    a.name.clone()
                } else {
                    a.id.clone()
                };
                self.get_child(&name)
                    .map(|provider| ListEntry::Child { name, provider })
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name.trim().is_empty() {
            return None;
        }
        let id = if self.config.locale.is_some() {
            Storage::global()
                .find_child_album_by_name_ci(None, name)
                .ok()??
        } else {
            name.to_string()
        };
        if !Storage::global().album_exists(&id).ok()? {
            return None;
        }
        Some(Arc::new(MainAlbumEntryProvider::new_with_config(
            id,
            self.config,
        )) as Arc<dyn Provider>)
    }

}

/// Main 画册子树节点：`album/<id>/<子画册名>`（VD 下为翻译后的「子画册」目录名）。
/// - Gallery：不枚举子目录（前端动态导航）；`get_child` 按子画册 **ID** 解析。
/// - VD：列出直接子画册（按 **名称**）；`get_child` 按 **名称** 解析。
pub struct MainAlbumTreeProvider {
    album_id: String,
    config: ProviderConfig,
}

impl MainAlbumTreeProvider {
    pub fn new(album_id: String) -> Self {
        Self::new_with_config(album_id, ProviderConfig::gallery_default())
    }

    pub fn new_with_config(album_id: String, config: ProviderConfig) -> Self {
        Self { album_id, config }
    }
}

impl Provider for MainAlbumTreeProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::AlbumTree {
            album_id: self.album_id.clone(),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        if self.config.locale.is_none() {
            return Ok(Vec::new());
        }
        let children = Storage::global().get_albums(Some(&self.album_id))?;
        Ok(children
            .into_iter()
            .filter_map(|a| {
                let name = a.name.clone();
                self.get_child(&name)
                    .map(|provider| ListEntry::Child { name, provider })
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name.trim().is_empty() {
            return None;
        }
        let child_id = if self.config.locale.is_some() {
            Storage::global()
                .find_child_album_by_name_ci(Some(&self.album_id), name)
                .ok()??
        } else {
            let album = Storage::global().get_album_by_id(name).ok()??;
            if album.parent_id.as_deref() != Some(&self.album_id) {
                return None;
            }
            name.to_string()
        };
        Some(Arc::new(MainAlbumEntryProvider::new_with_config(
            child_id,
            self.config,
        )) as Arc<dyn Provider>)
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

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let mut entries = vec![
            ListEntry::Child {
                name: self.config.display_name("tree"),
                provider: Arc::new(MainAlbumTreeProvider::new_with_config(
                    self.album_id.clone(),
                    self.config,
                )) as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("desc"),
                provider: Arc::new(CommonProvider::with_query_and_config(
                    ImageQuery::album_source(self.album_id.clone())
                        .merge(&ImageQuery::sort_by_crawled_at(false)),
                    self.config,
                )) as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("album-order"),
                provider: Arc::new(MainAlbumJoinOrderProvider::new(
                    self.album_id.clone(),
                    self.config,
                ))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("wallpaper-order"),
                provider: Arc::new(MainAlbumWallpaperOrderProvider::new(
                    self.album_id.clone(),
                    self.config,
                ))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("image-only"),
                provider: Arc::new(MainAlbumMediaEntryProvider::new(
                    self.album_id.clone(),
                    "image",
                    self.config,
                ))
                    as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("video-only"),
                provider: Arc::new(MainAlbumMediaEntryProvider::new(
                    self.album_id.clone(),
                    "video",
                    self.config,
                ))
                    as Arc<dyn Provider>,
            },
        ];

        // VD (Greedy) 模式：追加图片/范围条目（与旧 AlbumProvider 一致）
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.time_asc_query(), self.config);
            let desc_name = self.config.display_name("desc");
            for entry in inner.list_entries()? {
                if let ListEntry::Child { ref name, .. } = entry {
                    if *name == desc_name {
                        continue;
                    }
                }
                entries.push(entry);
            }
        }

        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match self.config.canonical_name(name) {
            "tree" => Some(Arc::new(MainAlbumTreeProvider::new_with_config(
                self.album_id.clone(),
                self.config,
            )) as Arc<dyn Provider>),
            "desc" => Some(Arc::new(CommonProvider::with_query_and_config(
                ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::sort_by_crawled_at(false)),
                self.config,
            )) as Arc<dyn Provider>),
            "album-order" => Some(
                Arc::new(MainAlbumJoinOrderProvider::new(self.album_id.clone(), self.config))
                    as Arc<dyn Provider>,
            ),
            "wallpaper-order" => Some(
                Arc::new(MainAlbumWallpaperOrderProvider::new(self.album_id.clone(), self.config))
                    as Arc<dyn Provider>,
            ),
            "image-only" => Some(
                Arc::new(MainAlbumMediaEntryProvider::new(
                    self.album_id.clone(),
                    "image",
                    self.config,
                ))
                    as Arc<dyn Provider>,
            ),
            "video-only" => Some(
                Arc::new(MainAlbumMediaEntryProvider::new(
                    self.album_id.clone(),
                    "video",
                    self.config,
                ))
                    as Arc<dyn Provider>,
            ),
            _ => {
                // VD (Greedy): delegate range/image names to CommonProvider
                if self.config.pagination_mode == PaginationMode::Greedy {
                    let inner = CommonProvider::with_query_and_config(self.time_asc_query(), self.config);
                    return inner.get_child(name);
                }
                // Gallery (SimplePage): parse page number
                if let Ok(page) = name.parse::<usize>() {
                    if page > 0 {
                        let q = self.time_asc_query();
                        return Some(Arc::new(SimplePageProvider::new(q, page)) as Arc<dyn Provider>);
                    }
                }
                None
            }
        }
    }

    fn can_delete_child(&self, _child_name: &str) -> bool {
        self.config.pagination_mode == PaginationMode::Greedy
    }

    fn delete_child(&self, child_name: &str) -> Result<(), String> {
        let removed = crate::providers::vd_ops::delete_child_file_by_album(&self.album_id, child_name)?;
        if removed {
            Ok(())
        } else {
            Err("图片不存在或不在该画册中".to_string())
        }
    }
}

/// 画册内仅图片或仅视频：子路径语义与 [`MainAlbumEntryProvider`] 一致
pub struct MainAlbumMediaEntryProvider {
    album_id: String,
    media_type: &'static str,
    config: ProviderConfig,
}

impl MainAlbumMediaEntryProvider {
    pub fn new(album_id: String, media_type: &'static str, config: ProviderConfig) -> Self {
        Self {
            album_id,
            media_type,
            config,
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

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let mut entries = vec![
            ListEntry::Child {
                name: self.config.display_name("desc"),
                provider: Arc::new(CommonProvider::with_query_and_config(
                    ImageQuery::album_source(self.album_id.clone())
                        .merge(&ImageQuery::media_type_filter(self.media_type))
                        .merge(&ImageQuery::sort_by_crawled_at(false)),
                    self.config,
                )) as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("album-order"),
                provider: Arc::new(MainAlbumMediaJoinOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                    self.config,
                )) as Arc<dyn Provider>,
            },
            ListEntry::Child {
                name: self.config.display_name("wallpaper-order"),
                provider: Arc::new(MainAlbumMediaWallpaperOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                    self.config,
                )) as Arc<dyn Provider>,
            },
        ];
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.time_asc_query(), self.config);
            let desc_name = self.config.display_name("desc");
            for entry in inner.list_entries()? {
                if let ListEntry::Child { ref name, .. } = entry {
                    if *name == desc_name {
                        continue;
                    }
                }
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match self.config.canonical_name(name) {
            "desc" => Some(Arc::new(CommonProvider::with_query_and_config(
                ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::media_type_filter(self.media_type))
                    .merge(&ImageQuery::sort_by_crawled_at(false)),
                self.config,
            )) as Arc<dyn Provider>),
            "album-order" => Some(
                Arc::new(MainAlbumMediaJoinOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                    self.config,
                )) as Arc<dyn Provider>,
            ),
            "wallpaper-order" => Some(
                Arc::new(MainAlbumMediaWallpaperOrderProvider::new(
                    self.album_id.clone(),
                    self.media_type,
                    self.config,
                )) as Arc<dyn Provider>,
            ),
            _ => {
                if self.config.pagination_mode == PaginationMode::Greedy {
                    let inner =
                        CommonProvider::with_query_and_config(self.time_asc_query(), self.config);
                    return inner.get_child(name);
                }
                if let Ok(page) = name.parse::<usize>() {
                    if page > 0 {
                        let q = self.time_asc_query();
                        return Some(Arc::new(SimplePageProvider::new(q, page)) as Arc<dyn Provider>);
                    }
                }
                None
            }
        }
    }
}

/// 画册内「仅某媒体类型」+ 按加入顺序排序
pub struct MainAlbumMediaJoinOrderProvider {
    album_id: String,
    media_type: &'static str,
    config: ProviderConfig,
}

impl MainAlbumMediaJoinOrderProvider {
    pub fn new(album_id: String, media_type: &'static str, config: ProviderConfig) -> Self {
        Self {
            album_id,
            media_type,
            config,
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

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let mut entries = vec![ListEntry::Child {
            name: self.config.display_name("desc"),
            provider: Arc::new(CommonProvider::with_query_and_config(
                ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::media_type_filter(self.media_type))
                    .merge(&ImageQuery::sort_by_album_order(false)),
                self.config,
            )) as Arc<dyn Provider>,
        }];
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.order_asc_query(), self.config);
            let desc_name = self.config.display_name("desc");
            for entry in inner.list_entries()? {
                if let ListEntry::Child { ref name, .. } = entry {
                    if *name == desc_name {
                        continue;
                    }
                }
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.config.canonical_name(name) == "desc" {
            let q = ImageQuery::album_source(self.album_id.clone())
                .merge(&ImageQuery::media_type_filter(self.media_type))
                .merge(&ImageQuery::sort_by_album_order(false));
            return Some(Arc::new(CommonProvider::with_query_and_config(
                q,
                self.config,
            )) as Arc<dyn Provider>);
        }
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.order_asc_query(), self.config);
            return inner.get_child(name);
        }
        None
    }

}

/// 画册内「仅某媒体类型」+ 仅设过壁纸
pub struct MainAlbumMediaWallpaperOrderProvider {
    album_id: String,
    media_type: &'static str,
    config: ProviderConfig,
}

impl MainAlbumMediaWallpaperOrderProvider {
    pub fn new(album_id: String, media_type: &'static str, config: ProviderConfig) -> Self {
        Self {
            album_id,
            media_type,
            config,
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

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let mut entries = vec![ListEntry::Child {
            name: self.config.display_name("desc"),
            provider: Arc::new(CommonProvider::with_query_and_config(
                ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::media_type_filter(self.media_type))
                    .merge(&ImageQuery::wallpaper_set_filter())
                    .merge(&ImageQuery::sort_by_wallpaper_set_at(false)),
                self.config,
            )) as Arc<dyn Provider>,
        }];
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.wallpaper_asc_query(), self.config);
            let desc_name = self.config.display_name("desc");
            for entry in inner.list_entries()? {
                if let ListEntry::Child { ref name, .. } = entry {
                    if *name == desc_name {
                        continue;
                    }
                }
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.config.canonical_name(name) == "desc" {
            let q = ImageQuery::album_source(self.album_id.clone())
                .merge(&ImageQuery::media_type_filter(self.media_type))
                .merge(&ImageQuery::wallpaper_set_filter())
                .merge(&ImageQuery::sort_by_wallpaper_set_at(false));
            return Some(Arc::new(CommonProvider::with_query_and_config(
                q,
                self.config,
            )) as Arc<dyn Provider>);
        }
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner =
                CommonProvider::with_query_and_config(self.wallpaper_asc_query(), self.config);
            return inner.get_child(name);
        }
        None
    }

}

/// 画册内按 `album_images.order`（加入顺序）排序
pub struct MainAlbumJoinOrderProvider {
    album_id: String,
    config: ProviderConfig,
}

impl MainAlbumJoinOrderProvider {
    pub fn new(album_id: String, config: ProviderConfig) -> Self {
        Self { album_id, config }
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

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let mut entries = vec![ListEntry::Child {
            name: self.config.display_name("desc"),
            provider: Arc::new(CommonProvider::with_query_and_config(
                ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::sort_by_album_order(false)),
                self.config,
            )) as Arc<dyn Provider>,
        }];
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.order_asc_query(), self.config);
            let desc_name = self.config.display_name("desc");
            for entry in inner.list_entries()? {
                if let ListEntry::Child { ref name, .. } = entry {
                    if *name == desc_name {
                        continue;
                    }
                }
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.config.canonical_name(name) == "desc" {
            let q = ImageQuery::album_source(self.album_id.clone())
                .merge(&ImageQuery::sort_by_album_order(false));
            return Some(Arc::new(CommonProvider::with_query_and_config(
                q,
                self.config,
            )) as Arc<dyn Provider>);
        }
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.order_asc_query(), self.config);
            return inner.get_child(name);
        }
        None
    }

}

/// 画册内「仅设置过壁纸」分支（与 MainWallpaperOrderProvider 结构相同，查询限定在当前画册）
pub struct MainAlbumWallpaperOrderProvider {
    album_id: String,
    config: ProviderConfig,
}

impl MainAlbumWallpaperOrderProvider {
    pub fn new(album_id: String, config: ProviderConfig) -> Self {
        Self { album_id, config }
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

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let mut entries = vec![ListEntry::Child {
            name: self.config.display_name("desc"),
            provider: Arc::new(CommonProvider::with_query_and_config(
                ImageQuery::album_source(self.album_id.clone())
                    .merge(&ImageQuery::wallpaper_set_filter())
                    .merge(&ImageQuery::sort_by_wallpaper_set_at(false)),
                self.config,
            )) as Arc<dyn Provider>,
        }];
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner = CommonProvider::with_query_and_config(self.wallpaper_asc_query(), self.config);
            let desc_name = self.config.display_name("desc");
            for entry in inner.list_entries()? {
                if let ListEntry::Child { ref name, .. } = entry {
                    if *name == desc_name {
                        continue;
                    }
                }
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.config.canonical_name(name) == "desc" {
            let q = ImageQuery::album_source(self.album_id.clone())
                .merge(&ImageQuery::wallpaper_set_filter())
                .merge(&ImageQuery::sort_by_wallpaper_set_at(false));
            return Some(Arc::new(CommonProvider::with_query_and_config(
                q,
                self.config,
            )) as Arc<dyn Provider>);
        }
        if self.config.pagination_mode == PaginationMode::Greedy {
            let inner =
                CommonProvider::with_query_and_config(self.wallpaper_asc_query(), self.config);
            return inner.get_child(name);
        }
        None
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
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn get_note(&self) -> Option<(String, String)> {
        self.config.locale?;
        let s = "这里按任务归档图片（目录名含插件名与任务ID，可删除任务目录）.txt".to_string();
        Some((s.clone(), s))
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let tasks = Storage::global().get_tasks_with_images()?;
        Ok(tasks
            .into_iter()
            .filter_map(|(id, plugin_id)| {
                let name = vd_task_dir_name(self.config, &id, &plugin_id);
                self.get_child(&name)
                    .map(|provider| ListEntry::Child { name, provider })
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name.trim().is_empty() {
            return None;
        }
        let task_id = vd_resolve_task_id_from_dir_name(self.config, name);
        let task_exists = matches!(Storage::global().get_task(task_id), Ok(Some(_)));
        if !task_exists {
            return None;
        }
        Some(Arc::new(CommonProvider::with_query_and_config(
            ImageQuery::by_task(task_id.to_string()),
            self.config,
        )) as Arc<dyn Provider>)
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
            locale: self.config.locale.map(|s| s.to_string()),
        }
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        let records = Storage::global().get_surf_records_with_images()?;
        Ok(records
            .into_iter()
            .filter_map(|(id, _)| {
                self.get_child(&id)
                    .map(|provider| ListEntry::Child { name: id, provider })
            })
            .collect())
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

}

/// MainSurfRecordProvider：单个畅游记录，支持 desc 子目录与 page 动态子路径
pub struct MainSurfRecordProvider {
    query: ImageQuery,
    config: ProviderConfig,
}

impl MainSurfRecordProvider {
    pub fn new(surf_record_id: String) -> Self {
        Self::new_with_config(surf_record_id, ProviderConfig::gallery_default())
    }

    pub fn new_with_config(surf_record_id: String, config: ProviderConfig) -> Self {
        let query = ImageQuery::by_surf_record(surf_record_id);
        Self {
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

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        Ok(vec![ListEntry::Child {
            name: self.config.display_name("desc"),
            provider: Arc::new(CommonProvider::with_query_and_config(
                self.query.to_desc(),
                self.config,
            )) as Arc<dyn Provider>,
        }])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if self.config.canonical_name(name) != "desc" {
            return None;
        }
        Some(
            Arc::new(CommonProvider::with_query_and_config(
                self.query.to_desc(),
                self.config,
            )) as Arc<dyn Provider>,
        )
    }

}

