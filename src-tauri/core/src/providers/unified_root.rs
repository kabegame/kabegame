use std::sync::Arc;

use crate::providers::config::ProviderConfig;
use crate::providers::descriptor::ProviderDescriptor;
use crate::providers::main_root::MainRootProvider;
use crate::providers::provider::{ListEntry, Provider};

const SUPPORTED_VD_LOCALES: &[&str] = &["zh", "en", "ja", "ko", "zhtw"];

/// 统一根：`/gallery` + `/vd`
#[derive(Clone, Default)]
pub struct UnifiedRootProvider;

impl Provider for UnifiedRootProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::UnifiedRoot
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        Ok(vec![
            ListEntry::Child {
                name: "gallery".to_string(),
                provider: Arc::new(MainRootProvider {
                    config: ProviderConfig::gallery_default(),
                }),
            },
            ListEntry::Child {
                name: "vd".to_string(),
                provider: Arc::new(VdRootProvider::new()),
            },
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match name {
            "gallery" => Some(
                Arc::new(MainRootProvider {
                    config: ProviderConfig::gallery_default(),
                })
                    as Arc<dyn Provider>,
            ),
            "vd" => Some(Arc::new(VdRootProvider::new()) as Arc<dyn Provider>),
            _ => None,
        }
    }
}

/// VD 根：`/vd/{locale}/...`
#[derive(Clone, Default)]
pub struct VdRootProvider;

impl VdRootProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Provider for VdRootProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::VdRoot
    }

    fn list_entries(&self) -> Result<Vec<ListEntry>, String> {
        Ok(SUPPORTED_VD_LOCALES
            .iter()
            .map(|locale| ListEntry::Child {
                name: (*locale).to_string(),
                provider: Arc::new(MainRootProvider {
                    config: ProviderConfig::vd_with_locale(locale),
                }),
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let locale = SUPPORTED_VD_LOCALES.iter().find(|locale| **locale == name)?;
        let config = ProviderConfig::vd_with_locale(locale);
        Some(Arc::new(MainRootProvider { config }) as Arc<dyn Provider>)
    }
}
