//! WPE 网页壁纸（`x-wpe/web`）与场景宿主的状态协议：页面里的垫片（`webview_js/wpe_shim.js`）向宿主
//! **拉取**完整状态，自己订阅应用事件、看到相关变化就重拉，差异与投递时机全由垫片决定。
//!
//! 网页壁纸一律是 `WallpaperStage` web 层里的 `file:` iframe（图库预览在主窗口，桌面在壁纸窗口），垫片只有
//! 一种传输：iframe 里有 Tauri 的 IPC 桥（runtime 无条件注入每个子 frame），直接调 [`wpe_web_pull_state`]
//! 与 `plugin:event|listen`。权限只来自 `wpe-web-capability`（绑定 `main` 与 `wallpaper`、`frames: "sub"`、
//! 来源 `file:///*`），事件只投递到这个 iframe，iframe 销毁时它的监听随 `SubframeDestroyed` 清掉。
//! iframe 的 `file:` 请求由运行时闸门按网页壁纸目录索引（`wallpaper::wpe_web_dir_index`）裁决。
//!
//! 状态只在这里计算、每次都读图片当前的 metadata；宿主不推状态、不排队、不记版本号，乱序由垫片
//! 按自己的拉取编号丢弃。

use crate::wallpaper::wpe_scene_host;
use crate::wallpaper::wpe_web_dir_index::WpeWebDirIndex;
use crate::wpe_media::{WpeMediaHub, WpeMediaKind, WpeMediaMessage};
use kabegame_core::app_paths::AppPaths;
use kabegame_core::crawler::downloader::compress::{generate_wallpaper_cover, CoverCrop};
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::media::image_type::wpe_kind;
use kabegame_core::settings::Settings;
use kabegame_core::storage::{ImageInfo, Storage};
use kabegame_core::wpe::project::read_project;
use kabegame_core::wpe::properties::{resolve_web_user_props, wpe_language_code};
use kabegame_core::wpe::user_props::{
    apply_changes, list_directory_files, localize, normalize_value, parse_defs, user_file_grants,
    user_values, WpeComboOption, WpePropKind,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// 垫片注入脚本（壁纸窗口与主窗口共用，all-frames；只在顶层的直接子 `file:` iframe 里启用）。
pub const WPE_SHIM_JS: &str = include_str!("../webview_js/wpe_shim.js");

/// 网页壁纸页面拉取的完整状态。乱序由垫片按自己的拉取序号丢弃，这里不带版本号。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeWebState {
    /// 垫片按它过滤 `metadataId` 补丁（只认本张）。
    pub image_id: String,
    /// 推给 `applyUserProperties` 的用户属性：`{ key: { type, value } }`。
    pub user: serde_json::Map<String, serde_json::Value>,
    /// 推给 `applyGeneralProperties` 的通用属性。
    pub general: WpeWebGeneral,
    /// 设了值的 `directory` 属性的文件列表；`fetchall` 由垫片按差异回调，`ondemand` 由垫片随机取。
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
fn scene_user_from_view(view: WpeWebPropertiesView) -> serde_json::Map<String, Value> {
    view.items
        .into_iter()
        .filter(|item| !matches!(item.kind, WpePropKind::Group | WpePropKind::Text))
        .filter_map(|item| {
            item.value.map(|value| {
                (
                    item.key,
                    serde_json::json!({ "type": item.kind, "value": value }),
                )
            })
        })
        .collect()
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

/// 通用属性：第一版只有界面语言。`fps` 等到 Phase 6 有了设置再推（推 0 会让按 `1000 / fps`
/// 算间隔的页面停住）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WpeWebGeneral {
    /// WPE 语言码（`zh-chs` / `zh-cht` / `en-us` / `ja-jp` / `ko-kr`）。
    pub language: &'static str,
}

/// 按 id 组装状态，每次都读图片当前的 metadata（导入时存的 `project.json` 原文）；
/// 行不存在或不是 `x-wpe/web` / `x-wpe/scene` 返回 None。场景的 directories 为空。
pub async fn build_wpe_web_state(image_id: &str) -> Result<Option<WpeWebState>, String> {
    Ok(build_wpe_web_state_with_raw(image_id)
        .await?
        .map(|(state, _)| state))
}

async fn build_wpe_web_state_with_raw(
    image_id: &str,
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
        scene_user_from_view(properties_view(
            info.id.clone(),
            info.metadata_id,
            raw.as_ref().unwrap_or(&Value::Null),
        ))
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
    Ok(Some((
        WpeWebState {
            image_id: info.id,
            user,
            general: WpeWebGeneral {
                language: wpe_language_code(Settings::global().get_resolved_language()),
            },
            directories,
        },
        raw,
    )))
}

/// 网页壁纸页面（`file:` iframe，wpe-web-capability，`frames: "sub"`）拉取状态。普通网页壁纸不看传入的 id：
/// 按调用方自己的文档 URL（CEF runtime 把 `file:` frame 的 `Origin` 改写成完整文档 URL，页面伪造不了）
/// 在网页壁纸目录索引里找到它所在的那张，页面拿不到别的图片的 metadata。场景宿主的确切入口文档
/// 则必须传库内场景壁纸的 id；不写用户文件 grants。
///
/// 返回之前用同一份 metadata 覆盖这张壁纸的 `file:` 放行：页面只能从拉取结果得知用户新选的路径，拿到时
/// 闸门一定已经认它；撤销旧选择由目录索引跟随 `metadataId` 补丁完成。
#[tauri::command]
pub async fn wpe_web_pull_state(
    caller: tauri::ipc::CallerOrigin,
    image_id: Option<String>,
) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    if let Some(id) = index.image_id_of(&doc) {
        let (state, raw) = build_wpe_web_state_with_raw(&id)
            .await?
            .ok_or_else(|| "web wallpaper row missing".to_string())?;
        index.replace_grants(&id, user_file_grants(&raw));
        return Ok(state);
    }
    if wpe_scene_host::is_host_document(&doc) {
        let id = image_id.ok_or("the scene host must pass imageId")?;
        if !index.is_scene(&id) {
            return Err("not a scene wallpaper in the library".into());
        }
        return build_wpe_web_state(&id)
            .await?
            .ok_or_else(|| "scene wallpaper row missing".into());
    }
    Err("not inside a web wallpaper".into())
}

