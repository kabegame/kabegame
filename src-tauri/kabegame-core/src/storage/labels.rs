use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const LABEL_KEY_MAX_BYTES: usize = 64;

/// 插件 id：`[a-zA-Z0-9_-]+` 且不超过 64 字节。插件 id 会进文件名、路径与缺省标签目录，
/// 因此比标签 key 严格；满足它的值一定也是合法的标签 key。
pub fn is_plugin_ident(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= LABEL_KEY_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// 标签 key 与目录每段：`[a-zA-Z0-9_\-() ]+` 且不超过 64 字节。动漫标签常见
/// `name (series)` 形式，所以放开英文括号与空格；空格不得出现在首尾、不得连续，
/// 保证搜索时按「去首尾 + 折叠连续空白」规整后的输入能原样比对。
/// `,`（搜索 token 分隔）与 `/`（路径分隔）始终不允许。
pub fn is_label_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= LABEL_KEY_MAX_BYTES
        && !value.starts_with(' ')
        && !value.ends_with(' ')
        && !value.contains("  ")
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'(' | b')' | b' ')
        })
}

/// 插件 / 迁移脚本传入的原始标签。
#[derive(Debug, Clone, Deserialize)]
pub struct LabelInput {
    pub key: Option<String>,
    pub category: Option<String>,
    pub name: Option<String>,
}

/// 校验后的标签。`segments` 是目录各段，`name` 为 `None` 表示未提供。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelSpec {
    pub segments: Vec<String>,
    pub key: String,
    pub name: Option<String>,
}

/// 校验单个标签。除了将纯空白名称视为未提供，不会修正输入。
pub fn validate_label(input: &LabelInput, plugin_id: &str) -> Result<LabelSpec, String> {
    let key = input
        .key
        .as_deref()
        .ok_or_else(|| "标签 key 缺失".to_string())?;
    if !is_label_key(key) {
        return Err(format!(
            "标签 key \"{key}\" 不合规：只允许 ASCII 字母、数字、`_`、`-`、`(`、`)` 与空格（空格不能在首尾或连续），且不超过 {LABEL_KEY_MAX_BYTES} 字节"
        ));
    }

    let segments = match input.category.as_deref() {
        Some(category) => category
            .split('/')
            .map(|segment| {
                if segment.is_empty() {
                    return Err(format!("标签 category \"{category}\" 不合规：不能包含空段"));
                }
                if !is_label_key(segment) {
                    return Err(format!(
                        "标签 category 段 \"{segment}\" 不合规：只允许 ASCII 字母、数字、`_`、`-`、`(`、`)` 与空格（空格不能在首尾或连续），且不超过 {LABEL_KEY_MAX_BYTES} 字节"
                    ));
                }
                Ok(segment.to_string())
            })
            .collect::<Result<Vec<_>, String>>()?,
        None => {
            if !is_plugin_ident(plugin_id) {
                return Err(format!("缺省 category 所用的插件 id \"{plugin_id}\" 不合规"));
            }
            vec![plugin_id.to_string()]
        }
    };

    let name = input
        .name
        .as_ref()
        .filter(|name| !name.trim().is_empty())
        .cloned();

    Ok(LabelSpec {
        segments,
        key: key.to_string(),
        name,
    })
}

/// 批量校验并按 `(segments, key)` 大小写不敏感去重，保留首次出现的顺序。
pub fn validate_labels(
    inputs: &[LabelInput],
    plugin_id: &str,
) -> (Vec<LabelSpec>, Vec<(usize, String)>) {
    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    let mut seen = HashSet::new();

    for (index, input) in inputs.iter().enumerate() {
        match validate_label(input, plugin_id) {
            Ok(spec) => {
                let dedup_key = (
                    spec.segments
                        .iter()
                        .map(|segment| segment.to_ascii_lowercase())
                        .collect::<Vec<_>>(),
                    spec.key.to_ascii_lowercase(),
                );
                if seen.insert(dedup_key) {
                    accepted.push(spec);
                }
            }
            Err(reason) => rejected.push((index, reason)),
        }
    }

    (accepted, rejected)
}

