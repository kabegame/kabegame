//! `project.json` 解析与校验。
//!
//! 解析失败按 [`WpeSkip`] 分类，供导入任务按类型统计并写任务日志；不修改任何文件。

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::is_safe_relative_path;

pub const WPE_PROJECT_FILE: &str = "project.json";

/// `project.json` 的 `type`：WPE 壁纸类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WpeKind {
    Video,
    Web,
    Scene,
    Application,
    Other,
}

impl WpeKind {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "video" => Self::Video,
            "web" => Self::Web,
            "scene" => Self::Scene,
            "application" | "app" => Self::Application,
            _ => Self::Other,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Web => "web",
            Self::Scene => "scene",
            Self::Application => "application",
            Self::Other => "other",
        }
    }

    /// 可入库的目录型格式键；第一阶段只实现 `video`。
    pub fn media_type(self) -> Option<&'static str> {
        match self {
            Self::Video => Some("x-wpe/video"),
            Self::Web => Some("x-wpe/web"),
            Self::Scene => Some("x-wpe/scene"),
            Self::Application | Self::Other => None,
        }
    }
}

/// 一个可导入的 WPE 壁纸目录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WpeProject {
    /// 绝对、规范化、无 `\\?\` 前缀、无尾斜杠 → 直接作为 `images.local_path`。
    pub dir: PathBuf,
    pub kind: WpeKind,
    /// 入口文件（目录内相对路径）。
    pub file: Option<String>,
    /// 预览图（目录内相对路径）；文件不存在时已归为 `None`。
    pub preview: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub workshop_id: Option<String>,
    pub content_rating: Option<String>,
    /// `project.json` 原文，写进 metadata 供详情面板展示。
    pub raw: Value,
}

impl WpeProject {
    pub fn dir_string(&self) -> String {
        self.dir.to_string_lossy().into_owned()
    }

    /// 入口文件的绝对路径（仅在 `file` 校验通过时有值）。
    pub fn entry_path(&self) -> Option<PathBuf> {
        self.file.as_ref().map(|file| self.dir.join(file))
    }

    /// 预览图的绝对路径。
    pub fn preview_path(&self) -> Option<PathBuf> {
        self.preview.as_ref().map(|preview| self.dir.join(preview))
    }

    /// 创意工坊页面地址（有 workshop id 时）。
    pub fn workshop_url(&self) -> Option<String> {
        self.workshop_id
            .as_deref()
            .map(|id| format!("https://steamcommunity.com/sharedfiles/filedetails/?id={id}"))
    }
}

/// 跳过某个壁纸目录的原因。
#[derive(Debug, Clone)]
pub enum WpeSkip {
    /// 目录里没有 `project.json`。
    NoProject,
    /// 类型不受支持（web / scene / application / 其它，第一阶段只导入 video）。
    Unsupported(WpeKind),
    /// 声明了入口但入口文件不存在。
    MissingEntry(String),
    /// `project.json` 非法。
    Invalid(String),
}

impl WpeSkip {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoProject => "no-project",
            Self::Unsupported(_) => "unsupported",
            Self::MissingEntry(_) => "missing-entry",
            Self::Invalid(_) => "invalid",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::NoProject => "目录内没有 project.json".to_string(),
            Self::Unsupported(kind) => format!("暂不支持的壁纸类型：{}", kind.as_str()),
            Self::MissingEntry(file) => format!("入口文件不存在：{file}"),
            Self::Invalid(reason) => format!("project.json 非法：{reason}"),
        }
    }
}

fn read_string(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn read_tags(value: &Value) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(items) = value.get("tags").and_then(Value::as_array) {
        for item in items {
            let Some(tag) = item.as_str().map(str::trim) else {
                continue;
            };
            if tag.is_empty() || tags.iter().any(|existing| existing == tag) {
                continue;
            }
            tags.push(tag.to_string());
        }
    }
    tags
}

/// 创意工坊目录里的壁纸可能不带 `workshopid`，回退用 `431960/<id>` 的目录名。
fn workshop_id_from_path(dir: &Path, value: &Value) -> Option<String> {
    if let Some(id) = read_string(value, "workshopid") {
        return Some(id);
    }
    let parent = dir.parent()?.file_name()?.to_str()?;
    let name = dir.file_name()?.to_str()?.trim();
    if parent == "431960" && !name.is_empty() && name.chars().all(|ch| ch.is_ascii_digit()) {
        return Some(name.to_string());
    }
    None
}

