# 下载器流程与任务计数

本文档描述下载队列、scheme downloader、DownloadSink 溢写、worker 后处理、失败重试与任务图片计数事件的流程。

---

## 1. 总览

```
任务/脚本发起 download_image
    -> 写入 image_metadata，DownloadRequest 只携带 metadata_id 与 display_name
    -> DownloadQueue::download 等待下载池容量并入队
    -> download_worker_loop 取 job，发送 Preparing -> Downloading
    -> URL 前置去重：命中已有图片时跳过读取，只补画册/计数/事件
    -> download_with_retry 按 URL scheme 读取，写入 DownloadSink（内存 ≤5 MiB，超阈溢写到临时文件）
    -> 后处理：postprocess_downloaded_image 统一入口，按 PostprocessSource 处理 Bytes/Path
    -> 成功、失败、取消或去重终态后，等待 downloadIntervalMs 并释放下载池槽位
```

下载阶段通过 `DownloadSink` 管理内存/磁盘缓冲，下载结果为 `DownloadOutcome`（`Bytes` 或 `Path`）。后处理由统一的 `postprocess_downloaded_image` 函数完成，根据 `PostprocessSource` 枚举（`Bytes` 或 `Path`）自适应处理路径。桌面 WebView/CEF native 下载也登记进 `DownloadQueue.active_downloads`，以 `native=true` 标识，但不占下载池并发额度。Android 本地 `content://` 导入不走下载池后处理，直接走 content URI 入库。

---

## 2. 代码位置

| 文件 | 责任 |
|------|------|
| `src-tauri/kabegame-core/src/crawler/downloader/mod.rs` | downloader 模块门面；scheme downloader trait/注册表；`download_with_retry`；下载间隔 helper；统一 `postprocess_downloaded_image`；`DownloadSink` / `DownloadOutcome` / `PostprocessSource` 定义；最终目标路径与 Android Pictures copy / content URI 入库 |
| `src-tauri/kabegame-core/src/crawler/downloader/queue.rs` | `DownloadQueue`、下载池、统一 active download 状态机、原生下载登记/移除、worker loop、URL 前置去重、失败记录 upsert、任务图片计数快照 |
| `src-tauri/kabegame-core/src/crawler/downloader/http.rs` | HTTP/HTTPS scheme downloader；响应流读取写入 `DownloadSink`、Range 续传、进度事件、请求头处理 |
| `src-tauri/kabegame-core/src/crawler/downloader/content.rs` | Android-only `content://` scheme downloader；从 ContentResolver 读取 bytes 写入 `DownloadSink` |
| `src-tauri/kabegame-core/src/crawler/downloader/compress.rs` | 图片缩略图、视频预览压缩、缩略图尺寸策略 |
| `src-tauri/kabegame-core/src/crawler/downloader/util.rs` | 安全文件名、唯一下载路径、hash、MIME/文件名辅助 |
| `src-tauri/kabegame/src/startup.rs`、`src-tauri/kabegame/src/commands/surf.rs`、`src-tauri/kabegame/src/commands/crawler.rs` | 桌面 WebView/CEF native 下载触发、URL identity 匹配、落盘路径指定与统一后处理衔接 |
| `src-tauri/kabegame-core/src/crawler/scheduler.rs` | crawl task 调度；失败图片重试句柄；任务级 header/display_name/metadata 快照回放 |
| `src-tauri/kabegame/src/commands/task.rs` | 失败项重试、取消重试、删除失败项等命令入口 |
| `apps/kabegame/src/stores/failedImages.ts` | 前端失败图片事件增量同步 |
| `apps/kabegame/src/views/TaskDetail.vue`、`apps/kabegame/src/components/FailedImagesDialog.vue`、`apps/kabegame/src/components/common/FailedImagesHeaderButton.vue` | 任务详情、Header 失败图片入口与失败图片弹窗展示 |

额外涉及：
| `src-tauri/kabegame-core/src/app_paths.rs` | `downloads_temp_dir()` 提供溢写临时目录；`temp_dir` 提供通用临时目录；启动时临时文件清理逻辑 |

---

## 3. Scheme Downloader

### 下载器选择

`download_with_retry` 解析 URL 后从静态 registry 选择 downloader：

- 桌面：`http` / `https`
- Android：`content` / `http` / `https`

### DownloadSink：内存溢写磁盘

下载不再简单返回 `Vec<u8>`。`download_with_retry` 内部创建 `DownloadSink`：

- **阈值**：5 MiB（`DOWNLOAD_SINK_MEMORY_THRESHOLD`）。
- 接收到的 chunk 先写入内存缓冲区。
- 当内存缓冲超过 5 MiB 时，自动将已缓冲数据写入临时文件（`downloads_temp_dir()` 下以 `download_id` 命名的文件），后续 chunk 直接追加到临时文件。
- 下载完成后，`DownloadSink` 产出 `DownloadOutcome`：
  - `DownloadOutcome::Bytes(Vec<u8>)` — 数据未超过阈值，全部在内存。
  - `DownloadOutcome::Path(PathBuf)` — 数据已溢写到临时文件。

