//! `file:` 访问策略：按 webview label 登记的两项能力 + 按发起 frame 分档的闸门 + 由应用推出的访问范围。
//!
//! 两项能力都是建 browser 时写进 `extra_info` 的 bool 键，由 CEF 补丁按 browser 开启：
//!
//! 1. **文件文档**（[`ALLOW_FILE_ACCESS_EXTRA_INFO_KEY`]，补丁 `third-patches/cef/0004`）：
//!    以 `file://` 加载的页面可以用 `fetch` / XHR 读其它本地文件（Wallpaper Engine 网页壁纸
//!    就是这么运行的）。Chromium 的 `allow_file_access_from_file_urls` 偏好本身放开的是**任意**
//!    本地文件；
//! 2. **应用页加载本地资源**（[`ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY`]，补丁 05 + 0006）：最外层主
//!    frame 里的非 `file:` 文档（应用页）可以加载 `file:`：给 `<iframe>` 赋 `src = file:…`（0005），
//!    以及 `<img>` / `<video>` / CSS `url()` 这类子资源（0006 补上 `file:` 子资源工厂）。
//!    应用页 `fetch` / XHR `file:` 还需要私有 CORS 列表与运行时跨源白名单。
//!
//! 补丁只开门，不管哪些文件能进来。带任一能力的 browser 的每个 `file:` 资源请求都按**发起方**分档
//! （`webview.rs` 的 `resource_request_handler` 调 [`classify_file_requester`]）：
//!
//! | 发起方 | 处理 |
//! | --- | --- |
//! | 应用页主 frame 的子资源（非导航、主 frame，发起方 origin 与 0007 文档头都不是 `file:`） | 登记了 0005 即**免检**（[`app_page_open`]；图库媒体走 `file://`） |
//! | `file:` 文档自己的请求（子资源、自身导航、它嵌的新 iframe） | 只能访问**它自己所在**的网页壁纸：解析器按文档路径给出的范围 |
//! | 应用页发起的子 frame 导航（给 iframe 赋 `src`） | 目标须落进库里**某个**网页壁纸目录：解析器按目标路径给出的范围 |
//! | 主 frame 导航到 `file:`、无法归属的请求 | 拒绝 |
//!
//! 访问范围（[`FileAccessScope`]：壁纸目录 + 用户为它选的文件 / 目录）不在运行时里存，而是每次请求时由应用
//! 注册的解析器（[`set_file_scope_resolver`]）现算：给定一个本地路径，返回包含它的网页壁纸的范围。解析器
//! 注册之前一律拒绝。判定经 [`check_file_request`]，只放行范围内的普通文件（拒绝越界、符号链接、目录、
//! 不存在）。运行时只提供机制；哪个窗口开哪项能力、库里有哪些壁纸由应用决定。
//!

use cef::CefString;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock},
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

/// 建 browser 时 `extra_info` 里的 bool 键；CEF 补丁 04 读它打开文件访问偏好。
pub(crate) const ALLOW_FILE_ACCESS_EXTRA_INFO_KEY: &str =
    "kabegame.allow_file_access_from_file_urls";

/// 建 browser 时 `extra_info` 里的 bool 键；CEF 补丁 05 读它允许应用页加载本地资源
/// （渲染侧 `SecurityOrigin::GrantLoadLocalResources`、浏览器侧 `GrantRequestScheme(file)`）。
/// 键名必须与补丁里的字面量一致。
pub(crate) const ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY: &str = "kabegame.allow_local_resources";

/// 一个 label 登记的能力。只有开关，不存目录：访问范围由解析器现算。
#[derive(Debug, Default, Clone, Copy)]
struct FileCapabilities {
    /// 建窗带 0004 键：`file:` 文档可读本地文件。
    file_documents: bool,
    /// 建窗带 0005 键：应用页可加载 `file:`。
    app_local_resources: bool,
}

/// label → 能力。进表即开闸门。
static FILE_CAPABILITIES: OnceLock<Mutex<HashMap<String, FileCapabilities>>> = OnceLock::new();

fn capabilities() -> &'static Mutex<HashMap<String, FileCapabilities>> {
    FILE_CAPABILITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 建窗前登记 label 的「文件文档」能力（0004）。已登记的保留其它能力不变。
pub(crate) fn allow_file_documents(webview_label: &str) {
    if let Ok(mut map) = capabilities().lock() {
        map.entry(webview_label.to_string())
            .or_default()
            .file_documents = true;
    }
}

