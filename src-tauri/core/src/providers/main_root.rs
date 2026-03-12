//! MainProvider 体系：前端简单分页（与 DiskProvider 的贪心分解分离）
//!
//! - MainRootProvider：根目录，提供 all/plugin/date/date-range/album/task 入口
//! - MainGroupProvider 系列：各分组的动态子目录解析

use std::sync::Arc;

use crate::providers::common::{CommonProvider, PaginationMode};
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

/// MainDateGroupProvider：按月份分组
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
        // 返回所有年月的目录列表
        let groups = Storage::global().get_gallery_date_groups()?;
        Ok(groups
            .into_iter()
            .map(|g| FsEntry::dir(g.year_month))
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        // name 就是 yyyy-mm
        let groups = Storage::global().get_gallery_date_groups().ok()?;
        let exists = groups.iter().any(|g| g.year_month == name);
        if !exists {
            return None;
        }

        Some(Arc::new(CommonProvider::with_query_and_mode(
            ImageQuery::by_date(name.to_string()),
            PaginationMode::SimplePage,
        )) as Arc<dyn Provider>)
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

fn parse_range_name(s: &str) -> Option<(String, String)> {
    let raw = s.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.split('~').collect();
    if parts.len() != 2 {
        return None;
    }
    let start = parts[0].trim();
    let end = parts[1].trim();
    if start.len() != 10 || end.len() != 10 {
        return None;
    }
    // 仅做轻量校验：YYYY-MM-DD
    if !start.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !start.as_bytes().get(7).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(7).is_some_and(|c| *c == b'-')
    {
        return None;
    }
    Some((start.to_string(), end.to_string()))
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

        let provider = CommonProvider::with_query_and_mode(
            ImageQuery::by_album(id.to_string()),
            PaginationMode::SimplePage,
        );
        ResolveChild::Dynamic(Arc::new(provider) as Arc<dyn Provider>)
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
    surf_record_id: String,
    inner: CommonProvider,
}

impl MainSurfRecordProvider {
    pub fn new(surf_record_id: String) -> Self {
        Self {
            inner: CommonProvider::with_query_and_mode(
                ImageQuery::by_surf_record(surf_record_id.clone()),
                PaginationMode::SimplePage,
            ),
            surf_record_id,
        }
    }
}

impl Provider for MainSurfRecordProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::SimpleAll {
            query: ImageQuery::by_surf_record(self.surf_record_id.clone()),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![FsEntry::dir("desc")])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name != "desc" {
            return None;
        }
        Some(Arc::new(MainSurfRecordDescProvider::new(
            self.surf_record_id.clone(),
        )) as Arc<dyn Provider>)
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        self.inner.resolve_child(name)
    }
}

/// MainSurfRecordDescProvider：单个畅游记录的倒序视图
pub struct MainSurfRecordDescProvider {
    inner: CommonProvider,
}

impl MainSurfRecordDescProvider {
    pub fn new(surf_record_id: String) -> Self {
        Self {
            inner: CommonProvider::with_query_and_mode(
                ImageQuery::by_surf_record_desc(surf_record_id),
                PaginationMode::SimplePage,
            ),
        }
    }
}

impl Provider for MainSurfRecordDescProvider {
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
