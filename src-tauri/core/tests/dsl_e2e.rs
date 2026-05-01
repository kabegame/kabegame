//! Phase 7c: core-level E2E for the fully-DSL provider tree.
//!
//! The fixture uses an in-memory sqlite database and test-local host SQL
//! functions, so these tests do not touch the user's Kabegame data directory.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use kabegame_core::providers::dsl_loader::{register_embedded_dsl, validate_dsl};
use pathql_rs::provider::{ClosureExecutor, EngineError, SqlDialect};
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use pathql_rs::ProviderRuntime;
use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;

const FAVORITE_ALBUM_ID: &str = kabegame_core::storage::FAVORITE_ALBUM_ID;
const HIDDEN_ALBUM_ID: &str = kabegame_core::storage::HIDDEN_ALBUM_ID;
const ALBUM_A_ID: &str = "11111111-1111-1111-1111-111111111111";
const TASK_A_ID: &str = "22222222-2222-2222-2222-222222222222";

fn local_params_for(values: &[TemplateValue]) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value;
    values
        .iter()
        .map(|v| match v {
            TemplateValue::Null => Value::Null,
            TemplateValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
            TemplateValue::Int(i) => Value::Integer(*i),
            TemplateValue::Real(r) => Value::Real(*r),
            TemplateValue::Text(s) => Value::Text(s.clone()),
            TemplateValue::Json(v) => Value::Text(v.to_string()),
        })
        .collect()
}

fn register_fixture_functions(conn: &Connection) {
    conn.create_scalar_function(
        "crawled_at_seconds",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let v: i64 = ctx.get(0)?;
            Ok(if v > 253_402_300_799 { v / 1000 } else { v })
        },
    )
    .unwrap();

    conn.create_scalar_function(
        "vd_display_name",
        1,
        FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let canonical: String = ctx.get(0)?;
            Ok(kabegame_i18n::vd_display_name(&canonical))
        },
    )
    .unwrap();

    conn.create_scalar_function(
        "get_plugin",
        -1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let plugin_id: String = ctx.get(0)?;
            let locale = if ctx.len() >= 2 {
                let raw: rusqlite::types::Value = ctx.get(1)?;
                match raw {
                    rusqlite::types::Value::Text(s) => s,
                    _ => kabegame_i18n::current_vd_locale().to_string(),
                }
            } else {
                kabegame_i18n::current_vd_locale().to_string()
            };
            let name = if locale.starts_with("zh") {
                "像素插件"
            } else {
                "Pixel Plugin"
            };
            Ok(serde_json::json!({
                "id": plugin_id,
                "name": name,
                "description": format!("{name} fixture"),
                "baseUrl": "https://example.test"
            })
            .to_string())
        },
    )
    .unwrap();

    for fn_name in ["get_album", "get_task", "get_surf_record"] {
        conn.create_scalar_function(
            fn_name,
            1,
            FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
            |ctx| -> rusqlite::Result<String> {
                let id: String = ctx.get(0)?;
                Ok(serde_json::json!({ "kind": "fixture", "data": { "id": id } }).to_string())
            },
        )
        .unwrap();
    }
}

