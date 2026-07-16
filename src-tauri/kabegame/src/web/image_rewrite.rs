//! Web 边界：把 core 命令返回的图片 JSON 里的 `local_path` / `thumbnail_path`
//! 改写为 CDN 绝对 URL。
//!
//! `kabegame-core::commands` 层是 feature-agnostic 的，一律回**原始本地路径**；
//! 改写在**本层（web dispatch 出口）**对 core 已序列化的 `serde_json::Value`
//! 就地施加。桌面 Tauri 不经过这里，保持文件系统路径。
//!
//! 规则：取 local_path 的 **末级目录名** + **basename**，拼到 [`CDN_BASE`]。
//! images/ 与 thumbnails/ 共用同一函数，未来多层目录 / 多租户分桶也不必改逻辑。

use std::path::Path;

use serde_json::Value;

pub const CDN_BASE: &str = "https://cdn.kabegame.com";

/// 把文件系统路径改写成 CDN URL。空串 / 已是 http(s) URL 时原样返回。
pub fn rewrite_fs_path(p: &str) -> String {
    if p.is_empty() {
        return String::new();
    }
    if p.starts_with("http://") || p.starts_with("https://") {
        return p.to_string();
    }
    let path = Path::new(p);
    let filename = match path.file_name().and_then(|s| s.to_str()) {
        Some(f) if !f.is_empty() => f,
        _ => return p.to_string(),
    };
    let dir = path
        .parent()
        .and_then(|pp| pp.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("images");
    format!("{}/{}/{}", CDN_BASE, dir, filename)
}

/// 对 core 返回的图片 `Value` 就地改写 `local_path` / `thumbnail_path`。
/// 接受单个 image 对象，或 image 对象数组（`get_album_preview` / `pathql_fetch`）。
///
/// **Debug 构建下是 no-op**——`deno task dev` 里 web server 与桌面共用调试二进制，
/// 开发时不希望 web RPC 返回 CDN URL（本地没挂 CDN、会打断断点调试时的路径观察）。
/// release（`deno task b --release`，debug_assertions=false）才启用改写；上线生效。
pub fn rewrite_image_value(v: &mut Value) {
    if cfg!(debug_assertions) {
        return;
    }
    match v {
        Value::Array(items) => items.iter_mut().for_each(rewrite_obj_paths),
        obj @ Value::Object(_) => rewrite_obj_paths(obj),
        _ => {}
    }
}

fn rewrite_obj_paths(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else {
        return;
    };
    for key in ["local_path", "thumbnail_path"] {
        if let Some(Value::String(s)) = obj.get_mut(key) {
            *s = rewrite_fs_path(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_unix_image_path() {
        assert_eq!(
            rewrite_fs_path("/home/cmtheit/.local/share/Kabegame/images/abc-1234.jpg"),
            format!("{}/images/abc-1234.jpg", CDN_BASE),
        );
    }

    #[test]
    fn rewrites_unix_thumbnail_path() {
        assert_eq!(
            rewrite_fs_path("/home/cmtheit/.local/share/Kabegame/thumbnails/xyz.webp"),
            format!("{}/thumbnails/xyz.webp", CDN_BASE),
        );
    }

    #[test]
    fn preserves_empty() {
        assert_eq!(rewrite_fs_path(""), "");
    }

    #[test]
    fn passes_through_http_url() {
        let url = "https://cdn.kabegame.com/images/x.jpg";
        assert_eq!(rewrite_fs_path(url), url);
    }

    #[test]
    fn passes_through_http_insecure() {
        let url = "http://example.com/a.png";
        assert_eq!(rewrite_fs_path(url), url);
    }
}
