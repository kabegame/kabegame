use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use super::validate_kb_rel_path;

pub const ASSET_MAX_FILE_SIZE: usize = 2 * 1024 * 1024;
pub const ASSET_MAX_TOTAL_SIZE: usize = 10 * 1024 * 1024;

/// 资源路径归一化。None = 「不是本地资源引用」或非法。
/// 这是 kbAssets 项、md 引用、assets 键三者的唯一裁决者。
/// 同构 TS 实现:packages/kabegame-core/src/utils/assetPath.ts —— 改规则必须同时改两处。
pub fn normalize_asset_path(raw: &str) -> Option<String> {
    static TITLE_SUFFIX_RE: OnceLock<Regex> = OnceLock::new();

    let mut key = raw.trim().to_string();
    let title_suffix_re =
        TITLE_SUFFIX_RE.get_or_init(|| Regex::new(r#"^(.*?)\s+["'(].*["')]$"#).unwrap());
    if let Some(prefix) = title_suffix_re
        .captures(&key)
        .and_then(|captures| captures.get(1))
        .map(|matched| matched.as_str())
        .filter(|prefix| !prefix.is_empty())
    {
        key = prefix.to_string();
    }

    if let Some(index) = key.find(['#', '?']) {
        key.truncate(index);
    }

    key = key.replace('\\', "/");
    if let Ok(decoded) = urlencoding::decode(&key) {
        key = decoded.into_owned();
    }

    // scheme 大小写不敏感（`HTTP://…` 同样是外链）
    let lowered = key.to_ascii_lowercase();
    if lowered.starts_with("http://")
        || lowered.starts_with("https://")
        || lowered.starts_with("data:")
        || lowered.starts_with("//")
    {
        return None;
    }

    let key = key.trim_start_matches('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in key.split('/') {
        match segment {
            "" | "." => {}
            // `..` 弹栈；栈为空表示越过插件根，判为非法。
            ".." => match segments.last() {
                Some(_) => {
                    segments.pop();
                }
                None => return None,
            },
            _ => segments.push(segment),
        }
    }

    let normalized = segments.join("/");
    (!normalized.is_empty()).then_some(normalized)
}

/// 扩展名 → MIME。
pub fn mime_for_asset(key_or_path: &str) -> &'static str {
    let ext = Path::new(key_or_path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// 是否是「展示位」资源：完整归一化路径以 `banner` 开头，大小写不敏感。
///
/// 这类图供「源」页面的快捷预览走马灯当橱窗图用，通常不被任何 md 引用；
/// 同构 TS 实现：`packages/kabegame-core/src/utils/assetPath.ts::isBannerAsset`。
pub fn is_banner_asset(key_or_path: &str) -> bool {
    key_or_path.to_ascii_lowercase().starts_with("banner")
}

/// 返回归一化后的资源路径列表，来源只有 `kbAssets`，顺序与数组声明顺序一致。
/// 每项都是插件根相对路径；doc 与 changelog 共用这一份列表。
/// 字段缺失 = 该插件零资源。
pub fn build_asset_index(pkg: &serde_json::Value) -> Vec<String> {
    let mut index = Vec::new();
    let mut seen = HashSet::new();
    let Some(pkg_obj) = pkg.as_object() else {
        eprintln!("[WARN] package.json 不是 JSON 对象，无法构建资源清单");
        return index;
    };

    if pkg_obj.contains_key("kbDocAssets") {
        eprintln!("[WARN] kbDocAssets 已被 kbAssets 取代（路径数组），本字段被忽略");
    }
    let Some(items) = pkg_obj.get("kbAssets") else {
        return index;
    };
    let Some(items) = items.as_array() else {
        eprintln!("[WARN] kbAssets 不是数组，已忽略资源清单");
        return index;
    };
    for item in items {
        let Some(raw) = item.as_str() else {
            eprintln!("[WARN] kbAssets 含非字符串项，已跳过");
            continue;
        };
        let Some(path) = normalize_asset_path(raw) else {
            eprintln!("[WARN] kbAssets 含非法资源路径，已跳过: {raw:?}");
            continue;
        };
        if let Err(error) = validate_kb_rel_path(&path) {
            eprintln!("[WARN] kbAssets 项路径非法，已跳过 {raw:?}: {error}");
            continue;
        }
        if !seen.insert(path.clone()) {
            eprintln!("[WARN] kbAssets 归一化后重复，已忽略: {path:?}");
            continue;
        }
        index.push(path);
    }

    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_asset_path_follows_shared_rules() {
        let cases = [
            ("./a.png", Some("a.png")),
            ("a.png", Some("a.png")),
            ("doc_root/a.png", Some("doc_root/a.png")),
            ("./images/x.png", Some("images/x.png")),
            ("./images/a%20b%28c%29.png", Some("images/a b(c).png")),
            ("a.png \"t\"", Some("a.png")),
            ("a.png 't'", Some("a.png")),
            ("a.png (t)", Some("a.png")),
            ("a.png#frag", Some("a.png")),
            ("a.png?v=1", Some("a.png")),
            ("https://x/a.png", None),
            ("data:image/png;base64,abc", None),
            ("//cdn/a.png", None),
            ("../shared/a.png", None),
            ("../../a.png", None),
            ("images/../a.png", Some("a.png")),
            // scheme 大小写不敏感
            ("HTTPS://x/a.png", None),
            ("Data:image/png;base64,abc", None),
            ("", None),
            (".", None),
            ("/", None),
            (r"images\x.png", Some("images/x.png")),
            ("A.PNG", Some("A.PNG")),
            ("%FF.png", Some("%FF.png")),
        ];

        for (raw, expected) in cases {
            assert_eq!(
                normalize_asset_path(raw).as_deref(),
                expected,
                "raw={raw:?}"
            );
        }
    }

    #[test]
    fn build_asset_index_uses_kb_assets_only() {
        let pkg = serde_json::json!({
            "kbAssets": [
                "shared/b.jpg",
                "./images/a.png",
                "images/../shared/b.jpg",
                "../outside.png",
                42
            ]
        });
        let index = build_asset_index(&pkg);

        assert_eq!(
            index,
            vec!["shared/b.jpg".to_string(), "images/a.png".to_string()]
        );
    }

    #[test]
    fn banner_asset_uses_full_path_prefix() {
        assert!(is_banner_asset("banner.png"));
        assert!(is_banner_asset("Banner/home.webp"));
        assert!(!is_banner_asset("images/banner-home.webp"));
    }
}
