//! ProviderQuery 结构化中间表示 + ContribQuery 累积。
//!
//! 本模块只做结构化累积; SQL 渲染 + 模板求值在 Phase 5 (compose/build.rs)。

#![cfg(feature = "compose")]

pub mod aliases;
pub mod build;
pub mod fold;
pub mod order;
pub mod query;
pub mod render;

pub use aliases::{AliasTable, AllocatedAlias, ResolvedAlias};
pub use build::BuildError;
pub use fold::{fold_contrib, FoldError};
pub use order::OrderState;
pub use query::{FieldFrag, JoinFrag, ProviderQuery};
pub use render::{render_template_sql, render_to_owned, RenderError};
