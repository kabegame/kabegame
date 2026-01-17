# Provider 插件系统设计文档

## 1. 设计背景

### 1.1 现状

Kabegame 的 Provider 系统目前只能返回已下载的本地图片，限制了数据视图的灵活性。

### 1.2 设计目标

1. **Provider 插件化**：允许插件作者使用 DSL 编写自定义 Provider
2. **支持远程 URL**：Provider 可以返回远程图片 URL，无需预先下载
3. **统一接口**：本地和远程图片使用统一的接口和体验
4. **按需下载**：用户可以选择预览远程图片，按需下载

## 2. Provider 插件系统

### 2.1 插件文件结构扩展

```
plugin-name.kgpg
    - manifest.json          # 插件元数据（必需）
    - icon.png               # 插件图标（可选）
    - config.json            # 插件配置（可选）
    - crawl.rhai             # 爬取脚本（可选，用于爬虫插件）
    - provider.rhai          # Provider 脚本（可选，用于 Provider 插件）
    # 或
    - provider.json          # Provider DSL 配置（可选，用于简单 Provider）
    - doc_root/              # 文档目录（可选）
```

### 2.2 Provider DSL 设计

#### 方案 A：Rhai DSL（命令式，复杂场景）

```rhai
// provider.rhai - Provider 定义脚本

// 定义 list 行为
fn list(storage) {
    // 获取所有标签
    let tags = storage.get_all_tags();
    
    let entries = [];
    for tag in tags {
        entries.push(provider_entry_directory(tag));
    }
    
    entries
}

// 定义 get_child 行为
fn get_child(storage, name) {
    // 创建按标签过滤的查询
    let query = image_query_by_metadata("tag", name);
    
    // 返回 CommonProvider
    provider_common(query)
}

// 定义 resolve_file 行为
fn resolve_file(storage, name) {
    // 根据文件名查找图片
    let image = storage.find_image_by_name(name);
    if image {
        (image.id, image.path)
    } else {
        null
    }
}
```

#### 方案 B：JSON DSL（声明式，简单场景）

```json
{
  "type": "provider",
  "name": "我的自定义视图",
  "description": "按标签组织的图片视图",
  
  "source": {
    "type": "storage",
    "query": {
      "tags": ["{{tag}}"]
    }
  },
  
  "list": {
    "type": "query",
    "query": "SELECT DISTINCT tag FROM image_metadata WHERE tag IS NOT NULL",
    "format": "directory"
  },
  
  "getChild": {
    "type": "filter",
    "filter": {
      "metadata.tag": "{{name}}"
    }
  }
}
```

### 2.3 PluginProvider 实现

```rust
// src-tauri/core/src/providers/plugin.rs

pub struct PluginProvider {
    plugin: Arc<Plugin>,
    path: Vec<String>,
    config: HashMap<String, serde_json::Value>,
}

impl Provider for PluginProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        // 执行插件的 list 函数
        let result = self.execute_provider_script("list", vec![
            serde_json::to_value(storage).unwrap(),
        ])?;
        
        // 转换为 FsEntry
        self.parse_list_result(result)
    }
    
    fn get_child(&self, storage: &Storage, name: &str) -> Option<Arc<dyn Provider>> {
        // 执行插件的 get_child 函数
        let result = self.execute_provider_script("get_child", vec![
            serde_json::to_value(storage).unwrap(),
            serde_json::to_value(name).unwrap(),
        ]).ok()?;
        
        // 解析结果，创建子 Provider
        self.parse_child_result(result, storage)
    }
}
```

### 2.4 Provider Rhai API

为 Provider 脚本提供 API：

- **数据源 API**：`storage_query()`, `http_api()`, `file_system()`
- **Provider 构建 API**：`provider_common()`, `provider_album()`
- **条目构建 API**：`provider_entry_directory()`, `provider_entry_file()`, `provider_entry_remote_file()`
- **查询 API**：`image_query_all()`, `image_query_by_album()`, `image_query_by_metadata()`

## 3. 远程 URL 支持

### 3.1 扩展 FsEntry

```rust
#[derive(Debug, Clone)]
pub enum FsEntry {
    /// 目录条目
    Directory { name: String },
    
    /// 文件条目（本地文件）
    File {
        name: String,
        image_id: String,
        resolved_path: PathBuf,
    },
    
    /// 远程文件条目（新增）
    RemoteFile {
        name: String,
        /// 唯一标识符（可以是 URL 的 hash，或自定义 ID）
        remote_id: String,
        /// 远程 URL（通用 URL，作为后备）
        url: String,
        /// 缩略图 URL（可选，Provider 可以提供）
        thumbnail_url: Option<String>,
        /// 原图 URL（可选，Provider 可以提供）
        original_url: Option<String>,
        /// 可选的本地缓存路径（如果已下载）
        cached_path: Option<PathBuf>,
        /// 元数据（可选）
        metadata: Option<HashMap<String, String>>,
    },
}
```

