# 插件文档资源（`kbDocAssets`）与快捷预览走马灯

本文档描述插件文档配图的**声明、打包、加载、展示**全链路：`package.json` 的 `kbDocAssets`
白名单如何取代旧的「正则扫 Markdown 自动收集」，资源键的归一化契约，以及这些图片除了渲染
在文档正文里之外，还被「源」页面的 hover 快捷预览当作走马灯示例图使用。

---

## 1. 为什么要白名单

改造前，文档配图是**打包期与加载期各跑一遍正则**（`extract_doc_local_refs` 扫
`![](x)` 与 `<img src=x>`）自动收集的。两个后果：

1. **声明权在正则手里**：插件作者无法表达「这个文档要带哪些资源」，漏引用、多引用都只能
   到运行时打开文档才发现图裂了。
2. **键的语义没有唯一裁决者**：加载器把 md 里的 `![](./b-posts.png)` 改写成
   `![](doc_root/b-posts.png)` 并以 `doc_root/b-posts.png` 作 `docResources` 的键，
   前端查表前却把 `doc_root/` 前缀剥掉 —— 两边永远对不上，**所有插件文档的图片实际都
   渲染成「图片加载失败」**。

`kbDocAssets` 解决前者：显式白名单 + 打包期交叉校验，把「运行时才发现图裂」提前成
「打包就打不出来」。归一化契约解决后者。

---

## 2. `kbDocAssets` 字段

`package.json` 里与 `kbDoc` **并列**、职责不重叠：`kbDoc` 管 locale → md 入口映射，
`kbDocAssets` 只管资源清单。

```json
"kbDoc": {
  "default": "doc_root/doc.md",
  "en": "doc_root/doc.en.md"
},
"kbDocAssets": {
  "./images/home.png": "doc_root/images/home.png",
  "./images/cookie.png": "doc_root/images/cookie.png"
}
```

- **键**：md 里**字面写的那串引用**（约定带 `./`，便于人肉 diff 对照）。归一化后比较，
  所以 `"./a.png"` 与 `"a.png"` 等价。
- **值**：插件根相对的包内路径，过 `validate_kb_rel_path`（禁绝对路径、盘符、`..`）。
- **未声明该字段的旧包**：加载器与打包器都回退到 md 正则扫描，行为不变（打包时给 WARN）。
  **不要给没有配图的插件写 `kbDocAssets: {}`** —— 空对象等于「显式声明零资源」，
  会让交叉校验对它生效却无物可校；字段缺失才是合法的「未迁移」态。

---

## 3. 归一化契约（唯一裁决者）

**键就是 md 里字面写的那串，经一次归一化后比较。** 规则按序：

1. `trim`
2. 剥 markdown 标题后缀（`a.png "标题"` / `'标题'` / `(标题)`）
3. 截断 `#fragment` 与 `?query`
4. `\` → `/`
5. 百分号解码（失败则保留原串，不做逐字符兜底替换）
6. `http://` `https://` `data:` `//` 开头 → 判为外链，返回「非本地资源」
7. 去掉所有前导 `/`
8. 按 `/` 分段：丢弃空段与 `.`；`..` 弹栈，但**栈为空或栈顶已是字面 `..` 时保留 `..`**
   （否则 `../../a.png` 会被折成 `a.png`，等于让 `..` 逃逸）
9. 拼回；为空则视为非法

**刻意不做的两件事**：不 strip `doc_root/` 前缀（那正是历史 bug 的根因，
`doc_root/a.png` 与 `./a.png` 是两个不同的键）；不做大小写归一（ZIP 条目名大小写敏感）。

### 两份同构实现

| 侧 | 文件 | 用途 |
|---|---|---|
| Rust | `src-tauri/kabegame-core/src/plugin/doc_assets.rs::normalize_doc_asset_key` | 打包校验、加载建表 |
| TS | `packages/kabegame-core/src/utils/docAssetKey.ts::normalizeDocAssetKey` | 文档渲染时查表、判外链 |

