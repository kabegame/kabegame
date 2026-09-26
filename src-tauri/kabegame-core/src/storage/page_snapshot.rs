//! 冻结网页快照 metadata 的统一规则（畅游一键下载与网页收集任务共用）。
//!
//! 形状：`{ kind: PAGE_SNAPSHOT_KIND, schemaVersion: 1, sourceUrl, documentUrl, title, pageHtml,
//! capturedAt, backend? }`。详情面板按 `kind` 识别并在沙箱 iframe 中渲染。
//! 这里只放与写入方无关的约束：大小上限与搜索索引范围。

use serde_json::Value;

/// 页面快照 metadata 的 `kind`。名字沿用畅游首发时的叫法，已被网页收集复用，勿改（已有数据按它识别）。
pub const PAGE_SNAPSHOT_KIND: &str = "kabegame.surfPageSnapshot";

/// 单页快照 HTML 上限（UTF-8 字节）。快照入本地库并被同页图片共享。
pub const MAX_PAGE_SNAPSHOT_HTML_BYTES: usize = 32 * 1024 * 1024;

fn as_snapshot(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    let obj = value.as_object()?;
    (obj.get("kind").and_then(Value::as_str) == Some(PAGE_SNAPSHOT_KIND)).then_some(obj)
}

/// 非快照 metadata 直接放行；快照要求 `pageHtml` 为非空字符串且不超过上限。
pub fn validate(value: &Value) -> Result<(), String> {
    let Some(obj) = as_snapshot(value) else {
        return Ok(());
    };
    let html = obj
        .get("pageHtml")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if html.is_empty() {
        return Err("Page snapshot is empty".to_string());
    }
    if html.len() > MAX_PAGE_SNAPSHOT_HTML_BYTES {
        return Err(format!(
            "Page snapshot too large: {} bytes (max {})",
            html.len(),
            MAX_PAGE_SNAPSHOT_HTML_BYTES
        ));
    }
    Ok(())
}

/// 快照只索引标题与来源 URL（整页 HTML 会让正文里的任意词误命中）；非快照返回 `None`。
pub fn search_text(value: &Value) -> Option<String> {
    let obj = as_snapshot(value)?;
    let text = |key: &str| {
        obj.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .replace(['\n', '\r'], " ")
    };
    Some(format!("{}\n{}", text("title"), text("sourceUrl")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_snapshot_is_untouched() {
        let v = json!({ "title": "sakura", "pageHtml": "" });
        assert!(validate(&v).is_ok());
        assert!(search_text(&v).is_none());
    }

    #[test]
    fn snapshot_indexes_title_and_url_only() {
        let v = json!({
            "kind": PAGE_SNAPSHOT_KIND,
            "title": "Gallery\npage",
            "sourceUrl": "https://example.com/p",
            "pageHtml": "<html>huge body</html>",
        });
        assert!(validate(&v).is_ok());
        let text = search_text(&v).unwrap();
        assert_eq!(text, "Gallery page\nhttps://example.com/p");
        assert!(!text.contains("huge body"));
    }

    #[test]
    fn snapshot_rejects_empty_and_oversized() {
        let empty = json!({ "kind": PAGE_SNAPSHOT_KIND, "pageHtml": "" });
        assert!(validate(&empty).is_err());
        let big = json!({
            "kind": PAGE_SNAPSHOT_KIND,
            "pageHtml": "a".repeat(MAX_PAGE_SNAPSHOT_HTML_BYTES + 1),
        });
        assert!(validate(&big).unwrap_err().contains("too large"));
    }
}
