//! 虚拟文件系统 Provider 实现

pub mod albums;
pub mod all;
pub mod date_group;
pub mod plugin_group;

pub use albums::AlbumsProvider;
pub use all::AllProvider;
pub use date_group::DateGroupProvider;
pub use plugin_group::PluginGroupProvider;
