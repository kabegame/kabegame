//! 场景宿主（P3-0）：独立前端项目 `apps/wpe-scene` 的构建产物，主窗口 / 壁纸窗口的应用页把它当 `file:` iframe
//! 加载（sandbox 同网页壁纸），渲染器与 P3 的场景脚本以后都跑在这个 realm 里。
//!
//! - **位置**：`<resource_dir>/wpe-scene/index.html`。dev 下构建脚本把产物直接写进
//!   `target/<profile>/resources/wpe-scene`（不经 tauri-build 复制，改宿主不用重编 Rust）；prod 写进
//!   `src-tauri/kabegame/resources/wpe-scene`，经 tauri.conf.json 的 `resources/**/*` 打进安装包
//!   （见 `scripts/plugins/wpe-scene-host-plugin.ts`）。
//! - **`file:` 闸门**（[`access_scope_of`]，注册给 runtime 的解析器）：宿主目录里的文档以宿主目录为根，另放行
//!   WPE 安装目录的 `assets` 目录与 `config.json`、Windows 上文本对象要读的几个系统字体文件（[`font_grants`]），
//!   以及库里全部 `x-wpe/scene` 行的目录（随图片事件维护，见
//!   [`WpeWebDirIndex::scene_dir_grants`]）。范围按文档路径算、不分实例。应用页把 iframe 导航到宿主时
//!   按目标路径解析，只认宿主目录本身（runtime 对导航目标去掉放行项）。其它路径照旧按网页壁纸目录。
//! - **IPC**：场景壁纸是一种特殊的网页壁纸。宿主同样匹配 `wpe-web-capability`（`file:///*`、`frames: "sub"`），
//!   网页壁纸的命令与事件它都有（应答 ping、按 `image-changed` 跟随用户属性、`setting-change` 等）。
//!   场景专用的命令另由启动时按宿主 `index.html` 的**确切** `file:` 地址注册的 capability 放行（[`register_capability`]，
//!   `frames: "sub"`，窗口 main 与壁纸窗口池 `WALLPAPER_LABELS`）。不用路径通配：工坊内容可以造同名目录冒充。
//!   `file:` 文档的 IPC 来源就是去掉 query / fragment 的文档 URL（runtime `ipc_origin`，CEF 补丁 07）。
//!
//! 内存表只在这里与 [`WpeWebDirIndex`] 里，解析器在 CEF IO 线程上同步调用，不碰数据库与 Steam 库清单。

use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::RwLock;

use kabegame_core::app_paths::AppPaths;
use tauri_runtime_kbcef::{file_path_key, FileAccessScope, FileGrant};

use super::wpe_web_dir_index::WpeWebDirIndex;

/// 宿主在 resources 下的目录名。
pub const SCENE_HOST_DIR_NAME: &str = "wpe-scene";
/// 宿主入口文件。
const SCENE_HOST_ENTRY: &str = "index.html";
/// 运行时注册的 capability 标识。
const SCENE_HOST_CAPABILITY: &str = "wpe-scene-host-capability";
/// 宿主 capability 引用的应用权限（`permissions/wpe-scene-host.toml`）。
const SCENE_HOST_PERMISSION: &str = "wpe-scene-host";

/// 文本对象会读的系统字体（`%WINDIR%\Fonts` 下的文件名）。WPE 直接读这些文件、不随壁纸分发，
/// 我们照样不分发，只逐个放行文件、不放行整个字体目录：
/// - `systemfont_*` 字体名对应的文件（rea-p6b-raster 2.2）；
/// - 字形回退链用到的系统字体（rea-p6b-raster 2.3；链里另有 WPE 自带的 TwemojiMozilla，在 `assets` 里）。
#[cfg(any(windows, test))]
const SYSTEM_FONT_FILES: &[&str] = &[
    // systemfont_*（2.2）
    "arial.ttf",
    "calibri.ttf",
    "cambria.ttc",
    "comic.ttf",
    "consola.ttf",
    "micross.ttf",
    "segoeui.ttf",
    "verdana.ttf",
    // 回退链（2.3）
    "seguiemj.ttf",
    "arialuni.ttf",
    "seguisym.ttf",
    "msyh.ttc",
    "Malgun.ttf",
];