改规则必须同时改两处，顺序也要一致。两边漂移只影响「这张图找不找得到」，
不涉及安全边界 —— 包内路径合法性由 `validate_kb_rel_path` 在打包期与加载期各把一次。
Rust 侧的用例表（`doc_assets.rs` 的 `#[test] normalize_doc_asset_key_follows_shared_rules`）
是规则的可执行说明书。

---

## 4. 全链路

```
package.json (kbDocAssets)
    │
    ├─ 打包 kabegame-cli plugin pack
    │     pack_plugin_v3()：键归一化 + 归一化后冲突检测 + 值存在性/扩展名/2MB 硬上限
    │                       + 交叉校验（md 引用了但未注册 → 硬报错，附建议 JSON 片段；
    │                         注册但未引用 → WARN；总量超 10MB → WARN）
    │     collect_v3_entries()：有 kbDocAssets 则直接按 values 收；否则走旧的自动扫描分支
    │
    ├─ 加载 parse_kgpg → load_plugin_v3_from_zip
    │     build_doc_asset_index(pkg, read_doc_md)  ← 新老两条路径在这里收敛成同一张
    │                                                「归一化键 → 包内路径」的表
    │     按表读字节 → base64 → Plugin.doc_resources（键为归一化键）
    │     md 推**原文**，不再改写引用；条目缺失只 WARN 跳过，不再让整个插件装不上
    │
    └─ 展示
          ├─ 文档正文：PluginDocRenderer.vue 用 normalizeDocAssetKey(引用) 查 docResources
          │            外链归一化返回 null → 原样交给 marked（不再误判成「加载失败」）
          └─ 快捷预览走马灯：见第 5 节
```

### 限额

| 常量 | 值 | 位置 |
|---|---|---|
| `DOC_ASSET_MAX_FILE_SIZE` | 2 MB | 打包期**硬报错**（白名单路径）/ 回退路径 WARN 跳过 / 加载期 WARN 跳过 |
| `DOC_ASSET_MAX_TOTAL_SIZE` | 10 MB | 打包期 WARN / 加载期超出部分不内嵌 |

均定义在 `doc_assets.rs`，CLI 与 core 共用，不再各自写死。

> **注意**：`plugins/miyoushe/doc_root/preview.png` 为 2,031,100 B，距 2 MiB 硬上限仅
> 约 64 KB。改造后单文件超限是**打包硬失败**（旧行为是 WARN 跳过），这张图不能再变大。

---

## 5. 快捷预览走马灯

「源」页面（`PluginBrowser.vue`）的插件卡片支持快捷预览：桌面 hover 400ms 后在卡片旁弹出
320px 悬浮面板，紧凑端长按 500ms 弹出同一面板的底部抽屉形态。面板里的**示例图走马灯直接
复用 `Plugin.docResources`** —— 不额外增加任何后端接口或资源。

| 关注点 | 处理 |
|---|---|
| 顺序 | `Object.keys(docResources).sort()`，与 PathQL provider `plugin://{id}/doc_resource` 的 list 排序口径一致（字典序，非作者声明序） |
| 图注 | 插件没有提供图注元数据，用 `humanizeDocAssetLabel(key)` 从文件名推导（去目录与扩展名、`-`/`_` 转空格），不编造内容 |
| MIME | `guessDocAssetMime(key)`，与 Rust `mime_for_doc_asset` 及打包白名单口径一致 |
| **只对已安装插件出图** | 商店里未安装的条目**不出图**，显示「安装后可查看示例图」。原因见下 |

### 为什么未安装条目不出图

唯一能拿到远程插件 `docResources` 的接口 `get_plugin_detail(source_id)` 内部会调用
`ensure_plugin_cached`，把**整个 .kgpg 下载到本地磁盘缓存**（可能几 MB）。hover 是高频
轻量交互，鼠标划过卡片列表就会触发一串后台整包下载，产生非预期流量。因此快捷预览只做
best-effort：

