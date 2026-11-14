//! 场景宿主（P3-0）：独立前端项目 `apps/wpe-scene` 的构建产物，主窗口 / 壁纸窗口的应用页把它当 `file:` iframe
//! 加载（sandbox 同网页壁纸），渲染器与 P3 的场景脚本以后都跑在这个 realm 里。
//!
//! - **位置**：`<resource_dir>/wpe-scene/index.html`。dev 下构建脚本把产物直接写进
//!   `target/<profile>/resources/wpe-scene`（不经 tauri-build 复制，改宿主不用重编 Rust）；prod 写进
//!   `src-tauri/kabegame/resources/wpe-scene`，经 tauri.conf.json 的 `resources/**/*` 打进安装包
//!   （见 `scripts/plugins/wpe-scene-host-plugin.ts`）。
//! - **`file:` 闸门**（[`access_scope_of`]，注册给 runtime 的解析器）：宿主目录里的文档以宿主目录为根，另放行
//!   WPE 安装目录的 `assets` 目录与 `config.json`、文本对象要读的系统字体（按平台解析成本机文件，
//!   [`platform_system_fonts`]；交给宿主的表 [`system_fonts`] 与放行项是同一次解析的结果），
//!   以及库里全部 `x-wpe/scene` 行的目录与用户为它们选的 `scenetexture` 文件（随图片事件维护，见
//!   [`WpeWebDirIndex::scene_grants`]）。范围按文档路径算、不分实例。应用页把 iframe 导航到宿主时
//!   按目标路径解析，只认宿主目录本身（runtime 对导航目标去掉放行项）。其它路径照旧按网页壁纸目录。
//! - **IPC**：场景壁纸是一种特殊的网页壁纸。宿主同样匹配 `wpe-web-capability`（`file:///*`、`frames: "sub"`），
//!   网页壁纸的命令与事件它都有（应答 ping、按 `image-changed` 跟随用户属性、`setting-change` 等）。
//!   场景专用的命令另由启动时按宿主 `index.html` 的**确切** `file:` 地址注册的 capability 放行（[`register_capability`]，
//!   `frames: "sub"`，窗口 main 与壁纸窗口池 `WALLPAPER_LABELS`）。不用路径通配：工坊内容可以造同名目录冒充。
//!   `file:` 文档的 IPC 来源就是去掉 query / fragment 的文档 URL（runtime `ipc_origin`，CEF 补丁 07）。
//!
//! 内存表只在这里与 [`WpeWebDirIndex`] 里，解析器在 CEF IO 线程上同步调用，不碰数据库与 Steam 库清单。

use std::collections::BTreeMap;
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

/// 文本对象会读的系统字体名：WPE 在 `%WINDIR%\Fonts` 下的文件名，宿主写成 `system:<名字>`
/// （`apps/wpe-scene/src/text/fonts.ts`，拼写逐字相同，含 `Malgun.ttf` 的大写 M）。所有平台共用这张键表：
/// Windows 取 `%WINDIR%\Fonts` 下的同名文件，macOS / Linux 按 [`MACOS_SYSTEM_FONTS`] / [`LINUX_SYSTEM_FONTS`]
/// 换成本机文件（[`platform_system_fonts`]）。WPE 直接读这些文件、不随壁纸分发，我们照样不分发，只逐个放行
/// 解析出的文件、不放行整个字体目录：
/// - `systemfont_*` 字体名对应的文件（rea-p6b-raster 2.2）；
/// - 字形回退链用到的系统字体（rea-p6b-raster 2.3；链里另有 WPE 自带的 TwemojiMozilla，在 `assets` 里）。
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