### 3.2 统一图片信息结构

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInfo {
    pub id: String,
    
    // 图片来源类型
    pub source_type: ImageSourceType,
    
    // 本地路径（如果已下载）
    pub local_path: Option<String>,
    
    // 远程 URL（如果未下载或来源是远程）
    pub url: Option<String>,
    
    // 缩略图 URL（可选，Provider 可以提供）
    pub thumbnail_url: Option<String>,
    
    // 原图 URL（可选，Provider 可以提供）
    pub original_url: Option<String>,
    
    // ... 其他字段 ...
}
```

**重要说明**：Provider 可以可选地提供缩略图或原图 URL，画廊会自动补充缺失的 URL：
- 如果只提供了缩略图 URL，画廊会使用缩略图作为原图（在需要原图时）
- 如果只提供了原图 URL，画廊会使用原图作为缩略图（在网格视图中）
- 这与现有 Provider 的逻辑一致（本地图片中，如果缩略图缺失，会使用原图；如果原图缺失，会使用缩略图）

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ImageSourceType {
    /// 本地已下载的图片
    Local,
    /// 远程图片（未下载）
    Remote,
    /// 混合：有本地缓存，但源是远程
    Cached,
}
```

### 3.3 前端处理

```typescript
// 根据来源类型选择 URL
if (image.sourceType === 'remote' || image.sourceType === 'cached') {
    // 远程图片：使用 Provider 提供的 URL（可选缩略图/原图）
    // 画廊会自动补充缺失的 URL
    imageSrcMap.value[image.id] = {
        // 优先使用缩略图 URL，缺失则使用原图 URL
        thumbnail: image.thumbnailUrl || image.originalUrl || image.url || '',
        // 优先使用原图 URL，缺失则使用缩略图 URL
        original: image.originalUrl || image.thumbnailUrl || image.url || '',
    };
} else if (image.localPath) {
    // 本地图片：使用 convertFileSrc
    // ... 现有逻辑 ...
}
```

**补充逻辑说明**：
- Provider 可以提供 `thumbnail_url` 和 `original_url` 中的任意一个或两个
- 如果只提供了 `thumbnail_url`，画廊会使用它作为原图（在需要原图时）
- 如果只提供了 `original_url`，画廊会使用它作为缩略图（在网格视图中）
- 如果两个都提供了，则分别使用
- 如果两个都缺失，则使用通用的 `url`（如果存在）
- 这与现有本地图片的逻辑一致：如果 `thumbnailPath` 缺失，使用 `localPath`；如果 `localPath` 缺失，使用 `thumbnailPath`

### 3.4 Provider URL 补充逻辑

Provider 可以可选地提供缩略图或原图 URL，画廊会自动补充缺失的 URL，与现有本地图片的逻辑一致。

#### 3.4.1 补充规则

```
如果提供了 thumbnailUrl 和 originalUrl：
  → 分别使用

如果只提供了 thumbnailUrl：
  → thumbnail = thumbnailUrl
  → original = thumbnailUrl（使用缩略图作为原图）

如果只提供了 originalUrl：
  → thumbnail = originalUrl（使用原图作为缩略图）
  → original = originalUrl

如果两个都缺失，但提供了 url：
  → thumbnail = url
  → original = url
```

#### 3.4.2 与现有逻辑一致

现有的本地图片逻辑已经实现了类似的补充：

```rust
// src-tauri/core/src/storage/gallery.rs
// resolve_gallery_image_path 函数

// 如果 local_path 不存在，使用 thumbnail_path
if !local_path.exists() {
    return thumbnail_path;  // 补充逻辑
}
```

```typescript
// packages/core/src/composables/useImageUrlLoader.ts
// pickThumbnailPath 函数

const pickThumbnailPath = (image: TImage): string => {
    return (image.thumbnailPath || image.localPath || "").trim();
    // 如果 thumbnailPath 缺失，使用 localPath（补充逻辑）
};
```

远程图片采用相同的补充策略，确保一致性。

#### 3.4.3 Provider 脚本示例

```rhai
// provider.rhai - 提供可选 URL

fn list(storage) {
    let images = fetch_images();
    let entries = [];
    
    for img in images {
        // 方式 1：只提供原图 URL
        entries.push(provider_entry_remote_file(
            img.filename,
            img.id,
            img.url,           // 通用 URL（后备）
            null,              // 无缩略图
            img.original_url,  // 只提供原图
            null,
            img.metadata
        ));
        
        // 方式 2：只提供缩略图 URL
        entries.push(provider_entry_remote_file(
            img.filename,
            img.id,
            img.url,
            img.thumbnail_url, // 只提供缩略图
            null,              // 无原图
            null,
            img.metadata
        ));
        
        // 方式 3：提供两个 URL
        entries.push(provider_entry_remote_file(
            img.filename,
            img.id,
            img.url,
            img.thumbnail_url, // 缩略图
            img.original_url,   // 原图
            null,
            img.metadata
        ));
    }
    
    entries
}
```

### 3.5 远程图片加载和缓存机制

#### 3.5.1 通过 download_image worker 加载

