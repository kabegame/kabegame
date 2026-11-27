//! 场景查找范围里有哪些文件：工程散文件、`scene.pkg` 条目与 WPE `assets`，和场景宿主读资源的三处一致
//! （`apps/wpe-scene/src/compile/fs.ts` 的 `SceneFs`）。按来源分开给，路径相对各自根目录、`/` 分隔、保持原样大小写，
//! 怎么规整成键由宿主定。
//!
//! 用途（宿主每次加载经命令 `wpe_scene_files` 拉一次）：
//! - 编译读资源（`SceneFs`）先查表：表里没有的位置不去探，表里的写法按真实大小写读；表里哪处都没有时才按原写法逐个探一次
//!   （表可能过时）。表只决定先去哪里找，不决定资源存不存在；
//! - 场景脚本 `createLayer` / `createModelData` 的 `__workshopId` 改写（rea-p6d-script 2.2）要知道一条路径存不存在，
//!   存在就不改写。WPE 在运行时问它的资源文件系统；宿主的脚本跑在同步的 realm 里、问不了文件，只能查表。
//!
//! 缓存都在这里，都不失效（还不支持运行中更新），目录不存在时不缓存：
//! - `assets` 按目录缓存一次运行（WPE 自带资源）；
//! - 每个工程目录的散文件与 pkg 条目放进容量 [`PROJECT_CACHE_CAPACITY`] 的 LRU。
//!
//! 运行中改了工程目录或 WPE 安装：编译靠 `SceneFs` 的逐个探兜底，结果不变、只是多探几次；脚本改写要重启应用才看得到。

use std::borrow::Borrow;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::Serialize;

use super::project::{read_pkg_entry_names, WPE_SCENE_PKG};

/// 工程目录清单的 LRU 容量（按工程目录计）。
pub const PROJECT_CACHE_CAPACITY: usize = 100;

type Files = Arc<Vec<String>>;

/// 一个目录里的全部普通文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirFiles {
    /// 目录本身，写法同 `wpe_scene_target` 的 `path` / `sceneAssets`（`to_string_lossy`），宿主按它对上自己的根目录。
    pub dir: String,
    /// 相对 `dir`、`/` 分隔、原样大小写。
    pub files: Vec<String>,
}

/// 场景查找范围里的文件，按来源分开（宿主的 `SceneFileList`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SceneFiles {
    /// 工程目录里的散文件（含 `scene.pkg` 本身）。
    pub project: DirFiles,
    /// `scene.pkg` 的条目名；没有包时为空。
    pub pkg: Vec<String>,
    /// 各个 `assets` 目录，顺序同参数 `asset_dirs`。
    pub assets: Vec<DirFiles>,
}

fn assets_cache() -> MutexGuard<'static, HashMap<PathBuf, Files>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Files>>> = OnceLock::new();
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn projects_cache() -> MutexGuard<'static, Lru<PathBuf, (Files, Files)>> {
    static CACHE: OnceLock<Mutex<Lru<PathBuf, (Files, Files)>>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(Lru::new(PROJECT_CACHE_CAPACITY)))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// 工程目录（散文件与 `scene.pkg` 条目）与各 `assets` 目录里的全部文件，按来源分开。
pub fn scene_files(project_dir: &Path, asset_dirs: &[PathBuf]) -> SceneFiles {
    let (loose, pkg) = project_files(project_dir);
    SceneFiles {
        project: DirFiles {
            dir: project_dir.to_string_lossy().into_owned(),
            files: loose.as_ref().clone(),
        },
        pkg: pkg.as_ref().clone(),
        assets: asset_dirs
            .iter()
            .map(|dir| DirFiles {
                dir: dir.to_string_lossy().into_owned(),
                files: asset_files(dir).as_ref().clone(),
            })
            .collect(),
    }
}

/// 工程目录的散文件与 `scene.pkg` 条目名。
fn project_files(dir: &Path) -> (Files, Files) {
    if let Some(hit) = projects_cache().get(dir) {
        return hit;
    }
    // 在锁外读盘：同一个工程并发未命中时各读一遍，后写的覆盖，内容相同
    let loose = Arc::new(relative_files(dir));
    let path = dir.join(WPE_SCENE_PKG);
    let pkg = Arc::new(match read_pkg_entry_names(&path) {
        Ok(names) => names,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            tracing::warn!("读 {} 的条目表失败：{error}", path.display());
            Vec::new()
        }
    });
    // 目录还不存在（如 WPE 还没装好）时不缓存空表，装好之后下次加载就能看到
    if dir.is_dir() {
        projects_cache().put(dir.to_path_buf(), (loose.clone(), pkg.clone()));
    }
    (loose, pkg)
}

fn asset_files(dir: &Path) -> Files {
    if let Some(hit) = assets_cache().get(dir) {
        return hit.clone();
    }
    let files = Arc::new(relative_files(dir));
    // 同上：目录不存在时不缓存（Kabegame 从 Steam 顺带下载 WPE 本体是在运行中）
    if dir.is_dir() {
        assets_cache().insert(dir.to_path_buf(), files.clone());
    }
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
    fn lists_loose_files_pkg_entries_and_assets_by_source() {
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
        assert_eq!(files.project.dir, project.to_string_lossy());
        let mut loose = files.project.files.clone();
        loose.sort();
        assert_eq!(loose, ["models/Sub/b.json", "project.json", "scene.pkg"]);
        assert_eq!(files.pkg, ["scene.json", "models/workshop/1/x.json"]);
        assert_eq!(
            files.assets,
            [DirFiles {
                dir: assets.to_string_lossy().into_owned(),
                files: vec!["models/util/solidlayer.json".to_owned()],
            }]
        );
    }

    #[test]
    fn missing_dirs_and_pkg_give_empty_lists() {
        let root = tempfile::tempdir().unwrap();
        let files = scene_files(&root.path().join("nope"), &[root.path().join("nope2")]);
        assert!(files.project.files.is_empty());
        assert!(files.pkg.is_empty());
        assert_eq!(files.assets.len(), 1, "每个 assets 目录都有一项");
        assert!(files.assets[0].files.is_empty());
    }

    #[test]
    fn missing_dirs_are_not_cached() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("later");
        let assets = root.path().join("later-assets");
        let assets_dirs = std::slice::from_ref(&assets);
        assert!(scene_files(&project, assets_dirs).project.files.is_empty());
        // 目录之后才出现（WPE 本体运行中才下载好）：下次就能看到
        write(&project.join("a.json"), b"{}");
        write(&assets.join("b.json"), b"{}");
        let files = scene_files(&project, assets_dirs);
        assert_eq!(files.project.files, ["a.json"]);
        assert_eq!(files.assets[0].files, ["b.json"]);
    }

    #[test]
    fn caches_are_not_invalidated() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let assets = root.path().join("assets");
        write(&project.join("a.json"), b"{}");
        write(&assets.join("b.json"), b"{}");
        let assets_dirs = std::slice::from_ref(&assets);
        let count = |files: &SceneFiles| files.project.files.len() + files.assets[0].files.len();
        assert_eq!(count(&scene_files(&project, assets_dirs)), 2);
        // 运行中新增的文件看不到（还不支持更新；编译靠 SceneFs 逐个探兜底）
        write(&project.join("c.json"), b"{}");
        write(&assets.join("d.json"), b"{}");
        assert_eq!(count(&scene_files(&project, assets_dirs)), 2);
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
