//! 格式适配器集合。每个子模块由 feature 开关控制。

#[cfg(feature = "json5")]
pub mod json5;

#[cfg(feature = "json5")]
pub use json5::Json5Loader;

#[cfg(feature = "sqlite")]
pub mod sqlite;
