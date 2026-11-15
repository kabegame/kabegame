//! 把 WPE 装进 [`super::managed_engine_dir`]，按 manifest 增量更新。
//!
//! 是否下载只看「Wallpaper Engine 目录」设置（先自动查找一次）：
//! - 设置为空：下载到应用管理目录，完成后写进设置；
//! - 设置指向应用管理目录：按 manifest 增量更新，manifest 没变且文件都在就跳过；
//! - 设置指向别处（用户自己的安装或手选目录）：不下载。
//!
//! 安装状态记在 `<库>/steamapps/kabegame_wpe_install.json`（每个 depot 的 manifest id、每个文件的大小与 SHA-1）。
//! 文件先写 `<文件>.kbpart`，全部 chunk 到齐才改名；中断后再跑时，状态里没有记录、大小又对得上的文件现算一次
//! SHA-1，对上就不重下。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use std::sync::Arc;

use super::cdn::{CdnPool, ChunkRef, ManifestFile};
use super::cm::{self, CmError};
use super::{managed_engine_dir, managed_library, WPE_APP_ID};
use crate::settings::Settings;
use crate::wpe::discover;
use crate::wpe::scan::path_key;

/// 同时下载的 chunk 数（DepotDownloader 缺省 8）。
const CONCURRENCY: usize = 8;
const STATE_FILE: &str = "kabegame_wpe_install.json";
const PART_SUFFIX: &str = ".kbpart";

/// 拉取过程中给调用方的回调。
pub struct PullHooks<'a> {
    pub cancel: &'a CancellationToken,
    /// 0.0 ~ 1.0。
    pub progress: &'a (dyn Fn(f64) + Send + Sync),
    /// 任务日志：级别、i18n 键、参数。
    pub log: &'a (dyn Fn(&str, &str, Value) + Send + Sync),
}

