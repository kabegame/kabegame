use crate::storage::metadata_search_text::{
    native_search_text_from_json_str, search_terms_from_json_str,
};
use crate::storage::search_terms::insert_metadata_search_terms;
use crate::storage::{default_true, Storage, FAVORITE_ALBUM_ID};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct ImageInfo {
    #[serde(deserialize_with = "deserialize_stringish")]
    pub id: String,
    /// 图片源 URL，本地导入时可为空。
    pub url: Option<String>,
    #[serde(alias = "localPath")]
    pub local_path: String,
    #[serde(rename(serialize = "pluginId"), alias = "pluginId")]
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(rename(serialize = "taskId"), alias = "taskId")]
    pub task_id: Option<String>,
    #[serde(rename(serialize = "surfRecordId"), alias = "surfRecordId")]
    #[serde(default)]
    pub surf_record_id: Option<String>,
    #[serde(alias = "crawledAt")]
    pub crawled_at: u64,
    /// 外键指向 `metadata.id`；下载入口已将 raw metadata 预先归一化为该 id。
    #[serde(rename(serialize = "metadataId"), alias = "metadataId")]
    #[serde(default)]
    pub metadata_id: Option<i64>,
    /// 原生元数据外键，新增事件在持久化后携带最终值。
    #[serde(
        rename(serialize = "imageMetadataId"),
        alias = "imageMetadataId",
        default
    )]
    pub image_metadata_id: Option<i64>,
    #[serde(rename(serialize = "thumbnailPath"), alias = "thumbnailPath")]
    #[serde(default)]
    pub thumbnail_path: String,
    #[serde(
        default,
        alias = "is_favorite",
        deserialize_with = "deserialize_boolish"
    )]
    pub favorite: bool,
    /// 是否在隐藏画册（HIDDEN_ALBUM_ID）中。前端根据此值决定上下文菜单显示"隐藏"或"取消隐藏"。
    /// VD 据此给虚拟图片文件叠加 OS hidden 属性。衍生自统一 LEFT JOIN，不是 images 表列。
    #[serde(
        rename(serialize = "isHidden"),
        alias = "isHidden",
        default,
        deserialize_with = "deserialize_boolish"
    )]
    pub is_hidden: bool,
    /// 本地文件是否存在（用于前端标记缺失文件：仍展示条目，但提示用户源文件已丢失/移动）
    #[serde(default = "default_true", alias = "localExists")]
    pub local_exists: bool,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(rename(serialize = "displayName"), alias = "displayName")]
    #[serde(default)]
    pub display_name: String,
    /// 存储格式 key（`image/jpg`、`video/mp4`…）。
    ///
    /// 线上键名统一为 `type`，**不要再加 `media_type` 别名**：provider 树的上游
    /// (`images_root_provider`) 贡献 `images.*`，展开后已含一个 `type` 列；只要哪个
    /// 下游 provider 再取名 `media_type`，两个键就会同时出现在同一行 JSON 里，
    /// 而 serde 对同一字段的两个可接受键名会直接报 `duplicate field type`，
    /// 令整棵 gallery 子树无法反序列化。
    #[serde(rename = "type")]
    #[serde(default)]
    pub media_type: Option<String>,
    /// 最后一次被设为壁纸的 Unix 时间戳（秒）；从未设为壁纸则为 None。
    #[serde(rename(serialize = "lastSetWallpaperAt"), alias = "lastSetWallpaperAt")]
    #[serde(default)]
    pub last_set_wallpaper_at: Option<u64>,
    /// 图片磁盘大小（字节）；旧数据或无法获取时为 None。
    #[serde(default)]
    pub size: Option<u64>,
    /// 仅在画册路径 (`/gallery/album/<id>/...`) 下被填: 该图片在 album_images 表中的 `order` 列。
    /// 顺序壁纸轮播 (sequential mode) 用它定位 next 图片 (`bigger_order` 路径)。
    /// 非画册路径的查询里恒为 None。
    #[serde(rename(serialize = "albumOrder"), alias = "albumOrder")]
    #[serde(default)]
    pub album_order: Option<i64>,
    /// 浏览器兼容副本路径（可空）。原始媒体为浏览器不可播放的格式时由下载/导入/Organize 生成。
    /// 图片转 PNG（含超大图下采样）；视频转 H.264 mp4（含 AAC 音频）。
    #[serde(
        rename(serialize = "compatiblePath"),
        alias = "compatiblePath",
        default
    )]
    pub compatible_path: Option<String>,
    #[serde(rename(serialize = "postUrl"), alias = "postUrl", default)]
    pub post_url: Option<String>,
}

fn deserialize_boolish<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Bool(v) => Ok(v),
        serde_json::Value::Number(n) => Ok(n.as_i64().unwrap_or(0) != 0),
        serde_json::Value::String(s) => Ok(matches!(s.as_str(), "1" | "true" | "TRUE" | "True")),
        serde_json::Value::Null => Ok(false),
        other => Err(serde::de::Error::custom(format!(
            "cannot deserialize bool from {other}"
        ))),
    }
}

fn deserialize_stringish<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        other => Err(serde::de::Error::custom(format!(
            "cannot deserialize string from {other}"
        ))),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaginatedImages {
    pub images: Vec<ImageInfo>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangedImages {
    pub images: Vec<ImageInfo>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataFull {
    pub id: i64,
    pub data: Option<Value>,
    /// 图片下载时的插件版本（packed u32）。
    pub plugin_version: u32,
    pub plugin_id: String,
}

#[derive(Debug, Clone)]
pub struct ImageNativeMetadataRow {
    pub image_metadata_id: Option<i64>,
    pub data: Option<String>,
    pub parser_version: Option<u32>,
    pub local_path: String,
    pub format_key: Option<String>,
}

#[cfg(not(target_os = "android"))]
fn remove_thumbnail_file_if_needed(local_path: Option<&str>, thumbnail_path: Option<&str>) {
    let Some(thumb) = thumbnail_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return;
    };
    if let Some(local) = local_path.map(str::trim).filter(|p| !p.is_empty()) {
        if local == thumb {
            return;
        }
    }
    let _ = fs::remove_file(thumb);
}

#[cfg(target_os = "android")]
fn remove_thumbnail_file_if_needed(_local_path: Option<&str>, _thumbnail_path: Option<&str>) {}

/// 删除由 Kabegame 生成且位于 `compatibles_dir` 内的兼容副本。
/// canonicalize 后再校验目录归属，避免删除原始媒体、外部路径或越界软链接。
fn remove_compatible_file_if_owned(path: Option<&str>) {
    let Some(path) = path.map(str::trim).filter(|p| !p.is_empty()) else {
        return;
    };
    let Ok(root) = crate::app_paths::AppPaths::global()
        .compatibles_dir()
        .canonicalize()
    else {
        return;
    };
    let Ok(target) = Path::new(path).canonicalize() else {
        return;
    };
    if !target.starts_with(&root) {
        return;
    }
    if let Err(e) = fs::remove_file(&target) {
        eprintln!(
            "[storage] remove compatible file failed ({}): {e}",
            target.display()
        );
    }
}

// v4.0 删除说明：resolve_file_size_for_backfill（含 Android / 桌面两个 cfg 版本）
// 仅被 fill_missing_sizes 使用，随之一并删除。

/// 从 DB `metadata.data` 文本列解析为 JSON；空串或无效则 `None`。
pub(crate) fn parse_metadata_json(s: Option<String>) -> Option<Value> {
    s.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            serde_json::from_str(t).ok()
        }
    })
}

