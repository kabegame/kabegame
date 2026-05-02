//! Web 边界：把 `ImageInfo.local_path` / `thumbnail_path` 改写为 CDN 绝对 URL。
//!
//! 仅供 `commands_core::image` / `commands_core::album` 这些 web-only 包装层调用。
//! 桌面 Tauri 走 `commands::image` 不经过这里，保持返回文件系统路径。
//!
//! 规则：取 local_path 的 **末级目录名** + **basename**，拼到 [`CDN_BASE`]。
//! 这样 images/ 与 thumbnails/ 都走同一函数，future 多层目录或多租户分桶也不必改逻辑。
//!
//! 注意：不要退回 `serde_json::Value` 原地改写的风格
//! （参考 `web::dispatch::strip_http_headers_in_place` 的反面示例）——那里丢类型检查，
//! 多 RPC 维护成本高。此处在类型化的 `ImageInfo` 上改。

use std::path::Path;

use kabegame_core::storage::ImageInfo;

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

/// 对单个 ImageInfo 改写 local_path 与 thumbnail_path。
///
/// **Debug 构建下是 no-op**——`bun dev` 里 web server 和桌面共用调试二进制，
/// 开发时不希望 web RPC 返回 CDN URL（本地没挂 CDN、打断断点调试时的路径观察）。
/// release（`bun b --release`，debug_assertions=false）才启用改写；上线生效。
pub fn rewrite_image_info(info: &mut ImageInfo) {
    if cfg!(debug_assertions) {
        let _ = info;
        return;
    }
    info.local_path = rewrite_fs_path(&info.local_path);
    info.thumbnail_path = rewrite_fs_path(&info.thumbnail_path);
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
