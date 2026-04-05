# Provider System 设计说明

## 目标

Provider 负责“路径解析与内容枚举”，不负责平台挂载细节。  
虚拟盘（VD）与画廊（Gallery）共享同一棵 Provider 树，仅在分页模式和目录本地化上有差异。

## 核心原则

- Provider 是纯逻辑层，不依赖 Dokan/FUSE。
- 路径入口统一走 `ProviderRuntime::resolve(path)`。
- 列表返回 `ListEntry`：
  - `Child { name, provider }`：子节点与其 provider
  - `Image(ImageEntry)`：图片条目（含 `local_path`）
- `get_child(name)` 仅用于动态子节点（如页码、日期范围等无法穷举项）。
- 写操作在父节点上执行：
  - `add_child`
  - `rename_child`
  - `delete_child_v2`

## 架构总览

```text
ProviderRuntime (global singleton)
  └─ UnifiedRootProvider
     ├─ gallery -> MainRootProvider(config: locale=None, mode=SimplePage)
     └─ vd
        └─ {locale} -> MainRootProvider(config: locale=Some(locale), mode=Greedy)
```

## ProviderConfig

`ProviderConfig` 在 provider 树中向下传递：

- `locale: Option<&'static str>`
  - `None`：canonical 名称（用于 Gallery）
  - `Some(locale)`：本地化名称（用于 VD）
- `pagination_mode: PaginationMode`
  - `SimplePage`：简单分页
  - `Greedy`：贪心区间目录

通过 `display_name()` 与 `canonical_name()` 实现目录名翻译与反查。

## Descriptor 与缓存

`ProviderDescriptor` 用于缓存重建 provider。当前核心变体：

- `UnifiedRoot`
- `GalleryRoot`
- `VdRoot`
- `Group { kind }`
- `All { query }`
- `Range { query, offset, count, depth }`
- `DateScoped { query, tier }`
- `SimpleAll { query }`
- `SimplePage { query, page }`

`ProviderRuntime` 缓存策略：

- `list_entries()` 产出的 `Child`：持久缓存（sled）+ 运行时 LRU
- `get_child()` 动态命中：仅 LRU

## Consumer 侧约定

- Gallery browse：
  - 调 `resolve("gallery/...")`
  - 依据 descriptor + storage 查询返回 browse 结果
- VD 语义层：
  - 调 `resolve("vd/{locale}/...")`
  - `read_dir` 基于 `list_entries()`
  - 文件打开基于 `ListEntry::Image.local_path`
  - `get_note()` 注入说明文件

## 扩展 Provider 的标准流程

1. 实现 `Provider` trait（至少 `descriptor/list/get_child`）。
2. 若有写能力，实现 `add_child/rename_child/delete_child_v2`。
3. 在 `ProviderDescriptor` 增加必要变体（若已有可复用则不新增）。
4. 在 `ProviderFactory::build` 注册重建逻辑。
5. 挂到 `UnifiedRoot -> MainRoot` 的合适分支。

## 平台说明

- 支持平台：Android、Windows、macOS、Linux
- iOS：不支持
