//! 把用户随手选的文件夹识别成 WPE 壁纸目录集合。
//!
//! 支持：单个壁纸目录、创意工坊根（`431960`）、WPE 安装目录、`projects/` 目录、
//! Steam 库根（含 `steamapps/`）与 `steamapps/` 本身；其它目录向下找两层
//! `project.json`，都没有则视为未识别。

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::{normalize_local_dir, WPE_PROJECT_FILE};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecognizedKind {
    /// 单个壁纸目录（含 `project.json`）。
    Wallpaper,
    /// 创意工坊内容根（`431960`）。
    Workshop,
    /// `defaultprojects` / `myprojects` / `projects`。
    Projects,
    /// WPE 安装目录。
    Install,
    /// Steam 库根或 `steamapps/`。
    SteamLibrary,
    Unknown,
}

impl RecognizedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wallpaper => "wallpaper",
            Self::Workshop => "workshop",
            Self::Projects => "projects",
            Self::Install => "install",
            Self::SteamLibrary => "steamLibrary",
            Self::Unknown => "unknown",
        }
    }
}

fn has_project(dir: &Path) -> bool {
    dir.join(WPE_PROJECT_FILE).is_file()
}

fn file_name_lower(dir: &Path) -> String {
    dir.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// 子目录是否「多为纯数字目录且各含 project.json」。
fn looks_like_workshop_root(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut numeric = 0usize;
    let mut with_project = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty() || !name.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        numeric += 1;
        if has_project(&path) {
            with_project += 1;
        }
    }
    numeric > 0 && with_project * 2 >= numeric
}

fn looks_like_install(dir: &Path) -> bool {
    dir.join("wallpaper64.exe").is_file()
        || dir.join("wallpaper32.exe").is_file()
        || (dir.join("bin").is_dir() && dir.join("projects").is_dir())
        || file_name_lower(dir) == "wallpaper_engine"
}

fn looks_like_steam_library(dir: &Path) -> bool {
    if file_name_lower(dir) == "steamapps" {
        return dir.is_dir();
    }
    dir.join("steamapps").is_dir()
}

fn looks_like_projects(dir: &Path) -> bool {
    matches!(file_name_lower(dir).as_str(), "projects" | "defaultprojects" | "myprojects")
}

/// 识别目录类型（不展开）。
pub fn classify_dir(path: &Path) -> RecognizedKind {
    let Some(dir) = normalize_local_dir(path) else {
        return RecognizedKind::Unknown;
    };
    if has_project(&dir) {
        return RecognizedKind::Wallpaper;
    }
    if looks_like_install(&dir) {
        return RecognizedKind::Install;
    }
    if looks_like_projects(&dir) {
        return RecognizedKind::Projects;
    }
    if file_name_lower(&dir) == "431960" || looks_like_workshop_root(&dir) {
        return RecognizedKind::Workshop;
    }
    if looks_like_steam_library(&dir) {
        return RecognizedKind::SteamLibrary;
    }
    RecognizedKind::Unknown
}

fn sorted_project_children(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && has_project(path))
        .filter_map(|path| normalize_local_dir(&path))
        .collect();
    out.sort();
    out
}

fn projects_roots(install: &Path) -> Vec<PathBuf> {
    // `install` 既可能是 WPE 安装根，也可能直接是 `projects/`。
    let base = if file_name_lower(install) == "projects" {
        install.to_path_buf()
    } else {
        install.join("projects")
    };
    let mut out = Vec::new();
    for name in ["defaultprojects", "myprojects"] {
        let path = base.join(name);
        if path.is_dir() {
            out.push(path);
        }
    }
    if out.is_empty() && base.is_dir() {
        out.push(base);
    }
    out
}

/// 展开一个 `projects/` 风格目录（可直接是 projects，也可已是 defaultprojects）。
fn expand_projects_root(dir: &Path) -> Vec<PathBuf> {
    if matches!(file_name_lower(dir).as_str(), "defaultprojects" | "myprojects") {
        return sorted_project_children(dir);
    }
    let mut out = Vec::new();
    for root in projects_roots(dir) {
        out.extend(sorted_project_children(&root));
    }
    out
}

