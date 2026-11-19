//! 创意工坊：列订阅、查条目详情、把条目下载进 `<WPE>/projects/myprojects/<条目 id>/`。
//!
//! - 列订阅是 `PublishedFile.GetUserFiles#1`（`type = "mysubscriptions"`），工坊发现是 `PublishedFile.QueryFiles#1`；
//!   分页、排序、搜索与筛选都交给 Steam：分级是 WPE 的三个标签 [`RATINGS`]，每条恰有一个；筛选用 `excludedtags`
//!   排除没选的分级 / 类型（组内「或」、组间「与」）。
//! - 条目的 `hcontent_file` 是工坊 depot（PICS 的 `workshopdepot`）的 manifest id；之后的 request code、
//!   CDN、manifest、chunk 与下载本体同一套（[`super::install`] 的计划与下载函数）。
//! - 条目状态记在 `<WPE>/projects/myprojects/kabegame_workshop.json`（条目 id → manifest id、文件、Steam 标签），
//!   跟着 WPE 目录走；manifest id 没变且文件都在就跳过，变了只补变化的文件、删掉新版本里没有的旧文件。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use steam_vent::{Connection, ConnectionTrait};
use steam_vent_proto_steam::steammessages_publishedfile_steamclient::{
    CPublishedFile_GetDetails_Request, CPublishedFile_GetUserFiles_Request, CPublishedFile_QueryFiles_Request,
    PublishedFileDetails,
};

use super::cdn::{CdnPool, ManifestFile};
use super::cm::{self, CmError};
use super::install::{download_files, now_secs, plan_downloads, FileState, PullHooks};
use super::WPE_APP_ID;

/// WPE 的分级标签（Steam 标签原文），每个条目恰有一个。
pub const RATINGS: [&str; 3] = ["Everyone", "Questionable", "Mature"];
/// 类型标签（Steam 标签原文）→ 条目类型。
const KIND_TAGS: [(&str, &str); 5] = [
    ("Scene", "scene"),
    ("Video", "video"),
    ("Web", "web"),
    ("Application", "application"),
    ("Preset", "preset"),
];
/// Kabegame 能导入的条目类型。
const SUPPORTED_KINDS: [&str; 3] = ["scene", "video", "web"];
/// 工坊发现里固定排除的类型：导入不了（预设约 14 万条，程序壁纸只有 1 条）。
const DISCOVER_EXCLUDED: [&str; 2] = ["Application", "Preset"];
/// 条目状态文件；`project.rs` 也读它，从目录认出 Steam 下载的条目 id。
const STATE_FILE: &str = crate::wpe::project::WORKSHOP_STATE_FILE;
/// 一次 `GetUserFiles` / `GetDetails` 最多取多少条。
const MAX_PER_PAGE: u32 = 100;

/// 条目在本地的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalState {
    /// 本地没有。
    Missing,
    /// 已是 Steam 上的版本。
    Current,
    /// 本地有目录，但不是 Steam 上的版本（或不是 Kabegame 下载的）。
    Outdated,
}

/// 一个创意工坊条目（对话框列表与任务共用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopItem {
    /// published file id（字符串，避免 JS 数字精度问题）。
    pub id: String,
    pub title: String,
    pub preview_url: Option<String>,
    /// 条目内容的字节数（Steam 给的，下载前用来估算）。
    pub file_size: u64,
    /// 工坊 depot 的 manifest id；没有时为 `"0"`。
    pub manifest_id: String,
    pub time_updated: u32,
    pub time_subscribed: u32,
    /// 当前订阅人数。
    pub subscriptions: u32,
    pub tags: Vec<String>,
    /// [`RATINGS`] 之一。
    pub rating: Option<String>,
    /// scene / video / web / application / preset / unknown。
    pub kind: String,
    /// Kabegame 能不能导入（类型受支持且有 manifest）。
    pub supported: bool,
    pub local: LocalState,
}

impl WorkshopItem {
    fn manifest(&self) -> u64 {
        self.manifest_id.parse().unwrap_or(0)
    }
}

