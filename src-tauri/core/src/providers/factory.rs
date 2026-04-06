//! Provider 工厂：根据描述符重建 Provider（避免用 id 引用导致内存膨胀）。

use std::sync::Arc;

use crate::providers::descriptor::{ProviderDescriptor, ProviderGroupKind};
use crate::providers::provider::Provider;
use crate::providers::{
    CommonProvider,
    albums::VdAlbumTreeProvider,
    config::ProviderConfig,
    main_date_scoped::MainDateScopedProvider,
    main_root::{
        MainAlbumsProvider, MainAlbumTreeProvider, MainDateGroupProvider, MainDateRangeRootProvider,
        MainMediaTypeGroupProvider, MainPluginGroupProvider, MainRootProvider,
        MainSurfGroupProvider, MainTaskGroupProvider,
    },
    UnifiedRootProvider, VdRootProvider,
};

pub struct ProviderFactory;

impl ProviderFactory {
    /// 从持久化 locale 字符串还原为 `&'static str`（仅允许已知 locale 段）。
    fn locale_to_static(locale: &Option<String>) -> Option<&'static str> {
        match locale.as_deref() {
            Some("zh") => Some("zh"),
            Some("en") => Some("en"),
            Some("ja") => Some("ja"),
            Some("ko") => Some("ko"),
            Some("zhtw") => Some("zhtw"),
            _ => None,
        }
    }

    fn config_from_locale(locale: &Option<String>) -> ProviderConfig {
        match Self::locale_to_static(locale) {
            Some(loc) => ProviderConfig::vd_with_locale(loc),
            None => ProviderConfig::gallery_default(),
        }
    }

    pub fn build(desc: &ProviderDescriptor) -> Arc<dyn Provider> {
        match desc {
            ProviderDescriptor::UnifiedRoot => Arc::new(UnifiedRootProvider),
            ProviderDescriptor::GalleryRoot { locale } => Arc::new(MainRootProvider {
                config: Self::config_from_locale(locale),
            }),
            ProviderDescriptor::VdRoot => Arc::new(VdRootProvider::new()),
            ProviderDescriptor::Group { kind, locale } => {
                let config = Self::config_from_locale(locale);
                match kind {
                    ProviderGroupKind::Plugin => Arc::new(MainPluginGroupProvider::new_with_config(config)),
                    ProviderGroupKind::Date => Arc::new(MainDateGroupProvider::new_with_config(config)),
                    ProviderGroupKind::DateRange => Arc::new(MainDateRangeRootProvider::new_with_config(config)),
                    ProviderGroupKind::Album => Arc::new(MainAlbumsProvider::new_with_config(config)),
                    ProviderGroupKind::Task => Arc::new(MainTaskGroupProvider::new_with_config(config)),
                    ProviderGroupKind::Surf => Arc::new(MainSurfGroupProvider::new_with_config(config)),
                    ProviderGroupKind::MediaType => Arc::new(MainMediaTypeGroupProvider::new_with_config(config)),
                }
            }

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
                MainDateScopedProvider::from_query_and_tier(
                    query.clone(),
                    tier.clone(),
                    ProviderConfig::gallery_default(),
                ),
            ),
            ProviderDescriptor::SimpleAll { query } => Arc::new(CommonProvider::with_query_and_mode(
                query.clone(),
                crate::providers::common::PaginationMode::SimplePage,
            )),
            ProviderDescriptor::SimplePage { query, page } => Arc::new(crate::providers::common::SimplePageProvider::new(
                query.clone(),
                *page,
            )),
            ProviderDescriptor::AlbumTree { album_id } => {
                Arc::new(MainAlbumTreeProvider::new(album_id.clone()))
            }
            ProviderDescriptor::VdAlbumTree { album_id } => {
                Arc::new(VdAlbumTreeProvider::new(album_id.clone()))
            }
        }
    }
}
