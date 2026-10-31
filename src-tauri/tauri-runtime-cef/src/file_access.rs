//! 按 webview label 的 `file:` 访问策略：两项能力 + 按发起 frame 分档的闸门。
//!
//! 两项能力都是建 browser 时写进 `extra_info` 的 bool 键，由 CEF 补丁按 browser 开启：
//!
//! 1. **文件文档**（[`ALLOW_FILE_ACCESS_EXTRA_INFO_KEY`]，补丁 `third-patches/cef/0004`）：
//!    以 `file://` 加载的页面可以用 `fetch` / XHR 读其它本地文件（Wallpaper Engine 网页壁纸
//!    就是这么运行的）。Chromium 的 `allow_file_access_from_file_urls` 偏好本身放开的是**任意**
//!    本地文件；
//! 2. **应用页加载本地资源**（[`ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY`]，补丁 0005 + 0006）：最外层主
//!    frame 里的非 `file:` 文档（应用页）可以加载 `file:`：给 `<iframe>` 赋 `src = file:…`（0005），
//!    以及 `<img>` / `<video>` / CSS `url()` 这类子资源（0006 补上 `file:` 子资源工厂）。
//!    应用页 `fetch` / XHR `file:` 还需要私有 CORS 列表与运行时跨源白名单。
//!
//! 补丁只开门，不管哪些文件能进来。带任一能力的 browser 的每个 `file:` 资源请求都按**发起 frame**
//! 分档（`webview.rs` 的 `resource_request_handler`）：
//!
//! | 发起方 | 处理 |
//! | --- | --- |
//! | 应用页主 frame 的子资源（非导航、主 frame，发起方 origin 与 frame 文档都不是 `file:`） | 登记了 0005 即**免检**（[`app_page_open`]；图库媒体走 `file://`） |
//! | 子 frame 导航到 `file:`（给 iframe 赋 `src`）；主 frame 导航到 `file:`（壁纸窗口由 Rust 导航） | 过闸门：按根目录与追加放行 |
//! | `file:` 文档自己的子资源（WPE 页 fetch 同目录、嵌套页；壁纸窗口整窗 `file:` 时的主 frame） | 过闸门：按根目录与追加放行 |
//!
//! 闸门经 [`check_file_request`] 判定，只放行当前根目录或用户追加放行项内的普通文件（拒绝越界、符号链接、
//! 目录、不存在）；没有根目录与追加放行时拒绝。两项能力与根目录并在同一张 label 表里，「进表即开闸门」
//! 由结构保证；免检只是闸门前按发起方的一档分流，不改根目录语义。
//!
//! 运行时只提供机制；哪个窗口开哪项能力、放行哪个目录由应用决定。

use cef::CefString;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

/// 已登记的应用 origin；CEF 白名单在进程内常驻。
static APP_FETCH_ORIGINS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// 让应用 origin 的 `fetch(file:)` 通过 CEF proxy 的跨源闸门。
pub(crate) fn grant_app_fetch_file(origin: &str) -> bool {
    let Ok(mut origins) = APP_FETCH_ORIGINS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
    else {
        return false;
    };
    if origins.contains(origin) {
        return true;
    }
    let added = cef::add_cross_origin_whitelist_entry(
        Some(&CefString::from(origin)),
        Some(&CefString::from("file")),
        None,
        1,
    ) != 0;
    if added {
        origins.insert(origin.to_string());
    }
    added
}

/// 建 browser 时 `extra_info` 里的 bool 键；CEF 补丁 0004 读它打开文件访问偏好。
pub(crate) const ALLOW_FILE_ACCESS_EXTRA_INFO_KEY: &str =
    "kabegame.allow_file_access_from_file_urls";

/// 建 browser 时 `extra_info` 里的 bool 键；CEF 补丁 0005 读它允许应用页加载本地资源
/// （渲染侧 `SecurityOrigin::GrantLoadLocalResources`、浏览器侧 `GrantRequestScheme(file)`）。
/// 键名必须与补丁里的字面量一致。
pub(crate) const ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY: &str = "kabegame.allow_local_resources";