fn fixture_db() -> Arc<Mutex<Connection>> {
    let conn = Connection::open_in_memory().unwrap();
    register_fixture_functions(&conn);
    conn.execute_batch(
        r#"
        CREATE TABLE images (
            id INTEGER PRIMARY KEY,
            url TEXT,
            local_path TEXT NOT NULL,
            plugin_id TEXT NOT NULL,
            task_id TEXT,
            surf_record_id TEXT,
            crawled_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_id INTEGER,
            thumbnail_path TEXT NOT NULL DEFAULT '',
            hash TEXT NOT NULL DEFAULT '',
            type TEXT DEFAULT 'image',
            width INTEGER,
            height INTEGER,
            display_name TEXT NOT NULL DEFAULT '',
            last_set_wallpaper_at INTEGER,
            size INTEGER
        );
        CREATE TABLE album_images (
            album_id TEXT NOT NULL,
            image_id INTEGER NOT NULL,
            "order" INTEGER,
            PRIMARY KEY (album_id, image_id)
        );
        CREATE TABLE image_metadata (
            id INTEGER PRIMARY KEY,
            data TEXT NOT NULL
        );
        CREATE TABLE albums (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            parent_id TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            start_time INTEGER
        );
        CREATE TABLE surf_records (
            id TEXT PRIMARY KEY,
            host TEXT NOT NULL UNIQUE,
            root_url TEXT NOT NULL,
            last_visit_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO albums VALUES
            ('11111111-1111-1111-1111-111111111111', 'AlbumA', 1, NULL),
            ('33333333-3333-3333-3333-333333333333', 'AlbumChild', 2, '11111111-1111-1111-1111-111111111111');
        INSERT INTO image_metadata VALUES
            (1, '{"source":"table","tags":["a"]}');
        INSERT INTO tasks VALUES
            ('22222222-2222-2222-2222-222222222222', 'pixiv', 10);
        INSERT INTO surf_records VALUES
            ('surf-a', 'pixiv.test', 'https://pixiv.test', 20, 10, 'Pixiv Test');
        "#,
    )
    .unwrap();

    for i in 1..=120 {
        let crawled_at = 1_680_652_800_i64 + (i as i64 * 60);
        conn.execute(
            "INSERT INTO images
             (id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at,
              metadata, metadata_id, thumbnail_path, hash, type, width, height, display_name, size)
             VALUES (?1, ?2, ?3, 'pixiv', ?4, 'surf-a', ?5, ?6, ?7, '', ?8, 'image', 100, 100, ?9, 10)",
            (
                i,
                format!("https://example.test/{i}.jpg"),
                format!("D:/fixture/{i}.jpg"),
                TASK_A_ID,
                crawled_at,
                if i == 2 {
                    Some("{\"source\":\"legacy\"}".to_string())
                } else {
                    None
                },
                if i == 1 { Some(1_i64) } else { None },
                format!("hash-{i}"),
                format!("image-{i}"),
            ),
        )
        .unwrap();
        if i <= 5 {
            conn.execute(
                "INSERT INTO album_images(album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                (ALBUM_A_ID, i, i),
            )
            .unwrap();
        }
        if (6..=8).contains(&i) {
            conn.execute(
                "INSERT INTO album_images(album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                ("33333333-3333-3333-3333-333333333333", i, 9 - i),
            )
            .unwrap();
        }
    }

    Arc::new(Mutex::new(conn))
}

fn make_executor(conn: Arc<Mutex<Connection>>) -> Arc<dyn pathql_rs::SqlExecutor> {
    Arc::new(ClosureExecutor::new(
        SqlDialect::Sqlite,
        move |sql: &str, params: &[TemplateValue]| {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(sql).map_err(|e| {
                EngineError::FactoryFailed("sqlite".into(), "prepare".into(), e.to_string())
            })?;
            let rusq_params = local_params_for(params);
            let col_names: Vec<String> = stmt
                .column_names()
                .into_iter()
                .map(|s| s.to_string())
                .collect();
            let rows = stmt
                .query_map(rusqlite::params_from_iter(rusq_params.iter()), |row| {
                    let mut obj = serde_json::Map::new();
                    for (i, name) in col_names.iter().enumerate() {
                        let value = match row.get_ref_unwrap(i) {
                            rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                            rusqlite::types::ValueRef::Integer(i) => serde_json::Value::from(i),
                            rusqlite::types::ValueRef::Real(f) => serde_json::json!(f),
                            rusqlite::types::ValueRef::Text(t) => {
                                serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                            }
                            rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                        };
                        obj.insert(name.clone(), value);
                    }
                    Ok(serde_json::Value::Object(obj))
                })
                .map_err(|e| {
                    EngineError::FactoryFailed("sqlite".into(), "query".into(), e.to_string())
                })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
                EngineError::FactoryFailed("sqlite".into(), "collect".into(), e.to_string())
            })
        },
    ))
}

fn build_runtime() -> Arc<ProviderRuntime> {
    let globals = HashMap::from([
        (
            "favorite_album_id".to_string(),
            TemplateValue::Text(FAVORITE_ALBUM_ID.to_string()),
        ),
        (
            "hidden_album_id".to_string(),
            TemplateValue::Text(HIDDEN_ALBUM_ID.to_string()),
        ),
    ]);
    let runtime = ProviderRuntime::new(make_executor(fixture_db()), globals);
    register_embedded_dsl(&runtime);
    validate_dsl(&runtime);
    runtime.set_root("kabegame", "root_provider").unwrap();
    runtime
}

fn ids(rows: Vec<serde_json::Value>) -> Vec<String> {
    rows.into_iter()
        .map(|row| {
            row.get("id")
                .and_then(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .or_else(|| v.as_i64().map(|i| i.to_string()))
                })
                .expect("row has id")
        })
        .collect()
}

#[test]
fn gallery_all_page_fetches_expected_image_set() {
    let runtime = build_runtime();
    let rows = runtime.fetch("/gallery/all/x2x/1").unwrap();
    assert_eq!(ids(rows), ["1", "2"]);
}

#[test]
fn date_lists_expose_year_month_and_day_children() {
    let runtime = build_runtime();

    assert_date_list_chain(&runtime, "/gallery/date");
    assert_date_list_chain(&runtime, "/gallery/hide/date");
    assert_date_list_chain(&runtime, "/gallery/search/display-name/image-1/date");
    assert_date_list_chain(&runtime, "/gallery/hide/search/display-name/image-1/date");
}