fn item_from(details: &PublishedFileDetails) -> Option<WorkshopItem> {
    if details.result() != 1 || details.publishedfileid() == 0 {
        return None;
    }
    let tags: Vec<String> = details.tags.iter().map(|tag| tag.tag().to_string()).collect();
    let rating = tags.iter().find(|tag| RATINGS.contains(&tag.as_str())).cloned();
    let kind = KIND_TAGS
        .iter()
        .find(|(tag, _)| tags.iter().any(|t| t == tag))
        .map(|(_, kind)| kind.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let manifest = details.hcontent_file();
    Some(WorkshopItem {
        id: details.publishedfileid().to_string(),
        title: details.title().to_string(),
        preview_url: Some(details.preview_url().to_string()).filter(|url| !url.is_empty()),
        file_size: details.file_size(),
        manifest_id: manifest.to_string(),
        time_updated: details.time_updated(),
        time_subscribed: details.time_subscribed(),
        subscriptions: details.subscriptions(),
        tags,
        rating,
        supported: manifest != 0 && SUPPORTED_KINDS.contains(&kind.as_str()),
        kind,
        local: LocalState::Missing,
    })
}

/// 订阅列表的排序。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubscriptionSort {
    /// 条目更新时间从新到旧（Steam 缺省）。
    #[default]
    LastUpdated,
    /// 订阅时间从新到旧。
    SubscriptionDate,
}

impl SubscriptionSort {
    fn method(self) -> &'static str {
        match self {
            Self::LastUpdated => "lastupdated",
            Self::SubscriptionDate => "subscriptiondate",
        }
    }
}

/// 只保留选中的分级：排除没选的。空表示全部。
fn excluded_ratings(ratings: &[String]) -> Vec<String> {
    if ratings.is_empty() {
        return Vec::new();
    }
    RATINGS
        .iter()
        .filter(|rating| !ratings.iter().any(|r| r == *rating))
        .map(|rating| rating.to_string())
        .collect()
}

/// 工坊发现的排除标签：没选的分级、没选的类型（`kinds` 是 scene / video / web，空表示全部），加上导入不了的类型。
fn discover_excluded_tags(ratings: &[String], kinds: &[String]) -> Vec<String> {
    let mut tags = excluded_ratings(ratings);
    if !kinds.is_empty() {
        tags.extend(
            KIND_TAGS
                .iter()
                .filter(|(_, kind)| SUPPORTED_KINDS.contains(kind) && !kinds.iter().any(|k| k == kind))
                .map(|(tag, _)| tag.to_string()),
        );
    }
    tags.extend(DISCOVER_EXCLUDED.iter().map(|tag| tag.to_string()));
    tags
}

/// 工坊发现的排序（`query_type`，2026-11-15 实测含义）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscoverSort {
    /// 趋势（配时间窗 `days`）：3。
    #[default]
    Trend,
    /// 总订阅数：9。
    MostSubscribed,
    /// 评分：0。
    TopRated,
    /// 最新发布：1。
    Newest,
    /// 最近更新：21。
    RecentlyUpdated,
    /// 搜索相关度：12。
    Relevance,
}

impl DiscoverSort {
    fn query_type(self) -> u32 {
        match self {
            Self::Trend => 3,
            Self::MostSubscribed => 9,
            Self::TopRated => 0,
            Self::Newest => 1,
            Self::RecentlyUpdated => 21,
            Self::Relevance => 12,
        }
    }
}

/// 一页工坊发现的条件。
#[derive(Debug, Clone, Default)]
pub struct DiscoverQuery {
    pub page: u32,
    pub per_page: u32,
    pub sort: DiscoverSort,
    /// 趋势的时间窗（天）；只对 [`DiscoverSort::Trend`] 有意义。
    pub days: Option<u32>,
    /// 搜索文字；为空不搜。能叠加任何排序。
    pub text: Option<String>,
    pub ratings: Vec<String>,
    pub kinds: Vec<String>,
}