/// 宿主目录的访问范围素材。只在内存里，闸门只读它。
#[derive(Debug, Clone)]
struct HostScope {
    /// 宿主目录（原样；闸门比较时自己规范化）。
    root: PathBuf,
    /// 宿主目录的比较键（[`file_path_key`]）。
    root_key: String,
    /// WPE 安装目录的 `assets`（目录）与 `config.json`（文件）。
    engine_grants: Vec<FileGrant>,
    /// 系统字体文件（只 Windows，见 [`font_grants`]）。
    font_grants: Vec<FileGrant>,
}

/// 宿主目录不存在（还没构建）时为 None：宿主路径落回网页壁纸目录的判定，等于全拒。
static HOST_SCOPE: RwLock<Option<HostScope>> = RwLock::new(None);

/// 宿主目录 `<resource_dir>/wpe-scene`。
pub fn host_dir() -> PathBuf {
    AppPaths::global().resource_dir.join(SCENE_HOST_DIR_NAME)
}

/// 只认宿主入口文档，不把宿主目录中的其它文件当成可拉取场景状态的页面。
pub fn is_host_document(path: &Path) -> bool {
    is_host_document_in(path, &host_dir())
}

fn is_host_document_in(path: &Path, dir: &Path) -> bool {
    file_path_key(path) == file_path_key(&dir.join(SCENE_HOST_ENTRY))
}

/// 宿主 `index.html` 的 `file:///` 地址。应用页赋给 iframe 的地址、宿主的 IPC 来源与 capability 地址
/// 都是它，必须逐字一致，所以只从这里生成。
fn host_entry_url() -> Option<String> {
    entry_url(&host_dir())
}

fn entry_url(dir: &Path) -> Option<String> {
    let url = url::Url::from_file_path(dir.join(SCENE_HOST_ENTRY)).ok()?;
    Some(upper_drive_letter(url.as_str()))
}

/// Chromium 把 Windows 盘符规范成大写（`file:///d:/` → `file:///D:/`），文档 URL 与 IPC 来源随之是大写；
/// 这里先规范好，capability 才匹配得上。
fn upper_drive_letter(url: &str) -> String {
    const PREFIX: &str = "file:///";
    if let Some(rest) = url.strip_prefix(PREFIX) {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return format!(
                "{PREFIX}{}{}",
                (bytes[0] as char).to_ascii_uppercase(),
                &rest[1..]
            );
        }
    }
    url.to_string()
}

/// WPE 安装目录 → 放行项：`assets` 目录与 `config.json` 文件；不存在的跳过。
fn engine_grants(engine_dirs: &[PathBuf]) -> Vec<FileGrant> {
    engine_dirs
        .iter()
        .flat_map(|engine| {
            [
                FileGrant::new(&engine.join("assets"), true),
                FileGrant::new(&engine.join("config.json"), false),
            ]
        })
        .flatten()
        .collect()
}

/// 系统字体 → 放行项：`%WINDIR%\Fonts` 下 [`SYSTEM_FONT_FILES`] 里存在的文件；不存在的跳过（WPE 同样跳过）。
#[cfg(windows)]
fn font_grants() -> Vec<FileGrant> {
    let Some(windir) = std::env::var_os("WINDIR") else {
        return Vec::new();
    };
    font_grants_in(&PathBuf::from(windir).join("Fonts"))
}

/// 只有 Windows 上的 WPE 读系统字体。
#[cfg(not(windows))]
fn font_grants() -> Vec<FileGrant> {
    Vec::new()
}

/// `fonts` 目录下 [`SYSTEM_FONT_FILES`] 里存在的文件 → 放行项（只放文件，不放目录）。
#[cfg(any(windows, test))]
fn font_grants_in(fonts: &Path) -> Vec<FileGrant> {
    SYSTEM_FONT_FILES
        .iter()
        .filter_map(|name| FileGrant::new(&fonts.join(name), false))
        .collect()
}

/// 重新解析宿主目录、WPE 安装目录与系统字体，覆盖内存表。阻塞调用（读文件系统与 Steam 库清单）：启动时在
/// `init_heavy_globals` 里、应用页每次取宿主地址时各调一次——dev 下宿主可能晚于应用启动才构建，WPE 也可能后装。
pub fn refresh_scene_host() {
    let root = host_dir();
    let next = file_path_key(&root).map(|root_key| HostScope {
        root,
        root_key,
        engine_grants: engine_grants(kabegame_core::wpe::discover::engine_dir().as_slice()),
        font_grants: font_grants(),
    });
    if let Ok(mut slot) = HOST_SCOPE.write() {
        *slot = next;
    }
}

