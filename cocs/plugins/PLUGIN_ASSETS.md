# 插件资源（`kbAssets`）：单一坐标系与快捷预览走马灯

本文档描述插件配图的**声明、打包、加载、展示**全链路：`package.json` 的 `kbAssets`
如何用一份「插件根相对路径」清单同时服务 `kbDoc`（README）与 `kbChangelog`
（更新日志），路径归一化的唯一裁决者是谁，以及其中**归一化路径以 `banner` 开头**的那些
除了渲染在文档正文里之外，还被「源」页面的 hover 快捷预览当作走马灯示例图使用。

---

## 1. 为什么只留一个坐标系

这里踩过两个坑，`kbAssets` 是两次修正的终点。

**第一次：没有声明权。** 最早文档配图是**打包期与加载期各跑一遍正则**扫 md
（`![](x)` 与 `<img src=x>`）自动收集的。插件作者无法表达「这个文档要带哪些资源」，
漏引用、多引用都只能到运行时打开文档才发现图裂了。

**第二次：两个坐标系。** 于是引入白名单 `kbDocAssets`，形态是**对象**：

```json
"kbDocAssets": { "./b-posts.png": "doc_root/b-posts.png" }
```

键是「md 里字面写的引用串」，值是「插件根相对的包内路径」——**两个不同的路径空间**。
后果立刻来了：加载器把 md 里的 `![](./b-posts.png)` 改写成
`![](doc_root/b-posts.png)` 并以 `doc_root/b-posts.png` 作运行时资源表的键，
前端查表前却把 `doc_root/` 前缀剥掉 —— 两边永远对不上，**所有插件文档的图片实际都
渲染成「图片加载失败」**。当时的修法是给键的归一化立一份严格契约，并刻意规定「不 strip
`doc_root/`」，让两个空间各自自洽。

**第三次修正（当前形态）：把两个空间合成一个。** 触发点是资源池要被 `kbDoc` 与
`kbChangelog` **公用** —— 一旦同一张图可能被 README 和 CHANGELOG 分别引用，就必须有一个
公共的相对根来指称它，「按某一份文档的引用串给资源起别名」这件事本身就失去了意义。
回头看，那个对象形态从来没被当别名用过：迁移时仓库里 8 个插件、34 个键值对，
**键去掉 `./` 后无一例外等于值**。它只是同一路径的两种写法。

所以 `kbAssets` 是数组，每项就是插件根相对路径；md 里的引用串经同一个归一化函数后
直接与之比较。键/值两个空间消失，那条「不 strip `doc_root/`」的告诫也随之无从谈起。

同时删掉了「无白名单则回退扫 md」那条兼容路径 —— 插件全部随安装包分发，不存在滞留在
用户磁盘上的旧 `.kgpg` 需要兼容；而当时还没迁移的 10 个插件 README 里**一条本地图片引用
都没有**，回退对它们一直产出空表，从没真正生效。安全网改放在打包器里（见第 4 节）。

---

## 2. `kbAssets` 字段

与 `kbDoc` / `kbChangelog` **并列**、职责不重叠：那两个管 locale → md 入口映射，
`kbAssets` 只管资源清单。

```json
"kbDoc":       { "default": "README.md", "en": "README.en.md" },
"kbChangelog": { "default": "CHANGELOG.md" },
"kbAssets":    ["image.jpg", "images/cookie.png"]
```

- **每项**：插件根相对路径，过归一化后再过 `validate_kb_rel_path`（禁绝对路径、盘符、
  `..`）。扩展名限 jpg/jpeg/png/gif/webp/bmp。
- **doc 与 changelog 共用这一份清单**。同一张图被 README 与 CHANGELOG 同时引用只需声明
  一次（打包按 ZIP 内路径去重）。
- **归一化路径以 `banner` 开头的项额外进快捷预览走马灯**（第 5 节），且不必被任何 md 引用
  ——「声明但未引用」本来就只是 WARN，正是为橱窗图预留的。
