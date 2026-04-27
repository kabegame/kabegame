//! 输出 / 执行侧适配器（DB 驱动桥接）。
//!
//! 每个子模块对应一种 DB 驱动，feature 开关控制编译。
//! 把 `TemplateValue`（pathql-rs 的中性 bind 参数表达）转换为具体驱动的值类型。

#[cfg(feature = "sqlite")]
pub mod sqlite;
