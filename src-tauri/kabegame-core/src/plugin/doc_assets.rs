use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use super::{extract_doc_local_refs, validate_kb_rel_path};

pub const DOC_ASSET_MAX_FILE_SIZE: usize = 2 * 1024 * 1024;
pub const DOC_ASSET_MAX_TOTAL_SIZE: usize = 10 * 1024 * 1024;

/// 文档资源键归一化。None = 「不是本地资源引用」或非法。
/// 这是 kbDocAssets 注册键、md 引用、doc_resources 键三者的唯一裁决者。
/// 同构 TS 实现:packages/kabegame-core/src/utils/docAssetKey.ts —— 改规则必须同时改两处。
pub fn normalize_doc_asset_key(raw: &str) -> Option<String> {
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
            // `..` 弹栈；栈为空、或栈顶本身就是字面 `..` 时保留字面 `..`
            // （否则 `../../a.png` 会被折成 `a.png`，等于让 `..` 逃逸）
            ".." => match segments.last() {
                Some(&last) if last != ".." => {
                    segments.pop();
                }
                _ => segments.push(".."),
            },
            _ => segments.push(segment),
        }
    }

    let normalized = segments.join("/");
    (!normalized.is_empty()).then_some(normalized)
}

/// 扩展名 → MIME。
pub fn mime_for_doc_asset(key_or_path: &str) -> &'static str {
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

/// 返回「归一化键 → 插件根相对的包内路径」。新老两条路径在此收敛成同一张表。
///
/// - 有 `kbDocAssets`：key 经 [`normalize_doc_asset_key`]，value 经
///   `validate_kb_rel_path`；非法项在加载期 WARN 并跳过。
/// - 无 `kbDocAssets`：扫描每个 `kbDoc`，以原引用的归一化结果为 key、
///   `extract_doc_local_refs` 产出的插件根相对路径为 value，冲突时先到先得。
pub fn build_doc_asset_index(
    pkg: &serde_json::Value,
    read_doc_md: &mut dyn FnMut(&str) -> Option<String>,
) -> HashMap<String, String> {
    let mut index = HashMap::new();
    let Some(pkg_obj) = pkg.as_object() else {
        eprintln!("[WARN] package.json 不是 JSON 对象，无法构建文档资源索引");
        return index;
    };

    if let Some(assets_value) = pkg_obj.get("kbDocAssets") {
        let Some(assets) = assets_value.as_object() else {
            eprintln!("[WARN] kbDocAssets 不是对象，已忽略文档资源白名单");
            return index;
        };

        for (raw_key, path_value) in assets {
            let Some(key) = normalize_doc_asset_key(raw_key) else {
                eprintln!("[WARN] kbDocAssets 含非法资源键，已跳过: {raw_key:?}");
                continue;
            };
            let Some(zip_path) = path_value.as_str() else {
                eprintln!("[WARN] kbDocAssets[{raw_key:?}] 的值不是字符串，已跳过");
                continue;
            };
            if let Err(error) = validate_kb_rel_path(zip_path) {
                eprintln!("[WARN] kbDocAssets[{raw_key:?}] 的包内路径非法，已跳过: {error}");
                continue;
            }
            if index.contains_key(&key) {
                eprintln!("[WARN] kbDocAssets 归一化后资源键冲突，保留先出现的项: {key:?}");
                continue;
            }
            index.insert(key, zip_path.to_string());
        }
        return index;
    }

    let Some(doc_map) = pkg_obj.get("kbDoc").and_then(|value| value.as_object()) else {
        return index;
    };
    for (lang, md_path_value) in doc_map {
        let Some(md_path) = md_path_value.as_str() else {
            eprintln!("[WARN] kbDoc[{lang:?}] 不是字符串，无法扫描文档资源");
            continue;
        };
        let Some(md) = read_doc_md(md_path) else {
            eprintln!("[WARN] 无法读取 kbDoc[{lang:?}] {md_path:?}，已跳过资源扫描");
            continue;
        };
        let doc_dir = Path::new(md_path)
            .parent()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        for (normalized_path, original_ref) in extract_doc_local_refs(&md, &doc_dir) {
            let Some(key) = normalize_doc_asset_key(&original_ref) else {
                continue;
            };
            index.entry(key).or_insert(normalized_path);
        }
    }

    index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_doc_asset_key_follows_shared_rules() {
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
            ("../shared/a.png", Some("../shared/a.png")),
            // 连续 `..` 不能互相抵消，否则等于让 `..` 逃逸
            ("../../a.png", Some("../../a.png")),
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
                normalize_doc_asset_key(raw).as_deref(),
                expected,
                "raw={raw:?}"
            );
        }
    }

    #[test]
    fn explicit_and_fallback_indexes_have_the_same_semantics() {
        let explicit_pkg = serde_json::json!({
            "kbDoc": {"default": "doc_root/doc.md"},
            "kbDocAssets": {
                "./images/a.png": "doc_root/images/a.png",
                "./shared/b.jpg": "doc_root/shared/b.jpg"
            }
        });
        let mut explicit_reader = |_path: &str| -> Option<String> {
            panic!("显式 kbDocAssets 路径不应读取 Markdown")
        };
        let explicit = build_doc_asset_index(&explicit_pkg, &mut explicit_reader);

        let fallback_pkg = serde_json::json!({
            "kbDoc": {"default": "doc_root/doc.md"}
        });
        let mut fallback_reader = |path: &str| {
            (path == "doc_root/doc.md")
                .then(|| "![](./images/a.png)\n<img src=\"./shared/b.jpg\">".to_string())
        };
        let fallback = build_doc_asset_index(&fallback_pkg, &mut fallback_reader);

        assert_eq!(explicit, fallback);
        assert_eq!(
            explicit.get("images/a.png").map(String::as_str),
            Some("doc_root/images/a.png")
        );
        assert_eq!(
            explicit.get("shared/b.jpg").map(String::as_str),
            Some("doc_root/shared/b.jpg")
        );
    }
}
