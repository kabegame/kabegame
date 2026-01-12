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
pub mod all;
pub mod date_group;
pub mod plugin_group;
pub mod task_group;

pub use albums::AlbumsProvider;
pub use all::AllProvider;
pub use cache::{ProviderCacheConfig, ProviderRuntime};
pub use date_group::DateGroupProvider;
pub use descriptor::ProviderDescriptor;
pub use factory::ProviderFactory;
pub use plugin_group::PluginGroupProvider;
pub use root::RootProvider;
pub use task_group::TaskGroupProvider;
