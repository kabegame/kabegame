# v4.7.0 regression

## metadata 冻结描述模板（`plugin run --freeze-template`）

CLI `plugin run` 加 `--freeze-template` 后，任务冻结时读一次插件包内 `kbDescriptionTemplate`，`Task::insert_metadata` 写进每行 `metadata.template`。开关只在内存中经 `CrawlTaskRequest` 传递，不入任务记录。详情面板并行获取冻结模板与插件模板，前者非空即覆盖。去重覆盖改挂新行，data 与模板一起被替换，未冻结时清空；metadata 迁移原样拷贝模板，去重按模板分区。IPC 协议升到 v4。

2026-10-26：macOS 桌面 CEF dev 真机实测（`deno task b -c kabegame-cli --data dev` 新建 dev CLI，`deno task dev -c kabegame` 启动时执行 v047 迁移，`metadata` 表新增 `template` 列）。用 `miyoushe`（V8，模板经 `__bridge.getPluginData()` 读表情映射）以 `run-cli.sh` 跑「壁纸」搜索第 1 页；经 CDP 打开预览并读取 iframe DOM，截图在会话 scratchpad。测试 id 产生的图片与任务已清理。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 测试 id 冻结模板渲染 | dev app + dev CLI | 运行 `plugin run <kgpg> --id <id>-test --freeze-template` 后，打开一张测试 id 图片的详情 | 插件详情面板以 iframe 渲染模板，不再只显示原始键值 | `--id miyoushe-ft1` 入库 60 张、3 行 metadata，`template` 全部非空且与包内 `description.ejs` 逐字节一致；`pathql query images://id_<id>/metadata_full` 返回 `template`。测试 id 未安装，详情面板以 iframe 渲染帖子卡片，原始键值 0 项 |
| [x] | 未冻结回退 | dev app + dev CLI | 不加 `--freeze-template`，用新测试 id 跑一次并打开详情 | 未安装插件时显示原始 metadata 键值 | `--id miyoushe-nf1 --no-freeze-template`：metadata `template` 为 NULL，详情面板无 iframe，显示 25 项原始键值 |
| [x] | 冻结模板覆盖插件模板 | dev app + dev CLI | 对已安装插件改本地模板后打包，用已安装 id 加 `--freeze-template` 运行 | 新图片详情使用冻结的新模板；旧图片仍用已安装插件模板 | 已安装 `miyoushe`：先用已安装 id 不冻结跑出旧图，再把加了隐藏标记的模板打包，以路径模式 `--id miyoushe --freeze-template` 跑新图。新图 iframe 含标记，旧图不含。注意：同版本重新打包后，前端内存里的插件模板缓存（`pluginFiles` 按版本 URL 缓存）在 `refresh_plugins` 后仍是旧内容，需要重载页面 |
| [x] | 去重覆盖清空模板 | dev app + dev CLI | 开启「去重时更新元数据」，先带 `--freeze-template` 跑一次，再不带参数跑同一批 | 第二次去重命中后图片改挂新 metadata，详情退回插件模板或原始键值 | 开启「去重时更新元数据」与自动去重（dev 原为关闭，测完已恢复），同一测试 id 不冻结重跑同一批：60 张 URL 去重命中，图片改挂新 metadata（如 12422→12429），新行 `template` 为 NULL，旧冻结行被 GC；详情退回原始键值。命中的旧图若是其它来源，`plugin_id` 也会改为本次 id（符合「插件下载覆盖任意来源」设计）。自动去重关闭时重跑会重复入库，不会命中 |
| [x] | bridge 按测试 id 取数 | dev app | 打开使用 `__bridge.getPluginData()` 的插件模板的测试 id 图片 | 读到测试运行写入的插件数据，模板正常渲染 | iframe 内 `__bridge.getPluginData()` 返回 `miyoushe-ft1` 的数据（`miyoushe_emoticon_map` 3105 项），正文渲染出 13 个表情图片 |
| [ ] | IPC v4 门控 | dev CLI | 主程序运行时执行 `plugin run --freeze-template`，确认走 app IPC | 新 CLI 与新主程序协议一致并走 app；连旧主程序时打印协议过旧并回退本地 | 前半部分已验证：dev app 运行时 CLI 输出「经主程序执行（版本 4.6.1）」，没有协议过旧回退，任务进入 app 任务表。连旧主程序回退本地未测（缺少 v3 主程序） |
| [x] | 迁移保留模板与去重分区 | 单测 | `frozen_template_tests` | 写回新行拷贝模板；data 相同、模板不同的行不合并；改挂到无模板行后旧冻结行被 GC | `deno task test` kabegame-core 通过 |
| [x] | v047 迁移幂等 | 单测 | `v047_metadata_template::tests` | 执行两次只加一列，旧行 template 为 NULL | 通过 |

