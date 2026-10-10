use crate::emitter::current_change_seq;
use crate::providers::{decode_provider_path_segments, query_entry, query_fetch};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct RowsSnapshot {
    pub rows: Value,
    pub seq: u64,
}

#[derive(Debug, Serialize)]
pub struct TotalSnapshot {
    pub total: usize,
    pub seq: u64,
}

/// 先读序号再查询，避免漏掉读取期间发出的变更。
pub async fn snapshot_rows(path: String) -> Result<RowsSnapshot, String> {
    let seq = current_change_seq();
    let path = decode_provider_path_segments(&path);
    let rows = tokio::task::spawn_blocking(move || query_fetch(&path))
        .await
        .map_err(|e| e.to_string())??;
    let rows = serde_json::to_value(rows).map_err(|e| e.to_string())?;
    Ok(RowsSnapshot { rows, seq })
}

/// 先读序号再查询，避免漏掉读取期间发出的变更。
pub async fn snapshot_total(path: String) -> Result<TotalSnapshot, String> {
    let seq = current_change_seq();
    let path = decode_provider_path_segments(&path);
    let total = tokio::task::spawn_blocking(move || {
        query_entry(&path).map(|entry| entry.total.unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(TotalSnapshot { total, seq })
}

pub async fn pathql_view(path: String) -> Result<RowsSnapshot, String> {
    snapshot_rows(path).await
}

pub async fn pathql_count(path: String) -> Result<TotalSnapshot, String> {
    snapshot_total(path).await
}
