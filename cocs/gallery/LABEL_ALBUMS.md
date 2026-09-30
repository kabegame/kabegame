# 标签画册（Label Albums）

图片标签没有独立的表：**标签就是一种画册**。`albums.type IN ('label', 'label_dir')` 的画册组成
独立的「标签森林」，其中 `label_dir` 是内部目录、`label` 是可挂图的叶子；图片与标签的关系就是
`album_images` 行。加入 / 移出画册、删除、移动、壁纸轮播、虚拟磁盘、MCP 与事件刷新继续复用画册能力。

1. 自成一片森林：标签森林成员只能挂在 `label_dir` 下（或位于根级），普通 / 文件夹画册不能进入。
2. 结构互斥：`label` 不能有子画册，`label_dir` 不能有图片成员。
3. 两种类型都有 `label_key`：`[a-zA-Z0-9_\-() ]+`，空格不在首尾、不连续，不超过 64 字节。
4. 同级 key 唯一，且不区分大小写（目录与叶子共用 key 空间；名称仍同级唯一）。

设计依据与分阶段实施记录见 `.claude/plans/image-labels/00-plan.md`。

## 数据模型

v031 迁移（`storage/migrations/v031_label_albums.rs`，`init.rs` 同步）：

| 列 / 索引 | 说明 |
|---|---|
| `albums.label_key` | `label` / `label_dir` 非空 |
| `albums.label_path` | 派生列：从森林根到自身的 key 链，如 `pixiv/character/hatsune` |
| `idx_albums_label_key` | `(COALESCE(parent_id,''), LOWER(label_key)) WHERE type IN ('label','label_dir')`，唯一 |
| `idx_albums_label_path` | `LOWER(label_path) WHERE type IN ('label','label_dir')`，给完整路径搜索点查 |
| `task_failed_images.labels` | 下载失败时保存已校验的标签 JSON，重试还原 |

`label_path` 的维护时机与 `ancestor_path` 相同：新建时由父级直接拼出；移动、改 key 后由
`Storage::rebuild_album_ancestor_paths` 用同一个递归 CTE 全量重算。

## 内容与计数

- `label` 中栏只显示直接图片成员；`label_dir` 中栏显示“不能放图片”的空态。
- 计数不跨标签层级汇总：`label` 显示直接图片数，`label_dir` 显示直接子画册数。两者都由
  `buildAlbumMediaNodes` 生成，树、选择器与详情同源；目录不发逐画册图片 COUNT 查询。
- 「从画册移除」只删直接关联：删掉 `character` 不影响同一张图上的 `hatsune`。删除标签画册递归
  删除整棵子树及其成员关系。

## 标识符校验（单一来源）

`storage/labels.rs`：

- `is_label_key`：标签 key 与目录每段。允许 `[a-zA-Z0-9_-]`、英文括号与空格（动漫标签常见
  `name (series)`），空格不在首尾、不连续；`,`（搜索分隔）与 `/`（路径分隔）永远不允许。
- `is_plugin_ident`：**插件 id**（`app_paths::validate_plugin_id` 直接调用），只允许 `[a-zA-Z0-9_-]`，
  所以插件 id 也不再允许 `.`。它是 `is_label_key` 的子集，保证「缺省目录 = 插件 id」一定合法。
- `validate_label` / `validate_labels`：只拒绝、不修正；`category` 缺省为插件 id；name 空白视为未提供；
  批量按 `(segments, key)` 不区分大小写去重保序。
- `validate_label_values`：插件传来的原始 JSON 数组入口（V8 `downloadImage`、WebView
  `crawl_download_image` 共用）；非数组报参数错误，不合规项返回原下标供写任务日志。

前端输入框即时校验用 `apps/kabegame/src/utils/labelKey.ts` 的 `isLabelKey`（同规则）。

## 存储 API（`storage/albums.rs`）

| API | 语义 |
|---|---|
| `add_label_album(key, name, parent_id, directory)` | 用户新建叶子或目录；父级只能为空或 `label_dir`；name 缺省 = key |
| `set_label_key(id, key)` | 改 key，重算子孙 `label_path`，发 `album-changed { labelKey }` |
| `ensure_label_path(spec)` | 插件寻址：`category` 各段找或建 `label_dir`，末端找或建 `label`；撞到相反类型时报冲突 |
| `apply_labels_to_images(specs, image_ids)` | 逐项容错：寻址成功才挂叶子；冲突项进入 `skipped`，同批其它标签继续 |
| `get_image_album_ids(image_id)` | 预览面板用：图片直接所属的全部画册 id，前端按类型过滤 |

插件给的名称**只在创建时使用**，已存在节点永远不改名（用户可能改过）。新建时名称撞同级已有画册，
依次退化为 `name (key)`、`key`、`key (2)`、`key (3)`…，插件创建永不因撞名失败。

命令接线与 `rename_album` 同一组位置：`kabegame-core/src/commands/album.rs`、
`kabegame/src/commands/album.rs`、`lib.rs` 注册、`permissions/main.toml`、`web/dispatch.rs`（两个写命令要求 super）、
IPC `ipc.rs` / `client.rs` / `handlers/storage/albums.rs`。

## 标签来源

1. **下载新图片**：`Kabegame.downloadImage(url, { labels })`。入口只校验，入库成功时才建画册并挂叶子，
   详见 [../downloader-tasks/DOWNLOADER_FLOW.md](../downloader-tasks/DOWNLOADER_FLOW.md)「插件标签」。
2. **去重命中**：仅在「去重时更新元数据」开启时给已有图片补挂。
3. **历史图片**：迁移脚本导出 `provideLabels(input)`，`migrate` 成功后以其输出调用，标签挂到引用该
   metadata 行的所有图片，详见 [../crawler/METADATA_MIGRATION.md](../crawler/METADATA_MIGRATION.md)。
