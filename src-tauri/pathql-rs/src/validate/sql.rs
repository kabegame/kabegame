use crate::ast::{DynamicListEntry, ListEntry, Query, SqlExpr};
use crate::validate::{ValidateConfig, ValidateError, ValidateErrorKind};

use sqlparser::ast::{
    Insert, Join, ObjectName, Query as SqlQuery, SetExpr, Statement, TableFactor, TableWithJoins,
};
use sqlparser::dialect::SQLiteDialect;
use sqlparser::parser::Parser;

/// 校验所有 SqlExpr。
///
/// 策略：
/// - **完整语句位置** (DynamicSqlEntry.sql)：经 sqlparser parse, 拒绝多语句 / DDL, 提取字面表名做白名单。
/// - **片段位置** (ContribQuery from / join.table / join.on / where / fields.sql)：
///   只做轻量字符串级 DDL 关键字 / 多语句分号检查（pathql 内部生成, 风险低）。
pub fn validate_sql_exprs(
    registry: &crate::ProviderRegistry,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, name), def) in registry.iter_dsl() {
        let fqn = super::fqn(ns, name);

        // ContribQuery fragments: light check
        if let Some(Query::Contrib(c)) = &def.query {
            if let Some(from) = &c.from {
                check_fragment(&fqn, "query.from", from, errors);
            }
            if let Some(joins) = &c.join {
                for (i, j) in joins.iter().enumerate() {
                    check_fragment(&fqn, &format!("query.join[{}].table", i), &j.table, errors);
                    if let Some(on) = &j.on {
                        check_fragment(&fqn, &format!("query.join[{}].on", i), on, errors);
                    }
                }
            }
            if let Some(w) = &c.where_ {
                check_fragment(&fqn, "query.where", w, errors);
            }
            if let Some(fields) = &c.fields {
                for (i, f) in fields.iter().enumerate() {
                    check_fragment(&fqn, &format!("query.fields[{}].sql", i), &f.sql, errors);
                }
            }
        }

        // Dynamic SQL list entries: full statement validation
        if let Some(list) = &def.list {
            for (key, entry) in &list.entries {
                if let ListEntry::Dynamic(DynamicListEntry::Sql(e)) = entry {
                    let field = format!("list[`{}`].sql", key);
                    validate_full_sql(&fqn, &field, &e.sql, cfg, errors);
                }
            }
        }
    }
}

/// 片段级校验：纯字符串扫描 DDL 关键字 / 多语句。
fn check_fragment(
    fqn: &str,
    field: &str,
    expr: &SqlExpr,
    errors: &mut Vec<ValidateError>,
) {
    let s = &expr.0;
    if has_unbalanced_semicolon(s) {
        errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::SqlMultipleStatements,
        ));
    }
    if let Some(kw) = first_ddl_keyword(s) {
        errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::SqlDdlNotAllowed(kw.into()),
        ));
    }
}

fn has_unbalanced_semicolon(s: &str) -> bool {
    // ignore trailing whitespace + a single trailing `;`
    let trimmed = s.trim_end();
    let stripped = trimmed.strip_suffix(';').unwrap_or(trimmed);
    stripped.contains(';')
}

fn first_ddl_keyword(s: &str) -> Option<&'static str> {
    let upper = s.to_uppercase();
    for kw in &[
        "CREATE TABLE",
        "DROP TABLE",
        "ALTER TABLE",
        "CREATE INDEX",
        "DROP INDEX",
        "TRUNCATE",
        "GRANT ",
        "REVOKE ",
    ] {
        if upper.contains(kw) {
            return Some(kw);
        }
    }
    None
}

