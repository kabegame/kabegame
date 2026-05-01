//! 输入侧适配器（Loader trait 实现）。
//!
//! 每个子模块对应一种外部输入格式，feature 开关控制编译。
//! 把字节流 / 字符串反序列化为 `ProviderDef` AST。

#[cfg(feature = "json5")]
pub mod json5;

#[cfg(feature = "json5")]
pub use json5::Json5Loader;

pub enum LoaderType {
    #[cfg(feature = "json5")]
    JSON5,
}