/// 只插入一行 `metadata` 并返回 id，不写搜索词。
fn insert_metadata_data_row(
    conn: &rusqlite::Connection,
    data_json: &str,
    plugin_id: &str,
    plugin_version: u32,
) -> Result<i64, String> {
    conn.prepare_cached(
        "INSERT INTO metadata (data, plugin_id, plugin_version)
         VALUES (?1, ?2, ?3)",
    )
    .and_then(|mut stmt| stmt.execute(params![data_json, plugin_id, i64::from(plugin_version)]))
    .map_err(|e| format!("insert metadata: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// 搜索词：插件提供的列表，缺省（`None`）时按默认规则展开 JSON。
fn resolve_search_terms<'a>(
    data_json: &str,
    search_terms: Option<&'a [String]>,
) -> Cow<'a, [String]> {
    match search_terms {
        Some(terms) => Cow::Borrowed(terms),
        None => Cow::Owned(search_terms_from_json_str(data_json)),
    }
}

/// 将 JSON 文本写入 `metadata` 并返回新插入的行 id。
pub(crate) fn insert_metadata_id(
    conn: &rusqlite::Connection,
    data_json: &str,
    plugin_id: &str,
    plugin_version: u32,
    search_terms: Option<&[String]>,
) -> Result<i64, String> {
    let metadata_id = insert_metadata_data_row(conn, data_json, plugin_id, plugin_version)?;
    let terms = resolve_search_terms(data_json, search_terms);
    insert_metadata_search_terms(conn, &[(metadata_id, &terms)])?;
    Ok(metadata_id)
}

/// 一行迁移结果：旧 metadata id、迁移后的 data 与搜索词（`None` 按默认规则展开）。
#[derive(Debug, Clone)]
pub struct MigratedMetadataRow {
    pub old_id: i64,
    pub data: String,
    pub search_terms: Option<Vec<String>>,
}

/// 一批写回的结果：本批新建的 metadata id 与被改指的 `(图片 id, 新 metadata id)`。
#[derive(Debug, Default)]
pub struct MigratedMetadataBatch {
    pub new_ids: Vec<i64>,
    pub repointed: Vec<(String, i64)>,
}

/// 按 `[(旧 id, 新 id)]` 一次改指 images 与 task_failed_images 并删掉旧行，返回被改指的图片。
fn repoint_metadata_rows(
    conn: &rusqlite::Connection,
    pairs: &[(i64, i64)],
) -> Result<Vec<(String, i64)>, String> {
    if pairs.is_empty() {
        return Ok(Vec::new());
    }
    let map = serde_json::to_string(pairs).map_err(|e| format!("serialize metadata map: {e}"))?;
    let repointed = {
        let mut stmt = conn
            .prepare(
                "UPDATE images SET metadata_id = m.value ->> 1
                   FROM json_each(?1) AS m
                  WHERE images.metadata_id = m.value ->> 0
                 RETURNING CAST(images.id AS TEXT), images.metadata_id",
            )
            .map_err(|e| format!("prepare repoint images.metadata_id: {e}"))?;
        let rows = stmt
            .query_map(params![map], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("repoint images.metadata_id: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect repointed images: {e}"))?
    };
    conn.execute(
        "UPDATE task_failed_images SET metadata_id = m.value ->> 1
           FROM json_each(?1) AS m
          WHERE task_failed_images.metadata_id = m.value ->> 0",
        params![map],
    )
    .map_err(|e| format!("repoint task_failed_images.metadata_id: {e}"))?;
    conn.execute(
        "DELETE FROM metadata WHERE id IN (SELECT value ->> 0 FROM json_each(?1))",
        params![map],
    )
    .map_err(|e| format!("delete migrated metadata rows: {e}"))?;
    Ok(repointed)
}

fn insert_image_metadata_row(
    conn: &rusqlite::Connection,
    data_json: &str,
    parser_version: u32,
) -> Result<i64, String> {
    let search_text = native_search_text_from_json_str(data_json);
    conn.execute(
        "INSERT INTO image_metadata (data, parser_version, search_text) VALUES (?1, ?2, ?3)",
        params![data_json, i64::from(parser_version), search_text],
    )
    .map_err(|e| format!("insert image_metadata: {}", e))?;
    Ok(conn.last_insert_rowid())
}

// v4.0 删除说明：以下内容已随 perform_complex_migrations 的移除一并删除。
//   - PIXIV_METADATA_BODY_KEYS、trim_pixiv_metadata_body、
//     trim_pixiv_plugin_metadata_if_needed、migrate_pixiv_metadata_trim
// 这些函数用于一次性裁剪旧版 pixiv 图片的 metadata.body 字段，
// 仅针对早于 3.5.x 的历史数据库，v4.0 不再支持从那些版本直接升级。

fn first_gallery_image_at(path: &str) -> Result<Option<ImageInfo>, String> {
    let mut image = crate::providers::images_at(path)?.into_iter().next();
    if let Some(ref mut image) = image {
        image.local_exists = PathBuf::from(&image.local_path).exists();
    }
    Ok(image)
}

fn encode_provider_segment(value: &str) -> String {
    pathql_rs::escape_path_segment(value)
}

impl Storage {
    pub fn find_image_by_id(image_id: &str) -> Result<Option<ImageInfo>, String> {
        if image_id.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_id/{}",
            encode_provider_segment(image_id)
        ))
    }

    /// 读取 `metadata.data`。
    pub fn get_metadata(&self, image_id: &str) -> Result<Option<Value>, String> {
        crate::providers::metadata_at(image_id)
    }

    /// 读取 metadata 的完整行信息（含 plugin_version/plugin_id）。
    pub fn get_metadata_full(&self, image_id: &str) -> Result<Option<MetadataFull>, String> {
        crate::providers::metadata_full_at(image_id)
    }

    /// V8 `Kabegame.createImageMetadata`：将 JSON 写入 `metadata` 并返回 id。
    /// `plugin_version` 为写入时运行插件的 packed 版本（应用维护，插件不可读写）。
    /// 页面快照 metadata 先经 `page_snapshot::validate`（空 / 超限直接报错）。
    pub fn insert_metadata_row(
        &self,
        value: &Value,
        plugin_id: &str,
        plugin_version: u32,
        search_terms: Option<Vec<String>>,
    ) -> Result<i64, String> {
        super::page_snapshot::validate(value)?;
        let s = serde_json::to_string(value)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin insert metadata: {e}"))?;
        let metadata_id =
            insert_metadata_id(&tx, &s, plugin_id, plugin_version, search_terms.as_deref())?;
        tx.commit()
            .map_err(|e| format!("commit insert metadata: {e}"))?;
        Ok(metadata_id)
    }

    /// 读取 metadata 行的 `plugin_id`；行不存在返回 `None`。
    pub fn metadata_plugin_id(&self, metadata_id: i64) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT plugin_id FROM metadata WHERE id = ?1",
            params![metadata_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|v| v.map(|p| p.unwrap_or_default()))
        .map_err(|e| format!("metadata_plugin_id: {}", e))
    }

    /// 读取某 metadata 行的原始 `data` 文本（用于文件夹同步重导入前「保存」内容）。
    pub fn read_metadata_text(&self, metadata_id: i64) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT data FROM metadata WHERE id = ?1",
            params![metadata_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("read_metadata_text: {}", e))
    }

    /// 按原始 JSON 文本写入 metadata 行并返回 id。
    /// 文件夹同步重导入用：删旧行后重写——若内容仍在则拿回原 id，若已被 GC 则得新 id。
    pub fn insert_metadata_text(&self, data_json: &str) -> Result<i64, String> {
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin insert metadata text: {e}"))?;
        let metadata_id = insert_metadata_id(&tx, data_json, "", 0, None)?;
        tx.commit()
            .map_err(|e| format!("commit insert metadata text: {e}"))?;
        Ok(metadata_id)
    }

    /// 扫描某插件低于目标插件版本（packed）的 metadata 行，供迁移运行器逐行升级。
    /// 空串或字面量 `"null"`（trim 后）视为没有 metadata，不参与迁移。
    pub fn metadata_rows_below_plugin_version(
        &self,
        plugin_id: &str,
        max_plugin_version: u32,
    ) -> Result<Vec<(i64, String, u32)>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, data, plugin_version
                 FROM metadata
                 WHERE plugin_id = ?1 AND plugin_version < ?2
                   AND TRIM(data) NOT IN ('', 'null')
                 ORDER BY id",
            )
            .map_err(|e| format!("prepare metadata_rows_below_plugin_version: {e}"))?;
        let rows = stmt
            .query_map(params![plugin_id, i64::from(max_plugin_version)], |row| {
                let plugin_version: i64 = row.get(2)?;
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    plugin_version.max(0) as u32,
                ))
            })
            .map_err(|e| format!("query metadata_rows_below_plugin_version: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect metadata_rows_below_plugin_version: {e}"))
    }

    /// 一次查出一批 metadata 行各自引用的图片 id。
    /// 迁移挂标签必须在写回改指之前调用。
    pub fn image_ids_by_metadata_ids(
        &self,
        metadata_ids: &[i64],
    ) -> Result<HashMap<i64, Vec<String>>, String> {
        let mut out = HashMap::<i64, Vec<String>>::new();
        if metadata_ids.is_empty() {
            return Ok(out);
        }
        let ids = serde_json::to_string(metadata_ids)
            .map_err(|e| format!("serialize metadata ids: {e}"))?;
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT metadata_id, CAST(id AS TEXT) FROM images
                  WHERE metadata_id IN (SELECT value FROM json_each(?1))
                  ORDER BY metadata_id, id",
            )
            .map_err(|e| format!("prepare image_ids_by_metadata_ids: {e}"))?;
        let rows = stmt
            .query_map(params![ids], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("query image_ids_by_metadata_ids: {e}"))?;
        for row in rows {
            let (metadata_id, image_id) =
                row.map_err(|e| format!("collect image_ids_by_metadata_ids: {e}"))?;
            out.entry(metadata_id).or_default().push(image_id);
        }
        Ok(out)
    }

    /// 按批写回迁移结果。metadata 行按 id 不可变：每行插一份带新版本的新行（含搜索词），
    /// 再用一条 UPDATE 把整批图片与失败记录改指过去、一条 DELETE 删掉旧行（搜索映射级联删除）。
    /// 这里不找内容相同的合并目标——那是逐行 O(n²) 的比较；整轮结束后由
    /// [`Self::dedup_migrated_metadata`] 一次合并。迁移途中已被 `gc_metadata` 删掉的旧行跳过。
    pub fn writeback_migrated_metadata_batch(
        &self,
        plugin_id: &str,
        plugin_version: u32,
        rows: &[MigratedMetadataRow],
    ) -> Result<MigratedMetadataBatch, String> {
        if rows.is_empty() {
            return Ok(MigratedMetadataBatch::default());
        }
        let old_ids = serde_json::to_string(&rows.iter().map(|row| row.old_id).collect::<Vec<_>>())
            .map_err(|e| format!("serialize migrated metadata ids: {e}"))?;
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin writeback_migrated_metadata_batch: {e}"))?;

        let alive: HashSet<i64> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM metadata
                      WHERE plugin_id = ?1 AND id IN (SELECT value FROM json_each(?2))",
                )
                .map_err(|e| format!("prepare alive metadata rows: {e}"))?;
            let ids = stmt
                .query_map(params![plugin_id, old_ids], |row| row.get(0))
                .map_err(|e| format!("query alive metadata rows: {e}"))?;
            ids.collect::<Result<_, _>>()
                .map_err(|e| format!("collect alive metadata rows: {e}"))?
        };

        // 逐行插新行；搜索词整批一次写入。
        let mut pairs = Vec::with_capacity(alive.len());
        let mut terms = Vec::with_capacity(alive.len());
        for row in rows.iter().filter(|row| alive.contains(&row.old_id)) {
            let new_id = insert_metadata_data_row(&tx, &row.data, plugin_id, plugin_version)?;
            pairs.push((row.old_id, new_id));
            terms.push((
                new_id,
                resolve_search_terms(&row.data, row.search_terms.as_deref()),
            ));
        }
        let terms = terms
            .iter()
            .map(|(new_id, terms)| (*new_id, terms.as_ref()))
            .collect::<Vec<_>>();
        insert_metadata_search_terms(&tx, &terms)?;
        let repointed = repoint_metadata_rows(&tx, &pairs)?;

        tx.commit()
            .map_err(|e| format!("commit writeback_migrated_metadata_batch: {e}"))?;
        Ok(MigratedMetadataBatch {
            new_ids: pairs.into_iter().map(|(_, new_id)| new_id).collect(),
            repointed,
        })
    }

    /// 整轮迁移结束后，把同插件、同版本、data 相同的行合并到组内最小 id。
    /// 只合并本轮新建的行（`candidate_ids`）：运行中的任务可能已用 `createImageMetadata`
    /// 建好、但图片还没引用的行，删掉会让随后的插图违反外键。返回被改指的图片。
    pub fn dedup_migrated_metadata(
        &self,
        plugin_id: &str,
        plugin_version: u32,
        candidate_ids: &[i64],
    ) -> Result<Vec<(String, i64)>, String> {
        if candidate_ids.is_empty() {
            return Ok(Vec::new());
        }
        let candidates = serde_json::to_string(candidate_ids)
            .map_err(|e| format!("serialize dedup candidates: {e}"))?;
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin dedup_migrated_metadata: {e}"))?;
        let pairs: Vec<(i64, i64)> = {
            // 先按 length 分区再比 data：长度不同的行不必逐字节比较。
            let mut stmt = tx
                .prepare(
                    "WITH canon AS (
                         SELECT id, MIN(id) OVER (PARTITION BY length(data), data) AS keep_id
                           FROM metadata
                          WHERE plugin_id = ?1 AND plugin_version = ?2
                     )
                     SELECT id, keep_id FROM canon
                      WHERE id <> keep_id AND id IN (SELECT value FROM json_each(?3))",
                )
                .map_err(|e| format!("prepare dedup metadata: {e}"))?;
            let rows = stmt
                .query_map(
                    params![plugin_id, i64::from(plugin_version), candidates],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| format!("query dedup metadata: {e}"))?;
            rows.collect::<Result<_, _>>()
                .map_err(|e| format!("collect dedup metadata: {e}"))?
        };
        let repointed = repoint_metadata_rows(&tx, &pairs)?;
        tx.commit()
            .map_err(|e| format!("commit dedup_migrated_metadata: {e}"))?;
        Ok(repointed)
    }

    pub fn gc_metadata(&self, candidate_ids: &[i64]) -> Result<usize, String> {
        if candidate_ids.is_empty() {
            return Ok(0);
        }
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let mut deleted = 0usize;
        let mut seen = HashSet::new();
        for &id in candidate_ids {
            if !seen.insert(id) {
                continue;
            }
            let used: i64 = conn
                .query_row(
                    "SELECT
                        (SELECT COUNT(1) FROM images WHERE metadata_id = ?1)
                      + (SELECT COUNT(1) FROM task_failed_images WHERE metadata_id = ?1)",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("gc_metadata count: {}", e))?;
            if used == 0 {
                conn.execute("DELETE FROM metadata WHERE id = ?1", params![id])
                    .map_err(|e| format!("gc_metadata delete: {}", e))?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    /// 去重命中时把旧图改挂到新 metadata；`plugin_id` / `post_url` 为 Some 时同步覆盖，None 保留原值。
    /// `task_id` / `surf_record_id` 不动。旧 metadata 行改挂后无人引用则 GC。
    pub fn rebind_image_metadata(
        &self,
        image_id: &str,
        metadata_id: i64,
        plugin_id: Option<&str>,
        post_url: Option<&str>,
    ) -> Result<(), String> {
        let old_metadata_id = {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
            let old_metadata_id = conn
                .query_row(
                    "SELECT metadata_id FROM images WHERE id = ?1",
                    params![image_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()
                .map_err(|e| format!("select image metadata for rebind: {e}"))?
                .flatten();
            conn.execute(
                "UPDATE images
                 SET metadata_id = ?1,
                     plugin_id = COALESCE(?2, plugin_id),
                     post_url = COALESCE(?3, post_url)
                 WHERE id = ?4",
                params![metadata_id, plugin_id, post_url, image_id],
            )
            .map_err(|e| format!("rebind image metadata: {e}"))?;
            old_metadata_id
        };

        if let Some(old_metadata_id) = old_metadata_id.filter(|old| *old != metadata_id) {
            self.gc_metadata(&[old_metadata_id])?;
        }
        Ok(())
    }

    /// 把解析结果存成本图独占的新行并改挂；旧行随即删除。新 id 让前端按 `imageMetadataId` 的缓存失效。
    pub fn replace_image_native_metadata(
        &self,
        image_id: &str,
        parser_version: u32,
        json: &str,
    ) -> Result<i64, String> {
        // 1. 在事务内查询当前图片关联的旧行；图片不存在时返回错误，不写入元数据。
        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin replace image native metadata: {e}"))?;
        let old_id = tx
            .query_row(
                "SELECT image_metadata_id FROM images WHERE id = ?1",
                params![image_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|e| format!("select image native metadata: {e}"))?
            .ok_or_else(|| "native-metadata:image-not-found".to_string())?;

        // 2. 保存调用方提供的解析结果为新行，并只改挂当前图片。
        let metadata_id = insert_image_metadata_row(&tx, json, parser_version)?;
        tx.execute(
            "UPDATE images SET image_metadata_id = ?1 WHERE id = ?2",
            params![metadata_id, image_id],
        )
        .map_err(|e| format!("attach image native metadata: {e}"))?;

        // 3. 一图一行，旧行只属于本图；历史共享行仍被别的图引用时外键会拒绝，留给对方清理。
        if let Some(old_id) = old_id {
            let _ = tx.execute("DELETE FROM image_metadata WHERE id = ?1", params![old_id]);
        }

        // 4. 提交事务后返回新行 ID，供调用方发送补丁并使前端缓存失效。
        tx.commit()
            .map_err(|e| format!("commit image native metadata: {e}"))?;
        Ok(metadata_id)
    }

    pub fn get_image_native_metadata_row(
        &self,
        image_id: &str,
    ) -> Result<Option<ImageNativeMetadataRow>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        conn.query_row(
            "SELECT i.image_metadata_id, im.data, im.parser_version,
                    i.local_path, i.type
             FROM images i
             LEFT JOIN image_metadata im ON im.id = i.image_metadata_id
             WHERE i.id = ?1",
            params![image_id],
            |row| {
                let parser_version = row
                    .get::<_, Option<i64>>(2)?
                    .map(|version| version.max(0) as u32);
                Ok(ImageNativeMetadataRow {
                    image_metadata_id: row.get(0)?,
                    data: row.get(1)?,
                    parser_version,
                    local_path: row.get(3)?,
                    format_key: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("get image native metadata row: {e}"))
    }

    pub fn find_image_by_path(local_path: &str) -> Result<Option<ImageInfo>, String> {
        if local_path.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_path/{}",
            encode_provider_segment(local_path)
        ))
    }

    pub fn find_image_by_compatible_path(path: &str) -> Result<Option<ImageInfo>, String> {
        if path.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_compatible_path/{}",
            encode_provider_segment(path)
        ))
    }

    /// 按缩略图路径查找：path 可为 thumbnail_path 或（当 thumbnail_path 为空时）local_path。
    /// 查询时规范化路径（统一斜杠），与写入时 canonicalize 后的形式兼容。
    pub fn find_image_by_thumbnail_path(path: &str) -> Result<Option<ImageInfo>, String> {
        let path = path.trim();
        if path.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_thumbnail_path/{}",
            encode_provider_segment(path)
        ))
    }

    pub fn find_image_by_url(url: &str) -> Result<Option<ImageInfo>, String> {
        // 去重语义，不含 file://：本地导入图片正是靠 file:// url 去重。
        if crate::crawler::downloader::is_dedup_dummy_url(url) {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_url/{}",
            encode_provider_segment(url)
        ))
    }

    pub fn find_image_by_hash(hash: &str) -> Result<Option<ImageInfo>, String> {
        if hash.is_empty() {
            return Ok(None);
        }
        first_gallery_image_at(&format!(
            "images://gallery/by_hash/{}",
            encode_provider_segment(hash)
        ))
    }

    /// 为本地文件夹同步查询某 album 当前的图片 id 快照（作为「待删除候选」基线）。
    pub fn list_album_image_ids_for_sync(&self, album_id: &str) -> Result<Vec<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT i.id
                 FROM images i
                 INNER JOIN album_images ai ON ai.image_id = i.id
                 WHERE ai.album_id = ?1",
            )
            .map_err(|e| format!("prepare list_album_image_ids_for_sync: {e}"))?;
        let rows = stmt
            .query_map(params![album_id], |row| {
                Ok(row.get::<_, i64>(0)?.to_string())
            })
            .map_err(|e| format!("query list_album_image_ids_for_sync: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read list_album_image_ids_for_sync: {e}"))
    }

    pub fn add_image(&self, mut image: ImageInfo) -> Result<ImageInfo, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        image.media_type =
            crate::media::image_type::normalize_stored_media_type(image.media_type.take());

        let thumbnail_path = if image.thumbnail_path.trim().is_empty() {
            image.local_path.clone()
        } else {
            image.thumbnail_path.clone()
        };

        let crawled_at_i64 = image.crawled_at as i64;
        conn.execute(
            "INSERT INTO images (url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata_id, thumbnail_path, hash, type, width, height, display_name, size, compatible_path, post_url)
             VALUES (?1, ?2, ?3, (SELECT id FROM tasks WHERE id = ?4), ?5, ?6, (SELECT id FROM metadata WHERE id = ?7), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                &image.url,
                image.local_path,
                image.plugin_id,
                image.task_id,
                image.surf_record_id,
                crawled_at_i64,
                image.metadata_id,
                thumbnail_path,
                image.hash,
                image.media_type,
                image.width.map(|v| v as i64),
                image.height.map(|v| v as i64),
                image.display_name,
                image.size.map(|v| v as i64),
                image.compatible_path,
                image.post_url,
            ],
        )
        .map_err(|e| format!("Failed to add image: {}", e))?;

        let id = conn.last_insert_rowid();
        image.id = id.to_string();
        image.thumbnail_path = thumbnail_path;

        if let Some(ref tid) = image.task_id {
            if !tid.trim().is_empty() {
                let _ = conn.execute(
                    "UPDATE tasks SET success_count = success_count + 1 WHERE id = ?1",
                    params![tid],
                );
            }
        }

        self.invalidate_images_total_cache();

        Ok(image)
    }

    // v4.0 删除说明：fill_missing_dimensions 和 fill_missing_sizes 均为启动时回填旧数据的
    // 一次性迁移逻辑（width/height/size 列早期为 NULL），v4.0 新库建表即含这些列，
    // 3.5.x 用户的存量数据已由之前版本补齐，不再需要启动时扫描回填。

    /// 删除前查询图片所属任务 id（用于事件广播）
    pub fn get_task_id_for_image(&self, image_id: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.query_row(
            "SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL",
            params![image_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query task IDs: {}", e))
    }

    /// 批量图片在删除前涉及的任务 id（去重）
    pub fn collect_task_ids_for_images(&self, image_ids: &[String]) -> Result<Vec<String>, String> {
        let mut set = HashSet::new();
        for id in image_ids {
            if let Some(tid) = self.get_task_id_for_image(id)? {
                set.insert(tid);
            }
        }
        Ok(set.into_iter().collect())
    }

    pub fn batch_delete_images(&self, image_ids: &[String]) -> Result<Vec<String>, String> {
        if image_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;
        let mut metadata_ids = Vec::new();

        // 在删除前，查询所有图片所属的任务，并统计每个任务需要增加的 deleted_count
        let mut task_deleted_counts: HashMap<String, i64> = HashMap::new();
        for id in image_ids {
            let task_ids: Vec<String> = tx
                .prepare("SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL")
                .and_then(|mut stmt| {
                    stmt.query_map(params![id], |row| row.get::<_, String>(0))
                        .and_then(|rows| {
                            let mut ids = Vec::new();
                            for row_result in rows {
                                if let Ok(task_id) = row_result {
                                    ids.push(task_id);
                                }
                            }
                            Ok(ids)
                        })
                })
                .unwrap_or_default();

            for task_id in task_ids {
                *task_deleted_counts.entry(task_id).or_insert(0) += 1;
            }
        }

        // purge 是异步操作（Android 需经过 IPC，且可能弹系统授权窗），不能在持有 DB 锁时执行。
        let mut local_paths_to_purge: Vec<String> = Vec::new();

        for id in image_ids {
            let image_paths: Option<(
                String,
                String,
                Option<i64>,
                Option<i64>,
                Option<String>,
                Option<String>,
            )> = tx
                .query_row(
                    "SELECT local_path, thumbnail_path, metadata_id, image_metadata_id, compatible_path, wallpaper_compatible_path FROM images WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| format!("Failed to query image path: {}", e))?;

            let image_metadata_id = image_paths.as_ref().and_then(|(_, _, _, id, _, _)| *id);
            if let Some((
                local_path,
                thumbnail_path,
                metadata_id,
                _,
                compatible_path,
                wallpaper_compatible_path,
            )) = image_paths
            {
                if let Some(metadata_id) = metadata_id {
                    metadata_ids.push(metadata_id);
                }
                remove_thumbnail_file_if_needed(Some(&local_path), Some(&thumbnail_path));
                remove_compatible_file_if_owned(compatible_path.as_deref());
                remove_compatible_file_if_owned(wallpaper_compatible_path.as_deref());
                local_paths_to_purge.push(local_path);
            }

            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to delete image: {}", e))?;

            if let Some(image_metadata_id) = image_metadata_id {
                // 一图一行，旧行只属于本图；历史共享行仍被别的图引用时外键会拒绝，留给对方清理。
                let _ = tx.execute(
                    "DELETE FROM image_metadata WHERE id = ?1",
                    params![image_metadata_id],
                );
            }

            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
        }

        // 更新所有相关任务的 deleted_count 与 success_count
        for (task_id, count) in task_deleted_counts {
            let _ = tx.execute(
                "UPDATE tasks SET deleted_count = deleted_count + ?1, success_count = MAX(0, success_count - ?2) WHERE id = ?3",
                params![count, count, task_id],
            );
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        self.invalidate_images_total_cache();
        drop(conn);
        let _ = self.gc_metadata(&metadata_ids);

        Ok(local_paths_to_purge)
    }

    pub fn batch_remove_images(&self, image_ids: &[String]) -> Result<(), String> {
        if image_ids.is_empty() {
            return Ok(());
        }

        let mut conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;
        let mut metadata_ids = Vec::new();

        // 在删除前，查询所有图片所属的任务，并统计每个任务需要增加的 deleted_count
        let mut task_deleted_counts: HashMap<String, i64> = HashMap::new();
        for id in image_ids {
            let task_ids: Vec<String> = tx
                .prepare("SELECT task_id FROM images WHERE id = ?1 AND task_id IS NOT NULL")
                .and_then(|mut stmt| {
                    stmt.query_map(params![id], |row| row.get::<_, String>(0))
                        .and_then(|rows| {
                            let mut ids = Vec::new();
                            for row_result in rows {
                                if let Ok(task_id) = row_result {
                                    ids.push(task_id);
                                }
                            }
                            Ok(ids)
                        })
                })
                .unwrap_or_default();

            for task_id in task_ids {
                *task_deleted_counts.entry(task_id).or_insert(0) += 1;
            }
        }

        for id in image_ids {
            let image_paths: Option<(
                String,
                String,
                Option<i64>,
                Option<i64>,
                Option<String>,
                Option<String>,
            )> = tx
                .query_row(
                    "SELECT local_path, thumbnail_path, metadata_id, image_metadata_id, compatible_path, wallpaper_compatible_path FROM images WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| format!("Failed to query image path: {}", e))?;

            let image_metadata_id = image_paths.as_ref().and_then(|(_, _, _, id, _, _)| *id);
            if let Some((
                local_path,
                thumbnail_path,
                metadata_id,
                _,
                compatible_path,
                wallpaper_compatible_path,
            )) = image_paths
            {
                if let Some(metadata_id) = metadata_id {
                    metadata_ids.push(metadata_id);
                }
                remove_thumbnail_file_if_needed(Some(&local_path), Some(&thumbnail_path));
                remove_compatible_file_if_owned(compatible_path.as_deref());
                remove_compatible_file_if_owned(wallpaper_compatible_path.as_deref());
            }

            tx.execute("DELETE FROM images WHERE id = ?1", params![id])
                .map_err(|e| format!("Failed to remove image: {}", e))?;

            if let Some(image_metadata_id) = image_metadata_id {
                // 一图一行，旧行只属于本图；历史共享行仍被别的图引用时外键会拒绝，留给对方清理。
                let _ = tx.execute(
                    "DELETE FROM image_metadata WHERE id = ?1",
                    params![image_metadata_id],
                );
            }

            let _ = tx.execute("DELETE FROM album_images WHERE image_id = ?1", params![id]);
        }

        // 更新所有相关任务的 deleted_count 与 success_count
        for (task_id, count) in task_deleted_counts {
            let _ = tx.execute(
                "UPDATE tasks SET deleted_count = deleted_count + ?1, success_count = MAX(0, success_count - ?2) WHERE id = ?3",
                params![count, count, task_id],
            );
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        self.invalidate_images_total_cache();
        drop(conn);
        let _ = self.gc_metadata(&metadata_ids);

        Ok(())
    }

    pub fn get_total_count(&self) -> Result<usize, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        self.get_images_total_cached(&conn)
    }

    pub fn toggle_image_favorite(&self, image_id: &str, favorite: bool) -> Result<bool, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let changed = if favorite {
            conn.execute(
                "INSERT OR IGNORE INTO album_images (album_id, image_id, \"order\") VALUES (?1, ?2, ?3)",
                params![FAVORITE_ALBUM_ID, image_id, SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64],
            )
        } else {
            conn.execute(
                "DELETE FROM album_images WHERE album_id = ?1 AND image_id = ?2",
                params![FAVORITE_ALBUM_ID, image_id],
            )
        }
        .map_err(|e| format!("Failed to update favorite membership: {e}"))?;

        Ok(changed > 0)
    }

    pub fn replace_image_thumbnail_path(
        &self,
        image_id: &str,
        thumbnail_path: &str,
    ) -> Result<(), String> {
        let old_paths = {
            let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
            let old_paths = conn
                .query_row(
                    "SELECT local_path, thumbnail_path FROM images WHERE id = ?1",
                    params![image_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|e| format!("Failed to query existing thumbnail path: {}", e))?;
            conn.execute(
                "UPDATE images SET thumbnail_path = ?1 WHERE id = ?2",
                params![thumbnail_path, image_id],
            )
            .map_err(|e| format!("Failed to update thumbnail path: {}", e))?;
            old_paths
        };

        if let Some((local_path, old_thumbnail_path)) = old_paths {
            if old_thumbnail_path.trim() != thumbnail_path.trim() {
                remove_thumbnail_file_if_needed(Some(&local_path), Some(&old_thumbnail_path));
            }
        }

        Ok(())
    }

    /// 将图片的 `compatible_path` 更新为新路径（不删除旧文件，由调用方负责）。
    pub fn replace_image_compatible_path(
        &self,
        image_id: &str,
        compatible_path: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET compatible_path = ?1 WHERE id = ?2",
            params![compatible_path, image_id],
        )
        .map_err(|e| format!("Failed to update compatible_path: {}", e))?;
        Ok(())
    }

    pub fn get_image_wallpaper_compatible_path(
        &self,
        image_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        let path = conn
            .query_row(
                "SELECT wallpaper_compatible_path FROM images WHERE id = ?1",
                params![image_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|e| format!("Failed to query wallpaper_compatible_path: {}", e))?
            .flatten()
            .filter(|path| !path.trim().is_empty());
        Ok(path)
    }

    pub fn replace_image_wallpaper_compatible_path(
        &self,
        image_id: &str,
        path: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET wallpaper_compatible_path = ?1 WHERE id = ?2",
            params![path, image_id],
        )
        .map_err(|e| format!("Failed to update wallpaper_compatible_path: {}", e))?;
        Ok(())
    }

    pub fn update_image_last_set_wallpaper_at(
        &self,
        image_id: &str,
        ts: u64,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET last_set_wallpaper_at = ?1 WHERE id = ?2",
            params![ts as i64, image_id],
        )
        .map_err(|e| format!("Failed to update last_set_wallpaper_at: {}", e))?;
        Ok(())
    }

    pub fn update_image_display_name(
        &self,
        image_id: &str,
        display_name: &str,
    ) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        conn.execute(
            "UPDATE images SET display_name = ?1 WHERE id = ?2",
            params![display_name, image_id],
        )
        .map_err(|e| format!("Failed to update display_name: {}", e))?;
        Ok(())
    }

    pub fn pick_existing_gallery_image_id(&self, mode: &str) -> Result<Option<String>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;

        let sql = match mode {
            "random" => "SELECT CAST(id AS TEXT) FROM images ORDER BY RANDOM() LIMIT 1",
            _ => "SELECT CAST(id AS TEXT) FROM images ORDER BY crawled_at ASC LIMIT 1",
        };

        let id: Option<String> = conn
            .query_row(sql, [], |row| row.get(0))
            .optional()
            .map_err(|e| format!("Failed to pick image: {}", e))?;

        Ok(id)
    }
}

