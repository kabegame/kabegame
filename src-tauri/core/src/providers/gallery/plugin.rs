//! Gallery 按插件分组（路由壳）。
//! 类型归属：路由壳。apply_query：noop（委托 shared::PluginsProvider）。
//! list_images：默认实现（不 override）。

pub use crate::providers::shared::plugin::PluginsProvider as GalleryPluginGroupProvider;