远程图片的加载必须通过 `download_image` worker，避免对服务器造成太大压力：

```rust
// src-tauri/core/src/providers/remote_file.rs

pub struct RemoteImageLoader {
    download_queue: Arc<DownloadQueue>,
    storage: Arc<Storage>,
    cache_dir: PathBuf,
}

impl RemoteImageLoader {
    /// 加载远程图片（通过 download_image worker）
    pub async fn load_remote_image(
        &self,
        url: &str,
        original_url: Option<&str>,
        thumbnail_url: Option<&str>,
    ) -> Result<RemoteImageInfo, String> {
        // 1. 根据 URL 判断是否本地已存在（避免反复加载相同图片）
        if let Some(existing) = self.storage.find_image_by_url(url).await? {
            // 图片已存在，直接返回本地路径
            return Ok(RemoteImageInfo {
                local_path: Some(existing.local_path),
                thumbnail_path: existing.thumbnail_path,
                cached: true,
            });
        }
        
        // 2. 检查缓存目录
        let url_hash = self.hash_url(url);
        let cache_path = self.cache_dir.join(format!("{}.cache", url_hash));
        
        if cache_path.exists() {
            // 缓存存在，直接使用
            return Ok(RemoteImageInfo {
                local_path: Some(cache_path),
                thumbnail_path: None,
                cached: true,
            });
        }
        
        // 3. 通过 download_image worker 下载（避免对服务器造成压力）
        // 使用原图 URL（如果提供了），否则使用通用 URL
        let download_url = original_url.unwrap_or(url);
        
        // 将下载任务加入队列
        let download_start_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        
        // 使用临时任务 ID（用于 Provider 图片的下载）
        let temp_task_id = format!("provider-{}", uuid::Uuid::new_v4());
        
        self.download_queue.download_image(
            download_url.to_string(),
            self.cache_dir.clone(),
            "provider".to_string(),  // plugin_id
            temp_task_id,
            download_start_time,
            None,  // output_album_id
            HashMap::new(),  // http_headers
        )?;
        
        // 4. 返回缓存路径（文件可能还在下载中）
        Ok(RemoteImageInfo {
            local_path: Some(cache_path),
            thumbnail_path: None,
            cached: false,  // 正在下载
        })
    }
    
    /// 根据 URL 生成哈希（用于去重和缓存）
    fn hash_url(&self, url: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(url.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}
```

#### 3.5.2 URL 去重检查

应用需要根据 Provider 提供的图片 URL 判断是否本地已经存在，避免反复加载相同图片：

```rust
// src-tauri/core/src/storage/images.rs

impl Storage {
    /// 根据 URL 查找已存在的图片
    pub async fn find_image_by_url(&self, url: &str) -> Result<Option<ImageInfo>, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        
        // 查询 images 表中的 url 字段（需要添加此字段）
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT id, local_path, thumbnail_path FROM images WHERE url = ?1",
                params![url],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();
        
        if let Some((id, local_path, thumbnail_path)) = row {
            // 验证文件是否存在
            if PathBuf::from(&local_path).exists() {
                return Ok(Some(ImageInfo {
                    id,
                    local_path: Some(local_path),
                    thumbnail_path: Some(thumbnail_path),
                    url: Some(url.to_string()),
                    source_type: ImageSourceType::Cached,
                    // ... 其他字段
                }));
            }
        }
        
        Ok(None)
    }
}
```

#### 3.5.3 缓存到本地后保存到画廊

如果已经通过 `download_image` 缓存到本地了，则直接保存到画廊：

```rust
// src-tauri/core/src/providers/remote_file.rs

impl RemoteImageLoader {
    /// 检查下载完成的图片，保存到画廊
    pub async fn check_and_save_to_gallery(
        &self,
        url: &str,
        image_id: &str,
        metadata: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        // 1. 检查图片是否已下载完成
        let url_hash = self.hash_url(url);
        let cache_path = self.cache_dir.join(format!("{}.cache", url_hash));
        
        if !cache_path.exists() {
            return Ok(());  // 还在下载中
        }
        
        // 2. 检查是否已经在画廊中
        if self.storage.find_image_by_url(url).await?.is_some() {
            return Ok(());  // 已存在
        }
        
        // 3. 生成缩略图
        let thumbnail_path = generate_thumbnail(&cache_path)?;
        
        // 4. 保存到画廊
        self.storage.add_image(
            image_id,
            &cache_path,
            &thumbnail_path,
            url,
            metadata,
        )?;
        
        Ok(())
    }
}
```

#### 3.5.4 前端下载按钮

用户可以直接点击右上角的下载按钮下载（原图 URL），按钮和任务里面的失败图片按钮一样：

