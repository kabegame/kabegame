rust_i18n::i18n!("locales", fallback = "en");

const DEFAULT_LANGUAGE: &str = "en";

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
    let supported = rust_i18n::available_locales!();
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
    language
        .as_ref()
        .filter(|lang| !lang.is_empty())
        .and_then(|lang| resolve_supported_language(lang))
        .unwrap_or_else(system_language)
}

#[inline]
pub fn system_language() -> &'static str {
    sys_locale::get_locale()
        .as_deref()
        .and_then(resolve_supported_language)
        .unwrap_or(DEFAULT_LANGUAGE)
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
        "album-order" => Some("vd.albumOrder"),
        "image-only" => Some("vd.imageOnly"),
        "video-only" => Some("vd.videoOnly"),
        "tree" | "subAlbums" => Some("vd.subAlbums"),
        "local-import" => Some("vd.localImport"),
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
