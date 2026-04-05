//! Provider 工厂：根据描述符重建 Provider（避免用 id 引用导致内存膨胀）。

use std::sync::Arc;

use crate::providers::descriptor::{ProviderDescriptor, ProviderGroupKind};
use crate::providers::provider::Provider;
use crate::providers::{
    CommonProvider,
    config::ProviderConfig,
    main_date_scoped::MainDateScopedProvider,
    main_root::{
        MainAlbumsProvider, MainDateGroupProvider, MainDateRangeRootProvider,
        MainMediaTypeGroupProvider, MainPluginGroupProvider, MainRootProvider,
        MainSurfGroupProvider, MainTaskGroupProvider,
    },
    UnifiedRootProvider, VdRootProvider,
};

pub struct ProviderFactory;

impl ProviderFactory {
    pub fn build(desc: &ProviderDescriptor) -> Arc<dyn Provider> {
        match desc {
            ProviderDescriptor::UnifiedRoot => Arc::new(UnifiedRootProvider),
            ProviderDescriptor::GalleryRoot => Arc::new(MainRootProvider {
                config: ProviderConfig::gallery_default(),
            }),
            ProviderDescriptor::VdRoot => Arc::new(VdRootProvider::new()),
            ProviderDescriptor::Group { kind } => match kind {
                ProviderGroupKind::Plugin => Arc::new(MainPluginGroupProvider::new()),
                ProviderGroupKind::Date => Arc::new(MainDateGroupProvider::new()),
                ProviderGroupKind::DateRange => Arc::new(MainDateRangeRootProvider::new()),
                ProviderGroupKind::Album => Arc::new(MainAlbumsProvider::new()),
                ProviderGroupKind::Task => Arc::new(MainTaskGroupProvider::new()),
                ProviderGroupKind::Surf => Arc::new(MainSurfGroupProvider::new()),
                ProviderGroupKind::MediaType => Arc::new(MainMediaTypeGroupProvider::new()),
            },

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
            ProviderDescriptor::DateScoped { query, tier } => Arc::new(
                MainDateScopedProvider::from_query_and_tier(query.clone(), tier.clone()),
            ),
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