/// 网页壁纸订阅音频（`audio`）或媒体会话（`media`）数据，经 `channel` 推回调用的 iframe。
///
/// 预览（主窗口）与桌面（壁纸窗口）的网页壁纸 iframe 走同一条路：按调用方文档认出是哪张（同
/// [`wpe_web_pull_state`]）；场景宿主也是子 frame，它的确切入口文档必须传库内场景壁纸的 `image_id`
/// （SceneScript 的 `engine.registerAudioBuffers`），网页壁纸的垫片不传。订阅归属调用方 frame，frame 销毁
/// 即释放（`lib.rs` 的 `on_webview_event`），同一 frame 再订阅同一类替换旧条，所以没有退订命令。只接受
/// 子 frame：两个窗口的主 frame 是应用页。`audio` 只对 `general.supportsaudioprocessing: true` 的壁纸放行
/// （照 WPE）。只有 Windows 有数据源，其它平台返回错误，垫片与宿主都忽略。
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
    if !cfg!(target_os = "windows") {
        return Err("web wallpaper media is only available on Windows".to_string());
    }
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    let id = match index.image_id_of(&doc) {
        Some(id) => id,
        None if wpe_scene_host::is_host_document(&doc) => {
            let id = image_id.ok_or("the scene host must pass imageId")?;
            if !index.is_scene(&id) {
                return Err("not a scene wallpaper in the library".into());
            }
            id
        }
        None => return Err("not inside a web wallpaper".into()),
    };
    if kind == WpeMediaKind::Audio && !supports_audio_processing(&id).await? {
        return Err("this wallpaper does not process audio".to_string());
    }
    WpeMediaHub::global().subscribe(webview.label(), frame, kind, Box::new(channel));
    Ok(())
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

    /// `wpe_web_pull_state` 按调用方来源认文档：`file://localhost/…` 归一后能还原成本地路径，
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
}