/// 建窗前登记 label 的「应用页加载本地资源」能力（0005）。已登记的保留其它能力不变。
pub(crate) fn allow_app_local_resources(webview_label: &str) {
    if let Ok(mut map) = capabilities().lock() {
        map.entry(webview_label.to_string())
            .or_default()
            .app_local_resources = true;
    }
}

/// 建 browser 时要写进 `extra_info` 的 bool 键（值都为 true），顺序固定为 0004、0005；
/// 未登记的 label 为空。
pub(crate) fn extra_info_keys(webview_label: &str) -> Vec<&'static str> {
    let Ok(map) = capabilities().lock() else {
        return Vec::new();
    };
    let Some(caps) = map.get(webview_label) else {
        return Vec::new();
    };
    let mut keys = Vec::with_capacity(2);
    if caps.file_documents {
        keys.push(ALLOW_FILE_ACCESS_EXTRA_INFO_KEY);
    }
    if caps.app_local_resources {
        keys.push(ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY);
    }
    keys
}

/// label 是否登记过任一能力，即它的 `file:` 请求是否要过闸门。
pub(crate) fn is_file_document_webview(webview_label: &str) -> bool {
    capabilities()
        .lock()
        .map(|map| map.contains_key(webview_label))
        .unwrap_or(false)
}

/// label 的应用页（最外层主 frame 的非 `file:` 文档）发起的 `file:` 子资源是否免检：登记了 0005 即免检。
/// 子 frame 导航与 `file:` 文档的请求不受此影响，仍按解析器给出的范围裁决。
pub(crate) fn app_page_open(webview_label: &str) -> bool {
    capabilities()
        .lock()
        .map(|map| {
            map.get(webview_label)
                .is_some_and(|caps| caps.app_local_resources)
        })
        .unwrap_or(false)
}

/// 放行的一项（已 canonicalize、去掉 Windows `\\?\` 前缀）：文件只放行它本身，目录放行其中的普通文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileGrant {
    pub path: PathBuf,
    pub is_dir: bool,
}

impl FileGrant {
    /// 由用户选的路径建一项放行：必须存在、不是符号链接，且与 `is_dir` 一致（文件 / 目录）；
    /// 路径规范化成与闸门比较时同一形式。不满足返回 None。
    pub fn new(path: &Path, is_dir: bool) -> Option<Self> {
        let meta = std::fs::symlink_metadata(path).ok()?;
        if meta.file_type().is_symlink()
            || meta.is_dir() != is_dir
            || !(meta.is_file() || meta.is_dir())
        {
            return None;
        }
        Some(Self {
            path: canonical_path(path)?,
            is_dir,
        })
    }
}

/// 一张网页壁纸能访问的范围：壁纸目录（`root`）+ 用户为它选的文件 / 目录（`grants`）。
/// 默认值（无根、无放行）拒绝一切。
#[derive(Debug, Clone, Default)]
pub struct FileAccessScope {
    pub root: Option<PathBuf>,
    pub grants: Vec<FileGrant>,
}

/// 应用注册的访问范围解析器：给定本地路径，返回包含它的网页壁纸的范围；不在任何网页壁纸里返回 None。
pub type FileScopeResolver = Arc<dyn Fn(&Path) -> Option<FileAccessScope> + Send + Sync>;

static FILE_SCOPE_RESOLVER: RwLock<Option<FileScopeResolver>> = RwLock::new(None);

/// 注册（或替换）访问范围解析器。应用启动时注册一次；注册之前所有要过闸门的 `file:` 请求都被拒绝。
/// 解析器在 CEF IO 线程上同步调用，不能阻塞（只读内存表，不碰数据库）。
pub fn set_file_scope_resolver(resolver: FileScopeResolver) {
    if let Ok(mut slot) = FILE_SCOPE_RESOLVER.write() {
        *slot = Some(resolver);
    }
}

fn resolve_file_scope(path: &Path) -> Option<FileAccessScope> {
    let resolver = FILE_SCOPE_RESOLVER.read().ok()?.clone()?;
    resolver(path)
}

/// 路径的比较键：与闸门同一套规范化（`canonicalize`、去 Windows `\\?\` 前缀、Windows 不分大小写、
/// 去尾分隔符）。应用拿它给目录建索引，保证与闸门对同一路径算出的键相同。路径不存在返回 None。
pub fn file_path_key(path: &Path) -> Option<String> {
    canonical_path(path).map(|path| path_key(&path))
}