/// 完整语句校验（dynamic SQL entries）。
///
/// 严格 sqlparser 解析失败时（常见原因：`${composed}` 等模板在 FROM 子查询位置,
/// 替换为 bind param 后 sqlparser 拒绝），回退到 fragment 级 string 检查
/// (DDL 关键字 + 分号检测)，仍捕获 DDL / multi-statement 风险。
pub(crate) fn validate_full_sql(
    fqn: &str,
    field: &str,
    expr: &SqlExpr,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    let stripped = replace_template_with_placeholder(&expr.0);
    let dialect = SQLiteDialect {};
    match Parser::parse_sql(&dialect, &stripped) {
        Err(_) => {
            // strict parse failed (e.g. ${composed} in FROM subquery position).
            // fall back to lenient fragment check.
            check_fragment(fqn, field, expr, errors);
        }
        Ok(stmts) if stmts.len() > 1 => errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::SqlMultipleStatements,
        )),
        Ok(stmts) if stmts.is_empty() => errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::SqlParseError("empty SQL".into()),
        )),
        Ok(stmts) => {
            for stmt in &stmts {
                if let Some(ddl) = ddl_kind(stmt) {
                    errors.push(ValidateError::new(
                        fqn,
                        field,
                        ValidateErrorKind::SqlDdlNotAllowed(ddl.into()),
                    ));
                    continue;
                }
                if let Some(wl) = &cfg.table_whitelist {
                    for t in literal_tables_in_stmt(stmt) {
                        if !wl.contains(&t) {
                            errors.push(ValidateError::new(
                                fqn,
                                field,
                                ValidateErrorKind::TableNotWhitelisted(t),
                            ));
                        }
                    }
                }
            }
        }
    }
}

/// 严格版本（不回退）— 仅供 bad-fixture 测试需要明确解析错误时使用。
#[cfg(test)]
pub(crate) fn validate_full_sql_strict(
    fqn: &str,
    field: &str,
    expr: &SqlExpr,
    cfg: &ValidateConfig,
    errors: &mut Vec<ValidateError>,
) {
    let stripped = replace_template_with_placeholder(&expr.0);
    let dialect = SQLiteDialect {};
    match Parser::parse_sql(&dialect, &stripped) {
        Err(e) => errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::SqlParseError(e.to_string()),
        )),
        Ok(stmts) if stmts.len() > 1 => errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::SqlMultipleStatements,
        )),
        Ok(stmts) if stmts.is_empty() => errors.push(ValidateError::new(
            fqn,
            field,
            ValidateErrorKind::SqlParseError("empty SQL".into()),
        )),
        Ok(stmts) => {
            for stmt in &stmts {
                if let Some(ddl) = ddl_kind(stmt) {
                    errors.push(ValidateError::new(
                        fqn,
                        field,
                        ValidateErrorKind::SqlDdlNotAllowed(ddl.into()),
                    ));
                    continue;
                }
                if let Some(wl) = &cfg.table_whitelist {
                    for t in literal_tables_in_stmt(stmt) {
                        if !wl.contains(&t) {
                            errors.push(ValidateError::new(
                                fqn,
                                field,
                                ValidateErrorKind::TableNotWhitelisted(t),
                            ));
                        }
                    }
                }
            }
        }
    }
}

/// 把 `${...}` 替换为 `:p0` / `:p1` ... (SQLite 命名 bind param)。
pub(crate) fn replace_template_with_placeholder(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut counter = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            // find matching `}` (no nesting per template parser)
            let inner_start = i + 2;
            let mut j = inner_start;
            let mut found_end: Option<usize> = None;
            while j < bytes.len() {
                if bytes[j] == b'}' {
                    found_end = Some(j);
                    break;
                }
                if bytes[j] == b'$' && j + 1 < bytes.len() && bytes[j + 1] == b'{' {
                    break; // unmatched / nested — give up; replace prefix only
                }
                j += 1;
            }
            if let Some(end) = found_end {
                out.push_str(&format!(":p{}", counter));
                counter += 1;
                i = end + 1;
                continue;
            }
        }
        // copy a single char (preserve utf-8 boundaries)
        let ch_end = next_char_boundary(input, i);
        out.push_str(&input[i..ch_end]);
        i = ch_end;
    }
    out
}

fn next_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}

