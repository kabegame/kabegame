//! 按 webview label 的 `file://` 文档策略。
//!
//! 某些窗口需要以 `file://` 加载一个本地目录里的页面，并允许页面用 `fetch` / XHR
//! 读同目录的其它文件（Wallpaper Engine 网页壁纸就是这么运行的）。Chromium 的
//! `allow_file_access_from_file_urls` 偏好能做到这一点，但它同时放开了**任意**本地文件。
//! 这里把边界拆成两层，都只作用于登记过的 label：
//!
//! 1. 建 browser 时在 `extra_info` 里带 [`ALLOW_FILE_ACCESS_EXTRA_INFO_KEY`]，CEF 补丁
//!    `third-patches/cef/0004` 据此只给这个 browser 打开偏好；
//! 2. 该 browser 的每个 `file:` 资源请求都经 [`check_file_request`] 判定，只放行当前允许
//!    根目录内的普通文件（拒绝越界、符号链接、目录、不存在）；没有根目录时一律拒绝。
//!
//! 运行时只提供机制；哪个窗口、哪个目录由应用决定。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

/// 建 browser 时 `extra_info` 里的 bool 键；CEF 补丁 0004 读它打开文件访问偏好。
pub(crate) const ALLOW_FILE_ACCESS_EXTRA_INFO_KEY: &str =
    "kabegame.allow_file_access_from_file_urls";

/// label → 当前允许的根目录（`None` = 拒绝所有 `file:` 请求）。
static FILE_DOCUMENT_POLICIES: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> =
    OnceLock::new();

fn policies() -> &'static Mutex<HashMap<String, Option<PathBuf>>> {
    FILE_DOCUMENT_POLICIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 建窗前登记 label。已登记的保留当前根目录不变。
pub(crate) fn allow_file_documents(webview_label: &str) {
    if let Ok(mut map) = policies().lock() {
        map.entry(webview_label.to_string()).or_insert(None);
    }
}

/// 设置 / 清空允许的根目录；未登记的 label 返回 Err。
pub(crate) fn set_file_document_root(
    webview_label: &str,
    root: Option<PathBuf>,
) -> Result<(), String> {
    let mut map = policies()
        .lock()
        .map_err(|_| "file document policy mutex poisoned".to_string())?;
    let Some(slot) = map.get_mut(webview_label) else {
        return Err(format!(
            "webview '{webview_label}' 未登记文件文档策略（需在建窗前调用 allow_file_documents）"
        ));
    };
    *slot = root;
    Ok(())
}

/// label 是否登记过文件文档策略。
pub(crate) fn is_file_document_webview(webview_label: &str) -> bool {
    policies()
        .lock()
        .map(|map| map.contains_key(webview_label))
        .unwrap_or(false)
}

/// label 当前允许的根目录；未登记或未设置都是 `None`。
pub(crate) fn file_document_root(webview_label: &str) -> Option<PathBuf> {
    policies()
        .lock()
        .ok()
        .and_then(|map| map.get(webview_label).cloned().flatten())
}

/// URL 是否为 `file:` scheme（大小写不敏感，不解析其余部分）。
pub(crate) fn is_file_url(url: &str) -> bool {
    url.trim_start()
        .split_once(':')
        .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("file"))
}

/// 拒绝原因（写进日志）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FileDeny {
    /// 当前没有允许的根目录。
    NoRoot,
    /// URL 不是合法的本地 `file:` 地址。
    InvalidUrl,
    /// 目标不存在或不可读元数据。
    NotFound,
    /// 目标是符号链接。
    Symlink,
    /// 目标不是普通文件（目录等）。
    NotFile,
    /// 规范化后位于根目录之外。
    OutsideRoot,
}

/// `file:` 资源请求判定：只放行 `root` 内的普通文件，返回其规范化路径。
///
/// - URL → 本地路径用 `url::Url::to_file_path`（百分号解码；查询串与片段不参与）；
/// - `symlink_metadata` 必须是普通文件（符号链接、目录、不存在一律拒绝）；
/// - 目标与根目录都 `canonicalize`（解析 `..` 与中间层链接），去掉 Windows `\\?\` 前缀，
///   按路径比较键（Windows 大小写不敏感）判定目标位于根目录之内。
pub(crate) fn check_file_request(url: &str, root: Option<&Path>) -> Result<PathBuf, FileDeny> {
    let Some(root) = root else {
        return Err(FileDeny::NoRoot);
    };
    let parsed = url::Url::parse(url).map_err(|_| FileDeny::InvalidUrl)?;
    if parsed.scheme() != "file" {
        return Err(FileDeny::InvalidUrl);
    }
    let path = parsed.to_file_path().map_err(|_| FileDeny::InvalidUrl)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|_| FileDeny::NotFound)?;
    if meta.file_type().is_symlink() {
        return Err(FileDeny::Symlink);
    }
    if !meta.is_file() {
        return Err(FileDeny::NotFile);
    }
    let target = canonical_path(&path).ok_or(FileDeny::NotFound)?;
    let root = canonical_path(root).ok_or(FileDeny::OutsideRoot)?;
    if !is_inside(&target, &root) {
        return Err(FileDeny::OutsideRoot);
    }
    Ok(target)
}