Scheme downloader trait 签名也有所调整：`download` 方法不再接收 `&mut Vec<u8>`，而是接收 `&mut DownloadSink`。这样：

- HTTP/HTTPS downloader 流式写入 sink，读流中断时利用 sink 中已缓冲的字节数（`sink.received()`）发送 `Range` 续传请求。
- `content://` downloader 一次性读取全部 bytes 写入 sink；失败按 fatal 返回，不做 HTTP 式重试。

重试时 `DownloadSink` 的状态得以保留：若前次尝试已将部分数据溢写到磁盘，`received` 计数仍准确，允许 HTTP downloader 从断点续传。

### 错误分类：Fatal / Retriable / Resumable

`DownloadAttemptError` 提供三种错误构建方式，对应三类重试策略：

| 种类 | 方法 | 语义 | 示例 |
|------|------|------|------|
| **Fatal** | `fatal(msg)` | 不可重试，直接向上传播为最终失败 | 过多重定向、任务取消、不支持的 MIME |
| **Retriable** | `retryable_request(msg)` / `retryable_status(status)` | 从头重试（清空 sink，重新请求） | 连接被拒、503/429、DNS 解析失败 |
| **Resumable** | `retryable_read_body(msg)` | 续传重试（保留 sink 已有数据，Range 从 received 继续） | 流读取超时、连接中断、body error |

重试循环逻辑：

1. Fatal 错误立即返回。
2. Retriable 错误：清空 sink，退避后重新发起请求（最多 `networkRetryCount + 1` 次）。
3. Resumable 错误：保留 sink 内容，退避后以 `Range: bytes={received}-` 续传；若服务端不支持 Range（返回 200 而非 206），则回退为 Retriable 从头重试。

### DownloadOutcome 与后处理衔接

`download_with_retry` 成功后返回 `DownloadOutcome`。worker 随后调用统一的 `postprocess_downloaded_image`，传入 `PostprocessSource`：

```rust
pub enum PostprocessSource<'a> {
    Bytes(&'a [u8]),
    Path(&'a Path),
}
```

- `DownloadOutcome::Bytes` → `PostprocessSource::Bytes`
- `DownloadOutcome::Path` → `PostprocessSource::Path`

后处理内部根据 source 类型决定如何计算 hash、推断 MIME 和落盘：
- `Bytes` 路径：直接从内存计算 hash/MIME，未去重时写入目标文件。
- `Path` 路径：从临时文件读取计算 hash/MIME，未去重时将临时文件移动到目标位置（或 Android 上复制到 MediaStore），完成后删除临时文件。

---

## 4. 队列与并发

`DownloadQueue::download` 做三件事：

- 若任务已取消，直接返回 `Task canceled`。
- 若这是失败图片重试且相同 `failed_image_id` 已在 active downloads 中，跳过重复入队。
- 等待下载池容量。容量由 `Settings::get_max_concurrent_downloads()` 动态决定；满载时等待 `capacity_notify`，被取消时退出等待。

worker 数量由 `start_download_workers` 与设置缩容逻辑维护。worker loop 同时监听：

- `job_notify`：取下一个 `DownloadRequest`
- `exit_notify`：当当前 worker 数量大于设置并发时退出

每个 job 进入 active downloads 后按状态机发送：

`Preparing -> Downloading -> Processing -> Completed/Failed/Canceled`

终态后调用 `wait_then_finish_download`：先按 `downloadIntervalMs` 等待，再 `in_flight--`、发送 `download-removed`、唤醒等待容量的入队者。

`active_downloads` 是所有进行中下载的唯一列表，包含下载池 worker 项和桌面 WebView/CEF native 项。因为 WebView `on_download` / `on_navigation` 回调是同步闭包，`active_downloads` 使用 `std::sync::Mutex`，native 项通过同步方法按 URL 查找、登记和取出：

- `register_native`：把 `ActiveDownloadInfo { native: true, ... }` 放入列表。
- `get_native` / `contains_native`：用于 Requested 复用预登记项和 navigation 拦截。
- `take_native`：Finished 时移除项并把其后端上下文交给后处理。

下载池容量门控只统计 `native=false` 的项，保持浏览器原生下载不挤占 reqwest worker 并发额度。任务取消统一走 `DownloadQueue::cancel_task_downloads`：下载池项加入协作取消集合；native 项从 `active_downloads` 移除并发送 `Canceled` 与 `download-removed`。如果浏览器下载之后仍回调 Finished，因为列表中已没有对应 URL，回调会被忽略。

---

## 5. 去重流程