```vue
<!-- packages/core/src/components/image/ImageItem.vue -->

<template>
  <div class="image-item" :class="{ 'remote-image': isRemote }">
    <!-- 远程图片下载按钮（右上角，和任务失败图片按钮一样） -->
    <el-tooltip 
      v-if="isRemote && !isDownloaded" 
      content="下载原图" 
      placement="top" 
      :show-after="300">
      <div class="download-remote-badge" @click.stop="handleDownloadRemote">
        <el-icon :size="14">
          <Download />
        </el-icon>
      </div>
    </el-tooltip>
    
    <!-- 图片内容 -->
    <img
      v-if="imageUrl"
      :src="imageUrl"
      :alt="image.name"
      @error="handleImageError"
      @load="handleImageLoad"
    />
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  image: ImageInfo;
  imageUrl?: { thumbnail?: string; original?: string };
}>();

const isRemote = computed(() => 
  props.image.sourceType === 'remote' || 
  props.image.sourceType === 'cached'
);

const isDownloaded = computed(() => 
  props.image.localPath != null
);

const handleDownloadRemote = async () => {
  // 调用后端下载远程图片（使用原图 URL）
  const url = props.image.originalUrl || props.image.url;
  if (!url) {
    ElMessage.warning('没有可下载的 URL');
    return;
  }
  
  try {
    await invoke('download_remote_image', {
      imageId: props.image.id,
      url: url,
      originalUrl: props.image.originalUrl,
      thumbnailUrl: props.image.thumbnailUrl,
    });
    ElMessage.success('已开始下载');
  } catch (error) {
    console.error('下载失败:', error);
    ElMessage.error('下载失败');
  }
};
</script>

<style scoped>
.download-remote-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 10;
  transition: background 0.2s;
}

.download-remote-badge:hover {
  background: rgba(0, 0, 0, 0.8);
}
</style>
```

#### 3.5.5 后端下载接口

```rust
// src-tauri/app-main/src/main.rs

#[tauri::command]
async fn download_remote_image(
    image_id: String,
    url: String,
    original_url: Option<String>,
    thumbnail_url: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let download_url = original_url.unwrap_or(url);
    
    // 检查是否已存在
    if let Some(_) = state.storage.find_image_by_url(&url).await? {
        return Err("图片已存在".to_string());
    }
    
    // 通过 download_image worker 下载
    let download_start_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    
    let temp_task_id = format!("provider-{}", uuid::Uuid::new_v4());
    
    state.download_queue.download_image(
        download_url,
        state.images_dir.clone(),
        "provider".to_string(),
        temp_task_id,
        download_start_time,
        None,
        HashMap::new(),
    )?;
    
    Ok(())
}
```

#### 3.5.6 前端 load_image_url 修改

**关键要点**：
1. **避免直接加载**：远程图片不直接通过 `<img src>` 加载，而是通过 `download_image` worker
2. **预览策略**：可以先显示缩略图 URL（如果提供了），同时后台下载原图
3. **缓存检查**：加载前先检查是否已缓存到本地
4. **URL 去重**：根据 URL 判断是否本地已存在，避免重复下载

#### 3.5.7 数据流总结

```
用户浏览 Provider 插件视图
    ↓
Provider 返回 RemoteFile（包含 URL）
    ↓
前端检查是否已缓存到本地
    ↓
如果已缓存 → 使用本地路径显示
    ↓
如果未缓存 → 通过 download_image worker 下载
    ↓
下载完成后 → 保存到画廊（如果用户点击下载按钮）
    ↓
显示图片（使用缓存或预览 URL）
```

#### 3.5.8 实现注意事项

1. **并发控制**：通过 `download_image` worker 的并发控制，避免对服务器造成压力
2. **缓存管理**：缓存文件需要定期清理，避免占用过多磁盘空间
3. **错误处理**：下载失败时需要显示错误状态，允许用户重试
4. **进度显示**：下载过程中可以显示进度（可选）
5. **URL 规范化**：需要对 URL 进行规范化处理，确保去重正确

```typescript
// packages/core/src/composables/useImageUrlLoader.ts

const loadSingleImageUrl = async (
  image: TImage,
  preferOriginal: boolean
) => {
  // ... 现有代码 ...
  
  if (image.sourceType === 'remote' || image.sourceType === 'cached') {
    // 远程图片：通过 download_image worker 加载
    // 1. 检查是否已缓存到本地
    const cached = await invoke<{ localPath?: string; cached: boolean }>(
      'check_remote_image_cache',
      { url: image.url || image.originalUrl }
    );
    
    if (cached.localPath) {
      // 已缓存，使用本地路径
      const thumbnailUrl = toAssetUrl(cached.localPath);
      const originalUrl = toAssetUrl(cached.localPath);
      
      imageSrcMap.value[image.id] = {
        thumbnail: thumbnailUrl,
        original: originalUrl,
      };
      return;
    }
    
    // 2. 未缓存，通过 download_image worker 下载
    // 使用缩略图 URL（如果提供了）进行预览，同时下载原图
    const previewUrl = image.thumbnailUrl || image.originalUrl || image.url || '';
    
    if (previewUrl) {
      // 先显示预览（直接使用 URL，不通过 worker）
      imageSrcMap.value[image.id] = {
        thumbnail: previewUrl,
        original: previewUrl,
      };
      
      // 后台通过 worker 下载原图
      await invoke('load_remote_image_via_worker', {
        imageId: image.id,
        url: image.url,
        originalUrl: image.originalUrl,
        thumbnailUrl: image.thumbnailUrl,
      });
    }
  }
};
```

