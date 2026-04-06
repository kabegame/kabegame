//! VD/Gallery 共享的路径解析工具。
//!
//! 顶层分组目录的**显示名**由 `ProviderConfig` + `kabegame-i18n`（`vd.*`）按 locale 决定，
//! 不得在业务代码中写死某一种语言的文件夹名。

/// 解析 `YYYY-MM-DD~YYYY-MM-DD` 日期范围目录名。
pub fn parse_date_range_name(s: &str) -> Option<(String, String)> {
    let raw = s.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.split('~').collect();
    if parts.len() != 2 {
        return None;
    }
    let start = parts[0].trim();
    let end = parts[1].trim();
    if start.len() != 10 || end.len() != 10 {
        return None;
    }
    if !start.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !start.as_bytes().get(7).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(4).is_some_and(|c| *c == b'-')
        || !end.as_bytes().get(7).is_some_and(|c| *c == b'-')
    {
        return None;
    }
    Some((start.to_string(), end.to_string()))
}