fn assert_date_list_chain(runtime: &ProviderRuntime, root: &str) {
    let years = runtime.list(root).unwrap();
    assert!(
        years.iter().any(|child| child.name == "2023y"),
        "{root} years={:?}",
        years.iter().map(|child| &child.name).collect::<Vec<_>>()
    );

    let months = runtime.list(&format!("{root}/2023y")).unwrap();
    assert!(
        months.iter().any(|child| child.name == "04m"),
        "{root}/2023y months={:?}",
        months.iter().map(|child| &child.name).collect::<Vec<_>>()
    );

    let days = runtime.list(&format!("{root}/2023y/04m")).unwrap();
    assert!(
        days.iter().any(|child| child.name == "05d"),
        "{root}/2023y/04m days={:?}",
        days.iter().map(|child| &child.name).collect::<Vec<_>>()
    );
}

#[test]
fn desc_router_keeps_pagination_after_filtered_paths() {
    let runtime = build_runtime();

    let media_type = runtime
        .fetch("/gallery/media-type/image/desc/x2x/1")
        .unwrap();
    assert_eq!(ids(media_type), ["120", "119"]);

    let hidden_filtered = runtime
        .fetch("/gallery/hide/media-type/image/desc/x2x/1")
        .unwrap();
    assert_eq!(ids(hidden_filtered), ["120", "119"]);
}

#[test]
fn images_provider_pages_return_raw_image_rows() {
    let runtime = build_runtime();
    let rows = runtime.fetch("/images/x3x/2").unwrap();
    assert_eq!(ids(rows.clone()), ["4", "5", "6"]);
    let first = rows.first().unwrap();
    assert_eq!(first.get("hash").and_then(|v| v.as_str()), Some("hash-4"));
    assert_eq!(
        first.get("local_path").and_then(|v| v.as_str()),
        Some("D:/fixture/4.jpg")
    );
}

#[test]
fn images_metadata_path_prefers_table_then_legacy_metadata() {
    let runtime = build_runtime();
    let table = runtime.fetch("/images/id_1/metadata").unwrap();
    assert_eq!(
        table[0].get("metadata_json").and_then(|v| v.as_str()),
        Some("{\"source\":\"table\",\"tags\":[\"a\"]}")
    );

    let legacy = runtime.fetch("/images/id_2/metadata").unwrap();
    assert_eq!(
        legacy[0]
            .get("legacy_metadata_json")
            .and_then(|v| v.as_str()),
        Some("{\"source\":\"legacy\"}")
    );
}

#[test]
fn album_order_path_paginates_and_limit_leaf_only_limits() {
    let runtime = build_runtime();
    let paged = runtime
        .fetch("/gallery/album/33333333-3333-3333-3333-333333333333/order/x3x/1")
        .unwrap();
    let legacy_paged = runtime
        .fetch("/gallery/album/33333333-3333-3333-3333-333333333333/album-order/x3x/1")
        .unwrap();
    let legacy_desc = runtime
        .fetch("/gallery/album/33333333-3333-3333-3333-333333333333/album-order/desc/x3x/1")
        .unwrap();
    let legacy_hidden = runtime
        .fetch("/gallery/hide/album/33333333-3333-3333-3333-333333333333/album-order/x3x/1")
        .unwrap();
    let image_only = runtime
        .fetch("/gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/x3x/1")
        .unwrap();
    let image_only_legacy_order = runtime
        .fetch(
            "/gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/album-order/x3x/1",
        )
        .unwrap();
    let image_only_legacy_order_desc = runtime
        .fetch("/gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/album-order/desc/x3x/1")
        .unwrap();
    let video_only = runtime
        .fetch("/gallery/hide/album/33333333-3333-3333-3333-333333333333/video-only/x3x/1")
        .unwrap();
    let image_only_wallpaper_order = runtime
        .fetch("/gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/wallpaper-order/x3x/1")
        .unwrap();
    let album_wallpaper_order = runtime
        .fetch("/gallery/hide/album/33333333-3333-3333-3333-333333333333/wallpaper-order/x3x/1")
        .unwrap();
    let limited = runtime
        .fetch("/gallery/album/33333333-3333-3333-3333-333333333333/order/l3l")
        .unwrap();
    assert_eq!(ids(paged), ["8", "7", "6"]);
    assert_eq!(ids(legacy_paged), ["8", "7", "6"]);
    assert_eq!(ids(legacy_desc), ["6", "7", "8"]);
    assert_eq!(ids(legacy_hidden), ["8", "7", "6"]);
    assert_eq!(ids(image_only), ["6", "7", "8"]);
    assert_eq!(ids(image_only_legacy_order), ["8", "7", "6"]);
    assert_eq!(ids(image_only_legacy_order_desc), ["6", "7", "8"]);
    assert!(video_only.is_empty());
    assert!(image_only_wallpaper_order.is_empty());
    assert!(album_wallpaper_order.is_empty());
    assert_eq!(ids(limited), ["8", "7", "6"]);

    let page_node = runtime
        .resolve("/gallery/album/33333333-3333-3333-3333-333333333333/order/x3x/1")
        .unwrap();
    assert!(page_node.composed.offset_terms.len() == 1);
    let limit_node = runtime
        .resolve("/gallery/album/33333333-3333-3333-3333-333333333333/order/l3l")
        .unwrap();
    assert!(limit_node.composed.offset_terms.is_empty());
}

