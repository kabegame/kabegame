//! 收集入口「壁纸」对话框的只读扫描：列出自动识别的三类来源及数量。
//!
//! 只读目录与 `project.json`；不入库、不写任何文件。导入任务会用自己的展开结果，
//! 这里只用于对话框预览。

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::discover::{discover_roots, platform_supported, WpeRootKind};
use super::project::{read_project, WpeKind};
use super::recognize::{classify_dir, expand_dir, RecognizedKind};
use super::{normalize_local_dir, WPE_PROJECT_FILE};

/// 一个来源（按类别合并多个 Steam 库）的扫描结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeSourceInfo {
    /// `workshop` / `defaultprojects` / `myprojects` / `custom`。
    pub kind: String,
    /// 自定义目录的识别结果（`wallpaper` / `workshop` / `install` / `steamLibrary` …）。
    pub recognized: Option<String>,
    pub paths: Vec<String>,
    pub total: usize,
    /// 可导入数量（第一阶段只统计 `video`，且入口文件存在）。
    pub video: usize,
    /// 其中尚未入库、本次导入会新增的数量。
    pub pending: usize,
    /// 已在库中的数量（按 `local_path` 命中）。
    pub imported: usize,
}

impl WpeSourceInfo {
    pub fn empty(kind: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            recognized: None,
            paths: Vec::new(),
            total: 0,
            video: 0,
            pending: 0,
            imported: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeScanResult {
    pub platform_supported: bool,
    pub sources: Vec<WpeSourceInfo>,
}

/// 路径比较键：Windows 大小写不敏感，其余平台原样。
pub fn path_key(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    if cfg!(target_os = "windows") {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// 一批壁纸目录的计数结果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DirCounts {
    pub total: usize,
    pub video: usize,
    /// 可导入且尚未入库。
    pub pending: usize,
    pub imported: usize,
}

impl WpeSourceInfo {
    fn add_counts(&mut self, counts: DirCounts) {
        self.total += counts.total;
        self.video += counts.video;
        self.pending += counts.pending;
        self.imported += counts.imported;
    }
}

/// 把一批壁纸目录计数；`imported` 是已入库 `local_path` 的 [`path_key`] 集合。
pub fn count_dirs(dirs: &[PathBuf], imported: &HashSet<String>) -> DirCounts {
    let mut counts = DirCounts::default();
    for dir in dirs {
        let Some(normalized) = normalize_local_dir(dir) else {
            continue;
        };
        counts.total += 1;
        let already = imported.contains(&path_key(&normalized.to_string_lossy()));
        if already {
            counts.imported += 1;
        }
        if matches!(
            read_project(&normalized),
            Ok(project) if project.kind == WpeKind::Video
        ) {
            counts.video += 1;
            if !already {
                counts.pending += 1;
            }
        }
    }
    counts
}

/// 扫描自动发现的 WPE 来源，按类别合并多个 Steam 库。
pub fn scan_sources(imported: &HashSet<String>) -> WpeScanResult {
    let roots = discover_roots();
    let mut sources: Vec<WpeSourceInfo> = Vec::new();
    for kind in WpeRootKind::ALL {
        let mut info = WpeSourceInfo::empty(kind.as_str());
        for root in roots.iter().filter(|root| root.kind == kind) {
            let dirs = expand_dir(&root.path);
            if dirs.is_empty() {
                continue;
            }
            info.paths.push(root.path.to_string_lossy().into_owned());
            info.add_counts(count_dirs(&dirs, imported));
        }
        if !info.paths.is_empty() {
            sources.push(info);
        }
    }

    WpeScanResult {
        platform_supported: platform_supported(),
        sources,
    }
}

/// 识别用户随手选的目录（单个壁纸 / 创意工坊根 / WPE 安装目录 / Steam 库根）。
pub fn scan_extra_dir(path: &Path, imported: &HashSet<String>) -> Result<WpeSourceInfo, String> {
    let Some(dir) = normalize_local_dir(path) else {
        return Err("目录不存在或不可访问".to_string());
    };
    let dirs = expand_dir(&dir);
    if dirs.is_empty() {
        let recognized = classify_dir(&dir);
        if recognized == RecognizedKind::Unknown {
            return Err("未识别到 Wallpaper Engine 壁纸目录（缺少 project.json）".to_string());
        }
        return Err(format!(
            "该目录（{}）里没有可识别的壁纸目录",
            recognized.as_str()
        ));
    }
    let mut info = WpeSourceInfo::empty("custom");
    info.recognized = Some(classify_dir(&dir).as_str().to_string());
    info.paths.push(dir.to_string_lossy().into_owned());
    info.add_counts(count_dirs(&dirs, imported));
    Ok(info)
}

/// 导入任务用：自动来源按勾选展开成壁纸目录，并去重排序。
pub fn collect_selected_dirs(
    kinds: &[WpeRootKind],
    extra_dirs: &[String],
) -> (Vec<PathBuf>, Vec<(String, String)>) {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut errors: Vec<(String, String)> = Vec::new();

    let roots = discover_roots();
    for root in roots.iter().filter(|root| kinds.contains(&root.kind)) {
        dirs.extend(expand_dir(&root.path));
    }
    for raw in extra_dirs {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        match normalize_local_dir(path) {
            Some(dir) => {
                let expanded = expand_dir(&dir);
                if expanded.is_empty() {
                    errors.push((
                        trimmed.to_string(),
                        format!("{}（{}）", WPE_PROJECT_FILE, classify_dir(&dir).as_str()),
                    ));
                } else {
                    dirs.extend(expanded);
                }
            }
            None => errors.push((trimmed.to_string(), "目录不存在或不可访问".to_string())),
        }
    }

    dirs.sort();
    dirs.dedup();
    (dirs, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kabegame-wpe-scan-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wallpaper(dir: &Path, kind: &str, file: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            format!(r#"{{"type":"{kind}","file":"{file}"}}"#),
        )
        .unwrap();
        if !file.is_empty() {
            fs::write(dir.join(file), b"x").unwrap();
        }
    }

    #[test]
    fn counts_total_video_and_imported() {
        let root = temp_dir("counts");
        let content = root.join("431960");
        wallpaper(&content.join("1"), "video", "a.mp4");
        wallpaper(&content.join("2"), "web", "index.html");
        wallpaper(&content.join("3"), "video", "missing.mp4");
        let dirs = expand_dir(&content);
        fs::remove_file(content.join("3").join("missing.mp4")).unwrap();

        let imported = HashSet::from([path_key(&normalize_local_dir(&content.join("2")).unwrap().to_string_lossy())]);
        let counts = count_dirs(&dirs, &imported);
        assert_eq!(counts.total, 3);
        // 1 是唯一入口存在的 video；3 的入口已删；已入库的 2 是 web，不影响 pending。
        assert_eq!(counts.video, 1);
        assert_eq!(counts.pending, 1);
        assert_eq!(counts.imported, 1);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn extra_dir_reports_unknown() {
        let root = temp_dir("unknown");
        let error = scan_extra_dir(&root, &HashSet::new()).unwrap_err();
        assert!(error.contains("未识别"));
        fs::remove_dir_all(root).ok();
    }
}
