# Android 压缩包导入方案

本文档描述在 Android 上通过 Kotlin 插件统一解压压缩包、Rust 端按「目录扫描」现有流程处理的方案。目标是：**输入为 content URI，输出为解压目录路径，Rust 侧仅负责扫描该目录**，与选择文件夹的流程一致。

---

## 1. 设计原则

- **平台分工**：Desktop 解压全部在 Rust（现有 `archive` 模块）；Android 解压全部在 Kotlin，避免 RAR 等 C 库依赖。
- **接口统一**：Android 插件只负责「content URI → 解压到某目录 → 返回目录路径」；Rust 收到目录路径后，与「选择文件夹」走同一套 `collect_images_from_dir` 逻辑，不做格式区分。

---

## 2. 插件契约

### 2.1 方法名

建议在现有 **FolderPicker** 插件或新建 **Archive** 插件中提供：

- **`extractArchiveToDirectory`**（或等价名称）

### 2.2 输入

| 参数 | 类型 | 说明 |
|------|------|------|
| `uri` | `String` | 单个 **content URI**，指向用户选择的压缩文件（如 `content://...`）。 |

仅支持单个 URI；多选时由前端/Rust 多次调用。

### 2.3 输出

| 字段 | 类型 | 说明 |
|------|------|------|
| `dir` | `String` | 解压后的**目录绝对路径**（app 私有存储，如 cache 或 files 下的子目录）。Rust 将对此路径执行「扫描目录」逻辑。 |

返回结构示例（JSON，与 Tauri 插件约定一致）：

```json
{
  "dir": "/data/user/0/app.kabegame/cache/archive_extract/abc123"
}
```

失败时通过 Tauri 的 plugin 错误机制返回错误信息（如「不支持的格式」「解压失败」）。

### 2.4 行为约定

- 插件根据 URI 打开 `InputStream`，根据文件扩展名或魔数识别格式（zip / rar / 7z / tar / gz / bz2 / xz 等）。
- 解压到 **临时目录**（如 `context.cacheDir/archive_extract/<唯一子目录>`），避免多次选择同一文件时冲突。
- 解压完成后返回该**目录的绝对路径**；目录内结构可为任意层级，Rust 端按 `recursive: true` 递归扫描。
- 生命周期：该目录可在本次「本地导入」任务完成后由 Kotlin 在适当时机清理（例如任务成功注册后通过某次调用通知插件清理，或依赖系统 cache 策略）。本文档不规定具体清理时机，仅约定「输出是目录路径」。

---

## 3. Rust 端处理流程（Android）

在 **`local_import.rs`** 的 `enumerate_image_paths` 中，对 Android 上「content URI 且视为压缩包」的路径：

1. **识别**：当前项为 `content://` 且任务参数或上下文表明这是「压缩文件选择」（例如通过额外参数 `is_archive: true`，或统一对 content URI 先调「解压」再扫目录，见下）。
2. **调用插件**：  
   `extractArchiveToDirectory(uri: path_str)` → 得到 `{ dir: String }`。
3. **统一当目录处理**：  
   将返回的 `dir` 视为一个普通目录路径，调用现有逻辑：  
   `collect_images_from_dir(PathBuf::from(dir), recursive, &mut result)?`。  
   不再调用 `crate::archive::manager().get_processor()`。

这样，**输入 = content URI，输出 = 目录路径，后续 = 与现有文件夹流程相同的目录扫描**。

### 3.1 与现有 content URI 的区分

当前 Android 上 `content://` 由 `content_uri::resolve` 处理，用于**文件夹**（`listContentTree`：遍历 SAF 树并复制文件到可读路径，返回文件列表）。

- **方案 A（推荐）**：前端在选择「压缩文件」时，对返回的 content URI 打上标记传入任务配置，例如 `paths: ["content://..."], path_is_archive: [true]`，或单路径时 `is_archive: true`。Rust 根据该标记决定调用 `extractArchiveToDirectory` 还是 `listContentTree`。
- **方案 B**：Rust 先根据扩展名或 MIME 推断：若无法访问文件元数据，可先尝试 `extractArchiveToDirectory`，失败再走 `listContentTree`（实现更复杂，不推荐）。

文档建议采用 **方案 A**，由前端在创建「本地导入」任务时显式标记是否为压缩包。

---

## 4. Kotlin 端实现要点

- **依赖**：
  - **Apache Commons Compress**：zip, tar, gz, bz2, xz, 7z。
  - **Junrar**（纯 Java）：rar。
- **流程**：
  1. 通过 `ContentResolver.openInputStream(uri)` 获取输入流（必要时用 `takePersistablePermission` 等保证可读）。
  2. 根据 URI 的 type/扩展名或流头魔数选择解压器。
  3. 在 `context.cacheDir`（或 `getDir("archive_extract", MODE_PRIVATE)`）下创建唯一子目录（如 UUID）。
  4. 解压到该目录。
  5. 返回该目录的绝对路径（`File.getAbsolutePath()`）。

支持的格式与前端「选择压缩文件」的说明保持一致：**.zip、.rar、.7z、.tar、.gz、.bz2、.xz** 等。

---

## 5. 数据流小结

```
[用户选择压缩文件] → content URI
       ↓
[前端] addTask("本地导入", { paths: [uri], isArchive: true })
       ↓
[Rust] enumerate_image_paths
       ↓ (Android && content:// && isArchive)
[Kotlin] extractArchiveToDirectory(uri) → { dir }
       ↓
[Rust] collect_images_from_dir(dir, recursive, &mut result)  // 与现有文件夹流程相同
       ↓
[Rust] 后续：注册图片、写入存储等（不变）
```

---

## 6. 文档与实现清单

- [ ] Android 插件实现 `extractArchiveToDirectory`（输入 content URI，输出目录路径）。
- [ ] Rust：在 `local_import.rs` 的 Android 分支中，对标记为压缩包的 content URI 调用该插件，并将返回的 `dir` 交给 `collect_images_from_dir`。
- [ ] 前端：在「选择压缩文件」创建本地导入任务时，传入 `is_archive: true`（或等价的 `path_is_archive` 列表）。
- [ ] 可选：任务完成后由 Rust 通知插件清理对应解压目录，或依赖 cache 策略。

以上即为「输入 content URI，输出目录，Rust 只扫目录」的完整方案说明。
