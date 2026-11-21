//! WPE 网页壁纸（`x-wpe/web`）与场景宿主的状态协议。照 WPE 由宿主**推送**（2026-11-21 起，
//! `.claude/plans/wpe-import/2-web/phase-9-parent-delivery.md`）：父页面（应用页里的 `WpeWallpaperContent` /
//! `WpeSceneView`）调 [`wpe_web_get_state`] 取完整状态、自己订阅变化，经 `postMessage` 推给 iframe 里的垫片
//! （`webview_js/wpe_shim.js`）；就绪标志、增量与投递时机都在父页面（`useWpeStateDelivery`），页面自己 reload 不重推。
//!
//! 网页壁纸一律是 `WpeWallpaperContent` 里的 `file:` iframe（图库预览在主窗口，桌面在壁纸窗口）。iframe 里仍有
//! Tauri 的 IPC 桥（runtime 无条件注入每个子 frame），只用来答 ping、订阅音频 / 媒体（[`wpe_web_media_subscribe`]）、
//! 登记原生鼠标；权限只来自 `wpe-web-capability`（绑定 `main` 与 `wallpaper`、`frames: "sub"`、来源 `file:///*`），
//! iframe 拿不到状态、也收不到设置与图片事件。iframe 的 `file:` 请求由运行时闸门按网页壁纸目录索引
//! （`wallpaper::wpe_web_dir_index`）裁决。
//!
//! 状态只在这里计算、每次都读图片当前的 metadata；乱序由父页面按自己的请求编号丢弃。

use crate::wallpaper::wpe_scene_host;
use crate::wallpaper::wpe_web_dir_index::WpeWebDirIndex;
use crate::wpe_media::{MediaGate, WpeMediaFlavor, WpeMediaHub, WpeMediaKind, WpeMediaMessage};
use kabegame_core::app_paths::AppPaths;
use kabegame_core::crawler::downloader::compress::{generate_wallpaper_cover, CoverCrop};
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::media::image_type::wpe_kind;
use kabegame_core::settings::Settings;
use kabegame_core::storage::{ImageInfo, Storage};
use kabegame_core::wpe::fps::{self as wpe_fps, WpeFps};
use kabegame_core::wpe::preview_settings;
use kabegame_core::wpe::project::read_project;
use kabegame_core::wpe::properties::{resolve_web_user_props, wpe_language_code};
use kabegame_core::wpe::user_props::{
    apply_changes, list_directory_files, localize, normalize_value, parse_defs,
    parse_user_shortcut, shortcut_key, user_file_grants, user_values, WpeComboOption, WpePropKind,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// 垫片注入脚本（壁纸窗口与主窗口共用，all-frames；只在顶层的直接子 `file:` iframe 里启用）。
pub const WPE_SHIM_JS: &str = include_str!("../webview_js/wpe_shim.js");

/// 父页面推给网页壁纸 / 场景宿主的完整状态。乱序由父页面按自己的请求序号丢弃，这里不带版本号。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebState {
    /// 这张壁纸的 id（父页面已知，原样带回）。
    pub image_id: String,
    /// 推给 `applyUserProperties` 的用户属性：`{ key: { type, value } }`。
    pub user: serde_json::Map<String, serde_json::Value>,
    /// 推给 `applyGeneralProperties` 的通用属性。
    pub general: WpeWebGeneral,
    /// 设了值的 `directory` 属性的文件列表；`fetchall` 由父页面算差异、垫片回调，`ondemand` 由垫片随机取。
    pub directories: BTreeMap<String, WpeWebDirectory>,
}

/// 一个 `directory` 属性的状态：`mode` 缺省按 `fetchall`；`files` 与 `user` 里的路径同形（`/` 分隔）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WpeWebDirectory {
    pub mode: String,
    pub files: Vec<String>,
}

/// 面板的一条属性：标签与选项已本地化（可能含 HTML，前端净化后渲染）；`default` 是归一后的作者默认值，
/// `value` 是当前生效值（用户值优先），`modified` 表示存了用户值。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebPropertyItem {
    pub key: String,
    pub kind: WpePropKind,
    pub label: String,
    pub condition: Option<String>,
    pub default: Option<Value>,
    pub value: Option<Value>,
    pub modified: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub options: Vec<WpeComboOption>,
    pub extensions: Vec<String>,
    pub mode: Option<String>,
}

/// 给属性面板的视图。面板按 `metadata_id` 判断 `metadataId` 补丁是否需要重读。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebPropertiesView {
    pub image_id: String,
    pub metadata_id: Option<i64>,
    /// 封面已换成截取的画面，面板据此显示「恢复默认封面」。
    pub custom_cover: bool,
    pub items: Vec<WpeWebPropertyItem>,
}

/// 标签与选项的本地化（照 WPE 的查找顺序）。没装 WPE 时 `scheme_color` 这一条（几乎每张壁纸都有）
/// 退回 Kabegame 自己的翻译，其余保留原文。
fn localized(raw: &Value, language: &str, text: &str) -> String {
    let value = localize(
        raw,
        language,
        text,
        &kabegame_core::wpe::locale::builtin_term,
    );
    if value == "ui_browse_properties_scheme_color" {
        kabegame_i18n::translate_for_locale(
            "wpe.schemeColor",
            Settings::global().get_resolved_language(),
        )
    } else {
        value
    }
}