// TODO:[WPE_SCENE] 在 macOS 上测试：下面的候选路径没在真机上核对过，是按 macOS 自带字体与 Office for Mac 的
// 常见位置写的。
// - 要核对：各路径在当前系统版本上是否存在、`wpe_scene_target` 交给宿主的表、文本场景实际画出来的字形；
// - 先同一款字体（`Supplemental/` 自带的 Arial、Comic Sans MS、Microsoft Sans Serif、Verdana、Arial Unicode）；
//   Calibri / Cambria / Consolas 只有装了 Office for Mac（字体在 Word 的 app 包里）或装进 `/Library/Fonts` 时才有，
//   否则 cambria 退到 Georgia、consola 退到 Menlo；segoeui、msyh、Malgun 没有同款，用外观接近的系统字体
//   （SF / Helvetica、冬青黑体 / 华文黑体、Apple SD Gothic Neo），度量不同，画面只求像、不会和 WPE 逐像素相同；
// - 彩色 emoji（`seguiemj.ttf`）不给替代：Apple Color Emoji 是 sbix（内嵌 PNG），wpefont 没编进 libpng，FreeType
//   读不了；emoji 交给回退链后面 WPE 自带的 Twemoji（COLR）；
// - TTC 一律取 face 0（wpefont 照 WPE），这些 `.ttc` 的 face 0 是不是常规体没核对；
// - 只看系统级目录，不看 `~/Library/Fonts`；候选本身是符号链接时跳过（`file:` 闸门不认符号链接）。
/// macOS：每个名字一组本机候选（绝对路径），按优先级排，取第一个存在的（[`resolve_system_fonts`]）。不加 `cfg`：
/// 各平台都编译、可单测。
const MACOS_SYSTEM_FONTS: &[(&str, &[&str])] = &[
    (
        "arial.ttf",
        &[
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
        ],
    ),
    (
        "calibri.ttf",
        &[
            "/Applications/Microsoft Word.app/Contents/Resources/DFonts/Calibri.ttf",
            "/Library/Fonts/Calibri.ttf",
        ],
    ),
    (
        "cambria.ttc",
        &[
            "/Applications/Microsoft Word.app/Contents/Resources/DFonts/Cambria.ttc",
            "/Library/Fonts/Cambria.ttc",
            "/System/Library/Fonts/Supplemental/Georgia.ttf",
        ],
    ),
    (
        "comic.ttf",
        &["/System/Library/Fonts/Supplemental/Comic Sans MS.ttf"],
    ),
    (
        "consola.ttf",
        &[
            "/Applications/Microsoft Word.app/Contents/Resources/DFonts/Consola.ttf",
            "/Library/Fonts/Consola.ttf",
            "/System/Library/Fonts/Menlo.ttc",
        ],
    ),
    (
        "micross.ttf",
        &["/System/Library/Fonts/Supplemental/Microsoft Sans Serif.ttf"],
    ),
    (
        "segoeui.ttf",
        &[
            "/System/Library/Fonts/SFNS.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ],
    ),
    (
        "verdana.ttf",
        &["/System/Library/Fonts/Supplemental/Verdana.ttf"],
    ),
    ("seguiemj.ttf", &[]),
    (
        "arialuni.ttf",
        &[
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/Library/Fonts/Arial Unicode.ttf",
        ],
    ),
    ("seguisym.ttf", &["/System/Library/Fonts/Apple Symbols.ttf"]),
    (
        "msyh.ttc",
        &[
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/STHeiti Medium.ttc",
        ],
    ),
    (
        "Malgun.ttf",
        &["/System/Library/Fonts/AppleSDGothicNeo.ttc"],
    ),
];

// TODO:[WPE_SCENE] 在 Linux 上测试：下面的候选路径没在真机上核对过。
// - 发行版之间字体包与路径不一（这里列了 Debian / Ubuntu、Fedora、Arch 三种布局），装了哪些字体包也因人而异；
//   以后可以考虑改用 fontconfig（`fc-match <字体族>`）按族名查，代替写死的路径；要核对的同 macOS 一条；
// - 先同一款字体（msttcorefonts 的 Arial、Comic Sans MS、Verdana），再度量兼容的（Liberation Sans ↔ Arial、
//   Carlito ↔ Calibri、Caladea ↔ Cambria），再外观接近的（DejaVu、Noto、文泉驿、Nanum），画面只求像、不会和 WPE
//   逐像素相同；
// - Debian 的 msttcorefonts 里小写文件名多是指向首字母大写文件的符号链接，`file:` 闸门不认符号链接，所以两种写法
//   都列，是链接的那条会被跳过；
// - 彩色 emoji（`seguiemj.ttf`）不给替代：Noto Color Emoji 是 CBDT（内嵌 PNG），wpefont 没编进 libpng，FreeType
//   读不了；emoji 交给回退链后面 WPE 自带的 Twemoji（COLR）。`arialuni.ttf` 没有同款，也不给；
// - TTC 一律取 face 0（wpefont 照 WPE）：Noto Sans CJK 的 face 0 是 JP 字形，中文 / 韩文的字形和 WPE 用的
//   雅黑 / Malgun 有差别；
// - 只看 `/usr/share/fonts`，不看 `/usr/local/share/fonts`、`~/.local/share/fonts`。
/// Linux（以及 macOS 以外的其它 Unix）：每个名字一组本机候选（绝对路径），按优先级排，取第一个存在的。
/// 不加 `cfg`：各平台都编译、可单测。
const LINUX_SYSTEM_FONTS: &[(&str, &[&str])] = &[
    (
        "arial.ttf",
        &[
            "/usr/share/fonts/truetype/msttcorefonts/arial.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/Arial.ttf",
            "/usr/share/fonts/msttcore/arial.ttf",
            "/usr/share/fonts/TTF/arial.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
            "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
        ],
    ),
    (
        "calibri.ttf",
        &[
            "/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf",
            "/usr/share/fonts/google-carlito-fonts/Carlito-Regular.ttf",
            "/usr/share/fonts/TTF/Carlito-Regular.ttf",
        ],
    ),
    (
        "cambria.ttc",
        &[
            "/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf",
            "/usr/share/fonts/google-crosextra-caladea-fonts/Caladea-Regular.ttf",
            "/usr/share/fonts/TTF/Caladea-Regular.ttf",
        ],
    ),
    (
        "comic.ttf",
        &[
            "/usr/share/fonts/truetype/msttcorefonts/comic.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/Comic_Sans_MS.ttf",
            "/usr/share/fonts/msttcore/comic.ttf",
            "/usr/share/fonts/TTF/comic.ttf",
        ],
    ),
    (
        "consola.ttf",
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
            "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
        ],
    ),
    (
        "micross.ttf",
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ],
    ),
    (
        "segoeui.ttf",
        &[
            "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
            "/usr/share/fonts/google-noto/NotoSans-Regular.ttf",
            "/usr/share/fonts/noto/NotoSans-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ],
    ),
    (
        "verdana.ttf",
        &[
            "/usr/share/fonts/truetype/msttcorefonts/verdana.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/Verdana.ttf",
            "/usr/share/fonts/msttcore/verdana.ttf",
            "/usr/share/fonts/TTF/verdana.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ],
    ),
    ("seguiemj.ttf", &[]),
    ("arialuni.ttf", &[]),
    (
        "seguisym.ttf",
        &[
            "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
            "/usr/share/fonts/google-noto/NotoSansSymbols2-Regular.ttf",
            "/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ],
    ),
    (
        "msyh.ttc",
        &[
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc",
        ],
    ),
    (
        "Malgun.ttf",
        &[
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        ],
    ),
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
    /// 系统字体：名字 → 本机文件（[`platform_system_fonts`]）。交给宿主的表（[`system_fonts`]）就是它。
    system_fonts: BTreeMap<String, PathBuf>,
    /// 由 `system_fonts` 生成的放行项（[`font_grants`]，只放文件）。
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

/// Windows 的候选：每个名字一个，`<fonts>\<名字>`（`fonts` 是 `%WINDIR%\Fonts`，WPE 读的就是它）。
fn windows_system_fonts(fonts: &Path) -> Vec<(&'static str, [PathBuf; 1])> {
    SYSTEM_FONT_FILES
        .iter()
        .map(|name| (*name, [fonts.join(name)]))
        .collect()
}

/// 每个名字取候选里第一个存在的（`exists` 判定，产品里是 [`is_grantable_font`]，单测注入假的文件集合）；
/// 一个候选都不在的名字不出现在表里，宿主读它时当读不到（同 WPE 的「文件不在就跳过」）。
fn resolve_system_fonts<'a, C, P>(
    table: impl IntoIterator<Item = (&'a str, C)>,
    exists: impl Fn(&Path) -> bool,
) -> BTreeMap<String, PathBuf>
where
    C: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    table
        .into_iter()
        .filter_map(|(name, candidates)| {
            candidates
                .into_iter()
                .map(|candidate| candidate.as_ref().to_path_buf())
                .find(|candidate| exists(candidate))
                .map(|path| (name.to_string(), path))
        })
        .collect()
}

/// 产品里的「存在」：普通文件、本身不是符号链接（同 [`FileGrant::new`] 与 `file:` 闸门的要求），这样解析出的表里
/// 每一项都能放行、宿主都读得到。
fn is_grantable_font(path: &Path) -> bool {
    FileGrant::new(path, false).is_some()
}

/// 当前平台的系统字体表：Windows 按 `%WINDIR%\Fonts`（取不到 `WINDIR` 时为空表），macOS 按
/// [`MACOS_SYSTEM_FONTS`]，其余平台（Linux 等 Unix）按 [`LINUX_SYSTEM_FONTS`]。阻塞调用（逐个查文件）。
fn platform_system_fonts() -> BTreeMap<String, PathBuf> {
    if cfg!(windows) {
        let Some(windir) = std::env::var_os("WINDIR") else {
            return BTreeMap::new();
        };
        resolve_system_fonts(
            windows_system_fonts(&PathBuf::from(windir).join("Fonts")),
            is_grantable_font,
        )
    } else if cfg!(target_os = "macos") {
        resolve_system_fonts(MACOS_SYSTEM_FONTS.iter().copied(), is_grantable_font)
    } else {
        resolve_system_fonts(LINUX_SYSTEM_FONTS.iter().copied(), is_grantable_font)
    }
}

/// 解析出的系统字体 → 放行项（只放文件，不放目录）。
fn font_grants(fonts: &BTreeMap<String, PathBuf>) -> Vec<FileGrant> {
    fonts
        .values()
        .filter_map(|path| FileGrant::new(path, false))
        .collect()
}

/// 交给宿主的形式：名字 → 本机文件路径的字符串（宿主转成 `file:` 地址读）。
fn font_table(fonts: &BTreeMap<String, PathBuf>) -> BTreeMap<String, String> {
    fonts
        .iter()
        .map(|(name, path)| (name.clone(), path.to_string_lossy().into_owned()))
        .collect()
}

/// 交给宿主的系统字体表（`wpe_scene_target` 的 `systemFonts`）：读 [`refresh_scene_host`] 解析好的结果，和放行项是
/// 同一份。宿主目录不在（没构建）时为空表。
pub fn system_fonts() -> BTreeMap<String, String> {
    HOST_SCOPE
        .read()
        .ok()
        .and_then(|slot| slot.as_ref().map(|host| font_table(&host.system_fonts)))
        .unwrap_or_default()
}

/// 重新解析宿主目录、WPE 安装目录与系统字体，覆盖内存表。阻塞调用（读文件系统与 Steam 库清单）：启动时在
/// `init_heavy_globals` 里、应用页每次取宿主地址时各调一次——dev 下宿主可能晚于应用启动才构建，WPE 也可能后装。
pub fn refresh_scene_host() {
    let root = host_dir();
    let next = file_path_key(&root).map(|root_key| {
        let system_fonts = platform_system_fonts();
        let missing: Vec<_> = SYSTEM_FONT_FILES
            .iter()
            .filter(|name| !system_fonts.contains_key(**name))
            .collect();
        tracing::debug!(
            "场景宿主的系统字体：解析到 {} 个，本机没有 {missing:?}",
            system_fonts.len()
        );
        HostScope {
            root,
            root_key,
            engine_grants: engine_grants(kabegame_core::wpe::discover::engine_dir().as_slice()),
            font_grants: font_grants(&system_fonts),
            system_fonts,
        }
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

/// 宿主目录里的路径的访问范围；不在宿主目录里返回 None。`scene_grants` 只在命中时才取。
fn host_scope_for(
    key: &str,
    host: &HostScope,
    scene_grants: impl FnOnce() -> Vec<FileGrant>,
) -> Option<FileAccessScope> {
    if !is_within(key, &host.root_key) {
        return None;
    }
    let mut grants = host.engine_grants.clone();
    grants.extend(host.font_grants.iter().cloned());
    grants.extend(scene_grants());
    Some(FileAccessScope {
        root: Some(host.root.clone()),
        grants,
    })
}

/// 注册给 runtime 的解析器：宿主目录优先，其它路径按网页壁纸目录（[`WpeWebDirIndex::access_scope_of_key`]）。
pub fn access_scope_of(path: &Path) -> Option<FileAccessScope> {
    let key = file_path_key(path)?;
    if let Ok(slot) = HOST_SCOPE.read() {
        if let Some(scope) = slot
            .as_ref()
            .and_then(|host| host_scope_for(&key, host, || WpeWebDirIndex::global().scene_grants()))
        {
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
    use std::collections::BTreeSet;
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
        let system_fonts =
            resolve_system_fonts(windows_system_fonts(&base.join("fonts")), is_grantable_font);
        HostScope {
            root_key: file_path_key(&root).unwrap(),
            root,
            engine_grants: engine_grants(&[base.join("engine"), base.join("missing-engine")]),
            font_grants: font_grants(&system_fonts),
            system_fonts,
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

    /// 三张表都恰好是那 13 个名字、顺序同键表（宿主按名字查表，漏一个就读不到）；键表本身不重复。
    #[test]
    fn every_platform_table_covers_every_name() {
        fn names(table: &[(&'static str, &[&str])]) -> Vec<&'static str> {
            table.iter().map(|(name, _)| *name).collect()
        }
        assert_eq!(SYSTEM_FONT_FILES.len(), 13);
        assert_eq!(
            SYSTEM_FONT_FILES.iter().collect::<BTreeSet<_>>().len(),
            SYSTEM_FONT_FILES.len()
        );
        assert_eq!(names(MACOS_SYSTEM_FONTS), SYSTEM_FONT_FILES);
        assert_eq!(names(LINUX_SYSTEM_FONTS), SYSTEM_FONT_FILES);
        let windows: Vec<_> = windows_system_fonts(Path::new("fonts"))
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(windows, SYSTEM_FONT_FILES);
    }

    /// macOS / Linux 的候选都是绝对路径（Unix 形式：按 `/` 开头判断，Windows 上 `Path::is_absolute` 不认没有盘符的路径）、
    /// 没有 `..` 与反斜杠、是字体文件、组内不重复。
    #[test]
    fn unix_candidates_are_absolute_font_files() {
        for table in [MACOS_SYSTEM_FONTS, LINUX_SYSTEM_FONTS] {
            for (name, candidates) in table {
                let unique: BTreeSet<_> = candidates.iter().collect();
                assert_eq!(unique.len(), candidates.len(), "{name}");
                for candidate in *candidates {
                    assert!(candidate.starts_with('/'), "{candidate}");
                    assert!(
                        !candidate.contains('\\')
                            && !candidate.contains("/../")
                            && !candidate.contains("//"),
                        "{candidate}"
                    );
                    assert!(
                        candidate.ends_with(".ttf") || candidate.ends_with(".ttc"),
                        "{candidate}"
                    );
                }
            }
        }
    }

    /// 每个名字取第一个存在的候选；一个都不在的、空候选组的名字不出现在表里。
    #[test]
    fn resolve_takes_the_first_existing_candidate() {
        const TABLE: &[(&str, &[&str])] = &[
            ("a.ttf", &["/x/a1.ttf", "/x/a2.ttf", "/x/a3.ttf"]),
            ("b.ttf", &["/x/b.ttf"]),
            ("c.ttf", &[]),
        ];
        let present = ["/x/a2.ttf", "/x/a3.ttf", "/x/unlisted.ttf"];
        let exists = |path: &Path| present.iter().any(|item| Path::new(item) == path);
        assert_eq!(
            resolve_system_fonts(TABLE.iter().copied(), exists),
            BTreeMap::from([("a.ttf".to_string(), PathBuf::from("/x/a2.ttf"))])
        );
        assert!(resolve_system_fonts(TABLE.iter().copied(), |_: &Path| false).is_empty());

        // 真实的 Linux 表：msttcorefonts 不在、Liberation 在 → arial 取 Liberation Sans；consola 的 DejaVu Sans Mono 与
        // Liberation Mono 都在 → 取排在前面的 DejaVu
        let present = [
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
        ];
        let exists = |path: &Path| present.iter().any(|item| Path::new(item) == path);
        let linux = resolve_system_fonts(LINUX_SYSTEM_FONTS.iter().copied(), exists);
        assert_eq!(
            linux,
            BTreeMap::from([
                ("arial.ttf".to_string(), PathBuf::from(present[0])),
                ("consola.ttf".to_string(), PathBuf::from(present[2])),
            ])
        );
        // 真实的 macOS 表：没装 Office 时 consola 退到 Menlo
        let exists = |path: &Path| path == Path::new("/System/Library/Fonts/Menlo.ttc");
        let mac = resolve_system_fonts(MACOS_SYSTEM_FONTS.iter().copied(), exists);
        assert_eq!(
            mac,
            BTreeMap::from([(
                "consola.ttf".to_string(),
                PathBuf::from("/System/Library/Fonts/Menlo.ttc")
            )])
        );
    }

    /// 彩色 emoji 在 macOS / Linux 不给替代（sbix / CBDT 是内嵌 PNG，wpefont 没有 libpng），`arialuni.ttf` 只有 macOS
    /// 有同款：候选文件全在时它们也不出现在表里；其余名字取各自的第一个候选。
    #[test]
    fn color_emoji_has_no_substitute_off_windows() {
        let all = |_: &Path| true;
        for (table, absent) in [
            (MACOS_SYSTEM_FONTS, &["seguiemj.ttf"][..]),
            (LINUX_SYSTEM_FONTS, &["seguiemj.ttf", "arialuni.ttf"][..]),
        ] {
            let fonts = resolve_system_fonts(table.iter().copied(), all);
            assert_eq!(fonts.len(), SYSTEM_FONT_FILES.len() - absent.len());
            for (name, candidates) in table {
                match fonts.get(*name) {
                    Some(path) => assert_eq!(path, Path::new(candidates[0])),
                    None => assert!(absent.contains(name), "{name}"),
                }
            }
        }
    }

    /// 放行项与解析表一致：表里每个文件各放一项（只放文件），交给宿主的路径和放行的是同一个文件；清单外的文件、
    /// 和清单同名的目录、不存在的文件都不在表里。
    #[test]
    fn font_grants_match_the_resolved_table() {
        let base = fixture("fonts");
        let fonts = base.join("fonts");
        let table = resolve_system_fonts(windows_system_fonts(&fonts), is_grantable_font);
        assert_eq!(
            table.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["arial.ttf", "msyh.ttc"]
        );
        let grants = font_grants(&table);
        assert!(grants.iter().all(|grant| !grant.is_dir));
        let granted: Vec<_> = grants.iter().map(|grant| key(&grant.path)).collect();
        assert_eq!(
            granted,
            vec![key(&fonts.join("arial.ttf")), key(&fonts.join("msyh.ttc"))]
        );
        let handed: Vec<_> = font_table(&table)
            .values()
            .map(|path| key(Path::new(path)))
            .collect();
        assert_eq!(handed, granted);
        // 字体目录不存在：空表、没有放行项
        let missing = resolve_system_fonts(
            windows_system_fonts(&base.join("missing-fonts")),
            is_grantable_font,
        );
        assert!(missing.is_empty() && font_grants(&missing).is_empty());
        let _ = fs::remove_dir_all(base);
    }

    /// 名字在 Windows 上不分大小写（`Malgun.ttf` 实际多是 `malgun.ttf`）：表里的键照旧是 `Malgun.ttf`，放行的是那个文件。
    #[cfg(windows)]
    #[test]
    fn windows_names_ignore_case() {
        let base = fixture("fonts-case");
        let fonts = base.join("fonts");
        fs::write(fonts.join("malgun.ttf"), "font").unwrap();
        let table = resolve_system_fonts(windows_system_fonts(&fonts), is_grantable_font);
        let path = table.get("Malgun.ttf").expect("Malgun.ttf");
        assert_eq!(key(path), key(&fonts.join("malgun.ttf")));
        let granted: Vec<_> = font_grants(&table)
            .iter()
            .map(|grant| key(&grant.path))
            .collect();
        assert!(
            granted.contains(&key(&fonts.join("malgun.ttf"))),
            "{granted:?}"
        );
        let _ = fs::remove_dir_all(base);
    }

    /// 候选本身是符号链接时跳过、取下一个（`file:` 闸门不认符号链接；Debian 的 msttcorefonts 小写文件名就是链接）。
    #[cfg(unix)]
    #[test]
    fn symlinked_candidates_are_skipped() {
        let base = fixture("fonts-link");
        let fonts = base.join("fonts");
        fs::write(fonts.join("real.ttf"), "font").unwrap();
        std::os::unix::fs::symlink(fonts.join("real.ttf"), fonts.join("link.ttf")).unwrap();
        let table = resolve_system_fonts(
            [(
                "arial.ttf",
                [fonts.join("link.ttf"), fonts.join("real.ttf")],
            )],
            is_grantable_font,
        );
        assert_eq!(table.get("arial.ttf"), Some(&fonts.join("real.ttf")));
        let _ = fs::remove_dir_all(base);
    }

    /// 真实的 `%WINDIR%\Fonts`：表里只有该目录下的同名文件（本机缺的不在），Windows 自带的 arial.ttf 一定在；
    /// 放行项与表一一对应。
    #[cfg(windows)]
    #[test]
    fn windows_system_fonts_stay_in_the_windows_fonts_dir() {
        let fonts = PathBuf::from(std::env::var_os("WINDIR").unwrap()).join("Fonts");
        let table = platform_system_fonts();
        assert!(table.contains_key("arial.ttf"), "{table:?}");
        let fonts_key = key(&fonts);
        for (name, path) in &table {
            assert!(SYSTEM_FONT_FILES.contains(&name.as_str()), "{name}");
            assert_eq!(key(path), key(&fonts.join(name)));
            assert!(is_within(&key(path), &fonts_key), "{path:?}");
        }
        let grants = font_grants(&table);
        assert_eq!(grants.len(), table.len());
        assert!(grants.iter().all(|grant| !grant.is_dir));
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
