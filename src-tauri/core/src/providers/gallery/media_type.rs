//! Gallery 按媒体类型分组（路由壳）。
//! 类型归属：路由壳。apply_query：noop（委托 shared::MediaTypesProvider）。
//! list_images：默认实现（不 override）。

pub use crate::providers::shared::media_type::MediaTypesProvider as GalleryMediaTypeProvider;