fn properties_view(
    image_id: String,
    metadata_id: Option<i64>,
    raw: &Value,
) -> WpeWebPropertiesView {
    let language = wpe_language_code(Settings::global().get_resolved_language());
    properties_view_for_language(image_id, metadata_id, raw, language)
}

fn properties_view_for_language(
    image_id: String,
    metadata_id: Option<i64>,
    raw: &Value,
    language: &str,
) -> WpeWebPropertiesView {
    let user = user_values(raw);
    let items = parse_defs(raw)
        .into_iter()
        .map(|def| {
            let default = def
                .default
                .as_ref()
                .and_then(|v| normalize_value(&def, v).ok());
            let value = user.get(&def.key).cloned().or_else(|| default.clone());
            WpeWebPropertyItem {
                key: def.key.clone(),
                kind: def.kind,
                label: localized(raw, language, &def.text),
                condition: def.condition,
                default,
                value,
                modified: user.contains_key(&def.key),
                min: def.min,
                max: def.max,
                step: def.step,
                options: def
                    .options
                    .into_iter()
                    .map(|option| WpeComboOption {
                        label: localized(raw, language, &option.label),
                        value: option.value,
                    })
                    .collect(),
                extensions: def.extensions,
                mode: def.mode,
            }
        })
        .collect();
    WpeWebPropertiesView {
        image_id,
        metadata_id,
        // 只有面板用得上，由 `get_wpe_web_properties` 按图片行填
        custom_cover: false,
        items,
    }
}

/// 场景宿主的属性值直接取面板同一份归一化结果，避免作者默认值与面板形态分叉。
///
/// `usershortcut` 例外（P11d）：宿主拿不到原值（完整路径不离开后端），给 `{ type, value, isbound, commandtype?, file? }`：
/// `value` 是原值的不可逆键（`shortcut_key`，没配为 `""`），`isbound` 是用户配的值能不能解析，`commandtype` / `file`
/// 只在 `isbound` 时有（WPE 脚本看到的就这三个字段）。只认用户在面板里配过的值（启动命令同规则），作者缺省值不算。
/// 面板读的是 [`properties_view`] 的原值视图，不经这里。
///
/// 这里只有面板能编辑的类型；交给宿主的全集由 [`scene_user_props`] 再补上其余项。
fn scene_user_from_view(view: WpeWebPropertiesView) -> serde_json::Map<String, Value> {
    view.items
        .into_iter()
        .filter(|item| !matches!(item.kind, WpePropKind::Group | WpePropKind::Text))
        .filter_map(|item| {
            if item.kind == WpePropKind::UserShortcut {
                let raw = if item.modified {
                    item.value.as_ref().and_then(Value::as_str).unwrap_or("")
                } else {
                    ""
                };
                return Some((item.key, scene_shortcut_entry(raw)));
            }
            item.value.map(|value| {
                (
                    item.key,
                    serde_json::json!({ "type": item.kind, "value": value }),
                )
            })
        })
        .collect()
}

/// 场景宿主的用户属性全集（宿主据此给脚本 `engine.userProperties` 与首次 `applyUserProperties`，也给绑定取值）。
///
/// 照 WPE（2026-11-21 `kbprops-kinds` 实测）：工程 `general.properties` 里**带 `value` 键**的每一项都在全集里，不看 `type`：
/// `text`、`group`、不认识的类型、没写 `type` 的都算，值为 `null` 的也算；没有 `value` 键的不算。面板能编辑的类型取
/// [`scene_user_from_view`] 的归一化结果，其余项（以及归一化不了的作者值）原样给 `{ type, value }`，没写 `type` 的只给
/// `{ value }`：宿主把这种项挡在首次 `applyUserProperties` 的参数之外、只留在 `engine.userProperties` 里，同 WPE。
/// 2974757317 的 22 段脚本靠 `text` 项 `xian` 在首次 `applyUserProperties` 里初始化，缺了它这些图层的位置全是 NaN。
fn scene_user_props(view: WpeWebPropertiesView, raw: &Value) -> serde_json::Map<String, Value> {
    let mut user = scene_user_from_view(view);
    let Some(props) = raw
        .pointer("/general/properties")
        .and_then(Value::as_object)
    else {
        return user;
    };
    for (key, prop) in props {
        if user.contains_key(key) {
            continue;
        }
        let Some(value) = prop.get("value") else {
            continue;
        };
        let mut entry = serde_json::Map::new();
        if let Some(kind) = prop.get("type") {
            entry.insert("type".into(), kind.clone());
        }
        entry.insert("value".into(), value.clone());
        user.insert(key.clone(), Value::Object(entry));
    }
    user
}

/// 一个快捷方式属性给场景宿主的形状，`raw` 是用户配的原值（没配为空串）。
fn scene_shortcut_entry(raw: &str) -> Value {
    // TODO:[WPE_SCENE] macOS / Linux 上做快捷方式（取图标与启动）：目前只有 Windows，其它平台一律未绑定，
    // 脚本的 `openUserShortcut` 返回 false、图标槽用缺省纹理。
    let parsed = cfg!(windows).then(|| parse_user_shortcut(raw)).flatten();
    let mut entry = serde_json::json!({
        "type": "usershortcut",
        "value": shortcut_key(raw),
        "isbound": parsed.is_some(),
    });
    if let Some(shortcut) = parsed {
        let (commandtype, file) = shortcut.script_fields();
        entry["commandtype"] = commandtype.into();
        entry["file"] = file.into();
    }
    entry
}

