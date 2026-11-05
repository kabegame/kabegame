//! 把目录展开成 WPE 壁纸目录集合。
//!
//! 用户手选的目录与自动发现的根走同一条规则：只看目录自身、`<dir>/*`、`<dir>/*/*`，含 `project.json`
//! 就收下且不再深入，到第二层仍没有就停。不按目录名或结构猜类型，所以 Steam 库根、WPE 安装根这类
//! 壁纸在三层以下的目录识别不到，它们由自动发现（`discover`）覆盖。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::{normalize_local_dir, WPE_PROJECT_FILE};

/// 向下展开的最大层数。
const MAX_DEPTH: usize = 2;

fn has_project(dir: &Path) -> bool {
    dir.join(WPE_PROJECT_FILE).is_file()
}

fn collect_project_dirs(dir: &Path, depth: usize, out: &mut BTreeSet<PathBuf>) {
    if has_project(dir) {
        if let Some(normalized) = normalize_local_dir(dir) {
            out.insert(normalized);
        }
        return;
    }
    if depth >= MAX_DEPTH {
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

/// 展开成具体壁纸目录列表（已规范化、去重、排序）。
pub fn expand_dir(path: &Path) -> Vec<PathBuf> {
    let Some(dir) = normalize_local_dir(path) else {
        return Vec::new();
    };
    let mut out = BTreeSet::new();
    collect_project_dirs(&dir, 0, &mut out);
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
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"type":"video","file":"a.mp4"}"#,
        )
        .unwrap();
        fs::write(dir.join("a.mp4"), b"x").unwrap();
    }

    #[test]
    fn selected_wallpaper_dir_is_itself() {
        let root = temp_dir("single");
        wallpaper(&root);
        assert_eq!(expand_dir(&root), vec![normalize_local_dir(&root).unwrap()]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn finds_first_and_second_level() {
        let root = temp_dir("levels");
        wallpaper(&root.join("a"));
        wallpaper(&root.join("group").join("b"));
        assert_eq!(expand_dir(&root).len(), 2);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stops_below_second_level() {
        let root = temp_dir("deep");
        wallpaper(&root.join("a").join("b").join("c"));
        assert!(expand_dir(&root).is_empty());
        fs::remove_dir_all(root).ok();
    }

    /// 手选 Steam 库根：工坊在第 5 层、官方项目在第 6 层，都超过两层。
    #[test]
    fn steam_library_root_is_not_recognized() {
        let library = temp_dir("library");
        let steamapps = library.join("steamapps");
        wallpaper(
            &steamapps
                .join("workshop")
                .join("content")
                .join("431960")
                .join("333"),
        );
        wallpaper(
            &steamapps
                .join("common")
                .join("wallpaper_engine")
                .join("projects")
                .join("defaultprojects")
                .join("beach"),
        );
        assert!(expand_dir(&library).is_empty());
        fs::remove_dir_all(library).ok();
    }

    #[test]
    fn nested_project_inside_wallpaper_is_ignored() {
        let root = temp_dir("nested");
        wallpaper(&root.join("a"));
        wallpaper(&root.join("a").join("inner"));
        assert_eq!(
            expand_dir(&root),
            vec![normalize_local_dir(&root.join("a")).unwrap()]
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn wallpapers_mixed_with_plain_dirs() {
        let root = temp_dir("mixed");
        wallpaper(&root.join("111"));
        fs::create_dir_all(root.join("notes")).unwrap();
        wallpaper(&root.join("collection").join("222"));
        assert_eq!(expand_dir(&root).len(), 2);
        fs::remove_dir_all(root).ok();
    }

    /// 自动发现的 `projects/defaultprojects` 这类根与手选 `projects/` 都能展开。
    #[test]
    fn projects_dir_is_within_two_levels() {
        let root = temp_dir("projects");
        let projects = root.join("projects");
        wallpaper(&projects.join("defaultprojects").join("beach"));
        wallpaper(&projects.join("myprojects").join("mine"));
        assert_eq!(expand_dir(&projects).len(), 2);
        assert_eq!(expand_dir(&projects.join("defaultprojects")).len(), 1);
        fs::remove_dir_all(root).ok();
    }
}