/// `key` 是否为宿主目录本身或其中的路径（两者都是 [`file_path_key`] 的形式）。
fn is_within(key: &str, root_key: &str) -> bool {
    key == root_key
        || key
            .strip_prefix(root_key)
            .is_some_and(|rest| rest.starts_with(MAIN_SEPARATOR))
}

/// 宿主目录里的路径的访问范围；不在宿主目录里返回 None。`scene_dirs` 只在命中时才取。
fn host_scope_for(
    key: &str,
    host: &HostScope,
    scene_dirs: impl FnOnce() -> Vec<FileGrant>,
) -> Option<FileAccessScope> {
    if !is_within(key, &host.root_key) {
        return None;
    }
    let mut grants = host.engine_grants.clone();
    grants.extend(host.font_grants.iter().cloned());
    grants.extend(scene_dirs());
    Some(FileAccessScope {
        root: Some(host.root.clone()),
        grants,
    })
}

/// 注册给 runtime 的解析器：宿主目录优先，其它路径按网页壁纸目录（[`WpeWebDirIndex::access_scope_of_key`]）。
pub fn access_scope_of(path: &Path) -> Option<FileAccessScope> {
    let key = file_path_key(path)?;
    if let Ok(slot) = HOST_SCOPE.read() {
        if let Some(scope) = slot.as_ref().and_then(|host| {
            host_scope_for(&key, host, || WpeWebDirIndex::global().scene_dir_grants())
        }) {
            return Some(scope);
        }
    }
    WpeWebDirIndex::global().access_scope_of_key(&key)
}

/// 应用页取宿主地址：先刷新内存表；宿主没构建时报错。阻塞调用。
pub fn prepare_host_entry_url() -> Result<String, String> {
    refresh_scene_host();
    let entry = host_dir().join(SCENE_HOST_ENTRY);
    if !entry.is_file() {
        return Err(format!("scene host is not built: {}", entry.display()));
    }
    host_entry_url().ok_or_else(|| format!("invalid scene host path: {}", entry.display()))
}

