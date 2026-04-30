pub mod eval;
pub mod parse;

pub use eval::{evaluate_var, EvalError, TemplateContext, TemplateValue};
pub use parse::{parse, validate_scope, ParseError, ScopeError, Segment, TemplateAst, VarRef};