/// 一个 label 的 `file:` 访问策略。
#[derive(Debug, Default)]
struct FilePolicy {
    /// 建窗带 0004 键：`file:` 文档可读本地文件。
    file_documents: bool,
    /// 建窗带 0005 键：应用页可加载 `file:`。
    app_local_resources: bool,
    /// 子 frame 与 `file:` 文档的根目录（`None` = 这类请求全拒）；应用页主 frame 的子资源
    /// 免检时不看它。
    root: Option<PathBuf>,
    /// 追加放行（[`grant_file_documents`]）：只增不减，换根即清空。
    grants: Vec<Grant>,
}

/// 追加放行的一项（已 canonicalize）：文件只放行它本身，目录放行其中的普通文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Grant {
    pub path: PathBuf,
    pub is_dir: bool,
}

/// 闸门裁决用的快照：根目录 + 追加放行。
#[derive(Debug, Clone, Default)]
pub(crate) struct FileAccess {
    pub root: Option<PathBuf>,
    pub grants: Vec<Grant>,
}

/// label → 策略。进表即开闸门。
static FILE_POLICIES: OnceLock<Mutex<HashMap<String, FilePolicy>>> = OnceLock::new();

fn policies() -> &'static Mutex<HashMap<String, FilePolicy>> {
    FILE_POLICIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 建窗前登记 label 的「文件文档」能力（0004）。已登记的保留当前根目录与其它能力不变。
pub(crate) fn allow_file_documents(webview_label: &str) {
    if let Ok(mut map) = policies().lock() {
        map.entry(webview_label.to_string())
            .or_default()
            .file_documents = true;
    }
}

/// 建窗前登记 label 的「应用页加载本地资源」能力（0005）。已登记的保留当前根目录与其它能力不变。
pub(crate) fn allow_app_local_resources(webview_label: &str) {
    if let Ok(mut map) = policies().lock() {
        map.entry(webview_label.to_string())
            .or_default()
            .app_local_resources = true;
    }
}

/// 建 browser 时要写进 `extra_info` 的 bool 键（值都为 true），顺序固定为 0004、0005；
/// 未登记的 label 为空。
pub(crate) fn extra_info_keys(webview_label: &str) -> Vec<&'static str> {
    let Ok(map) = policies().lock() else {
        return Vec::new();
    };
    let Some(policy) = map.get(webview_label) else {
        return Vec::new();
    };
    let mut keys = Vec::with_capacity(2);
    if policy.file_documents {
        keys.push(ALLOW_FILE_ACCESS_EXTRA_INFO_KEY);
    }
    if policy.app_local_resources {
        keys.push(ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY);
    }
    keys
}

/// 设置 / 清空允许的根目录；未登记的 label 返回 Err。
pub(crate) fn set_file_document_root(
    webview_label: &str,
    root: Option<PathBuf>,
) -> Result<(), String> {
    let mut map = policies()
        .lock()
        .map_err(|_| "file document policy mutex poisoned".to_string())?;
    let Some(policy) = map.get_mut(webview_label) else {
        return Err(format!(
            "webview '{webview_label}' 未登记文件访问策略（需在建窗前调用 allow_file_documents / allow_app_local_resources）"
        ));
    };
    policy.root = root;
    policy.grants.clear();
    Ok(())
}

/// 当前页面的根仍匹配时追加用户选的文件或目录，旧页面的在途拉取会被忽略。
pub(crate) fn grant_file_documents(
    webview_label: &str,
    for_root: &Path,
    paths: &[PathBuf],
) -> Result<(), String> {
    let mut map = policies()
        .lock()
        .map_err(|_| "file document policy mutex poisoned".to_string())?;
    let policy = map
        .get_mut(webview_label)
        .ok_or_else(|| format!("webview '{webview_label}' 未登记文件访问策略"))?;
    let Some(current_root) = policy.root.as_deref().and_then(canonical_path) else {
        return Ok(());
    };
    if !canonical_path(for_root).is_some_and(|root| path_key(&current_root) == path_key(&root)) {
        return Ok(());
    }
    for path in paths {
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !(meta.is_file() || meta.is_dir()) {
            continue;
        }
        let Some(path) = canonical_path(path) else {
            continue;
        };
        let grant = Grant {
            path,
            is_dir: meta.is_dir(),
        };
        if !policy.grants.contains(&grant) {
            policy.grants.push(grant);
        }
    }
    Ok(())
}