## 图片详情「基本信息」卡片式排版

`ImageBasicInfoPanel` 从「标签：值」两列改为卡片：名称标题（两行省略）→ 源头像 + 源名 + 收藏时间（年 / 月 / 日分别可点）+ 任务按钮 → 媒体芯片（类型种类 / 格式、文件大小、像素尺寸、宽高比矩形框）→ URL 与本地路径行。宽高比框高 22px、宽按比例夹在 12–56px，接近常见比例（1.5% 内）显示 `16:9` 等，否则显示小数；框放不下文字时写在框外。路径从左侧省略、保留文件名。预览侧栏里基本信息不再与原生元数据平分高度，按自然高度显示。

2026-10-26：macOS 桌面 CEF dev 真机，韩语界面，经 CDP 打开画廊预览截图验证；截图在会话 scratchpad。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 卡片排版 | 桌面 dev | 打开一张插件来源图片的预览与详情弹窗 | 名称、源、时间、芯片、链接行按新排版显示，无大片空白 | 预览侧栏：名称两行、PixAI 图标 + 源名 + 时间 + 任务按钮、芯片两行、URL 与路径各一行，面板约 280px 高。首版名称被 flex 压成 0 高、面板平分高度导致链接行被滚出，已修。详情弹窗未单独看 |
| [~] | 筛选入口不丢 | 桌面 dev | 依次点源、年 / 月 / 日、种类、格式、大小芯片、宽高比框 | 均跳到画廊对应筛选 | 宽高比框已验证：点 16:9 图片的框后预览关闭，画廊计数 3127 → 213。其余入口沿用原 `emitGalleryFilter`，未逐个点 |
| [x] | 宽高比框 | 桌面 dev | 分别打开横图（16:9）、方图、竖图（9:16）、超宽图 | 框与图片同比例；横图与方图文字在框内，竖图文字在框外 | 2504×1408 → `16:9` 框宽 39px 文字在框内；1408×1408 → `1:1` 22px；1232×1632 → `3:4` 17px、720×1280 → `9:16` 12px、1104×1824 → `3:5` 13px，文字在框外。超宽图库里没有，未测 |
| [~] | 链接行 | 桌面 dev | 点 URL、点本地路径、点复制按钮、右键本地路径 | 打开链接 / 打开文件 / 复制成功提示；长路径保留文件名，开头的 `/` 不跑到末尾 | 两个复制按钮均弹「클립보드에 복사됨」，`pbpaste` 拿到完整 URL 与路径；路径显示 `… Lumiera （oc）.webp`。点击打开未测（会拉起外部程序） |
| [ ] | 畅游与未知来源 | 桌面 dev | 打开畅游下载的图片与无来源图片 | 畅游显示站点 host 与罗盘图标，点击打开畅游记录；未知来源显示 unknown 且不可点 | |
| [ ] | 视频与缺失字段 | 桌面 dev | 打开视频、无尺寸或无 URL 的图片 | 视频芯片用摄像机图标；缺失字段对应芯片 / 行不显示 | |
| [ ] | 暗色主题与 Android | 桌面 dev / Android dev | 切暗色主题；Android 打开详情 | 芯片、矩形框、链接配色可读；窄屏下芯片自动换行 | |