/// 取一页工坊发现（`page` 从 1 起）。本地状态由调用方用 [`fill_local_state`] 补。
pub async fn discover_page(connection: &Connection, query: &DiscoverQuery) -> Result<WorkshopPage, CmError> {
    let per_page = query.per_page.clamp(1, MAX_PER_PAGE);
    let page = query.page.max(1);
    let text = query
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    let rsp = connection
        .service_method(CPublishedFile_QueryFiles_Request {
            query_type: Some(query.sort.query_type()),
            page: Some(page),
            numperpage: Some(per_page),
            appid: Some(WPE_APP_ID),
            excludedtags: discover_excluded_tags(&query.ratings, &query.kinds),
            search_text: text,
            days: query.days.filter(|_| query.sort == DiscoverSort::Trend),
            return_tags: Some(true),
            ..Default::default()
        })
        .await
        .map_err(|error| CmError::Other(format!("浏览创意工坊失败：{error}")))?;
    Ok(WorkshopPage {
        total: rsp.total(),
        page,
        per_page,
        items: rsp.publishedfiledetails.iter().filter_map(item_from).collect(),
    })
}

/// 一页条目（订阅或工坊发现）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkshopPage {
    /// 筛选后的总条数。
    pub total: u32,
    pub page: u32,
    pub per_page: u32,
    pub items: Vec<WorkshopItem>,
}

/// 取一页订阅（`page` 从 1 起）。本地状态由调用方用 [`fill_local_state`] 补。
pub async fn subscriptions_page(
    connection: &Connection,
    page: u32,
    per_page: u32,
    sort: SubscriptionSort,
    ratings: &[String],
) -> Result<WorkshopPage, CmError> {
    let per_page = per_page.clamp(1, MAX_PER_PAGE);
    let page = page.max(1);
    let rsp = connection
        .service_method(CPublishedFile_GetUserFiles_Request {
            steamid: Some(u64::from(connection.steam_id())),
            appid: Some(WPE_APP_ID),
            page: Some(page),
            numperpage: Some(per_page),
            type_: Some("mysubscriptions".to_string()),
            sortmethod: Some(sort.method().to_string()),
            excludedtags: excluded_ratings(ratings),
            return_tags: Some(true),
            ..Default::default()
        })
        .await
        .map_err(|error| CmError::Other(format!("获取创意工坊订阅失败：{error}")))?;
    Ok(WorkshopPage {
        total: rsp.total(),
        page,
        per_page,
        items: rsp.publishedfiledetails.iter().filter_map(item_from).collect(),
    })
}

/// 选中分级下的全部订阅（任务里「导入全部订阅」用）。
pub async fn all_subscriptions(
    connection: &Connection,
    ratings: &[String],
) -> Result<Vec<WorkshopItem>, CmError> {
    let mut items = Vec::new();
    let mut page = 1;
    loop {
        let batch =
            subscriptions_page(connection, page, MAX_PER_PAGE, SubscriptionSort::LastUpdated, ratings)
                .await?;
        let count = batch.items.len();
        items.extend(batch.items);
        if count == 0 || items.len() >= batch.total as usize {
            break;
        }
        page += 1;
    }
    Ok(items)
}

/// 按 id 查条目详情（任务里「导入选中的条目」用，取任务运行时的最新 manifest）。查不到的条目不返回。
pub async fn details(connection: &Connection, ids: &[u64]) -> Result<Vec<WorkshopItem>, CmError> {
    let mut items = Vec::new();
    for chunk in ids.chunks(MAX_PER_PAGE as usize) {
        let rsp = connection
            .service_method(CPublishedFile_GetDetails_Request {
                publishedfileids: chunk.to_vec(),
                includetags: Some(true),
                appid: Some(WPE_APP_ID),
                ..Default::default()
            })
            .await
            .map_err(|error| CmError::Other(format!("获取创意工坊条目详情失败：{error}")))?;
        items.extend(rsp.publishedfiledetails.iter().filter_map(item_from));
    }
    Ok(items)
}

