//! Gallery 按畅游记录（host）分组（路由壳）。
//! 类型归属：路由壳。apply_query：noop（委托 shared::SurfsProvider）。
//! list_images：默认实现（不 override）。

pub use crate::providers::shared::surf::SurfsProvider as GallerySurfGroupProvider;