/// 属性面板读视图；行不存在或不是 `x-wpe/web` / `x-wpe/scene` 返回 None。只给主窗口（不进 `wpe-web.toml`）。
/// 场景壁纸的用户属性与网页壁纸同一格式（`project.json` 的 `general.properties` + metadata 的 `userProperties`）。
#[tauri::command]
pub async fn get_wpe_web_properties(
    image_id: String,
) -> Result<Option<WpeWebPropertiesView>, String> {
    let Some(info) = Storage::find_image_by_id(&image_id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if !has_user_properties(info.media_type.as_deref()) {
        return Ok(None);
    }
    let id = image_id.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(WpeWebPropertiesView {
        custom_cover: is_custom_cover(&info.thumbnail_path, &AppPaths::global().thumbnails_dir()),
        ..properties_view(image_id, info.metadata_id, &raw.unwrap_or_default())
    }))
}

/// 属性面板写入 `{ key: 新值 | null }`（`null` = 恢复默认），返回保存后的视图。改写 metadata 后发
/// `image-changed { metadataId }`：桌面与预览里的垫片、其它打开的面板都靠这条补丁重拉。页面不能写属性。
#[tauri::command]
pub async fn set_wpe_web_user_properties(
    image_id: String,
    changes: serde_json::Map<String, Value>,
) -> Result<WpeWebPropertiesView, String> {
    let info = Storage::find_image_by_id(&image_id)
        .map_err(|e| e.to_string())?
        .ok_or("image not found")?;
    if !has_user_properties(info.media_type.as_deref()) {
        return Err("not a web or scene wallpaper".into());
    }
    let id = image_id.clone();
    let changed = tauri::async_runtime::spawn_blocking(move || {
        Storage::global().rewrite_image_metadata(&id, |raw| apply_changes(raw, &changes))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(metadata_id) = changed {
        GlobalEmitter::global().emit_image_fields(
            &[image_id.clone()],
            serde_json::json!({ "metadataId": metadata_id }),
        );
    }
    get_wpe_web_properties(image_id)
        .await?
        .ok_or_else(|| "wpe wallpaper row missing".to_string())
}

/// 带作者用户属性的 WPE 类型：网页与场景。
fn has_user_properties(media_type: Option<&str>) -> bool {
    matches!(wpe_kind(media_type).as_deref(), Some("web" | "scene"))
}

const MAIN_WEBVIEW_LABEL: &str = "main";

/// 封面是不是应用自己生成的：在 `thumbnails_dir` 里。作者的 `preview.*` 在壁纸目录，没有预览图时是目录本身。
fn is_custom_cover(thumbnail_path: &str, thumbnails_dir: &Path) -> bool {
    let thumbnail_path = thumbnail_path.trim();
    !thumbnail_path.is_empty() && Path::new(thumbnail_path).starts_with(thumbnails_dir)
}

/// 恢复默认封面时的 `thumbnail_path`，与导入一致：作者预览图去掉 `\\?\`，没有时用 `local_path`
/// （同 `add_image` 的兜底）。
fn default_cover_path(preview: Option<&Path>, local_path: &str) -> String {
    preview
        .map(|path| {
            path.to_string_lossy()
                .trim_start_matches("\\\\?\\")
                .to_string()
        })
        .unwrap_or_else(|| local_path.to_string())
}

fn find_wallpaper_with_cover(image_id: &str) -> Result<ImageInfo, String> {
    let info = Storage::find_image_by_id(image_id)
        .map_err(|e| e.to_string())?
        .ok_or("image not found")?;
    if !has_user_properties(info.media_type.as_deref()) {
        return Err("not a web or scene wallpaper".into());
    }
    Ok(info)
}

/// 换 `thumbnail_path` 并发字段补丁，返回新路径。旧封面按归属清理：只删 `thumbnails_dir` 里的文件，
/// 作者的 `preview.*` 不动。场景的退回画面取的也是它，下次取壁纸目标时跟着变。
async fn replace_cover(image_id: String, path: String) -> Result<String, String> {
    let (id, target) = (image_id.clone(), path.clone());
    tauri::async_runtime::spawn_blocking(move || {
        Storage::global().replace_image_thumbnail_path(&id, &target)
    })
    .await
    .map_err(|e| e.to_string())??;
    GlobalEmitter::global().emit_image_fields(
        std::slice::from_ref(&image_id),
        serde_json::json!({ "thumbnailPath": path }),
    );
    Ok(path)
}

/// 把预览画布当前的画面设为封面，返回新封面路径。`region` 是画布占主窗口内容区的比例：截整窗再裁，为什么不用
/// `clip` 见 [`tauri_runtime_kbcef::capture_screenshot`]。在浏览器层截图，网页和场景走同一条路：`file:` iframe 跨源，
/// 应用页读不到它的像素。暂停时截到的就是停住的那一帧。按钮只在画面确定实时渲染时显示，这里不再校验。
/// 只给应用页（不进 `wpe-web.toml`）。
#[tauri::command]
pub async fn capture_wallpaper_cover(
    image_id: String,
    region: CoverCrop,
) -> Result<String, String> {
    find_wallpaper_with_cover(&image_id)?;
    let screenshot = tauri_runtime_kbcef::capture_screenshot(MAIN_WEBVIEW_LABEL).await?;
    let cover = generate_wallpaper_cover(&screenshot, region).await?;
    replace_cover(image_id, cover.to_string_lossy().into_owned())
        .await
        .inspect_err(|_| {
            // 没换上的封面没有行引用它，留着就成了孤儿文件
            let _ = std::fs::remove_file(&cover);
        })
}

/// 恢复作者的预览图，返回恢复后的路径。`project.json` 读不了时（目录被移走）按没有预览图处理。
/// 只给应用页（不进 `wpe-web.toml`）。
#[tauri::command]
pub async fn restore_wallpaper_cover(image_id: String) -> Result<String, String> {
    let info = find_wallpaper_with_cover(&image_id)?;
    let dir = info.local_path.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        read_project(Path::new(&dir))
            .ok()
            .and_then(|project| project.preview_path())
    })
    .await
    .map_err(|e| e.to_string())?;
    let path = default_cover_path(preview.as_deref(), &info.local_path);
    replace_cover(image_id, path).await
}