- 本身就是已安装插件 → 直接用内存里的 `docResources`（零成本）
- 商店条目且 `installedVersion === version` → 同一份内容，复用本地已装包
- 其余 → 空态「安装后可查看示例图」

真要看图，点进详情弹窗（那里本就要拉完整包，是用户的显式动作）。

### 涉及文件

| 层 | 文件 |
|---|---|
| 走马灯 | `packages/kabegame-core/src/components/plugin/PluginQuickPreviewCarousel.vue` |
| 悬浮面板 | `packages/kabegame-core/src/components/plugin/PluginQuickPreviewPanel.vue` |
| 交互（hover 延迟/长按/定位翻转） | `packages/kabegame-core/src/composables/usePluginQuickPreview.ts` |
| 接入 | `apps/kabegame/src/views/PluginBrowser.vue` |

> `usePluginQuickPreview` 的 `cardListeners(item)` 供 `v-on="..."` 使用，
> 返回的**键是事件名本身**（`mouseenter`），不带 `on` 前缀 —— 对象语法的 `v-on` 会把
> `onMouseenter` 当成名为 `onMouseenter` 的事件，永远不触发。

---

## 6. 插件详情：弹窗，非路由

插件/源详情原本是独立路由 `/plugin-detail/:id`（`PluginDetail.vue` + 三个 URL query
镜像设置键）。现已改为**弹窗**，与导入预览弹窗（`PluginImportDialog.vue`）形态一致：

- `apps/kabegame/src/components/plugin/PluginDetailDialog.vue` —— 弹窗外壳 + 安装/更新/
  卸载/复制 ID 等动作，自行订阅 `plugin-store-download-progress` 显示下载进度
- `apps/kabegame/src/composables/usePluginDetailLoader.ts` —— 详情加载与缓存
  （已安装内存直读 → 内存缓存 → web 侧 Dexie 版本校验 → `get_plugin_detail`）
- 两者都复用 `PluginDetailContent.vue`，与导入预览共享同一套详情渲染

随之删除：`/plugin-detail` 路由与 `PluginDetail.vue`、settings 的
`pluginDetailMode` / `pluginDetailSourceId` / `pluginDetailVersion` 三个 query 镜像键
及其 codec、`route.pluginDetail` i18n 键、`useActiveRoute` 里对该路径前缀的匹配。

---

## 7. 涉及代码文件

| 层级 | 文件 | 作用 |
|---|---|---|
| 归一化 / 建表 / 常量 | `src-tauri/kabegame-core/src/plugin/doc_assets.rs` | `normalize_doc_asset_key`、`build_doc_asset_index`、`mime_for_doc_asset`、两个限额常量 |
| 加载 | `src-tauri/kabegame-core/src/plugin/mod.rs` | `load_plugin_v3_from_zip` 的 doc 段；`Plugin.doc_resources` |
| 打包 | `src-tauri/kabegame-cli/src/main.rs` | `pack_plugin_v3` 校验 + `collect_v3_entries` 收集 + `.kabegameignore` 关键文件保护 |
| PathQL | `src-tauri/kabegame-core/src/providers/programmatic/plugin_resource.rs` | `plugin://{id}/doc_resource/{key}`，MIME 复用 `mime_for_doc_asset` |
| MCP | `src-tauri/kabegame/src/mcp_server.rs` | 资源说明文案（键语义） |
| 前端归一化 | `packages/kabegame-core/src/utils/docAssetKey.ts` | `normalizeDocAssetKey`、`guessDocAssetMime`、`humanizeDocAssetLabel` |
| 文档渲染 | `packages/kabegame-core/src/components/plugin/PluginDocRenderer.vue` | 查 `docResources` 内联 base64 图片 |

格式规范另见 `docs/PLUGIN_FORMAT.md`、`apps/docs/src/content/docs/dev/format.mdx`、
`.../dev/packaging.md`、`.../reference/plugin-schema.mdx`。