/// 搜索框里填的是不是条目 id：整段由 id 组成（空格、逗号、分号、换行分隔）时返回它们（去重、保序），否则 None。
/// 每段可以是纯数字，也可以是工坊链接（`…/filedetails/?id=<id>`、`steam://url/CommunityFilePage/<id>`）。
pub fn parse_item_ids(text: &str) -> Option<Vec<u64>> {
    let mut ids = Vec::new();
    for token in text
        .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | '，' | ';' | '；'))
        .filter(|token| !token.is_empty())
    {
        let digits = if token.chars().all(|ch| ch.is_ascii_digit()) {
            token
        } else {
            let start = ["?id=", "&id=", "CommunityFilePage/"]
                .iter()
                .find_map(|key| token.find(key).map(|at| at + key.len()))?;
            let rest = &token[start..];
            let end = rest.find(|ch: char| !ch.is_ascii_digit()).unwrap_or(rest.len());
            &rest[..end]
        };
        let id = digits.parse::<u64>().ok().filter(|id| *id != 0)?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    (!ids.is_empty()).then_some(ids)
}

/// 按 id 查出的条目当作一页（工坊发现里搜 id 时用）。别的游戏的条目（Steam 回 `result = 8`）与不存在的（`9`）不返回。
pub async fn details_page(connection: &Connection, ids: &[u64]) -> Result<WorkshopPage, CmError> {
    let items = details(connection, ids).await?;
    Ok(WorkshopPage {
        total: items.len() as u32,
        page: 1,
        per_page: ids.len().max(1) as u32,
        items,
    })
}

