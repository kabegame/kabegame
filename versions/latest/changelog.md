# v4.5.0 changelog

## 用户侧
### Added
- 新增任意搜索功能，本质上是所有其他搜索（名称、元数据等）的按或查询
- 畅游导航栏新增“一键下载”：检测当前页面的图片与视频并逐个下载，转圈时再次点击可取消
- 新增设置“冻结网页”（下载分区，默认开启）：畅游一键下载与网页收集时保存页面快照，可在图片详情中回看原网页，并可刷新重新加载（V8 模式仅保存 HTML，WebView 与畅游同时保存样式）
- 新增设置“去重时更新元数据”（下载分区，默认关闭）：重复下载命中已有图片时，可用本次下载的新元数据、来源插件与帖子地址更新该图片
- 画廊“开始收集”新增“网页”来源：粘贴一个网页地址即可收集页面上的图片与视频，可选 V8（静态 HTML，可自定义 HTTP 头，默认自动注入畅游 Cookie 与浏览器 UA）或 WebView（浏览器渲染并自动滚动，保留登录态）两种后端；Android 仅支持 V8，Web 版暂不开放
- 新增 v8 api: `cefUA()` 函数，可以获取cef的默认UA拼到http header.
- 新增图片标签：画册页新增「标签」分区，标签森林以标签目录组织、图片只挂在叶子标签上（有英文 key，可含空格与英文括号，如 `sua (alien stage)`；可改名、改 key、移动、删除），可在图片预览的「标签」面板里查看、添加、新建、删除、复制标签（复制内容按 SD 提示词转义括号，可直接粘贴使用），点击标签跳到对应标签画册；图片右键新增「复制标签」
- 搜索新增「标签」tab：按标签 key 搜索，多个 key 用英文逗号分隔（需同时命中），可勾选「包含子标签」；写成 `a/b/c` 按完整路径匹配
- anime-pictures 插件 0.5.0：下载时把作品、角色、画师、参考、物体标签写入标签分区，历史图片升级后自动补标签
- konachan 插件 1.3.0：下载时按标签颜色（画师 / 版权 / 角色 / 社团 / 风格 / 通用）写入标签分区，历史图片升级后自动补标签
- Pixiv 插件 1.3.0：下载与历史迁移会把作品标签、作者写入标签分区；作品标签保留 Pixiv 默认日语显示名，以英文翻译生成 key，作者以 UID 作为稳定 key；插件筛选改为喜欢数、收藏数、查看数三个区间维度
- PixAI 插件 0.6.0：下载与历史迁移会把作品 tags、作者写入 `pixai/tag`、`pixai/artist` 标签分区；插件筛选改为喜欢数、评论数两个区间维度

### Fixed
- 修复本地文件夹中单个文件变化会触发整目录重扫、阻塞应用事件刷新，以及同步在飞时可能漏掉后续文件变化的问题
- anime-pictures 插件被 Cloudflare 403：改用畅游的 Cookie 与 UA
- linux 下打开图片所在文件夹没有自动定位到图片
- 栅格模式显示图片下，图片填充方式设置的丢失问题（fit、fill）
- 窗口最小尺寸为0的bug
- linux下拖动画廊文件无效的bug（修复后可以拖动到文件管理器、浏览器、微信等其他应用中）

### Optimized
- 本地文件夹同步改为文件级增量事件；长任务延迟显示并提供逐目录百分比与取消能力
- 进度条里的进度文案放到进度条下方，不挤空间
- 进度条宽度调整，在极端窄的情况下隐藏。
- 畅游网址输入框体验优化，不会防抖打开一个不一样的网址
- 大幅优化查询性能、优化操作响应速度
- 画册分页拉取优化，同时降低前端内存使用
- 画册树与画廊过滤树为可选择节点增加文字悬浮变色提示；不可选择节点文字保持原色，移到展开图标时恢复文字颜色，同时保留原有整行悬浮背景
- 所有下拉选择器的弹层宽度统一为与输入框等宽：长选项（如 anihonet 的「作品」）不再把下拉撑到输入框近两倍宽；插件配置表单里被截断的下拉选项、分段器、复选标签与输入框占位文案都补了原生 `title`，鼠标悬停即可看全（畅游的插件快速选择触发器只有 150px，插件名仍会截断）
- 优化开始收集弹窗，不编辑config，加载也速度更快

