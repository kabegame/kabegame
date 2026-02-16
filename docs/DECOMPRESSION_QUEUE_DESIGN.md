# 解压队列统一设计：本地导入入队 DecompressionJob

本文档描述将「本地导入」中压缩文件的解压统一走**解压队列**与**解压 worker** 的设计方案。适用于桌面与 Android（桌面：Rust 解压入队；Android：按 [ANDROID_ARCHIVE_IMPORT.md](./ANDROID_ARCHIVE_IMPORT.md) 由 Kotlin 解压后返回目录，Rust 侧只扫目录，不入队本地压缩包）。

---

## 1. 目标与范围

- **目标**：所有「解压压缩包」的行为都经过唯一的解压 worker，避免在 Task Worker 线程内同步解压大包导致卡顿；并便于统一取消、状态与错误处理。
- **范围**：
  - **桌面**：用户选择本地路径中的压缩文件（zip/rar 等）时，不再在 `local_import.rs` 的 `enumerate_image_paths` 里内联调用 `processor.process()`，改为入队 `DecompressionJob`，由解压 worker 执行解压，Task Worker 只等待结果并继续「扫描结果 + 注册图片」的现有流程。
  - **爬虫下载**：保持现有逻辑不变——下载完成后入队 `DecompressionJob`，解压 worker 解压后对每张图调用 `download_with_temp_guard`。
- **Processor**：`ArchiveProcessor::process()` 的签名与语义不变（解压到指定目录、返回图片路径列表）；仅「谁在何时调用」改为统一由解压 worker 调用。

---

## 2. DecompressionJob 扩展：按来源分支

当前 `DecompressionJob` 只服务「爬虫下载的压缩包」。需要增加**来源类型**，使同一队列同时支持「爬虫下载」与「本地导入」两种后续处理方式。

### 2.1 建议结构（Rust 侧）

```rust
// decompression.rs（或 downloader.rs 中定义）

/// 解压完成后的处理方式
pub enum DecompressionJobKind {
    /// 爬虫下载：解压后对每张图调用 download_with_temp_guard 写入 images_dir
    CrawlerDownload {
        images_dir: PathBuf,
        http_headers: HashMap<String, String>,
        output_album_id: Option<String>,
        download_start_time: u64,
        temp_dir_guard: Option<Arc<TempDirGuard>>,
    },
    /// 本地导入：解压后仅将「图片路径列表 + 临时目录守卫」回传给任务侧，由任务侧做注册
    LocalImport {
        /// 用于将 (Vec<PathBuf>, Arc<TempDirGuard>) 回传给等待的 Task Worker
        response_tx: oneshot::Sender<Result<(Vec<PathBuf>, Arc<TempDirGuard>), String>>,
    },
}

#[derive(Clone)]
pub struct DecompressionJob {
    pub archive_path: PathBuf,
    pub original_url: String,   // file:///... 或 http(s)://...
    pub task_id: String,
    pub plugin_id: String,
    pub kind: DecompressionJobKind,
}
```

- **CrawlerDownload**：保留现有字段（含 `images_dir`、`http_headers`、`output_album_id`、`download_start_time`、`temp_dir_guard`），解压后逻辑与现在一致。
- **LocalImport**：仅需 `response_tx`；解压 worker 在解压完成后向该 channel 发送 `Ok((image_paths, temp_dir_guard))` 或 `Err(...)`，不调用 `download_with_temp_guard`。

注意：`oneshot::Sender` 可能不实现 `Clone`，实际实现时可用 `Option<oneshot::Sender<...>>` 或将 `LocalImport` 单独装箱（如 `Box<LocalImportPayload>`）再放入 enum，以便 `DecompressionJob` 仍可 `Clone`（若队列需要）或改为不 Clone 仅移入队列。

---

## 3. 解压 Worker 行为（decompression_worker_loop）

- 从 `decompression_queue` 取出的仍是**一个** `DecompressionJob`。
- 根据 `job.kind` 分支：
  - **CrawlerDownload**：与当前实现一致：
    - 使用 `archive::manager().get_processor()` 解压到 `archive_path.parent()` 的目录；
    - 得到 `Vec<PathBuf>` 后，对每个路径调用 `download_with_temp_guard(..., job.images_dir, ...)`；
    - 发送 archiver-log、错误处理等保持不变。
  - **LocalImport**：
    - 在 worker 内创建**本次解压专用**的临时目录（例如 `std::env::temp_dir().join(format!("kabegame_local_archive_{}", uuid))`），并创建 `TempDirGuard` 持有该目录；
    - 将 `archive_path` 转为 `file:///...` URL，调用 `processor.process(url, &temp_dir, &dummy_downloader, &cancel_check)`，得到 `Vec<PathBuf>`；
    - 通过 `response_tx.send(Ok((images, temp_dir_guard)))` 将**图片路径列表**和**临时目录守卫**一并交给等待方；若解压或取消失败，则 `send(Err(...))`。
- **Processor 内部**：无需修改。仍为「解压到给定 `temp_dir` + 递归收集图片路径并返回」；worker 负责创建 temp_dir 和 guard，并将返回的路径与 guard 一起交给 LocalImport 调用方。

---

## 4. 本地导入侧：入队与等待结果

### 4.1 enumerate_image_paths 的同步契约