fn path_for_page(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 通用属性，垫片经 `applyGeneralProperties` 交给页面（WPE 网页壁纸协议），场景宿主也从这里取帧率。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WpeWebGeneral {
    /// WPE 语言码（`zh-chs` / `zh-cht` / `en-us` / `ja-jp` / `ko-kr`）。
    pub language: &'static str,
    /// 解析后的帧率（正整数，`wpe::fps::resolve`）。不会是 0：按 `1000 / fps` 算间隔的页面会停住。
    pub fps: u32,
}

/// 设置取哪一份：桌面（壁纸窗口）取全局设置，预览与应用背景（主窗口）取这张图 metadata 的 `previewSettings`；
/// 与媒体集成的分流同一规则（[`wpe_web_media_subscribe`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WpeSettingsSource {
    Desktop,
    Preview,
}

impl WpeSettingsSource {
    pub fn of_label(label: &str) -> Self {
        if crate::wallpaper::is_wallpaper_label(label) {
            Self::Desktop
        } else {
            Self::Preview
        }
    }
}

/// 按 id 组装状态，每次都读图片当前的 metadata（导入时存的 `project.json` 原文）；
/// 行不存在或不是 `x-wpe/web` / `x-wpe/scene` 返回 None。场景的 directories 为空。
pub async fn build_wpe_web_state(
    image_id: &str,
    source: WpeSettingsSource,
) -> Result<Option<WpeWebState>, String> {
    Ok(build_wpe_web_state_with_raw(image_id, source)
        .await?
        .map(|(state, _)| state))
}

/// 帧率设置解析成生效值。跟随 WPE 第一次要读 `config.json`（经 `engine_dir` 碰 Storage），放到阻塞线程。
async fn resolve_fps(source: WpeSettingsSource, raw: &Value) -> Result<u32, String> {
    let fps = match source {
        WpeSettingsSource::Desktop => Settings::global().get_wpe_fps(),
        WpeSettingsSource::Preview => preview_settings::fps(raw),
    };
    match fps {
        WpeFps::Fixed(fps) => Ok(fps),
        WpeFps::Follow => tauri::async_runtime::spawn_blocking(move || wpe_fps::resolve(fps))
            .await
            .map_err(|error| error.to_string()),
    }
}

