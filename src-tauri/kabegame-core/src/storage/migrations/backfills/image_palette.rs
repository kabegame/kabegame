//! 给存量图算色盘（`images.palette`），并把 v052 铺的 65536 改写成到各色桶的真实距离。
//!
//! v052 之后入库的图在 [`crate::storage::Storage::add_image`] 里已经带着色盘；这里只处理
//! `palette IS NULL` 的行。来源规则与入库相同（[`palette::compute_for_row`]）：图片读缩略图，
//! GIF 与视频抽帧，WPE 网页 / 场景取 `project.json` 的 `schemecolor`、没有则用预览图。
//!
//! 只读写 v052 引入的列与表。算不出色盘的行（文件不在、格式解不了）保持 NULL、距离保持 65536，
//! 不重试；算出色盘且改到行的图各发一条 `palette` 字段补丁。

use crate::ipc::events::ImageFieldPatch;
use crate::media::palette::{self, Palette};
use crate::storage::images::write_color_distances;
use crate::storage::migrations::backfill::{Backfill, BackfillCtx, BatchOutcome};
use rusqlite::{params, Connection};

pub(crate) const JOB: Backfill = Backfill {
    id: "image_palette",
    introduced_at: 52,
    // 图片用 image crate，视频用 FFmpeg（除 iOS 外都有）
    platforms: || true,
    // 一批约 0.2–0.5 秒，批间释放写锁
    batch_size: 32,
    count_remaining,
    run_batch,
};

fn count_remaining(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM images WHERE palette IS NULL",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as usize)
    .map_err(|e| format!("image_palette count: {e}"))
}

struct Candidate {
    id: i64,
    media_type: String,
    local_path: String,
    thumbnail_path: String,
    compatible_path: Option<String>,
    /// WPE 网页 / 场景壁纸的 `schemecolor`（作者值）。
    scheme_color: Option<[u8; 3]>,
}

