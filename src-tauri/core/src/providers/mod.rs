//! 可复用的“核心 Provider”集合（不依赖虚拟盘/Dokan）。
//!
//! - `provider`: Provider trait + FsEntry + ResolveResult
//! - `all`: AllProvider（贪心分解 + range 子目录）
//! - `date_group`: 按日期（年月）分组
//! - `plugin_group`: 按插件分组
//! - `task_group`: 按任务分组
//! - `albums`: 画册（用于虚拟盘）

pub mod provider;

pub mod cache;
pub mod descriptor;
pub mod factory;
pub mod root;

pub mod albums;
pub mod common;
pub mod date_group;

pub mod plugin_group;
pub mod task_group;

// VD 专属的 providers 行为（mkdir/delete/说明文件等）放在 core 的 providers 内部，
// 通过 `virtual-driver` feature gate 控制，仅 app-main 会开启该 feature。
#[cfg(feature = "virtual-driver")]
pub(crate) mod vd_ops;

/// 虚拟盘专用：从插件包（`.kgpg`）读取插件显示名（用于“按任务”目录名展示）。
///
/// - 返回 `None` 表示找不到或为空。
/// - 该函数仅在开启 `virtual-driver` feature 时可用。
#[cfg(feature = "virtual-driver")]
pub fn plugin_display_name_from_manifest(plugin_id: &str) -> Option<String> {
    vd_ops::plugin_display_name_from_manifest(plugin_id)
}

pub use albums::AlbumsProvider;
pub use cache::{ProviderCacheConfig, ProviderRuntime};
pub use common::CommonProvider;
pub use date_group::DateGroupProvider;
pub use date_group::DateRangeRootProvider;
pub use descriptor::ProviderDescriptor;
pub use factory::ProviderFactory;
pub use plugin_group::PluginGroupProvider;
pub use root::RootProvider;
pub use task_group::TaskGroupProvider;