#[derive(Debug)]
pub enum EngineOutcome {
    /// 设置里已有别的 WPE 目录，不下载。
    SkippedExisting(PathBuf),
    /// 应用管理的安装已是最新。
    UpToDate(PathBuf),
    /// 下载或更新完成。
    Installed { dir: PathBuf, files: usize, bytes: u64 },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallState {
    app_id: u32,
    build_id: String,
    /// depot id → manifest id（都存成字符串，避免 JSON 数字精度问题）。
    depots: BTreeMap<String, String>,
    files: BTreeMap<String, FileState>,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct FileState {
    size: u64,
    sha: String,
}

/// 对话框展示用的安装信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedInstallInfo {
    pub build_id: String,
    pub updated_at: u64,
    pub files: usize,
}

fn state_path(library: &Path) -> PathBuf {
    library.join("steamapps").join(STATE_FILE)
}

fn read_state(library: &Path) -> InstallState {
    std::fs::read(state_path(library))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_state(library: &Path, state: &InstallState) -> Result<(), String> {
    let path = state_path(library);
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("写安装状态失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写安装状态失败：{e}"))
}

/// 应用管理的安装信息；没装过时为 None。
pub fn managed_install_info() -> Option<ManagedInstallInfo> {
    let library = managed_library()?;
    let state = read_state(&library);
    (state.app_id == WPE_APP_ID && !state.files.is_empty()).then(|| ManagedInstallInfo {
        build_id: state.build_id,
        updated_at: state.updated_at,
        files: state.files.len(),
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn same_path(a: &Path, b: &Path) -> bool {
    path_key(&a.to_string_lossy()) == path_key(&b.to_string_lossy())
}

/// 设置里的目录是不是应用管理的那个（目录还没建时也能比较）。
pub fn is_managed_engine_dir(dir: &Path) -> bool {
    let Some(managed) = managed_engine_dir() else {
        return false;
    };
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    same_path(&canonical(dir), &canonical(&managed))
}

fn file_sha_hex(path: &Path) -> Option<String> {
    use sha1::{Digest, Sha1};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha1::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(hex::encode(hasher.finalize()))
}

/// 文件是否已经是 manifest 里的那份：状态记录一致且大小对得上；没有记录时大小对得上再现算 SHA-1。
fn is_current(path: &Path, file: &ManifestFile, recorded: Option<&FileState>) -> bool {
    let sha = hex::encode(file.sha);
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() != file.size {
        return false;
    }
    if recorded.is_some_and(|state| state.sha == sha && state.size == file.size) {
        return true;
    }
    file_sha_hex(path).as_deref() == Some(sha.as_str())
}

fn part_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(PART_SUFFIX);
    path.with_file_name(name)
}

fn write_at(path: &Path, offset: u64, data: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("打开 {} 失败：{e}", path.display()))?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.write_all(data)
        .map_err(|e| format!("写入 {} 失败：{e}", path.display()))
}

fn finish_part(part: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        let _ = std::fs::remove_file(target);
    }
    std::fs::rename(part, target).map_err(|e| format!("改名 {} 失败：{e}", target.display()))
}

/// 拉取入口（`wpe-import` 任务调用）。见模块说明的三种情况。
pub async fn ensure_engine(account: &str, hooks: &PullHooks<'_>) -> Result<EngineOutcome, String> {
    let (Some(library), Some(engine)) = (managed_library(), managed_engine_dir()) else {
        return Err("应用数据目录未初始化".to_string());
    };
    // 先让自动查找跑一次：Steam 库里本来就有 WPE 时会写进设置，之后就不下载
    let _ = tokio::task::spawn_blocking(discover::engine_dir).await;
    if let Some(dir) = Settings::global().get_wpe_engine_dir().map(PathBuf::from) {
        if !is_managed_engine_dir(&dir) {
            return Ok(EngineOutcome::SkippedExisting(dir));
        }
    }

    (hooks.log)("info", "taskLogWpeSteamConnecting", json!({ "account": account }));
    let connection = cm::connect(account).await.map_err(|error| match error {
        CmError::SessionInvalid(message) => message,
        CmError::Other(message) => message,
    })?;
    let build = cm::app_build(&connection, WPE_APP_ID).await?;
    if build.depots.is_empty() {
        return Err("Steam 没有返回可下载的 Wallpaper Engine 内容".to_string());
    }

    let state = tokio::task::spawn_blocking({
        let library = library.clone();
        move || read_state(&library)
    })
    .await
    .map_err(|e| e.to_string())?;
    let manifests_unchanged = state.app_id == WPE_APP_ID
        && build.depots.len() == state.depots.len()
        && build.depots.iter().all(|depot| {
            state.depots.get(&depot.depot_id.to_string()) == Some(&depot.manifest_id.to_string())
        });
    if manifests_unchanged {
        let all_present = {
            let engine = engine.clone();
            let files: Vec<(String, u64)> = state.files.iter().map(|(p, f)| (p.clone(), f.size)).collect();
            tokio::task::spawn_blocking(move || {
                files.iter().all(|(path, size)| {
                    std::fs::metadata(engine.join(path)).is_ok_and(|m| m.len() == *size)
                })
            })
            .await
            .unwrap_or(false)
        };
        if all_present {
            set_engine_dir_if_empty(&engine);
            return Ok(EngineOutcome::UpToDate(engine));
        }
    }

    let servers = cm::cdn_servers(&connection, WPE_APP_ID).await?;
    let pool = Arc::new(CdnPool::new(WPE_APP_ID, connection.clone(), servers));
    // 后面的 depot 覆盖前面的同名文件（与 Steam 一致）
    let mut files: BTreeMap<String, (u32, ManifestFile)> = BTreeMap::new();
    let mut keys: HashMap<u32, Vec<u8>> = HashMap::new();
    for depot in &build.depots {
        if hooks.cancel.is_cancelled() {
            return Err("Task canceled".to_string());
        }
        let key = cm::depot_key(&connection, WPE_APP_ID, depot.depot_id).await?;
        let code =
            cm::manifest_request_code(&connection, WPE_APP_ID, depot.depot_id, depot.manifest_id).await?;
        let manifest = pool.manifest(depot.depot_id, depot.manifest_id, code, &key).await?;
        (hooks.log)(
            "info",
            "taskLogWpeSteamManifest",
            json!({
                "depot": depot.depot_id,
                "files": manifest.files.len(),
                "sizeMb": format!("{:.1}", depot.size as f64 / 1048576.0),
            }),
        );
        for file in manifest.files {
            files.insert(file.path.clone(), (depot.depot_id, file));
        }
        keys.insert(depot.depot_id, key);
    }

    // 规划：建目录、跳过已是最新的文件、删掉新版本里没有的旧文件
    let plan = {
        let engine = engine.clone();
        let files: Vec<(u32, ManifestFile)> = files.values().cloned().collect();
        let recorded = state.files.clone();
        tokio::task::spawn_blocking(move || plan_downloads(&engine, &files, &recorded))
            .await
            .map_err(|e| e.to_string())??
    };
    let total_bytes: u64 = plan
        .downloads
        .iter()
        .flat_map(|(_, file)| file.chunks.iter())
        .map(|chunk| chunk.compressed_len as u64)
        .sum();
    (hooks.log)(
        "info",
        "taskLogWpeSteamDownloading",
        json!({
            "files": plan.downloads.len(),
            "sizeMb": format!("{:.1}", total_bytes as f64 / 1048576.0),
        }),
    );

    download_files(&pool, &engine, &plan.downloads, Arc::new(keys), total_bytes, hooks).await?;

    // 新版本里没有的旧文件：只删我们装过的（状态里记录的）
    let new_paths: HashSet<&str> = files.keys().map(String::as_str).collect();
    for path in state.files.keys().filter(|path| !new_paths.contains(path.as_str())) {
        let _ = std::fs::remove_file(engine.join(path));
    }

    let next_state = InstallState {
        app_id: WPE_APP_ID,
        build_id: build.build_id.clone(),
        depots: build
            .depots
            .iter()
            .map(|depot| (depot.depot_id.to_string(), depot.manifest_id.to_string()))
            .collect(),
        files: files
            .values()
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
        updated_at: now_secs(),
    };
    write_state(&library, &next_state)?;
    set_engine_dir_if_empty(&engine);
    (hooks.progress)(1.0);
    Ok(EngineOutcome::Installed {
        dir: engine,
        files: plan.downloads.len(),
        bytes: total_bytes,
    })
}

fn set_engine_dir_if_empty(engine: &Path) {
    let settings = Settings::global();
    if settings.get_wpe_engine_dir().is_none() {
        if let Err(error) = discover::set_engine_dir(Some(engine.to_string_lossy().into_owned())) {
            tracing::warn!("写入 WPE 安装目录设置失败：{error}");
        }
    }
}

struct Plan {
    /// 要下载的文件（depot id、文件）。
    downloads: Vec<(u32, ManifestFile)>,
}

fn plan_downloads(
    engine: &Path,
    files: &[(u32, ManifestFile)],
    recorded: &BTreeMap<String, FileState>,
) -> Result<Plan, String> {
    std::fs::create_dir_all(engine).map_err(|e| format!("创建 {} 失败：{e}", engine.display()))?;
    let mut downloads = Vec::new();
    for (depot_id, file) in files {
        let target = engine.join(&file.path);
        if file.is_dir {
            std::fs::create_dir_all(&target).map_err(|e| format!("创建 {} 失败：{e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败：{e}", parent.display()))?;
        }
        if is_current(&target, file, recorded.get(&file.path)) {
            continue;
        }
        if file.chunks.is_empty() {
            // 空文件不用下载
            std::fs::write(&target, b"").map_err(|e| format!("写入 {} 失败：{e}", target.display()))?;
            continue;
        }
        downloads.push((*depot_id, file.clone()));
    }
    Ok(Plan { downloads })
}

/// 并发下载 chunk。每个 chunk 的 future 只持有自己的数据（Arc 与克隆），不借用外部引用：
/// `stream.map(|..| async { 借用 })` 会让 rustc 证明不了 future 对所有生命周期都是 Send。
async fn download_files(
    pool: &Arc<CdnPool>,
    engine: &Path,
    downloads: &[(u32, ManifestFile)],
    keys: Arc<HashMap<u32, Vec<u8>>>,
    total_bytes: u64,
    hooks: &PullHooks<'_>,
) -> Result<(), String> {
    if downloads.is_empty() {
        return Ok(());
    }
    // 预先建好每个文件的 .kbpart（定长），chunk 按偏移写入
    let parts: Vec<(PathBuf, PathBuf)> = downloads
        .iter()
        .map(|(_, file)| {
            let target = engine.join(&file.path);
            (part_path(&target), target)
        })
        .collect();
    {
        let parts = parts.clone();
        let sizes: Vec<u64> = downloads.iter().map(|(_, file)| file.size).collect();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            for ((part, _), size) in parts.iter().zip(sizes) {
                let file = std::fs::File::create(part).map_err(|e| format!("创建 {} 失败：{e}", part.display()))?;
                file.set_len(size).map_err(|e| e.to_string())?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }

    let remaining: Arc<Vec<AtomicUsize>> = Arc::new(
        downloads
            .iter()
            .map(|(_, file)| AtomicUsize::new(file.chunks.len()))
            .collect(),
    );
    let parts = Arc::new(parts);
    let done_bytes = AtomicU64::new(0);
    let jobs: Vec<(usize, u32, ChunkRef)> = downloads
        .iter()
        .enumerate()
        .flat_map(|(index, (depot_id, file))| {
            file.chunks.iter().map(move |chunk| (index, *depot_id, chunk.clone()))
        })
        .collect();

    let mut results = stream::iter(jobs)
        .map(|(index, depot_id, chunk)| {
            let parts = Arc::clone(&parts);
            let remaining = Arc::clone(&remaining);
            let pool = Arc::clone(pool);
            let keys = Arc::clone(&keys);
            let cancel = hooks.cancel.clone();
            async move {
                if cancel.is_cancelled() {
                    return Err("Task canceled".to_string());
                }
                let key = keys.get(&depot_id).ok_or("缺 depot 密钥")?;
                let data = pool.chunk(depot_id, &chunk, key).await?;
                let part = parts[index].0.clone();
                let offset = chunk.offset;
                tokio::task::spawn_blocking(move || write_at(&part, offset, &data))
                    .await
                    .map_err(|e| e.to_string())??;
                // 写完才减：把计数减到 0 的那个 chunk 是这个文件最后写完的，其余都已落盘
                let last = remaining[index].fetch_sub(1, Ordering::AcqRel) == 1;
                Ok::<_, String>((index, chunk.compressed_len as u64, last))
            }
        })
        .buffer_unordered(CONCURRENCY);

    while let Some(result) = results.next().await {
        let (index, bytes, last) = result?;
        let done = done_bytes.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if total_bytes > 0 {
            (hooks.progress)(done as f64 / total_bytes as f64);
        }
        if last {
            let (part, target) = parts[index].clone();
            tokio::task::spawn_blocking(move || finish_part(&part, &target))
                .await
                .map_err(|e| e.to_string())??;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wpe::steam::cdn::ChunkRef;
    use sha1::{Digest, Sha1};

    fn manifest_file(path: &str, data: &[u8]) -> ManifestFile {
        ManifestFile {
            path: path.to_string(),
            size: data.len() as u64,
            is_dir: false,
            sha: Sha1::digest(data).into(),
            chunks: vec![ChunkRef {
                id: Sha1::digest(data).into(),
                offset: 0,
                original_len: data.len() as u32,
                compressed_len: data.len() as u32,
            }],
        }
    }

    #[test]
    fn plan_skips_current_files_and_hashes_unrecorded_ones() {
        let dir = tempfile::tempdir().unwrap();
        let engine = dir.path().join("wallpaper_engine");
        std::fs::create_dir_all(engine.join("assets")).unwrap();
        std::fs::write(engine.join("assets/same.h"), b"same").unwrap();
        std::fs::write(engine.join("assets/changed.h"), b"old!").unwrap();
        let files = vec![
            (1, manifest_file("assets/same.h", b"same")),
            (1, manifest_file("assets/changed.h", b"new!")),
            (1, manifest_file("assets/missing.h", b"x")),
            (
                1,
                ManifestFile {
                    path: "projects/defaultprojects".into(),
                    size: 0,
                    is_dir: true,
                    sha: [0; 20],
                    chunks: vec![],
                },
            ),
        ];
        // 状态里没有记录：same.h 现算 SHA-1 对上，不重下；changed.h 大小相同但内容不同，要重下
        let plan = plan_downloads(&engine, &files, &BTreeMap::new()).unwrap();
        let paths: Vec<&str> = plan.downloads.iter().map(|(_, f)| f.path.as_str()).collect();
        assert_eq!(paths, vec!["assets/changed.h", "assets/missing.h"]);
        assert!(engine.join("projects/defaultprojects").is_dir());
    }

    #[test]
    fn part_and_finish() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.bin");
        std::fs::write(&target, b"old").unwrap();
        let part = part_path(&target);
        assert_eq!(part.file_name().unwrap(), "a.bin.kbpart");
        std::fs::File::create(&part).unwrap().set_len(4).unwrap();
        write_at(&part, 2, b"cd").unwrap();
        write_at(&part, 0, b"ab").unwrap();
        finish_part(&part, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"abcd");
        assert!(!part.exists());
    }
}
