//! 可恢复的异步回填作业（backfill）。
//!
//! schema 迁移（[`super::MIGRATIONS`]）只改结构、必须在进入界面前跑完；回填是「按现有列补算数据」
//! 的长作业，登记进 `backfill_jobs` 表后按批推进：
//!
//! - 由某个 schema 迁移在跨过其版本时登记（[`enqueue_introduced_at`]）。新增回填不必真的改 schema，
//!   写一个 `up` 为空的迁移专门用来登记即可。全新安装走 `create_all_tables`，不登记任何作业。
//! - 每批由作业自己的写入与 `cursor` / `processed` 进度在同一个 `BEGIN IMMEDIATE` 事务里提交
//!   （[`BackfillCtx::commit`]），崩溃后从游标续跑；批间释放写锁，用户写入可以穿插。
//! - 启动时只同步排干被后续迁移 `min_backfill_version` 显式依赖的作业（阻塞阶段，Storage 尚未构造，
//!   直接用裸连接）；其余进入界面后由 `BackfillService` 在后台按 `introduced_at, id` 顺序跑完。
//!
//! 不变量：回填只读写它引入时就已存在的列；之后任何想改动这些列的 schema 迁移必须用
//! `min_backfill_version` 先排干它（排干后它不再运行）。

use crate::ipc::events::ImageFieldPatch;
use rusqlite::{params, Connection, OptionalExtension};
use std::cell::Cell;
use std::future::Future;
use std::sync::Mutex;

/// 一个回填作业的定义。作业代码是随应用维护的活代码，不是冻结 SQL。
pub struct Backfill {
    /// 全局唯一 id，也是 `backfill_jobs.id`。
    pub id: &'static str,
    /// 登记它的迁移版本（必须等于某个 `Migration.version`）。
    pub introduced_at: u32,
    /// 当前平台能否运行；不能运行的作业保持 pending、不计 attempts，等能跑的平台再跑。
    pub platforms: fn() -> bool,
    /// 每批最多处理的候选行数。
    pub batch_size: usize,
    /// 登记时估算剩余工作量，写进 `backfill_jobs.total` 作为进度分母。
    pub count_remaining: fn(&Connection) -> Result<usize, String>,
    /// 从 `cursor`（已处理到的 rowid）之后取最多 `limit` 行处理一批。
    /// 有写入时必须经 [`BackfillCtx::commit`] 提交（每批至多一次），并返回 commit 给出的结果。
    pub run_batch: fn(&BackfillCtx, cursor: i64, limit: usize) -> Result<BatchOutcome, String>,
}

/// 一批的结果。
#[derive(Debug, Default)]
pub struct BatchOutcome {
    /// 下一批的起始游标；`None` 表示已到末尾、作业完成。
    pub next_cursor: Option<i64>,
    /// 本批处理（检查过）的候选行数，累加进 `backfill_jobs.processed`。
    pub processed: usize,
    /// 本批产生的图片字段补丁；后台阶段经 `emit_image_patches` 推给前端，阻塞阶段丢弃。
    pub patches: Vec<ImageFieldPatch>,
}

/// 一个作业当前的进度（`backfill_jobs` 行的内存镜像）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobProgress {
    pub id: &'static str,
    pub cursor: i64,
    pub processed: usize,
    pub total: Option<usize>,
}

/// 待执行作业：注册表定义 + 持久化进度。
pub struct PendingJob {
    pub job: &'static Backfill,
    pub introduced_at: u32,
    pub progress: JobProgress,
}

