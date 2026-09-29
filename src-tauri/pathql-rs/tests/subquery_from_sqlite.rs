//! `FromSource::Subquery` 在真实 sqlite 上的语义：先在内层切页，外层再 join 计数。
//!
//! 对照组是扁平查询——`LIMIT/OFFSET` 渲染在所有 JOIN 之后，切的是「画册×图片」成员行，
//! 翻页会串页、计数被截断。这正是需要子查询边界的原因。

use std::sync::Arc;

use pathql_rs::ast::{JoinKind, NumberOrTemplate, OrderDirection};
use pathql_rs::compose::{FromSource, ProviderQuery};
use pathql_rs::provider::SqlDialect;
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use rusqlite::Connection;

fn params_for(values: &[TemplateValue]) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value;
    values
        .iter()
        .map(|v| match v {
            TemplateValue::Null => Value::Null,
            TemplateValue::Bool(b) => Value::Integer(*b as i64),
            TemplateValue::Int(i) => Value::Integer(*i),
            TemplateValue::Real(r) => Value::Real(*r),
            TemplateValue::Text(s) => Value::Text(s.clone()),
            TemplateValue::Json(v) => Value::Text(v.to_string()),
        })
        .collect()
}

/// P 下四个子画册：A(3 张) B(2) C(0) D(1)，按名称每页 2 个。
fn fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "
        CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT);
        CREATE TABLE album_images (album_id TEXT, image_id INTEGER);
        INSERT INTO albums VALUES ('P','P',NULL),('A','A','P'),('B','B','P'),('C','C','P'),('D','D','P');
        INSERT INTO album_images VALUES ('A',1),('A',2),('A',3),('B',4),('B',5),('D',6);
        ",
    )
    .unwrap();
    conn
}

/// 一页子画册（对应 `parent/P/x2x/<page>`）。
fn album_page(page: i64) -> ProviderQuery {
    let mut q = ProviderQuery::new()
        .with_field_raw("albums.id", Some("id"), &[])
        .with_where_raw("albums.parent_id = ?", &[TemplateValue::Text("P".into())])
        .with_order_raw("albums.name", OrderDirection::Asc);
    q.from = Some(FromSource::table("albums"));
    q.limit = Some(NumberOrTemplate::Number(2.0));
    q.offset_terms
        .push(NumberOrTemplate::Number(((page - 1) * 2) as f64));
    q
}

/// 在 `base` 之上 join 成员行并按画册分组计数（外层只加 join 与 fields，模拟 `images` 段）。
fn with_image_join(mut q: ProviderQuery) -> ProviderQuery {
    q = q
        .with_join_raw(
            JoinKind::Inner,
            "album_images",
            "ai",
            Some("ai.album_id = albums.id"),
            &[],
        )
        .unwrap();
    q
}

fn run(conn: &Connection, q: &ProviderQuery) -> Vec<(String, i64)> {
    let (inner_sql, values) = q
        .build_sql(&TemplateContext::default(), SqlDialect::Sqlite)
        .unwrap();
    let sql = format!(
        "SELECT sub.id, COUNT(*) FROM ({inner_sql}) AS sub GROUP BY sub.id ORDER BY sub.id"
    );
    let mut stmt = conn.prepare(&sql).unwrap();
    stmt.query_map(rusqlite::params_from_iter(params_for(&values)), |row| {
        Ok((row.get(0)?, row.get(1)?))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn nested(page: i64) -> ProviderQuery {
    let mut outer = ProviderQuery::new().with_field_raw("albums.id", Some("id"), &[]);
    outer.from = Some(FromSource::Subquery {
        inner: Arc::new(album_page(page)),
        alias: "albums".into(),
    });
    with_image_join(outer)
}

#[test]
fn subquery_pages_albums_before_join() {
    let conn = fixture();
    // 第 1 页 = [A, B]，第 2 页 = [C, D]；C 没有图片所以 INNER JOIN 后不出现
    assert_eq!(
        run(&conn, &nested(1)),
        vec![("A".into(), 3), ("B".into(), 2)]
    );
    assert_eq!(run(&conn, &nested(2)), vec![("D".into(), 1)]);
}

#[test]
fn flat_query_pages_member_rows_instead() {
    // 对照组：同样的条件写成一条扁平查询，LIMIT 落在 JOIN 之后
    let conn = fixture();
    let page1 = with_image_join(album_page(1));
    let page2 = with_image_join(album_page(2));
    assert_eq!(run(&conn, &page1), vec![("A".into(), 2)]);
    assert_eq!(run(&conn, &page2), vec![("A".into(), 1), ("B".into(), 1)]);
}