## 4. 使用场景

### 4.1 Provider 插件场景

- **自定义分类视图**：按标签、按作者、按来源等组织图片
- **外部数据源集成**：从 HTTP API、数据库等获取数据
- **复杂查询视图**：多条件组合查询
- **数据转换视图**：格式化、过滤、排序等

### 4.2 远程 URL 场景

- **预览模式**：浏览远程图片，只下载需要的
- **外部 API**：直接显示外部服务的图片
- **混合视图**：本地和远程图片混合显示
- **缓存优化**：已下载的图片使用本地缓存

## 5. Provider 插件示例

### 示例 1：按标签组织

```rhai
// provider.rhai - 按标签组织图片

fn list(storage) {
    let tags = storage.get_all_tags();
    let entries = [];
    for tag in tags {
        entries.push(provider_entry_directory(tag));
    }
    entries
}

fn get_child(storage, name) {
    let query = image_query_by_metadata("tag", name);
    provider_common(query)
}
```

### 示例 2：HTTP API 数据源（支持远程 URL）

```rhai
// provider.rhai - 从 HTTP API 获取数据

fn list(storage) {
    let api_url = config.api_url;
    let response = http_get(api_url + "/images");
    let images = response.json();
    
    let entries = [];
    for img in images {
        // 创建远程文件条目
        // Provider 可以可选地提供缩略图或原图 URL
        entries.push(provider_entry_remote_file(
            img.filename,
            img.id,
            img.url,              // 通用 URL（作为后备）
            img.thumbnail_url,      // 可选：缩略图 URL
            img.original_url,      // 可选：原图 URL
            null,                  // 无缓存
            img.metadata
        ));
    }
    
    entries
}
```

**说明**：
- Provider 可以提供 `thumbnail_url` 和 `original_url` 中的任意一个或两个
- 如果只提供了缩略图 URL，画廊会使用它作为原图（在需要原图时）
- 如果只提供了原图 URL，画廊会使用它作为缩略图（在网格视图中）
- 如果两个都缺失，则使用通用的 `url`

### 示例 3：混合视图（本地 + 远程）

```rhai
// provider.rhai - 混合本地和远程图片

fn list(storage) {
    let entries = [];
    
    // 本地图片
    let local_images = storage.get_images_by_query(image_query_all());
    for img in local_images {
        entries.push(provider_entry_file(
            img.filename,
            img.id,
            img.path
        ));
    }
    
    // 远程图片
    let remote_images = fetch_remote_images();
    for img in remote_images {
        entries.push(provider_entry_remote_file(
            img.filename,
            img.id,
            img.url,
            null,
            img.metadata
        ));
    }
    
    entries
}
```

## 6. 扩展 ProviderDescriptor

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderDescriptor {
    // ... 现有类型 ...
    
    // 新增：插件 Provider
    Plugin {
        plugin_id: String,
        path: Vec<String>,
        config: Option<HashMap<String, serde_json::Value>>,
    },
}
```

## 7. 在 RootProvider 中集成

```rust
impl Provider for RootProvider {
    fn list(&self, storage: &Storage) -> Result<Vec<FsEntry>, String> {
        let mut entries = vec![
            FsEntry::dir("全部"),
            FsEntry::dir("画册"),
            // ...
        ];
        
        // 添加插件 Provider
        let plugin_manager = get_plugin_manager();
        for plugin in plugin_manager.list_plugins() {
            if plugin.has_provider_script() {
                entries.push(FsEntry::dir(format!("插件:{}", plugin.name)));
            }
        }
        
        Ok(entries)
    }
}
```

## 8. 画廊集成

### 8.1 画廊浏览 Provider 插件视图

Provider 插件提供的视图可以无缝集成到画廊中，用户可以通过画廊浏览插件定义的自定义视图。

#### 8.1.1 路径显示

在画廊的路径导航中，插件 Provider 显示为：

```
画廊 > 插件:我的标签视图 > 标签A > 图片列表
```

#### 8.1.2 浏览流程

```typescript
// apps/main/src/views/Gallery.vue

// 1. 用户选择插件 Provider 路径
const providerPath = "插件:我的标签视图/标签A";

// 2. 调用后端 API 浏览 Provider
const result = await invoke('gallery_browse_provider', {
  path: providerPath
});