enum CtxConn<'a> {
    /// 阻塞阶段：Storage 尚未构造，直接用迁移用的裸连接。
    Raw(&'a Connection),
    /// 后台阶段：按需短暂锁 `storage.db`。
    Locked(&'a Mutex<Connection>),
}

enum CtxRuntime {
    /// 阻塞阶段：在作用域线程里临时建 current_thread runtime（调用方可能已在某个 runtime 里，
    /// 例如 CLI 的 `#[tokio::main]`、web 的 `block_on`，不能在当前线程再建 runtime）。
    Scoped,
    /// 后台阶段：作业跑在 tokio blocking 线程池里，直接用 Handle。
    Handle(tokio::runtime::Handle),
}

/// 作业拿到的执行上下文：按需取连接、跑异步、提交一批。
pub struct BackfillCtx<'a> {
    job_id: &'static str,
    conn: CtxConn<'a>,
    runtime: CtxRuntime,
    committed: Cell<bool>,
}

impl<'a> BackfillCtx<'a> {
    pub(crate) fn blocking(job_id: &'static str, conn: &'a Connection) -> Self {
        Self {
            job_id,
            conn: CtxConn::Raw(conn),
            runtime: CtxRuntime::Scoped,
            committed: Cell::new(false),
        }
    }

    pub(crate) fn background(
        job_id: &'static str,
        db: &'a Mutex<Connection>,
        handle: tokio::runtime::Handle,
    ) -> Self {
        Self {
            job_id,
            conn: CtxConn::Locked(db),
            runtime: CtxRuntime::Handle(handle),
            committed: Cell::new(false),
        }
    }

    /// 短暂取连接（后台阶段持有 `storage.db` 锁直到闭包返回）。不开事务；需要和进度一起提交的写入走 [`Self::commit`]。
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        match &self.conn {
            CtxConn::Raw(conn) => f(conn),
            CtxConn::Locked(db) => {
                let conn = db.lock().map_err(|e| format!("Lock error: {e}"))?;
                f(&conn)
            }
        }
    }

    /// 在同步作业里跑一个异步操作（转码等）。调用期间不持有连接。
    pub fn block_on<F>(&self, fut: F) -> F::Output
    where
        F: Future + Send,
        F::Output: Send,
    {
        match &self.runtime {
            CtxRuntime::Handle(handle) => handle.block_on(fut),
            CtxRuntime::Scoped => std::thread::scope(|scope| {
                scope
                    .spawn(|| {
                        let runtime = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .expect("build backfill runtime");
                        runtime.block_on(fut)
                    })
                    .join()
                    .expect("backfill block_on thread panicked")
            }),
        }
    }

    /// 在一个 `BEGIN IMMEDIATE … COMMIT` 事务里执行本批写入，并在同一事务内把返回的进度写回
    /// `backfill_jobs`。每批至多调用一次；`f` 或提交失败时整批回滚、进度不前进。
    pub fn commit(
        &self,
        f: impl FnOnce(&Connection) -> Result<BatchOutcome, String>,
    ) -> Result<BatchOutcome, String> {
        debug_assert!(!self.committed.get(), "BackfillCtx::commit 每批至多一次");
        let job_id = self.job_id;
        let outcome = self.with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")
                .map_err(|e| format!("backfill {job_id} begin: {e}"))?;
            let result = f(conn).and_then(|outcome| {
                write_progress(conn, job_id, &outcome)?;
                Ok(outcome)
            });
            match result {
                Ok(outcome) => match conn.execute_batch("COMMIT") {
                    Ok(()) => Ok(outcome),
                    Err(e) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        Err(format!("backfill {job_id} commit: {e}"))
                    }
                },
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })?;
        self.committed.set(true);
        Ok(outcome)
    }

    fn take_committed(&self) -> bool {
        self.committed.replace(false)
    }
}

/// 发布态注册表（作业实现放在 `backfills/`）。当前没有作业；框架行为由下方测试里的内存作业覆盖。
const BACKFILLS: &[Backfill] = &[];

pub(crate) fn registry() -> &'static [Backfill] {
    BACKFILLS
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

pub(crate) fn has_jobs_table(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backfill_jobs'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|e| format!("inspect backfill_jobs: {e}"))
}

