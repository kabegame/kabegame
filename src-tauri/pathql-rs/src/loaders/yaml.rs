//! YAML 格式 Loader 适配器。零状态。
//!
//! 与 json5 产出同一份 `ProviderDef` AST，区别只在书写：长 SQL 可以用块标量
//! (`|` 保留换行 / `>` 折叠换行) 分行书写，无需在一行字符串里拼接。
//! 底层用 `serde-saphyr`（纯 Rust、无 unsafe-libyaml），YAML 1.2 语义：
//! `yes` / `no` / `on` / `off` 仍是字符串，不会被当成布尔。

use std::path::PathBuf;

use super::read_source_text;
use crate::ast::ProviderDef;
use crate::loader::{LoadError, Loader, Source};

/// YAML 格式 Loader 适配器；零状态。
#[derive(Debug, Clone, Copy, Default)]
pub struct YamlLoader;

impl Loader for YamlLoader {
    fn load(&self, source: Source<'_>) -> Result<ProviderDef, LoadError> {
        let (text, path) = read_source_text(source)?;
        serde_saphyr::from_str::<ProviderDef>(&text).map_err(|e| map_yaml_error(e, path))
    }
}

fn map_yaml_error(e: serde_saphyr::Error, path: Option<PathBuf>) -> LoadError {
    // saphyr 的 Location 行列均为 1-based，0 表示未知。
    let location = e.location();
    let known = |v: u64| (v > 0).then_some(v as u32);
    LoadError::Syntax {
        path,
        line: location.and_then(|l| known(l.line())),
        col: location.and_then(|l| known(l.column())),
        msg: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{Query, WhereQuery};
    use std::path::Path;

    #[test]
    fn loads_minimal() {
        let def = YamlLoader.load(Source::Str("name: foo\n")).expect("parse");
        assert_eq!(def.name.0, "foo");
    }

    #[test]
    fn loads_with_comments_and_schema() {
        let src = "# 注释\n$schema: ../schema.json5\nnamespace: kabegame\nname: foo\n";
        let def = YamlLoader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "foo");
        assert_eq!(def.namespace.unwrap().0, "kabegame");
        assert_eq!(def.schema.as_deref(), Some("../schema.json5"));
    }

    #[test]
    fn block_scalar_sql_keeps_newlines() {
        let src = r#"
name: multi_line
query:
  where: |-
    images.id IN (
      SELECT image_id
      FROM album_images
      WHERE album_id = ${properties.album_id}
    )
"#;
        let def = YamlLoader.load(Source::Str(src)).expect("parse");
        let Some(Query::Contrib(q)) = def.query else {
            panic!("expected contrib query");
        };
        let Some(WhereQuery::Is(sql)) = q.where_ else {
            panic!("expected single where");
        };
        assert_eq!(
            sql.0,
            "images.id IN (\n  SELECT image_id\n  FROM album_images\n  WHERE album_id = ${properties.album_id}\n)"
        );
    }

    #[test]
    fn plain_scalars_stay_strings() {
        // YAML 1.2：`on` / `yes` 不是布尔；数字键作为 map key 仍按字符串反序列化。
        let src = r#"
name: yes
list:
  on:
    provider: child
"#;
        let def = YamlLoader.load(Source::Str(src)).expect("parse");
        assert_eq!(def.name.0, "yes");
        let list = def.list.expect("list");
        assert_eq!(list.entries.len(), 1);
    }

    #[test]
    #[cfg(feature = "json5")]
    fn same_ast_as_json5() {
        let json5 = r#"{
    namespace: 'kabegame',
    name: "demo_router",
    query: { delegate: { provider: "paginate_router" } },
    list: { "static_child": { provider: "child_router" } },
    resolve: {
        "x([1-9][0-9]*)x": {
            provider: "paginate_router",
            properties: { page_size: "${capture[1]}" },
        },
    },
}"#;
        let yaml = r#"
namespace: kabegame
name: demo_router
query:
  delegate:
    provider: paginate_router
list:
  static_child:
    provider: child_router
resolve:
  "x([1-9][0-9]*)x":
    provider: paginate_router
    properties:
      page_size: "${capture[1]}"
"#;
        let from_json5 = crate::Json5Loader.load(Source::Str(json5)).expect("json5");
        let from_yaml = YamlLoader.load(Source::Str(yaml)).expect("yaml");
        assert_eq!(from_json5, from_yaml);
    }

    #[test]
    fn syntax_error_has_line() {
        let r = YamlLoader.load(Source::Str("name: foo\nquery: [unclosed\n"));
        match r {
            Err(LoadError::Syntax { line, .. }) => {
                assert!(line.unwrap_or(0) >= 1, "line should be 1-based");
            }
            other => panic!("expected Syntax error, got {:?}", other),
        }
    }

    #[test]
    fn missing_required_field() {
        let r = YamlLoader.load(Source::Str("namespace: k\n"));
        assert!(matches!(r, Err(LoadError::Syntax { .. })));
    }

    #[test]
    fn unknown_field_rejected() {
        // ProviderDef 是 deny_unknown_fields，拼错的键必须报错而不是静默忽略。
        let r = YamlLoader.load(Source::Str("name: foo\nbogus: 1\n"));
        assert!(matches!(r, Err(LoadError::Syntax { .. })));
    }

    #[test]
    fn bytes_invalid_utf8() {
        let r = YamlLoader.load(Source::Bytes(&[0xff, 0xfe, 0xfd]));
        match r {
            Err(LoadError::Type { msg, .. }) => assert!(msg.contains("utf-8")),
            other => panic!("expected Type error, got {:?}", other),
        }
    }

    #[test]
    fn path_not_found() {
        let r = YamlLoader.load(Source::Path(Path::new("/no/such/file.yaml")));
        assert!(matches!(r, Err(LoadError::Io { .. })));
    }

    #[test]
    fn path_syntax_error_includes_path() {
        let path = std::env::temp_dir().join("pathql_rs_test_loader_bad.yaml");
        std::fs::write(&path, "name: [broken\n").unwrap();
        let r = YamlLoader.load(Source::Path(&path));
        match r {
            Err(LoadError::Syntax { path: p, .. }) => assert_eq!(p, Some(path.clone())),
            other => panic!("expected Syntax error with path, got {:?}", other),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn trait_object_works() {
        let l: Box<dyn Loader> = Box::new(YamlLoader);
        let def = l.load(Source::Str("name: x")).unwrap();
        assert_eq!(def.name.0, "x");
    }
}
