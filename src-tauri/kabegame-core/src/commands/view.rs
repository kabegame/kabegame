use crate::emitter::current_change_seq;
use crate::providers::{decode_provider_path_segments, query_entry, query_fetch};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct ViewQuery {
    pub rows: String,
    pub count: String,
}

#[derive(Debug, Serialize)]
pub struct ViewSnapshot {
    pub rows: Value,
    pub total: usize,
    pub seq: u64,
}

/// 读取同一视图的行与总数。序号必须先于数据读取，避免漏掉读取期间发出的变更。
pub async fn snapshot_view(query: ViewQuery) -> Result<ViewSnapshot, String> {
    let seq = current_change_seq();
    let rows_path = decode_provider_path_segments(&query.rows);
    let count_path = decode_provider_path_segments(&query.count);
    // 行与总数互不依赖，并行查询；两者都晚于 seq 读取，不影响序号语义。
    let rows_task = tokio::task::spawn_blocking(move || query_fetch(&rows_path));
    let total_task = tokio::task::spawn_blocking(move || {
        query_entry(&count_path).map(|entry| entry.total.unwrap_or(0))
    });
    let (rows, total) = tokio::try_join!(rows_task, total_task).map_err(|e| e.to_string())?;
    let (rows, total) = (rows?, total?);
    let rows = serde_json::to_value(rows).map_err(|e| e.to_string())?;
    Ok(ViewSnapshot { rows, total, seq })
}

pub async fn pathql_view(query: ViewQuery) -> Result<ViewSnapshot, String> {
    snapshot_view(query).await
}
