# 虚拟盘访问画册流程图

## 完整流程

```mermaid
graph TB
    Start[用户在文件浏览器打开<br/>K:\画册\收藏] --> Dokan[Dokan 驱动捕获<br/>文件系统操作]
    
    Dokan --> FindFiles{操作类型}
    Dokan --> CreateFile{操作类型}
    Dokan --> ReadFile{操作类型}
    
    %% FindFiles 流程（列出目录内容）
    FindFiles -->|FindFiles| ParsePath1[解析路径段<br/>K:\ → 画册 → 收藏]
    ParsePath1 --> Resolve1[resolve_cached<br/>路径解析]
    Resolve1 --> ProviderChain1[Provider 链解析<br/>Root → Albums → Album]
    ProviderChain1 --> GetProvider1[获取 AlbumProvider]
    GetProvider1 --> List1[调用 provider.list<br/>AlbumProvider.list]
    List1 --> Delegate1[委托给 CommonProvider.list]
    Delegate1 --> Query1[构建 ImageQuery<br/>by_album album_id]
    Query1 --> DB1[查询数据库<br/>get_images_count_by_query]
    DB1 --> CheckCount{图片数量}
    CheckCount -->|≤ 1000| DirectList[直接返回图片列表<br/>get_images_fs_entries_by_query]
    CheckCount -->|> 1000| GreedyDecompose[贪心分解<br/>生成范围目录]
    GreedyDecompose --> ReturnEntries1[返回 FsEntry 列表<br/>目录 + 文件]
    DirectList --> ReturnEntries1
    ReturnEntries1 --> Convert1[转换为 FindData<br/>填充文件信息]
    Convert1 --> Return1[返回给 Dokan]
    Return1 --> Explorer1[文件浏览器显示]
    
    %% CreateFile 流程（打开文件/目录）
    CreateFile -->|CreateFile| ParsePath2[解析路径段]
    ParsePath2 --> Resolve2[resolve_cached<br/>判断是目录还是文件]
    Resolve2 --> IsDir{是目录?}
    IsDir -->|是| CreateDir[创建 FsItem::Directory<br/>缓存路径]
    IsDir -->|否| ResolveFile2[resolve_file<br/>解析文件路径]
    ResolveFile2 --> OpenFile[打开文件句柄<br/>File::open]
    OpenFile --> CreateFileItem[创建 FsItem::File<br/>缓存句柄和路径]
    CreateDir --> Return2[返回 CreateFileInfo]
    CreateFileItem --> Return2
    Return2 --> Explorer2[文件浏览器打开]
    
    %% ReadFile 流程（读取文件内容）
    ReadFile -->|ReadFile| GetContext[从 Context 获取<br/>FsItem::File]
    GetContext --> GetHandle[获取缓存的<br/>file_handle]
    GetHandle --> SeekRead[seek_read<br/>按 offset 读取]
    SeekRead --> Return3[返回数据给 Dokan]
    Return3 --> Explorer3[文件浏览器显示图片]
    
    style Start fill:#e1f5ff
    style Dokan fill:#fff4e1
    style DB1 fill:#ffe1f5
    style Return1 fill:#e1ffe1
    style Return2 fill:#e1ffe1
    style Return3 fill:#e1ffe1
```

## 详细步骤说明

### 1. 路径解析阶段（resolve_cached）

```
K:\画册\收藏
  ↓ parse_components
["画册", "收藏"]
  ↓ resolve_provider (递归)
RootProvider
  ↓ get_child("画册")
AlbumsProvider
  ↓ get_child("收藏")
AlbumProvider
  ↓ (内部使用)
CommonProvider (with ImageQuery::by_album)
```

### 2. Provider 链

```
RootProvider (根目录)
  ├─ list() → ["按任务", "画册", "全部", ...]
  └─ get_child("画册") → AlbumsProvider

AlbumsProvider (画册列表)
  ├─ list() → 查询所有画册名称
  └─ get_child("收藏") → AlbumProvider

AlbumProvider (单个画册)
  ├─ list() → 委托给 CommonProvider
  ├─ get_child() → 委托给 CommonProvider (处理范围目录)
  └─ resolve_file() → 委托给 CommonProvider

CommonProvider (通用图片列表)
  ├─ list() → 查询图片列表（支持贪心分解）
  ├─ get_child() → 处理范围目录（如 "1-1000"）
  └─ resolve_file() → 解析单个文件路径
```

### 3. 数据库查询

```sql
-- ImageQuery::by_album 生成的查询
SELECT images.* 
FROM images
INNER JOIN album_images ai ON images.id = ai.image_id
WHERE ai.album_id = ?
ORDER BY images.id DESC
LIMIT ? OFFSET ?
```

### 4. 贪心分解策略

当图片数量 > 1000 时，使用贪心分解：

```
总图片数: 112400

分解结果:
├─ 1-100000/        (10万级目录)
├─ 100001-110000/   (1万级目录)
├─ 110001-111000/   (1千级目录)
├─ 111001-112000/   (1千级目录)
└─ 112001-112400    (剩余 400 个文件直接显示)
```

### 5. 文件读取优化

- **文件句柄缓存**：在 `create_file` 时打开并缓存 `File` 句柄
- **无锁读取**：使用 `FileExt::seek_read(offset)` 直接按偏移量读取
- **支持并发**：不移动文件游标，天然支持碎片读取（Explorer/图片查看器常见）

## 关键代码位置

- **路径解析**: `windows.rs::resolve_cached()` (445-491行)
- **Provider 解析**: `windows.rs::resolve_provider()` (494-510行)
- **画册列表**: `albums.rs::AlbumsProvider` (34-36行)
- **画册内容**: `albums.rs::AlbumProvider` (114-116行)
- **图片查询**: `common.rs::CommonProvider::list()` (61-78行)
- **贪心分解**: `common.rs::list_greedy_subdirs_with_remainder()` (346-379行)
- **文件读取**: `windows.rs::read_file()` (907-927行)