- **字段缺失 = 该插件零资源**，这是唯一语义，不再有回退。空数组同义 —— 所以
  「不要写空对象」那条旧告诫也不再需要，写不写都一样，但没配图的插件**没必要**写。

> **`kbDocAssets` 已停止支持**：打包期直接报可读错误并提示改成数组；加载期只打 WARN 并
> 视为零资源。这个不对称是刻意的 —— 打包要拦住作者，运行时不该让用户装不上包。

---

## 3. 归一化契约（唯一裁决者）

**`kbAssets` 项、Markdown 引用串、运行时 `Plugin.assets[].key`，三者是同一个东西**：
插件根相对路径，经一次归一化后逐字比较。规则按序：

1. `trim`
2. 剥 markdown 标题后缀（`a.png "标题"` / `'标题'` / `(标题)`）
3. 截断 `#fragment` 与 `?query`
4. `\` → `/`
5. 百分号解码（失败则保留原串，不做逐字符兜底替换）
6. `http://` `https://` `data:` `//` 开头（scheme 大小写不敏感）→ 判为外链，返回
   「非本地资源」
7. 去掉所有前导 `/`（root-relative 视同插件根相对）
8. 按 `/` 分段：丢弃空段与 `.`；`..` 弹栈，**栈为空时判非法**（越过插件根）；
   拼回为空亦非法

**关于第 8 条**：早先为防 `..` 逃逸而保留字面 `..`（让 `../../a.png` 归一化成
`../../a.png`），产出的是「合法但永远匹配不上」的键。单一坐标系下插件根就是根，
越界即非法，直接判非法更诚实。注意 `images/../a.png` → `a.png` 仍然合法（同层折叠）。

**刻意不做**：不做大小写归一（ZIP 条目名大小写敏感）。

### 引用一律按插件根解析

**没有「md 所在目录」这个概念。** md 在插件根还是深埋在 `doc_root/` 里，引用串都按插件根
解析。代价是 md 不在插件根时，作者得在 md 里写完整的插件根相对路径（在 GitHub 上预览会
裂图）；换来的是资源键只有一种写法。当前全部插件的 `kbDoc` / `kbChangelog` 都在插件根，
所以这个取舍零代价 —— md 里现有的 `./image.jpg` 归一化后就是 `image.jpg`。

### 两份同构实现

| 侧 | 文件 | 用途 |
|---|---|---|
| Rust | `src-tauri/kabegame-core/src/plugin/assets.rs::normalize_asset_path` | 打包校验、加载建表 |
| TS | `packages/kabegame-core/src/utils/assetPath.ts::normalizeAssetPath` | 文档渲染时查表、判外链 |

改规则必须同时改两处，顺序也要一致。两边漂移只影响「这张图找不找得到」，不涉及安全边界
—— 包内路径合法性由 `validate_kb_rel_path` 在打包期与加载期各把一次。
Rust 侧的用例表（`assets.rs` 的 `#[test] normalize_asset_path_follows_shared_rules`）
是规则的可执行说明书。

---

## 4. 全链路

```
package.json (kbAssets + kbDoc + kbChangelog)
    │
    ├─ 打包 kabegame-cli plugin pack
    │     pack_plugin_v3()：
    │       1) 解析清单：逐项归一化 + 归一化后冲突检测 + 存在性 + 扩展名 + 2MB 硬上限
    │       2) 交叉校验（无条件执行，不管有没有 kbAssets 字段）：
    │          扫 kbDoc + kbChangelog 的 md，引用了但未声明 → 硬报错（附建议 JSON 片段）
    │       3) 声明但未被引用 → WARN；总量超 10MB → WARN
    │     collect_v3_entries()：按 kbAssets 项收资源，按两个字段收 md 本体
    │
    ├─ 加载 parse_kgpg → load_plugin_v3_from_zip
    │     read_locale_md_field() 对 kbDoc / kbChangelog 各跑一次（缺条目 = 硬错误）
    │     build_asset_index(pkg) → Vec<归一化路径>（保留 kbAssets 声明顺序）
    │     按路径读字节 → base64 → Plugin.assets（数组项为 { key, dataBase64 }，继续保序）
    │     md 推**原文**，不改写引用；资源条目缺失只 WARN 跳过，不让整个插件装不上
    │
    └─ 展示
          ├─ 文档正文：PluginDocRenderer.vue 用 normalizeAssetPath(引用) 查 assets
          │            外链归一化返回 null → 原样交给 marked（不误判成「加载失败」）
          └─ 快捷预览走马灯：见第 5 节
```

