//! 把 metadata / image_metadata 的 JSON `data` 展开成扁平可搜索文本，预存进 search_text 列。
//!
//! 收集规则（两张表通用，不按 schema 做字段白名单）：
//! - object 的键全部收集（JSON 键必为字符串）
//! - 字符串叶子值全部收集；若该字符串本身又是一份合法 JSON（双重编码，如 ComfyUI 把整个
//!   workflow 存成 PNG tEXt chunk 的字符串值、评论字段存成 Quill Delta JSON 字符串），
//!   且解析结果是 object/array，则递归再拆一层——只在解析出容器类型时才递归，避免把
//!   "42"/"true"/"null" 这类纯量字面量字符串误当 JSON 数字/布尔/null 解析后丢失原文。
//! - 数组索引不收集（不是字符串），但继续递归元素
//! - number / bool / null 叶子跳过
//!
//! 片段间用 "\n" 连接，且片段内部的 \n / \r 一律替换为空格——两条合起来保证 "\n" 在结果里只可能是
//! 分隔符。否则 {"author":{"name":"sb"}} 会拼成 authornamesb，搜 "rn" 就凭空命中。

use serde_json::Value;

/// 非法 JSON（含空串）返回空串——与 `parse_metadata_json` 的宽松兜底一致，不阻塞写入。
pub(crate) fn search_text_from_json_str(data_json: &str) -> String {
    match serde_json::from_str::<Value>(data_json) {
        Ok(value) => flatten_json_for_search(&value),
        Err(_) => String::new(),
    }
}

pub(crate) fn flatten_json_for_search(value: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    collect_search_text_parts(value, &mut parts);
    parts.join("\n")
}

/// 片段内换行归一化为空格，保证换行只作为分隔符出现。
fn sanitize_fragment(s: &str) -> String {
    if s.contains('\n') || s.contains('\r') {
        s.replace(['\n', '\r'], " ")
    } else {
        s.to_string()
    }
}

fn collect_search_text_parts(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                parts.push(sanitize_fragment(key));
                collect_search_text_parts(value, parts);
            }
        }
        Value::Array(items) => {
            for value in items {
                collect_search_text_parts(value, parts);
            }
        }
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(nested @ (Value::Object(_) | Value::Array(_))) => {
                collect_search_text_parts(&nested, parts);
            }
            _ => parts.push(sanitize_fragment(s)),
        },
        Value::Number(_) | Value::Bool(_) | Value::Null => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{flatten_json_for_search, search_text_from_json_str};
    use serde_json::json;

    #[test]
    fn fragment_boundaries_prevent_cross_fragment_matches() {
        let flattened = flatten_json_for_search(&json!({"author": {"name": "sb"}}));

        assert!(!flattened.contains("authorname"));
        assert!(!flattened.contains("rn"));
    }

    #[test]
    fn newlines_only_separate_sanitized_fragments() {
        let flattened = flatten_json_for_search(&json!({"note": "a\nb"}));
        let fragment_count = 2;

        assert_eq!(flattened, "note\na b");
        assert_eq!(flattened.matches('\n').count(), fragment_count - 1);
    }

    #[test]
    fn recursively_collects_nested_object_keys_and_string_leaves() {
        let flattened = flatten_json_for_search(&json!({
            "creator": {
                "profile": {
                    "name": "Alice",
                    "location": "Tokyo"
                }
            }
        }));

        for expected in ["creator", "profile", "name", "Alice", "location", "Tokyo"] {
            assert!(flattened.split('\n').any(|part| part == expected));
        }
    }

    #[test]
    fn arrays_recurse_without_indices_and_skip_non_string_leaves() {
        let flattened = flatten_json_for_search(&json!({
            "items": ["first", {"leaf": "second"}, 42, true, null]
        }));

        assert_eq!(flattened, "items\nfirst\nleaf\nsecond");
        assert!(!flattened.contains("42"));
    }

    #[test]
    fn invalid_json_returns_empty_text() {
        assert_eq!(search_text_from_json_str(""), "");
        assert_eq!(search_text_from_json_str("{invalid"), "");
    }

    #[test]
    fn recursively_unwraps_double_encoded_json_string_leaves() {
        // 评论字段存成 Quill Delta 富文本 JSON 字符串（真实数据里的常见形态）。
        let flattened = flatten_json_for_search(&json!({
            "comments": "[{\"insert\":\"大佬\"},{\"insert\":\"_(抱大腿)\"}]"
        }));

        for expected in ["comments", "insert", "大佬", "_(抱大腿)"] {
            assert!(flattened.split('\n').any(|part| part == expected), "missing {expected:?} in {flattened:?}");
        }
        assert!(!flattened.contains('{'));
        assert!(!flattened.contains('}'));
        assert!(!flattened.contains('"'));
    }

    #[test]
    fn scalar_looking_string_leaves_are_preserved_verbatim() {
        // "42"/"true"/"null" 都是合法 JSON 纯量字面量，但作为字符串叶子值不应被当成
        // JSON 数字/布尔/null 解析后丢弃原文——必须原样保留在 search_text 里。
        let flattened = flatten_json_for_search(&json!({
            "count_label": "42",
            "flag_label": "true",
            "empty_label": "null"
        }));

        for expected in ["42", "true", "null"] {
            assert!(flattened.split('\n').any(|part| part == expected), "missing {expected:?} in {flattened:?}");
        }
    }
}
