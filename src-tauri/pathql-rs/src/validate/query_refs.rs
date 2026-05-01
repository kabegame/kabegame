use crate::ast::{ContribQuery, Namespace, ProviderDef, Query, SimpleName};
use crate::template::{parse, Segment, VarRef};
use crate::validate::{ValidateError, ValidateErrorKind};

/// 校验 ContribQuery 内的 `${ref:X}` 引用：
/// - X 必须在同一 query 的 `join.as` / `fields.as` 字面别名集合里
/// - 别名本身若是 `${ref:...}` 不算字面别名（不能给自己/他人定义）
/// - `as: ${ref:...}` 不与 `in_need: true` 共存
/// - `from` 不应含 ` JOIN ` 关键字（应改用 `join[]`）
pub fn validate_query_refs(
    ns: &Namespace,
    name: &SimpleName,
    def: &ProviderDef,
    errors: &mut Vec<ValidateError>,
) {
    let Some(Query::Contrib(c)) = &def.query else {
        return;
    };
    let fqn = super::fqn(ns, name);
    check_contrib(&fqn, c, errors);
}

fn check_contrib(fqn: &str, c: &ContribQuery, errors: &mut Vec<ValidateError>) {
    // collect literal aliases (skip `${ref:...}` aliases — those are themselves refs)
    let mut aliases: Vec<String> = Vec::new();

    if let Some(joins) = &c.join {
        for j in joins {
            if !is_ref_alias(&j.alias.0) {
                aliases.push(j.alias.0.clone());
            }
        }
    }
    if let Some(fields) = &c.fields {
        for f in fields {
            if let Some(a) = &f.alias {
                if !is_ref_alias(&a.0) {
                    aliases.push(a.0.clone());
                }
            }
        }
    }

    // collect ref usages and check
    let check_refs = |source: &str, field_path: &str, errors: &mut Vec<ValidateError>| {
        let Ok(ast) = parse(source) else { return };
        for seg in &ast.segments {
            if let Segment::Var(VarRef::Method { name, arg }) = seg {
                if name == "ref" && !aliases.iter().any(|a| a == arg) {
                    errors.push(ValidateError::new(
                        fqn,
                        field_path,
                        ValidateErrorKind::UndefinedRef(arg.clone()),
                    ));
                }
            }
        }
    };

    if let Some(joins) = &c.join {
        for (i, j) in joins.iter().enumerate() {
            check_refs(&j.table.0, &format!("query.join[{}].table", i), errors);
            if let Some(on) = &j.on {
                check_refs(&on.0, &format!("query.join[{}].on", i), errors);
            }
            // alias as ref + in_need = error
            if is_ref_alias(&j.alias.0) && j.in_need == Some(true) {
                errors.push(ValidateError::new(
                    fqn,
                    format!("query.join[{}]", i),
                    ValidateErrorKind::RefAliasWithInNeed,
                ));
            }
        }
    }
    if let Some(fields) = &c.fields {
        for (i, f) in fields.iter().enumerate() {
            check_refs(&f.sql.0, &format!("query.fields[{}].sql", i), errors);
            if let Some(a) = &f.alias {
                check_refs(&a.0, &format!("query.fields[{}].as", i), errors);
                if is_ref_alias(&a.0) && f.in_need == Some(true) {
                    errors.push(ValidateError::new(
                        fqn,
                        format!("query.fields[{}]", i),
                        ValidateErrorKind::RefAliasWithInNeed,
                    ));
                }
            }
        }
    }
    if let Some(w) = &c.where_ {
        check_refs(&w.0, "query.where", errors);
    }
    if let Some(from) = &c.from {
        if from.0.to_uppercase().contains(" JOIN ") {
            errors.push(ValidateError::new(
                fqn,
                "query.from",
                ValidateErrorKind::FromContainsJoin,
            ));
        }
    }
}

fn is_ref_alias(s: &str) -> bool {
    let Ok(ast) = parse(s) else { return false };
    ast.segments.iter().any(|seg| {
        matches!(
            seg,
            Segment::Var(VarRef::Method { name, .. }) if name == "ref"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        AliasName, ContribQuery, Field, Join, JoinKind, ProviderDef, Query, SimpleName, SqlExpr,
    };

    fn def_with_query(q: ContribQuery) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName("p".into()),
            properties: None,
            query: Some(Query::Contrib(q)),
            list: None,
            resolve: None,
            note: None,
        }
    }

    fn run(q: ContribQuery) -> Vec<ValidateError> {
        let d = def_with_query(q);
        let mut errs = Vec::new();
        validate_query_refs(
            &Namespace(String::new()),
            &SimpleName("p".into()),
            &d,
            &mut errs,
        );
        errs
    }

    #[test]
    fn ref_resolves_via_join_as() {
        let q = ContribQuery {
            join: Some(vec![Join {
                kind: Some(JoinKind::Left),
                table: SqlExpr("album_images".into()),
                alias: AliasName("ai".into()),
                on: Some(SqlExpr("${ref:ai}.image_id = images.id".into())),
                in_need: None,
            }]),
            ..Default::default()
        };
        assert!(run(q).is_empty());
    }

    #[test]
    fn ref_undefined() {
        let q = ContribQuery {
            join: Some(vec![Join {
                kind: None,
                table: SqlExpr("x".into()),
                alias: AliasName("y".into()),
                on: Some(SqlExpr("${ref:nope}.id = x.id".into())),
                in_need: None,
            }]),
            ..Default::default()
        };
        let errs = run(q);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::UndefinedRef(_))));
    }

    #[test]
    fn ref_with_in_need_on_join() {
        let q = ContribQuery {
            join: Some(vec![Join {
                kind: None,
                table: SqlExpr("t".into()),
                alias: AliasName("${ref:t}".into()),
                on: None,
                in_need: Some(true),
            }]),
            ..Default::default()
        };
        let errs = run(q);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::RefAliasWithInNeed)));
    }

    #[test]
    fn from_with_join_warns() {
        let q = ContribQuery {
            from: Some(SqlExpr("images JOIN album_images ai".into())),
            ..Default::default()
        };
        let errs = run(q);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::FromContainsJoin)));
    }

    #[test]
    fn from_without_join_ok() {
        let q = ContribQuery {
            from: Some(SqlExpr("images".into())),
            ..Default::default()
        };
        assert!(run(q).is_empty());
    }

    #[test]
    fn ref_via_field_alias() {
        let q = ContribQuery {
            fields: Some(vec![Field {
                sql: SqlExpr("images.id".into()),
                alias: Some(AliasName("img".into())),
                in_need: None,
            }]),
            where_: Some(SqlExpr("${ref:img} > 0".into())),
            ..Default::default()
        };
        assert!(run(q).is_empty());
    }

    #[test]
    fn no_query_skipped() {
        let mut errs = Vec::new();
        let d = ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName("p".into()),
            properties: None,
            query: None,
            list: None,
            resolve: None,
            note: None,
        };
        validate_query_refs(
            &Namespace(String::new()),
            &SimpleName("p".into()),
            &d,
            &mut errs,
        );
        assert!(errs.is_empty());
    }
}
