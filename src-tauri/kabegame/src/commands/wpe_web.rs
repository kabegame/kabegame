//! WPE 网页壁纸（`x-wpe/web`）的宿主协议：页面里的垫片（`webview_js/wpe_shim.js`）向宿主
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

use crate::wallpaper::wpe_web_dir_index::WpeWebDirIndex;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::media::image_type::wpe_kind;
use kabegame_core::settings::Settings;
use kabegame_core::storage::Storage;
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
        items,
    }
}

/// 属性面板读视图；行不存在或不是 `x-wpe/web` 返回 None。只给主窗口（不进 `wpe-web.toml`）。
#[tauri::command]
pub async fn get_wpe_web_properties(
    image_id: String,
) -> Result<Option<WpeWebPropertiesView>, String> {
    let Some(info) = Storage::find_image_by_id(&image_id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if wpe_kind(info.media_type.as_deref()).as_deref() != Some("web") {
        return Ok(None);
    }
    let id = image_id.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Some(properties_view(
        image_id,
        info.metadata_id,
        &raw.unwrap_or_default(),
    )))
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
    if wpe_kind(info.media_type.as_deref()).as_deref() != Some("web") {
        return Err("not a web wallpaper".into());
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
        .ok_or_else(|| "web wallpaper row missing".to_string())
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
/// 行不存在或不是 `x-wpe/web` 返回 None。metadata 读取放 blocking 线程。
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
    if wpe_kind(info.media_type.as_deref()).as_deref() != Some("web") {
        return Ok(None);
    }
    let id = info.id.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || Storage::global().get_metadata(&id))
        .await
        .map_err(|error| error.to_string())??;
    // metadata 缺失时按「作者没有声明属性」处理，页面照常收到空的用户属性。
    let user = raw.as_ref().map(resolve_web_user_props).unwrap_or_default();
    let raw = raw.unwrap_or_default();
    let directories = tauri::async_runtime::spawn_blocking({
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
    .map_err(|e| e.to_string())?;
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

/// 网页壁纸页面（`file:` iframe，wpe-web-capability，`frames: "sub"`）拉取状态。不接收 id、不看 webview：
/// 按调用方自己的文档 URL（CEF runtime 把 `file:` frame 的 `Origin` 改写成完整文档 URL，页面伪造不了）
/// 在网页壁纸目录索引里找到它所在的那张，页面拿不到别的图片的 metadata。
///
/// 返回之前用同一份 metadata 覆盖这张壁纸的 `file:` 放行：页面只能从拉取结果得知用户新选的路径，拿到时
/// 闸门一定已经认它；撤销旧选择由目录索引跟随 `metadataId` 补丁完成。
#[tauri::command]
pub async fn wpe_web_pull_state(caller: tauri::ipc::CallerOrigin) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;
    let index = WpeWebDirIndex::global();
    let id = index
        .image_id_of(&doc)
        .ok_or("not inside a web wallpaper")?;
    let (state, raw) = build_wpe_web_state_with_raw(&id)
        .await?
        .ok_or_else(|| "web wallpaper row missing".to_string())?;
    index.replace_grants(&id, user_file_grants(&raw));
    Ok(state)
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
}