去重受 `Settings::get_auto_deduplicate()` 控制。

### URL 前置去重

worker 在读取 bytes 前先查 `Storage::find_image_by_url(job.url)`。命中时：

- 记录 `taskLogDedupByUrl`
- 如果指定了输出画册，把已存在图片加入该画册并发送 `album-images-change`
- 增加 `tasks.dedup_count` 并发送 `task-image-counts`
- 发送 Completed，清理对应失败记录，跳过下载读取

### Hash 后置去重

未被 URL 去重命中时，worker 下载完成获得 `DownloadOutcome`，调用统一后处理 `postprocess_downloaded_image`，内部先推断 MIME 并计算 hash，再查 `Storage::find_image_by_hash`。命中时：

- 记录 `taskLogDedupByHash`
- 按需加入输出画册
- 发送 `images-change` reason `change`，让前端刷新既有记录关联视图
- 后处理最终分支收到 `imported = false` 后增加 `tasks.dedup_count`
- 发送 Completed，清理对应失败记录

Hash 去重现在覆盖 Android `content://`，不再由 content 分支绕过。

---

## 6. 入库与落盘

### 统一后处理入口

下载池 worker 调用统一的 `postprocess_downloaded_image`，不区分 `_bytes` / `_path` 变体。该函数接收 `PostprocessSource`，内部按 source 分发：

1. 推断 MIME（`Bytes` 用 `mime_type_from_bytes`；`Path` 用 `mime_type_from_path`）。
2. 计算 hash（同 source 分发）。
3. 查 `Storage::find_image_by_hash` 做 hash 去重。
4. 未命中去重时，根据 MIME 计算最终目标路径/文件名，落盘（或 Android MediaStore copy）。
5. 生成缩略图/预览，写入 `images` 表，广播事件。

### 桌面

桌面后处理（`PostprocessSource::Bytes` 或 `Path`）：

- 从 source 推断 MIME，并在函数内计算最终文件名和扩展名
- 未重复时写入最终文件
- 生成缩略图或视频预览
- 写入 `images`，其中 `local_path` 是磁盘路径，`thumbnail_path` 是缩略图路径或回退本地路径
- 按需写入目标画册并广播事件

桌面 WebView/CEF 原生下载完成后也复用同一后处理入口。触发原生下载前，后端会把下载所需的入库上下文登记到 `ActiveDownloadInfo` 的后端字段里，包括 `task_id` / `surf_record_id`、`plugin_id`、输出画册、header 快照、脚本指定展示名和 `metadata_id`。这些字段都使用 `#[serde(skip)]`，不会下发前端，避免暴露 cookie/鉴权 header。下载完成事件只负责按 URL 从 `active_downloads` 取回 native 项，并把浏览器落盘文件交给 `postprocess_downloaded_image`；后续入库、去重、缩略图和事件广播仍由统一后处理负责。native 下载也发送完整 lifecycle：`Downloading -> Processing -> Completed/Failed -> download-removed`，前端刷新快照时可以从同一个 `get_active_downloads` 结果看到池下载与 native 下载。

桌面的 `file://` 或其他本地导入路径也通过 `PostprocessSource::Path` 走统一后处理。

### Android

Android 下载池也走 `postprocess_downloaded_image`：

- 未命中去重时（`Bytes`/`Path` 源，非 `ContentUri`）：
  - 先把数据落到内部临时文件（`Bytes` 源写入 `cache_dir/image-download`；`Path` 源即溢写文件），再调用 `copy_image_to_pictures(temp_path, mime, name)` 复制进系统媒体库，得到最终 content URI，随后删除临时文件。
  - **复制目标按 MIME 分流**（Kotlin `copyFileToPictures` 内部）：图片 → `MediaStore.Images`（`Pictures/Kabegame/`），视频 → `MediaStore.Video`（`Movies/Kabegame/`）。视频必须写入 Video 集合，否则插入 Images 会触发 MIME 校验失败。
  - 复制后 `local_path` 被改写为该 content URI；之后的尺寸 / 大小 / 预览 / 展示名解析全部基于该 URI。
- 库内的最终命名与冲突处理交给 Android 系统；`get_display_name(uri)` 取回系统去重后的真实名。
- hash 去重发生在复制（写临时文件）之前，避免给系统媒体库制造重复项。
- 图片缩略图：`Bytes` 源直接从内存字节生成（最可靠）；`Path` 源（溢写文件已删除）改用 `get_image_thumbnail(content_uri)` 取系统缩略图，失败回退 `None`。
- 视频预览：必须在复制进库**之后**，用 content URI 走 Kotlin provider 的 `compress_video_for_preview(uri)` 生成（Android 版只接受 content URI，不接受文件路径）。
- 宽高：图片/视频均通过 content URI 由 `get_image_dimensions` / `get_video_dimensions` 解析（图片侧有 `BitmapFactory` 兜底，刚插入即可解码）。大小优先用 `Bytes` 长度，否则 `get_content_size(uri)`。
- 入库后 `images.local_path` 存最终 content URI，`images.url` 仍存原始下载 URL（`url.scheme()=="content"` 的本地导入才置空），缩略图仍是本地路径。
- `ContentUri` 源（本地 `content://` 导入）跳过复制：`local_path` 即原 URI。

