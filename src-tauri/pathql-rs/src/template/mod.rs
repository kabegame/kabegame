pub mod parse;

#[cfg(feature = "compose")]
pub mod eval;

pub use parse::{
    parse, validate_scope, ParseError, ScopeError, Segment, TemplateAst, VarRef,
};

#[cfg(feature = "compose")]
pub use eval::{evaluate_var, EvalError, TemplateContext, TemplateValue};
