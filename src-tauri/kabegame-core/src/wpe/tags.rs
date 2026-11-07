//! 壁纸的标签。作者声明的 `tags` 只是其中一部分：WPE 发布时还会打上音频响应、可自定义、年龄分级等标签，
//! 这些写在 Steam 上，`project.json` 里没有。
//!
//! - `bin/workshopcache.json`：WPE 缓存的已订阅工坊壁纸的 Steam 标签，就是 WPE 界面显示的那份。有这张壁纸就以它为准：
//!   作者的 `contentrating` 可能已被 Steam 上的分级改过，发布后才加的属性也不会让 `Customizable` 出现。
//! - 其余壁纸（默认壁纸、自己的项目、已退订的工坊目录）没有 Steam 标签，从 `project.json` 推导。
//!   `Approved` 是工坊审核给的，`HDR`、`3D`、`Puppet Warp`、`Media Integration` 要看场景内容，这些推导不出来。
//!
//! 标签 key 就是 Steam 标签原文，不随语言变，两个来源落到同一个标签；显示名由 [`tag_name`] 在建标签时翻译。
//! 标签照 WPE 筛选面板分进题材、年龄分级、特性三个子目录（[`tag_dir`]），目录 key 同样不随语言变。

use std::collections::HashMap;

use serde_json::Value;

use super::project::WpeProject;

/// WPE 安装目录下的工坊缓存。
const WORKSHOP_CACHE_FILE: &str = "bin/workshopcache.json";

// 这些是 Steam 标签原文，也是写进库里的标签 key：不能改写，也不能翻译。
const TAG_AUDIO_RESPONSIVE: &str = "Audio responsive";
const TAG_CUSTOMIZABLE: &str = "Customizable";
const TAG_USER_SHORTCUT: &str = "User Shortcut";
const TAG_VIDEO_TEXTURE: &str = "Video Texture";
const RATING_TAGS: [&str; 3] = ["Everyone", "Questionable", "Mature"];

/// 标签子目录的 key，写进库里，不能改。
const DIR_GENRE: &str = "genre";
const DIR_RATING: &str = "rating";
const DIR_FEATURE: &str = "feature";

/// WPE 的工具标签：功能特性，不是题材。
const FEATURE_TAGS: [&str; 12] = [
    TAG_AUDIO_RESPONSIVE,
    TAG_CUSTOMIZABLE,
    TAG_USER_SHORTCUT,
    TAG_VIDEO_TEXTURE,
    "3D",
    "Approved",
    "HDR",
    "Media Integration",
    "Multi-monitor optimized",
    "No Animation",
    "Oversized",
    "Puppet Warp",
];

/// 分类、类型、来源：这些已经由图片类型和导入来源表达，不挂标签。
const NON_LABEL_TAGS: [&str; 10] = [
    "Wallpaper",
    "Preset",
    "Asset",
    "Scene",
    "Video",
    "Web",
    "Application",
    "Official",
    "Workshop",
    "Local",
];

/// `general.properties` 里随项目自带的主题色，不算作者提供的属性。
const SCHEME_COLOR_PROPERTY: &str = "schemecolor";
/// `general.supportsvideoflags` 里表示场景用了视频纹理的位；`general.supportsvideo` 为真时不一定有。
const VIDEO_FLAG_TEXTURE: u64 = 1;

/// 工坊 id → 这张壁纸的 Steam 标签。
pub type WorkshopTags = HashMap<String, Vec<String>>;

fn parse_workshop_cache(text: &str) -> Result<WorkshopTags, serde_json::Error> {
    let cache: Value = serde_json::from_str(text)?;
    let entries = cache.get("wallpapers").and_then(Value::as_array);
    let tags = entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = entry.get("workshopid")?.as_str()?;
            let tags: Vec<String> = entry
                .get("tags")?
                .as_str()?
                .split(',')
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .map(str::to_string)
                .collect();
            (!tags.is_empty()).then(|| (id.to_string(), tags))
        })
        .collect();
    Ok(tags)
}