本地 `content://` 导入走独立路径：`local_import.rs` 提前解析/传入 `display_name`，直接调用 `process_downloaded_content_image_to_storage`，不经过下载池的统一后处理。

---

## 7. 失败记录与重试

失败记录写入 `task_failed_images`，核心字段包括：

- `url`
- `plugin_id`
- `task_id`
- `order`，下载时沿用 `download_start_time`
- `last_error`
- `header_snapshot`
- `display_name`
- `metadata_id`

失败时 `upsert_failed_image_on_failure`：

- 普通失败新增失败记录并发送 `failed-images-change` added
- 重试失败更新原失败记录的 attempt/error/header snapshot，并发送 updated
- 同步发送 `task-image-counts`，让 `failedCount` 与任务表保持一致

重试入口在 `TaskScheduler::retry_failed_image`。它读取失败记录与任务：

- header 优先使用失败记录的 `header_snapshot`，为空时回退任务级 headers
- display name 与 metadata_id 从失败记录回放
- 每个 failed image id 维护一个 `download_handles` 句柄，防止重复重试并支持等待入队时取消
- 重试成功后清理失败记录并发送 removed/count 事件

批量重试、取消重试、删除失败项都通过命令层按 failed image id 操作；删除前会先取消对应重试句柄。

---

## 8. 事件

### 下载状态事件

`download-state` 记录单个 active download 的阶段：

- `preparing`
- `downloading`
- `processing`
- `completed`
- `canceled`
- `failed`

`download-progress` 由 HTTP/HTTPS downloader 在读取响应流时发送。`content://` 读取当前没有分块进度事件。

`download-removed` 在终态等待下载间隔后发送，前端据此从 active 列表移除。

### 图片与画册事件

下载器入库时按表拆分事件：

- 新增或刷新 `images`：发送 `images-change`
- 输出画册或去重补画册影响 `album_images`：发送 `album-images-change`

画廊分页、任务视图和 Plasma 依赖这两个事件区分刷新范围。详情见 [gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md](../gallery/GALLERY_PAGINATION_AND_IMAGE_LOAD.md)。

### 任务图片计数

事件名：`task-image-counts`（`DaemonEvent::TaskImageCounts`）。

载荷始终带 `taskId`，并按需携带当前绝对值：

- `successCount`
- `deletedCount`
- `failedCount`
- `dedupCount`

典型发送时机：

- 成功入库后，后处理最终分支收到 `imported = true` 并同步任务 success/failed 状态快照
- URL 前置去重命中或后处理最终分支收到 `imported = false` 后发送新的 `dedupCount`；`imported = false` 只表示后置 hash/path 去重
- 失败记录新增、更新、删除后刷新 `failedCount`
- 图片删除、整理删除后刷新 `deletedCount` 或相关计数

---

## 9. 设置

### 下载并发

`maxConcurrentDownloads` 控制下载池 in-flight 上限。入队时读取当前设置；worker 缩容通过 `exit_notify` 唤醒，多余 worker 在下一轮退出。

### 下载间隔

`downloadIntervalMs`：

- 范围：100 到 10000 ms
- 默认：500 ms
- 语义：每个下载 job 到达终态后，释放槽位前等待该时长
- 中断：等待期间监听 `exit_notify`，缩容时可提前结束等待

非下载池路径（本地导入、本地文件夹同步、native/surf 下载）使用 `wait_after_non_pool_download_if_needed`，保证单个处理流程也遵守同一下载间隔。

### 自动去重

`autoDeduplicate` 打开时启用 URL 前置去重和 hash 后置去重；关闭时仍会受 `local_path` 唯一约束保护，避免同一磁盘路径或同一 content URI 重复入库。

---

## 10. 启动临时文件清理

应用启动时执行临时文件清理，防止溢写残留占用磁盘：

- **清理范围**：`downloads_temp_dir()`（溢写目录 `cache_dir/downloads`）和通用 `temp_dir` 下的 `kabegame-*` 前缀文件。
- **清理时机**：`AppPaths::init()` 之后、下载池启动之前，由启动流程中专门的清理步骤完成。
- **清理策略**：删除目录内所有文件及子目录（不递归到系统其他路径）。
- **容错**：清理失败（权限不足、文件被占用）记录 warn 日志，不阻塞启动。

这确保上次异常退出（崩溃、强杀）遗留的溢写临时文件不会无限堆积。
