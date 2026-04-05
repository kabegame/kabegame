//! 可复用的“核心 Provider”集合（不依赖虚拟盘/Dokan）。
//!
//! - `provider`: Provider trait + ListEntry/ImageEntry（含过渡兼容）
//! - `main_root`: 统一的 Gallery/VD provider 树入口实现
//! - `common`: 通用查询 provider（Greedy/SimplePage）

pub mod provider;

pub mod cache;
pub mod config;
pub mod descriptor;
pub mod factory;
pub mod unified_root;
pub mod vd_names;

pub mod albums;
pub mod common;
pub mod main_date_browse;
pub mod main_date_scoped;
pub mod main_root;
// VD 专属的 providers 行为（mkdir/delete/说明文件等）放在 core 的 providers 内部，
// 通过 `virtual-driver` feature gate 控制，仅 app-main 会开启该 feature。
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
pub(crate) mod vd_ops;

/// 虚拟盘专用：从插件包（`.kgpg`）读取插件显示名（用于“按任务”目录名展示）。
///
/// - 返回 `None` 表示找不到或为空。
/// - 该函数仅在开启 `virtual-driver` feature 时可用。
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
pub fn plugin_display_name_from_manifest(plugin_id: &str) -> Option<String> {
    vd_ops::plugin_display_name_from_manifest(plugin_id)
}

pub use albums::AlbumsProvider;
pub use cache::{ProviderCacheConfig, ProviderRuntime};
pub use config::ProviderConfig;
pub use common::CommonProvider;
pub use descriptor::ProviderDescriptor;
pub use factory::ProviderFactory;
pub use unified_root::{UnifiedRootProvider, VdRootProvider};
pub use crate::storage::gallery_time::{
    gallery_month_groups_from_days, GalleryTimeFilterPayload, GalleryTimeGroupIndex,
};