4. **用户手动**：画册页新建标签/标签目录、拖入文件到标签叶子、预览面板添加 / 新建标签。

样例：`src-crawler-plugins/plugins/anime-pictures` 把作品 / 角色 / 画师 / 参考 / 物体 tag 映射为
`anime-pictures/{copyright,character,artist,reference,object}` 下的标签（下载与 `provideLabels` 各一份同规则实现）。
`src-crawler-plugins/plugins/pixiv` 把作品 tag 映射到 `pixiv/tag`：作品详情固定请求 `lang=en`，英文翻译
优先派生 ASCII key；无翻译时把假名转成罗马字、长音符转成 `-`，仅将其余非 ASCII 字符确定性编码为
`u-...`。Pixiv 默认原始名（通常为日语）优先作为显示名，缺失时才回落英文与 key。作者映射到
`pixiv/artist`，以 UID 作稳定 key、用户名作显示名。
`src-crawler-plugins/plugins/pixai` 把作品 tack 映射到 `pixai/tag`（优先用 codeName 归一化派生 key，
无法派生时回退到 tack id），作者映射到 `pixai/artist`，以作者 id 作稳定 key、显示名或用户名作名称。

## 搜索

`search/label/<q>`（精确）与 `search/label-tree/<q>`（包含子标签），`q` 为英文逗号分隔的 token，
token 之间为「且」，比较不区分大小写；含 `/` 的 token 按 `label_path` 匹配，否则按 `label_key`。
`kb_label_tokens` 对每个 `/` 段去首尾空白并折叠连续空白，与 key 的空格规则对齐。

- `gallery_search_label_router` / `gallery_search_label_tree_router` → 共用
  `gallery_search_label_query_provider`（`properties.tree = "0" | "1"`）。
- 逗号拆分由宿主 SQL 函数 `kb_label_tokens(q)`（`storage/dsl_funcs.rs`）返回 JSON 数组，交给
  `json_each` 展开，避免用户输入的引号破坏手拼 JSON。
- WHERE 是关系除法「不存在未命中的 token」；token 集为空（只输入逗号）时显式判空，否则会恒真命中全部。
- 三个 detail provider 整体委派 `search`，画册 / 任务 / 畅游详情自动支持。

前端（`galleryQuery.ts` / `GallerySearchDropdown.vue`）把两种模式合并成一个「标签」tab +
「包含子标签」勾选；「任意」模式**不**展开标签模式（输入语法不同），含标签分支的 OR 组也不折叠为任意搜。

## 前端入口

- `services/albums.ts` 提供无状态的单画册、祖先、图片所属画册与分页目录查询，以及标签创建 / 改 key
  写入口；前端不缓存全量画册或全量计数。`album-added` 事件携带 `labelKey` / `labelPath` /
  `ancestorPath`。
- `AlbumTreeView.vue` 的「标签」分区按目录分页查询
  `albums://roots/~any/album_kind/label/~or/album_kind/label_dir/~end/x<页大小>x/<页码>`
  （子目录把 `roots` 换成 `parent/<id>`；只选目录时单写 `album_kind/label_dir`，默认按创建时间排序）；
  目录计数取 `…/~~/children/<同一类型段>` 的 `child_count`（同类型过滤下的直接子画册数），标签叶子计数取
  `…/~~/images` 的 `image_count`（与 `images://gallery/[hide/]album/<id>` 同口径），两者都在 `~~` 边界之后
  按画册 `GROUP BY`，没有行即 0。隐藏口径用 `…/~~/images/hide`。搜索时树形不变：每层查询与
  `~~/children` 都叠加 `search/<q>`（自身或子孙的名称 / 标签路径命中才保留，命中项的祖先一路保留），
  不自动展开；重载按 key diff，用户的展开态按 key 记忆，清空搜索后恢复。
- `AlbumTreePanel.vue` 包装同一棵查询树并提供 DnD；只允许同森林移动且拒绝把节点放到标签叶子下。
- `Albums.vue`：新建对话框类型选择（普通 / 标签 / 标签目录 / 本地文件夹）；移动与父级候选通过
  `AlbumPicker` 的 `scope` 只列标签目录。
- 预览弹窗：core `ImagePreviewDialog` 开 `#info-extra` slot、`ImageGrid` 透传为 `#preview-info-extra`，
  由 app 层 `components/ImageGrid.vue` 渲染 `ImageLabelsPanel.vue`（列出 / 删除 / 从已有添加 / 当场新建 /
  复制 key / 点击跳转）。紧凑布局（PhotoSwipe）没有信息区，标签面板仅桌面预览可见。
  标签按完整父目录 key 路径、不区分大小写的字母序排列，目录内按标签 key 排序；根级标签排在最前。
  `utils/imageLabelPresentation.ts` 对小写目录路径执行 FNV-1a 与雪崩混合，再投射至 OKLCH
  的浅亮低色度区间（L 0.94–0.96、C 0.025–0.035）；同目录共用色板，根级标签使用中性色。
  完整目录路径参与哈希，不受列表顺序、标签增删、切图影响；复制 key 仍沿用原数据顺序。
- 图片右键「复制标签」：标签需异步查询，因此单选时恒显示，无标签时点击给出提示。
- 复制内容面向 SD 提示词：key 用 `, ` 连接，`\ ( ) [ ]` 转义为 `\(` 等（`utils/imageLabels.ts`
  的 `escapeSdPrompt`），空格不转义。

## 范围外

- VD 里标签画册按普通画册显示「直接成员 + 子目录」。
- 搜索框联想。