// 3. 显示结果（目录或图片列表）
if (result.entries) {
  // 处理目录和文件条目
  for (const entry of result.entries) {
    if (entry.type === 'directory') {
      // 显示目录，可以继续导航
    } else if (entry.type === 'file') {
      // 显示本地图片
    } else if (entry.type === 'remoteFile') {
      // 显示远程图片
    }
  }
}
```

#### 8.1.3 与现有画廊系统集成

- **路径导航**：插件 Provider 路径可以像普通路径一样导航
- **分页支持**：插件 Provider 可以返回分页数据
- **搜索过滤**：可以在插件 Provider 视图中搜索和过滤
- **虚拟滚动**：支持大量数据的虚拟滚动
- **统一体验**：插件 Provider 视图与系统 Provider 视图体验一致

#### 8.1.4 实现要点

```typescript
// apps/main/src/composables/useGalleryProvider.ts

export function useGalleryProvider() {
  const providerPath = ref<string>('');
  const displayedImages = ref<ImageInfo[]>([]);
  
  // 浏览 Provider 路径
  const browseProvider = async (path: string) => {
    providerPath.value = path;
    
    // 调用后端 API
    const result = await invoke<GalleryBrowseResult>('gallery_browse_provider', {
      path: path
    });
    
    // 转换条目为 ImageInfo
    const images: ImageInfo[] = result.entries
      .filter(e => e.type === 'file' || e.type === 'remoteFile')
      .map(e => {
        if (e.type === 'file') {
          return {
            id: e.imageId,
            localPath: e.resolvedPath,
            sourceType: 'local' as const,
            // ... 其他字段
          };
        } else {
          return {
            id: e.remoteId,
            url: e.url,
            localPath: e.cachedPath,
            sourceType: e.cachedPath ? 'cached' as const : 'remote' as const,
            // ... 其他字段
          };
        }
      });
    
    displayedImages.value = images;
    
    // 加载图片 URL（需要支持混合来源）
    // 这里会调用修改后的 useImageUrlLoader
    return images;
  };
  
  return {
    providerPath,
    displayedImages,
    browseProvider,
  };
}
```

### 8.2 需要修改 load_image_url 函数

现有的 `useImageUrlLoader` 函数需要修改以支持远程 URL 和混合来源。

#### 8.2.1 当前实现问题

```typescript
// packages/core/src/composables/useImageUrlLoader.ts

// 当前只支持本地图片
export function useImageUrlLoader<TImage extends Pick<ImageInfo, "id" | "localPath" | "thumbnailPath">>(
  params: UseImageUrlLoaderParams<TImage>
) {
  // 只处理 localPath 和 thumbnailPath
  // 不支持远程 URL
}
```

#### 8.2.2 需要修改的内容

**1. 扩展类型定义**

```typescript
// 扩展 ImageInfo 类型
export type ImageInfo = {
  id: string;
  localPath?: string;
  thumbnailPath?: string;
  url?: string;  // 新增：远程 URL（通用 URL，作为后备）
  thumbnailUrl?: string;  // 新增：缩略图 URL（可选，Provider 可以提供）
  originalUrl?: string;  // 新增：原图 URL（可选，Provider 可以提供）
  sourceType?: 'local' | 'remote' | 'cached';  // 新增：来源类型
  // ... 其他字段
};

// 扩展 useImageUrlLoader 参数类型
export type UseImageUrlLoaderParams<
  TImage extends Pick<ImageInfo, "id" | "localPath" | "thumbnailPath" | "url" | "thumbnailUrl" | "originalUrl" | "sourceType">
> = {
  // ... 现有参数
  imagesRef: Ref<TImage[]>;
};
```

**重要说明**：Provider 可以可选地提供 `thumbnailUrl` 和 `originalUrl`，画廊会自动补充缺失的 URL，与现有本地图片的逻辑一致。

**2. 修改 URL 加载逻辑**

```typescript
export function useImageUrlLoader<TImage extends Pick<ImageInfo, "id" | "localPath" | "thumbnailPath" | "url" | "sourceType">>(
  params: UseImageUrlLoaderParams<TImage>
) {
  // ... 现有代码 ...
  
  const loadImageUrl = async (image: TImage) => {
    // 检查图片是否已存在 URL
    if (imageSrcMap.value[image.id]?.thumbnail && imageSrcMap.value[image.id]?.original) {
      return; // 已有 URL，跳过
    }
    
    // 根据来源类型选择 URL 加载方式
    if (image.sourceType === 'remote' || (image.sourceType === 'cached' && !image.localPath)) {
      // 远程图片：使用 Provider 提供的 URL（可选缩略图/原图）
      // 画廊会自动补充缺失的 URL（与现有本地图片逻辑一致）
      const thumbnailUrl = image.thumbnailUrl || image.originalUrl || image.url || '';
      const originalUrl = image.originalUrl || image.thumbnailUrl || image.url || '';
      
      if (thumbnailUrl || originalUrl) {
        imageSrcMap.value[image.id] = {
          thumbnail: thumbnailUrl,
          original: originalUrl,
        };
        return;
      }
    } else if (image.sourceType === 'cached' && image.localPath) {
      // 有缓存的远程图片：优先使用本地缓存
      // 使用现有的 convertFileSrc 逻辑
      // 如果缩略图缺失，使用原图；如果原图缺失，使用缩略图（与现有逻辑一致）
      const thumbnailPath = image.thumbnailPath || image.localPath;
      const originalPath = image.localPath || image.thumbnailPath;
      const thumbnailUrl = toAssetUrl(thumbnailPath);
      const originalUrl = toAssetUrl(originalPath);
      
      imageSrcMap.value[image.id] = {
        thumbnail: thumbnailUrl,
        original: originalUrl,
      };
    } else if (image.localPath) {
      // 本地图片：使用现有逻辑
      // ... 现有的 convertFileSrc 和 Blob URL 逻辑 ...
    }
  };
  
  // ... 其他代码 ...
}
```

**3. 处理远程图片加载状态**

```typescript
// 添加加载状态管理
const remoteImageLoadingStates = ref<Record<string, boolean>>({});
const remoteImageErrors = ref<Record<string, string>>({});

