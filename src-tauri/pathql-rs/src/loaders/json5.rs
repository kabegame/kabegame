//! json5 格式 Loader 适配器。零状态。
//!
//! 用 `::json5::` 绝对路径调用外部 crate, 避免与本模块同名歧义。

use std::fs;
use std::path::PathBuf;

use crate::ast::ProviderDef;
use crate::loader::{LoadError, Loader, Source};

/// json5 格式 Loader 适配器；零状态。
#[derive(Debug, Clone, Copy, Default)]
pub struct Json5Loader;

impl Loader for Json5Loader {
    fn load(&self, source: Source<'_>) -> Result<ProviderDef, LoadError> {
        let (text, path) = match source {
            Source::Path(p) => {
                let text = fs::read_to_string(p).map_err(|e| LoadError::Io {
                    path: p.to_path_buf(),
                    source: e,
                })?;
                (text, Some(p.to_path_buf()))
            }
            Source::Str(s) => (s.to_string(), None),
            Source::Bytes(b) => {
                let text = std::str::from_utf8(b)
                    .map_err(|e| LoadError::Type {
                        path: None,
                        msg: format!("invalid utf-8: {}", e),
                    })?
                    .to_string();
                (text, None)
            }
        };

        ::json5::from_str::<ProviderDef>(&text).map_err(|e| map_json5_error(e, path))
    }
}

fn map_json5_error(e: ::json5::Error, path: Option<PathBuf>) -> LoadError {
    match e {
        ::json5::Error::Message { msg, location } => LoadError::Syntax {
            path,
            line: location.as_ref().map(|l| l.line as u32),
            col: location.as_ref().map(|l| l.column as u32),
            msg,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn loads_minimal() {
        let def = Json5Loader
            .load(Source::Str(r#"{"name":"foo"}"#))
            .expect("parse");
        assert_eq!(def.name.0, "foo");
    }

    #[test]
    fn loads_with_comments() {
        let src = "// 注释\n{\"name\":\"foo\"}";
        let def = Json5Loader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "foo");
    }

    #[test]
    fn loads_with_block_comment() {
        let src = "/* block */ {\"name\":\"foo\"}";
        let def = Json5Loader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "foo");
    }

    #[test]
    fn loads_with_trailing_comma() {
        let src = r#"{"name":"foo","namespace":"k",}"#;
        let def = Json5Loader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "foo");
        assert_eq!(def.namespace.unwrap().0, "k");
    }

    #[test]
    fn loads_with_single_quotes() {
        let src = "{'name':'foo'}";
        let def = Json5Loader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "foo");
    }

    #[test]
    fn loads_with_unquoted_keys() {
        let src = "{name:'foo'}";
        let def = Json5Loader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "foo");
    }

    #[test]
    fn loads_realistic_router() {
        let src = r#"
{
    // realistic provider
    "$schema": "../schema.json5",
    namespace: 'kabegame',
    name: "demo_router",
    query: { delegate: { provider: "paginate_router" } },
    list: {
        "static_child": { provider: "child_router" },
    },
    resolve: {
        "x([1-9][0-9]*)x": {
            provider: "paginate_router",
            properties: { page_size: "${capture[1]}" },
        },
    },
}
"#;
        let def = Json5Loader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "demo_router");
        assert!(def.query.is_some());
        assert!(def.list.is_some());
        assert!(def.resolve.is_some());
    }

    #[test]
    fn syntax_error_unclosed_brace() {
        let r = Json5Loader.load(Source::Str("{"));
        match r {
            Err(LoadError::Syntax { line, .. }) => {
                assert!(line.unwrap_or(0) >= 1, "line should be 1-based");
            }
            other => panic!("expected Syntax error, got {:?}", other),
        }
    }

    #[test]
    fn syntax_error_invalid_token() {
        let r = Json5Loader.load(Source::Str("{xxx}"));
        assert!(matches!(r, Err(LoadError::Syntax { .. })));
    }

    #[test]
    fn missing_required_field() {
        let r = Json5Loader.load(Source::Str("{}"));
        // json5 wraps serde missing-field as Message → Syntax
        assert!(matches!(r, Err(LoadError::Syntax { .. })));
    }

    #[test]
    fn bytes_utf8_ok() {
        let def = Json5Loader
            .load(Source::Bytes(b"{\"name\":\"foo\"}"))
            .expect("bytes parse");
        assert_eq!(def.name.0, "foo");
    }

    #[test]
    fn bytes_invalid_utf8() {
        let r = Json5Loader.load(Source::Bytes(&[0xff, 0xfe, 0xfd]));
        match r {
            Err(LoadError::Type { msg, .. }) => assert!(msg.contains("utf-8")),
            other => panic!("expected Type error, got {:?}", other),
        }
    }

    #[test]
    fn path_not_found() {
        let r = Json5Loader.load(Source::Path(Path::new("/no/such/file.json5")));
        match r {
            Err(LoadError::Io { path, .. }) => {
                assert_eq!(path, PathBuf::from("/no/such/file.json5"));
            }
            other => panic!("expected Io error, got {:?}", other),
        }
    }

    #[test]
    fn path_loads_real_file() {
        let dir = std::env::temp_dir();
        let path = dir.join("pathql_rs_test_loader.json5");
        std::fs::write(&path, "// hi\n{ name: 'tmp' }").unwrap();
        let def = Json5Loader.load(Source::Path(&path)).expect("load");
        assert_eq!(def.name.0, "tmp");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn path_syntax_error_includes_path() {
        let dir = std::env::temp_dir();
        let path = dir.join("pathql_rs_test_loader_bad.json5");
        std::fs::write(&path, "{ broken").unwrap();
        let r = Json5Loader.load(Source::Path(&path));
        match r {
            Err(LoadError::Syntax { path: p, line, .. }) => {
                assert_eq!(p, Some(path.clone()));
                assert!(line.is_some(), "line info expected");
            }
            other => panic!("expected Syntax error with path, got {:?}", other),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn trait_object_works() {
        let l: Box<dyn Loader> = Box::new(Json5Loader);
        let def = l.load(Source::Str(r#"{"name":"x"}"#)).unwrap();
        assert_eq!(def.name.0, "x");
    }
}
