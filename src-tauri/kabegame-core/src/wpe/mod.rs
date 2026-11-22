//! Wallpaper Engine（WPE）壁纸目录的发现、识别、解析与属性换算。
//!
//! 一个 WPE 壁纸是**目录**而非单个文件：`project.json` 描述类型（`video` / `web` /
//! `scene` / `application`）、入口文件、预览图、标题与标签。Kabegame 把整个目录作为
//! 一行 `images` 记录，`local_path` 存目录绝对路径，`type` 存 `x-wpe/<kind>`。
//!
//! 本模块只做只读解析与目录展开，不写库、不复制或转码用户目录里的任何文件。

// 入库模型与属性解析在所有构建里都要（Storage、Android 的壁纸目标），发现与识别只随 wpe feature 编译。
pub mod dir_hash;
#[cfg(feature = "wpe")]
pub mod discover;
pub mod fps;
#[cfg(feature = "wpe")]
pub mod locale;
pub mod preview_settings;
pub mod project;
pub mod properties;
#[cfg(feature = "wpe")]
pub mod recognize;
#[cfg(feature = "wpe")]
pub mod scan;
#[cfg(feature = "wpe")]
pub mod scene_files;
#[cfg(feature = "wpe")]
pub mod steam;
#[cfg(feature = "wpe")]
pub mod tags;
pub mod user_props;

pub use project::{read_project, WpeKind, WpeProject, WpeSkip, WPE_PROJECT_FILE};

/// 内建「壁纸」导入任务 / 插件 id。
pub const WPE_IMPORT_PLUGIN_ID: &str = "wpe-import";

use std::path::{Path, PathBuf};

/// 把 WPE 目录规范成入库用的 `local_path`：绝对、规范化、无 Windows `\\?\` 前缀、无尾分隔符。
pub fn normalize_local_dir(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_dir() {
        return None;
    }
    let text = canonical.to_string_lossy();
    let trimmed = text.trim_start_matches(r"\\?\");
    let trimmed = trimmed.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// 从图库删除 WPE 壁纸行时，判断它的目录该不该一并回收。
///
/// 目录型 WPE 壁纸的 `local_path` 是用户机器上的真实目录，删除前必须按来源分流：
/// - **创意工坊订阅**与 **WPE 自带工程**：只删库记录，目录留在磁盘上（Steam 管理的内容，
///   删了也会被同步回来，且自带工程属于 WPE 安装内容）；
/// - `myprojects` 与用户手选的任意目录：照常随图片行一起进回收站。
///
/// 受保护的根只在构造时发现一次（要读注册表与 Steam 的 vdf），之后逐行比较只是字符串前缀匹配。
/// 没有 `wpe` feature 的构建（Android / Web）拿不到 Steam 库信息，一律保留目录。
pub struct WpeDeleteGuard {
    /// 受保护根的 `path_key`；`None` = 无法判断，全部保留。
    protected: Option<Vec<String>>,
}

impl WpeDeleteGuard {
    pub fn new() -> Self {
        #[cfg(feature = "wpe")]
        let protected = Some(
            discover::protected_roots()
                .iter()
                .map(|root| dir_key(&root.to_string_lossy()))
                .collect(),
        );
        #[cfg(not(feature = "wpe"))]
        let protected = None;
        Self { protected }
    }

    /// `true` = 这个壁纸目录必须留在磁盘上，只删库记录。
    pub fn must_keep_dir(&self, dir: &str) -> bool {
        let Some(protected) = self.protected.as_ref() else {
            return true;
        };
        let key = dir_key(dir);
        protected
            .iter()
            .any(|root| key == *root || key.starts_with(&format!("{root}/")))
    }
}

impl Default for WpeDeleteGuard {
    fn default() -> Self {
        Self::new()
    }
}

/// 比较用的路径键：统一分隔符与尾分隔符，Windows 上再忽略大小写。
///
/// 不能直接用 `scan::path_key`：那个保留 `\`，而受保护根与 `local_path` 的分隔符不一定一致。
fn dir_key(path: &str) -> String {
    let unified = path.trim().replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    if cfg!(target_os = "windows") {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// 目录内相对路径的安全校验：拒绝绝对路径、盘符、`..` 与空段。
///
/// WPE 的 `file` / `preview` 必须是目录内相对路径；媒体服务按它拼目录并再次做
/// canonicalize 边界校验，这里是第一道门。
///
/// 壁纸内容来自 Windows，规则不随平台变：`\` 一律按分隔符看（Unix 上它本是普通文件名字符），
/// 盘符也单独拒绝（Unix 的 `Path` 不认识盘符）。
pub fn is_safe_relative_path(rel: &str) -> bool {
    let rel = rel.trim();
    if rel.is_empty() {
        return false;
    }
    let normalized = rel.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return false;
    }
    use std::path::Component;
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_reject_traversal_and_absolute() {
        assert!(is_safe_relative_path("Wallpaper-1.mp4"));
        assert!(is_safe_relative_path("video/entry.mp4"));
        assert!(!is_safe_relative_path("../outside.mp4"));
        assert!(!is_safe_relative_path("video/../../outside.mp4"));
        assert!(!is_safe_relative_path(""));
        assert!(!is_safe_relative_path(r"C:\Windows\notepad.exe"));
        assert!(!is_safe_relative_path("C:/Windows/notepad.exe"));
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path(r"\\server\share\a.mp4"));
        assert!(!is_safe_relative_path(r"video\..\..\outside.mp4"));
    }
}