fn ddl_kind(stmt: &Statement) -> Option<&'static str> {
    match stmt {
        Statement::CreateTable(_) => Some("CREATE TABLE"),
        Statement::CreateIndex(_) => Some("CREATE INDEX"),
        Statement::CreateView { .. } => Some("CREATE VIEW"),
        Statement::CreateSchema { .. } => Some("CREATE SCHEMA"),
        Statement::CreateDatabase { .. } => Some("CREATE DATABASE"),
        Statement::CreateFunction { .. } => Some("CREATE FUNCTION"),
        Statement::CreateProcedure { .. } => Some("CREATE PROCEDURE"),
        Statement::CreateTrigger { .. } => Some("CREATE TRIGGER"),
        Statement::CreateSequence { .. } => Some("CREATE SEQUENCE"),
        Statement::AlterTable { .. } => Some("ALTER TABLE"),
        Statement::AlterIndex { .. } => Some("ALTER INDEX"),
        Statement::AlterView { .. } => Some("ALTER VIEW"),
        Statement::Drop { .. } => Some("DROP"),
        Statement::DropFunction { .. } => Some("DROP FUNCTION"),
        Statement::Truncate { .. } => Some("TRUNCATE"),
        Statement::Grant { .. } => Some("GRANT"),
        Statement::Revoke { .. } => Some("REVOKE"),
        _ => None,
    }
}

fn literal_tables_in_stmt(stmt: &Statement) -> Vec<String> {
    let mut tables = Vec::new();
    match stmt {
        Statement::Query(q) => collect_tables_query(q, &mut tables),
        Statement::Insert(Insert { table_name, source, .. }) => {
            tables.push(object_name_to_string(table_name));
            if let Some(src) = source {
                collect_tables_query(src, &mut tables);
            }
        }
        Statement::Update {
            table, from, selection: _, ..
        } => {
            collect_tables_table_with_joins(table, &mut tables);
            if let Some(from) = from {
                collect_tables_table_with_joins(from, &mut tables);
            }
        }
        Statement::Delete(d) => {
            for t in &d.from_table().to_vec_for_phase3() {
                collect_tables_table_with_joins(t, &mut tables);
            }
        }
        _ => {}
    }
    tables
}

// Helper trait to abstract Delete::From shape across sqlparser versions.
trait DeleteFromHelper {
    fn from_table(&self) -> DeleteFromTables<'_>;
}

struct DeleteFromTables<'a>(&'a [TableWithJoins]);

impl<'a> DeleteFromTables<'a> {
    fn to_vec_for_phase3(&self) -> Vec<&'a TableWithJoins> {
        self.0.iter().collect()
    }
}

impl DeleteFromHelper for sqlparser::ast::Delete {
    fn from_table(&self) -> DeleteFromTables<'_> {
        match &self.from {
            sqlparser::ast::FromTable::WithFromKeyword(v)
            | sqlparser::ast::FromTable::WithoutKeyword(v) => DeleteFromTables(v),
        }
    }
}

fn collect_tables_query(q: &SqlQuery, out: &mut Vec<String>) {
    collect_tables_setexpr(&q.body, out);
}

fn collect_tables_setexpr(expr: &SetExpr, out: &mut Vec<String>) {
    match expr {
        SetExpr::Select(s) => {
            for twj in &s.from {
                collect_tables_table_with_joins(twj, out);
            }
        }
        SetExpr::Query(q) => collect_tables_query(q, out),
        SetExpr::SetOperation { left, right, .. } => {
            collect_tables_setexpr(left, out);
            collect_tables_setexpr(right, out);
        }
        SetExpr::Values(_) => {}
        _ => {}
    }
}

fn collect_tables_table_with_joins(twj: &TableWithJoins, out: &mut Vec<String>) {
    collect_tables_table_factor(&twj.relation, out);
    for join in &twj.joins {
        collect_tables_join(join, out);
    }
}

fn collect_tables_join(j: &Join, out: &mut Vec<String>) {
    collect_tables_table_factor(&j.relation, out);
}

fn collect_tables_table_factor(tf: &TableFactor, out: &mut Vec<String>) {
    match tf {
        TableFactor::Table { name, .. } => {
            out.push(object_name_to_string(name));
        }
        TableFactor::Derived { .. } => {
            // 子查询: 不算字面表 (白名单豁免)
        }
        TableFactor::NestedJoin { table_with_joins, .. } => {
            collect_tables_table_with_joins(table_with_joins, out);
        }
        _ => {}
    }
}

