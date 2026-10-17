rust_i18n::i18n!("locales", fallback = "en");

const DEFAULT_LANGUAGE: &str = "en";
pub const SUPPORTED_LOCALES: &[&str] = &["en", "zh", "ja", "ko", "zhtw"];

#[inline]
fn locale_alias(locale: &str) -> Option<&'static str> {
    match locale {
        "zh" | "zh-cn" | "zh-hans" | "zh-sg" | "zh-my" | "zh-chs" => Some("zh"),
        "zh-tw" | "zh-hk" | "zh-hant" | "zh-mo" | "zh-cht" => Some("zhtw"),
        "ja" | "ja-jp" => Some("ja"),
        "ko" | "ko-kr" | "ko-kp" => Some("ko"),
        _ => None,
    }
}

#[inline]
fn resolve_supported_language(language: &str) -> Option<&'static str> {
    if language.is_empty() {
        return None;
    }
    let normalized = language.to_lowercase().replace('_', "-");
    let segments: Vec<&str> = normalized.split('-').collect();
    let supported = SUPPORTED_LOCALES;
    for i in (1..=segments.len()).rev() {
        let prefix = segments[..i].join("-");
        if let Some(alias) = locale_alias(&prefix) {
            if let Some(&found) = supported.iter().find(|&&l| l.eq_ignore_ascii_case(alias)) {
                return Some(found);
            }
        }
        if let Some(&found) = supported.iter().find(|&&l| l.eq_ignore_ascii_case(&prefix)) {
            return Some(found);
        }
    }
    None
}

#[inline]
fn current_language(language: Option<&str>) -> &'static str {
    resolve_language_setting(language)
}

#[inline]
pub fn system_language() -> &'static str {
    sys_locale::get_locale()
        .as_deref()
        .and_then(resolve_supported_language)
        .unwrap_or(DEFAULT_LANGUAGE)
}

#[inline]
pub fn resolve_language_setting(language: Option<&str>) -> &'static str {
    match language.map(str::trim).filter(|lang| !lang.is_empty()) {
        Some(lang) => resolve_supported_language(lang).unwrap_or(DEFAULT_LANGUAGE),
        None => system_language(),
    }
}

#[inline]
pub fn sync_locale(language: Option<&str>) {
    let language = current_language(language);
    set_locale(language);
}

#[inline]
pub fn set_locale(language: &str) {
    let lang = resolve_supported_language(language).unwrap_or(DEFAULT_LANGUAGE);
    rust_i18n::set_locale(lang);
}

#[inline]
pub fn translate(key: &str) -> String {
    rust_i18n::t!(key).to_string()
}

#[inline]
pub fn translate_for_locale(key: &str, locale: &str) -> String {
    let lang = resolve_supported_language(locale).unwrap_or(DEFAULT_LANGUAGE);
    rust_i18n::t!(key, locale = lang).to_string()
}

/// 注入网页（畅游 / WebView 爬虫窗口）脚本使用的文案键，均位于 `webview.` 命名空间下。
/// 新增 key 时同时补全 `locales/*.yml` 的 `webview:` 段。
const WEBVIEW_KEYS: &[&str] = &[
    "menu.downloadVideo",
    "menu.downloadImage",
    "toast.queued",
    "toast.succeeded",
    "toast.completed",
    "toast.failed",
    "toast.archiveImported",
    "progress.downloading",
    "progress.downloadingPercent",
    "progress.writing",
    "progress.muxing",
    "progress.importing",
    "panel.title",
    "panel.video",
    "panel.audio",
    "panel.stream",
    "panel.rawStream",
    "panel.missingInit",
    "panel.aborts",
    "panel.resyncs",
    "panel.dropped",
    "panel.noData",
    "panel.waitingMetadata",
    "panel.switched",
    "panel.fetchingGap",
    "panel.waitingGap",
    "panel.refetchingGap",
    "panel.failed",
    "error.liveStream",
    "error.durationTimeout",
    "error.videoChanged",
    "error.drm",
    "error.captureLimit",
    "error.gapLost",
    "error.stalled",
    "error.notCaptured",
    "error.captureMissing",
    "error.captureEmpty",
];