### Changed
- 本地文件夹目录消失时删除对应画册树但保留图片记录；文件消失时只删除图片记录，不删除磁盘文件
- 视频暂停时进度条不常驻
- 高级搜索被作为普通搜索的补充，而非替代
- 对于更新元数据功能，会更新覆盖已有的相同的图片元数据，通常无害但会有数据更改。
- 大批量画册现在需要分页拉取（加载更多）
- 画册列表默认按创建时间排序（之后会提供专门的排序功能）
- 左侧边栏现在关闭，不展开
- 下载新版本按钮出现在左侧边栏下方
- 整数输入编程可输入框，上下界也不用滑块
- 开始收集弹窗去掉定时设置、配置选择配置，添加跳转配置页面，移动保存到配置按钮到左下方
- 运行配置页面一键运行改成打开配置弹窗
- 图片详情弹窗仅在 Android 提供，桌面端图片右键菜单不再显示“详情”入口

## 开发侧

### Added
- 畅游一键下载：`surf_collect.rs` 以 Tauri Channel 与内容页通信（Rust 权威 run 状态机，内容页脚本 `concat!` 成封闭 IIFE、不挂 window 全局）；页面发现脚本 `page_discover.js` 供后续 webpage runner 复用；快照写入 metadata 表并只以标题与 URL 建搜索索引
- 新增本地文件夹 `fs_listener` + `synchronizer` 双管道与跨画册 CPU 核数并发限制
- 添加了 cef 、 cef-rs 补丁，为了实现linux、macos的拖拽，维护负担增加
- 标签画册：`albums.type IN ('label', 'label_dir')` + `label_key` / 派生列 `label_path`（v031），目录只装子画册、叶子只挂图片，见 `cocs/gallery/LABEL_ALBUMS.md`
- 插件 API：`Kabegame.downloadImage` 新增 `labels`；迁移脚本新增可选导出 `provideLabels(input)`，`migrate` 变为可选
- 新增 PathQL 搜索 `search/label/<q>`；统一按图片叶子标签的完整 `label_path` 做不区分大小写的子串匹配，多个前端输入条件通过 `filter_comb` 叠加
- PathQL 新增子查询边界段 `~~`（此前的查询整体成为下一段的 FROM，按方言渲染为物化 CTE）与 ContribQuery `group_by`；画册页计数改为分页后 `~~` + `GROUP BY` 一条出整页，子树判断改用 `ancestor_path` 前缀区间并新增迁移 v033 `idx_albums_ancestor_path`，见 `cocs/provider-dsl/RULES.md` §2.1
- V8 插件新增 `Kabegame.cefUserAgent()`，返回畅游（桌面 CEF）的默认 UA，配合 `requireCookie()` 解决 Cloudflare `cf_clearance` 绑定 UA 导致的 403；Chrome 大版本号写死在 `ops.rs` 的 `CEF_CHROME_MAJOR`，升级 CEF 时同步

### Changed

- PathQL `~~` 边界改为通过 `<表名>.*` 继承内层全部 fields，不再重放根 provider 贡献；fields / join 的同名字面别名改为后到原位覆盖，`${ref:}` 重名则明确报错
- PathQL `register_schema` 第二个参数收紧为数据表名（不再接受任意 FROM 片段），行不来自 SQL 的 schema（`plugin://`）改用 `register_programmatic_schema`
- 插件 id 收紧为 `[a-zA-Z0-9_-]`、不超过 64 字节（去掉 `.`），规则在 `storage::labels::is_plugin_ident`（标签 key 另用更宽的 `is_label_key`，额外允许英文括号与空格）；不合规的 `.kgpg` 安装 / 打包时被拒绝
- 元数据迁移改为「失败也盖版本」：每行无论成败只处理一次，失败行保留原数据，不再每次启动重试
- `changelog.md` 放到了 [versions](/versions/) 文件夹下方
- windows下拖动文件通过新的download端点下载，可以显示真实文件名称。
- 重构前端pathql查询视图为eventWorker统一收集、refetch、转发
- vendored element-plus 的 `ElSelect` 默认 `fit-input-width`（`select/src/select.ts` 里 `fitInputWidth` 默认改 `true`，与 `ElSelectV2` 对齐），业务侧不再逐个传该 prop；需要按内容宽度的调用方显式传 `false`
- 重构去掉前端 kabegame-core，并入kabegame

### Removed
- 去掉 Daemon 的概念