/// 解析一个壁纸目录；`dir` 由调用方保证已存在。
pub fn read_project(dir: &Path) -> Result<WpeProject, WpeSkip> {
    let dir = super::normalize_local_dir(dir).ok_or_else(|| WpeSkip::NoProject)?;
    let project_path = dir.join(WPE_PROJECT_FILE);
    if !project_path.is_file() {
        return Err(WpeSkip::NoProject);
    }

    let text = std::fs::read_to_string(&project_path)
        .map_err(|error| WpeSkip::Invalid(format!("读取失败：{error}")))?;
    let raw: Value =
        serde_json::from_str(&text).map_err(|error| WpeSkip::Invalid(format!("JSON 无效：{error}")))?;
    if !raw.is_object() {
        return Err(WpeSkip::Invalid("根节点不是对象".to_string()));
    }

    let kind = WpeKind::parse(read_string(&raw, "type").as_deref().unwrap_or("other"));

    let file = read_string(&raw, "file");
    if let Some(file) = file.as_deref() {
        if !is_safe_relative_path(file) {
            return Err(WpeSkip::Invalid(format!("入口路径越界：{file}")));
        }
    }

    // 预览是可选项：声明了但不存在或越界时按「无预览」处理，不让整张壁纸失败。
    let preview = read_string(&raw, "preview").and_then(|preview| {
        if !is_safe_relative_path(&preview) || !dir.join(&preview).is_file() {
            None
        } else {
            Some(preview)
        }
    });

    if kind == WpeKind::Video {
        let Some(file) = file.as_deref() else {
            return Err(WpeSkip::MissingEntry("project.json 未声明 file".to_string()));
        };
        if !dir.join(file).is_file() {
            return Err(WpeSkip::MissingEntry(file.to_string()));
        }
    }

    let title = read_string(&raw, "title").unwrap_or_else(|| {
        dir.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Wallpaper Engine")
            .to_string()
    });

    Ok(WpeProject {
        kind,
        file,
        preview,
        title,
        description: read_string(&raw, "description"),
        tags: read_tags(&raw),
        workshop_id: workshop_id_from_path(&dir, &raw),
        content_rating: read_string(&raw, "contentrating"),
        raw,
        dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kabegame-wpe-test-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_video_project_and_normalizes_fields() {
        let dir = temp_dir("video");
        fs::write(dir.join("Wallpaper-1.mp4"), b"not-really-a-video").unwrap();
        fs::write(dir.join("preview.gif"), b"gif").unwrap();
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{
                "file": "Wallpaper-1.mp4",
                "preview": "preview.gif",
                "title": "Solitude",
                "type": "Video",
                "tags": ["Retro", "Retro", " "],
                "contentrating": "Everyone",
                "workshopid": 123
            }"#,
        )
        .unwrap();

        let project = read_project(&dir).expect("project should parse");
        assert_eq!(project.kind, WpeKind::Video);
        assert_eq!(project.file.as_deref(), Some("Wallpaper-1.mp4"));
        assert_eq!(project.preview.as_deref(), Some("preview.gif"));
        assert_eq!(project.title, "Solitude");
        assert_eq!(project.tags, vec!["Retro"]);
        assert_eq!(project.workshop_id.as_deref(), Some("123"));
        assert_eq!(
            project.workshop_url().as_deref(),
            Some("https://steamcommunity.com/sharedfiles/filedetails/?id=123")
        );
        assert!(project.entry_path().is_some());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn workshop_id_falls_back_to_directory_name() {
        let root = temp_dir("workshop");
        let dir = root.join("431960").join("2725770343");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("entry.mp4"), b"x").unwrap();
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"entry.mp4","preview":"missing.gif","title":"T","type":"video"}"#,
        )
        .unwrap();

        let project = read_project(&dir).expect("project should parse");
        assert_eq!(project.workshop_id.as_deref(), Some("2725770343"));
        // 预览缺失归为 None，不影响导入。
        assert_eq!(project.preview, None);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_traversal_and_missing_entry() {
        let dir = temp_dir("invalid");
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"../outside.mp4","type":"video"}"#,
        )
        .unwrap();
        match read_project(&dir) {
            Err(WpeSkip::Invalid(_)) => {}
            other => panic!("expected Invalid, got {other:?}"),
        }

        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"missing.mp4","type":"video"}"#,
        )
        .unwrap();
        match read_project(&dir) {
            Err(WpeSkip::MissingEntry(file)) => assert_eq!(file, "missing.mp4"),
            other => panic!("expected MissingEntry, got {other:?}"),
        }
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unsupported_kinds_are_preserved_for_stats() {
        let dir = temp_dir("web");
        fs::write(dir.join("index.html"), b"<html></html>").unwrap();
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"index.html","type":"web","preview":"missing.jpg"}"#,
        )
        .unwrap();
        let project = read_project(&dir).expect("web project should parse");
        assert_eq!(project.kind, WpeKind::Web);
        assert_eq!(project.kind.media_type(), Some("x-wpe/web"));
        fs::remove_dir_all(dir).ok();
    }
}