### 为什么交叉校验要提到分支外

删掉回退后，「md 引用了本地图但没声明」不再有任何兜底 —— 图会静默不进包，运行时渲染裂图，
而文件明明在磁盘上，旧的「缺图硬错误」也不触发。所以交叉校验必须**无条件执行**，
不能像以前那样关在 `if let Some(kbDocAssets)` 里面。

由此得到的语义正好满足「三个键互不依存」：约束落在**「md 里真的引用了本地图」这个事实**
上，而不是字段共现。零配图插件不写 `kbAssets` 静默通过；有配图却不写 → 打包硬失败并给出
该写什么。不需要「声明 A 就必须声明 B」这类规则。

### 限额

| 常量 | 值 | 位置 |
|---|---|---|
| `ASSET_MAX_FILE_SIZE` | 2 MB | 打包期**硬报错** / 加载期 WARN 跳过 |
| `ASSET_MAX_TOTAL_SIZE` | 10 MB | 打包期 WARN / 加载期超出部分不内嵌 |

均定义在 `assets.rs`，CLI 与 core 共用，不再各自写死。doc 与 changelog 共享同一份预算。

---

## 5. 快捷预览走马灯

「源」页面（`PluginBrowser.vue`）的插件卡片与**插件选择器**（`PluginPickerField.vue`
的桌面下拉行）支持快捷预览：桌面 hover 400ms 后在触发元素旁弹出 320px 悬浮面板，
紧凑端长按 500ms 弹出同一面板的底部抽屉形态。面板里的**示例图走马灯直接复用
`Plugin.assets`** —— 不额外增加任何后端接口或资源。

| 关注点 | 处理 |
|---|---|
| **只收 banner 图** | `isBannerAsset(key)`：完整归一化路径以 `banner` 开头，大小写不敏感。见下 |
| 顺序 | `Plugin.assets` 按 `kbAssets` 数组声明顺序下发；过滤后不再排序，走马灯直接沿用作者声明顺序 |
| 图注 | **不显示**。走马灯是橱窗，图上压一行从文件名推导的字符串（`Banner 1`）既非作者本意也无信息量 |
| MIME | `guessAssetMime(key)`，与 Rust `mime_for_asset` 及打包白名单口径一致 |
| **只对已安装插件出图** | 商店里未安装的条目**不出图**，显示「安装后可查看示例图」。原因见下 |

### 为什么按路径前缀筛

`kbAssets` 同时承载两类图：文档正文里的操作截图（「点这个按钮」「填这个 cookie」）与
插件橱窗图。前者进走马灯毫无意义 —— 脱离上下文的局部截图既不好看也不说明插件能抓什么。

区分方式选了**路径前缀**而非新增清单字段：`kbAssets` 的立身之本是「一份清单、一个坐标系」
（第 1 节），再引一个 `kbBanners` 数组等于把刚合并掉的两个空间重新劈开，还要处理两份清单
不一致时谁说了算。前缀约定零字段、零校验，作者调整资源路径即可加入橱窗。

`banner.png` / `banner-1.jpg` / `banner/home.webp` 都算；`images/banner-home.webp` 不算，
因为它的完整路径不是以 `banner` 开头。判定实现在
`packages/kabegame-core/src/utils/assetPath.ts::isBannerAsset`，两个装配点共用。
**存量插件没有迁移**，因此它们当前都命中「没有示例图」空态 —— 这是预期的，
补图时按新约定命名即可。

### 为什么未安装条目不出图

