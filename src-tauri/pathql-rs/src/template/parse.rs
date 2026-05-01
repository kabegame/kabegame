//! 模板表达式解析器: ${...} 语法分析。0 外部 dep, 永久编译。

use thiserror::Error;

/// 解析后的模板：可能是纯字面或字面+变量片段交错。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateAst {
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    Var(VarRef),
}

/// `${...}` 内的引用形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarRef {
    /// `${ns}` — 裸命名空间访问（如 `${composed}`）
    Bare { ns: String },
    /// `${ns.path.to.field}` — 点访问
    Path { ns: String, path: Vec<String> },
    /// `${ns[N]}` — 索引访问（仅 capture）
    Index { ns: String, index: usize },
    /// `${method:arg}` — 方法标记
    Method { name: String, arg: String },
}

impl VarRef {
    /// 返回 var 的命名空间（method 形态返回 method 名）。
    pub fn ns(&self) -> &str {
        match self {
            VarRef::Bare { ns } => ns,
            VarRef::Path { ns, .. } => ns,
            VarRef::Index { ns, .. } => ns,
            VarRef::Method { name, .. } => name,
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ParseError {
    #[error("unclosed ${{...}} starting at offset {0}")]
    Unclosed(usize),
    #[error("nested ${{${{...}}}} not allowed at offset {0}")]
    Nested(usize),
    #[error("empty ${{}} at offset {0}")]
    Empty(usize),
    #[error("invalid syntax in ${{...}} at offset {offset}: {msg}")]
    Invalid { offset: usize, msg: String },
}

pub fn parse(input: &str) -> Result<TemplateAst, ParseError> {
    let bytes = input.as_bytes();
    let mut segments: Vec<Segment> = Vec::new();
    let mut text = String::new();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if !text.is_empty() {
                segments.push(Segment::Text(std::mem::take(&mut text)));
            }
            let var_start = i;
            // find matching closing `}` — reject nested `${`
            let inner_start = i + 2;
            let mut j = inner_start;
            let mut found_end: Option<usize> = None;
            while j < bytes.len() {
                if bytes[j] == b'$' && j + 1 < bytes.len() && bytes[j + 1] == b'{' {
                    return Err(ParseError::Nested(j));
                }
                if bytes[j] == b'}' {
                    found_end = Some(j);
                    break;
                }
                j += 1;
            }
            let end = found_end.ok_or(ParseError::Unclosed(var_start))?;
            let inner = &input[inner_start..end];
            if inner.is_empty() {
                return Err(ParseError::Empty(var_start));
            }
            let var = parse_var_ref(inner, var_start)?;
            segments.push(Segment::Var(var));
            i = end + 1;
        } else {
            // accumulate text byte (safe slice via char boundary by advancing one char)
            let ch_end = next_char_boundary(input, i);
            text.push_str(&input[i..ch_end]);
            i = ch_end;
        }
    }
    if !text.is_empty() {
        segments.push(Segment::Text(text));
    }
    Ok(TemplateAst { segments })
}

fn next_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}

