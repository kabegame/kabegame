use thiserror::Error;

#[derive(Debug, Error)]
#[error("{provider}: {field}: {kind}")]
pub struct ValidateError {
    /// 全限定名 `<namespace>.<name>` (root namespace shows as bare name)
    pub provider: String,
    /// 字段路径，如 `query.fields[2].as`
    pub field: String,
    pub kind: ValidateErrorKind,
}

impl ValidateError {
    pub fn new(provider: impl Into<String>, field: impl Into<String>, kind: ValidateErrorKind) -> Self {
        Self {
            provider: provider.into(),
            field: field.into(),
            kind,
        }
    }
}

#[derive(Debug, Error)]
pub enum ValidateErrorKind {
    #[error("invalid pattern: {0}")]
    InvalidPattern(String),
    #[error("template parse error: {0}")]
    TemplateParse(#[from] crate::template::ParseError),
    #[error("template scope error: {0}")]
    TemplateScope(#[from] crate::template::ScopeError),
    #[error("undefined ${{ref:{0}}} - no matching alias in same query")]
    UndefinedRef(String),
    #[error("`as: ${{ref:...}}` cannot coexist with `in_need: true`")]
    RefAliasWithInNeed,
    #[error("`from` clause should not contain JOIN keyword (use `join[]` instead)")]
    FromContainsJoin,
    #[error("dynamic list entry: ${{X.Y}} prefix `{0}` does not match {1}_var `{2}`")]
    DynamicVarMismatch(String, &'static str, String),
    #[error("dynamic SQL list entry cannot reference ${{data_var.provider}}")]
    DynamicSqlProviderRef,
    #[error("reserved identifier `{0}` cannot be used as binding")]
    ReservedIdent(String),
    #[error("invalid namespace pattern: `{0}`")]
    InvalidNamespace(String),
    #[error("invalid name pattern: `{0}`")]
    InvalidName(String),
    #[error("SQL parse error: {0}")]
    SqlParseError(String),
    #[error("multiple SQL statements not allowed")]
    SqlMultipleStatements,
    #[error("DDL not allowed: {0}")]
    SqlDdlNotAllowed(String),
    #[error("table `{0}` not in whitelist")]
    TableNotWhitelisted(String),
    #[error("regex compile error in `{pattern}`: {msg}")]
    RegexCompileError { pattern: String, msg: String },
    #[error("regex `{0}` matches static list key `{1}`")]
    RegexMatchesStatic(String, String),
    #[error("regex `{0}` and regex `{1}` overlap (intersection non-empty)")]
    RegexIntersection(String, String),
    #[error("${{capture[{idx}]}} out of bounds (regex `{pattern}` has {groups} group(s))")]
    CaptureIndexOutOfBounds {
        pattern: String,
        idx: usize,
        groups: usize,
    },
    #[error("provider reference `{0}` not found in registry (current_ns: `{1}`)")]
    UnresolvedProviderRef(String, String),
    #[error("delegate cycle detected: {}", .0.join(" → "))]
    DelegateCycle(Vec<String>),
}