fn write_progress(conn: &Connection, job_id: &str, outcome: &BatchOutcome) -> Result<(), String> {
    conn.execute(
        "UPDATE backfill_jobs
            SET cursor = COALESCE(?1, cursor),
                processed = processed + ?2,
                done = CASE WHEN ?1 IS NULL THEN 1 ELSE 0 END,
                updated_at = ?3
          WHERE id = ?4",
        params![
            outcome.next_cursor,
            outcome.processed as i64,
            now_ms(),
            job_id
        ],
    )
    .map_err(|e| format!("backfill {job_id} write progress: {e}"))?;
    Ok(())
}

fn record_failure(conn: &Connection, job_id: &str, error: &str) {
    if let Err(e) = conn.execute(
        "UPDATE backfill_jobs
            SET attempts = attempts + 1, last_error = ?1, updated_at = ?2
          WHERE id = ?3",
        params![error, now_ms(), job_id],
    ) {
        eprintln!("[backfill] {job_id} record failure failed: {e}");
    }
}

/// 登记 `registry` 中 `introduced_at == version` 的作业（`INSERT OR IGNORE`，`total` 取当时的 `count_remaining`）。
pub(crate) fn enqueue_introduced_at_in(
    conn: &Connection,
    registry: &[Backfill],
    version: u32,
) -> Result<(), String> {
    for job in registry.iter().filter(|job| job.introduced_at == version) {
        let total = (job.count_remaining)(conn)?;
        conn.execute(
            "INSERT OR IGNORE INTO backfill_jobs (id, introduced_at, total, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![job.id, i64::from(version), total as i64, now_ms()],
        )
        .map_err(|e| format!("enqueue backfill {}: {e}", job.id))?;
        println!(
            "[backfill] enqueued {} (v{version:03}, total {total})",
            job.id
        );
    }
    Ok(())
}

pub fn enqueue_introduced_at(conn: &Connection, version: u32) -> Result<(), String> {
    enqueue_introduced_at_in(conn, registry(), version)
}

