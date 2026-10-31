//! 网页壁纸目录索引：库内每张网页壁纸（`x-wpe/web`）的目录 → 图片 id 与用户选的文件 / 目录。
//!
//! 它是两处的唯一数据源，只在内存里、不落库：
//! - CEF runtime 的 `file:` 闸门（[`tauri_runtime_kbcef::set_file_scope_resolver`]）：`file:` 文档只能访问
//!   它自己所在的网页壁纸目录与这张壁纸的用户选择，应用页发起的子 frame 导航只能落进库里某个网页壁纸目录；
//! - [`crate::commands::wpe_web::wpe_web_pull_state`]：按调用方文档路径认出是哪张壁纸。
//!
//! 生命周期：桌面 Windows 在 `core_init::init_heavy_globals` 里 Storage 就绪之后调用
//! [`init_wpe_web_dir_index`]——先订阅图片事件、再全量扫描（走 `idx_images_type`），然后向 runtime 注册
//! 解析器、后台跟随事件。主窗口要等启动页 Ready 才会打开预览，壁纸窗口在 `init_post` 才建，所以表一定先于
//! 任何网页壁纸 iframe 就绪。建表失败时保持空表：闸门全拒、拉取报错，不放宽。
//!
//! 放行（grants）有两条写入路：事件跟随在收到 `metadataId` 补丁时按新 metadata 重算（撤销旧选择不必等
//! 页面重拉）；`wpe_web_pull_state` 在把状态交给页面之前按同一份 metadata 覆盖（页面拿到新路径时闸门一定
//! 已经认它）。两条路写的都是「这张壁纸当前 metadata 算出的放行」，先后到达结果相同。
//!
//! 本体与单测跨平台编译；只有初始化的挂接点（`core_init` 里的调用）限 Windows，因为网页壁纸只在 Windows 提供。

use kabegame_core::ipc::events::{AppEvent, AppEventKind, ArcAppEvent, ImageFieldPatch};
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::media::image_type::wpe_kind;
use kabegame_core::storage::Storage;
use kabegame_core::wpe::user_props::{user_file_grants, WpeFileGrant};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::{Arc, OnceLock, RwLock};
use tauri_runtime_kbcef::{file_path_key, FileAccessScope, FileGrant};
use tokio::sync::{broadcast, mpsc};

/// 按壁纸目录索引的库内网页壁纸。
pub struct WpeWebDirIndex {
    inner: RwLock<DirIndexMaps>,
}

#[derive(Default)]
struct DirIndexMaps {
    /// 规范化后的壁纸目录键（[`file_path_key`]）→ 条目。闸门在 CEF IO 线程上只读这张表，不碰数据库。
    entry_by_dir_key: HashMap<String, WpeWebDirEntry>,
    /// 图片 id → 目录键：删除事件只带 id。
    dir_key_by_image_id: HashMap<String, String>,
}

/// 一张库内网页壁纸：图片 id、壁纸目录、按当前用户属性算出的放行（已转成闸门比较用的形式）。
#[derive(Debug, Clone)]
struct WpeWebDirEntry {
    image_id: String,
    dir: PathBuf,
    grants: Vec<FileGrant>,
}

/// 用户选择 → 闸门放行项；路径已不存在、类型不符或是符号链接的跳过。
fn to_file_grants(grants: Vec<WpeFileGrant>) -> Vec<FileGrant> {
    grants
        .into_iter()
        .filter_map(|grant| FileGrant::new(&grant.path, grant.is_dir))
        .collect()
}

fn is_wpe_web(media_type: Option<&str>) -> bool {
    wpe_kind(media_type).as_deref() == Some("web")
}

impl DirIndexMaps {
    /// 沿 `key` 的祖先向上找，第一个在表里的目录就是它所属的壁纸（文档在壁纸子目录里也能找到）。
    fn entry_containing(&self, key: &str) -> Option<&WpeWebDirEntry> {
        let mut candidate = key;
        loop {
            if let Some(entry) = self.entry_by_dir_key.get(candidate) {
                return Some(entry);
            }
            let cut = candidate.rfind(MAIN_SEPARATOR)?;
            if cut == 0 {
                // 到根目录为止：Unix 的 `/` 本身不会是壁纸目录
                return None;
            }
            candidate = &candidate[..cut];
        }
    }