#[test]
fn vd_album_i18n_roots_resolve_to_same_image_set() {
    let runtime = build_runtime();
    kabegame_i18n::set_locale("zh");
    let zh = ids(runtime.fetch("/vd/i18n-zh_CN/画册/AlbumA/x100x/1").unwrap());
    kabegame_i18n::set_locale("en");
    let en = ids(runtime
        .fetch("/vd/i18n-en_US/By Album/AlbumA/x100x/1")
        .unwrap());
    assert_eq!(zh, ["1", "2", "3", "4", "5"]);
    assert_eq!(zh, en);
}

#[test]
fn vd_plugin_meta_name_tracks_current_locale() {
    let runtime = build_runtime();

    kabegame_i18n::set_locale("zh");
    let zh = runtime.list("/vd/i18n-zh_CN/按插件").unwrap();
    let zh_plugin = zh.iter().find(|c| c.name == "像素插件 - pixiv").unwrap();
    assert_eq!(
        zh_plugin.meta.as_ref().unwrap().get("name").unwrap(),
        "像素插件"
    );

    kabegame_i18n::set_locale("en");
    let en = runtime.list("/vd/i18n-en_US/By Plugin").unwrap();
    let en_plugin = en
        .iter()
        .find(|c| c.name == "Pixel Plugin - pixiv")
        .unwrap();
    assert_eq!(
        en_plugin.meta.as_ref().unwrap().get("name").unwrap(),
        "Pixel Plugin"
    );
}

#[test]
fn vd_root_routers_cover_all_supported_locales() {
    let runtime = build_runtime();

    let cases = [
        ("zh", "/vd/i18n-zh_CN", "画册", "按插件", "AlbumA"),
        ("en", "/vd/i18n-en_US", "Albums", "By Plugin", "AlbumA"),
        ("ja", "/vd/i18n-ja", "アルバム", "プラグイン別", "AlbumA"),
        ("ko", "/vd/i18n-ko", "앨범", "플러그인별", "AlbumA"),
        ("zhtw", "/vd/i18n-zhtw", "畫冊", "按外掛", "AlbumA"),
    ];

    for (locale, root, album_root, plugin_root, album_name) in cases {
        kabegame_i18n::set_locale(locale);
        let children = runtime.list(root).unwrap();
        let names = children.iter().map(|c| c.name.as_str()).collect::<Vec<_>>();
        assert!(names.contains(&album_root), "{root} names={names:?}");
        assert!(names.contains(&plugin_root), "{root} names={names:?}");

        let album_path = format!("{root}/{album_root}/{album_name}/x100x/1");
        assert_eq!(
            ids(runtime.fetch(&album_path).unwrap()),
            ["1", "2", "3", "4", "5"]
        );
    }
}

#[test]
fn resolving_many_pages_uses_bounded_prefix_cache_shape() {
    let runtime = build_runtime();
    for page in 1..=100 {
        runtime
            .resolve(&format!("/gallery/all/x1x/{page}"))
            .unwrap();
    }
    assert!(
        runtime.cache_size() <= 103,
        "cache size={}",
        runtime.cache_size()
    );
}

#[test]
fn date_path_fold_builds_expected_sql_shape() {
    let runtime = build_runtime();
    let resolved = runtime
        .resolve("/gallery/date/2023y/04m/05d/x2x/1")
        .unwrap();
    let mut ctx = TemplateContext::default();
    ctx.globals = runtime.globals().clone();
    let (sql, params) = resolved
        .composed
        .build_sql(&ctx, SqlDialect::Sqlite)
        .unwrap();

    assert!(sql.contains("FROM images"));
    assert!(sql.contains("crawled_at_seconds(images.crawled_at)"));
    assert!(sql.contains("strftime('%Y'"));
    assert!(sql.contains("strftime('%Y-%m'"));
    assert!(sql.contains("strftime('%Y-%m-%d'"));
    assert!(sql.contains("LIMIT ?"));
    let debug_params = format!("{params:?}");
    assert!(debug_params.contains("2023"));
    assert!(debug_params.contains("2023-04"));
    assert!(debug_params.contains("2023-04-05"));
}
