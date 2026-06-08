//! Phase 7c: core-level E2E for the fully-DSL provider tree.
//!
//! The fixture uses an in-memory sqlite database and test-local host SQL
//! functions, so these tests do not touch the user's Kabegame data directory.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use kabegame_core::providers::dsl_loader::{register_embedded_dsl, validate_dsl};
use kabegame_core::providers::programmatic::plugin_resource::register_plugin_resource_provider;
use kabegame_core::storage::{Album, ImageInfo, SurfRecord, TaskInfo};
use pathql_rs::provider::{ClosureExecutor, EngineError, SqlDialect};
use pathql_rs::template::eval::{TemplateContext, TemplateValue};
use pathql_rs::{LoaderType, ProviderRuntime, Source};
use rusqlite::functions::FunctionFlags;
use rusqlite::Connection;

const FAVORITE_ALBUM_ID: &str = kabegame_core::storage::FAVORITE_ALBUM_ID;
const HIDDEN_ALBUM_ID: &str = kabegame_core::storage::HIDDEN_ALBUM_ID;
const ALBUM_A_ID: &str = "11111111-1111-1111-1111-111111111111";
const TASK_A_ID: &str = "22222222-2222-2222-2222-222222222222";
static LOCALE_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock_locale_tests() -> MutexGuard<'static, ()> {
    LOCALE_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap()
}

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

    conn.create_scalar_function(
        "name_language_bucket",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<String> {
            let value: String = ctx.get(0)?;
            let bucket = value
                .chars()
                .find_map(|ch| {
                    let code = ch as u32;
                    if (0x4E00..=0x9FFF).contains(&code) || (0x3400..=0x4DBF).contains(&code) {
                        Some("chinese")
                    } else if (0x3040..=0x30FF).contains(&code) {
                        Some("japanese")
                    } else if (0xAC00..=0xD7AF).contains(&code) || (0x1100..=0x11FF).contains(&code)
                    {
                        Some("korean")
                    } else if ch.is_ascii_alphabetic() {
                        Some("english")
                    } else {
                        None
                    }
                })
                .unwrap_or("other");
            Ok(bucket.to_string())
        },
    )
    .unwrap();

    conn.create_scalar_function(
        "name_language_rank",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let bucket: String = ctx.get(0)?;
            Ok(match bucket.as_str() {
                "english" => 0,
                "chinese" => 1,
                "japanese" => 2,
                "korean" => 3,
                _ => 4,
            })
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
            data TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 0,
            plugin_id TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX idx_image_metadata_dedup
            ON image_metadata(plugin_id, version, content_hash);
        CREATE TABLE albums (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            parent_id TEXT,
            type TEXT NOT NULL DEFAULT 'normal',
            sync_folder TEXT,
            folder_status TEXT
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            plugin_id TEXT NOT NULL,
            output_dir TEXT,
            user_config TEXT,
            http_headers TEXT,
            output_album_id TEXT,
            run_config_id TEXT,
            trigger_source TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            progress REAL NOT NULL DEFAULT 0,
            deleted_count INTEGER NOT NULL DEFAULT 0,
            dedup_count INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            start_time INTEGER,
            end_time INTEGER,
            error TEXT
        );
        CREATE TABLE task_failed_images (
            id INTEGER PRIMARY KEY,
            task_id TEXT NOT NULL,
            plugin_id TEXT NOT NULL,
            url TEXT NOT NULL,
            "order" INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            last_error TEXT,
            last_attempted_at INTEGER,
            header_snapshot TEXT,
            metadata_id INTEGER,
            display_name TEXT
        );
        CREATE TABLE surf_records (
            id TEXT PRIMARY KEY,
            host TEXT NOT NULL UNIQUE,
            root_url TEXT NOT NULL,
            icon BLOB,
            last_visit_at INTEGER NOT NULL,
            download_count INTEGER NOT NULL DEFAULT 0,
            deleted_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            cookie TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO albums(id, name, created_at, parent_id) VALUES
            ('11111111-1111-1111-1111-111111111111', 'AlbumA', 1, NULL),
            ('33333333-3333-3333-3333-333333333333', 'AlbumChild', 2, '11111111-1111-1111-1111-111111111111');
        INSERT INTO image_metadata(id, data, content_hash, version, plugin_id) VALUES
            (1, '{"source":"table","tags":["a"]}', 'fixture-hash-1', 0, 'pixiv');
        INSERT INTO tasks VALUES
            (
                '22222222-2222-2222-2222-222222222222',
                'pixiv',
                NULL,
                '{"quality":"high"}',
                '{"User-Agent":"Kabegame"}',
                NULL,
                NULL,
                'manual',
                'done',
                100.0,
                0,
                1,
                2,
                0,
                10,
                11,
                NULL
            );
        INSERT INTO task_failed_images VALUES
            (1, '22222222-2222-2222-2222-222222222222', 'pixiv', 'https://example.test/fail-1.jpg', 10, 30, 'network', 31, '{"User-Agent":"Kabegame"}', 1, 'failed-1'),
            (2, 'other-task', 'pixiv', 'https://example.test/fail-2.jpg', 20, 32, 'timeout', NULL, NULL, NULL, 'failed-2');
        INSERT INTO surf_records VALUES
            ('surf-a', 'pixiv.test', 'https://pixiv.test', NULL, 20, 2, 0, 10, 'Pixiv Test', '');
        "#,
    )
    .unwrap();

    for i in 1..=120 {
        let crawled_at = 1_680_652_800_i64 + (i as i64 * 60);
        let media_type = match i {
            118 => "video/mp4",
            119 => "image/webp",
            _ => "image/jpeg",
        };
        let (width, height) = match i {
            111 => (900, 1600),  // 9:16 portrait lower boundary
            112 => (300, 400),   // 3:4 square lower boundary
            113 => (400, 300),   // 4:3 square upper boundary
            114 => (1600, 900),  // 16:9 landscape upper boundary
            115 => (1920, 900),  // widescreen
            116 => (3000, 1000), // too wide
            117 => (100, 300),   // too narrow
            118 => (1920, 1080), // 16:9 video, still landscape
            119 => (1000, 1000),
            _ => (100, 100),
        };
        conn.execute(
            "INSERT INTO images
             (id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at,
              metadata_id, thumbnail_path, hash, type, width, height, display_name, size)
             VALUES (?1, ?2, ?3, 'pixiv', ?4, 'surf-a', ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, 10)",
            (
                i,
                format!("https://example.test/{i}.jpg"),
                format!("D:/fixture/{i}.jpg"),
                TASK_A_ID,
                crawled_at,
                if i == 1 { Some(1_i64) } else { None },
                format!("hash-{i}"),
                media_type,
                width,
                height,
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
        if i == 9 {
            conn.execute(
                "INSERT INTO album_images(album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                (HIDDEN_ALBUM_ID, i, i),
            )
            .unwrap();
        }
        if i == 10 {
            conn.execute(
                "INSERT INTO album_images(album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                (FAVORITE_ALBUM_ID, i, i),
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
    runtime
        .register_schema("images", "images", "kabegame", "images_root_provider")
        .unwrap();
    runtime
        .register_schema("albums", "albums", "kabegame", "albums_root_provider")
        .unwrap();
    runtime
        .register_schema("tasks", "tasks", "kabegame", "tasks_root_provider")
        .unwrap();
    runtime
        .register_schema(
            "fail-images",
            "task_failed_images",
            "kabegame",
            "fail_images_root_provider",
        )
        .unwrap();
    runtime
        .register_schema(
            "surf_records",
            "surf_records",
            "kabegame",
            "surf_records_root_provider",
        )
        .unwrap();
    register_plugin_resource_provider(&runtime).unwrap();
    runtime
        .register_schema(
            "plugin",
            "(SELECT 1)",
            "kabegame",
            "plugin_resource_root_provider",
        )
        .unwrap();
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
fn schema_registration_smoke_and_schemaless_paths_fail() {
    let runtime = build_runtime();

    assert_eq!(
        runtime.registered_schemes(),
        vec![
            "albums".to_string(),
            "fail-images".to_string(),
            "images".to_string(),
            "plugin".to_string(),
            "surf_records".to_string(),
            "tasks".to_string()
        ]
    );
    assert!(runtime.list("images://gallery").is_ok());

    let err = runtime.list("/gallery").unwrap_err();
    assert!(matches!(err, EngineError::MissingScheme(path) if path == "/gallery"));
}

#[test]
fn plural_resource_schemas_fetch_and_deserialize_rows() {
    let runtime = build_runtime();

    let image = runtime
        .fetch("images://id_1")
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let image: ImageInfo = serde_json::from_value(image).unwrap();
    assert_eq!(image.id, "1");

    let album = runtime
        .fetch(&format!("albums://id_{ALBUM_A_ID}"))
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let album: Album = serde_json::from_value(album).unwrap();
    assert_eq!(album.id, ALBUM_A_ID);

    let task = runtime
        .fetch(&format!("tasks://id_{TASK_A_ID}"))
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let task: TaskInfo = serde_json::from_value(task).unwrap();
    assert_eq!(task.id, TASK_A_ID);
    assert_eq!(
        task.user_config
            .as_ref()
            .and_then(|config| config.get("quality"))
            .and_then(|value| value.as_str()),
        Some("high")
    );

    let failed = runtime
        .fetch("fail-images://id_1")
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(failed["id"], 1);
    assert_eq!(failed["task_id"], TASK_A_ID);
    let header_snapshot: serde_json::Value =
        serde_json::from_str(failed["header_snapshot"].as_str().unwrap()).unwrap();
    assert_eq!(header_snapshot["User-Agent"], "Kabegame");

    let failed_ids = ids(runtime
        .fetch("fail-images://tasks/id_22222222-2222-2222-2222-222222222222")
        .unwrap());
    assert_eq!(failed_ids, ["1"]);
    let all_failed_ids = ids(runtime.fetch("fail-images://all").unwrap());
    assert_eq!(all_failed_ids, ["2", "1"]);

    let surf = runtime
        .fetch("surf_records://id_surf-a")
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let surf: SurfRecord = serde_json::from_value(surf).unwrap();
    assert_eq!(surf.id, "surf-a");
    assert_eq!(surf.image_count, 120);
}

#[test]
fn root_gallery_and_vd_topology_uses_images_schema() {
    let runtime = build_runtime();

    assert_eq!(runtime.count("images://").unwrap(), 120);
    assert_eq!(runtime.count("images://gallery/all").unwrap(), 120);

    let plugins = runtime.list("images://gallery/plugin").unwrap();
    assert_eq!(
        plugins
            .iter()
            .map(|child| child.name.as_str())
            .collect::<Vec<_>>(),
        ["pixiv"]
    );

    let years = runtime.list("images://gallery/date").unwrap();
    assert!(
        years.iter().any(|child| child.name == "2023y"),
        "years={:?}",
        years.iter().map(|child| &child.name).collect::<Vec<_>>()
    );

    let vd = runtime.list("images://vd/i18n-en_US").unwrap();
    let vd_names = vd
        .iter()
        .map(|child| child.name.as_str())
        .collect::<Vec<_>>();
    for expected in ["Albums", "By Plugin", "By Dimensions"] {
        assert!(vd_names.contains(&expected), "vd names={vd_names:?}");
    }
}

#[test]
fn image_basic_delegate_contributes_fields_order_and_schema_from() {
    let runtime = build_runtime();
    let resolved = runtime.resolve("images://x100x/1").unwrap();
    let mut ctx = TemplateContext::default();
    ctx.globals = runtime.globals().clone();
    let (sql, _) = resolved
        .composed
        .build_sql(&ctx, SqlDialect::Sqlite)
        .unwrap();

    assert!(sql.contains("SELECT images.*"), "{sql}");
    assert!(sql.contains("FROM images"), "{sql}");
    assert!(sql.contains("ORDER BY images.id ASC"), "{sql}");
}

#[test]
fn dsl_loader_rejects_legacy_from_contribution() {
    let runtime = ProviderRuntime::new(make_executor(fixture_db()), HashMap::new());
    let err = runtime
        .register_provider_dsl(
            LoaderType::JSON5,
            Source::Str(
                r#"{
                    "namespace": "kabegame",
                    "name": "bad_from_provider",
                    "query": { "from": "images" }
                }"#,
            ),
        )
        .unwrap_err();

    assert!(matches!(err, EngineError::Load(_)), "{err}");
}

#[test]
fn gallery_all_page_fetches_expected_image_set() {
    let runtime = build_runtime();
    let rows = runtime.fetch("images://gallery/all/x2x/1").unwrap();
    assert_eq!(ids(rows), ["1", "2"]);
}

#[test]
fn gallery_by_routes_fetch_single_images() {
    let runtime = build_runtime();
    for (path, expected_id) in [
        ("images://gallery/by_id/7", "7"),
        ("images://gallery/by_path/D%3A%2Ffixture%2F8.jpg", "8"),
        (
            "images://gallery/by_thumbnail_path/D%3A%2Ffixture%2F9.jpg",
            "9",
        ),
        (
            "images://gallery/by_url/https%3A%2F%2Fexample.test%2F10.jpg",
            "10",
        ),
        ("images://gallery/by_hash/hash-11", "11"),
    ] {
        let rows = runtime
            .fetch(path)
            .unwrap_or_else(|e| panic!("{path} should fetch: {e}"));
        assert_eq!(ids(rows), [expected_id], "path={path}");
    }

    let rows = runtime.fetch("images://gallery/by_id/7").unwrap();
    assert_eq!(
        rows[0].get("surf_record_id").and_then(|v| v.as_str()),
        Some("surf-a")
    );
}

#[test]
fn date_lists_expose_year_month_and_day_children() {
    let runtime = build_runtime();

    assert_date_list_chain(&runtime, "images://gallery/date");
    assert_date_list_chain(&runtime, "images://gallery/hide/date");
    assert_date_list_chain(
        &runtime,
        "images://gallery/search/display-name/image-1/date",
    );
    assert_date_list_chain(
        &runtime,
        "images://gallery/hide/search/display-name/image-1/date",
    );
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
        .fetch("images://gallery/media-type/image/desc/x2x/1")
        .unwrap();
    assert_eq!(ids(media_type), ["120", "119"]);

    let webp = runtime
        .fetch("images://gallery/media-type/image/webp/desc/x2x/1")
        .unwrap();
    assert_eq!(ids(webp), ["119"]);

    let mp4 = runtime
        .fetch("images://gallery/media-type/video/mp4/x2x/1")
        .unwrap();
    assert_eq!(ids(mp4), ["118"]);

    let image_formats = runtime.list("images://gallery/media-type/image").unwrap();
    let image_format_names = image_formats
        .iter()
        .map(|child| child.name.as_str())
        .collect::<Vec<_>>();
    assert!(
        image_format_names.contains(&"jpeg"),
        "{image_format_names:?}"
    );
    assert!(
        image_format_names.contains(&"webp"),
        "{image_format_names:?}"
    );

    let hidden_filtered = runtime
        .fetch("images://gallery/hide/media-type/image/desc/x2x/1")
        .unwrap();
    assert_eq!(ids(hidden_filtered), ["120", "119"]);
}

#[test]
fn gallery_sort_by_id_provider_orders_default_ids() {
    let runtime = build_runtime();

    let by_id = runtime.fetch("images://gallery/sort/by-id/x3x/1").unwrap();
    assert_eq!(ids(by_id), ["1", "2", "3"]);

    let by_id_desc = runtime
        .fetch("images://gallery/sort/by-id/desc/x3x/1")
        .unwrap();
    assert_eq!(ids(by_id_desc), ["120", "119", "118"]);
}

#[test]
fn gallery_search_sort_paths_allow_empty_results() {
    let runtime = build_runtime();

    let rows = runtime
        .fetch("images://gallery/search/display-name/image-1/sort/by-id/x3x/1")
        .unwrap();
    assert_eq!(ids(rows), ["1", "10", "11"]);

    let hidden_rows = runtime
        .fetch("images://gallery/hide/search/display-name/image-1/sort/by-id/x3x/1")
        .unwrap();
    assert_eq!(ids(hidden_rows), ["1", "10", "11"]);

    let empty_rows = runtime
        .fetch("images://gallery/search/display-name/not-found/sort/by-id/x3x/1")
        .unwrap();
    assert!(empty_rows.is_empty());

    let hidden_empty_rows = runtime
        .fetch("images://gallery/hide/search/display-name/not-found/sort/by-set-time/x3x/1")
        .unwrap();
    assert!(hidden_empty_rows.is_empty());
}

#[test]
fn gallery_aspect_buckets_filter_and_explicit_sort_by_ratio() {
    let runtime = build_runtime();

    let buckets = runtime.list("images://gallery/aspect").unwrap();
    let names = buckets
        .iter()
        .map(|child| child.name.as_str())
        .collect::<Vec<_>>();
    for expected in [
        "landscape-4x3-16x9",
        "widescreen-16x9-21x9",
        "square-3x4-4x3",
        "portrait-9x16-3x4",
        "other",
    ] {
        assert!(names.contains(&expected), "aspect names={names:?}");
    }

    let portrait = runtime
        .fetch("images://gallery/aspect/portrait-9x16-3x4/x10x/1")
        .unwrap();
    assert_eq!(ids(portrait), ["111"]);

    let landscape = runtime
        .fetch("images://gallery/aspect/landscape-4x3-16x9/x10x/1")
        .unwrap();
    assert_eq!(ids(landscape), ["114", "118"]);

    let landscape_desc = runtime
        .fetch("images://gallery/aspect/landscape-4x3-16x9/desc/x10x/1")
        .unwrap();
    assert_eq!(ids(landscape_desc), ["118", "114"]);

    let widescreen = runtime
        .fetch("images://gallery/aspect/widescreen-16x9-21x9/x10x/1")
        .unwrap();
    assert_eq!(ids(widescreen), ["115"]);

    let other = runtime
        .fetch("images://gallery/aspect/other/x10x/1")
        .unwrap();
    assert_eq!(ids(other), ["116", "117"]);

    let other_by_aspect = runtime
        .fetch("images://gallery/aspect/other/filter_comb/sort/by-aspect/x10x/1")
        .unwrap();
    assert_eq!(ids(other_by_aspect), ["117", "116"]);

    let other_by_aspect_desc = runtime
        .fetch("images://gallery/aspect/other/filter_comb/sort/by-aspect/desc/x10x/1")
        .unwrap();
    assert_eq!(ids(other_by_aspect_desc), ["116", "117"]);
}

#[test]
fn gallery_filter_combines_dimensions_and_sort() {
    let runtime = build_runtime();

    let image_landscape = runtime
        .fetch("images://gallery/media-type/image/filter_comb/aspect/landscape-4x3-16x9/x10x/1")
        .unwrap();
    assert_eq!(ids(image_landscape), ["114"]);

    let image_landscape_by_size_desc = runtime
        .fetch("images://gallery/media-type/image/filter_comb/aspect/landscape-4x3-16x9/filter_comb/sort/by-size/desc/x10x/1")
        .unwrap();
    assert_eq!(ids(image_landscape_by_size_desc), ["114"]);

    let plugin_image_webp = runtime
        .fetch("images://gallery/plugin/pixiv/filter_comb/media-type/image/webp/x10x/1")
        .unwrap();
    assert_eq!(ids(plugin_image_webp), ["119"]);

    let count = runtime
        .count("images://gallery/media-type/image/filter_comb/aspect/other")
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn gallery_no_album_filter_excludes_non_hidden_album_memberships() {
    let runtime = build_runtime();

    let no_album = runtime.fetch("images://gallery/no-album/x10x/1").unwrap();
    assert_eq!(
        ids(no_album),
        ["9", "11", "12", "13", "14", "15", "16", "17", "18", "19"]
    );
    assert_eq!(runtime.count("images://gallery/no-album").unwrap(), 111);

    let combined = runtime
        .fetch("images://gallery/media-type/image/filter_comb/no-album/filter_comb/sort/by-size/desc/x10x/1")
        .unwrap();
    let combined_ids = ids(combined);
    assert_eq!(combined_ids.len(), 10);
    assert!(!combined_ids.contains(&"10".to_string()));
    assert!(!combined_ids.contains(&"1".to_string()));
    assert_eq!(
        runtime
            .count(
                "images://gallery/media-type/image/filter_comb/no-album/filter_comb/sort/by-size"
            )
            .unwrap(),
        110
    );
}

#[test]
fn images_provider_pages_return_raw_image_rows() {
    let runtime = build_runtime();
    let rows = runtime.fetch("images://x3x/2").unwrap();
    assert_eq!(ids(rows.clone()), ["4", "5", "6"]);
    let first = rows.first().unwrap();
    assert_eq!(first.get("hash").and_then(|v| v.as_str()), Some("hash-4"));
    assert_eq!(
        first.get("local_path").and_then(|v| v.as_str()),
        Some("D:/fixture/4.jpg")
    );
}

#[test]
fn images_metadata_path_reads_table_metadata() {
    let runtime = build_runtime();
    let table = runtime.fetch("images://id_1/metadata").unwrap();
    assert_eq!(
        table[0].get("metadata_json").and_then(|v| v.as_str()),
        Some("{\"source\":\"table\",\"tags\":[\"a\"]}")
    );

    let legacy = runtime.fetch("images://id_2/metadata").unwrap();
    assert_eq!(
        legacy[0].get("metadata_json").and_then(|v| v.as_str()),
        None
    );
}

#[test]
fn album_order_path_paginates_and_limit_leaf_only_limits() {
    let runtime = build_runtime();
    let paged = runtime
        .fetch("images://gallery/album/33333333-3333-3333-3333-333333333333/order/x3x/1")
        .unwrap();
    let legacy_paged = runtime
        .fetch("images://gallery/album/33333333-3333-3333-3333-333333333333/album-order/x3x/1")
        .unwrap();
    let legacy_desc = runtime
        .fetch("images://gallery/album/33333333-3333-3333-3333-333333333333/album-order/desc/x3x/1")
        .unwrap();
    let legacy_hidden = runtime
        .fetch("images://gallery/hide/album/33333333-3333-3333-3333-333333333333/album-order/x3x/1")
        .unwrap();
    let image_only = runtime
        .fetch("images://gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/x3x/1")
        .unwrap();
    let image_only_legacy_order = runtime
        .fetch(
            "images://gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/album-order/x3x/1",
        )
        .unwrap();
    let image_only_legacy_order_desc = runtime
        .fetch("images://gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/album-order/desc/x3x/1")
        .unwrap();
    let video_only = runtime
        .fetch("images://gallery/hide/album/33333333-3333-3333-3333-333333333333/video-only/x3x/1");
    let image_only_wallpaper_order = runtime.fetch(
        "images://gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/wallpaper-order/x3x/1",
    );
    let album_wallpaper_order = runtime.fetch(
        "images://gallery/hide/album/33333333-3333-3333-3333-333333333333/wallpaper-order/x3x/1",
    );
    let bigger_order = runtime
        .fetch("images://gallery/album/33333333-3333-3333-3333-333333333333/bigger_order/1/l100l")
        .unwrap();
    let limited = runtime
        .fetch("images://gallery/album/33333333-3333-3333-3333-333333333333/order/l3l")
        .unwrap();
    assert_eq!(ids(paged), ["8", "7", "6"]);
    assert_eq!(ids(legacy_paged), ["8", "7", "6"]);
    assert_eq!(ids(legacy_desc), ["6", "7", "8"]);
    assert_eq!(ids(legacy_hidden), ["8", "7", "6"]);
    assert_eq!(ids(image_only), ["6", "7", "8"]);
    assert_eq!(ids(image_only_legacy_order), ["8", "7", "6"]);
    assert_eq!(ids(image_only_legacy_order_desc), ["6", "7", "8"]);
    assert!(
        matches!(video_only, Err(EngineError::PathNotFound(path)) if path == "images://gallery/hide/album/33333333-3333-3333-3333-333333333333/video-only/x3x/1")
    );
    assert!(matches!(
        image_only_wallpaper_order,
        Err(EngineError::PathNotFound(path))
            if path == "images://gallery/hide/album/33333333-3333-3333-3333-333333333333/image-only/wallpaper-order/x3x/1"
    ));
    assert!(matches!(
        album_wallpaper_order,
        Err(EngineError::PathNotFound(path))
            if path == "images://gallery/hide/album/33333333-3333-3333-3333-333333333333/wallpaper-order/x3x/1"
    ));
    assert_eq!(ids(bigger_order), ["7", "6"]);
    assert_eq!(ids(limited), ["8", "7", "6"]);

    let single = runtime
        .fetch("images://gallery/album/33333333-3333-3333-3333-333333333333/id_7")
        .unwrap();
    assert_eq!(ids(single.clone()), ["7"]);
    assert_eq!(
        single[0].get("album_order").and_then(|v| v.as_i64()),
        Some(2)
    );

    let page_node = runtime
        .resolve("images://gallery/album/33333333-3333-3333-3333-333333333333/order/x3x/1")
        .unwrap();
    assert!(page_node.composed.offset_terms.len() == 1);
    let limit_node = runtime
        .resolve("images://gallery/album/33333333-3333-3333-3333-333333333333/order/l3l")
        .unwrap();
    assert!(limit_node.composed.offset_terms.is_empty());

    let album_children = runtime
        .list("images://gallery/hide/album/33333333-3333-3333-3333-333333333333")
        .unwrap();
    let child_names: Vec<_> = album_children.iter().map(|c| c.name.as_str()).collect();
    for control in ["1", "desc", "order", "album-order", "x100x"] {
        assert!(
            !child_names.contains(&control),
            "gallery album list should not expose control segment {control}: {child_names:?}"
        );
    }
}

#[test]
fn vd_album_i18n_roots_resolve_to_same_image_set() {
    let _locale_guard = lock_locale_tests();
    let runtime = build_runtime();
    kabegame_i18n::set_locale("zh");
    let zh = ids(runtime
        .fetch("images://vd/i18n-zh_CN/画册/AlbumA/x100x/1")
        .unwrap());
    kabegame_i18n::set_locale("en");
    let en = ids(runtime
        .fetch("images://vd/i18n-en_US/By Album/AlbumA/x100x/1")
        .unwrap());
    assert_eq!(zh, ["1", "2", "3", "4", "5"]);
    assert_eq!(zh, en);
}

#[test]
fn vd_media_type_lists_all_formats_and_specific_formats() {
    let _locale_guard = lock_locale_tests();
    let runtime = build_runtime();
    kabegame_i18n::set_locale("zh");

    let all = runtime
        .fetch("images://vd/i18n-zh_CN/按媒体/所有格式/1")
        .unwrap();
    let all_ids = ids(all);
    assert_eq!(&all_ids[..3], ["1", "2", "3"]);

    let mp4 = runtime
        .fetch("images://vd/i18n-zh_CN/按媒体/视频/mp4/1")
        .unwrap();
    assert_eq!(ids(mp4), ["118"]);
}

#[test]
fn vd_aspect_i18n_roots_list_localized_ratio_buckets() {
    let _locale_guard = lock_locale_tests();
    let runtime = build_runtime();

    kabegame_i18n::set_locale("zh");
    let zh = runtime.list("images://vd/i18n-zh_CN/按尺寸").unwrap();
    let zh_names = zh.iter().map(|c| c.name.as_str()).collect::<Vec<_>>();
    assert!(
        zh_names
            .iter()
            .all(|name| is_windows_safe_vd_dir_name(name)),
        "{zh_names:?}"
    );
    assert!(zh_names.contains(&"横屏 (4x3-16x9)"), "{zh_names:?}");
    assert!(zh_names.contains(&"宽屏 (16x9-21x9)"), "{zh_names:?}");
    assert_eq!(zh_names.len(), 5, "{zh_names:?}");
    assert_eq!(
        ids(runtime
            .fetch("images://vd/i18n-zh_CN/按尺寸/横屏 (4x3-16x9)/x100x/1")
            .unwrap()),
        ["114", "118"]
    );

    kabegame_i18n::set_locale("en");
    let en = runtime
        .list("images://vd/i18n-en_US/By Dimensions")
        .unwrap();
    let en_names = en.iter().map(|c| c.name.as_str()).collect::<Vec<_>>();
    assert!(
        en_names
            .iter()
            .all(|name| is_windows_safe_vd_dir_name(name)),
        "{en_names:?}"
    );
    assert!(en_names.contains(&"Landscape (4x3-16x9)"), "{en_names:?}");
    assert_eq!(en_names.len(), 5, "{en_names:?}");
    assert_eq!(
        ids(runtime
            .fetch("images://vd/i18n-en_US/By Dimensions/Landscape (4x3-16x9)/x100x/1")
            .unwrap()),
        ["114", "118"]
    );
}

fn is_windows_safe_vd_dir_name(name: &str) -> bool {
    !name
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
}

#[test]
fn vd_plugin_meta_name_tracks_current_locale() {
    let _locale_guard = lock_locale_tests();
    let runtime = build_runtime();

    kabegame_i18n::set_locale("zh");
    let zh = runtime.list("images://vd/i18n-zh_CN/按插件").unwrap();
    let zh_plugin = zh.iter().find(|c| c.name == "像素插件 - pixiv").unwrap();
    assert_eq!(
        zh_plugin.meta.as_ref().unwrap().get("name").unwrap(),
        "像素插件"
    );

    kabegame_i18n::set_locale("en");
    let en = runtime.list("images://vd/i18n-en_US/By Plugin").unwrap();
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
    let _locale_guard = lock_locale_tests();
    let runtime = build_runtime();

    let cases = [
        (
            "zh",
            "images://vd/i18n-zh_CN",
            "画册",
            "按插件",
            "按尺寸",
            "AlbumA",
        ),
        (
            "en",
            "images://vd/i18n-en_US",
            "Albums",
            "By Plugin",
            "By Dimensions",
            "AlbumA",
        ),
        (
            "ja",
            "images://vd/i18n-ja",
            "アルバム",
            "プラグイン別",
            "寸法別",
            "AlbumA",
        ),
        (
            "ko",
            "images://vd/i18n-ko",
            "앨범",
            "플러그인별",
            "크기 비율별",
            "AlbumA",
        ),
        (
            "zhtw",
            "images://vd/i18n-zhtw",
            "畫冊",
            "按外掛",
            "按尺寸",
            "AlbumA",
        ),
    ];

    for (locale, root, album_root, plugin_root, aspect_root, album_name) in cases {
        kabegame_i18n::set_locale(locale);
        let children = runtime.list(root).unwrap();
        let names = children.iter().map(|c| c.name.as_str()).collect::<Vec<_>>();
        assert!(names.contains(&album_root), "{root} names={names:?}");
        assert!(names.contains(&plugin_root), "{root} names={names:?}");
        assert!(names.contains(&aspect_root), "{root} names={names:?}");

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
            .resolve(&format!("images://gallery/all/x1x/{page}"))
            .unwrap();
    }
    // The first list fallback at /gallery/all/x1x expands and caches all
    // countable page nodes from the fixture (120), plus the three route
    // prefixes used to reach them.
    assert!(
        runtime.cache_size() <= 123,
        "cache size={}",
        runtime.cache_size()
    );
}

#[test]
fn date_path_fold_builds_expected_sql_shape() {
    let runtime = build_runtime();
    let resolved = runtime
        .resolve("images://gallery/date/2023y/04m/05d/x2x/1")
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
