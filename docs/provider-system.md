# Provider 系统设计

## 原则

- **Provider 是纯路径解析服务**：`path → Provider | Image`，不感知「画廊」或「虚拟盘」等上层产品概念。
- **`list_entries()`**：返回带已构建子 `Provider` 的 `Child`，或 `ImageEntry`；`get_child()` 仅用于无法由列表覆盖的动态子节点（LRU 缓存）。
- **写操作在父节点语义上**：`add_child` / `rename_child` / `can_delete_child` / `delete_child`。
- **`ProviderConfig`**：`locale` + `pagination_mode` 从父向子继承；VD 下 `locale` 控制目录显示名（与 `kabegame-i18n` 的 `vd.*` 一致）。
- **动态子节点**：`list_entries()` 无法穷举的（如日期范围、分页页码）走 `get_child()` + LRU；其余应尽量由 `list_entries()` 列出并写入 sled 缓存。

## 树形结构（概念）

```text
UnifiedRoot
├── gallery → MainRootProvider (gallery_default / SimplePage)
└── vd → VdRootProvider
         └── {locale} → MainRootProvider (vd_with_locale / Greedy)
                → Group / All / Range / DateScoped / …
```

## 扩展方式

1. 实现 `Provider` trait（`descriptor` / `list_entries` / 按需 `get_child` / 写操作）。
2. 在 `ProviderDescriptor` 中增加变体（若需持久化缓存）。
3. 在 `ProviderFactory::build()` 中注册 descriptor → 构造。
4. 在某一父节点的 `list_entries()` 中返回 `ListEntry::Child { name, provider }` 挂载到树上。

## 缓存

- **静态（sled）**：`list_entries()` 得到的子节点描述符可持久化；`Child` 直接带 `provider` 时写入子 key。
- **动态（LRU）**：仅 `get_child()` 解析的节点进入 LRU，避免污染持久缓存。

## i18n

- VD 目录显示名由 `ProviderConfig::display_name(canonical)` 提供，数据来自 **`kabegame-i18n`** 的 `vd.*` 键（与 YAML 中 `vd.all`、`vd.album` 等对应）。
- Explorer 通知路径（Windows `SHChangeNotify`）须使用当前 UI 语言对应的显示名，与 `VfsSemantics` 使用的 `vd/{locale}` 段一致。

## 虚拟盘相关类型归属

- **`ResolveResult`**（目录 / 文件 / 未找到）：仅用于 `virtual_driver::semantics`，不属于 `Provider` 核心 trait。
- **删除两阶段（Check / Commit）**：由 Dokan/FUSE 处理流程与 `delete_on_close` 维护；语义层提供 `can_delete_child_at` 与 `commit_delete_child_at`，不再使用已删除的 `DeleteChildMode` 类型。