/// 网页 / 场景壁纸的代表色：读 metadata 里的 `project.json` 原文。属性解析在所有构建里都编译
/// （`wpe::properties` 不随 `wpe` feature 门控），各平台对同一行算出同一个色盘。
fn read_scheme_color(
    conn: &Connection,
    media_type: &str,
    metadata_id: Option<i64>,
) -> Option<[u8; 3]> {
    use crate::media::image_type::{is_wpe_type, is_wpe_video_type};
    use rusqlite::OptionalExtension;

    if !is_wpe_type(Some(media_type)) || is_wpe_video_type(Some(media_type)) {
        return None;
    }
    let data: String = conn
        .query_row(
            "SELECT data FROM metadata WHERE id = ?1",
            params![metadata_id?],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()?;
    let raw: serde_json::Value = serde_json::from_str(&data).ok()?;
    crate::wpe::properties::scheme_color_from_raw(&raw)
}

fn run_batch(ctx: &BackfillCtx, cursor: i64, limit: usize) -> Result<BatchOutcome, String> {
    let candidates = ctx.with_conn(|conn| {
        let rows = conn
            .prepare(
                "SELECT id, type, local_path, thumbnail_path, compatible_path, metadata_id
                   FROM images
                  WHERE id > ?1 AND palette IS NULL
                  ORDER BY id LIMIT ?2",
            )
            .and_then(|mut stmt| {
                stmt.query_map(params![cursor, limit as i64], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|e| format!("image_palette select: {e}"))?;
        Ok(rows
            .into_iter()
            .map(
                |(id, media_type, local_path, thumbnail_path, compatible_path, metadata_id)| {
                    let media_type = media_type.unwrap_or_default();
                    let scheme_color = read_scheme_color(conn, &media_type, metadata_id);
                    Candidate {
                        id,
                        media_type,
                        local_path,
                        thumbnail_path: thumbnail_path.unwrap_or_default(),
                        compatible_path,
                        scheme_color,
                    }
                },
            )
            .collect::<Vec<_>>())
    })?;

    let processed = candidates.len();
    let next_cursor = if processed < limit {
        None
    } else {
        candidates.last().map(|candidate| candidate.id)
    };
    if candidates.is_empty() {
        return Ok(BatchOutcome {
            next_cursor,
            processed,
            patches: Vec::new(),
        });
    }

    // 不持有连接读盘计算。经 compute_for_row：Android 上 content:// 的 fd 处理只在它里面。
    // 文件缺失、解码失败都是 None，这些行不写。
    let computed: Vec<(Candidate, Palette)> = ctx.block_on(async move {
        let mut computed = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let palette = palette::compute_for_row(
                &candidate.media_type,
                &candidate.local_path,
                &candidate.thumbnail_path,
                candidate.compatible_path.as_deref(),
                candidate.scheme_color,
            )
            .await;
            if let Some(palette) = palette {
                computed.push((candidate, palette));
            }
        }
        computed
    });
    if computed.is_empty() {
        // 本批没有写入：进度由 run_to_completion 提交
        return Ok(BatchOutcome {
            next_cursor,
            processed,
            patches: Vec::new(),
        });
    }

    ctx.commit(|conn| {
        let mut patches = Vec::new();
        for (candidate, palette) in &computed {
            let json = palette.to_json();
            // 带上 local_path：读盘期间行被删掉或改指别处时不写
            let changed = conn
                .execute(
                    "UPDATE images SET palette = ?1 WHERE id = ?2 AND local_path = ?3",
                    params![json, candidate.id, candidate.local_path],
                )
                .map_err(|e| format!("image_palette update {}: {e}", candidate.id))?;
            if changed == 0 {
                continue;
            }
            write_color_distances(conn, candidate.id, Some(palette))?;
            patches.push(ImageFieldPatch {
                id: candidate.id.to_string(),
                fields: serde_json::Map::from_iter([(
                    "palette".to_string(),
                    serde_json::Value::String(json),
                )]),
            });
        }
        Ok(BatchOutcome {
            next_cursor,
            processed,
            patches,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::{distance_to, NO_PALETTE_DISTANCE};
    use crate::storage::migrations::backfill::{
        enqueue_introduced_at_in, pending_jobs_in, run_to_completion,
    };
    use crate::storage::migrations::{
        seed_builtin_color_buckets, BACKFILL_JOBS_DDL, BUILTIN_COLOR_BUCKETS, COLOR_TABLES_DDL,
    };
    use std::path::Path;

    static REGISTRY: &[Backfill] = &[JOB];

    /// v052 之后的最小形态：作业读写的列 + 两张色盘表。
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "PRAGMA foreign_keys = ON;
             {BACKFILL_JOBS_DDL}
             CREATE TABLE metadata (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
             CREATE TABLE images (
                 id              INTEGER PRIMARY KEY AUTOINCREMENT,
                 local_path      TEXT NOT NULL,
                 thumbnail_path  TEXT NOT NULL DEFAULT '',
                 compatible_path TEXT,
                 type            TEXT,
                 metadata_id     INTEGER,
                 palette         TEXT
             );
             {COLOR_TABLES_DDL}"
        ))
        .unwrap();
        seed_builtin_color_buckets(&conn).unwrap();
        conn
    }

    /// 一张存量图：图片行 + v052 铺的 12 行 65536。
    fn insert(conn: &Connection, local: &str, thumbnail: &str, media_type: &str) -> i64 {
        conn.execute(
            "INSERT INTO images (local_path, thumbnail_path, type) VALUES (?1, ?2, ?3)",
            params![local, thumbnail, media_type],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        write_color_distances(conn, id, None).unwrap();
        id
    }

    fn solid_png(path: &Path, rgb: [u8; 3]) -> String {
        image::RgbImage::from_pixel(64, 64, image::Rgb(rgb))
            .save(path)
            .unwrap();
        path.to_string_lossy().into_owned()
    }

    fn palette_of(conn: &Connection, id: i64) -> Option<String> {
        conn.query_row("SELECT palette FROM images WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
    }

    fn distances_of(conn: &Connection, id: i64) -> Vec<(i64, i64)> {
        conn.prepare(
            "SELECT bucket_rgb, distance FROM image_color_distances
              WHERE image_id = ?1 ORDER BY bucket_rgb",
        )
        .unwrap()
        .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    fn expected_distances(palette: Option<&Palette>) -> Vec<(i64, i64)> {
        let mut expected: Vec<(i64, i64)> = BUILTIN_COLOR_BUCKETS
            .iter()
            .map(|(_, rgb)| (i64::from(*rgb), i64::from(distance_to(palette, *rgb))))
            .collect();
        expected.sort();
        expected
    }

    fn run(conn: &Connection) -> Vec<(i64, usize, Vec<ImageFieldPatch>)> {
        let pending = pending_jobs_in(conn, REGISTRY).unwrap();
        let ctx = BackfillCtx::blocking(JOB.id, conn);
        let mut seen = Vec::new();
        run_to_completion(&ctx, &pending[0], &mut |progress, outcome| {
            seen.push((progress.cursor, progress.processed, outcome.patches))
        })
        .unwrap();
        seen
    }

    #[test]
    fn computes_palette_rewrites_distances_and_skips_missing_files() {
        let temp = tempfile::tempdir().unwrap();
        let conn = fixture();

        let red_path = solid_png(&temp.path().join("red.png"), [255, 0, 0]);
        let blue_path = solid_png(&temp.path().join("blue.png"), [0, 0, 255]);
        let missing_path = temp.path().join("gone.png").to_string_lossy().into_owned();

        // 缩略图与原图是同一个文件（小图拿原图当缩略图）
        let red = insert(&conn, &red_path, &red_path, "image/png");
        let gone = insert(&conn, &missing_path, &missing_path, "image/png");
        // 缩略图列为空：退到原图
        let blue = insert(&conn, &blue_path, "", "image/png");

        enqueue_introduced_at_in(&conn, REGISTRY, 52).unwrap();
        let total: i64 = conn
            .query_row(
                "SELECT total FROM backfill_jobs WHERE id = 'image_palette'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 3);

        let batches = run(&conn);
        assert_eq!(batches.iter().map(|batch| batch.1).max(), Some(3));

        // 纯色图只有一个颜色、占 100%，列里是规范形态
        let red_json = palette_of(&conn, red).expect("红图算出色盘");
        let red_palette = Palette::from_json(&red_json).unwrap();
        assert_eq!(red_palette, Palette::single([255, 0, 0]));
        assert_eq!(red_json, red_palette.to_json());
        let blue_palette = Palette::from_json(&palette_of(&conn, blue).unwrap()).unwrap();
        assert_eq!(blue_palette, Palette::single([0, 0, 255]));

        // 距离改写成真实值：红图到红桶为 0，且比到蓝桶近
        let red_distances = distances_of(&conn, red);
        assert_eq!(red_distances, expected_distances(Some(&red_palette)));
        assert_eq!(red_distances.len(), 12);
        let to = |bucket: i64| {
            red_distances
                .iter()
                .find(|(rgb, _)| *rgb == bucket)
                .unwrap()
                .1
        };
        assert_eq!(to(0xff0000), 0);
        assert!(to(0xff0000) < to(0x0000ff));
        assert!(red_distances.iter().all(|(_, distance)| *distance <= 65535));
        assert_eq!(
            distances_of(&conn, blue),
            expected_distances(Some(&blue_palette))
        );

        // 文件缺失的行保持 NULL / 65536
        assert_eq!(palette_of(&conn, gone), None);
        assert_eq!(distances_of(&conn, gone), expected_distances(None));
        assert!(distances_of(&conn, gone)
            .iter()
            .all(|(_, distance)| *distance == i64::from(NO_PALETTE_DISTANCE)));

        // 算出色盘的图各一条 palette 补丁（值是列里的 JSON 文本）；没算出来的不发
        let patches: Vec<ImageFieldPatch> = batches.into_iter().flat_map(|batch| batch.2).collect();
        assert_eq!(
            patches
                .iter()
                .map(|patch| patch.id.clone())
                .collect::<Vec<_>>(),
            vec![red.to_string(), blue.to_string()]
        );
        assert_eq!(patches[0].fields.len(), 1);
        assert_eq!(
            patches[0].fields["palette"],
            serde_json::Value::String(red_json)
        );

        let done: i64 = conn
            .query_row(
                "SELECT done FROM backfill_jobs WHERE id = 'image_palette'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(done, 1);
    }

    /// v052 之后入库的行已经带着色盘：不是候选，不重算、不发补丁。
    #[test]
    fn rows_that_already_have_a_palette_are_not_candidates() {
        let temp = tempfile::tempdir().unwrap();
        let conn = fixture();
        let green_path = solid_png(&temp.path().join("green.png"), [0, 255, 0]);

        let kept = insert(&conn, &green_path, &green_path, "image/png");
        let existing = Palette::single([1, 2, 3]);
        conn.execute(
            "UPDATE images SET palette = ?1 WHERE id = ?2",
            params![existing.to_json(), kept],
        )
        .unwrap();
        write_color_distances(&conn, kept, Some(&existing)).unwrap();

        enqueue_introduced_at_in(&conn, REGISTRY, 52).unwrap();
        let batches = run(&conn);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].1, 0, "已有色盘的行不是候选");
        assert!(batches[0].2.is_empty());
        assert_eq!(palette_of(&conn, kept), Some(existing.to_json()));
        assert_eq!(
            distances_of(&conn, kept),
            expected_distances(Some(&existing))
        );
    }

    /// 游标可续跑：从中途的游标开始只处理它之后的行，之前的不重做。
    #[test]
    fn resumes_from_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let conn = fixture();
        let count = JOB.batch_size + 3;
        let ids: Vec<i64> = (0..count)
            .map(|index| {
                let path = solid_png(
                    &temp.path().join(format!("{index}.png")),
                    [(index * 5) as u8, 128, 255 - (index * 5) as u8],
                );
                insert(&conn, &path, &path, "image/png")
            })
            .collect();
        enqueue_introduced_at_in(&conn, REGISTRY, 52).unwrap();

        // 模拟第一批已提交后被打断
        let ctx = BackfillCtx::blocking(JOB.id, &conn);
        let first = run_batch(&ctx, 0, JOB.batch_size).unwrap();
        let boundary = ids[JOB.batch_size - 1];
        assert_eq!(first.next_cursor, Some(boundary));
        assert_eq!(first.processed, JOB.batch_size);
        assert_eq!(first.patches.len(), JOB.batch_size);
        // 把已处理的行标记出来（清回 NULL 也不该被续跑重新捡起：它们在游标之前）
        conn.execute(
            "UPDATE images SET palette = NULL WHERE id <= ?1",
            [boundary],
        )
        .unwrap();

        let batches = run(&conn);
        assert_eq!(batches.len(), 1, "剩余 3 行一批跑完");
        assert_eq!(batches[0].2.len(), 3);
        for id in &ids[..JOB.batch_size] {
            assert_eq!(palette_of(&conn, *id), None, "游标之前的行不重做");
        }
        for id in &ids[JOB.batch_size..] {
            assert!(palette_of(&conn, *id).is_some());
        }
    }

    #[test]
    fn empty_library_finishes_in_one_batch() {
        let conn = fixture();
        enqueue_introduced_at_in(&conn, REGISTRY, 52).unwrap();
        let batches = run(&conn);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].1, 0);
        let done: i64 = conn
            .query_row(
                "SELECT done FROM backfill_jobs WHERE id = 'image_palette'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(done, 1);
    }

    /// 网页 / 场景壁纸取 metadata 里 `project.json` 的 `schemecolor`，不读盘。
    #[test]
    fn wpe_web_rows_take_the_scheme_color_from_metadata() {
        let conn = fixture();
        conn.execute(
            "INSERT INTO metadata (id, data) VALUES (1, ?1)",
            [serde_json::json!({
                "type": "web",
                "general": { "properties": {
                    "schemecolor": { "type": "color", "value": "0 0 1" }
                }}
            })
            .to_string()],
        )
        .unwrap();
        let web = insert(&conn, "/no/such/wallpaper-dir", "", "x-wpe/web");
        conn.execute("UPDATE images SET metadata_id = 1 WHERE id = ?1", [web])
            .unwrap();
        // 没有 schemecolor 也没有预览图：没有色盘
        let bare = insert(&conn, "/no/such/other-dir", "", "x-wpe/scene");

        enqueue_introduced_at_in(&conn, REGISTRY, 52).unwrap();
        let batches = run(&conn);

        assert_eq!(
            palette_of(&conn, web),
            Some(Palette::single([0, 0, 255]).to_json())
        );
        assert_eq!(palette_of(&conn, bare), None);
        let patched: Vec<String> = batches
            .into_iter()
            .flat_map(|batch| batch.2)
            .map(|patch| patch.id)
            .collect();
        assert_eq!(patched, vec![web.to_string()]);
    }
}
