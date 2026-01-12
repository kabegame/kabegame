//! Provider 工厂：根据描述符重建 Provider（避免用 id 引用导致内存膨胀）。

use std::sync::Arc;

use crate::providers::descriptor::ProviderDescriptor;
use crate::providers::provider::Provider;
use crate::providers::{
    AlbumsProvider, AllProvider, DateGroupProvider, PluginGroupProvider, RootProvider, TaskGroupProvider,
};

pub struct ProviderFactory;

impl ProviderFactory {
    pub fn build(desc: &ProviderDescriptor) -> Arc<dyn Provider> {
        match desc {
            ProviderDescriptor::Root => Arc::new(RootProvider::default()),
            ProviderDescriptor::GalleryRoot => Arc::new(crate::gallery::provider::GalleryRootProvider::default()),

            ProviderDescriptor::Albums => Arc::new(AlbumsProvider::new()),
            ProviderDescriptor::Album { album_id } => Arc::new(crate::providers::albums::AlbumProvider::new(album_id.clone())),

            ProviderDescriptor::PluginGroup => Arc::new(PluginGroupProvider::new()),
            ProviderDescriptor::DateGroup => Arc::new(DateGroupProvider::new()),
            ProviderDescriptor::TaskGroup => Arc::new(TaskGroupProvider::new()),

            ProviderDescriptor::All { query } => Arc::new(AllProvider::with_query(query.clone())),

            ProviderDescriptor::Range {
                query,
                offset,
                count,
                depth,
            } => Arc::new(crate::providers::all::RangeProvider::new(
                query.clone(),
                *offset,
                *count,
                *depth,
            )),
        }
    }
}