const loadRemoteImage = async (image: TImage) => {
  if (!image.url) return;
  
  remoteImageLoadingStates.value[image.id] = true;
  remoteImageErrors.value[image.id] = '';
  
  try {
    // 验证 URL 是否可访问（可选）
    const response = await fetch(image.url, { method: 'HEAD' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    // 设置 URL（使用 Provider 提供的 URL，自动补充缺失的）
    const thumbnailUrl = image.thumbnailUrl || image.originalUrl || image.url || '';
    const originalUrl = image.originalUrl || image.thumbnailUrl || image.url || '';
    
    imageSrcMap.value[image.id] = {
      thumbnail: thumbnailUrl,
      original: originalUrl,
    };
  } catch (error) {
    remoteImageErrors.value[image.id] = error.message;
    // 显示错误占位图
    imageSrcMap.value[image.id] = {
      thumbnail: '/static/lost.png',
      original: '/static/lost.png',
    };
  } finally {
    remoteImageLoadingStates.value[image.id] = false;
  }
};
```

**4. 支持混合来源的图片列表**

```typescript
// 在画廊中，图片列表可能包含本地和远程图片
const images: ImageInfo[] = [
  { id: '1', localPath: '/path/to/local.jpg', sourceType: 'local' },
  { id: '2', url: 'https://example.com/remote.jpg', sourceType: 'remote' },
  { id: '3', url: 'https://example.com/cached.jpg', localPath: '/cache/cached.jpg', sourceType: 'cached' },
];

// loadImageUrls 需要处理所有类型
const loadImageUrls = async (images: TImage[]) => {
  for (const image of images) {
    if (image.sourceType === 'remote' || image.sourceType === 'cached') {
      await loadRemoteImage(image);
    } else {
      await loadLocalImage(image);  // 现有逻辑
    }
  }
};
```

**5. 修改 loadSingleImageUrl 函数**

```typescript
// packages/core/src/composables/useImageUrlLoader.ts

const loadSingleImageUrl = async (
  image: TImage,
  preferOriginal: boolean
) => {
  // 检查是否已加载
  if (imageSrcMap.value[image.id]?.thumbnail) {
    return;
  }
  
  // 根据来源类型选择加载方式
  if (image.sourceType === 'remote') {
    // 远程图片：使用 Provider 提供的 URL（可选缩略图/原图）
    // 画廊会自动补充缺失的 URL（与现有本地图片逻辑一致）
    const thumbnailUrl = image.thumbnailUrl || image.originalUrl || image.url || '';
    const originalUrl = image.originalUrl || image.thumbnailUrl || image.url || '';
    
    if (thumbnailUrl || originalUrl) {
      imageSrcMap.value[image.id] = {
        thumbnail: thumbnailUrl,
        original: originalUrl,
      };
      return;
    }
  } else if (image.sourceType === 'cached' && image.localPath) {
    // 有缓存的远程图片：使用本地缓存
    // 使用现有的 convertFileSrc 逻辑
    const thumbnailPath = image.thumbnailPath || image.localPath;
    const thumbnailUrl = toAssetUrl(thumbnailPath);
    const originalUrl = toAssetUrl(image.localPath);
    
    imageSrcMap.value[image.id] = {
      thumbnail: thumbnailUrl,
      original: originalUrl,
    };
    return;
  } else if (image.localPath) {
    // 本地图片：使用现有逻辑
    // ... 现有的 readFile -> Blob URL 逻辑 ...
  }
};
```

#### 8.2.3 前端组件修改

```vue
<!-- packages/core/src/components/image/ImageItem.vue -->

<template>
  <div class="image-item" :class="{ 'remote-image': isRemote }">
    <!-- 图片 -->
    <img
      v-if="imageUrl"
      :src="imageUrl"
      :alt="image.name"
      @error="handleImageError"
      @load="handleImageLoad"
      :class="{ 'loading': isLoading }"
    />
    
    <!-- 加载状态 -->
    <div v-if="isLoading" class="loading-overlay">
      <el-icon class="is-loading"><Loading /></el-icon>
    </div>
    
    <!-- 远程图片标识 -->
    <div v-if="isRemote && !isDownloaded" class="remote-badge">
      <el-icon><CloudDownload /></el-icon>
    </div>
    
    <!-- 错误状态 -->
    <div v-if="hasError" class="error-overlay">
      <el-icon><Warning /></el-icon>
      <span>加载失败</span>
    </div>
    
    <!-- 下载按钮（远程图片） -->
    <el-button
      v-if="isRemote && !isDownloaded"
      class="download-btn"
      @click="downloadImage"
      size="small"
      circle>
      <el-icon><Download /></el-icon>
    </el-button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  image: ImageInfo;
  imageUrl?: { thumbnail?: string; original?: string };
}>();

const isLoading = computed(() => 
  props.image.sourceType === 'remote' && 
  !props.imageUrl?.thumbnail
);

const isRemote = computed(() => 
  props.image.sourceType === 'remote' || 
  props.image.sourceType === 'cached'
);

const isDownloaded = computed(() => 
  props.image.localPath != null
);

const downloadImage = async () => {
  // 调用后端下载远程图片
  await invoke('download_remote_image', {
    imageId: props.image.id,
    url: props.image.url,
  });
};
</script>
```

### 8.3 画廊路径导航增强

```typescript
// apps/main/src/composables/useGalleryNavigation.ts

// 支持插件 Provider 路径导航
const navigateToProvider = async (providerPath: string) => {
  // 更新当前路径
  currentPath.value = providerPath;
  
  // 浏览 Provider
  const result = await invoke('gallery_browse_provider', {
    path: providerPath
  });
  
  // 更新图片列表
  if (result.entries) {
    const images = result.entries
      .filter(e => e.type === 'file' || e.type === 'remoteFile')
      .map(e => convertToImageInfo(e));
    
    displayedImages.value = images;
    
    // 加载图片 URL（支持混合来源）
    await loadImageUrls(images);
  }
};
```

## 9. 关键修改点总结

### 9.1 后端修改

1. **FsEntry 扩展**：添加 `RemoteFile` 类型
2. **ImageInfo 扩展**：添加 `source_type` 和 `url` 字段
3. **Provider trait**：支持返回远程文件条目
4. **PluginProvider**：实现插件 Provider 支持

### 9.2 前端修改

1. **useImageUrlLoader**：
   - 扩展类型定义支持 `url` 和 `sourceType`
   - 修改 `loadSingleImageUrl` 函数支持远程 URL
   - 添加远程图片加载状态管理
   - 支持混合来源的图片列表

2. **ImageItem 组件**：
   - 显示远程图片标识
   - 添加加载状态显示
   - 添加下载按钮（远程图片）
   - 错误处理

3. **Gallery 视图**：
   - 支持浏览 Provider 插件路径
   - 路径导航支持插件 Provider
   - 图片列表支持混合来源

### 9.3 数据流

```
Provider 插件
    ↓
返回 FsEntry (File / RemoteFile)
    ↓
转换为 ImageInfo (sourceType: local / remote / cached)
    ↓
前端 useImageUrlLoader
    ↓
根据 sourceType 选择 URL 加载方式
    ↓
显示图片（本地 / 远程 / 缓存）
```

## 10. 实现优先级

### 阶段一：远程 URL 支持
1. 扩展 FsEntry 支持 RemoteFile
2. 扩展 ImageInfo 支持 source_type 和 url
3. **修改 useImageUrlLoader 支持远程 URL**
4. 前端组件支持远程图片显示
5. 按需下载机制

### 阶段二：Provider 插件基础
1. PluginProvider 实现
2. Provider Rhai API
3. ProviderDescriptor 扩展
4. RootProvider 集成
5. **画廊集成 Provider 插件视图**

### 阶段三：Provider DSL
1. Rhai DSL 支持
2. JSON DSL 支持（可选）
3. Provider 脚本执行引擎
4. 错误处理和调试

### 阶段四：高级功能
1. 混合视图支持
2. 缓存管理
3. 性能优化
4. 文档和示例

## 11. 优势总结

### 9.1 Provider 插件优势

- **可扩展性**：插件作者可以自定义数据视图
- **灵活性**：支持多种数据源和组合
- **统一接口**：插件 Provider 与系统 Provider 一致
- **易于使用**：DSL 简单，学习成本低
- **复用现有系统**：可以组合使用现有 Provider

### 9.2 远程 URL 优势

- **预览模式**：可以浏览远程图片，无需下载
- **按需下载**：用户可以选择预览远程图片，按需下载
- **外部数据源**：可以直接显示外部服务的图片
- **混合视图**：本地和远程图片可以混合显示
- **节省空间**：不下载不需要的图片

## 10. 注意事项

### 10.1 安全性

- 远程 URL 需要验证和过滤
- 防止 XSS 攻击
- 限制可访问的域名

### 10.2 性能

- 大量远程图片需要懒加载
- 图片加载失败的处理
- 缓存策略优化

### 10.3 用户体验

- 加载状态显示
- 占位图
- 重试机制
- 下载进度显示

---

**文档版本**：v1.0  
**创建日期**：2025-01-15  
**最后更新**：2025-01-15