async fn build_wpe_web_state_with_raw(
    image_id: &str,
    source: WpeSettingsSource,
) -> Result<Option<(WpeWebState, Value)>, String> {
    let Some(info) =
        Storage::find_image_by_id(image_id).map_err(|e| format!("Storage error: {}", e))?
    else {
        return Ok(None);
    };
    if !has_user_properties(info.media_type.as_deref()) {
        return Ok(None);
    }
    let id = info.id.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|error| error.to_string())??;
    // metadata 缺失时按「作者没有声明属性」处理，页面照常收到空的用户属性。
    let is_scene = wpe_kind(info.media_type.as_deref()).as_deref() == Some("scene");
    let user = if is_scene {
        let raw = raw.as_ref().unwrap_or(&Value::Null);
        scene_user_props(properties_view(info.id.clone(), info.metadata_id, raw), raw)
    } else {
        raw.as_ref().map(resolve_web_user_props).unwrap_or_default()
    };
    let raw = raw.unwrap_or_default();
    let directories = if is_scene {
        BTreeMap::new()
    } else {
        tauri::async_runtime::spawn_blocking({
            let raw = raw.clone();
            move || {
                let values = user_values(&raw);
                parse_defs(&raw)
                    .into_iter()
                    .filter(|def| def.kind == WpePropKind::Directory)
                    .filter_map(|def| {
                        let path = values.get(&def.key)?.as_str()?;
                        if path.is_empty() {
                            return None;
                        }
                        Some((
                            def.key,
                            WpeWebDirectory {
                                mode: def.mode.unwrap_or_else(|| "fetchall".into()),
                                files: list_directory_files(Path::new(path), 10000)
                                    .iter()
                                    .map(|p| path_for_page(p))
                                    .collect(),
                            },
                        ))
                    })
                    .collect::<BTreeMap<_, _>>()
            }
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let fps = resolve_fps(source, &raw).await?;
    Ok(Some((
        WpeWebState {
            image_id: info.id,
            user,
            general: WpeWebGeneral {
                language: wpe_language_code(Settings::global().get_resolved_language()),
                fps,
            },
            directories,
        },
        raw,
    )))
}

/// 父页面（主窗口 / 壁纸窗口的应用页，免 ACL，不进任何 permission）取一张网页 / 场景壁纸要推给 iframe 的状态
/// （`useWpeStateDelivery`）。照 WPE 由宿主推送：iframe 不再自己拉，页面自己 reload 时父页面不重推。
///
/// 返回之前用同一份 metadata 覆盖这张壁纸的 `file:` 放行（网页壁纸的 `file` / `directory`、场景的 `scenetexture`）：
/// 页面只能从推来的状态得知用户新选的路径，拿到时闸门一定已经认它；撤销旧选择由目录索引跟随 `metadataId` 补丁完成。
///
/// `general.fps` 按调用方所在窗口取设置（[`WpeSettingsSource`]）：桌面改全局 `wpeFps` 时父页面因 `setting-change`
/// 重取，预览改 `previewSettings` 时因 `metadataId` 补丁重取。行不存在或不是 `x-wpe/web` / `x-wpe/scene` 时返回 None。
#[tauri::command]
pub async fn wpe_web_get_state<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    image_id: String,
) -> Result<Option<WpeWebState>, String> {
    let source = WpeSettingsSource::of_label(webview.label());
    let Some((state, raw)) = build_wpe_web_state_with_raw(&image_id, source).await? else {
        return Ok(None);
    };
    WpeWebDirIndex::global().replace_grants(&state.image_id, user_file_grants(&raw));
    Ok(Some(state))
}

/// 网页壁纸订阅音频（`audio`）或媒体会话（`media`）数据，经 `channel` 推回调用的 iframe。
///
/// 预览（主窗口）与桌面（壁纸窗口）的网页壁纸 iframe 走同一条路：按调用方文档在网页壁纸目录索引里认出是哪张
/// （CEF runtime 把 `file:` frame 的 `Origin` 改写成完整文档 URL，页面伪造不了）；场景宿主也是子 frame，它的确切入口文档必须传库内场景壁纸的 `image_id`
/// （SceneScript 的 `engine.registerAudioBuffers`），网页壁纸的垫片不传。订阅归属调用方 frame，frame 销毁
/// 即释放（`lib.rs` 的 `on_webview_event`），同一 frame 再订阅同一类替换旧条，所以没有退订命令。只接受
/// 子 frame：两个窗口的主 frame 是应用页。`audio` 只对 `general.supportsaudioprocessing: true` 的壁纸放行
/// （照 WPE）。本平台没有这一类的数据源（`audio` 在 Windows / macOS 有，`media` 只在 Windows）时返回错误，
/// 垫片与宿主都忽略。
#[tauri::command]
pub async fn wpe_web_media_subscribe<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    caller: tauri::ipc::CallerOrigin,
    frame: tauri::ipc::CallerFrame,
    kind: WpeMediaKind,
    channel: tauri::ipc::Channel<WpeMediaMessage>,
    image_id: Option<String>,
) -> Result<(), String> {
    let tauri::ipc::CallerFrame::Sub(frame) = frame else {
        return Err("only web wallpaper frames can subscribe".to_string());
    };
    if !crate::wpe_media::kind_available(kind) {
        return Err(format!(
            "web wallpaper {kind:?} data is not available on this platform"
        ));
    }
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    // 投影由调用方文档决定：场景宿主入口文档收 WPE 的数据（整秒时间轴、原尺寸封面），网页壁纸目录里的文档收
    // Phase 8 的数据；页面不能自己选
    let (id, flavor) = match index.image_id_of(&doc) {
        Some(id) => (id, WpeMediaFlavor::Web),
        None if wpe_scene_host::is_host_document(&doc) => {
            let id = image_id.ok_or("the scene host must pass imageId")?;
            if !index.is_scene(&id) {
                return Err("not a scene wallpaper in the library".into());
            }
            (id, WpeMediaFlavor::Scene)
        }
        None => return Err("not inside a web wallpaper".into()),
    };
    if kind == WpeMediaKind::Audio && !supports_audio_processing(&id).await? {
        return Err("this wallpaper does not process audio".to_string());
    }
    // 「媒体集成」开关：壁纸窗口跟全局设置，主窗口（预览与应用背景）跟这张壁纸的预览设置
    let label = webview.label();
    if crate::wallpaper::is_wallpaper_label(label) {
        WpeMediaHub::global().subscribe(label, frame, kind, flavor, Box::new(channel));
    } else {
        let enabled = kind == WpeMediaKind::Media && preview_media_integration(&id).await?;
        WpeMediaHub::global().subscribe_gated(
            label,
            frame,
            kind,
            flavor,
            MediaGate::Preview { image_id: id },
            enabled,
            Box::new(channel),
        );
    }
    Ok(())
}

/// 这张壁纸预览设置里的「媒体集成」（没设取默认开）。
async fn preview_media_integration(image_id: &str) -> Result<bool, String> {
    let id = image_id.to_string();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|error| error.to_string())??;
    Ok(raw
        .as_ref()
        .map_or(true, preview_settings::media_integration))
}

/// 预览设置的读视图：`settings` 是存了的键（规整过），没设的项由前端按默认值显示。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpePreviewSettingsView {
    pub image_id: String,
    pub metadata_id: Option<i64>,
    pub settings: serde_json::Map<String, Value>,
}

