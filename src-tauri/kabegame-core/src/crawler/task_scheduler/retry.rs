//! 任务失败重试：运行期失败的任务按自身冻结的参数再提交一个新任务。
//!
//! 只由 worker 在运行期失败（`TaskError::Other` 且未取消）后调用；运行前失败（`enqueue`
//! 冻结阶段：找不到插件、配置不合法、版本不够……）是确定性的，不重试，自然结束重试链。
//! 新任务照搬数据库里的冻结快照，不重新合并用户默认配置；`run_config_id` 与
//! `trigger_source` 继承下来，定时任务的重试仍算作这次定时运行。

use super::TaskScheduler;
use crate::crawler::task_log_i18n::task_log_i18n;
use crate::emitter::GlobalEmitter;
use crate::storage::tasks::TaskStatus;
use crate::storage::{Storage, TaskInfo};
use serde_json::json;

/// 任务级失败重试次数上限（含）。
pub const MAX_TASK_RETRY_COUNT: u32 = 10;

/// 提交入口校验：0 关闭，1..=10 为最多重试次数。
pub fn validate_retry_count(count: u32) -> Result<(), String> {
    if count > MAX_TASK_RETRY_COUNT {
        return Err(format!(
            "失败重试次数必须在 0 到 {MAX_TASK_RETRY_COUNT} 之间"
        ));
    }
    Ok(())
}

/// 失败任务 → 下一次尝试的任务记录；次数用尽返回 `None`。
pub(crate) fn next_attempt(failed: &TaskInfo, new_id: String, now_ms: u64) -> Option<TaskInfo> {
    if failed.retry_attempt >= failed.retry_count {
        return None;
    }
    let retry_root_id = if failed.retry_root_id.is_empty() {
        failed.id.clone()
    } else {
        failed.retry_root_id.clone()
    };
    Some(TaskInfo {
        id: new_id,
        status: TaskStatus::Pending,
        progress: 0.0,
        deleted_count: 0,
        dedup_count: 0,
        success_count: 0,
        failed_count: 0,
        start_time: Some(now_ms),
        end_time: None,
        error: None,
        retry_attempt: failed.retry_attempt + 1,
        retry_root_id,
        // 冻结参数、run_config_id、trigger_source、retry_count 原样继承
        ..failed.clone()
    })
}

/// worker 在任务确实落到 `Failed` 之后调用：还有次数就给失败任务记一条日志，
/// 并在后台提交下一次尝试（不占 worker 槽位）。
pub(crate) fn resubmit_after_failure(task_id: &str) {
    let failed = match Storage::global().get_task(task_id) {
        Ok(Some(task)) => task,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!("读取失败任务 {task_id} 以重试失败: {error}");
            return;
        }
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let Some(next) = next_attempt(&failed, uuid::Uuid::new_v4().to_string(), now_ms) else {
        return;
    };
    GlobalEmitter::global().emit_task_log(
        task_id,
        "info",
        &task_log_i18n(
            "taskLogRetrySubmitted",
            json!({ "attempt": next.retry_attempt, "count": next.retry_count }),
        ),
    );
    let failed_id = task_id.to_string();
    tokio::spawn(async move {
        let next_id = next.id.clone();
        // 新任务若在冻结阶段失败，enqueue 已把它标成 Failed；这属于运行前失败，链到此结束。
        if let Err(error) = TaskScheduler::global()
            .add_and_submit(next, None, false)
            .await
        {
            tracing::warn!("任务 {failed_id} 的重试任务 {next_id} 提交失败: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn failed_task(retry_count: u32, retry_attempt: u32) -> TaskInfo {
        TaskInfo {
            id: "t-1".to_string(),
            plugin_id: "plugin".to_string(),
            output_dir: Some("/tmp/out".to_string()),
            user_config: Some(HashMap::from([("k".to_string(), json!("v"))])),
            http_headers: Some(HashMap::from([("A".to_string(), "b".to_string())])),
            output_album_id: Some("album".to_string()),
            run_config_id: Some("config".to_string()),
            trigger_source: "scheduled".to_string(),
            max_concurrent_downloads: Some(3),
            is_dry_run: true,
            retry_count,
            retry_attempt,
            retry_root_id: "root".to_string(),
            status: TaskStatus::Failed,
            progress: 42.0,
            deleted_count: 1,
            dedup_count: 2,
            success_count: 3,
            failed_count: 4,
            start_time: Some(10),
            end_time: Some(20),
            error: Some("boom".to_string()),
        }
    }

    #[test]
    fn no_retry_when_disabled_or_exhausted() {
        assert!(next_attempt(&failed_task(0, 0), "n".into(), 99).is_none());
        assert!(next_attempt(&failed_task(2, 2), "n".into(), 99).is_none());
    }

    #[test]
    fn next_attempt_resets_runtime_state_and_inherits_frozen_params() {
        let failed = failed_task(3, 1);
        let next = next_attempt(&failed, "t-2".into(), 99).unwrap();
        assert_eq!(next.id, "t-2");
        assert_eq!(next.retry_attempt, 2);
        assert_eq!(next.retry_count, 3);
        assert_eq!(next.retry_root_id, "root");
        assert_eq!(next.status, TaskStatus::Pending);
        assert_eq!(next.progress, 0.0);
        assert_eq!(
            (
                next.deleted_count,
                next.dedup_count,
                next.success_count,
                next.failed_count
            ),
            (0, 0, 0, 0)
        );
        assert_eq!((next.start_time, next.end_time), (Some(99), None));
        assert!(next.error.is_none());
        assert_eq!(next.plugin_id, failed.plugin_id);
        assert_eq!(next.output_dir, failed.output_dir);
        assert_eq!(next.user_config, failed.user_config);
        assert_eq!(next.http_headers, failed.http_headers);
        assert_eq!(next.output_album_id, failed.output_album_id);
        assert_eq!(next.run_config_id, failed.run_config_id);
        assert_eq!(next.trigger_source, "scheduled");
        assert_eq!(next.max_concurrent_downloads, Some(3));
        assert!(next.is_dry_run);
    }

    #[test]
    fn empty_root_falls_back_to_failed_task_id() {
        let mut failed = failed_task(1, 0);
        failed.retry_root_id.clear();
        assert_eq!(
            next_attempt(&failed, "n".into(), 1).unwrap().retry_root_id,
            "t-1"
        );
    }

    #[test]
    fn validate_retry_count_bounds() {
        assert!(validate_retry_count(0).is_ok());
        assert!(validate_retry_count(10).is_ok());
        assert!(validate_retry_count(11).is_err());
    }
}