/// 把地址转成只匹配它自己的 URLPattern：`file://` 之后的 URLPattern 特殊字符（`:` 具名组、`*` 通配、
/// `(` `)` 正则、`{` `}` 分组、`+` `?` 修饰、`\` 转义）逐个转义。Windows 盘符的冒号不转义会被当成具名组而解析失败。
fn url_pattern_literal(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let mut out = format!("{scheme}://");
    for ch in rest.chars() {
        if matches!(ch, ':' | '*' | '(' | ')' | '{' | '}' | '+' | '?' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// 按宿主 `index.html` 的确切地址注册 capability：只给主窗口 / 壁纸窗口的子 frame，放行
/// `permissions/wpe-scene-host.toml` 的场景专用命令。网页壁纸的命令与事件由 `wpe-web-capability` 给，这里不重复。
pub fn register_capability<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    use tauri::ipc::CapabilityBuilder;
    use tauri::utils::acl::capability::CapabilityFrames;
    use tauri::Manager;

    let url = host_entry_url().ok_or("cannot build the scene host url")?;
    let capability = CapabilityBuilder::new(SCENE_HOST_CAPABILITY)
        .remote(url_pattern_literal(&url))
        .local(false)
        .windows(std::iter::once("main").chain(crate::wallpaper::WALLPAPER_LABELS))
        .frames(CapabilityFrames::Sub)
        .permission(SCENE_HOST_PERMISSION);
    app.add_capability(capability)
        .map_err(|error| error.to_string())?;
    tracing::info!("场景宿主 capability 已注册: {url}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tauri::utils::acl::RemoteUrlPattern;

    /// `<tmp>/kabegame-scene-host-<name>-<pid>/{resources/wpe-scene, resources/wpe-scene2, engine/assets, scene, fonts}`。
    /// `fonts` 里有清单内的 `arial.ttf`、`msyh.ttc`，清单外的 `other.ttf`，以及和清单同名的目录 `segoeui.ttf`。
    fn fixture(name: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("kabegame-scene-host-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        for dir in [
            "resources/wpe-scene/assets",
            "resources/wpe-scene2",
            "engine/assets/shaders",
            "scene",
            "fonts/segoeui.ttf",
        ] {
            fs::create_dir_all(base.join(dir)).unwrap();
        }
        fs::write(base.join("resources/wpe-scene/index.html"), "host").unwrap();
        fs::write(base.join("resources/wpe-scene/assets/index.js"), "js").unwrap();
        fs::write(base.join("resources/wpe-scene2/index.html"), "fake").unwrap();
        fs::write(base.join("engine/config.json"), "{}").unwrap();
        fs::write(base.join("engine/assets/shaders/a.frag"), "x").unwrap();
        fs::write(base.join("scene/scene.pkg"), "pkg").unwrap();
        for font in ["arial.ttf", "msyh.ttc", "other.ttf"] {
            fs::write(base.join("fonts").join(font), "font").unwrap();
        }
        base
    }

    fn host(base: &Path) -> HostScope {
        let root = base.join("resources/wpe-scene");
        HostScope {
            root_key: file_path_key(&root).unwrap(),
            root,
            engine_grants: engine_grants(&[base.join("engine"), base.join("missing-engine")]),
            font_grants: font_grants_in(&base.join("fonts")),
        }
    }

    fn key(path: &Path) -> String {
        file_path_key(path).unwrap()
    }

    #[test]
    fn engine_grants_cover_assets_and_config_only() {
        let base = fixture("engine");
        let grants = engine_grants(&[base.join("engine"), base.join("missing-engine")]);
        // 不存在的安装目录不产生放行项
        assert_eq!(grants.len(), 2);
        assert!(grants[0].is_dir);
        assert_eq!(key(&grants[0].path), key(&base.join("engine/assets")));
        assert!(!grants[1].is_dir);
        assert_eq!(key(&grants[1].path), key(&base.join("engine/config.json")));
        let _ = fs::remove_dir_all(base);
    }

    /// 只放清单里存在的文件：清单外的文件、和清单同名的目录、不存在的文件都不放。
    #[test]
    fn font_grants_cover_listed_existing_files_only() {
        let base = fixture("fonts");
        let fonts = base.join("fonts");
        let grants = font_grants_in(&fonts);
        assert!(grants.iter().all(|grant| !grant.is_dir));
        let granted: Vec<_> = grants.iter().map(|grant| key(&grant.path)).collect();
        assert_eq!(
            granted,
            vec![key(&fonts.join("arial.ttf")), key(&fonts.join("msyh.ttc"))]
        );
        assert!(font_grants_in(&base.join("missing-fonts")).is_empty());
        let _ = fs::remove_dir_all(base);
    }

    /// 清单里的文件名在 Windows 上不分大小写（`Malgun.ttf` 实际多是 `malgun.ttf`）。
    #[cfg(windows)]
    #[test]
    fn font_grants_ignore_case_on_windows() {
        let base = fixture("fonts-case");
        let fonts = base.join("fonts");
        fs::write(fonts.join("malgun.ttf"), "font").unwrap();
        let granted: Vec<_> = font_grants_in(&fonts)
            .iter()
            .map(|grant| key(&grant.path))
            .collect();
        assert!(granted.contains(&key(&fonts.join("malgun.ttf"))), "{granted:?}");
        let _ = fs::remove_dir_all(base);
    }

    /// 真实的 `%WINDIR%\Fonts`：只放该目录下清单里的文件（本机缺的跳过），Windows 自带的 arial.ttf 一定在。
    #[cfg(windows)]
    #[test]
    fn system_font_grants_stay_in_the_windows_fonts_dir() {
        let fonts = PathBuf::from(std::env::var_os("WINDIR").unwrap()).join("Fonts");
        let grants = font_grants();
        assert!(!grants.is_empty());
        assert!(grants.len() <= SYSTEM_FONT_FILES.len());
        let fonts_key = key(&fonts);
        for grant in &grants {
            assert!(!grant.is_dir);
            assert!(is_within(&key(&grant.path), &fonts_key), "{grant:?}");
        }
        let arial = key(&fonts.join("arial.ttf"));
        assert!(grants.iter().any(|grant| key(&grant.path) == arial));
    }

    #[test]
    fn host_documents_get_the_host_scope() {
        let base = fixture("scope");
        let host = host(&base);
        let scene = FileGrant::new(&base.join("scene"), true).unwrap();
        let scenes = || vec![scene.clone()];

        let scope = host_scope_for(
            &key(&base.join("resources/wpe-scene/index.html")),
            &host,
            scenes,
        )
        .unwrap();
        assert_eq!(scope.root.as_deref(), Some(host.root.as_path()));
        let granted: Vec<_> = scope.grants.iter().map(|grant| key(&grant.path)).collect();
        assert_eq!(
            granted,
            vec![
                key(&base.join("engine/assets")),
                key(&base.join("engine/config.json")),
                key(&base.join("fonts/arial.ttf")),
                key(&base.join("fonts/msyh.ttc")),
                key(&base.join("scene")),
            ]
        );
        // 子目录里的文档、宿主目录本身（导航目标的祖先判定）同样命中
        assert!(host_scope_for(
            &key(&base.join("resources/wpe-scene/assets/index.js")),
            &host,
            scenes
        )
        .is_some());
        assert!(host_scope_for(&host.root_key, &host, scenes).is_some());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn paths_outside_the_host_are_not_host_documents() {
        let base = fixture("outside");
        let host = host(&base);
        let untouched = || -> Vec<FileGrant> { panic!("场景目录只在命中宿主时才取") };
        // 前缀相同的兄弟目录（`wpe-scene2`）不算
        assert!(host_scope_for(
            &key(&base.join("resources/wpe-scene2/index.html")),
            &host,
            untouched
        )
        .is_none());
        // 场景目录、WPE 安装目录里的文档本身没有宿主范围
        assert!(host_scope_for(&key(&base.join("scene/scene.pkg")), &host, untouched).is_none());
        assert!(host_scope_for(&key(&base.join("engine/config.json")), &host, untouched).is_none());
        assert!(host_scope_for(&key(&base.join("fonts/arial.ttf")), &host, untouched).is_none());
        assert!(host_scope_for(&key(&base.join("resources")), &host, untouched).is_none());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn drive_letters_are_uppercased() {
        assert_eq!(
            upper_drive_letter("file:///d:/Codes/a.html"),
            "file:///D:/Codes/a.html"
        );
        assert_eq!(
            upper_drive_letter("file:///D:/Codes/a.html"),
            "file:///D:/Codes/a.html"
        );
        assert_eq!(
            upper_drive_letter("file:///tmp/a.html"),
            "file:///tmp/a.html"
        );
        assert_eq!(
            upper_drive_letter("file://server/share/a.html"),
            "file://server/share/a.html"
        );
    }

    /// capability 地址只匹配宿主入口本身：同目录别的文件、前缀相同的兄弟目录、别处的同名目录都不匹配。
    #[test]
    fn capability_pattern_matches_only_the_host_entry() {
        let base = fixture("pattern");
        let dir = base.join("resources/wpe-scene");
        let url = entry_url(&dir).unwrap();
        let pattern: RemoteUrlPattern = url_pattern_literal(&url).parse().unwrap();
        let test = |raw: &str| pattern.test(&url::Url::parse(raw).unwrap());

        assert!(test(&url), "{url}");
        assert!(!test(
            &entry_url(&base.join("resources/wpe-scene2")).unwrap()
        ));
        assert!(!test(&url.replace("index.html", "other.html")));
        assert!(!test(
            &entry_url(&base.join("scene/resources/wpe-scene")).unwrap()
        ));
        assert!(!test("file:///*"));
        let _ = fs::remove_dir_all(base);
    }

    /// 路径里带空格与 URLPattern 特殊字符时照样只匹配它自己。
    #[test]
    fn capability_pattern_escapes_special_characters() {
        let base = fixture("special");
        let dir = base.join("Program Files (x86)+{k}").join("wpe-scene");
        fs::create_dir_all(&dir).unwrap();
        let url = entry_url(&dir).unwrap();
        let pattern: RemoteUrlPattern = url_pattern_literal(&url).parse().unwrap();
        assert!(pattern.test(&url::Url::parse(&url).unwrap()), "{url}");
        let sibling = entry_url(&base.join("Program Files (x86)+{k}").join("wpe-scenes")).unwrap();
        assert!(!pattern.test(&url::Url::parse(&sibling).unwrap()));
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(windows)]
    #[test]
    fn entry_url_is_a_file_url_with_an_uppercase_drive() {
        let url = entry_url(Path::new(r"d:\Apps\Kabegame\resources\wpe-scene")).unwrap();
        assert_eq!(
            url,
            "file:///D:/Apps/Kabegame/resources/wpe-scene/index.html"
        );
    }

    #[test]
    fn only_entry_is_a_host_document() {
        let base = fixture("host-document");
        let dir = base.join("resources/wpe-scene");
        assert!(is_host_document_in(&dir.join("index.html"), &dir));
        assert!(!is_host_document_in(&dir.join("assets/index.js"), &dir));
        assert!(!is_host_document_in(
            &base.join("resources/wpe-scene2/index.html"),
            &dir
        ));
        let _ = fs::remove_dir_all(base);
    }
}