    fn remove(&mut self, image_id: &str) {
        let Some(key) = self.dir_key_by_image_id.remove(image_id) else {
            return;
        };
        // 同一目录可能已被另一张壁纸（大小写不同的同一路径）接管，只删自己的
        if self
            .entry_by_dir_key
            .get(&key)
            .is_some_and(|entry| entry.image_id == image_id)
        {
            self.entry_by_dir_key.remove(&key);
        }
    }

    fn insert(&mut self, key: String, entry: WpeWebDirEntry) {
        self.remove(&entry.image_id);
        if let Some(previous) = self.entry_by_dir_key.get(&key) {
            let previous = previous.image_id.clone();
            self.dir_key_by_image_id.remove(&previous);
        }
        self.dir_key_by_image_id
            .insert(entry.image_id.clone(), key.clone());
        self.entry_by_dir_key.insert(key, entry);
    }
}

impl WpeWebDirIndex {
    fn new() -> Self {
        Self {
            inner: RwLock::new(DirIndexMaps::default()),
        }
    }

    /// 全局实例。未初始化（非 Windows、或尚未 [`init_wpe_web_dir_index`]）时是空表：闸门全拒、拉取报错。
    pub fn global() -> &'static Self {
        static INDEX: OnceLock<WpeWebDirIndex> = OnceLock::new();
        INDEX.get_or_init(Self::new)
    }

    /// 包含 `path` 的网页壁纸的访问范围：壁纸目录 + 这张壁纸的用户选择；不在任何网页壁纸里返回 None。
    pub fn access_scope_of(&self, path: &Path) -> Option<FileAccessScope> {
        let key = file_path_key(path)?;
        let maps = self.inner.read().ok()?;
        let entry = maps.entry_containing(&key)?;
        Some(FileAccessScope {
            root: Some(entry.dir.clone()),
            grants: entry.grants.clone(),
        })
    }

    /// 文档 `doc` 所在网页壁纸的图片 id。
    pub fn image_id_of(&self, doc: &Path) -> Option<String> {
        let key = file_path_key(doc)?;
        let maps = self.inner.read().ok()?;
        maps.entry_containing(&key)
            .map(|entry| entry.image_id.clone())
    }

    pub fn contains_image(&self, image_id: &str) -> bool {
        self.inner
            .read()
            .map(|maps| maps.dir_key_by_image_id.contains_key(image_id))
            .unwrap_or(false)
    }

    /// 用这张壁纸当前 metadata 算出的用户选择**覆盖**它的放行（不是追加：改了目录属性，旧目录立即不可读）。
    /// 表里没有这张壁纸时什么都不做。
    pub fn replace_grants(&self, image_id: &str, grants: Vec<WpeFileGrant>) {
        let grants = to_file_grants(grants);
        let Ok(mut maps) = self.inner.write() else {
            return;
        };
        let Some(key) = maps.dir_key_by_image_id.get(image_id).cloned() else {
            return;
        };
        if let Some(entry) = maps.entry_by_dir_key.get_mut(&key) {
            entry.grants = grants;
        }
    }

    /// 登记 / 更新一张网页壁纸。目录规范化失败（已不存在）时不登记，原有条目一并删除。
    fn upsert(&self, image_id: &str, local_path: &str, metadata: Option<&Value>) {
        let dir = PathBuf::from(local_path);
        let key = file_path_key(&dir);
        let grants = metadata
            .map(|raw| to_file_grants(user_file_grants(raw)))
            .unwrap_or_default();
        let Ok(mut maps) = self.inner.write() else {
            return;
        };
        match key {
            Some(key) => maps.insert(
                key,
                WpeWebDirEntry {
                    image_id: image_id.to_string(),
                    dir,
                    grants,
                },
            ),
            None => maps.remove(image_id),
        }
    }

    fn remove(&self, image_id: &str) {
        if let Ok(mut maps) = self.inner.write() {
            maps.remove(image_id);
        }
    }

    /// 用一次全量扫描的结果整张替换。
    fn replace_all(&self, rows: Vec<(String, String, Option<Value>)>) {
        let mut maps = DirIndexMaps::default();
        for (image_id, local_path, metadata) in rows {
            let dir = PathBuf::from(&local_path);
            let Some(key) = file_path_key(&dir) else {
                continue;
            };
            let grants = metadata
                .as_ref()
                .map(|raw| to_file_grants(user_file_grants(raw)))
                .unwrap_or_default();
            maps.insert(
                key,
                WpeWebDirEntry {
                    image_id,
                    dir,
                    grants,
                },
            );
        }
        if let Ok(mut current) = self.inner.write() {
            *current = maps;
        }
    }
}

