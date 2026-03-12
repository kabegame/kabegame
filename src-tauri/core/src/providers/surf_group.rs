//! 按畅游分组 Provider：按畅游记录显示图片
//!
//! - 根：列出所有有图片的畅游记录（目录名=host）
//! - 子：`SurfImagesProvider` 委托给 `CommonProvider(ImageQuery::by_surf_record)` 做分页/贪心分解

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::common::CommonProvider;
use crate::providers::provider::{FsEntry, Provider, ResolveChild};
use crate::storage::gallery::ImageQuery;
use crate::storage::Storage;

/// 畅游分组列表 Provider
#[derive(Clone)]
pub struct SurfGroupProvider;

impl SurfGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SurfGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for SurfGroupProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::SurfGroup
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let records = Storage::global().get_surf_records_with_images()?;
        Ok(records
            .into_iter()
            .map(|(_, host)| {
                let host = host.trim();
                if host.is_empty() {
                    FsEntry::dir("unknown-host")
                } else {
                    FsEntry::dir(host)
                }
            })
            .collect())
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let surf_record_id = Storage::global().get_surf_record_id_by_host(name).ok()??;
        if surf_record_id.is_empty() {
            return None;
        }
        if !Storage::global().surf_record_exists(&surf_record_id).ok()? {
            return None;
        }
        Some(Arc::new(SurfImagesProvider::new(surf_record_id, false)))
    }

    fn resolve_child(&self, name: &str) -> ResolveChild {
        let surf_record_id = match Storage::global().get_surf_record_id_by_host(name) {
            Ok(Some(id)) => id,
            _ => return ResolveChild::NotFound,
        };
        if surf_record_id.is_empty() {
            return ResolveChild::NotFound;
        }
        if !Storage::global()
            .surf_record_exists(&surf_record_id)
            .unwrap_or(false)
        {
            return ResolveChild::NotFound;
        }
        let child: Arc<dyn Provider> =
            Arc::new(SurfImagesProvider::new(surf_record_id, false));
        ResolveChild::Listed(child)
    }
}

/// 单个畅游记录的图片 Provider
pub struct SurfImagesProvider {
    surf_record_id: String,
    desc: bool,
    inner: CommonProvider,
}

impl SurfImagesProvider {
    pub fn new(surf_record_id: String, desc: bool) -> Self {
        let query = if desc {
            ImageQuery::by_surf_record_desc(surf_record_id.clone())
        } else {
            ImageQuery::by_surf_record(surf_record_id.clone())
        };
        let inner = CommonProvider::with_query(query);
        Self {
            surf_record_id,
            desc,
            inner,
        }
    }
}

impl Provider for SurfImagesProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        let query = if self.desc {
            ImageQuery::by_surf_record_desc(self.surf_record_id.clone())
        } else {
            ImageQuery::by_surf_record(self.surf_record_id.clone())
        };
        crate::providers::descriptor::ProviderDescriptor::All { query }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        let mut entries = self.inner.list()?;
        if !self.desc {
            entries.insert(0, FsEntry::dir("倒序"));
        }
        Ok(entries)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        if name == "倒序" && !self.desc {
            return Some(Arc::new(SurfImagesProvider::new(
                self.surf_record_id.clone(),
                true,
            )));
        }
        self.inner.get_child(name)
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        self.inner.resolve_file(name)
    }
}