/// 当前全局 locale 下注入网页脚本的整张文案表：键不带 `webview.` 前缀，占位符保持 `{name}` 原样，
/// 由页面脚本替换。
pub fn webview_messages() -> Vec<(&'static str, String)> {
    WEBVIEW_KEYS
        .iter()
        .map(|key| (*key, translate(&format!("webview.{key}"))))
        .collect()
}

/// 与 `UnifiedRootProvider` / `VfsSemantics` 的 `vd/{locale}` 段一致（zh/en/ja/ko/zhtw）。
#[inline]
pub fn vd_locale_segment_for_ui_language(lang: Option<&str>) -> &'static str {
    current_language(lang)
}

/// 从 `rust_i18n` 全局 locale（由 `sync_locale` 设定）读取当前 VD 路径段。
/// 不依赖 tokio runtime，可在 FUSE/Dokan 回调线程安全调用。
#[inline]
pub fn current_vd_locale() -> &'static str {
    let current = rust_i18n::locale();
    resolve_supported_language(&current).unwrap_or(DEFAULT_LANGUAGE)
}

fn vd_flat_key_for_canonical(canonical: &str) -> Option<&'static str> {
    match canonical {
        "all" => Some("vd.all"),
        "plugin" => Some("vd.plugin"),
        "name" => Some("vd.name"),
        "date" => Some("vd.date"),
        "date-range" => Some("vd.dateRange"),
        "album" => Some("vd.album"),
        "task" => Some("vd.task"),
        "surf" => Some("vd.surf"),
        "media-type" | "mediaType" => Some("vd.mediaType"),
        "wallpaper-order" => Some("vd.wallpaperOrder"),
        "desc" => Some("vd.desc"),
        "image" => Some("vd.image"),
        "video" => Some("vd.video"),
        "all-formats" => Some("vd.allFormats"),
        "album-order" => Some("vd.albumOrder"),
        "image-only" => Some("vd.imageOnly"),
        "video-only" => Some("vd.videoOnly"),
        "tree" | "subAlbums" => Some("vd.subAlbums"),
        "hidden-album" => Some("vd.hiddenAlbum"),
        _ => None,
    }
}

/// 按 locale 段（如 `zh`）与 canonical key（如 `album`）返回 VD 目录显示名。
pub fn translate_vd_canonical(locale: &str, canonical: &str) -> String {
    let Some(key) = vd_flat_key_for_canonical(canonical) else {
        return canonical.to_string();
    };
    let lang = resolve_supported_language(locale).unwrap_or(DEFAULT_LANGUAGE);
    rust_i18n::t!(key, locale = lang).to_string()
}

/// 当前全局 locale 下 canonical key 的 VD 目录显示名（最常用形式）。
#[inline]
pub fn vd_display_name(canonical: &str) -> String {
    translate_vd_canonical(current_vd_locale(), canonical)
}

#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::translate(&$key)
    };
    ($key:expr, $($arg_name:ident = $arg_value:expr),*) => {
        {
            let mut _text = $crate::translate(&$key);
            $(
                _text = _text.replace(&format!("{{{}}}", stringify!($arg_name)), &$arg_value);
            )*
            _text
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `WEBVIEW_KEYS` 的每个键在所有语言里都必须有译文：缺失时 rust-i18n 退回 key 原文，
    /// 注入页面会直接显示 `webview.xxx`。
    #[test]
    fn webview_keys_translated_in_every_locale() {
        for locale in SUPPORTED_LOCALES {
            for key in WEBVIEW_KEYS {
                let full = format!("webview.{key}");
                let text = translate_for_locale(&full, locale);
                assert!(
                    !text.is_empty() && text != full,
                    "{locale} 缺少 {full}"
                );
            }
        }
    }
}
