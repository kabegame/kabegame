//! 把存量视频的缩略图换成首帧静图，删掉旧的（只在桌面；Android 的缩略图仍是 GIF 动图，作业在那里一批空跑完）。
//!
//! v053 之前桌面的视频缩略图是 2.5 秒的 H.264 短片，WPE 视频壁纸直接用作者的 `preview.*`（常是几 MB 的 GIF）；
//! 之后入库写首帧 JPEG（[`generate_video_thumbnail`]），网格悬浮时才播原视频。前端按缩略图本身是什么决定放什么，
//! 作业跑完之前两种形态并存也能正常显示。
//!
//! - `video/*`：从原文件解首帧；缩略图已是首帧 JPEG 的行跳过。
//! - `x-wpe/video`：从 `compatible_path`（入口视频或兼容副本）解首帧；缩略图已是 `thumbnails_dir` 里的 JPEG 的行跳过。
//!   作者的 `preview.*` 不在 `thumbnails_dir`，换掉之后不删。
//!
//! 只读写 `thumbnail_path`（引入前就存在的列）。写回带旧值做条件，解码期间缩略图被别处换过的行不写、删掉刚生成的文件；
//! 写成功的行提交之后删旧文件（只删 `thumbnails_dir` 里的）并发 `thumbnailPath` 字段补丁。解不出首帧的行（原文件不在、
//! 缺解码器）保留旧缩略图、不重试，要重试就在整理里勾「重新生成缩略图」。

use crate::crawler::downloader::compress::{generate_video_thumbnail, is_current_video_thumbnail};
use crate::ipc::events::ImageFieldPatch;
use crate::storage::images::remove_thumbnail_file_if_needed;
use crate::storage::migrations::backfill::{Backfill, BackfillCtx, BatchOutcome};
use rusqlite::{params, Connection};
use std::path::Path;

/// 类型过滤：普通视频按前缀、WPE 视频等值，都是绑定参数，走 `idx_images_type`。
const VIDEO_TYPE_GLOB: &str = "video/*";
const WPE_VIDEO_TYPE: &str = "x-wpe/video";

pub(crate) const JOB: Backfill = Backfill {
    id: "video_thumbnail_frame",
    introduced_at: 53,
    // 解首帧用 FFmpeg（除 iOS 外都有）
    platforms: || true,
    // 一行解一帧，4K HEVC 也就一两百毫秒
    batch_size: 8,
    count_remaining,
    run_batch,
};

fn count_remaining(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM images WHERE type GLOB ?1 OR type = ?2",
        params![VIDEO_TYPE_GLOB, WPE_VIDEO_TYPE],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as usize)
    .map_err(|e| format!("video_thumbnail_frame count: {e}"))
}

struct Candidate {
    id: i64,
    media_type: String,
    local_path: String,
    thumbnail_path: String,
    compatible_path: Option<String>,
}

impl Candidate {
    /// 解首帧的来源；`None` = 已经是首帧静图或没有来源，跳过。
    fn source(&self, thumbnails_dir: &Path) -> Option<&str> {
        // Android 的视频缩略图仍是 GIF 动图（网格没有悬浮），不换；也没有 `wpe` feature，x-wpe 行只显示预览图
        if cfg!(target_os = "android") {
            return None;
        }
        let thumb = self.thumbnail_path.trim();
        if self.media_type == WPE_VIDEO_TYPE {
            let current =
                is_current_video_thumbnail(thumb) && Path::new(thumb).starts_with(thumbnails_dir);
            if current {
                return None;
            }
            return self
                .compatible_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty());
        }
        let local = self.local_path.trim();
        if local.is_empty() || (is_current_video_thumbnail(thumb) && thumb != local) {
            return None;
        }
        Some(local)
    }
}