唯一能拿到远程插件 `assets` 的接口 `get_plugin_detail(source_id)` 内部会调用
`ensure_plugin_cached`，把**整个 .kgpg 下载到本地磁盘缓存**（可能几 MB）。hover 是高频
轻量交互，鼠标划过卡片列表就会触发一串后台整包下载，产生非预期流量。因此快捷预览只做
best-effort：

- 本身就是已安装插件 → 直接用内存里的 `assets`（零成本）
- 商店条目且 `installedVersion === version` → 同一份内容，复用本地已装包
- 其余 → 空态「安装后可查看示例图」

真要看图，点进详情弹窗（那里本就要拉完整包，是用户的显式动作）。

### 涉及文件

| 层 | 文件 |
|---|---|
| 走马灯 | `packages/kabegame-core/src/components/plugin/PluginQuickPreviewCarousel.vue` |
| 悬浮面板 | `packages/kabegame-core/src/components/plugin/PluginQuickPreviewPanel.vue` |
| 交互（hover 延迟/长按/定位翻转/抽屉形态） | `packages/kabegame-core/src/components/common/HoverRevealPanel.vue` |
| 示例图装配 | `packages/kabegame-core/src/utils/assetPath.ts::bannerPreviewImages` |
| 接入 | `apps/kabegame/src/views/PluginBrowser.vue`、`apps/kabegame/src/components/PluginPickerField.vue` |

> **弹出容器是组件不是 composable**：`HoverRevealPanel` 把触发器放默认插槽、面板内容放
> `panel` 具名插槽，套在需要弹出的元素外层即可，两个接入点因此共用同一套延迟、定位与
> 抽屉逻辑。它只管「何时弹、贴哪」，面板 props 由各接入点自行装配 —— 「源」页面要处理
> 商店条目与更新提示，选择器面对的一定是已安装插件（故传 `:show-detail-hint="false"`：
> 那里点面板不跳详情）。面板层级取 `useZIndex().nextZIndex()`，否则会被 dialog 里的
> select 下拉压住。

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
| 归一化 / 建表 / 常量 | `src-tauri/kabegame-core/src/plugin/assets.rs` | `normalize_asset_path`、`build_asset_index`、`mime_for_asset`、两个限额常量 |
| 引用提取 | `src-tauri/kabegame-core/src/plugin/mod.rs` | `extract_local_refs(md)` —— 只回原始引用串，按插件根解析，不拼 md 目录 |
| 加载 | `src-tauri/kabegame-core/src/plugin/mod.rs` | `read_locale_md_field`（kbDoc / kbChangelog 共用）、`load_plugin_v3_from_zip` 的资源段、`Plugin.assets` / `Plugin.changelog` |
| 打包 | `src-tauri/kabegame-cli/src/main.rs` | `pack_plugin_v3` 清单解析 + 无条件交叉校验 + `collect_v3_entries` 全量白名单收集（只收清单显式引用的文件） |
| PathQL | `src-tauri/kabegame-core/src/providers/programmatic/plugin_resource.rs` | `plugin://{id}/asset/{path}`、`plugin://{id}/changelog`，MIME 复用 `mime_for_asset` |
| MCP | `src-tauri/kabegame/src/mcp_capabilities.rs`、`mcp_server.rs` | capability `plugin.read.asset` / `plugin.read.changelog`，资源模板与说明文案 |
| MCP bundle | `mcpb/kabegame-gallery-node/server/index.js` | `read_plugin` 工具的 `resource` 枚举（`asset` / `changelog`） |
| 前端归一化 | `packages/kabegame-core/src/utils/assetPath.ts` | `normalizeAssetPath`、`guessAssetMime`、`humanizeAssetLabel` |
| 文档渲染 | `packages/kabegame-core/src/components/plugin/PluginDocRenderer.vue` | 查 `assets` 内联 base64 图片 |

格式规范另见 `docs/PLUGIN_FORMAT.md`、`apps/docs/src/content/docs/dev/format.mdx`、
`.../dev/packaging.md`、`.../reference/plugin-schema.mdx`。