/// label 是否登记过任一能力，即它的 `file:` 请求是否要过闸门。
pub(crate) fn is_file_document_webview(webview_label: &str) -> bool {
    policies()
        .lock()
        .map(|map| map.contains_key(webview_label))
        .unwrap_or(false)
}

/// label 的应用页（最外层主 frame 的非 `file:` 文档）发起的 `file:` 子资源是否免检：登记了 0005 即免检。
/// 子 frame 导航与 `file:` 文档的请求不受此影响，仍按根目录裁决。
pub(crate) fn app_page_open(webview_label: &str) -> bool {
    policies()
        .lock()
        .map(|map| {
            map.get(webview_label)
                .is_some_and(|policy| policy.app_local_resources)
        })
        .unwrap_or(false)
}

/// label 当前的根目录与追加放行；未登记返回 `None`。
pub(crate) fn file_document_access(webview_label: &str) -> Option<FileAccess> {
    policies().lock().ok().and_then(|map| {
        map.get(webview_label).map(|policy| FileAccess {
            root: policy.root.clone(),
            grants: policy.grants.clone(),
        })
    })
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
    /// 当前没有允许的根目录或追加放行。
    NoRoot,
    /// URL 不是合法的本地 `file:` 地址。
    InvalidUrl,
    /// 目标不存在或不可读元数据。
    NotFound,
    /// 目标是符号链接。
    Symlink,
    /// 目标不是普通文件（目录等）。
    NotFile,
    /// 规范化后位于根目录与追加放行之外。
    OutsideRoot,
}

