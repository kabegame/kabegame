//! 整理（organize）命令的共享实现层。
//!
//! 调用方（均在 `kabegame` crate）：`web::dispatch` 与 `commands::misc`。
//! `start_organize` 只负责发起，进度/取消由下面三个函数提供 —— 缺一不可，
//! 否则调用方能启动却无法观测或中止。

use crate::storage::organize::{OrganizeOptions, OrganizeService};
use crate::storage::Storage;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOrganizeArgs {
    pub dedupe: bool,
    #[serde(default)]
    pub dedupe_keep_new: bool,
    pub remove_missing: bool,
    pub remove_unrecognized: bool,
    pub regen_thumbnails: bool,
    #[serde(default)]
    pub regen_compatible: bool,
    #[serde(default)]
    pub delete_source_files: bool,
    pub range_start: Option<usize>,
    pub range_end: Option<usize>,
}

pub async fn start_organize(args: StartOrganizeArgs) -> Result<Value, String> {
    let (offset, limit) = match (args.range_start, args.range_end) {
        (Some(s), Some(e)) if e > s => (Some(s), Some(e - s)),
        _ => (None, None),
    };
    OrganizeService::global()
        .clone()
        .start(
            Arc::new(Storage::global().clone()),
            OrganizeOptions {
                dedupe: args.dedupe,
                dedupe_keep_new: args.dedupe_keep_new,
                remove_missing: args.remove_missing,
                remove_unrecognized: args.remove_unrecognized,
                regen_thumbnails: args.regen_thumbnails,
                regen_compatible: args.regen_compatible,
                delete_source_files: args.delete_source_files,
                offset,
                limit,
            },
        )
        .await?;
    Ok(Value::Null)
}

/// 可整理的图片总数（前端据此算范围上界）。
pub fn get_organize_total_count() -> Result<Value, String> {
    let count = Storage::global().get_images_total_count()?;
    serde_json::to_value(count).map_err(|e| e.to_string())
}

/// 页面刷新后同步：是否正在整理及当前进度快照（与 `organize-progress` 事件一致）。
pub fn get_organize_run_state() -> Result<Value, String> {
    let state = OrganizeService::global().get_run_state();
    serde_json::to_value(state).map_err(|e| e.to_string())
}

/// 请求中止当前整理；返回是否确实有任务被取消。
pub fn cancel_organize() -> Result<Value, String> {
    let canceled = OrganizeService::global().cancel()?;
    serde_json::to_value(canceled).map_err(|e| e.to_string())
}