/// 发起一个 `file:` 请求的一方，决定按哪个路径去解析访问范围。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FileRequester {
    /// `file:` 文档：只能访问它自己所在的网页壁纸（按文档路径解析）。
    Document(PathBuf),
    /// 应用页发起的子 frame 导航：目标须落进库里某个网页壁纸目录
    /// （按目标路径解析，只看壁纸目录）。
    Target,
    /// 无法归属（主 frame 导航到 `file:` 等）：拒绝。
    Deny,
}

/// `file:` URL 对应的本地路径；不是合法的本地 `file:` 地址返回 None。
fn file_url_path(url: &str) -> Option<PathBuf> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    parsed.to_file_path().ok()
}

/// 根据 CEF 补丁 07 的文档头和父文档头识别发起方；无法归属时拒绝。
pub(crate) fn classify_file_requester(
    frame_is_main: bool,
    is_navigation: bool,
    document_url: Option<&str>,
    parent_document_url: Option<&str>,
) -> FileRequester {
    if let Some(doc) = document_url.and_then(file_url_path) {
        return FileRequester::Document(doc);
    }
    let parent = parent_document_url.filter(|url| !url.is_empty());
    if is_navigation {
        if frame_is_main {
            return FileRequester::Deny;
        }
        return match parent {
            Some(url) if is_file_url(url) => {
                file_url_path(url).map_or(FileRequester::Deny, FileRequester::Document)
            }
            Some(_) => FileRequester::Target,
            None => FileRequester::Deny,
        };
    }
    if document_url.is_some_and(inherits_parent_document) {
        if let Some(parent) = parent.and_then(file_url_path) {
            return FileRequester::Document(parent);
        }
    }
    FileRequester::Deny
}

/// 空文档与 srcdoc 的内容继承父文档范围。
fn inherits_parent_document(url: &str) -> bool {
    url.eq_ignore_ascii_case("about:blank") || url.eq_ignore_ascii_case("about:srcdoc")
}

/// 按发起方取访问范围：文档按文档路径；目标按目标路径，且只认壁纸目录、不带用户选择（应用页不该读到某张壁纸的用户选择）。
pub(crate) fn scope_for_request(
    requester: &FileRequester,
    url: &str,
    resolver: &dyn Fn(&Path) -> Option<FileAccessScope>,
) -> Option<FileAccessScope> {
    match requester {
        FileRequester::Document(doc) => resolver(doc),
        FileRequester::Target => {
            let target = file_url_path(url)?;
            resolver(&target).map(|scope| FileAccessScope {
                root: scope.root,
                grants: Vec::new(),
            })
        }
        FileRequester::Deny => None,
    }
}

/// [`scope_for_request`] 用已注册的解析器。
pub(crate) fn registered_scope_for_request(
    requester: &FileRequester,
    url: &str,
) -> Option<FileAccessScope> {
    scope_for_request(requester, url, &resolve_file_scope)
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
    /// 没有访问范围（不在库内网页壁纸里、发起方无法归属或解析器未注册）。
    NoRoot,
    /// URL 不是合法的本地 `file:` 地址。
    InvalidUrl,
    /// 目标不存在或不可读元数据。
    NotFound,
    /// 目标是符号链接。
    Symlink,
    /// 目标不是普通文件（目录等）。
    NotFile,
    /// 规范化后位于根目录与放行项之外。
    OutsideRoot,
}