// ---------- 本地状态 ----------

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkshopState {
    items: BTreeMap<String, ItemState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemState {
    manifest_id: String,
    files: BTreeMap<String, FileState>,
    /// Steam 标签：导入时与 WPE 自己的工坊缓存同一用途（见 [`crate::wpe::tags::read_workshop_tags`]）。
    tags: Vec<String>,
    updated_at: u64,
}

/// `<WPE>/projects/myprojects`：工坊条目的落盘目录。
pub fn myprojects_dir(engine: &Path) -> PathBuf {
    engine.join("projects").join("myprojects")
}

fn state_path(engine: &Path) -> PathBuf {
    myprojects_dir(engine).join(STATE_FILE)
}

fn read_state(engine: &Path) -> WorkshopState {
    std::fs::read(state_path(engine))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_state(engine: &Path, state: &WorkshopState) -> Result<(), String> {
    let path = state_path(engine);
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(myprojects_dir(engine)).map_err(|e| format!("写创意工坊状态失败：{e}"))?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("写创意工坊状态失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写创意工坊状态失败：{e}"))
}

fn local_state_of(engine: &Path, state: &WorkshopState, item: &WorkshopItem) -> LocalState {
    let dir = myprojects_dir(engine).join(&item.id);
    if !dir.join("project.json").is_file() {
        return LocalState::Missing;
    }
    match state.items.get(&item.id) {
        Some(recorded) if recorded.manifest_id == item.manifest_id => LocalState::Current,
        _ => LocalState::Outdated,
    }
}

/// 按 `<WPE>/projects/myprojects` 补上每个条目的本地状态。阻塞调用。
pub fn fill_local_state(engine: Option<&Path>, items: &mut [WorkshopItem]) {
    let Some(engine) = engine else {
        return;
    };
    let state = read_state(engine);
    for item in items {
        item.local = local_state_of(engine, &state, item);
    }
}

/// Kabegame 下载过的条目的 Steam 标签（工坊 id → 标签），给导入时打标签用。阻塞调用。
pub fn recorded_tags(engine: &Path) -> HashMap<String, Vec<String>> {
    read_state(engine)
        .items
        .into_iter()
        .filter(|(_, item)| !item.tags.is_empty())
        .map(|(id, item)| (id, item.tags))
        .collect()
}

// ---------- 下载 ----------

/// 一次任务里下载条目用的上下文：账号的共享 CM 连接（见 [`cm::shared_connection`]）、工坊 depot 的密钥与 CDN 池。
pub struct WorkshopDownloader {
    connection: Arc<Connection>,
    pool: Arc<CdnPool>,
    depot_id: u32,
    keys: Arc<HashMap<u32, Vec<u8>>>,
}

/// 一个条目的下载结果。
#[derive(Debug)]
pub enum ItemOutcome {
    /// 已是最新，没有下载。
    UpToDate(PathBuf),
    /// 下载或更新完成。
    Downloaded { dir: PathBuf, files: usize, bytes: u64 },
}

impl WorkshopDownloader {
    /// 登录 CM、查工坊 depot、取密钥与 CDN 服务器。
    pub async fn open(account: &str) -> Result<Self, CmError> {
        let (connection, build) = cm::connect_and_build(account, WPE_APP_ID).await?;
        let depot_id = build.workshop_depot.unwrap_or(WPE_APP_ID);
        let key = cm::depot_key(&connection, WPE_APP_ID, depot_id).await?;
        let servers = cm::cdn_servers(&connection, WPE_APP_ID).await?;
        let pool = Arc::new(CdnPool::new(WPE_APP_ID, (*connection).clone(), servers));
        Ok(Self {
            connection,
            pool,
            depot_id,
            keys: Arc::new(HashMap::from([(depot_id, key)])),
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// 把一个条目下载进 `<engine>/projects/myprojects/<id>/`，按 manifest 增量；完成后写状态。
    pub async fn download(
        &self,
        engine: &Path,
        item: &WorkshopItem,
        hooks: &PullHooks<'_>,
    ) -> Result<ItemOutcome, String> {
        let manifest_id = item.manifest();
        if manifest_id == 0 {
            return Err("这个条目没有可下载的内容".to_string());
        }
        let dir = myprojects_dir(engine).join(&item.id);
        let state = {
            let engine = engine.to_path_buf();
            tokio::task::spawn_blocking(move || read_state(&engine))
                .await
                .map_err(|e| e.to_string())?
        };
        let recorded = state.items.get(&item.id).cloned();
        if let Some(recorded) = recorded.as_ref().filter(|r| r.manifest_id == item.manifest_id) {
            let root = dir.clone();
            let files: Vec<(String, u64)> =
                recorded.files.iter().map(|(p, f)| (p.clone(), f.size)).collect();
            let all_present = tokio::task::spawn_blocking(move || {
                files
                    .iter()
                    .all(|(path, size)| std::fs::metadata(root.join(path)).is_ok_and(|m| m.len() == *size))
            })
            .await
            .unwrap_or(false);
            if all_present {
                return Ok(ItemOutcome::UpToDate(dir));
            }
        }

        let code = cm::manifest_request_code(&self.connection, WPE_APP_ID, self.depot_id, manifest_id).await?;
        let key = self.keys.get(&self.depot_id).ok_or("缺工坊 depot 密钥")?;
        let manifest = self.pool.manifest(self.depot_id, manifest_id, code, key).await?;
        let files: Vec<(u32, ManifestFile)> =
            manifest.files.into_iter().map(|file| (self.depot_id, file)).collect();

        let recorded_files = recorded.as_ref().map(|r| r.files.clone()).unwrap_or_default();
        let plan = {
            let dir = dir.clone();
            let files = files.clone();
            let recorded_files = recorded_files.clone();
            tokio::task::spawn_blocking(move || plan_downloads(&dir, &files, &recorded_files))
                .await
                .map_err(|e| e.to_string())??
        };
        let total_bytes: u64 = plan
            .downloads
            .iter()
            .flat_map(|(_, file)| file.chunks.iter())
            .map(|chunk| chunk.compressed_len as u64)
            .sum();
        download_files(&self.pool, &dir, &plan.downloads, Arc::clone(&self.keys), total_bytes, hooks).await?;

        // 新版本里没有的旧文件：只删我们下过的（状态里记录的）
        let new_paths: HashSet<&str> = files.iter().map(|(_, file)| file.path.as_str()).collect();
        for path in recorded_files.keys().filter(|path| !new_paths.contains(path.as_str())) {
            let _ = std::fs::remove_file(dir.join(path));
        }

        let entry = ItemState {
            manifest_id: item.manifest_id.clone(),
            files: files
                .iter()
                .filter(|(_, file)| !file.is_dir)
                .map(|(_, file)| {
                    (
                        file.path.clone(),
                        FileState {
                            size: file.size,
                            sha: hex::encode(file.sha),
                        },
                    )
                })
                .collect(),
            tags: item.tags.clone(),
            updated_at: now_secs(),
        };
        let engine = engine.to_path_buf();
        let id = item.id.clone();
        tokio::task::spawn_blocking(move || {
            // 重新读一次再写：同一个 WPE 目录可能有别的任务在写
            let mut state = read_state(&engine);
            state.items.insert(id, entry);
            write_state(&engine, &state)
        })
        .await
        .map_err(|e| e.to_string())??;
        (hooks.progress)(1.0);
        Ok(ItemOutcome::Downloaded {
            dir,
            files: plan.downloads.len(),
            bytes: total_bytes,
        })
    }
}

/// 任务日志里条目的称呼。
pub fn log_params(item: &WorkshopItem) -> serde_json::Value {
    json!({ "id": item.id, "title": item.title })
}

#[cfg(test)]
mod tests {
    use super::*;
    use steam_vent_proto_steam::steammessages_publishedfile_steamclient::published_file_details::Tag;

    fn details(id: u64, manifest: u64, tags: &[&str]) -> PublishedFileDetails {
        PublishedFileDetails {
            result: Some(1),
            publishedfileid: Some(id),
            title: Some(format!("item {id}")),
            hcontent_file: Some(manifest),
            tags: tags
                .iter()
                .map(|tag| Tag {
                    tag: Some(tag.to_string()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn item_kind_rating_and_support() {
        let scene = item_from(&details(1, 7, &["Scene", "Anime", "Mature"])).unwrap();
        assert_eq!((scene.kind.as_str(), scene.rating.as_deref(), scene.supported), ("scene", Some("Mature"), true));
        let app = item_from(&details(2, 7, &["Application", "Everyone"])).unwrap();
        assert!(!app.supported);
        let no_content = item_from(&details(3, 0, &["Scene"])).unwrap();
        assert!(!no_content.supported);
        let mut failed = details(4, 7, &["Scene"]);
        failed.result = Some(9);
        assert!(item_from(&failed).is_none());
    }

    #[test]
    fn discover_excludes_unpicked_kinds_and_unsupported() {
        let tags = discover_excluded_tags(&["Everyone".into()], &["scene".into()]);
        assert_eq!(
            tags,
            vec!["Questionable", "Mature", "Video", "Web", "Application", "Preset"]
        );
        assert_eq!(discover_excluded_tags(&[], &[]), vec!["Application", "Preset"]);
    }

    #[test]
    fn item_ids_from_search_text() {
        assert_eq!(parse_item_ids("3831518461"), Some(vec![3831518461]));
        assert_eq!(
            parse_item_ids(" 12, 34；12\nhttps://steamcommunity.com/sharedfiles/filedetails/?id=56&searchtext="),
            Some(vec![12, 34, 56])
        );
        assert_eq!(parse_item_ids("steam://url/CommunityFilePage/78"), Some(vec![78]));
        // 混了别的字就是普通搜索
        assert_eq!(parse_item_ids("furina 12"), None);
        assert_eq!(parse_item_ids("2077"), Some(vec![2077]));
        assert_eq!(parse_item_ids("0"), None);
        assert_eq!(parse_item_ids("  "), None);
    }

    #[test]
    fn ratings_become_excluded_tags() {
        assert!(excluded_ratings(&[]).is_empty());
        assert_eq!(
            excluded_ratings(&["Everyone".to_string(), "Questionable".to_string()]),
            vec!["Mature".to_string()]
        );
        assert!(excluded_ratings(&RATINGS.map(String::from)).is_empty());
    }

    #[test]
    fn local_state_follows_recorded_manifest() {
        let root = tempfile::tempdir().unwrap();
        let engine = root.path();
        let item = item_from(&details(42, 9, &["Scene"])).unwrap();
        let mut state = WorkshopState::default();
        assert_eq!(local_state_of(engine, &state, &item), LocalState::Missing);
        let dir = myprojects_dir(engine).join("42");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("project.json"), "{}").unwrap();
        assert_eq!(local_state_of(engine, &state, &item), LocalState::Outdated);
        state.items.insert(
            "42".into(),
            ItemState {
                manifest_id: "9".into(),
                files: BTreeMap::new(),
                tags: vec!["Scene".into()],
                updated_at: 0,
            },
        );
        assert_eq!(local_state_of(engine, &state, &item), LocalState::Current);
        write_state(engine, &state).unwrap();
        assert_eq!(recorded_tags(engine).get("42"), Some(&vec!["Scene".to_string()]));
    }
}
