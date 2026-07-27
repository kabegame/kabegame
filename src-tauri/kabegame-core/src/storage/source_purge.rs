/// 图库源文件清除结果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgeReport {
    pub purged: usize,
    pub kept: usize,
}

/// 清除图库源文件的唯一入口。
///
/// 桌面端统一移入系统回收站并保留安全护栏；Android 按 URI scheme 分流到
/// MediaStore 或普通文件删除；iOS 不受支持，仅保留可编译的空实现。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn purge_source_files(paths: &[String]) -> PurgeReport {
    use std::path::PathBuf;

    if paths.is_empty() {
        return PurgeReport::default();
    }

    let owned: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let kept_on_join_error = owned.len();
    match tokio::task::spawn_blocking(move || {
        let refs: Vec<&std::path::Path> = owned.iter().map(PathBuf::as_path).collect();
        crate::storage::safe_delete::trash_source_files_batch(&refs)
    })
    .await
    {
        Ok(report) => report,
        Err(error) => {
            eprintln!("[source_purge] 回收站任务执行失败，保留全部源文件: {error}");
            PurgeReport {
                purged: 0,
                kept: kept_on_join_error,
            }
        }
    }
}

#[cfg(target_os = "android")]
pub async fn purge_source_files(paths: &[String]) -> PurgeReport {
    if paths.is_empty() {
        return PurgeReport::default();
    }

    let mut report = PurgeReport::default();
    let mut media_uris = Vec::new();

    for path in paths {
        if path.starts_with("content://") {
            media_uris.push(path.clone());
            continue;
        }

        match std::fs::remove_file(path) {
            Ok(()) => report.purged += 1,
            Err(error) => {
                report.kept += 1;
                eprintln!("[source_purge] 删除源文件失败，保留文件: {path} — {error}");
            }
        }
    }

    if !media_uris.is_empty() {
        match crate::crawler::content_io::get_content_io_provider()
            .delete_media_uris(&media_uris)
            .await
        {
            Ok((deleted, skipped)) => {
                report.purged += deleted;
                report.kept += skipped;
                let accounted = deleted.saturating_add(skipped);
                if accounted < media_uris.len() {
                    let missing = media_uris.len() - accounted;
                    report.kept += missing;
                    eprintln!(
                        "[source_purge] MediaStore 删除结果缺少 {missing} 条，按保留源文件计数"
                    );
                }
            }
            Err(error) => {
                report.kept += media_uris.len();
                for uri in &media_uris {
                    eprintln!(
                        "[source_purge] 删除 MediaStore 源文件失败，保留文件: {uri} — {error}"
                    );
                }
            }
        }
    }

    report
}

#[cfg(target_os = "ios")]
pub async fn purge_source_files(paths: &[String]) -> PurgeReport {
    PurgeReport {
        purged: 0,
        kept: paths.len(),
    }
}
