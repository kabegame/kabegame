//! 按种类（图片 / 视频）分组 Provider（虚拟盘中文目录名）

use std::path::PathBuf;
use std::sync::Arc;

use crate::providers::common::CommonProvider;
use crate::providers::provider::{FsEntry, Provider};
use crate::providers::root::media_type_token_from_dir_name;
use crate::storage::gallery::ImageQuery;
use crate::providers::root::{DIR_MEDIA_IMAGE, DIR_MEDIA_VIDEO};

/// VD「按种类」分组：子目录为 [`DIR_MEDIA_IMAGE`] / [`DIR_MEDIA_VIDEO`]
pub struct MediaTypeGroupProvider;

impl MediaTypeGroupProvider {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MediaTypeGroupProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for MediaTypeGroupProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::MediaTypeGroup
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        Ok(vec![
            FsEntry::dir(DIR_MEDIA_IMAGE),
            FsEntry::dir(DIR_MEDIA_VIDEO),
        ])
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        let media = media_type_token_from_dir_name(name)?;
        Some(Arc::new(MediaTypeBrowseProvider::new(media)))
    }
}

struct MediaTypeBrowseProvider {
    media: &'static str,
    inner: CommonProvider,
}

impl MediaTypeBrowseProvider {
    fn new(media: &'static str) -> Self {
        let inner = CommonProvider::with_query(ImageQuery::by_media_type(media));
        Self { media, inner }
    }
}

impl Provider for MediaTypeBrowseProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::All {
            query: ImageQuery::by_media_type(self.media),
        }
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        self.inner.list()
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        self.inner.get_child(name)
    }

    fn resolve_file(&self, name: &str) -> Option<(String, PathBuf)> {
        self.inner.resolve_file(name)
    }
}
