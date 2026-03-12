//! Provider 工厂：根据描述符重建 Provider（避免用 id 引用导致内存膨胀）。

use std::sync::Arc;

use crate::providers::descriptor::{MainGroupKind, ProviderDescriptor};
use crate::providers::provider::Provider;
use crate::providers::{
    AlbumsProvider, CommonProvider, DateGroupProvider, DateRangeRootProvider,
    main_root::{
        MainAlbumsProvider, MainDateGroupProvider, MainDateRangeRootProvider,
        MainPluginGroupProvider, MainRootProvider, MainSurfGroupProvider, MainTaskGroupProvider,
    },
    PluginGroupProvider, RootProvider, SurfGroupProvider, TaskGroupProvider,
};

pub struct ProviderFactory;

impl ProviderFactory {
    pub fn build(desc: &ProviderDescriptor) -> Arc<dyn Provider> {
        match desc {
            ProviderDescriptor::Root => Arc::new(RootProvider::default()),

            ProviderDescriptor::Albums => Arc::new(AlbumsProvider::new()),
            ProviderDescriptor::Album { album_id } => Arc::new(
                crate::providers::albums::AlbumProvider::new(album_id.clone()),
            ),

            ProviderDescriptor::PluginGroup => Arc::new(PluginGroupProvider::new()),
            ProviderDescriptor::DateGroup => Arc::new(DateGroupProvider::new()),
            ProviderDescriptor::DateRangeRoot => Arc::new(DateRangeRootProvider::new()),
            ProviderDescriptor::TaskGroup => Arc::new(TaskGroupProvider::new()),
            ProviderDescriptor::SurfGroup => Arc::new(SurfGroupProvider::new()),

            ProviderDescriptor::All { query } => {
                Arc::new(CommonProvider::with_query(query.clone()))
            }

            ProviderDescriptor::Range {
                query,
                offset,
                count,
                depth,
            } => Arc::new(crate::providers::common::RangeProvider::new(
                query.clone(),
                *offset,
                *count,
                *depth,
            )),

            // 新增：MainProvider 体系
            ProviderDescriptor::MainRoot => Arc::new(MainRootProvider::new()),
            ProviderDescriptor::MainGroup { kind } => {
                match kind {
                    MainGroupKind::Plugin => Arc::new(MainPluginGroupProvider::new()),
                    MainGroupKind::Date => Arc::new(MainDateGroupProvider::new()),
                    MainGroupKind::DateRange => Arc::new(MainDateRangeRootProvider::new()),
                    MainGroupKind::Album => Arc::new(MainAlbumsProvider::new()),
                    MainGroupKind::Task => Arc::new(MainTaskGroupProvider::new()),
                    MainGroupKind::Surf => Arc::new(MainSurfGroupProvider::new()),
                }
            }
            ProviderDescriptor::SimpleAll { query } => Arc::new(CommonProvider::with_query_and_mode(
                query.clone(),
                crate::providers::common::PaginationMode::SimplePage,
            )),
            ProviderDescriptor::SimplePage { query, page } => Arc::new(crate::providers::common::SimplePageProvider::new(
                query.clone(),
                *page,
            )),
        }
    }
}
