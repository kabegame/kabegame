//! 流式下载 release asset 到临时目录 + 进度/取消。
//!
//! 三出口（由 `UpdaterService` 落地状态）：success / fail / cancel。
//! 不校验 checksum / 签名（符合当前版本）。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use kabegame_core::emitter::GlobalEmitter;

use super::UpdaterService;

/// 进度事件节流间隔。
const PROGRESS_THROTTLE_MS: u128 = 200;

enum Outcome {
    Completed(PathBuf),
    Cancelled,
}

/// 下载入口：进入下载态 → 流式写盘 → 按结果落地三出口。
pub async fn download_update(
    tag: String,
    asset_url: String,
    asset_name: String,
) -> Result<(), String> {
    let svc = UpdaterService::global();
    // 守卫：仅可从 UpdateAvailable 进入；checking/downloading → Err（不可重入）
    let cancel = svc.try_begin_download(&tag)?;

    match do_download(&svc, &tag, &asset_url, &asset_name, &cancel).await {
        Ok(Outcome::Completed(path)) => {
            svc.finish_download_success(&tag, path);
            Ok(())
        }
        Ok(Outcome::Cancelled) => {
            svc.finish_download_cancel();
            Ok(())
        }
        Err(e) => {
            svc.finish_download_fail(&e);
            Err(e)
        }
    }
}

async fn do_download(
    svc: &UpdaterService,
    tag: &str,
    asset_url: &str,
    asset_name: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<Outcome, String> {
    // 临时落点：AppPaths.temp_dir/updates（路径逻辑归 AppPaths）
    let dir = kabegame_core::app_paths::AppPaths::global()
        .temp_dir
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create temp dir failed: {e}"))?;
    let path = dir.join(asset_name);

    let outcome = write_stream(svc, tag, asset_url, &path, cancel).await;
    if outcome.is_err() {
        let _ = std::fs::remove_file(&path); // 失败清理半成品
    }
    outcome
}

async fn write_stream(
    svc: &UpdaterService,
    tag: &str,
    asset_url: &str,
    path: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<Outcome, String> {
    // reqwest client（复用全局代理配置，与 P1 一致）
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::default());
    if let Some(ref proxy_url) = kabegame_core::crawler::proxy::get_proxy_config().proxy_url {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let resp = client
        .get(asset_url)
        .header(reqwest::header::USER_AGENT, "kabegame-updater")
        .send()
        .await
        .map_err(|e| format!("download request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let total = resp.content_length();

    let mut file = std::fs::File::create(path).map_err(|e| format!("create file failed: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(path);
            return Ok(Outcome::Cancelled);
        }
        let chunk = chunk.map_err(|e| format!("download stream error: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("write failed: {e}"))?;
        downloaded += chunk.len() as u64;
        svc.update_progress(downloaded, total);
        if last_emit.elapsed().as_millis() >= PROGRESS_THROTTLE_MS {
            emit_progress(tag, downloaded, total);
            last_emit = Instant::now();
        }
    }
    file.flush().map_err(|e| format!("flush failed: {e}"))?;
    emit_progress(tag, downloaded, total); // 末次进度
    Ok(Outcome::Completed(path.to_path_buf()))
}

fn emit_progress(tag: &str, downloaded: u64, total: Option<u64>) {
    let percent = match total {
        Some(t) if t > 0 => (downloaded as f64 / t as f64) * 100.0,
        _ => 0.0,
    };
    GlobalEmitter::global().emit(
        "update-download-progress",
        serde_json::json!({
            "tag": tag,
            "downloadedBytes": downloaded,
            "totalBytes": total,
            "percent": percent,
        }),
    );
}
