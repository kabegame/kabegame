//! 场景查找范围里有哪些文件：工程散文件、`scene.pkg` 条目与 WPE `assets`，和场景宿主读资源的三处一致
//! （`apps/wpe-scene/src/compile/fs.ts` 的 `SceneFs`）。路径相对各自根目录、`/` 分隔、保持原样大小写，怎么规整成键由宿主定。
//!
//! 用途：场景脚本 `createLayer` / `createModelData` 的 `__workshopId` 改写（rea-p6d-script 2.2）要知道一条路径存不存在，
//! 存在就不改写。WPE 在运行时问它的资源文件系统；宿主的脚本跑在同步的 realm 里、问不了文件，所以每次加载经命令
//! `wpe_scene_files` 拉一次全表。
//!
//! 缓存都在这里，都不失效（还不支持运行中更新）：
//! - `assets` 按目录缓存一次运行（WPE 自带资源）；
//! - 每个工程目录的散文件与 pkg 条目放进容量 [`PROJECT_CACHE_CAPACITY`] 的 LRU。
//!
//! 运行中改了工程目录或 WPE 安装，要重启应用才看得到。

use std::borrow::Borrow;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use super::project::{read_pkg_entry_names, WPE_SCENE_PKG};

/// 工程目录清单的 LRU 容量（按工程目录计）。
pub const PROJECT_CACHE_CAPACITY: usize = 100;

type Files = Arc<Vec<String>>;

fn assets_cache() -> MutexGuard<'static, HashMap<PathBuf, Files>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Files>>> = OnceLock::new();
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn projects_cache() -> MutexGuard<'static, Lru<PathBuf, Files>> {
    static CACHE: OnceLock<Mutex<Lru<PathBuf, Files>>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(Lru::new(PROJECT_CACHE_CAPACITY)))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// 工程目录（散文件与 `scene.pkg` 条目）与各 `assets` 目录里的全部文件。顺序是散文件、pkg 条目、各 assets 目录，不去重。
pub fn scene_files(project_dir: &Path, asset_dirs: &[PathBuf]) -> Vec<String> {
    let mut files = project_files(project_dir).as_ref().clone();
    for dir in asset_dirs {
        files.extend(asset_files(dir).iter().cloned());
    }
    files
}

fn project_files(dir: &Path) -> Files {
    if let Some(hit) = projects_cache().get(dir) {
        return hit;
    }
    // 在锁外读盘：同一个工程并发未命中时各读一遍，后写的覆盖，内容相同
    let mut files = relative_files(dir);
    let pkg = dir.join(WPE_SCENE_PKG);
    match read_pkg_entry_names(&pkg) {
        Ok(names) => files.extend(names),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!("读 {} 的条目表失败：{error}", pkg.display()),
    }
    let files = Arc::new(files);
    projects_cache().put(dir.to_path_buf(), files.clone());
    files
}

fn asset_files(dir: &Path) -> Files {
    if let Some(hit) = assets_cache().get(dir) {
        return hit.clone();
    }
    let files = Arc::new(relative_files(dir));
    assets_cache().insert(dir.to_path_buf(), files.clone());
    files
}

/// `dir` 下全部普通文件相对 `dir` 的路径（`/` 分隔）。不跟随符号链接，读不到的项跳过，目录不存在时为空。
fn relative_files(dir: &Path) -> Vec<String> {
    walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let relative = entry.path().strip_prefix(dir).ok()?;
            let parts: Vec<_> = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect();
            Some(parts.join("/"))
        })
        .collect()
}

/// 容量固定的 LRU。`entries` 按最近使用从新到旧排；容量只有 100，线性查找就够。
struct Lru<K, V> {
    capacity: usize,
    entries: VecDeque<(K, V)>,
}

impl<K, V: Clone> Lru<K, V> {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: VecDeque::new(),
        }
    }

    /// 命中时挪到最前并返回值。
    fn get<Q: PartialEq + ?Sized>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        let index = self.entries.iter().position(|(k, _)| k.borrow() == key)?;
        let entry = self.entries.remove(index)?;
        let value = entry.1.clone();
        self.entries.push_front(entry);
        Some(value)
    }

    /// 放到最前；已有同键的先去掉，超出容量时丢最久没用的。
    fn put(&mut self, key: K, value: V)
    where
        K: PartialEq,
    {
        self.entries.retain(|(k, _)| *k != key);
        self.entries.push_front((key, value));
        self.entries.truncate(self.capacity);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 按 `scene.pkg` 的布局打一个包（同 `project.rs` 的测试）。
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

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn lists_loose_files_pkg_entries_and_assets() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let assets = root.path().join("assets");
        write(&project.join("project.json"), b"{}");
        write(&project.join("models/Sub/b.json"), b"{}");
        write(
            &project.join(WPE_SCENE_PKG),
            &pkg(&[("scene.json", b"{}"), ("models/workshop/1/x.json", b"{}")]),
        );
        write(&assets.join("models/util/solidlayer.json"), b"{}");

        let files = scene_files(&project, std::slice::from_ref(&assets));
        for expected in [
            "project.json",
            "models/Sub/b.json",
            "scene.pkg",
            "scene.json",
            "models/workshop/1/x.json",
            "models/util/solidlayer.json",
        ] {
            assert!(
                files.iter().any(|f| f == expected),
                "缺 {expected}：{files:?}"
            );
        }
        assert_eq!(files.len(), 6, "{files:?}");
    }

    #[test]
    fn missing_dirs_and_pkg_give_empty_lists() {
        let root = tempfile::tempdir().unwrap();
        let files = scene_files(&root.path().join("nope"), &[root.path().join("nope2")]);
        assert!(files.is_empty());
    }

    #[test]
    fn caches_are_not_invalidated() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let assets = root.path().join("assets");
        write(&project.join("a.json"), b"{}");
        write(&assets.join("b.json"), b"{}");
        let assets_dirs = std::slice::from_ref(&assets);
        assert_eq!(scene_files(&project, assets_dirs).len(), 2);
        // 运行中新增的文件看不到（还不支持更新）
        write(&project.join("c.json"), b"{}");
        write(&assets.join("d.json"), b"{}");
        assert_eq!(scene_files(&project, assets_dirs).len(), 2);
    }

    #[test]
    fn lru_evicts_least_recently_used() {
        let mut lru = Lru::new(2);
        lru.put("a".to_owned(), 1);
        lru.put("b".to_owned(), 2);
        assert_eq!(lru.get("a"), Some(1));
        lru.put("c".to_owned(), 3);
        assert_eq!(lru.get("b"), None, "b 最久没用，被挤掉");
        assert_eq!(lru.get("a"), Some(1));
        assert_eq!(lru.get("c"), Some(3));
        lru.put("a".to_owned(), 4);
        assert_eq!(lru.get("a"), Some(4), "同键覆盖");
        assert_eq!(lru.entries.len(), 2);
    }
}
