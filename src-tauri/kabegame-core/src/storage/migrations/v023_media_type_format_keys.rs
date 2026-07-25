//! 将 `images.type` 从标准 MIME/历史类别统一迁移为格式键。
//!
//! 迁移自包含格式映射，不依赖运行时代码中的媒体格式表，避免历史迁移随业务逻辑变化。

use rusqlite::{params, Connection};

/// 已知存储值到格式键的映射；输入会先 trim 并转为小写。
const KNOWN: &[(&str, &str)] = &[
    ("image", "image/jpg"),
    ("image/jpeg", "image/jpg"),
    ("image/jpg", "image/jpg"),
    ("image/png", "image/png"),
    ("image/gif", "image/gif"),
    ("image/bmp", "image/bmp"),
    ("image/webp", "image/webp"),
    ("image/avif", "image/avif"),
    ("image/heic", "image/heic"),
    ("image/heif", "image/heif"),
    ("image/tiff", "image/tiff"),
    ("video", "video/mp4"),
    ("video/mp4", "video/mp4"),
    ("video/x-m4v", "video/mp4"),
    ("video/3gpp", "video/mp4"),
    ("video/3gpp2", "video/mp4"),
    ("video/mov", "video/mov"),
    ("video/quicktime", "video/mov"),
    ("video/wmv", "video/wmv"),
    ("video/x-ms-wmv", "video/wmv"),
    ("video/x-ms-asf", "video/wmv"),
    ("video/webm", "video/webm"),
    ("video/mkv", "video/mkv"),
    ("video/x-matroska", "video/mkv"),
];

/// infer 返回的 MIME 到格式键的映射。
const INFER_TO_KEY: &[(&str, &str)] = &[
    ("image/jpeg", "image/jpg"),
    ("image/png", "image/png"),
    ("image/gif", "image/gif"),
    ("image/bmp", "image/bmp"),
    ("image/webp", "image/webp"),
    ("image/avif", "image/avif"),
    ("image/heic", "image/heic"),
    ("image/heif", "image/heif"),
    ("image/tiff", "image/tiff"),
    ("video/mp4", "video/mp4"),
    ("video/x-m4v", "video/mp4"),
    ("video/3gpp", "video/mp4"),
    ("video/3gpp2", "video/mp4"),
    ("video/quicktime", "video/mov"),
    ("video/x-ms-wmv", "video/wmv"),
    ("video/x-ms-asf", "video/wmv"),
    ("video/webm", "video/webm"),
    ("video/x-matroska", "video/mkv"),
];

struct MigrationStats {
    known: usize,
    residual: usize,
    inferred: usize,
    fallback: usize,
    updated: usize,
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn fallback_type(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    match lower.as_str() {
        "" | "image" => "image/jpg".to_string(),
        "video" => "video/mp4".to_string(),
        _ => lower,
    }
}

fn infer_format_key(path: &str, id: i64) -> Option<&'static str> {
    if path.trim().starts_with("content://") {
        return None;
    }

    match infer::get_from_path(path) {
        Ok(Some(kind)) => {
            let mime = kind.mime_type().trim().to_ascii_lowercase();
            INFER_TO_KEY
                .iter()
                .find_map(|(candidate, key)| (*candidate == mime).then_some(*key))
        }
        Ok(None) => None,
        Err(error) => {
            eprintln!("[v023] infer id={id} path={path} failed: {error}");
            None
        }
    }
}

fn migrate(conn: &Connection) -> Result<MigrationStats, String> {
    let normalized = "lower(trim(COALESCE(type, '')))";
    let case_arms = KNOWN
        .iter()
        .map(|(old, new)| format!("WHEN {} THEN {}", sql_literal(old), sql_literal(new)))
        .collect::<Vec<_>>()
        .join(" ");
    let known_values = KNOWN
        .iter()
        .map(|(old, _)| sql_literal(old))
        .collect::<Vec<_>>()
        .join(", ");

    let known_sql = format!(
        "UPDATE images
         SET type = CASE {normalized} {case_arms} ELSE {normalized} END
         WHERE {normalized} IN ({known_values})"
    );
    let known = conn
        .execute(&known_sql, [])
        .map_err(|error| format!("map known media types: {error}"))?;

    let residual_sql = format!(
        "SELECT id, local_path, COALESCE(type, '')
         FROM images
         WHERE {normalized} NOT IN ({known_values})"
    );
    let mut stmt = conn
        .prepare(&residual_sql)
        .map_err(|error| format!("prepare residual media types: {error}"))?;
    let query = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("query residual media types: {error}"))?;

    let mut rows = Vec::new();
    for row in query {
        match row {
            Ok(row) => rows.push(row),
            Err(error) => eprintln!("[v023] read residual row failed: {error}"),
        }
    }
    drop(stmt);

    let residual = rows.len();
    let mut inferred = 0usize;
    let mut fallback = 0usize;
    let mut updated = 0usize;
    for (id, path, raw_type) in rows {
        let target = if let Some(key) = infer_format_key(&path, id) {
            inferred += 1;
            key.to_string()
        } else {
            fallback += 1;
            fallback_type(&raw_type)
        };

        match conn.execute(
            "UPDATE images SET type = ?1 WHERE id = ?2",
            params![target, id],
        ) {
            Ok(_) => updated += 1,
            Err(error) => eprintln!("[v023] update id={id} failed: {error}"),
        }
    }

    Ok(MigrationStats {
        known,
        residual,
        inferred,
        fallback,
        updated,
    })
}

pub fn up(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN")
        .map_err(|error| format!("begin: {error}"))?;

    let stats = match migrate(conn) {
        Ok(stats) => stats,
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error);
        }
    };

    if let Err(error) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(format!("commit: {error}"));
    }

    println!(
        "[v023] mapped {} known rows; processed {}/{} residual rows (inferred {}, fallback {})",
        stats.known, stats.updated, stats.residual, stats.inferred, stats.fallback
    );
    Ok(())
}