/// 读一张 WPE 壁纸（`x-wpe/*`）的预览设置；行不存在或不是 WPE 返回 None。只给主窗口。
#[tauri::command]
pub async fn get_wpe_preview_settings(
    image_id: String,
) -> Result<Option<WpePreviewSettingsView>, String> {
    let Some(info) = Storage::find_image_by_id(&image_id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if wpe_kind(info.media_type.as_deref()).is_none() {
        return Ok(None);
    }
    let id = image_id.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(WpePreviewSettingsView {
        image_id,
        metadata_id: info.metadata_id,
        settings: preview_settings::stored(&raw.unwrap_or_default()),
    }))
}

/// 写预览设置 `{ key: 新值 | null }`（`null` = 恢复默认），返回保存后的视图。改写 metadata 后发
/// `image-changed { metadataId }`，打开着的预览与面板靠它重读；媒体集成变了另通知 hub 改这张的预览订阅。
#[tauri::command]
pub async fn set_wpe_preview_settings(
    image_id: String,
    changes: serde_json::Map<String, Value>,
) -> Result<WpePreviewSettingsView, String> {
    let info = Storage::find_image_by_id(&image_id)
        .map_err(|e| e.to_string())?
        .ok_or("image not found")?;
    if wpe_kind(info.media_type.as_deref()).is_none() {
        return Err("not a wallpaper engine wallpaper".into());
    }
    let id = image_id.clone();
    let changed = tauri::async_runtime::spawn_blocking(move || {
        Storage::global()
            .rewrite_image_metadata(&id, |raw| preview_settings::apply_changes(raw, &changes))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(metadata_id) = changed {
        GlobalEmitter::global().emit_image_fields(
            &[image_id.clone()],
            serde_json::json!({ "metadataId": metadata_id }),
        );
    }
    let view = get_wpe_preview_settings(image_id.clone())
        .await?
        .ok_or_else(|| "wpe wallpaper row missing".to_string())?;
    if let Some(hub) = WpeMediaHub::existing() {
        let enabled = view
            .settings
            .get("mediaIntegration")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        hub.set_preview_enabled(&image_id, enabled);
    }
    Ok(view)
}

/// 设置项能不能提供「跟随 Wallpaper Engine」：只在 Windows 上、且 WPE 安装目录里有 `config.json` 时可以
/// （场景宿主按它解析后处理 / 反射 / 阴影）。其它情况下界面不给这一档，存着的 `follow` 按 Kabegame 默认值显示与解析。
#[tauri::command]
pub async fn get_wpe_follow_available() -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
        // WPE 只能在 Windows 上运行，别的系统没有在跑的 WPE 可跟随；从别的机器拷来的 `config.json` 也不算
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(|| {
        kabegame_core::wpe::discover::engine_dir()
            .is_some_and(|dir| dir.join("config.json").is_file())
    })
    .await
    .map_err(|e| e.to_string())
}

/// 取不到显示器刷新率时帧率滑块的上限（Linux 等）。
const FALLBACK_MAX_REFRESH_RATE: u32 = 60;

/// WPE 壁纸帧率滑块的上限：所有在线显示器里最高的刷新率（同 WPE 设置界面的 `runtime.frequencymax`），
/// 取不到时 60。macOS 要在主线程读 `NSScreen`，放到阻塞线程里同步派过去。
#[tauri::command]
pub async fn get_display_max_refresh_rate() -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::wallpaper::screens::max_refresh_rate()
            .filter(|fps| *fps >= wpe_fps::WPE_FPS_MIN)
            .unwrap_or(FALLBACK_MAX_REFRESH_RATE)
    })
    .await
    .map_err(|e| e.to_string())
}

/// 壁纸是否声明处理音频：读图片 metadata（即 `project.json` 原文）的 `general.supportsaudioprocessing`。
async fn supports_audio_processing(image_id: &str) -> Result<bool, String> {
    let id = image_id.to_string();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|error| error.to_string())??;
    Ok(raw.as_ref().is_some_and(declares_audio_processing))
}

/// 只有显式 `true` 才算（缺失按 `false`，与 WPE 一致）。
fn declares_audio_processing(raw: &Value) -> bool {
    raw.pointer("/general/supportsaudioprocessing")
        .and_then(Value::as_bool)
        == Some(true)
}