fn object_name_to_string(n: &ObjectName) -> String {
    n.0.iter()
        .map(|i| i.value.clone())
        .collect::<Vec<_>>()
        .join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_full(sql: &str, wl: Option<Vec<&str>>) -> Vec<ValidateError> {
        let mut cfg = ValidateConfig::with_default_reserved();
        if let Some(v) = wl {
            cfg.table_whitelist = Some(v.into_iter().map(String::from).collect());
        }
        let mut errs = Vec::new();
        validate_full_sql_strict("p", "list[k].sql", &SqlExpr(sql.into()), &cfg, &mut errs);
        errs
    }

    #[test]
    fn select_simple() {
        assert!(run_full("SELECT 1", None).is_empty());
    }

    #[test]
    fn select_with_template() {
        assert!(run_full(
            "SELECT * FROM images WHERE id = ${properties.id}",
            None
        )
        .is_empty());
    }

    #[test]
    fn multi_stmt() {
        let errs = run_full("SELECT 1; SELECT 2", None);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::SqlMultipleStatements)));
    }

    #[test]
    fn ddl_create() {
        let errs = run_full("CREATE TABLE t (x INT)", None);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::SqlDdlNotAllowed(_))));
    }

    #[test]
    fn ddl_drop() {
        let errs = run_full("DROP TABLE images", None);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::SqlDdlNotAllowed(_))));
    }

    #[test]
    fn bad_syntax() {
        let errs = run_full("SELECT FROM", None);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::SqlParseError(_))));
    }

    #[test]
    fn whitelist_pass() {
        assert!(run_full("SELECT * FROM images", Some(vec!["images"])).is_empty());
    }

    #[test]
    fn whitelist_fail() {
        let errs = run_full("SELECT * FROM images", Some(vec!["tasks"]));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::TableNotWhitelisted(_))));
    }

    #[test]
    fn whitelist_subquery_exempt() {
        let errs = run_full(
            "SELECT * FROM (SELECT id FROM images) sub",
            Some(vec!["images"]),
        );
        assert!(errs.is_empty());
    }

    #[test]
    fn whitelist_none_skips() {
        // wl = None — should accept any table
        assert!(run_full("SELECT * FROM whatever", None).is_empty());
    }

    #[test]
    fn placeholder_replacement() {
        let s = replace_template_with_placeholder("a${x.y}b${z}c");
        assert_eq!(s, "a:p0b:p1c");
    }

    #[test]
    fn placeholder_keeps_unicode() {
        let s = replace_template_with_placeholder("按${x.y}画册");
        assert_eq!(s, "按:p0画册");
    }

    #[test]
    fn placeholder_handles_unclosed() {
        // unclosed `${` is left as-is
        let s = replace_template_with_placeholder("a${unclosed");
        assert_eq!(s, "a${unclosed");
    }

    #[test]
    fn fragment_join_in_from() {
        let mut errs = Vec::new();
        check_fragment(
            "p",
            "query.from",
            &SqlExpr("DROP TABLE images".into()),
            &mut errs,
        );
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::SqlDdlNotAllowed(_))));
    }

    #[test]
    fn fragment_multi_stmt() {
        let mut errs = Vec::new();
        check_fragment(
            "p",
            "query.where",
            &SqlExpr("x > 0; SELECT 1".into()),
            &mut errs,
        );
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::SqlMultipleStatements)));
    }

    #[test]
    fn fragment_clean() {
        let mut errs = Vec::new();
        check_fragment(
            "p",
            "query.from",
            &SqlExpr("images".into()),
            &mut errs,
        );
        assert!(errs.is_empty());
    }

    #[test]
    fn fragment_trailing_semicolon_ok() {
        let mut errs = Vec::new();
        check_fragment(
            "p",
            "query.from",
            &SqlExpr("images;".into()),
            &mut errs,
        );
        assert!(errs.is_empty());
    }

    #[test]
    fn placeholder_adjacent_templates() {
        let s = replace_template_with_placeholder("${a.b}${c.d}");
        assert_eq!(s, ":p0:p1");
    }
}