- `enumerate_image_paths` 当前为同步函数，返回 `Result<Vec<PathBuf>, String>`。
- 修改后仍为同步接口，但需要对「压缩文件」做**入队 + 阻塞等待**，并保证等待期间临时目录不被回收。

建议：

- 返回值改为 `Result<(Vec<PathBuf>, Vec<Arc<TempDirGuard>>), String>`：
  - 第一个：所有图片路径（包含从压缩包解压得到的路径）；
  - 第二个：本次枚举中因「压缩包」而产生的临时目录守卫，调用方必须在注册完成前持有，避免解压目录被删。
- 对每个路径：
  - 若是**目录**：继续 `collect_images_from_dir`，不产生 guard。
  - 若是**单张图片**：加入列表，不产生 guard。
  - 若是**压缩文件**（`is_archive_ext`）：
    1. 创建 `oneshot::channel()`；
    2. 构造 `DecompressionJob { archive_path, original_url: file_url, task_id, plugin_id: "本地导入", kind: LocalImport { response_tx } }`；
    3. 将 job 推入 `dq.decompression_queue` 并 `notify_waiters()`；
    4. 使用当前任务已有的 `tokio::runtime::Handle`（或通过 `download_queue` 拿到）执行 `rt.block_on(response_rx)`，得到 `Result<(Vec<PathBuf>, Arc<TempDirGuard>), String>`；
    5. 若为 `Ok((paths, guard))`：将 `paths` 并入结果列表，将 `guard` 加入本次返回的 `Vec<Arc<TempDirGuard>>`；若为 `Err`，则向上返回错误。
- 循环结束后返回 `(result_paths, guards)`。

### 4.2 run_builtin_local_import 的配合

- 调用 `enumerate_image_paths` 后得到 `(image_paths, temp_guards)`。
- 先**保留 `temp_guards` 在作用域内**（例如放在局部变量中），再执行现有的「遍历 image_paths、compute_file_hash、storage.add_image、画册、进度与事件」等逻辑。
- 在函数末尾或适当位置 drop `temp_guards`，解压临时目录即可被清理。

这样，本地导入的「解压」完全发生在解压 worker 中，Task Worker 只负责「等结果 + 注册」，与现有「专门解压线程」的设计一致；且不改变 Processor 的接口与内部实现。

---

## 5. Processor 内部实现

- **无需为本次设计修改**。各 `ArchiveProcessor` 实现仍：
  - 接收 `url`、`temp_dir`、`downloader`、`cancel_check`；
  - 将压缩包解压到 `temp_dir`；
  - 在 `temp_dir` 下递归收集图片路径并返回 `Vec<PathBuf>`。
- 解压 worker 负责：
  - 为 LocalImport 创建并持有 `temp_dir` 与 `TempDirGuard`；
  - 调用 `processor.process(..., temp_dir, ...)`；
  - 将返回的路径与 guard 通过 channel 交给本地导入任务。

---

## 6. 与 Android 的衔接

- **Android 本地导入**：按 [ANDROID_ARCHIVE_IMPORT.md](./ANDROID_ARCHIVE_IMPORT.md)，由 Kotlin 插件将 content URI 解压到目录并返回目录路径；Rust 侧只对该目录做 `collect_images_from_dir`，**不入队** `DecompressionJob`（解压在 Kotlin 完成）。
- **桌面本地导入**：按本文档，压缩文件一律入队 `DecompressionJob`（kind = LocalImport），由解压 worker 在 Rust 内解压并回传路径 + guard。
- 解压队列与 `decompression_worker_loop` 在桌面与 Android 上均存在；仅「谁往队列里推 LocalImport 任务」不同：桌面在 `local_import::enumerate_image_paths` 中推，Android 不推（压缩包由 Kotlin 处理）。

---

## 7. 实现清单（仅作文档索引，不要求在本 PR 全部完成）

- [ ] **DecompressionJob**：增加 `kind: DecompressionJobKind`（或等价分支），保留/迁移现有爬虫下载所需字段到 `CrawlerDownload`，新增 `LocalImport { response_tx }`；必要时调整 `Clone`/所有权（如 channel 仅移动一次）。
- [ ] **decompression_worker_loop**：按 `job.kind` 分支；CrawlerDownload 保持现有逻辑；LocalImport 创建 temp_dir + guard，调用 `processor.process`，向 `response_tx` 发送 `(paths, guard)` 或错误。
- [ ] **local_import.rs**：`enumerate_image_paths` 改为返回 `(Vec<PathBuf>, Vec<Arc<TempDirGuard>>)`；遇到压缩文件时构造 LocalImport 的 `DecompressionJob` 并入队，`block_on(response_rx)` 后合并路径与 guard；`run_builtin_local_import` 在注册阶段持有返回的 guards，结束后再 drop。
- [ ] **downloader.rs**：构造爬虫下载的 `DecompressionJob` 时使用 `kind: DecompressionJobKind::CrawlerDownload { ... }`，保证与当前行为一致。
- [ ] **Processor**：无需改动；仅确认解压 worker 对 LocalImport 传入的 `temp_dir` 与 guard 生命周期使用正确。

---

以上设计使「本地导入选压缩文件」与「爬虫下载压缩包」共用同一解压队列与 worker，解压均在专门线程/任务中执行，Processor 接口与内部实现保持不变，仅调用路径与 job 类型扩展。