#[cfg(test)]
mod metadata_search_terms_override_tests {
    use super::*;

    fn conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
            CREATE TABLE metadata (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                data           TEXT    NOT NULL,
                plugin_version INTEGER NOT NULL DEFAULT 0,
                plugin_id      TEXT    NOT NULL DEFAULT ''
            );
            CREATE TABLE search_terms (
                id INTEGER PRIMARY KEY,
                text TEXT NOT NULL UNIQUE
            );
            CREATE TABLE metadata_search_terms (
                metadata_id INTEGER NOT NULL REFERENCES metadata(id) ON DELETE CASCADE,
                term_id INTEGER NOT NULL REFERENCES search_terms(id),
                PRIMARY KEY (term_id, metadata_id)
            ) WITHOUT ROWID;",
        )
        .unwrap();
        conn
    }

    fn search_terms_of(conn: &rusqlite::Connection, id: i64) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT search_terms.text
                 FROM metadata_search_terms
                 JOIN search_terms ON search_terms.id = metadata_search_terms.term_id
                 WHERE metadata_search_terms.metadata_id = ?1
                 ORDER BY search_terms.id",
            )
            .unwrap();
        stmt.query_map(params![id], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn page_snapshot_indexes_only_title_and_url() {
        let conn = conn();
        let data = r#"{"kind":"kabegame.surfPageSnapshot","title":"Title","sourceUrl":"https://example.com/p","pageHtml":"<html>huge body</html>"}"#;
        let id = insert_metadata_id(&conn, data, "webpage", 0, None).unwrap();
        let terms = search_terms_of(&conn, id);
        assert_eq!(terms, ["Title", "https://example.com/p"]);
        assert!(!terms.iter().any(|term| term.contains("huge body")));
    }

    #[test]
    fn default_insert_still_flattens_json() {
        let conn = conn();
        let id = insert_metadata_id(&conn, r#"{"title":"sakura"}"#, "", 0, None).unwrap();
        assert!(search_terms_of(&conn, id)
            .iter()
            .any(|term| term == "sakura"));
    }

    #[test]
    fn explicit_empty_search_terms_disable_metadata_search() {
        let conn = conn();
        let id = insert_metadata_id(&conn, r#"{"title":"sakura"}"#, "", 0, Some(&[])).unwrap();
        assert!(search_terms_of(&conn, id).is_empty());
    }
}

#[cfg(test)]
mod rebind_image_metadata_tests {
    use super::*;

    fn storage() -> Storage {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE metadata (
                id        INTEGER PRIMARY KEY,
                data      TEXT NOT NULL DEFAULT '{}',
                plugin_id TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE images (
                id             TEXT PRIMARY KEY,
                metadata_id    INTEGER,
                plugin_id      TEXT,
                task_id        TEXT,
                surf_record_id TEXT,
                post_url       TEXT
            );
            CREATE TABLE task_failed_images (
                metadata_id INTEGER
            );",
        )
        .unwrap();
        Storage::from_test_connection(conn)
    }

    #[test]
    fn rebind_image_metadata_updates_source_preserves_ownership_and_gcs_old_rows() {
        let storage = storage();
        {
            let conn = storage.db.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO metadata (id) VALUES (1), (2), (3), (4);
                 INSERT INTO images (id, metadata_id, plugin_id, task_id, surf_record_id, post_url)
                 VALUES
                   ('image-plugin', 1, 'old-plugin', 'task-plugin', 'surf-plugin', 'https://old/post'),
                   ('image-shared', 3, 'kept-plugin', 'task-shared', 'surf-shared', 'https://kept/post'),
                   ('image-other', 3, 'other-plugin', 'task-other', 'surf-other', NULL);",
            )
            .unwrap();
        }

        storage
            .rebind_image_metadata(
                "image-plugin",
                2,
                Some("new-plugin"),
                Some("https://new/post"),
            )
            .unwrap();
        storage
            .rebind_image_metadata("image-shared", 4, None, None)
            .unwrap();

        let conn = storage.db.lock().unwrap();
        let plugin_row: (Option<i64>, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT metadata_id, plugin_id, task_id, surf_record_id
                 FROM images WHERE id = 'image-plugin'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            plugin_row,
            (
                Some(2),
                Some("new-plugin".to_string()),
                Some("task-plugin".to_string()),
                Some("surf-plugin".to_string()),
            )
        );

        let shared_row: (Option<i64>, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT metadata_id, plugin_id, task_id, surf_record_id
                 FROM images WHERE id = 'image-shared'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            shared_row,
            (
                Some(4),
                Some("kept-plugin".to_string()),
                Some("task-shared".to_string()),
                Some("surf-shared".to_string()),
            )
        );

        let post_urls: Vec<Option<String>> = ["image-plugin", "image-shared"]
            .iter()
            .map(|id| {
                conn.query_row(
                    "SELECT post_url FROM images WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap()
            })
            .collect();
        // 带 post_url 时覆盖，None 时保留原值
        assert_eq!(
            post_urls,
            vec![
                Some("https://new/post".to_string()),
                Some("https://kept/post".to_string()),
            ]
        );

        let unique_old_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM metadata WHERE id = 1)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let shared_old_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM metadata WHERE id = 3)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!unique_old_exists);
        assert!(shared_old_exists);
    }
}

