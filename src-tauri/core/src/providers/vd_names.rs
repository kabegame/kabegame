//! VD/Gallery 共享目录名与解析工具。

pub const DIR_BY_DATE: &str = "按时间";
pub const DIR_BY_PLUGIN: &str = "按插件";
pub const DIR_BY_TASK: &str = "按任务";
pub const DIR_BY_SURF: &str = "按畅游";
pub const DIR_ALBUMS: &str = "画册";
pub const DIR_BY_WALLPAPER_ORDER: &str = "按壁纸顺序";
pub const DIR_ALL: &str = "全部";
pub const DIR_BY_MEDIA_TYPE: &str = "按种类";
pub const DIR_MEDIA_IMAGE: &str = "图片";
pub const DIR_MEDIA_VIDEO: &str = "视频";

/// VD「按种类」子目录名 -> SQL `images.type` 取值
pub fn media_type_token_from_dir_name(name: &str) -> Option<&'static str> {
    let t = name.trim();
    if t == DIR_MEDIA_IMAGE {
        Some("image")
    } else if t == DIR_MEDIA_VIDEO {
        Some("video")
    } else {
        None
    }
}

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
