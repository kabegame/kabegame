pub mod parse;

pub use parse::{
    parse, validate_scope, ParseError, ScopeError, Segment, TemplateAst, VarRef,
};
