//! `project.json` 解析与校验。
//!
//! 解析失败按 [`WpeSkip`] 分类，供导入任务按类型统计并写任务日志；不修改任何文件。

use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::is_safe_relative_path;

pub const WPE_PROJECT_FILE: &str = "project.json";

/// 创意工坊发布的场景壁纸把 `scene.json` 与项目资源打进这个包，目录里只剩 `project.json` 与预览图。
/// 渲染资源由前端读（`apps/wpe-scene/src/compile/pkg.ts`），Rust 只从里面取入口 json，见 [`WpeProject::scene_resolution`]。
pub const WPE_SCENE_PKG: &str = "scene.pkg";

/// 包里单个 `sizedString`（头部与条目名）的上限，同前端。
const PKG_MAX_STRING_BYTES: u32 = 64 * 1024;
/// 入口 json 的上限：防止损坏的包把读取放大到整包。
const PKG_MAX_ENTRY_BYTES: u32 = 64 * 1024 * 1024;

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

    /// Kabegame 已支持入库的类型。scene 入库后先显示预览图，渲染能力随阶段 3 逐步解锁。
    pub fn is_supported(&self) -> bool {
        matches!(self, Self::Video | Self::Web | Self::Scene)
    }

    /// 目录型格式键；是否已支持入库见 [`WpeKind::is_supported`]。
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

    /// 入口文件的绝对路径（仅在 `file` 校验通过时有值）。打包的场景壁纸入口在 `scene.pkg` 里，这个路径不存在。
    pub fn entry_path(&self) -> Option<PathBuf> {
        self.file.as_ref().map(|file| self.dir.join(file))
    }

    /// 取 hash / size 的文件：入口是散文件时就是入口；场景壁纸的入口打包在 `scene.pkg` 里时取包本身。
    pub fn content_path(&self) -> Option<PathBuf> {
        let entry = self.entry_path()?;
        if entry.is_file() {
            return Some(entry);
        }
        let pkg = self.dir.join(WPE_SCENE_PKG);
        (self.kind == WpeKind::Scene && pkg.is_file()).then_some(pkg)
    }

    /// 场景分辨率：入口 json 的 `general.orthogonalprojection`，入口不是散文件就到 `scene.pkg` 里读。
    /// 透视场景没有这个字段，读不到时都是 `None`，宽高留空。
    pub fn scene_resolution(&self) -> Option<(u32, u32)> {
        if self.kind != WpeKind::Scene {
            return None;
        }
        let file = self.file.as_deref()?;
        let entry = self.dir.join(file);
        let bytes = if entry.is_file() {
            std::fs::read(entry).ok()?
        } else {
            read_pkg_entry(&self.dir.join(WPE_SCENE_PKG), file).ok()??
        };
        let scene: Value =
            serde_json::from_slice(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes)).ok()?;
        let projection = scene.get("general")?.get("orthogonalprojection")?;
        let side = |key: &str| {
            let value = projection.get(key)?.as_f64()?;
            (value >= 1.0).then(|| value.round() as u32)
        };
        Some((side("width")?, side("height")?))
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