fn run_batch(ctx: &BackfillCtx, cursor: i64, limit: usize) -> Result<BatchOutcome, String> {
    let candidates = ctx.with_conn(|conn| {
        conn.prepare(
            "SELECT id, type, local_path, thumbnail_path, compatible_path FROM images
              WHERE id > ?1 AND (type GLOB ?2 OR type = ?3)
              ORDER BY id LIMIT ?4",
        )
        .and_then(|mut stmt| {
            stmt.query_map(
                params![cursor, VIDEO_TYPE_GLOB, WPE_VIDEO_TYPE, limit as i64],
                |row| {
                    Ok(Candidate {
                        id: row.get(0)?,
                        media_type: row.get(1)?,
                        local_path: row.get(2)?,
                        thumbnail_path: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        compatible_path: row.get(4)?,
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| format!("video_thumbnail_frame select: {e}"))
    })?;

    let processed = candidates.len();
    let next_cursor = if processed < limit {
        None
    } else {
        candidates.last().map(|candidate| candidate.id)
    };

    // 不持有连接解码。解不出来的行保留旧缩略图。
    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    let generated: Vec<(Candidate, String)> = ctx.block_on(async move {
        let mut generated = Vec::new();
        for candidate in candidates {
            let Some(source) = candidate.source(&thumbnails_dir) else {
                continue;
            };
            match generate_video_thumbnail(source).await {
                Ok(path) => {
                    let path = path.to_string_lossy().into_owned();
                    generated.push((candidate, path));
                }
                Err(error) => tracing::warn!(
                    "video_thumbnail_frame: 图片 {} 解不出首帧，保留旧缩略图: {error}",
                    candidate.id
                ),
            }
        }
        generated
    });
    if generated.is_empty() {
        // 本批没有写入：进度由 run_to_completion 提交
        return Ok(BatchOutcome {
            next_cursor,
            processed,
            patches: Vec::new(),
        });
    }

    let mut written = vec![false; generated.len()];
    let committed = ctx.commit(|conn| {
        let mut patches = Vec::new();
        for (index, (candidate, new_path)) in generated.iter().enumerate() {
            // 带上旧值：解码期间行被删掉或缩略图被换过时不写
            let changed = conn
                .execute(
                    "UPDATE images SET thumbnail_path = ?1
                      WHERE id = ?2 AND COALESCE(thumbnail_path, '') = ?3",
                    params![new_path, candidate.id, candidate.thumbnail_path],
                )
                .map_err(|e| format!("video_thumbnail_frame update {}: {e}", candidate.id))?;
            if changed > 0 {
                written[index] = true;
                patches.push(ImageFieldPatch {
                    id: candidate.id.to_string(),
                    fields: serde_json::Map::from_iter([(
                        "thumbnailPath".to_string(),
                        serde_json::json!(new_path),
                    )]),
                });
            }
        }
        Ok(BatchOutcome {
            next_cursor,
            processed,
            patches,
        })
    });
    if committed.is_err() {
        written.fill(false);
    }

    // 写进去的删旧缩略图（只删 thumbnails_dir 里的），没写进去的删刚生成的
    for ((candidate, new_path), written) in generated.iter().zip(written) {
        if written {
            remove_thumbnail_file_if_needed(
                Some(&candidate.local_path),
                Some(&candidate.thumbnail_path),
            );
        } else {
            let _ = std::fs::remove_file(new_path);
        }
    }
    committed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrations::backfill::{
        enqueue_introduced_at_in, pending_jobs_in, run_to_completion,
    };

    static REGISTRY: &[Backfill] = &[JOB];

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "{}
             CREATE TABLE images (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 local_path TEXT NOT NULL,
                 thumbnail_path TEXT,
                 compatible_path TEXT,
                 type TEXT
             );
             CREATE INDEX idx_images_type ON images(type);",
            crate::storage::migrations::BACKFILL_JOBS_DDL
        ))
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, local: &str, thumb: &str, compat: Option<&str>, ty: &str) -> i64 {
        conn.execute(
            "INSERT INTO images (local_path, thumbnail_path, compatible_path, type)
             VALUES (?1, ?2, ?3, ?4)",
            params![local, thumb, compat, ty],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn candidate(media_type: &str, local: &str, thumb: &str, compat: Option<&str>) -> Candidate {
        Candidate {
            id: 1,
            media_type: media_type.to_string(),
            local_path: local.to_string(),
            thumbnail_path: thumb.to_string(),
            compatible_path: compat.map(str::to_string),
        }
    }

    /// 哪些行要重做、从哪里解：旧形态与没有独立缩略图的重做，已是首帧静图的跳过；WPE 读 compatible_path。
    #[test]
    fn source_picks_legacy_rows() {
        let thumbs = Path::new("/data/thumbnails");
        let video = |thumb: &str| candidate("video/mp4", "/v/a.mp4", thumb, None);
        assert_eq!(
            video("/data/thumbnails/x.mp4").source(thumbs),
            Some("/v/a.mp4")
        );
        assert_eq!(
            video("/data/thumbnails/x.gif").source(thumbs),
            Some("/v/a.mp4")
        );
        assert_eq!(video("").source(thumbs), Some("/v/a.mp4"));
        assert_eq!(video("/v/a.mp4").source(thumbs), Some("/v/a.mp4"));
        assert_eq!(video("/data/thumbnails/x.jpg").source(thumbs), None);

        let wpe =
            |thumb: &str, compat: Option<&str>| candidate("x-wpe/video", "/wpe/1", thumb, compat);
        assert_eq!(
            wpe("/wpe/1/preview.gif", Some("/wpe/1/v.mp4")).source(thumbs),
            Some("/wpe/1/v.mp4")
        );
        // 作者的 preview.jpg 不在 thumbnails_dir，也要换成首帧
        assert_eq!(
            wpe("/wpe/1/preview.jpg", Some("/wpe/1/v.mp4")).source(thumbs),
            Some("/wpe/1/v.mp4")
        );
        assert_eq!(
            wpe("/data/thumbnails/y.jpg", Some("/wpe/1/v.mp4")).source(thumbs),
            None
        );
        assert_eq!(wpe("/wpe/1/preview.gif", None).source(thumbs), None);
    }

    fn run(conn: &Connection) -> Vec<ImageFieldPatch> {
        let pending = pending_jobs_in(conn, REGISTRY).unwrap();
        let ctx = BackfillCtx::blocking(JOB.id, conn);
        let mut patches = Vec::new();
        run_to_completion(&ctx, &pending[0], &mut |_, outcome| {
            patches.extend(outcome.patches)
        })
        .unwrap();
        patches
    }

    fn thumb_of(conn: &Connection, id: i64) -> String {
        conn.query_row(
            "SELECT thumbnail_path FROM images WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// 旧缩略图换成 thumbnails_dir 里的首帧 JPEG：Kabegame 生成的旧文件删掉，作者的 preview.* 留着。
    #[test]
    fn replaces_legacy_thumbnails_with_first_frame() {
        let paths = crate::app_paths::AppPaths::init_for_tests();
        let thumbnails_dir = paths.thumbnails_dir();
        std::fs::create_dir_all(&thumbnails_dir).unwrap();
        let temp = tempfile::tempdir().unwrap();

        let video = temp.path().join("a.mp4");
        crate::media::decode::tests::write_test_video(&video, 12, 12, 4);
        let legacy = thumbnails_dir.join(format!("{}.mp4", uuid::Uuid::new_v4()));
        std::fs::write(&legacy, b"legacy").unwrap();

        let wpe_dir = temp.path().join("wpe");
        std::fs::create_dir_all(&wpe_dir).unwrap();
        let wpe_video = wpe_dir.join("v.mp4");
        crate::media::decode::tests::write_test_video(&wpe_video, 12, 12, 4);
        let preview = wpe_dir.join("preview.gif");
        std::fs::write(&preview, b"author").unwrap();

        let conn = fixture();
        let plain = insert(
            &conn,
            &video.to_string_lossy(),
            &legacy.to_string_lossy(),
            None,
            "video/mp4",
        );
        let wpe = insert(
            &conn,
            &wpe_dir.to_string_lossy(),
            &preview.to_string_lossy(),
            Some(&wpe_video.to_string_lossy()),
            "x-wpe/video",
        );
        enqueue_introduced_at_in(&conn, REGISTRY, 53).unwrap();

        let patches = run(&conn);
        assert_eq!(patches.len(), 2);
        for id in [plain, wpe] {
            let thumb = thumb_of(&conn, id);
            assert!(is_current_video_thumbnail(&thumb), "{thumb}");
            assert!(Path::new(&thumb).starts_with(&thumbnails_dir));
            let (w, h) = image::image_dimensions(&thumb).unwrap();
            assert!(w > 0 && h > 0);
        }
        assert!(!legacy.exists(), "Kabegame 生成的旧缩略图删掉");
        assert!(preview.exists(), "作者的 preview.* 不删");

        // 再跑一遍不重做
        conn.execute("UPDATE backfill_jobs SET done = 0, cursor = 0", [])
            .unwrap();
        assert!(run(&conn).is_empty());
    }

    /// 分母只数视频；解不出首帧（文件不在）的行原样保留、作业照样跑完。
    #[test]
    fn keeps_rows_whose_frame_cannot_be_decoded() {
        crate::app_paths::AppPaths::init_for_tests();
        let conn = fixture();
        insert(&conn, "/tmp/plain.png", "/tmp/plain.png", None, "image/png");
        let missing = insert(
            &conn,
            "/nonexistent/a.mp4",
            "/nonexistent/a-thumb.mp4",
            None,
            "video/mp4",
        );
        let wpe = insert(
            &conn,
            "/nonexistent/wpe",
            "/nonexistent/wpe/preview.gif",
            Some("/nonexistent/wpe/v.mp4"),
            "x-wpe/video",
        );

        enqueue_introduced_at_in(&conn, REGISTRY, 53).unwrap();
        let total: i64 = conn
            .query_row(
                "SELECT total FROM backfill_jobs WHERE id = 'video_thumbnail_frame'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 2, "分母只数视频行");

        assert!(run(&conn).is_empty());
        assert_eq!(thumb_of(&conn, missing), "/nonexistent/a-thumb.mp4");
        assert_eq!(thumb_of(&conn, wpe), "/nonexistent/wpe/preview.gif");
        let done: i64 = conn
            .query_row(
                "SELECT done FROM backfill_jobs WHERE id = 'video_thumbnail_frame'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(done, 1);
    }
}