/// 调用方来源对应的本地文档路径；只认 `file:`（`Url::to_file_path` 本身不看 scheme，`tauri://localhost/`
/// 也会被转成 `/`）。
fn caller_document(origin: &url::Url) -> Option<std::path::PathBuf> {
    if origin.scheme() != "file" {
        return None;
    }
    origin.to_file_path().ok()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use tauri::utils::acl::RemoteUrlPattern;
    use url::Url;

    /// 自定义封面在 `thumbnails_dir` 里；作者预览图、目录兜底、前缀相同的别的目录都不算。
    #[test]
    fn custom_cover_means_inside_thumbnails_dir() {
        use super::is_custom_cover;
        use std::path::Path;
        let dir = Path::new("/data/thumbnails");
        assert!(is_custom_cover("/data/thumbnails/a.jpg", dir));
        assert!(!is_custom_cover("/steam/431960/1/preview.jpg", dir));
        assert!(!is_custom_cover("/steam/431960/1", dir));
        assert!(!is_custom_cover("/data/thumbnails-old/a.jpg", dir));
        assert!(!is_custom_cover("  ", dir));
    }

    /// 恢复默认封面：有预览图取预览图（去掉 `\\?\`），没有时取 `local_path`。
    #[test]
    fn default_cover_prefers_the_author_preview() {
        use super::default_cover_path;
        use std::path::Path;
        assert_eq!(
            default_cover_path(Some(Path::new(r"\\?\D:\wpe\1\preview.jpg")), r"D:\wpe\1"),
            r"D:\wpe\1\preview.jpg"
        );
        assert_eq!(
            default_cover_path(Some(Path::new(r"D:\wpe\1\preview.gif")), r"D:\wpe\1"),
            r"D:\wpe\1\preview.gif"
        );
        assert_eq!(default_cover_path(None, r"D:\wpe\1"), r"D:\wpe\1");
    }

    /// 面板传来的形状：画布占窗口内容区的比例。
    #[test]
    fn cover_region_uses_the_panel_shape() {
        use kabegame_core::crawler::downloader::compress::CoverCrop;
        assert_eq!(
            serde_json::from_value::<CoverCrop>(serde_json::json!({
                "x": 0.25, "y": 0.5, "width": 0.5, "height": 0.25
            }))
            .unwrap(),
            CoverCrop {
                x: 0.25,
                y: 0.5,
                width: 0.5,
                height: 0.25
            }
        );
    }

    /// 音频订阅只认显式 `general.supportsaudioprocessing: true`。
    #[test]
    fn audio_processing_needs_explicit_true() {
        use super::declares_audio_processing;
        use serde_json::json;
        assert!(declares_audio_processing(
            &json!({ "general": { "supportsaudioprocessing": true } })
        ));
        assert!(!declares_audio_processing(
            &json!({ "general": { "supportsaudioprocessing": false } })
        ));
        assert!(!declares_audio_processing(&json!({ "general": {} })));
        assert!(!declares_audio_processing(
            &json!({ "general": { "supportsaudioprocessing": "true" } })
        ));
    }

    /// `wpe-web-capability` 匹配预览与桌面的网页壁纸 iframe，只绑定 main 和 wallpaper 的子 frame。
    #[test]
    fn wpe_web_capability_pattern_matches_file_urls() {
        let pattern = RemoteUrlPattern::from_str("file:///*").expect("file:///* 应能解析");
        let entry = Url::parse(
            "file:///D:/Applications/Steam/steamapps/workshop/content/431960/3679122549/index.html",
        )
        .unwrap();
        assert!(pattern.test(&entry));
        // 百分号编码路径（含空格、中文目录）
        let encoded = Url::parse("file:///D:/WPE%20Lib/%E5%A3%81%E7%BA%B8/index.html").unwrap();
        assert!(pattern.test(&encoded));
        // cef-ipc 回退通道交给 Tauri 的 `file://localhost/…` 经 url 归一后同样匹配
        let localhost = Url::parse("file://localhost/D:/x/y/index.html").unwrap();
        assert!(pattern.test(&localhost));
        assert!(!pattern.test(&Url::parse("http://127.0.0.1/").unwrap()));
        assert!(!pattern.test(&Url::parse("http://127.0.0.1:33050/index.html").unwrap()));
        assert!(!pattern.test(&Url::parse("http://tauri.localhost/index.html").unwrap()));
        assert!(!pattern.test(&Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(!pattern.test(&Url::parse("https://example.com/").unwrap()));
    }

    /// `wpe_web_media_subscribe` 按调用方来源认文档：`file://localhost/…` 归一后能还原成本地路径，
    /// 非 `file:` 来源（应用页、远程站点、占位来源）一律不认，命令报错。
    #[test]
    fn caller_origin_maps_to_a_document_path() {
        let entry = Url::parse("file://localhost/tmp/wpe/index.html").unwrap();
        assert_eq!(entry.as_str(), "file:///tmp/wpe/index.html");
        #[cfg(unix)]
        assert_eq!(
            super::caller_document(&entry),
            Some(std::path::PathBuf::from("/tmp/wpe/index.html"))
        );
        for origin in [
            "tauri://localhost/",
            "http://localhost:1420/",
            "https://example.com/",
            "kabegame-unattributed://ipc/",
        ] {
            assert_eq!(
                super::caller_document(&Url::parse(origin).unwrap()),
                None,
                "{origin}"
            );
        }
    }

    #[test]
    fn scene_user_values_match_property_items() {
        use serde_json::json;
        let raw = json!({
            "general": { "properties": {
                "speed": { "type": "slider", "value": 1, "min": 0, "max": 3 },
                "enabled": { "type": "bool", "value": false },
                "default_bool": { "type": "bool", "value": 0 },
                "label": { "type": "text", "value": "read only" }
            } },
            "userProperties": { "speed": 1.5, "enabled": true }
        });
        let view = super::properties_view_for_language("scene".into(), None, &raw, "en-us");
        let state_user = super::scene_user_from_view(super::properties_view_for_language(
            "scene".into(),
            None,
            &raw,
            "en-us",
        ));
        for item in view.items {
            if let Some(entry) = state_user.get(&item.key) {
                assert_eq!(entry.get("value"), item.value.as_ref(), "{}", item.key);
            }
        }
        assert_eq!(state_user["speed"]["value"], json!(1.5));
        assert_eq!(state_user["enabled"]["value"], json!(true));
        assert_eq!(state_user["default_bool"]["value"], json!(false));
        assert!(!state_user.contains_key("label"));
    }

    /// 场景全集照 WPE（`kbprops-kinds` 实测）：带 `value` 键的项都在，不看 `type`；没有 `value` 的不在；没写 `type` 的只给 `{ value }`。
    #[test]
    fn scene_user_props_follow_wpe_value_rule() {
        use serde_json::json;
        let raw = json!({
            "general": { "properties": {
                "p_bool": { "type": "bool", "text": "B", "value": true },
                "p_text_val": { "type": "text", "text": "T", "value": false },
                "p_text_str": { "type": "text", "text": "S", "value": "abc" },
                "p_text_noval": { "type": "text", "text": "N" },
                "p_notype": { "text": "no type" },
                "p_notype_val": { "text": "no type v", "value": 7 },
                "p_group": { "type": "group", "text": "G" },
                "p_group_val": { "type": "group", "text": "G2", "value": true },
                "p_unknown": { "type": "foo", "text": "U", "value": 3 },
                "p_null": { "type": "slider", "text": "Z", "value": null, "min": 0, "max": 1 },
                "p_bool_noval": { "type": "bool", "text": "B" }
            } },
            "userProperties": {}
        });
        let user = super::scene_user_props(
            super::properties_view_for_language("scene".into(), None, &raw, "en-us"),
            &raw,
        );
        let mut keys: Vec<_> = user.keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "p_bool",
                "p_group_val",
                "p_notype_val",
                "p_null",
                "p_text_str",
                "p_text_val",
                "p_unknown"
            ]
        );
        assert_eq!(user["p_bool"], json!({ "type": "bool", "value": true }));
        assert_eq!(
            user["p_text_val"],
            json!({ "type": "text", "value": false })
        );
        assert_eq!(
            user["p_group_val"],
            json!({ "type": "group", "value": true })
        );
        assert_eq!(user["p_unknown"], json!({ "type": "foo", "value": 3 }));
        assert_eq!(user["p_null"], json!({ "type": "slider", "value": null }));
        assert_eq!(user["p_notype_val"], json!({ "value": 7 }));
    }

    /// 快捷方式属性给宿主的形状：只有键与三个字段，没有原值；没绑定时只有 `isbound`。
    #[test]
    fn scene_shortcut_entries_hide_the_raw_value() {
        use serde_json::json;
        let raw = json!({
            "general": { "properties": {
                "app": { "type": "usershortcut", "text": "App", "value": "" },
                "other": { "type": "usershortcut", "text": "Other", "value": "" },
                "empty": { "type": "usershortcut", "text": "Empty", "value": "" },
                "bad": { "type": "usershortcut", "text": "Bad", "value": "" },
                "textinput": { "type": "textinput", "value": "file:C:/a.exe" }
            } },
            "userProperties": {
                "app": "cmd:calc /x",
                "other": "file:C:/Users/me/Secret.lnk|-x",
                "bad": "garbage"
            }
        });
        let user = super::scene_user_from_view(super::properties_view_for_language(
            "scene".into(),
            None,
            &raw,
            "en-us",
        ));
        let app = &user["app"];
        assert_eq!(app["type"], json!("usershortcut"));
        assert_eq!(app["value"], json!(super::shortcut_key("cmd:calc /x")));
        // 没配、格式不对：只有 isbound（`value` 是空串或键）
        let empty = user["empty"].as_object().unwrap();
        assert_eq!(empty["value"], json!(""));
        assert_eq!(empty["isbound"], json!(false));
        assert!(!empty.contains_key("commandtype") && !empty.contains_key("file"));
        let bad = user["bad"].as_object().unwrap();
        assert_eq!(bad["isbound"], json!(false));
        assert!(!bad.contains_key("commandtype") && !bad.contains_key("file"));
        if cfg!(windows) {
            assert_eq!(app["isbound"], json!(true));
            assert_eq!(app["commandtype"], json!("command"));
            assert_eq!(app["file"], json!("calc"));
            assert_eq!(user["other"]["commandtype"], json!("file"));
            assert_eq!(user["other"]["file"], json!("Secret.lnk"));
        } else {
            assert_eq!(app["isbound"], json!(false));
            assert!(app.get("file").is_none());
        }
        // 原值（路径、参数）任何字段里都没有
        let dump = serde_json::to_string(&user).unwrap();
        assert!(!dump.contains("calc /x") && !dump.contains("Users") && !dump.contains("-x"));
        // 同名的 textinput 属性不受影响，照旧给 { type, value }
        assert_eq!(user["textinput"]["type"], json!("textinput"));
        // 面板的视图仍然是原值
        let view = super::properties_view_for_language("scene".into(), None, &raw, "en-us");
        let item = view.items.iter().find(|item| item.key == "app").unwrap();
        assert_eq!(item.value, Some(json!("cmd:calc /x")));
        // 只有作者缺省值（用户没配）不算绑定，即使缺省值本身合法
        let mut only_default = raw.clone();
        only_default["general"]["properties"]["app"]["value"] = json!("cmd:calc");
        only_default["userProperties"] = json!({});
        let user = super::scene_user_from_view(super::properties_view_for_language(
            "scene".into(),
            None,
            &only_default,
            "en-us",
        ));
        assert_eq!(user["app"]["isbound"], json!(false));
        assert_eq!(user["app"]["value"], json!(""));
    }
}