/// `file:` 资源请求判定：只放行范围内（根目录或放行项）的普通文件，返回其规范化路径。
///
/// - URL → 本地路径用 `url::Url::to_file_path`（百分号解码；查询串与片段不参与）；
/// - `symlink_metadata` 必须是普通文件（符号链接、目录、不存在一律拒绝）；
/// - 目标与根目录都 `canonicalize`（解析 `..` 与中间层链接），去掉 Windows `\\?\` 前缀，
///   按路径比较键（Windows 大小写不敏感）判定目标位于根目录之内。
pub(crate) fn check_file_request(url: &str, access: &FileAccessScope) -> Result<PathBuf, FileDeny> {
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
            &FileAccessScope {
                root: root.map(Path::to_path_buf),
                grants: Vec::new(),
            },
        )
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
            // 符号链接也不能作为放行项
            assert!(FileGrant::new(&link, false).is_none());
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
    fn capability_registry_drives_keys_and_exemption() {
        // 未登记：不写键、不开闸门、不免检
        let none = "file-access-test-keys-none";
        assert!(extra_info_keys(none).is_empty());
        assert!(!is_file_document_webview(none));
        assert!(!app_page_open(none));

        // 只登记 0004：开闸门，但应用页子资源不免检
        let docs = "file-access-test-keys-docs";
        allow_file_documents(docs);
        assert_eq!(
            extra_info_keys(docs),
            vec![ALLOW_FILE_ACCESS_EXTRA_INFO_KEY]
        );
        assert!(is_file_document_webview(docs));
        assert!(!app_page_open(docs));

        // 只登记 0005：写 0005 键，同样开闸门，应用页子资源免检
        let local = "file-access-test-keys-local";
        allow_app_local_resources(local);
        assert_eq!(
            extra_info_keys(local),
            vec![ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY]
        );
        assert!(is_file_document_webview(local));
        assert!(app_page_open(local));

        // 两项都登记：顺序固定为 0004、0005，与登记先后无关；重复登记不变
        let both = "file-access-test-keys-both";
        allow_app_local_resources(both);
        allow_file_documents(both);
        allow_file_documents(both);
        assert_eq!(
            extra_info_keys(both),
            vec![
                ALLOW_FILE_ACCESS_EXTRA_INFO_KEY,
                ALLOW_LOCAL_RESOURCES_EXTRA_INFO_KEY
            ]
        );
        assert!(app_page_open(both));
    }

    #[test]
    fn grants_cover_files_and_directories() {
        let (base, wp, sibling) = fixture("grants");
        let file = sibling.join("project.json");
        let other = sibling.join("other.txt");
        fs::write(&other, "other").unwrap();
        // 类型不符、不存在的路径不成为放行项
        assert!(FileGrant::new(&file, true).is_none());
        assert!(FileGrant::new(&sibling, false).is_none());
        assert!(FileGrant::new(&base.join("missing"), false).is_none());

        let only_file = FileAccessScope {
            root: Some(wp.clone()),
            grants: vec![FileGrant::new(&file, false).unwrap()],
        };
        assert!(super::check_file_request(&file_url(&file), &only_file).is_ok());
        assert_eq!(
            super::check_file_request(&file_url(&other), &only_file),
            Err(FileDeny::OutsideRoot)
        );
        let dir = FileAccessScope {
            root: None,
            grants: vec![FileGrant::new(&sibling, true).unwrap()],
        };
        assert!(super::check_file_request(&file_url(&other), &dir).is_ok());
        assert_eq!(
            super::check_file_request(&file_url(&base.join("outside.txt")), &dir),
            Err(FileDeny::OutsideRoot)
        );
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn path_key_matches_for_the_same_directory() {
        let (base, wp, _) = fixture("key");
        let via_parent = wp.join("sub dir").join("..");
        assert_eq!(file_path_key(&wp), file_path_key(&via_parent));
        assert!(file_path_key(&base.join("missing")).is_none());
        let key = file_path_key(&wp).unwrap();
        assert!(!key.ends_with('/') && !key.ends_with('\\'));
        assert!(!key.starts_with(r"\\?\"));
        #[cfg(windows)]
        {
            // Windows 不分大小写：大小写不同的同一目录得到同一个键
            let upper = PathBuf::from(wp.to_string_lossy().to_uppercase());
            assert_eq!(file_path_key(&upper), Some(key.clone()));
            assert_eq!(key, key.to_ascii_lowercase());
        }
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn requester_classification() {
        const APP: &str = "http://localhost:1420/index.html";
        let wp = std::env::temp_dir().join("wp");
        let doc_url = file_url(&wp.join("index.html"));
        let doc = || FileRequester::Document(file_url_path(&doc_url).unwrap());
        assert_eq!(
            classify_file_requester(false, false, Some(&doc_url), Some(APP)),
            doc()
        );
        assert_eq!(
            classify_file_requester(false, true, Some(&doc_url), Some(APP)),
            doc()
        );
        assert_eq!(
            classify_file_requester(false, true, None, Some(&doc_url)),
            doc()
        );
        assert_eq!(
            classify_file_requester(false, true, None, Some(APP)),
            FileRequester::Target
        );
        assert_eq!(
            classify_file_requester(false, true, Some("about:blank"), Some(APP)),
            FileRequester::Target
        );
        assert_eq!(
            classify_file_requester(false, true, None, None),
            FileRequester::Deny
        );
        assert_eq!(
            classify_file_requester(true, true, Some(APP), None),
            FileRequester::Deny
        );
        assert_eq!(
            classify_file_requester(false, false, Some("about:srcdoc"), Some(&doc_url)),
            doc()
        );
        assert_eq!(
            classify_file_requester(false, false, Some("about:srcdoc"), Some(APP)),
            FileRequester::Deny
        );
        assert_eq!(
            classify_file_requester(false, false, None, Some(&doc_url)),
            FileRequester::Deny
        );
    }

    /// 两张库内网页壁纸 `wp` / `sibling`；`wp` 的用户选了 `picked` 目录，`sibling` 的用户选了 `secret.txt`。
    fn library(
        base: &Path,
        wp: &Path,
        sibling: &Path,
    ) -> impl Fn(&Path) -> Option<FileAccessScope> {
        let picked = base.join("picked");
        fs::create_dir_all(&picked).unwrap();
        fs::write(picked.join("photo.jpg"), "jpg").unwrap();
        fs::write(base.join("secret.txt"), "secret").unwrap();
        let wp_scope = FileAccessScope {
            root: Some(canonical_path(wp).unwrap()),
            grants: vec![FileGrant::new(&picked, true).unwrap()],
        };
        let sibling_scope = FileAccessScope {
            root: Some(canonical_path(sibling).unwrap()),
            grants: vec![FileGrant::new(&base.join("secret.txt"), false).unwrap()],
        };
        let wp = file_path_key(wp).unwrap();
        let sibling = file_path_key(sibling).unwrap();
        move |path: &Path| {
            let key = file_path_key(path)?;
            if key == wp || key.starts_with(&format!("{wp}{}", std::path::MAIN_SEPARATOR)) {
                Some(wp_scope.clone())
            } else if key == sibling
                || key.starts_with(&format!("{sibling}{}", std::path::MAIN_SEPARATOR))
            {
                Some(sibling_scope.clone())
            } else {
                None
            }
        }
    }

    fn allowed(
        requester: &FileRequester,
        url: &str,
        resolver: &dyn Fn(&Path) -> Option<FileAccessScope>,
    ) -> bool {
        let scope = scope_for_request(requester, url, resolver).unwrap_or_default();
        super::check_file_request(url, &scope).is_ok()
    }

    /// 闸门的五种情况：自己目录内放行、自己的用户选择放行、跨到另一张壁纸被拒、另一张壁纸的用户选择被拒、
    /// 应用页导航到库外目录被拒。
    #[test]
    fn gate_scopes_documents_to_their_own_wallpaper() {
        let (base, wp, sibling) = fixture("gate");
        let resolver = library(&base, &wp, &sibling);
        let doc = FileRequester::Document(wp.join("index.html"));

        // 1. 自己目录内
        assert!(allowed(&doc, &file_url(&wp.join("data.json")), &resolver));
        assert!(allowed(
            &doc,
            &file_url(&wp.join("sub dir").join("歌 词.txt")),
            &resolver
        ));
        // 2. 自己用户属性选中的目录里的文件
        assert!(allowed(
            &doc,
            &file_url(&base.join("picked").join("photo.jpg")),
            &resolver
        ));
        // 3. 另一张壁纸的目录
        assert!(!allowed(
            &doc,
            &file_url(&sibling.join("project.json")),
            &resolver
        ));
        // 4. 另一张壁纸的用户选择
        assert!(!allowed(
            &doc,
            &file_url(&base.join("secret.txt")),
            &resolver
        ));
        // 5. 应用页导航：库内壁纸目录放行，库外与任何用户选择都拒绝
        let target = FileRequester::Target;
        assert!(allowed(
            &target,
            &file_url(&wp.join("index.html")),
            &resolver
        ));
        assert!(allowed(
            &target,
            &file_url(&sibling.join("project.json")),
            &resolver
        ));
        assert!(!allowed(
            &target,
            &file_url(&base.join("outside.txt")),
            &resolver
        ));
        assert!(!allowed(
            &target,
            &file_url(&base.join("picked").join("photo.jpg")),
            &resolver
        ));
        // 库外文档、拒绝档：什么都读不到
        let stranger = FileRequester::Document(base.join("outside.txt"));
        assert!(!allowed(
            &stranger,
            &file_url(&wp.join("data.json")),
            &resolver
        ));
        assert!(!allowed(
            &FileRequester::Deny,
            &file_url(&wp.join("data.json")),
            &resolver
        ));
        let _ = fs::remove_dir_all(base);
    }
}
