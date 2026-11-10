//! 把存量 WPE 壁纸行的 `hash` / `size` 重算为目录哈希与目录总字节数。
//!
//! v051 之前这两列取的是入口文件（视频、入口 html、场景 json 或 `scene.pkg`）；之后入库统一写
//! 目录哈希（[`crate::wpe::dir_hash`]），下载到本机已有的壁纸靠它判重。作业跑完之前，
//! 存量行按目录哈希查不到，这段时间里下到本机已有的壁纸会多落一份。
//!
//! 只读写 `hash` / `size`（引入前就存在的列）。目录缺失或读不了的行原样跳过并记日志；
//! 重算是幂等的，已经是目录哈希的行（v051 之后入库的）算出来还是同一个值。

use crate::ipc::events::ImageFieldPatch;
use crate::storage::migrations::backfill::{Backfill, BackfillCtx, BatchOutcome};
use crate::wpe::dir_hash::digest_dir;
use rusqlite::{params, Connection};
use std::path::Path;

/// 类型过滤的模式串：绑定参数，等值前缀走 `idx_images_type`。
const WPE_TYPE_GLOB: &str = "x-wpe/*";

pub(crate) const JOB: Backfill = Backfill {
    id: "wpe_dir_hash",
    introduced_at: 51,
    // 目录哈希不受 wpe feature 门控；Android / Web 没有 x-wpe 行，一批空跑即完成
    platforms: || true,
    // 一行是一个壁纸目录，可能有几个 GB
    batch_size: 4,
    count_remaining,
    run_batch,
};

fn count_remaining(conn: &Connection) -> Result<usize, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM images WHERE type GLOB ?1",
        params![WPE_TYPE_GLOB],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count.max(0) as usize)
    .map_err(|e| format!("wpe_dir_hash count: {e}"))
}

struct Candidate {
    id: i64,
    local_path: String,
    size: Option<i64>,
}