fn read_pkg_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_pkg_string(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let length = read_pkg_u32(reader)?;
    if length > PKG_MAX_STRING_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut bytes = vec![0; length as usize];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// 读 `scene.pkg` 里的一个条目，没有这个条目时是 `None`。格式见 `apps/wpe-scene/src/compile/pkg.ts`：
/// `sizedString` 头、u32 条目数、条目表（`sizedString` 名、u32 偏移、u32 长度），数据区紧跟在条目表之后，全部小端。
fn read_pkg_entry(path: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
    let mut reader = BufReader::new(File::open(path)?);
    read_pkg_string(&mut reader)?;
    let count = read_pkg_u32(&mut reader)?;
    let mut found = None;
    for _ in 0..count {
        let entry = read_pkg_string(&mut reader)?;
        let offset = read_pkg_u32(&mut reader)?;
        let length = read_pkg_u32(&mut reader)?;
        if found.is_none() && entry == name.as_bytes() {
            found = Some((offset, length));
        }
    }
    let Some((offset, length)) = found else {
        return Ok(None);
    };
    if length > PKG_MAX_ENTRY_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let data_start = reader.stream_position()?;
    reader.seek(SeekFrom::Start(data_start + u64::from(offset)))?;
    let mut bytes = vec![0; length as usize];
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

/// 跳过某个壁纸目录的原因。
#[derive(Debug, Clone)]
pub enum WpeSkip {
    /// 目录里没有 `project.json`。
    NoProject,
    /// 类型不受支持（application / 其它；导入 video、web 与 scene）。
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
    let raw: Value = serde_json::from_str(&text)
        .map_err(|error| WpeSkip::Invalid(format!("JSON 无效：{error}")))?;
    if !raw.is_object() {
        return Err(WpeSkip::Invalid("根节点不是对象".to_string()));
    }

    let file = read_string(&raw, "file");
    if let Some(file) = file.as_deref() {
        if !is_safe_relative_path(file) {
            return Err(WpeSkip::Invalid(format!("入口路径越界：{file}")));
        }
    }

    // 部分默认项目（audiophile、techno）没有 `type`，但入口是场景 json，WPE 照场景处理
    let kind = match read_string(&raw, "type") {
        Some(kind) => WpeKind::parse(&kind),
        None if file
            .as_deref()
            .is_some_and(|file| file.to_ascii_lowercase().ends_with(".json")) =>
        {
            WpeKind::Scene
        }
        None => WpeKind::Other,
    };

    // 预览是可选项：声明了但不存在或越界时按「无预览」处理，不让整张壁纸失败。
    let preview = read_string(&raw, "preview").and_then(|preview| {
        if !is_safe_relative_path(&preview) || !dir.join(&preview).is_file() {
            None
        } else {
            Some(preview)
        }
    });

    // 已支持入库的类型都要求入口文件存在（video 是视频文件，web 是入口 html，scene 是场景 json）。
    // 创意工坊发布的场景把入口打进 `scene.pkg`：有包就算入口存在，包里是否真有入口交给前端编译时判断。
    if kind.is_supported() {
        let Some(file) = file.as_deref() else {
            return Err(WpeSkip::MissingEntry(
                "project.json 未声明 file".to_string(),
            ));
        };
        let packed = kind == WpeKind::Scene && dir.join(WPE_SCENE_PKG).is_file();
        if !dir.join(file).is_file() && !packed {
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
        let dir =
            std::env::temp_dir().join(format!("kabegame-wpe-test-{name}-{}", uuid::Uuid::new_v4()));
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
    fn web_project_requires_entry() {
        let dir = temp_dir("web");
        fs::write(dir.join("index.html"), b"<html></html>").unwrap();
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"index.html","type":"web","preview":"missing.jpg"}"#,
        )
        .unwrap();
        let project = read_project(&dir).expect("web project should parse");
        assert_eq!(project.kind, WpeKind::Web);
        assert!(project.kind.is_supported());
        assert_eq!(project.kind.media_type(), Some("x-wpe/web"));

        fs::remove_file(dir.join("index.html")).unwrap();
        match read_project(&dir) {
            Err(WpeSkip::MissingEntry(file)) => assert_eq!(file, "index.html"),
            other => panic!("expected MissingEntry, got {other:?}"),
        }
        fs::remove_dir_all(dir).ok();
    }

    /// 按 `scene.pkg` 的布局打一个包；第一个条目放在数据区开头以外，确认偏移是相对数据区的。
    fn pkg(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let sized = |bytes: &[u8]| [&(bytes.len() as u32).to_le_bytes(), bytes].concat();
        let mut table = sized(b"PKGV0022");
        table.extend((entries.len() as u32).to_le_bytes());
        let mut data = Vec::new();
        for (name, bytes) in entries {
            table.extend(sized(name.as_bytes()));
            table.extend((data.len() as u32).to_le_bytes());
            table.extend((bytes.len() as u32).to_le_bytes());
            data.extend_from_slice(bytes);
        }
        [table, data].concat()
    }

    fn scene_project(dir: &Path) -> WpeProject {
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"scene.json","type":"scene"}"#,
        )
        .unwrap();
        read_project(dir).expect("scene project should parse")
    }

    const SCENE_JSON: &str = r#"{"general":{"orthogonalprojection":{"width":2200,"height":1080}}}"#;

    #[test]
    fn scene_resolution_reads_the_loose_entry() {
        let dir = temp_dir("resolution-loose");
        fs::write(dir.join("scene.json"), SCENE_JSON).unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), Some((2200, 1080)));
    }

    #[test]
    fn scene_resolution_tolerates_a_bom() {
        let dir = temp_dir("resolution-bom");
        fs::write(dir.join("scene.json"), format!("\u{feff}{SCENE_JSON}")).unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), Some((2200, 1080)));
    }

    #[test]
    fn scene_resolution_reads_the_packed_entry() {
        let dir = temp_dir("resolution-pkg");
        let bytes = pkg(&[
            ("materials/a.tex", b"binary"),
            ("scene.json", SCENE_JSON.as_bytes()),
        ]);
        fs::write(dir.join(WPE_SCENE_PKG), bytes).unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), Some((2200, 1080)));
    }

    #[test]
    fn scene_resolution_is_none_when_it_cannot_be_read() {
        // 透视场景没有 orthogonalprojection
        let dir = temp_dir("resolution-perspective");
        fs::write(dir.join("scene.json"), r#"{"general":{"zoom":1}}"#).unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), None);
        // 包里没有入口
        let dir = temp_dir("resolution-missing");
        fs::write(dir.join(WPE_SCENE_PKG), pkg(&[("other.json", b"{}")])).unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), None);
        // 包被截断、头部长度离谱
        let dir = temp_dir("resolution-truncated");
        let bytes = pkg(&[("scene.json", SCENE_JSON.as_bytes())]);
        fs::write(dir.join(WPE_SCENE_PKG), &bytes[..bytes.len() - 8]).unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), None);
        let dir = temp_dir("resolution-corrupt");
        fs::write(dir.join(WPE_SCENE_PKG), u32::MAX.to_le_bytes()).unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), None);
        // 尺寸无效
        let dir = temp_dir("resolution-zero");
        fs::write(
            dir.join("scene.json"),
            r#"{"general":{"orthogonalprojection":{"width":0,"height":1080}}}"#,
        )
        .unwrap();
        assert_eq!(scene_project(&dir).scene_resolution(), None);
    }

    #[test]
    fn scene_resolution_is_only_for_scenes() {
        let dir = temp_dir("resolution-web");
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"index.html","type":"web"}"#,
        )
        .unwrap();
        fs::write(dir.join("index.html"), "<html>").unwrap();
        let project = read_project(&dir).expect("web project should parse");
        assert_eq!(project.scene_resolution(), None);
    }

    /// 本机语料：`KABEGAME_WPE_ROOT` 指向 WPE 安装目录时才跑，创意工坊的真实 `scene.pkg` 要能读出分辨率。
    #[test]
    fn scene_resolution_reads_the_local_corpus() {
        let Ok(root) = std::env::var("KABEGAME_WPE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let workshop = root.join("../../workshop/content/431960");
        let (mut loose, mut packed, mut unread) = (0, 0, 0);
        for base in [root.join("projects/defaultprojects"), workshop] {
            for item in fs::read_dir(base).unwrap().flatten() {
                let Ok(project) = read_project(&item.path()) else {
                    continue;
                };
                if project.kind != WpeKind::Scene {
                    continue;
                }
                let is_packed = project.entry_path().is_some_and(|entry| !entry.is_file());
                match (project.scene_resolution(), is_packed) {
                    (Some(_), true) => packed += 1,
                    (Some(_), false) => loose += 1,
                    (None, _) => unread += 1,
                }
            }
        }
        println!("散文件 {loose}，scene.pkg {packed}，读不到 {unread}");
        assert!(loose > 0 && packed > 0, "{loose} {packed}");
    }

    #[test]
    fn scene_entry_may_be_packed() {
        let dir = temp_dir("scene");
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"scene.json","type":"Scene"}"#,
        )
        .unwrap();
        // 既没有散文件入口也没有包
        match read_project(&dir) {
            Err(WpeSkip::MissingEntry(file)) => assert_eq!(file, "scene.json"),
            other => panic!("expected MissingEntry, got {other:?}"),
        }

        // 创意工坊形态：只有 scene.pkg，hash / size 取包
        fs::write(dir.join(WPE_SCENE_PKG), b"PKGV").unwrap();
        let project = read_project(&dir).expect("packed scene should parse");
        assert_eq!(project.kind, WpeKind::Scene);
        assert!(project.kind.is_supported());
        assert_eq!(project.kind.media_type(), Some("x-wpe/scene"));
        assert_eq!(
            project.content_path(),
            Some(project.dir.join(WPE_SCENE_PKG))
        );

        // 散文件入口优先
        fs::write(dir.join("scene.json"), b"{}").unwrap();
        let project = read_project(&dir).unwrap();
        assert_eq!(project.content_path(), Some(project.dir.join("scene.json")));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn missing_type_with_json_entry_is_scene() {
        let dir = temp_dir("untyped");
        fs::write(dir.join("techno.json"), b"{}").unwrap();
        fs::write(dir.join(WPE_PROJECT_FILE), r#"{"file":"techno.json"}"#).unwrap();
        assert_eq!(read_project(&dir).unwrap().kind, WpeKind::Scene);

        // 没有 type、入口也不是 json：仍是不支持的其它类型
        fs::write(dir.join("sheep.exe"), b"x").unwrap();
        fs::write(dir.join(WPE_PROJECT_FILE), r#"{"file":"sheep.exe"}"#).unwrap();
        assert_eq!(read_project(&dir).unwrap().kind, WpeKind::Other);

        // 只有 pkg 不能让其它类型通过：`content_path` 只为场景取包
        fs::write(dir.join(WPE_SCENE_PKG), b"PKGV").unwrap();
        fs::write(
            dir.join(WPE_PROJECT_FILE),
            r#"{"file":"index.html","type":"web"}"#,
        )
        .unwrap();
        assert!(matches!(read_project(&dir), Err(WpeSkip::MissingEntry(_))));
        fs::remove_dir_all(dir).ok();
    }
}
