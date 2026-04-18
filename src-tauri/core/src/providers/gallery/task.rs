//! Gallery 按任务分组（路由壳）。
//! 类型归属：路由壳。apply_query：noop（委托 shared::TasksProvider）。
//! list_images：默认实现（不 override）。

pub use crate::providers::shared::task::TasksProvider as GalleryTaskGroupProvider;