fn run_batch(ctx: &BackfillCtx, cursor: i64, limit: usize) -> Result<BatchOutcome, String> {
    let candidates = ctx.with_conn(|conn| {
        conn.prepare(
            "SELECT id, local_path, size FROM images
              WHERE id > ?1 AND type GLOB ?2
              ORDER BY id LIMIT ?3",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![cursor, WPE_TYPE_GLOB, limit as i64], |row| {
                Ok(Candidate {
                    id: row.get(0)?,
                    local_path: row.get(1)?,
                    size: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| format!("wpe_dir_hash select: {e}"))
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

    // 不持有连接读盘
    let digests: Vec<_> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let dir = Path::new(&candidate.local_path);
            if !dir.is_dir() {
                tracing::warn!(
                    "wpe_dir_hash: 图片 {} 的目录不存在，跳过: {}",
                    candidate.id,
                    candidate.local_path
                );
                return None;
            }
            match digest_dir(dir) {
                Ok(digest) => Some((candidate, digest)),
                Err(error) => {
                    tracing::warn!(
                        "wpe_dir_hash: 图片 {} 的目录读取失败，跳过: {} ({error})",
                        candidate.id,
                        candidate.local_path
                    );
                    None
                }
            }
        })
        .collect();

    ctx.commit(|conn| {
        let mut patches = Vec::new();
        for (candidate, digest) in &digests {
            let size = digest.total_bytes as i64;
            // 带上 local_path：读盘期间行被删掉或改指别处时不写
            let changed = conn
                .execute(
                    "UPDATE images SET hash = ?1, size = ?2 WHERE id = ?3 AND local_path = ?4",
                    params![digest.hash, size, candidate.id, candidate.local_path],
                )
                .map_err(|e| format!("wpe_dir_hash update {}: {e}", candidate.id))?;
            if changed > 0 && candidate.size != Some(size) {
                patches.push(ImageFieldPatch {
                    id: candidate.id.to_string(),
                    fields: serde_json::Map::from_iter([(
                        "size".to_string(),
                        serde_json::json!(digest.total_bytes),
                    )]),
                });
            }
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
    use crate::storage::migrations::backfill::{
        enqueue_introduced_at_in, pending_jobs_in, run_to_completion,
    };
    use std::fs;
    use std::path::PathBuf;

    static REGISTRY: &[Backfill] = &[JOB];

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "{}
             CREATE TABLE images (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 local_path TEXT NOT NULL,
                 hash TEXT NOT NULL DEFAULT '',
                 type TEXT,
                 size INTEGER
             );
             CREATE INDEX idx_images_type ON images(type);",
            crate::storage::migrations::BACKFILL_JOBS_DDL
        ))
        .unwrap();
        conn
    }

    fn wallpaper_dir(root: &Path, name: &str, entry: &[u8]) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("project.json"),
            br#"{"type":"video","file":"a.mp4"}"#,
        )
        .unwrap();
        fs::write(dir.join("a.mp4"), entry).unwrap();
        dir
    }

    fn insert(conn: &Connection, path: &str, hash: &str, media_type: &str, size: i64) -> i64 {
        conn.execute(
            "INSERT INTO images (local_path, hash, type, size) VALUES (?1, ?2, ?3, ?4)",
            params![path, hash, media_type, size],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn row(conn: &Connection, id: i64) -> (String, i64) {
        conn.query_row("SELECT hash, size FROM images WHERE id = ?1", [id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap()
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
    fn rewrites_entry_hash_to_dir_hash_and_skips_missing_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let conn = fixture();

        let first = wallpaper_dir(temp.path(), "first", b"video-one");
        let second = wallpaper_dir(temp.path(), "second", b"video-two!");
        let missing = temp.path().join("gone");

        let image = insert(&conn, "/tmp/plain.png", "plain-hash", "image/png", 10);
        let a = insert(&conn, &first.to_string_lossy(), "entry-a", "x-wpe/video", 9);
        let gone = insert(
            &conn,
            &missing.to_string_lossy(),
            "entry-gone",
            "x-wpe/web",
            5,
        );
        let b = insert(
            &conn,
            &second.to_string_lossy(),
            "entry-b",
            "x-wpe/scene",
            10,
        );

        enqueue_introduced_at_in(&conn, REGISTRY, 51).unwrap();
        let total: i64 = conn
            .query_row(
                "SELECT total FROM backfill_jobs WHERE id = 'wpe_dir_hash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 3, "分母只数 x-wpe 行");

        let batches = run(&conn);
        assert_eq!(batches.iter().map(|batch| batch.1).max(), Some(3));

        let first_digest = digest_dir(&first).unwrap();
        let second_digest = digest_dir(&second).unwrap();
        assert_eq!(
            row(&conn, a),
            (first_digest.hash.clone(), first_digest.total_bytes as i64)
        );
        assert_eq!(
            row(&conn, b),
            (second_digest.hash, second_digest.total_bytes as i64)
        );
        // 目录缺失的行与普通图片原样
        assert_eq!(row(&conn, gone), ("entry-gone".to_string(), 5));
        assert_eq!(row(&conn, image), ("plain-hash".to_string(), 10));

        // size 变了的行才带补丁
        let patched: Vec<String> = batches
            .into_iter()
            .flat_map(|batch| batch.2)
            .map(|patch| patch.id)
            .collect();
        assert_eq!(patched, vec![a.to_string(), b.to_string()]);

        let done: i64 = conn
            .query_row(
                "SELECT done FROM backfill_jobs WHERE id = 'wpe_dir_hash'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(done, 1);
    }

    /// 游标可续跑：从中途的游标开始只处理它之后的行，之前的不重做。
    #[test]
    fn resumes_from_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let conn = fixture();
        let ids: Vec<i64> = (0..6)
            .map(|index| {
                let dir = wallpaper_dir(
                    temp.path(),
                    &format!("w{index}"),
                    format!("video-{index}").as_bytes(),
                );
                insert(&conn, &dir.to_string_lossy(), "entry", "x-wpe/video", 1)
            })
            .collect();
        enqueue_introduced_at_in(&conn, REGISTRY, 51).unwrap();

        // 模拟第一批（4 行）已提交后被打断
        let ctx = BackfillCtx::blocking(JOB.id, &conn);
        let first = run_batch(&ctx, 0, JOB.batch_size).unwrap();
        assert_eq!(first.next_cursor, Some(ids[3]));
        assert_eq!(first.processed, 4);
        // 把已处理的行标记出来，续跑不应再碰它们
        conn.execute("UPDATE images SET hash = 'kept' WHERE id <= ?1", [ids[3]])
            .unwrap();

        let batches = run(&conn);
        assert_eq!(batches.len(), 1, "剩余 2 行一批跑完");
        for id in &ids[..4] {
            assert_eq!(row(&conn, *id).0, "kept");
        }
        for id in &ids[4..] {
            assert_ne!(row(&conn, *id).0, "entry");
            assert_eq!(row(&conn, *id).0.len(), 64);
        }
    }

    #[test]
    fn empty_library_finishes_in_one_batch() {
        let conn = fixture();
        insert(&conn, "/tmp/plain.png", "plain-hash", "image/png", 10);
        enqueue_introduced_at_in(&conn, REGISTRY, 51).unwrap();
        let batches = run(&conn);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].1, 0);
    }
}