/// 全量读取库内网页壁纸：行走 `idx_images_type`，metadata 按行读（只有几十到几百行）。阻塞调用。
fn scan_library() -> Result<Vec<(String, String, Option<Value>)>, String> {
    let storage = Storage::global();
    Ok(storage
        .list_wpe_web_rows()?
        .into_iter()
        .map(|(image_id, local_path)| {
            let metadata = storage.get_metadata(&image_id).ok().flatten();
            (image_id, local_path, metadata)
        })
        .collect())
}

const FOLLOWED_KINDS: [AppEventKind; 4] = [
    AppEventKind::ImagesAdded,
    AppEventKind::ImagesDeleted,
    AppEventKind::ImageChanged,
    AppEventKind::ImagesChange,
];

/// 建表并接上闸门与事件。调用方需在 Storage 就绪之后、任何网页壁纸 iframe 加载之前调用（见模块注释）；
/// 在普通线程上同步执行，不需要处在异步运行时里。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn init_wpe_web_dir_index() {
    let index = WpeWebDirIndex::global();
    // 1. 先订阅再扫描：扫描期间新增 / 删除的行留在通道里，扫完再处理，不会漏。
    //    广播订阅本身是同步的；合流在后台任务里做。
    let receivers: Vec<_> = FOLLOWED_KINDS
        .iter()
        .map(|kind| EventBroadcaster::global().subscribe(*kind))
        .collect();
    // 2. 全量建表；失败就保持空表：闸门全拒、拉取报错，网页壁纸加载不出来，但不放宽
    match scan_library() {
        Ok(rows) => {
            let count = rows.len();
            index.replace_all(rows);
            tracing::info!("网页壁纸目录索引已建立: {count} 张");
        }
        Err(error) => tracing::error!("网页壁纸目录索引初始化失败: {error}"),
    }
    // 3. 注册给 runtime：之后每个要过闸门的 file: 请求都查这张表；注册之前一律拒绝
    tauri_runtime_kbcef::set_file_scope_resolver(Arc::new(|path| {
        WpeWebDirIndex::global().access_scope_of(path)
    }));
    // 4. 后台跟随事件
    tauri::async_runtime::spawn(follow_events(receivers));
}

/// 合流后的一项：一条事件，或某个订阅落后丢了事件、需要全量重建。
enum Followed {
    Event(ArcAppEvent),
    Resync,
}