/// 读 WPE 的工坊缓存。这是 WPE 的内部文件，读不到或格式变了都当作没有，壁纸走 `project.json` 推导。
pub fn read_workshop_tags() -> WorkshopTags {
    let Some(engine) = super::discover::engine_dir() else {
        return WorkshopTags::new();
    };
    let path = engine.join(WORKSHOP_CACHE_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) => {
            tracing::debug!("读不到工坊缓存 {}: {error}", path.display());
            return WorkshopTags::new();
        }
    };
    parse_workshop_cache(&text).unwrap_or_else(|error| {
        tracing::warn!("工坊缓存格式无法识别 {}: {error}", path.display());
        WorkshopTags::new()
    })
}

/// 从 `project.json` 推导 WPE 发布时会打的标签。
fn derived_tags(raw: &Value) -> Vec<String> {
    let mut tags = Vec::new();
    let general = raw.get("general");
    if general
        .and_then(|general| general.get("supportsaudioprocessing"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        tags.push(TAG_AUDIO_RESPONSIVE.to_string());
    }
    let video_flags = general
        .and_then(|general| general.get("supportsvideoflags"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if video_flags & VIDEO_FLAG_TEXTURE != 0 {
        tags.push(TAG_VIDEO_TEXTURE.to_string());
    }
    if let Some(properties) = general
        .and_then(|general| general.get("properties"))
        .and_then(Value::as_object)
    {
        if properties.keys().any(|key| key != SCHEME_COLOR_PROPERTY) {
            tags.push(TAG_CUSTOMIZABLE.to_string());
        }
        if properties
            .values()
            .any(|property| property.get("type").and_then(Value::as_str) == Some("usershortcut"))
        {
            tags.push(TAG_USER_SHORTCUT.to_string());
        }
    }
    let rating = raw.get("contentrating").and_then(Value::as_str);
    if let Some(rating) = RATING_TAGS
        .into_iter()
        .find(|tag| rating.is_some_and(|rating| rating.trim().eq_ignore_ascii_case(tag)))
    {
        tags.push(rating.to_string());
    }
    tags
}

/// 分辨率标签：`3840 x 2160`、`Portrait 720 x 1280`、`Dual 5120 x 1440`、`Dynamic resolution`、
/// `Other resolution`、`Standard Definition`、`Portrait Standard Definition`。
fn is_resolution_tag(tag: &str) -> bool {
    let tag = tag.to_ascii_lowercase();
    tag.contains(" x ") || tag.ends_with(" resolution") || tag.ends_with("standard definition")
}

fn is_label_tag(tag: &str) -> bool {
    !is_resolution_tag(tag)
        && !NON_LABEL_TAGS
            .iter()
            .any(|excluded| excluded.eq_ignore_ascii_case(tag))
}

/// 这张壁纸要挂的标签：作者声明的 `tags`，加上 Steam 标签或推导出的标签。重复项交给 `validate_labels` 去掉。
pub fn wallpaper_tags(project: &WpeProject, workshop: &WorkshopTags) -> Vec<String> {
    let extra = project
        .workshop_id
        .as_ref()
        .and_then(|id| workshop.get(id))
        .cloned()
        .unwrap_or_else(|| derived_tags(&project.raw));
    project
        .tags
        .iter()
        .cloned()
        .chain(extra)
        .filter(|tag| is_label_tag(tag))
        .collect()
}

/// 标签所在的子目录。作者声明的 `tags` 只能从题材里选，所以不认识的标签都算题材。
pub fn tag_dir(tag: &str) -> &'static str {
    let listed = |tags: &[&str]| tags.iter().any(|known| known.eq_ignore_ascii_case(tag));
    if listed(&RATING_TAGS) {
        DIR_RATING
    } else if listed(&FEATURE_TAGS) {
        DIR_FEATURE
    } else {
        DIR_GENRE
    }
}

/// 标签在当前语言下的显示名；没有收录的标签返回 `None`，名称用 key。只在建标签时用，已有标签不改名。
pub fn tag_name(tag: &str) -> Option<String> {
    kabegame_i18n::try_translate(&format!("wpe.tags.{tag}"))
}

/// 子目录在当前语言下的显示名，规则同 [`tag_name`]。
pub fn tag_dir_name(dir: &str) -> Option<String> {
    kabegame_i18n::try_translate(&format!("wpe.tagDirs.{dir}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::labels::is_label_key;
    use crate::wpe::project::WpeKind;
    use serde_json::json;
    use std::path::PathBuf;

    fn project(workshop_id: Option<&str>, tags: &[&str], raw: Value) -> WpeProject {
        WpeProject {
            dir: PathBuf::from("wallpaper"),
            kind: WpeKind::Scene,
            file: None,
            preview: None,
            title: "T".to_string(),
            description: None,
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            workshop_id: workshop_id.map(str::to_string),
            content_rating: None,
            raw,
        }
    }

    #[test]
    fn workshop_cache_maps_ids_to_tags() {
        let tags = parse_workshop_cache(
            r#"{"user":1,"version":2,"wallpapers":[
                {"workshopid":"1","tags":"Wallpaper,Scene, Anime ,,Workshop"},
                {"workshopid":"2","tags":""},
                {"file":"local.mp4","tags":"Everyone,Local"},
                {"workshopid":3,"tags":"Anime"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags["1"], ["Wallpaper", "Scene", "Anime", "Workshop"]);
    }

    #[test]
    fn workshop_cache_tolerates_other_shapes() {
        assert!(parse_workshop_cache("{}").unwrap().is_empty());
        assert!(parse_workshop_cache(r#"{"wallpapers":{}}"#)
            .unwrap()
            .is_empty());
        assert!(parse_workshop_cache("not json").is_err());
    }

    /// 规则与本机 141 张工坊壁纸的 Steam 标签对照过：音频与视频纹理全部一致。
    #[test]
    fn derives_tags_from_project_json() {
        assert_eq!(
            derived_tags(&json!({
                "contentrating": "Questionable",
                "general": {
                    "supportsaudioprocessing": true,
                    "supportsvideo": true,
                    "supportsvideoflags": 3,
                    "properties": {
                        "schemecolor": { "type": "color" },
                        "hotkey": { "type": "usershortcut" }
                    }
                }
            })),
            [
                TAG_AUDIO_RESPONSIVE,
                TAG_VIDEO_TEXTURE,
                TAG_CUSTOMIZABLE,
                TAG_USER_SHORTCUT,
                "Questionable"
            ]
        );
    }

    #[test]
    fn derivation_needs_explicit_values() {
        assert!(derived_tags(&json!({})).is_empty());
        assert!(derived_tags(&json!({
            "contentrating": "Unknown",
            "general": {
                "supportsaudioprocessing": false,
                // 只有 `supportsvideo` 或位 2 都不算：本机 15 张这样的壁纸没有 Video Texture
                "supportsvideo": true,
                "supportsvideoflags": 2,
                "properties": { "schemecolor": { "type": "color" } }
            }
        }))
        .is_empty());
    }

    #[test]
    fn rating_key_keeps_the_steam_spelling() {
        assert_eq!(
            derived_tags(&json!({ "contentrating": " mature " })),
            ["Mature"]
        );
    }

    #[test]
    fn steam_tags_win_over_project_json() {
        let workshop = WorkshopTags::from([(
            "1".to_string(),
            vec!["Questionable".to_string(), "Approved".to_string()],
        )]);
        let raw = json!({
            "contentrating": "Everyone",
            "general": { "properties": { "music": { "type": "bool" } } }
        });
        assert_eq!(
            wallpaper_tags(&project(Some("1"), &["Anime"], raw.clone()), &workshop),
            ["Anime", "Questionable", "Approved"]
        );
        // 不在缓存里：回到推导
        assert_eq!(
            wallpaper_tags(&project(Some("2"), &["Anime"], raw.clone()), &workshop),
            ["Anime", "Customizable", "Everyone"]
        );
        assert_eq!(
            wallpaper_tags(&project(None, &[], raw), &workshop),
            ["Customizable", "Everyone"]
        );
    }

    #[test]
    fn category_type_source_and_resolution_are_not_labels() {
        let steam = "Wallpaper,Scene,Anime,Audio responsive,3840 x 2160,Mature,Customizable,\
             Puppet Warp,Video Texture,Other resolution,Dynamic resolution,Standard Definition,\
             Portrait 720 x 1280,Portrait Standard Definition,Ultrawide 3440 x 1440,Dual 5120 x 1440,\
             Triple 5760 x 1080,Video,Web,Application,Preset,Official,Workshop,Local,Oversized";
        let workshop = WorkshopTags::from([(
            "1".to_string(),
            steam.split(',').map(str::to_string).collect(),
        )]);
        assert_eq!(
            wallpaper_tags(&project(Some("1"), &[], json!({})), &workshop),
            [
                "Anime",
                "Audio responsive",
                "Mature",
                "Customizable",
                "Puppet Warp",
                "Video Texture",
                "Oversized"
            ]
        );
    }

    /// yml 用 Steam 原文作键：这里列的每个标签都要是合法 key，五种语言都要有译名。
    /// 非英语译文与英文相同的只有缩写，其它相同说明这个语言漏了（缺失时回落到英文）。
    /// 同一语言里不能重名，否则后建的标签会退化成 `name (key)`。
    #[test]
    fn known_tags_are_valid_keys_with_unique_names_in_every_locale() {
        const ACRONYMS: [&str; 4] = ["3D", "CGI", "HDR", "MMD"];
        let tags = [
            "3D",
            "Abstract",
            "Animal",
            "Anime",
            "Approved",
            TAG_AUDIO_RESPONSIVE,
            "CGI",
            "Cartoon",
            TAG_CUSTOMIZABLE,
            "Cyberpunk",
            RATING_TAGS[0],
            "Fantasy",
            "Game",
            "Girls",
            "Guys",
            "HDR",
            "Interactive",
            "Landscape",
            "MMD",
            RATING_TAGS[2],
            "Media Integration",
            "Medieval",
            "Memes",
            "Multi-monitor optimized",
            "Music",
            "Nature",
            "No Animation",
            "Oversized",
            "Pixel art",
            "Puppet Warp",
            RATING_TAGS[1],
            "Relaxing",
            "Retro",
            "Sci-Fi",
            "Sports",
            "Technology",
            "Television",
            "Unspecified",
            TAG_USER_SHORTCUT,
            "Vehicle",
            TAG_VIDEO_TEXTURE,
        ];
        for locale in kabegame_i18n::SUPPORTED_LOCALES {
            let mut names = std::collections::HashSet::new();
            for tag in tags {
                assert!(is_label_key(tag), "{tag}");
                let key = format!("wpe.tags.{tag}");
                let english = kabegame_i18n::translate_for_locale(&key, "en");
                let name = kabegame_i18n::translate_for_locale(&key, locale);
                assert!(!english.ends_with(&key), "{key} 没有英文");
                assert!(!name.contains('/'), "{locale} {tag}: 画册名不能带 /");
                assert!(names.insert(name.clone()), "{locale} 重名: {name}");
                if *locale != "en" && !ACRONYMS.contains(&tag) {
                    assert_ne!(name, english, "{locale} 没有翻译 {tag}");
                }
            }
        }
    }

    #[test]
    fn tags_go_to_the_group_wpe_shows_them_in() {
        for tag in RATING_TAGS {
            assert_eq!(tag_dir(tag), DIR_RATING);
        }
        for tag in FEATURE_TAGS {
            assert_eq!(tag_dir(tag), DIR_FEATURE, "{tag}");
        }
        for tag in ["Anime", "Pixel art", "Sci-Fi", "Unspecified", "Made up"] {
            assert_eq!(tag_dir(tag), DIR_GENRE, "{tag}");
        }
        // 路径按大小写不敏感寻址，分类也要一致，否则同一个标签会落到两个目录
        assert_eq!(tag_dir("video texture"), DIR_FEATURE);
        assert_eq!(tag_dir("MATURE"), DIR_RATING);
    }

    #[test]
    fn directories_are_valid_keys_with_names_in_every_locale() {
        for dir in [DIR_GENRE, DIR_RATING, DIR_FEATURE] {
            assert!(is_label_key(dir), "{dir}");
            let key = format!("wpe.tagDirs.{dir}");
            let english = kabegame_i18n::translate_for_locale(&key, "en");
            assert!(!english.ends_with(&key), "{key} 没有英文");
            for locale in kabegame_i18n::SUPPORTED_LOCALES {
                let name = kabegame_i18n::translate_for_locale(&key, locale);
                assert!(!name.contains('/'), "{locale} {dir}");
                if *locale != "en" {
                    assert_ne!(name, english, "{locale} 没有翻译 {dir}");
                }
            }
        }
        assert!(tag_dir_name(DIR_RATING).is_some());
        assert_eq!(tag_dir_name("nope"), None);
    }

    #[test]
    fn tag_name_is_none_only_for_unknown_tags() {
        assert!(tag_name("Anime").is_some());
        assert!(tag_name(TAG_VIDEO_TEXTURE).is_some());
        assert_eq!(tag_name("Not a real tag"), None);
    }
}