#[cfg(test)]
mod native_metadata_tests {
    use super::*;

    fn storage() -> Storage {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
            CREATE TABLE image_metadata (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                data           TEXT    NOT NULL,
                search_text    TEXT    NOT NULL DEFAULT '',
                parser_version INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE tasks (
                id            TEXT PRIMARY KEY,
                deleted_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE images (
                id                        INTEGER PRIMARY KEY,
                hash                      TEXT NOT NULL DEFAULT '',
                image_metadata_id         INTEGER REFERENCES image_metadata(id),
                local_path                TEXT NOT NULL DEFAULT '',
                thumbnail_path            TEXT NOT NULL DEFAULT '',
                metadata_id               INTEGER,
                task_id                   TEXT REFERENCES tasks(id),
                compatible_path           TEXT,
                wallpaper_compatible_path TEXT,
                type                      TEXT NOT NULL DEFAULT 'image/png'
            );
            CREATE TABLE album_images (
                album_id TEXT NOT NULL,
                image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE
            );
            INSERT INTO tasks (id, success_count) VALUES ('task', 2);
            INSERT INTO images (id, hash, task_id) VALUES (1, 'h', 'task'), (2, 'h', 'task');
            INSERT INTO album_images (album_id, image_id) VALUES ('album', 1), ('album', 2);",
        )
        .unwrap();
        Storage::from_test_connection(conn)
    }

    fn metadata_exists(storage: &Storage, metadata_id: i64) -> bool {
        storage
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM image_metadata WHERE id = ?1)",
                params![metadata_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn share_metadata(storage: &Storage) -> i64 {
        let metadata_id = storage.replace_image_native_metadata("1", 1, "{}").unwrap();
        storage
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE images SET image_metadata_id = ?1 WHERE id = 2",
                params![metadata_id],
            )
            .unwrap();
        metadata_id
    }

    #[test]
    fn replace_attaches_new_row_and_deletes_old_row() {
        let storage = storage();
        let json = r#"{"prompt":"1girl"}"#;
        let first = storage.replace_image_native_metadata("1", 1, json).unwrap();
        let row = storage.get_image_native_metadata_row("1").unwrap().unwrap();
        assert_eq!(row.image_metadata_id, Some(first));
        assert_eq!(row.parser_version, Some(1));
        assert_eq!(row.data.as_deref(), Some(json));
        // 同哈希图片不会自动挂载；相同解析结果也各自独占一行。
        assert_eq!(
            storage
                .get_image_native_metadata_row("2")
                .unwrap()
                .unwrap()
                .image_metadata_id,
            None
        );
        let other = storage.replace_image_native_metadata("2", 1, json).unwrap();
        assert_ne!(other, first);

        // 即使解析器版本未变，写入口也无条件换新行，让缓存键失效。
        let second = storage.replace_image_native_metadata("1", 1, "{}").unwrap();
        assert!(second > other);
        let row = storage.get_image_native_metadata_row("1").unwrap().unwrap();
        assert_eq!(row.image_metadata_id, Some(second));
        assert_eq!(row.data.as_deref(), Some("{}"));
        assert!(!metadata_exists(&storage, first));
        assert!(metadata_exists(&storage, other));
    }

    #[test]
    fn replace_missing_image_returns_error_without_inserting_row() {
        let storage = storage();
        assert_eq!(
            storage.replace_image_native_metadata("missing", 1, "{}"),
            Err("native-metadata:image-not-found".to_string())
        );
        let count: i64 = storage
            .db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM image_metadata", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn replace_preserves_historical_shared_row_with_foreign_keys() {
        let storage = storage();
        let shared = share_metadata(&storage);
        let replacement = storage.replace_image_native_metadata("1", 2, "{}").unwrap();
        assert_ne!(replacement, shared);
        let row = storage.get_image_native_metadata_row("1").unwrap().unwrap();
        assert_eq!(row.image_metadata_id, Some(replacement));
        assert_eq!(row.parser_version, Some(2));
        let other = storage.get_image_native_metadata_row("2").unwrap().unwrap();
        assert_eq!(other.image_metadata_id, Some(shared));
        assert_eq!(other.data.as_deref(), Some("{}"));
        assert!(metadata_exists(&storage, shared));
    }

    #[test]
    fn remove_preserves_shared_row_until_last_image_is_removed() {
        let storage = storage();
        let shared = share_metadata(&storage);
        storage.batch_remove_images(&["1".to_string()]).unwrap();
        assert!(storage
            .get_image_native_metadata_row("1")
            .unwrap()
            .is_none());
        assert!(metadata_exists(&storage, shared));
        assert_eq!(
            storage
                .get_image_native_metadata_row("2")
                .unwrap()
                .unwrap()
                .image_metadata_id,
            Some(shared)
        );

        storage.batch_remove_images(&["2".to_string()]).unwrap();
        assert!(storage
            .get_image_native_metadata_row("2")
            .unwrap()
            .is_none());
        assert!(!metadata_exists(&storage, shared));
        let conn = storage.db.lock().unwrap();
        let counts: (i64, i64) = conn
            .query_row(
                "SELECT deleted_count, success_count FROM tasks WHERE id = 'task'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(counts, (2, 0));
        let members: i64 = conn
            .query_row("SELECT COUNT(*) FROM album_images", [], |row| row.get(0))
            .unwrap();
        assert_eq!(members, 0);
    }
}