/// 校验插件传来的原始 JSON 标签数组（下载选项、WebView invoke 共用）。
/// 缺省 / null → 空；非数组 → Err（参数错误）；元素结构不对或不合规 → 进拒绝列表，
/// 下标是原数组下标，供调用方写任务日志。
pub fn validate_label_values(
    value: Option<&serde_json::Value>,
    plugin_id: &str,
) -> Result<(Vec<LabelSpec>, Vec<(usize, String)>), String> {
    let values = match value {
        None | Some(serde_json::Value::Null) => return Ok((Vec::new(), Vec::new())),
        Some(serde_json::Value::Array(values)) => values,
        Some(_) => return Err("labels must be an array".to_string()),
    };

    let mut inputs = Vec::new();
    let mut original_indices = Vec::new();
    let mut rejected = Vec::new();
    for (index, value) in values.iter().enumerate() {
        match serde_json::from_value::<LabelInput>(value.clone()) {
            Ok(input) => {
                inputs.push(input);
                original_indices.push(index);
            }
            Err(error) => rejected.push((index, error.to_string())),
        }
    }
    let (specs, invalid) = validate_labels(&inputs, plugin_id);
    rejected.extend(
        invalid
            .into_iter()
            .map(|(index, reason)| (original_indices[index], reason)),
    );
    rejected.sort_by_key(|(index, _)| *index);
    Ok((specs, rejected))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(key: Option<&str>, category: Option<&str>, name: Option<&str>) -> LabelInput {
        LabelInput {
            key: key.map(str::to_string),
            category: category.map(str::to_string),
            name: name.map(str::to_string),
        }
    }

    #[test]
    fn validate_label_defaults_category_and_normalizes_blank_name_only() {
        let spec =
            validate_label(&input(Some("hatsune"), None, Some("  初音ミク  ")), "pixiv").unwrap();
        assert_eq!(spec.segments, ["pixiv"]);
        assert_eq!(spec.key, "hatsune");
        assert_eq!(spec.name.as_deref(), Some("  初音ミク  "));

        let blank_name = validate_label(&input(Some("miku"), None, Some(" \t ")), "pixiv").unwrap();
        assert_eq!(blank_name.name, None);
    }

    #[test]
    fn validate_label_rejects_missing_or_invalid_keys() {
        assert!(validate_label(&input(None, None, None), "pixiv").is_err());
        for key in [
            "has.tune", "has/tune", "a,b", "初音", " lead", "trail ", "two  spaces",
        ] {
            assert!(
                validate_label(&input(Some(key), None, None), "pixiv").is_err(),
                "{key}"
            );
        }
        let too_long = "a".repeat(LABEL_KEY_MAX_BYTES + 1);
        assert!(validate_label(&input(Some(&too_long), None, None), "pixiv").is_err());
    }

    #[test]
    fn label_key_allows_parens_and_single_spaces_but_plugin_id_does_not() {
        for key in ["long hair", "sua (alien stage)", "futaba_akane_(pentagon)"] {
            assert!(is_label_key(key), "{key}");
            assert!(!is_plugin_ident(key), "{key}");
        }
        let spec = validate_label(
            &input(Some("sua (alien stage)"), Some("anime pictures/character (x)"), None),
            "pixiv",
        )
        .unwrap();
        assert_eq!(spec.segments, ["anime pictures", "character (x)"]);
        assert!(is_label_key("plugin-id_1") && is_plugin_ident("plugin-id_1"));
    }

    #[test]
    fn validate_label_rejects_empty_category_segments() {
        for category in ["a//b", "/a", "a/"] {
            assert!(
                validate_label(&input(Some("key"), Some(category), None), "pixiv").is_err(),
                "{category}"
            );
        }
    }

    #[test]
    fn validate_labels_deduplicates_case_insensitively_and_keeps_order() {
        let inputs = vec![
            input(Some("Miku"), Some("Pixiv/Character"), None),
            input(Some("rin"), Some("pixiv/character"), None),
            input(Some("miku"), Some("pixiv/CHARACTER"), Some("重复")),
            input(Some("bad.key"), None, None),
        ];

        let (accepted, rejected) = validate_labels(&inputs, "plugin");
        assert_eq!(
            accepted
                .iter()
                .map(|spec| spec.key.as_str())
                .collect::<Vec<_>>(),
            ["Miku", "rin"]
        );
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].0, 3);
    }
}