async fn follow_events(receivers: Vec<broadcast::Receiver<(u64, ArcAppEvent)>>) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    for mut receiver in receivers {
        let tx = tx.clone();
        tokio::spawn(async move {
            loop {
                let item = match receiver.recv().await {
                    Ok((_, event)) => Followed::Event(event),
                    Err(broadcast::error::RecvError::Lagged(_)) => Followed::Resync,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if tx.send(item).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    // 事件处理只改内存、按 id 读库，不发事件；逐事件路径上不打 trace 以上的日志（事件管线会自激放大）。
    while let Some(item) = rx.recv().await {
        match item {
            Followed::Event(event) => handle_event(&event).await,
            Followed::Resync => resync().await,
        }
    }
}

async fn handle_event(event: &AppEvent) {
    let index = WpeWebDirIndex::global();
    match event {
        // 新增行带完整 ImageInfo：只看 x-wpe/web，再按 id 读行与 metadata（各订阅之间不保证先后，
        // 按库里的当前状态落地，与到达顺序无关）
        AppEvent::ImagesAdded { images, .. } => {
            for image in images
                .iter()
                .filter(|image| is_wpe_web(image.media_type.as_deref()))
            {
                refresh(image.id.clone()).await;
            }
        }
        // 删除只带 id：靠 dir_key_by_image_id 找到目录
        AppEvent::ImagesDeleted { image_ids, .. } => {
            image_ids.iter().for_each(|id| index.remove(id));
        }
        AppEvent::ImageChanged { patch, .. } => on_patch(patch).await,
        AppEvent::ImagesChange { patches, .. } => {
            for patch in patches {
                on_patch(patch).await;
            }
        }
        _ => {}
    }
}

/// 只处理表里已有的壁纸，且补丁带 `metadataId`（改写了用户属性）或 `localPath` 时，重读这一行。
async fn on_patch(patch: &ImageFieldPatch) {
    if WpeWebDirIndex::global().contains_image(&patch.id)
        && (patch.fields.contains_key("metadataId") || patch.fields.contains_key("localPath"))
    {
        refresh(patch.id.clone()).await;
    }
}

/// 读这一行与它的 metadata 后 upsert；行已不存在或不再是 x-wpe/web 就 remove。
async fn refresh(image_id: String) {
    let read = tokio::task::spawn_blocking(move || {
        let row = Storage::find_image_by_id(&image_id)?;
        let found = row
            .filter(|info| is_wpe_web(info.media_type.as_deref()))
            .map(|info| {
                let metadata = Storage::global().get_metadata(&info.id).ok().flatten();
                (info.local_path, metadata)
            });
        Ok::<_, String>((image_id, found))
    })
    .await;
    let index = WpeWebDirIndex::global();
    match read {
        Ok(Ok((image_id, Some((local_path, metadata))))) => {
            index.upsert(&image_id, &local_path, metadata.as_ref())
        }
        Ok(Ok((image_id, None))) => index.remove(&image_id),
        Ok(Err(error)) => tracing::trace!("网页壁纸目录索引读行失败: {error}"),
        Err(error) => tracing::trace!("网页壁纸目录索引读行任务失败: {error}"),
    }
}

/// 订阅落后丢了事件：整张重建（极少发生）。失败时保留现有表。
async fn resync() {
    match tokio::task::spawn_blocking(scan_library).await {
        Ok(Ok(rows)) => WpeWebDirIndex::global().replace_all(rows),
        Ok(Err(error)) => tracing::warn!("网页壁纸目录索引重建失败: {error}"),
        Err(error) => tracing::warn!("网页壁纸目录索引重建任务失败: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    /// `<tmp>/kabegame-wpe-dir-index-<name>-<pid>/{wp-a,wp-b,picked-a,picked-b}`。
    fn fixture(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "kabegame-wpe-dir-index-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        for dir in ["wp-a/sub", "wp-b", "picked-a", "picked-b"] {
            fs::create_dir_all(base.join(dir)).unwrap();
        }
        fs::write(base.join("wp-a/index.html"), "a").unwrap();
        fs::write(base.join("wp-a/sub/page.html"), "a2").unwrap();
        fs::write(base.join("wp-b/index.html"), "b").unwrap();
        fs::write(base.join("picked-a/1.jpg"), "1").unwrap();
        fs::write(base.join("picked-b/2.jpg"), "2").unwrap();
        base
    }

    /// 带一个 `directory` 属性、用户选了 `picked` 的 project.json 原文。
    fn metadata_picking(picked: &Path) -> Value {
        json!({
            "general": { "properties": {
                "photos": { "type": "directory", "text": "Photos", "mode": "fetchall" }
            } },
            "userProperties": { "photos": picked.to_string_lossy() }
        })
    }

    fn path_str(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn finds_the_wallpaper_of_a_document_through_its_ancestors() {
        let base = fixture("ancestors");
        let index = WpeWebDirIndex::new();
        index.upsert("1", &path_str(&base.join("wp-a")), None);
        index.upsert("2", &path_str(&base.join("wp-b")), None);

        assert_eq!(
            index.image_id_of(&base.join("wp-a/index.html")).as_deref(),
            Some("1")
        );
        // 文档在壁纸子目录里
        assert_eq!(
            index
                .image_id_of(&base.join("wp-a/sub/page.html"))
                .as_deref(),
            Some("1")
        );
        assert_eq!(
            index.image_id_of(&base.join("wp-b/index.html")).as_deref(),
            Some("2")
        );
        // 库外
        assert_eq!(index.image_id_of(&base.join("picked-a/1.jpg")), None);
        assert!(index
            .access_scope_of(&base.join("picked-a/1.jpg"))
            .is_none());
        // 访问范围的根就是壁纸目录
        let scope = index.access_scope_of(&base.join("wp-a/sub")).unwrap();
        assert_eq!(scope.root.as_deref(), Some(base.join("wp-a").as_path()));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn removes_by_image_id_and_skips_missing_directories() {
        let base = fixture("remove");
        let index = WpeWebDirIndex::new();
        index.upsert("1", &path_str(&base.join("wp-a")), None);
        assert!(index.contains_image("1"));
        index.remove("1");
        assert!(!index.contains_image("1"));
        assert_eq!(index.image_id_of(&base.join("wp-a/index.html")), None);

        // 目录已不存在：不登记，原有条目一并删除
        index.upsert("2", &path_str(&base.join("wp-b")), None);
        fs::remove_dir_all(base.join("wp-b")).unwrap();
        index.upsert("2", &path_str(&base.join("wp-b")), None);
        assert!(!index.contains_image("2"));
        index.upsert("3", &path_str(&base.join("missing")), None);
        assert!(!index.contains_image("3"));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn grants_follow_metadata_and_are_replaced_not_appended() {
        let base = fixture("grants");
        let index = WpeWebDirIndex::new();
        let wp = base.join("wp-a");
        index.upsert(
            "1",
            &path_str(&wp),
            Some(&metadata_picking(&base.join("picked-a"))),
        );
        let grants = |index: &WpeWebDirIndex| {
            index
                .access_scope_of(&wp.join("index.html"))
                .unwrap()
                .grants
                .into_iter()
                .map(|grant| grant.path)
                .collect::<Vec<_>>()
        };
        let canonical = |path: &Path| file_path_key(path).map(PathBuf::from).unwrap();
        // 键与路径在 Windows 上都转小写，比较前统一
        let keyed = |paths: Vec<PathBuf>| {
            paths
                .iter()
                .map(|path| file_path_key(path).unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            keyed(grants(&index)),
            keyed(vec![canonical(&base.join("picked-a"))])
        );

        // 换目录：覆盖，旧目录立即不在放行里
        index.replace_grants(
            "1",
            user_file_grants(&metadata_picking(&base.join("picked-b"))),
        );
        assert_eq!(
            keyed(grants(&index)),
            keyed(vec![canonical(&base.join("picked-b"))])
        );
        // 清空用户选择
        index.replace_grants("1", Vec::new());
        assert!(grants(&index).is_empty());
        // 不在表里的壁纸：什么都不做
        index.replace_grants(
            "missing",
            user_file_grants(&metadata_picking(&base.join("picked-a"))),
        );
        assert!(!index.contains_image("missing"));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn replace_all_rebuilds_the_table() {
        let base = fixture("replace-all");
        let index = WpeWebDirIndex::new();
        index.upsert("old", &path_str(&base.join("wp-b")), None);
        index.replace_all(vec![
            ("1".into(), path_str(&base.join("wp-a")), None),
            ("gone".into(), path_str(&base.join("missing")), None),
        ]);
        assert!(index.contains_image("1"));
        assert!(!index.contains_image("old"));
        assert!(!index.contains_image("gone"));
        let _ = fs::remove_dir_all(base);
    }

    /// 目录键与闸门同一套规范化：Windows 上不分大小写，大小写不同的同一路径落到同一条目。
    #[test]
    fn directory_keys_match_the_gate() {
        let base = fixture("keys");
        let index = WpeWebDirIndex::new();
        index.upsert("1", &path_str(&base.join("wp-a")), None);
        let doc = base.join("wp-a/index.html");
        assert_eq!(
            file_path_key(&base.join("wp-a")),
            index
                .access_scope_of(&doc)
                .and_then(|scope| scope.root)
                .and_then(|root| file_path_key(&root))
        );
        #[cfg(target_os = "windows")]
        {
            let upper = PathBuf::from(path_str(&doc).to_uppercase());
            assert_eq!(index.image_id_of(&upper).as_deref(), Some("1"));
        }
        let _ = fs::remove_dir_all(base);
    }
}
