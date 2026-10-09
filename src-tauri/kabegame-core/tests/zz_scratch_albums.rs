//! Phase 7c: core-level E2E for the fully-DSL provider tree.
//!
//! The fixture uses an in-memory sqlite database and test-local host SQL
//! functions, so these tests do not touch the user's Kabegame data directory.

use std::collections::{HashMap, HashSet};
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
const LABEL_HATSUNE_ID: &str = "66666666-6666-6666-6666-666666666666";
const LABEL_VOCALOID_ID: &str = "77777777-7777-7777-7777-777777777777";
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

fn fixture_kb_rand_arg(
    ctx: &rusqlite::functions::Context<'_>,
    idx: usize,
) -> rusqlite::Result<i64> {
    match ctx.get_raw(idx) {
        rusqlite::types::ValueRef::Integer(value) => Ok(value),
        rusqlite::types::ValueRef::Text(value) => std::str::from_utf8(value)
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or_else(|| {
                rusqlite::Error::UserFunctionError(
                    format!("kb_rand: argument {} must be an integer", idx + 1).into(),
                )
            }),
        _ => Err(rusqlite::Error::UserFunctionError(
            format!("kb_rand: argument {} must be an integer", idx + 1).into(),
        )),
    }
}

fn register_fixture_functions(conn: &Connection) {
    conn.create_scalar_function(
        "is_search_dummy_url",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let rusqlite::types::ValueRef::Text(bytes) = ctx.get_raw(0) else {
                return Ok(1);
            };
            let url = String::from_utf8_lossy(bytes);
            Ok(kabegame_core::crawler::downloader::is_search_dummy_url(url.trim()) as i64)
        },
    )
    .unwrap();

    conn.create_scalar_function(
        "kb_rand",
        2,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let seed = fixture_kb_rand_arg(ctx, 0)?;
            let id = fixture_kb_rand_arg(ctx, 1)?;
            Ok(kabegame_core::storage::dsl_funcs::kb_rand_value(seed, id))
        },
    )
    .unwrap();

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
                "displayName": name,
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
            size INTEGER,
            description TEXT,
            compatible_path TEXT,
            post_url TEXT,
            wallpaper_compatible_path TEXT,
            image_metadata_id INTEGER,
            aspect_ratio REAL GENERATED ALWAYS AS (CASE WHEN width > 0 AND height > 0 THEN CAST(width AS REAL) / height END) VIRTUAL
        );
        CREATE TABLE album_images (
            album_id TEXT NOT NULL,
            image_id INTEGER NOT NULL,
            "order" INTEGER,
            PRIMARY KEY (album_id, image_id)
        );
        CREATE TABLE metadata (
            id INTEGER PRIMARY KEY,
            data TEXT NOT NULL,
            plugin_version INTEGER NOT NULL DEFAULT 0,
            plugin_id TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX idx_metadata_dedup
            ON metadata(plugin_id, plugin_version);
        CREATE TABLE albums (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            parent_id TEXT,
            type TEXT NOT NULL DEFAULT 'normal',
            sync_folder TEXT,
            folder_status TEXT,
            ancestor_path TEXT NOT NULL DEFAULT '',
            sync_mode TEXT NOT NULL DEFAULT 'none',
            label_key TEXT,
            label_path TEXT
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
            display_name TEXT,
            labels TEXT
        );
        CREATE TABLE surf_records (
            id TEXT PRIMARY KEY,
            host TEXT NOT NULL UNIQUE,
            root_url TEXT NOT NULL,
            icon BLOB,
            last_visit_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            cookie TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO albums(id, name, created_at, parent_id, ancestor_path) VALUES
            ('11111111-1111-1111-1111-111111111111', 'AlbumA', 1, NULL, '/11111111-1111-1111-1111-111111111111/'),
            ('33333333-3333-3333-3333-333333333333', 'AlbumChild', 2, '11111111-1111-1111-1111-111111111111', '/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/');
        INSERT INTO albums(id, name, created_at, parent_id, type, ancestor_path, label_key, label_path) VALUES
            ('44444444-4444-4444-4444-444444444444', 'Pixiv', 3, NULL, 'label_dir', '/44444444-4444-4444-4444-444444444444/', 'Pixiv', 'Pixiv'),
            ('55555555-5555-5555-5555-555555555555', '角色', 4, '44444444-4444-4444-4444-444444444444', 'label_dir', '/44444444-4444-4444-4444-444444444444/55555555-5555-5555-5555-555555555555/', 'Character', 'Pixiv/Character'),
            ('66666666-6666-6666-6666-666666666666', '初音未来', 5, '55555555-5555-5555-5555-555555555555', 'label', '/44444444-4444-4444-4444-444444444444/55555555-5555-5555-5555-555555555555/66666666-6666-6666-6666-666666666666/', 'Hatsune', 'Pixiv/Character/Hatsune'),
            ('77777777-7777-7777-7777-777777777777', 'Vocaloid', 6, '44444444-4444-4444-4444-444444444444', 'label', '/44444444-4444-4444-4444-444444444444/77777777-7777-7777-7777-777777777777/', 'Vocaloid', 'Pixiv/Vocaloid');
        INSERT INTO metadata(id, data, plugin_version, plugin_id) VALUES
            (1, '{"source":"table","tags":["a"]}', 0, 'pixiv');
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
                'completed',
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
            (1, '22222222-2222-2222-2222-222222222222', 'pixiv', 'https://example.test/fail-1.jpg', 10, 30, 'network', 31, '{"User-Agent":"Kabegame"}', 1, 'failed-1', '[{"segments":["pixiv"],"key":"hatsune","name":null}]'),
            (2, 'other-task', 'pixiv', 'https://example.test/fail-2.jpg', 20, 32, 'timeout', NULL, NULL, NULL, 'failed-2', NULL);
        INSERT INTO surf_records (
            id, host, root_url, icon, last_visit_at, created_at, name, cookie
        ) VALUES (
            'surf-a', 'pixiv.test', 'https://pixiv.test', NULL, 20, 10, 'Pixiv Test', ''
        );
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

    conn.execute(
        "INSERT INTO images
         (id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at,
          metadata_id, thumbnail_path, hash, type, width, height, display_name, size, post_url)
         VALUES (121, 'file:///D:/import/a.jpg', ?1, 'pixiv', ?2, 'surf-a', 1680660060,
                 NULL, '', 'hash-121', 'image/jpeg', 100, 100, 'local-file', 10, NULL)",
        (r"D:\pics\a.jpg", TASK_A_ID),
    )
    .unwrap();
    conn.execute(
        "INSERT INTO images
         (id, url, local_path, plugin_id, task_id, surf_record_id, crawled_at,
          metadata_id, thumbnail_path, hash, type, width, height, display_name, size, post_url)
         VALUES (122, 'data:dummy', 'D:/import/dummy.jpg', 'pixiv', ?1, 'surf-a', 1680660120,
                 NULL, '', 'hash-122', 'image/jpeg', 100, 100, 'dummy-url', 10,
                 'https://post.test/p/1')",
        [TASK_A_ID],
    )
    .unwrap();

    for (album_id, image_id) in [
        (LABEL_HATSUNE_ID, 1_i64),
        (LABEL_VOCALOID_ID, 1_i64),
        (LABEL_HATSUNE_ID, 2_i64),
        (LABEL_HATSUNE_ID, 3_i64),
    ] {
        conn.execute(
            "INSERT INTO album_images(album_id, image_id, \"order\") VALUES (?1, ?2, NULL)",
            (album_id, image_id),
        )
        .unwrap();
    }

    // 画册目录分页与 LIKE 字面转义夹具；UUID 保持可由新节点按 id 寻址。
    for i in 0..105_u32 {
        let id = format!("80000000-0000-0000-0000-{i:012}");
        conn.execute(
            "INSERT INTO albums(id, name, created_at, parent_id, type, ancestor_path)
             VALUES (?1, ?2, ?3, NULL, 'normal', '/' || ?1 || '/')",
            (&id, format!("Paged {i:03}"), 1000 + i as i64),
        )
        .unwrap();
    }
    for (id, name, kind) in [
        ("90000000-0000-0000-0000-000000000001", "literal%mark", "normal"),
        ("90000000-0000-0000-0000-000000000002", "literal_under_", "normal"),
        ("90000000-0000-0000-0000-000000000003", r"literal\slash", "normal"),
        ("90000000-0000-0000-0000-000000000004", "Local root", "local_folder"),
    ] {
        conn.execute(
            "INSERT INTO albums(id, name, created_at, parent_id, type, ancestor_path)
             VALUES (?1, ?2, 2000, NULL, ?3, '/' || ?1 || '/')",
            (id, name, kind),
        )
        .unwrap();
    }

    Arc::new(Mutex::new(conn))
}

fn make_executor(conn: Arc<Mutex<Connection>>) -> Arc<dyn pathql_rs::SqlExecutor> {
    Arc::new(ClosureExecutor::new(
        SqlDialect::Sqlite,
        move |sql: &str, params: &[TemplateValue]| {
            let conn = conn.lock().unwrap();
            let t0 = std::time::Instant::now();
            eprintln!("\n[SQL start] params={:?}\n{}", params, sql);
            conn.progress_handler(100000, Some(move || t0.elapsed().as_secs() > 8));
            struct Log<'a>(&'a str, std::time::Instant, String);
            impl Drop for Log<'_> { fn drop(&mut self) { eprintln!("\n[SQL {:?}] params={} \n{}\n", self.1.elapsed(), self.2, self.0); } }
            let _log = Log(sql, t0, format!("{:?}", params));
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
    let runtime = ProviderRuntime::new(make_executor(snap_db()), globals);
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
        .register_programmatic_schema("plugin", "kabegame", "plugin_resource_root_provider")
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


fn snap_db() -> Arc<Mutex<Connection>> {
    let conn = Connection::open(std::env::var("SNAP_DB").unwrap()).unwrap();
    register_fixture_functions(&conn);
    Arc::new(Mutex::new(conn))
}

#[test]
fn scratch_albums_page() {
    let rt = build_runtime();
    let path = std::env::var("PQ_PATH").unwrap();
    let t = std::time::Instant::now();
    if std::env::var("PQ_FETCH").is_ok() {
        let r = rt.fetch(&path);
        eprintln!("FETCH {path} -> {:?} in {:?}", r.map(|v| v.len()), t.elapsed());
    } else {
        let r = rt.list_with_count(&path);
        eprintln!("LIST {path} -> {:?} in {:?}", r.map(|v| v.iter().map(|c| (c.name.clone(), c.total)).collect::<Vec<_>>()), t.elapsed());
    }
}