fn library_content_roots(library: &Path) -> Vec<PathBuf> {
    // `library` 既可能是库根，也可能是 `steamapps/`。
    let steamapps = if file_name_lower(library) == "steamapps" {
        library.to_path_buf()
    } else {
        library.join("steamapps")
    };
    let mut out = Vec::new();
    let workshop = steamapps.join("workshop").join("content").join("431960");
    if workshop.is_dir() {
        out.push(workshop);
    }
    let projects = steamapps
        .join("common")
        .join("wallpaper_engine")
        .join("projects");
    if projects.is_dir() {
        out.extend(projects_roots(&projects));
    }
    out
}

/// 向下最多两层找含 `project.json` 的目录；找到即不再深入。
fn collect_project_dirs(dir: &Path, depth: usize, out: &mut BTreeSet<PathBuf>) {
    if depth > 2 {
        return;
    }
    if has_project(dir) {
        if let Some(normalized) = normalize_local_dir(dir) {
            out.insert(normalized);
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_project_dirs(&path, depth + 1, out);
        }
    }
}

/// 把一个已识别的目录展开成具体壁纸目录列表（已规范化、去重、排序）。
pub fn expand_dir(path: &Path) -> Vec<PathBuf> {
    let Some(dir) = normalize_local_dir(path) else {
        return Vec::new();
    };
    let mut out: BTreeSet<PathBuf> = BTreeSet::new();

    match classify_dir(&dir) {
        RecognizedKind::Wallpaper => {
            out.insert(dir);
        }
        RecognizedKind::Workshop => {
            out.extend(sorted_project_children(&dir));
        }
        RecognizedKind::Projects => {
            out.extend(expand_projects_root(&dir));
        }
        RecognizedKind::Install => {
            for root in projects_roots(&dir) {
                out.extend(sorted_project_children(&root));
            }
        }
        RecognizedKind::SteamLibrary => {
            for root in library_content_roots(&dir) {
                // 创意工坊根 / defaultprojects / myprojects 各自再走一次识别，
                // 避免在这里重复一套「根 → 壁纸」的规则。
                out.extend(expand_dir(&root));
            }
        }
        RecognizedKind::Unknown => {
            collect_project_dirs(&dir, 0, &mut out);
        }
    }

    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kabegame-wpe-recognize-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn wallpaper(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(WPE_PROJECT_FILE), r#"{"type":"video","file":"a.mp4"}"#).unwrap();
        fs::write(dir.join("a.mp4"), b"x").unwrap();
    }

    #[test]
    fn recognizes_single_wallpaper_dir() {
        let root = temp_dir("single");
        wallpaper(&root);
        assert_eq!(classify_dir(&root), RecognizedKind::Wallpaper);
        assert_eq!(expand_dir(&root), vec![normalize_local_dir(&root).unwrap()]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recognizes_workshop_root() {
        let root = temp_dir("workshop");
        let content = root.join("431960");
        wallpaper(&content.join("111"));
        wallpaper(&content.join("222"));
        assert_eq!(classify_dir(&content), RecognizedKind::Workshop);
        assert_eq!(expand_dir(&content).len(), 2);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recognizes_install_and_steam_library() {
        let library = temp_dir("library");
        let install = library
            .join("steamapps")
            .join("common")
            .join("wallpaper_engine");
        fs::create_dir_all(install.join("bin")).unwrap();
        fs::write(install.join("wallpaper64.exe"), b"x").unwrap();
        wallpaper(&install.join("projects").join("defaultprojects").join("beach"));
        wallpaper(&install.join("projects").join("myprojects").join("mine"));
        wallpaper(
            &library
                .join("steamapps")
                .join("workshop")
                .join("content")
                .join("431960")
                .join("333"),
        );

        assert_eq!(classify_dir(&install), RecognizedKind::Install);
        assert_eq!(expand_dir(&install).len(), 2);
        assert_eq!(classify_dir(&library), RecognizedKind::SteamLibrary);
        assert_eq!(expand_dir(&library).len(), 3);
        fs::remove_dir_all(library).ok();
    }

    #[test]
    fn unknown_dir_searches_two_levels() {
        let root = temp_dir("unknown");
        let nested = root.join("a").join("b");
        wallpaper(&nested);
        assert_eq!(classify_dir(&root), RecognizedKind::Unknown);
        assert_eq!(expand_dir(&root).len(), 1);
        fs::remove_dir_all(root).ok();
    }
}