/// 未完成、在注册表中且当前平台可运行的作业，按 `introduced_at, id` 排序。
pub(crate) fn pending_jobs_in(
    conn: &Connection,
    registry: &'static [Backfill],
) -> Result<Vec<PendingJob>, String> {
    if !has_jobs_table(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, introduced_at, cursor, processed, total
               FROM backfill_jobs
              WHERE done = 0
              ORDER BY introduced_at, id",
        )
        .map_err(|e| format!("prepare pending backfills: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(|e| format!("query pending backfills: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("collect pending backfills: {e}"))?;

    Ok(rows
        .into_iter()
        .filter_map(|(id, introduced_at, cursor, processed, total)| {
            let job = registry.iter().find(|job| job.id == id)?;
            if !(job.platforms)() {
                return None;
            }
            Some(PendingJob {
                job,
                introduced_at: introduced_at as u32,
                progress: JobProgress {
                    id: job.id,
                    cursor,
                    processed: processed.max(0) as usize,
                    total: total.map(|t| t.max(0) as usize),
                },
            })
        })
        .collect())
}

pub fn pending_jobs(conn: &Connection) -> Result<Vec<PendingJob>, String> {
    pending_jobs_in(conn, registry())
}

/// 循环 `run_batch` 直到作业完成。每批结束后回调 `on_batch(进度, 本批结果)`。
///
/// 作业返回 Err（基础设施错误）时记 `attempts += 1 / last_error` 并返回 Err，进度停在最后一次提交。
pub fn run_to_completion(
    ctx: &BackfillCtx,
    pending: &PendingJob,
    on_batch: &mut dyn FnMut(&JobProgress, BatchOutcome),
) -> Result<(), String> {
    let job = pending.job;
    let mut progress = pending.progress.clone();
    loop {
        let result =
            (job.run_batch)(ctx, progress.cursor, job.batch_size.max(1)).and_then(|outcome| {
                if outcome.next_cursor == Some(progress.cursor) {
                    return Err(format!(
                        "backfill {} 游标未推进（停在 {}）",
                        job.id, progress.cursor
                    ));
                }
                if !ctx.take_committed() {
                    // 本批没有写入：只推进进度。
                    ctx.commit(|_| {
                        Ok(BatchOutcome {
                            next_cursor: outcome.next_cursor,
                            processed: outcome.processed,
                            patches: Vec::new(),
                        })
                    })?;
                    ctx.take_committed();
                }
                Ok(outcome)
            });
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) => {
                ctx.take_committed();
                let _ = ctx.with_conn(|conn| {
                    record_failure(conn, job.id, &error);
                    Ok(())
                });
                return Err(error);
            }
        };
        progress.processed += outcome.processed;
        let finished = outcome.next_cursor.is_none();
        if let Some(next) = outcome.next_cursor {
            progress.cursor = next;
        }
        on_batch(&progress, outcome);
        if finished {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::migrations::{Migration, MIGRATIONS};
    use std::collections::HashSet;

    #[test]
    fn registry_ids_are_unique_and_introduced_by_a_migration() {
        let mut ids = HashSet::new();
        for job in registry() {
            assert!(ids.insert(job.id), "重复的回填 id: {}", job.id);
            assert!(
                MIGRATIONS.iter().any(|m| m.version == job.introduced_at),
                "回填 {} 的 introduced_at v{} 没有对应迁移",
                job.id,
                job.introduced_at
            );
            assert!(
                job.introduced_at >= 48,
                "回填 {} 早于 backfill_jobs 表（v048）",
                job.id
            );
            assert!(job.batch_size > 0, "回填 {} batch_size 为 0", job.id);
        }
    }

    #[test]
    fn min_backfill_version_points_to_an_earlier_version() {
        for m in MIGRATIONS {
            if let Some(min) = m.min_backfill_version {
                assert!(
                    min < m.version,
                    "v{} 的 min_backfill_version v{min} 不早于自身",
                    m.version
                );
            }
        }
    }

    // ---------- run_pending 夹具：内存库 + 测试迁移 / 测试作业 ----------
    //
    // 作业是 fn 指针、不能捕获状态，失败注入与「做过几次」都记在库里，保证并行测试互不干扰。

    fn fixture(version: u32) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "{}
             CREATE TABLE items (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER,
                                 hits INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE fail_at (job TEXT NOT NULL, cursor INTEGER NOT NULL);
             CREATE TABLE log (what TEXT NOT NULL);
             PRAGMA user_version = {version};",
            super::super::BACKFILL_JOBS_DDL
        ))
        .unwrap();
        for id in 1..=10 {
            conn.execute("INSERT INTO items (id) VALUES (?1)", [id])
                .unwrap();
        }
        conn
    }

    fn count_null(conn: &Connection, column: &str) -> Result<usize, String> {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM items WHERE {column} IS NULL"),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n as usize)
        .map_err(|e| e.to_string())
    }

    fn fill_batch(
        ctx: &BackfillCtx,
        cursor: i64,
        limit: usize,
        column: &str,
        job: &str,
    ) -> Result<BatchOutcome, String> {
        let poisoned = ctx.with_conn(|conn| {
            conn.query_row(
                "SELECT 1 FROM fail_at WHERE job = ?1 AND cursor = ?2",
                params![job, cursor],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(|e| e.to_string())
        })?;
        if poisoned {
            return Err(format!("{job} poisoned at {cursor}"));
        }
        ctx.commit(|conn| {
            let ids = conn
                .prepare(&format!(
                    "SELECT id FROM items WHERE id > ?1 AND {column} IS NULL ORDER BY id LIMIT ?2"
                ))
                .and_then(|mut stmt| {
                    stmt.query_map(params![cursor, limit as i64], |row| row.get::<_, i64>(0))?
                        .collect::<Result<Vec<_>, _>>()
                })
                .map_err(|e| e.to_string())?;
            for id in &ids {
                conn.execute(
                    &format!("UPDATE items SET {column} = 1, hits = hits + 1 WHERE id = ?1"),
                    [id],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(BatchOutcome {
                next_cursor: if ids.len() < limit {
                    None
                } else {
                    ids.last().copied()
                },
                processed: ids.len(),
                patches: Vec::new(),
            })
        })
    }

    const JOB_A: Backfill = Backfill {
        id: "test_fill_a",
        introduced_at: 101,
        platforms: || true,
        batch_size: 3,
        count_remaining: |conn| count_null(conn, "a"),
        run_batch: |ctx, cursor, limit| fill_batch(ctx, cursor, limit, "a", "test_fill_a"),
    };

    const JOB_B: Backfill = Backfill {
        id: "test_fill_b",
        introduced_at: 102,
        platforms: || true,
        batch_size: 4,
        count_remaining: |conn| count_null(conn, "b"),
        run_batch: |ctx, cursor, limit| fill_batch(ctx, cursor, limit, "b", "test_fill_b"),
    };

    const JOB_NEVER: Backfill = Backfill {
        id: "test_never_here",
        introduced_at: 102,
        platforms: || false,
        batch_size: 4,
        count_remaining: |_| Ok(0),
        run_batch: |_, _, _| Err("platform gated job must not run".to_string()),
    };

    static TEST_BACKFILLS: &[Backfill] = &[JOB_A, JOB_B, JOB_NEVER];

    fn noop(_: &Connection) -> Result<(), String> {
        Ok(())
    }

    /// v103 依赖 v101 的作业：执行时 `a` 必须已全部补齐。
    fn v103_requires_a(conn: &Connection) -> Result<(), String> {
        let missing = count_null(conn, "a")?;
        if missing > 0 {
            return Err(format!(
                "v103 ran before test_fill_a drained ({missing} missing)"
            ));
        }
        conn.execute("INSERT INTO log (what) VALUES ('v103')", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    static TEST_MIGRATIONS: &[Migration] = &[
        Migration {
            version: 101,
            name: "register_a",
            up: noop,
            min_backfill_version: None,
        },
        Migration {
            version: 102,
            name: "register_b",
            up: noop,
            min_backfill_version: None,
        },
        Migration {
            version: 103,
            name: "needs_a",
            up: v103_requires_a,
            min_backfill_version: Some(101),
        },
    ];

    fn run(conn: &Connection, sync_through: Option<u32>) -> Result<Vec<String>, String> {
        let mut events = Vec::new();
        super::super::run_pending_with(
            conn,
            TEST_MIGRATIONS,
            TEST_BACKFILLS,
            sync_through,
            &mut |p| events.push(format!("{p:?}")),
        )?;
        Ok(events)
    }

    fn job_row(conn: &Connection, id: &str) -> (i64, i64, i64, i64, Option<String>) {
        conn.query_row(
            "SELECT cursor, processed, done, attempts, last_error FROM backfill_jobs WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap()
    }

    #[test]
    fn required_backfill_drains_before_dependent_migration_others_stay_pending() {
        let conn = fixture(100);
        let events = run(&conn, None).unwrap();

        assert_eq!(super::super::current_version(&conn), 103);
        // 阻塞集只有 test_fill_a：v103 之前跑完。
        assert_eq!(count_null(&conn, "a").unwrap(), 0);
        let (_, processed, done, attempts, _) = job_row(&conn, "test_fill_a");
        assert_eq!((processed, done, attempts), (10, 1, 0));
        // 跨多版本升级：test_fill_b 比 v103 老但没有被要求，保持 pending、一行未动。
        assert_eq!(count_null(&conn, "b").unwrap(), 10);
        let (cursor, processed, done, _, _) = job_row(&conn, "test_fill_b");
        assert_eq!((cursor, processed, done), (0, 0, 0));
        // 平台门控的作业照常登记，但不进 pending。
        let pending = pending_jobs_in(&conn, TEST_BACKFILLS).unwrap();
        assert_eq!(
            pending.iter().map(|p| p.job.id).collect::<Vec<_>>(),
            ["test_fill_b"]
        );
        assert_eq!(
            conn.query_row(
                "SELECT total FROM backfill_jobs WHERE id = 'test_fill_b'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            10
        );
        // 进度事件：先 schema，排干 a 的批次夹在 v102 与 v103 之间。
        let v103 = events
            .iter()
            .position(|e| e.contains("version: 103"))
            .unwrap();
        let last_a = events
            .iter()
            .rposition(|e| e.contains("test_fill_a"))
            .unwrap();
        assert!(last_a < v103, "{events:?}");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM log", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn sync_through_env_widens_blocking_set() {
        let conn = fixture(100);
        run(&conn, Some(102)).unwrap();
        assert_eq!(count_null(&conn, "b").unwrap(), 0);
        assert_eq!(job_row(&conn, "test_fill_b").2, 1);
        assert!(pending_jobs_in(&conn, TEST_BACKFILLS).unwrap().is_empty());

        // 已是最新版本时环境变量仍会排干。
        conn.execute(
            "UPDATE backfill_jobs SET done = 0, cursor = 0, processed = 0 WHERE id = 'test_fill_b'",
            [],
        )
        .unwrap();
        conn.execute("UPDATE items SET b = NULL", []).unwrap();
        run(&conn, Some(102)).unwrap();
        assert_eq!(count_null(&conn, "b").unwrap(), 0);
    }

    #[test]
    fn interrupted_job_resumes_from_cursor_without_redoing_rows() {
        let conn = fixture(102);
        enqueue_introduced_at_in(&conn, TEST_BACKFILLS, 101).unwrap();
        // 第三批（游标停在 6）注入失败。
        conn.execute(
            "INSERT INTO fail_at (job, cursor) VALUES ('test_fill_a', 6)",
            [],
        )
        .unwrap();

        let error = run(&conn, None).unwrap_err();
        assert!(error.contains("poisoned"), "{error}");
        assert_eq!(
            super::super::current_version(&conn),
            102,
            "依赖失败时 v103 不执行"
        );
        let (cursor, processed, done, attempts, last_error) = job_row(&conn, "test_fill_a");
        assert_eq!((cursor, processed, done, attempts), (6, 6, 0, 1));
        assert!(last_error.unwrap().contains("poisoned"));

        conn.execute("DELETE FROM fail_at", []).unwrap();
        run(&conn, None).unwrap();
        assert_eq!(super::super::current_version(&conn), 103);
        let (_, processed, done, attempts, _) = job_row(&conn, "test_fill_a");
        assert_eq!((processed, done, attempts), (10, 1, 1));
        // 每行恰好处理一次：续跑从游标开始，不重做已提交的批。
        assert_eq!(
            conn.query_row("SELECT MAX(hits), MIN(hits) FROM items", [], |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?
            )))
            .unwrap(),
            (1, 1)
        );
    }

    #[test]
    fn run_to_completion_reports_each_batch() {
        let conn = fixture(102);
        enqueue_introduced_at_in(&conn, TEST_BACKFILLS, 101).unwrap();
        let pending = pending_jobs_in(&conn, TEST_BACKFILLS).unwrap();
        let ctx = BackfillCtx::blocking(pending[0].job.id, &conn);
        let mut seen = Vec::new();
        run_to_completion(&ctx, &pending[0], &mut |progress, _| {
            seen.push((progress.cursor, progress.processed))
        })
        .unwrap();
        // 10 行、每批 3：3 / 6 / 9 / 末批 1 行（游标停在 9，done）。
        assert_eq!(seen, [(3, 3), (6, 6), (9, 9), (9, 10)]);
    }

    #[test]
    fn blocking_ctx_block_on_works_inside_a_runtime() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let value = runtime.block_on(async {
            let conn = Connection::open_in_memory().unwrap();
            let ctx = BackfillCtx::blocking("test", &conn);
            ctx.block_on(async { 41 + 1 })
        });
        assert_eq!(value, 42);
    }
}