/// `canonicalize` 并去掉 Windows 的 `\\?\` 前缀。
fn canonical_path(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => Some(PathBuf::from(format!(r"\\{rest}"))),
        None => Some(PathBuf::from(text.trim_start_matches(r"\\?\"))),
    }
}

/// 路径比较键：Windows 大小写不敏感、统一分隔符，其余平台原样；去掉尾分隔符。
fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(target_os = "windows") {
        text.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    } else {
        text.trim_end_matches('/').to_string()
    }
}

/// `target` 严格位于 `root` 之内（等于根目录本身不算——根是目录，普通文件不会等于它）。
fn is_inside(target: &Path, root: &Path) -> bool {
    let target = path_key(target);
    let root = path_key(root);
    let separator = if cfg!(target_os = "windows") { '\\' } else { '/' };
    target.len() > root.len()
        && target.starts_with(&root)
        && target[root.len()..].starts_with(separator)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 临时目录：`<tmp>/kabegame-file-access-<name>-<pid>/{wp,sibling}`。
    fn fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "kabegame-file-access-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let wp = base.join("wp");
        let sibling = base.join("sibling");
        fs::create_dir_all(wp.join("sub dir")).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(wp.join("index.html"), "<html></html>").unwrap();
        fs::write(wp.join("data.json"), "{}").unwrap();
        fs::write(wp.join("sub dir").join("歌 词.txt"), "lyrics").unwrap();
        fs::write(sibling.join("project.json"), "{}").unwrap();
        fs::write(base.join("outside.txt"), "secret").unwrap();
        (base, wp, sibling)
    }

    fn file_url(path: &Path) -> String {
        url::Url::from_file_path(path).unwrap().to_string()
    }

    #[test]
    fn allows_regular_file_inside_root() {
        let (base, wp, _) = fixture("allow");
        let url = file_url(&wp.join("data.json"));
        assert!(check_file_request(&url, Some(&wp)).is_ok());
        // 查询串与片段不影响判定
        assert!(check_file_request(&format!("{url}?v=1#x"), Some(&wp)).is_ok());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn decodes_percent_encoded_paths() {
        let (base, wp, _) = fixture("percent");
        let url = file_url(&wp.join("sub dir").join("歌 词.txt"));
        assert!(url.contains("%20"), "fixture url should be percent-encoded: {url}");
        assert!(check_file_request(&url, Some(&wp)).is_ok());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_parent_traversal() {
        let (base, wp, _) = fixture("traversal");
        let url = format!("{}/../outside.txt", file_url(&wp));
        assert_eq!(
            check_file_request(&url, Some(&wp)),
            Err(FileDeny::OutsideRoot)
        );
        // 编码过的 `..` 段同样被归一化后拒绝
        let encoded = format!("{}/%2e%2e/outside.txt", file_url(&wp));
        assert_eq!(
            check_file_request(&encoded, Some(&wp)),
            Err(FileDeny::OutsideRoot)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_sibling_wallpaper_directory() {
        let (base, wp, sibling) = fixture("sibling");
        let url = file_url(&sibling.join("project.json"));
        assert_eq!(
            check_file_request(&url, Some(&wp)),
            Err(FileDeny::OutsideRoot)
        );
        // 前缀相同但不是子目录：`wp` 与 `wp2`
        let wp2 = base.join("wp2");
        fs::create_dir_all(&wp2).unwrap();
        fs::write(wp2.join("a.txt"), "x").unwrap();
        assert_eq!(
            check_file_request(&file_url(&wp2.join("a.txt")), Some(&wp)),
            Err(FileDeny::OutsideRoot)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_directory_and_missing() {
        let (base, wp, _) = fixture("dir");
        assert_eq!(
            check_file_request(&file_url(&wp), Some(&wp)),
            Err(FileDeny::NotFile)
        );
        assert_eq!(
            check_file_request(&file_url(&wp.join("sub dir")), Some(&wp)),
            Err(FileDeny::NotFile)
        );
        assert_eq!(
            check_file_request(&file_url(&wp.join("missing.js")), Some(&wp)),
            Err(FileDeny::NotFound)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_everything_without_root() {
        let (base, wp, _) = fixture("noroot");
        assert_eq!(
            check_file_request(&file_url(&wp.join("index.html")), None),
            Err(FileDeny::NoRoot)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_non_file_urls() {
        let (base, wp, _) = fixture("scheme");
        assert_eq!(
            check_file_request("http://localhost/index.html", Some(&wp)),
            Err(FileDeny::InvalidUrl)
        );
        assert_eq!(
            check_file_request("not a url", Some(&wp)),
            Err(FileDeny::InvalidUrl)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_symlink_when_platform_allows_creating_one() {
        let (base, wp, _) = fixture("symlink");
        let link = wp.join("link.txt");
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(base.join("outside.txt"), &link).is_ok();
        // Windows 建符号链接需要开发者模式或管理员权限，建不了就跳过这条断言。
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(base.join("outside.txt"), &link).is_ok();
        if created {
            assert_eq!(
                check_file_request(&file_url(&link), Some(&wp)),
                Err(FileDeny::Symlink)
            );
        }
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn file_scheme_detection() {
        assert!(is_file_url("file:///C:/a.html"));
        assert!(is_file_url("FILE:///tmp/a"));
        assert!(!is_file_url("http://localhost/"));
        assert!(!is_file_url("filesystem:http://x/"));
        assert!(!is_file_url(""));
    }

    #[test]
    fn policy_registry_requires_registration() {
        let label = "file-access-test-label";
        assert!(set_file_document_root(label, None).is_err());
        allow_file_documents(label);
        assert!(is_file_document_webview(label));
        assert_eq!(file_document_root(label), None);
        set_file_document_root(label, Some(PathBuf::from("/tmp/x"))).unwrap();
        assert_eq!(file_document_root(label), Some(PathBuf::from("/tmp/x")));
        // 再次登记不清空根目录
        allow_file_documents(label);
        assert_eq!(file_document_root(label), Some(PathBuf::from("/tmp/x")));
        set_file_document_root(label, None).unwrap();
        assert_eq!(file_document_root(label), None);
    }
}
