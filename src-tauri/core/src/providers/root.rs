//! 可复用 RootProvider（用于 warm cache / 非虚拟盘场景）。

use std::sync::Arc;

use crate::providers::provider::{FsEntry, Provider};
use crate::providers::{
    AlbumsProvider, CommonProvider, MediaTypeGroupProvider, PluginGroupProvider,
    SurfGroupProvider, TaskGroupProvider, VdByDateProvider,
};
use crate::storage::gallery::ImageQuery;

pub const DIR_BY_DATE: &str = "按时间";
pub const DIR_BY_PLUGIN: &str = "按插件";
pub const DIR_BY_TASK: &str = "按任务";
pub const DIR_BY_SURF: &str = "按畅游";
pub const DIR_ALBUMS: &str = "画册";
pub const DIR_BY_WALLPAPER_ORDER: &str = "按壁纸顺序";
pub const DIR_ALL: &str = "全部";
pub const DIR_BY_MEDIA_TYPE: &str = "按种类";
pub const DIR_MEDIA_IMAGE: &str = "图片";
pub const DIR_MEDIA_VIDEO: &str = "视频";

/// VD「按种类」子目录名 → SQL `images.type` 取值
pub fn media_type_token_from_dir_name(name: &str) -> Option<&'static str> {
    let t = name.trim();
    if t == DIR_MEDIA_IMAGE {
        Some("image")
    } else if t == DIR_MEDIA_VIDEO {
        Some("video")
    } else {
        None
    }
}

/// RootProvider：包含按时间、按插件、按任务、画册、全部
#[derive(Clone, Default)]
pub struct RootProvider;

impl Provider for RootProvider {
    fn descriptor(&self) -> crate::providers::descriptor::ProviderDescriptor {
        crate::providers::descriptor::ProviderDescriptor::Root
    }

    fn list(&self) -> Result<Vec<FsEntry>, String> {
        #[allow(unused_mut)]
        let mut out = vec![
            FsEntry::dir(DIR_BY_DATE),
            FsEntry::dir(DIR_BY_PLUGIN),
            FsEntry::dir(DIR_BY_TASK),
            FsEntry::dir(DIR_BY_SURF),
            FsEntry::dir(DIR_BY_MEDIA_TYPE),
            FsEntry::dir(DIR_ALBUMS),
            FsEntry::dir(DIR_BY_WALLPAPER_ORDER),
            FsEntry::dir(DIR_ALL),
        ];

        // VD 专用：根目录说明文件
        #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
        {
            // NOTE: 必须带扩展名，否则某些图片查看器/Explorer 枚举同目录文件时会尝试“打开”该说明文件并弹出错误。
            let display_name = "在这里你可以自由查看图片.txt";
            let (id, path) =
                crate::providers::vd_ops::ensure_note_file(display_name, display_name)?;
            out.insert(0, FsEntry::file(display_name, id, path));
        }

        Ok(out)
    }

    fn get_child(&self, name: &str) -> Option<Arc<dyn Provider>> {
        match name {
            n if n.eq_ignore_ascii_case(DIR_BY_DATE) => {
                Some(Arc::new(VdByDateProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_BY_PLUGIN) => {
                Some(Arc::new(PluginGroupProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_BY_TASK) => {
                Some(Arc::new(TaskGroupProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_BY_SURF) => {
                Some(Arc::new(SurfGroupProvider::new()) as Arc<dyn Provider>)
            }
            n if n.trim() == DIR_BY_MEDIA_TYPE => {
                Some(Arc::new(MediaTypeGroupProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_ALBUMS) => {
                Some(Arc::new(AlbumsProvider::new()) as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_BY_WALLPAPER_ORDER) => {
                Some(Arc::new(CommonProvider::with_query(ImageQuery::all_by_wallpaper_set()))
                    as Arc<dyn Provider>)
            }
            n if n.eq_ignore_ascii_case(DIR_ALL) => {
                Some(Arc::new(CommonProvider::new()) as Arc<dyn Provider>)
            }
            _ => None,
        }
    }

    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    fn resolve_file(&self, name: &str) -> Option<(String, std::path::PathBuf)> {
        let display_name = "在这里你可以自由查看图片.txt";
        if name != display_name {
            return None;
        }
        crate::providers::vd_ops::ensure_note_file(display_name, display_name)
            .ok()
            .map(|(id, path)| (id, path))
    }
}