/// `file:` 资源请求判定：只放行根目录或追加放行项内的普通文件，返回其规范化路径。
///
/// - URL → 本地路径用 `url::Url::to_file_path`（百分号解码；查询串与片段不参与）；
/// - `symlink_metadata` 必须是普通文件（符号链接、目录、不存在一律拒绝）；
/// - 目标与根目录都 `canonicalize`（解析 `..` 与中间层链接），去掉 Windows `\\?\` 前缀，
///   按路径比较键（Windows 大小写不敏感）判定目标位于根目录之内。
pub(crate) fn check_file_request(url: &str, access: &FileAccess) -> Result<PathBuf, FileDeny> {
    if access.root.is_none() && access.grants.is_empty() {
        return Err(FileDeny::NoRoot);
    }
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
    let root_allowed = access
        .root
        .as_deref()
        .and_then(canonical_path)
        .is_some_and(|root| is_inside(&target, &root));
    let grant_allowed = access.grants.iter().any(|grant| {
        if grant.is_dir {
            is_inside(&target, &grant.path)
        } else {
            path_key(&target) == path_key(&grant.path)
        }
    });
    if !root_allowed && !grant_allowed {
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
    let separator = if cfg!(target_os = "windows") {
        '\\'
    } else {
        '/'
    };
    target.len() > root.len()
        && target.starts_with(&root)
        && target[root.len()..].starts_with(separator)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_file_request(url: &str, root: Option<&Path>) -> Result<PathBuf, FileDeny> {
        super::check_file_request(
            url,
            &FileAccess {
                root: root.map(Path::to_path_buf),
                grants: Vec::new(),
            },
        )
    }

    fn file_document_root(label: &str) -> Option<PathBuf> {
        file_document_access(label).and_then(|access| access.root)
    }

    #[test]
    fn grant_app_fetch_file_dedups() {
        let origin = "http://file-access-test.invalid";
        APP_FETCH_ORIGINS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap()
            .insert(origin.into());
        assert!(grant_app_fetch_file(origin));
    }
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
        assert!(
            url.contains("%20"),
            "fixture url should be percent-encoded: {url}"
        );
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

    #[test]
    fn extra_info_keys_follow_registration() {
        // 未登记：不写键、不开闸门
        let none = "file-access-test-keys-none";
        assert!(extra_info_keys(none).is_empty());
        assert!(!is_file_document_webview(none));

        // 只登记 0005：写 0005 键，同样开闸门、可设根目录
        let local = "file-access-test-keys-local";
        allow_app_local_resources(local);
        assert_eq!(
            extra_info_keys(local),
            vec![ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY]
        );
        assert!(is_file_document_webview(local));
        set_file_document_root(local, Some(PathBuf::from("/tmp/local"))).unwrap();
        assert_eq!(file_document_root(local), Some(PathBuf::from("/tmp/local")));

        // 两项都登记：顺序固定为 0004、0005，与登记先后无关
        let both = "file-access-test-keys-both";
        allow_app_local_resources(both);
        allow_file_documents(both);
        assert_eq!(
            extra_info_keys(both),
            vec![
                ALLOW_FILE_ACCESS_EXTRA_INFO_KEY,
                ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY
            ]
        );

        // 已有根目录时再登记任一能力，不清根目录
        set_file_document_root(both, Some(PathBuf::from("/tmp/both"))).unwrap();
        allow_file_documents(both);
        allow_app_local_resources(both);
        assert_eq!(file_document_root(both), Some(PathBuf::from("/tmp/both")));
        assert_eq!(extra_info_keys(both).len(), 2);
    }

    #[test]
    fn app_page_open_follows_registration() {
        // 未登记：不免检
        let none = "file-access-test-open-none";
        assert!(!app_page_open(none));

        // 只登记 0004：开闸门，但应用页子资源不免检
        let docs = "file-access-test-open-docs";
        allow_file_documents(docs);
        assert!(is_file_document_webview(docs));
        assert!(!app_page_open(docs));

        // 登记 0005：免检，与根目录的设 / 清无关
        let local = "file-access-test-open-local";
        allow_app_local_resources(local);
        assert!(app_page_open(local));
        set_file_document_root(local, Some(PathBuf::from("/tmp/open"))).unwrap();
        assert!(app_page_open(local));
        set_file_document_root(local, None).unwrap();
        assert!(app_page_open(local));

        // 已登记 0004 再补登 0005：免检，根目录不受影响
        set_file_document_root(docs, Some(PathBuf::from("/tmp/docs"))).unwrap();
        allow_app_local_resources(docs);
        assert!(app_page_open(docs));
        assert_eq!(file_document_root(docs), Some(PathBuf::from("/tmp/docs")));
    }

    #[test]
    fn file_and_directory_grants_are_scoped_and_reset() {
        let (base, wp, sibling) = fixture("grants");
        let label = "file-access-test-grants";
        allow_file_documents(label);
        set_file_document_root(label, Some(wp.clone())).unwrap();
        let file = sibling.join("project.json");
        let other = sibling.join("other.txt");
        fs::write(&other, "other").unwrap();
        grant_file_documents(label, &base.join("wrong"), &[file.clone()]).unwrap();
        assert!(file_document_access(label).unwrap().grants.is_empty());
        grant_file_documents(label, &wp, &[file.clone()]).unwrap();
        grant_file_documents(label, &wp, &[file.clone()]).unwrap();
        let access = file_document_access(label).unwrap();
        assert_eq!(access.grants.len(), 1);
        assert!(super::check_file_request(&file_url(&file), &access).is_ok());
        assert_eq!(
            super::check_file_request(&file_url(&other), &access),
            Err(FileDeny::OutsideRoot)
        );
        grant_file_documents(label, &wp, &[sibling.clone()]).unwrap();
        assert!(super::check_file_request(
            &file_url(&other),
            &file_document_access(label).unwrap()
        )
        .is_ok());
        assert_eq!(
            super::check_file_request(
                &file_url(&base.join("outside.txt")),
                &file_document_access(label).unwrap()
            ),
            Err(FileDeny::OutsideRoot)
        );
        set_file_document_root(label, None).unwrap();
        assert!(file_document_access(label).unwrap().grants.is_empty());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn grant_without_root_works() {
        let (base, wp, _) = fixture("grant-no-root");
        // Grant 只经 grant_file_documents 创建，路径都是 canonical_path（Windows 已去掉 `\\?\`）
        let access = FileAccess {
            root: None,
            grants: vec![Grant {
                path: canonical_path(&wp.join("index.html")).unwrap(),
                is_dir: false,
            }],
        };
        assert!(super::check_file_request(&file_url(&wp.join("index.html")), &access).is_ok());
        assert_eq!(
            super::check_file_request(&file_url(&wp.join("data.json")), &access),
            Err(FileDeny::OutsideRoot)
        );
        let _ = fs::remove_dir_all(base);
    }
}
