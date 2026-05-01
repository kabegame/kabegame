//! ProviderQuery 结构化中间表示 + ContribQuery 累积 + SQL 渲染。

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
pub use render::{render_template_sql, render_template_to_string, render_to_owned, RenderError};