fn parse_var_ref(inner: &str, offset: usize) -> Result<VarRef, ParseError> {
    if let Some(colon) = inner.find(':') {
        let name = inner[..colon].to_string();
        let arg = inner[colon + 1..].to_string();
        if name.is_empty() {
            return Err(ParseError::Invalid {
                offset,
                msg: "empty method name before `:`".into(),
            });
        }
        return Ok(VarRef::Method { name, arg });
    }
    if let Some(open) = inner.find('[') {
        let close = inner.rfind(']').ok_or(ParseError::Invalid {
            offset,
            msg: "missing `]` in index expression".into(),
        })?;
        if close <= open {
            return Err(ParseError::Invalid {
                offset,
                msg: "invalid `[]` order".into(),
            });
        }
        if close + 1 != inner.len() {
            return Err(ParseError::Invalid {
                offset,
                msg: "unexpected text after `]`".into(),
            });
        }
        let ns = inner[..open].to_string();
        if ns.is_empty() {
            return Err(ParseError::Invalid {
                offset,
                msg: "empty namespace before `[`".into(),
            });
        }
        let idx_str = &inner[open + 1..close];
        let index: usize = idx_str.parse().map_err(|_| ParseError::Invalid {
            offset,
            msg: format!("non-integer index `{}`", idx_str),
        })?;
        return Ok(VarRef::Index { ns, index });
    }
    if let Some(dot) = inner.find('.') {
        let ns = inner[..dot].to_string();
        let rest = &inner[dot + 1..];
        if ns.is_empty() {
            return Err(ParseError::Invalid {
                offset,
                msg: "empty namespace before `.`".into(),
            });
        }
        let path: Vec<String> = rest.split('.').map(|s| s.to_string()).collect();
        if path.iter().any(|p| p.is_empty()) {
            return Err(ParseError::Invalid {
                offset,
                msg: "empty segment in path".into(),
            });
        }
        return Ok(VarRef::Path { ns, path });
    }
    Ok(VarRef::Bare {
        ns: inner.to_string(),
    })
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ScopeError {
    #[error("variable `${{{0}}}` not allowed in this context (allowed: {1:?})")]
    UnknownNamespace(String, Vec<String>),
    #[error("method `${{{0}:...}}` not allowed in this context (allowed: {1:?})")]
    UnknownMethod(String, Vec<String>),
}

/// 校验模板表达式中所有 VarRef 的命名空间在 `allowed_ns` 里, method 在 `allowed_methods` 里。
/// 返回首个错误。
pub fn validate_scope(
    ast: &TemplateAst,
    allowed_ns: &[&str],
    allowed_methods: &[&str],
) -> Result<(), ScopeError> {
    for seg in &ast.segments {
        if let Segment::Var(v) = seg {
            match v {
                VarRef::Method { name, .. } => {
                    if !allowed_methods.contains(&name.as_str()) {
                        return Err(ScopeError::UnknownMethod(
                            name.clone(),
                            allowed_methods.iter().map(|s| (*s).into()).collect(),
                        ));
                    }
                }
                VarRef::Bare { ns } | VarRef::Path { ns, .. } | VarRef::Index { ns, .. } => {
                    if !allowed_ns.contains(&ns.as_str()) {
                        return Err(ScopeError::UnknownNamespace(
                            ns.clone(),
                            allowed_ns.iter().map(|s| (*s).into()).collect(),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(ast: &TemplateAst) -> Vec<&VarRef> {
        ast.segments
            .iter()
            .filter_map(|s| {
                if let Segment::Var(v) = s {
                    Some(v)
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn pure_text() {
        let a = parse("hello world").unwrap();
        assert_eq!(a.segments, vec![Segment::Text("hello world".into())]);
    }

    #[test]
    fn empty_input() {
        let a = parse("").unwrap();
        assert!(a.segments.is_empty());
    }

    #[test]
    fn single_bare() {
        let a = parse("${composed}").unwrap();
        assert_eq!(
            a.segments,
            vec![Segment::Var(VarRef::Bare {
                ns: "composed".into()
            })]
        );
    }

    #[test]
    fn single_path() {
        let a = parse("${properties.album_id}").unwrap();
        let v = vars(&a)[0];
        assert_eq!(
            v,
            &VarRef::Path {
                ns: "properties".into(),
                path: vec!["album_id".into()]
            }
        );
    }

    #[test]
    fn nested_path() {
        let a = parse("${plugin.meta.info.name}").unwrap();
        let v = vars(&a)[0];
        assert_eq!(
            v,
            &VarRef::Path {
                ns: "plugin".into(),
                path: vec!["meta".into(), "info".into(), "name".into()]
            }
        );
    }

    #[test]
    fn index() {
        let a = parse("${capture[1]}").unwrap();
        let v = vars(&a)[0];
        assert_eq!(
            v,
            &VarRef::Index {
                ns: "capture".into(),
                index: 1
            }
        );
    }

    #[test]
    fn method() {
        let a = parse("${ref:my_id}").unwrap();
        let v = vars(&a)[0];
        assert_eq!(
            v,
            &VarRef::Method {
                name: "ref".into(),
                arg: "my_id".into()
            }
        );
    }

    #[test]
    fn mixed() {
        let a = parse("${a.b}-${c}").unwrap();
        assert_eq!(a.segments.len(), 3);
        assert!(matches!(a.segments[0], Segment::Var(_)));
        assert_eq!(a.segments[1], Segment::Text("-".into()));
        assert!(matches!(a.segments[2], Segment::Var(_)));
    }

    #[test]
    fn escape_lit_around() {
        let a = parse("${a.b}suffix${c}").unwrap();
        assert_eq!(a.segments.len(), 3);
        assert_eq!(a.segments[1], Segment::Text("suffix".into()));
    }

    #[test]
    fn unclosed() {
        assert!(matches!(parse("${a"), Err(ParseError::Unclosed(_))));
    }

    #[test]
    fn nested_disallowed() {
        assert!(matches!(parse("${${x}.y}"), Err(ParseError::Nested(_))));
    }

    #[test]
    fn empty_braces() {
        assert!(matches!(parse("${}"), Err(ParseError::Empty(_))));
    }

    #[test]
    fn bad_index() {
        assert!(matches!(
            parse("${capture[abc]}"),
            Err(ParseError::Invalid { .. })
        ));
    }

    #[test]
    fn bad_index_no_close() {
        assert!(matches!(
            parse("${capture[1}"),
            Err(ParseError::Invalid { .. })
        ));
    }

    #[test]
    fn empty_ns_dot() {
        assert!(matches!(parse("${.foo}"), Err(ParseError::Invalid { .. })));
    }

    #[test]
    fn empty_method_name() {
        assert!(matches!(parse("${:arg}"), Err(ParseError::Invalid { .. })));
    }

    #[test]
    fn dollar_alone_is_literal() {
        let a = parse("price $50").unwrap();
        assert_eq!(a.segments, vec![Segment::Text("price $50".into())]);
    }

    #[test]
    fn unicode_text() {
        let a = parse("按画册${properties.x}").unwrap();
        assert_eq!(a.segments.len(), 2);
        assert_eq!(a.segments[0], Segment::Text("按画册".into()));
    }

    #[test]
    fn scope_ok() {
        let a = parse("${properties.x}").unwrap();
        assert!(validate_scope(&a, &["properties"], &[]).is_ok());
    }

    #[test]
    fn scope_unknown_ns() {
        let a = parse("${properties.x}").unwrap();
        let r = validate_scope(&a, &["composed"], &[]);
        assert!(matches!(r, Err(ScopeError::UnknownNamespace(_, _))));
    }

    #[test]
    fn scope_method_ok() {
        let a = parse("${ref:x}").unwrap();
        assert!(validate_scope(&a, &[], &["ref"]).is_ok());
    }

    #[test]
    fn scope_method_bad() {
        let a = parse("${ref:x}").unwrap();
        assert!(matches!(
            validate_scope(&a, &[], &[]),
            Err(ScopeError::UnknownMethod(_, _))
        ));
    }

    #[test]
    fn scope_text_only_ok() {
        let a = parse("just text").unwrap();
        assert!(validate_scope(&a, &[], &[]).is_ok());
    }

    #[test]
    fn scope_index_uses_ns() {
        let a = parse("${capture[1]}").unwrap();
        assert!(validate_scope(&a, &["capture"], &[]).is_ok());
        assert!(validate_scope(&a, &["properties"], &[]).is_err());
    }
}
