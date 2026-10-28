# v4.7.0 regression

## 壁纸轮播：一个 PathQL 路径 + 持久化位置

轮播只认 `wallpaperRotationPath`（不含分页尾）与 `wallpaperRotationPosition`。每次切换先 count 有效路径（原生模式尾部拼 `_kb_fc/media-type/image`），出错回落默认全画廊随机路径，再从当前壁纸 id 经 `~~/rank` 定出的下一张开始取（当前壁纸不在路径里才用持久化位置）；换路径时立即设新路径的第 1 张。入口是查询行 ⋯ 面板的「用当前视图轮播」（路径由 `ImageGrid` 注入），设置页只读展示。切换壁纸模式按当前壁纸 id 经 `~~/rank` 重定位。设置迁移框架对齐数据库迁移，v003 把旧三键换算成路径。Android Worker 改为消费 `rotation_queue.json`。

2026-10-27：macOS 桌面 CEF dev 真机（韩语界面），经 CDP 在主窗口调用命令并点击 ⋯ 面板；测完已恢复 dev 的轮播设置与窗口模式（中途切过原生模式，系统桌面壁纸被换成测试图）。测试画册已删除。「换路径立即切到第 1 张」一行在改为按当前 id 定起点、换路径立即切换后补测；测完恢复路径时立即切到了该视图第 1 张（8743，窗口模式），随后清空了当前壁纸 id，位置为 1。换路径经位置 `-1` + 唤醒轮播线程实现后连跑 4 轮（另有 3 轮带 debug ingest 插桩确认每次换路径只切一次）均与表中一致。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 旧设置迁移 | dev app | 用 v2 的 settings.json 启动 | 迁到 v3，生成 `settings.json.bak-v2`；画廊 + 随机 → `images://gallery/hide/sort/random-<seed>`，位置 0，启用状态等原样 | dev 原为画廊随机、未启用，迁移结果与备份一致。其余五种组合由 v003 单测覆盖 |
| [x] | 按视图逐张前进 | 桌面 dev（窗口模式） | `set_wallpaper_rotation_path("images://gallery/hide/sort/by-id")` 后开启轮播，连续手动切换 3 次 | 位置 0→1→2→3，壁纸依次为视图前 3 张 | 30、31、32，与 `_kb_x8x/1` 前三行一致（窗口模式含视频）。此行测于「换路径立即切换」之前，现在设路径时就已切到 30 |
| [x] | 停开轮播保持位置 | 桌面 dev | 关闭再开启轮播；再用同一路径设一次 | 位置与当前壁纸不变 | 均保持位置 3 |
| [x] | 非法路径被拒 | 桌面 dev | 设 `albums://roots`、`images://gallery/hide/nope-xyz` | 报「轮播路径无效」，设置不变 | 分别报 row missing `local_path` 与 path not found |
| [x] | 切换模式重定位 | 桌面 dev | 窗口模式轮到第一张图片（38）→ 切原生 → 切换一次 → 切回窗口 → 切换一次 | 原生下位置为 38 在图片路径里的序号，下一张是其后的图片；切回窗口后接着 by-id 的下一张 | 窗口位置 8 → 原生位置 1、下一张 45 → 窗口位置 15、下一张 46 |
| [x] | 用当前视图轮播（窗口模式） | 桌面 dev | 画廊加宽高比过滤 + 时间倒序，打开 ⋯ 面板点「用当前视图轮播」 | 写入该视图路径、位置 0、开启轮播；按钮变为「正在轮播此视图」并禁用；成功提示 | 路径 `images://gallery/hide/aspect/16x9-/_kb_fc/sort/by-time/_kb_desc`。测于「换路径立即切换」之前；现在点按钮会立即设该视图第 1 张、位置为 1，按钮 UI 未重测 |
| [x] | 原生模式视频提示与取图 | 桌面 dev（原生模式） | 未选「仅图片」时点「用当前视图轮播」，再手动切换一次 | 提示视频会被跳过；切到的是图片 | 提示出现；切到 8743（webp 2504×1408） |
| [x] | 画册轮播循环与删除 | 桌面 dev | 新建含 3 张图的画册，设为 `album/<id>/sort/by-album-order` 切换 4 次，再删除画册并切换一次 | 按画册顺序 3 张后回到第 1 张；删除后路径回到默认（null），下一次切换写入新的默认随机路径 | 279→280→281→279；删除后路径 null、位置 0；切换后写入 `random-2937306784365644` |
| [x] | 换路径立即切到第 1 张，之后按当前壁纸续接 | 桌面 dev（窗口模式） | 设 by-id 视图后切 2 次；换成倒序视图；同一路径再设一次后切 1 次；换成只看视频的视图后切 1 次；手动设一张不在视图里的图片后再切 1 次 | 每次换路径立即设新视图第 1 张；同一路径再设不切换；之后接当前壁纸的下一张；当前壁纸不在视图里时按位置继续 | 设路径即 30，切换 31、32；倒序立即 8927，再设仍 8927，切换 8926；视频视图立即 30，切换 31；手动设 38 后切到 32，位置 3 |
| [ ] | count 出错回落 | 桌面 dev | 让设置路径失效（如插件扩展路径的插件被卸载）后切换 | 自动换成默认随机路径并从第 1 张开始，启动结果 `fallback: true` | 设置入口会先校验、CLI 不暴露写设置，未找到真机触发手段 |
| [ ] | 设置页只读路径 | 桌面 dev | 打开设置 → 壁纸 | 三个旧控件消失，显示「当前轮播路径」与迁移说明 | 仅类型检查通过，未截图 |
| [ ] | 画册右键设为 / 停止轮播 | 桌面 dev | 画册树右键「设为轮播」，再看树上轮播标记与右键「停止轮播」 | 路径为该画册默认视图，树标记与菜单状态正确 | 未点 UI；同路径的命令层已验证 |
| [ ] | 原生兼容副本 | Windows / Linux 原生模式 | 轮到 WebP / AVIF 图片 | 仍生成并复用 `wallpaper_compatible_path`，桌面正常显示 | rotator 仍把原始 `local_path` 交给原生后端；本机 macOS 未测 |
| [ ] | Android 队列 | Android dev | 设路径并开启轮播，等 WorkManager 触发，再回到应用 | 生成 `rotation_queue.json`；后台按队列换图且只换图片；回到应用后位置与当前壁纸同步 | 本机缺 Android rusty_v8 产物，`--mode android` 交叉检查未能运行，Android 门控代码仅人工复核 |
| [x] | 单测与 DSL 端到端 | 单测 | `deno task test` | 迁移框架、v001–v003、路径工具、`_kb_fc/media-type/image` 接在各类视图尾部的 count / 取行 / rank 一致 | kabegame-core：dsl_e2e 58 项全过；lib 353/355，失败的 `webview_watchdog_suspends_while_host_hidden`、`batch_adds_and_deletes_file_rows` 是并行时共享临时库的建表竞争，单独重跑均通过。前端 Vitest 574 通过。kabegame crate 的测试二进制在 macOS 上找不到 CEF framework 无法启动，rotator 的 `wrapped_position` 单测未跑 |

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

## Android 平板宽屏预览滑动切图

`ImagePreviewDialog` 的模板在 Android 上一律渲染 PhotoSwipe（`v-if="IS_ANDROID"`），但滑动回流（`swipe` / `reach-boundary` → `requestSwitch`）、换图重置、关闭通知等脚本分支仍按 `uiStore.isCompact`（宽度 < 断点）判断。平板横屏宽度超过断点时 PhotoSwipe 照样显示，滑动事件却被直接丢掉，上层 `previewedId` 不动，窗口被拉回原图。改为与模板同源的常量 `USE_PSWP = IS_ANDROID`。

滑动修好后又暴露同类问题：`ImageGridCore` 预览切图的 watch 只在 `isCompact` 时「预览与选择解耦」，平板宽屏走桌面逻辑把当前图设为选中；而 Android 上有选中即打开多选模式的 `androidSelectionModal` 栈位，压在预览之上，于是滑过之后第一次返回只清掉了这个看不见的多选，预览关不掉。该文件其它 Android 多选判断已是 `isCompact || IS_ANDROID`，补齐剩下三处（切图同步选中、多选时点空白不清空、`exitAndroidSelectionMode`）。

2026-10-26：Android 16 平板 dev 包（横屏 1163×776、竖屏 776×1163 CSS 像素）真机实测，CDP 打开画廊预览，用 `adb shell input swipe` / `keyevent BACK` 真实手势与按键，`adb screencap` 截图在会话 scratchpad。返回键问题用 debug ingest 插桩 + 包装 `modalStack.acquire` 定位，已删除插桩。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 平板横屏左滑下一张 | Android 平板 dev | 打开第 1 张，向左滑两次 | 依次切到第 2、3 张，背景网格跟随定位 | 第 1 → 2 → 3，网格高亮跟到第 3 张 |
| [x] | 平板横屏右滑上一张 | Android 平板 dev | 在第 3 张向右滑 | 回到第 2 张 | 通过 |
| [ ] | 跨页切换 | Android 平板 dev | 在一页最后一张继续左滑 | 加载下一页并切到其首张 | 未测：dev 库只有 36 张，最小页大小 100，只有一页 |
| [x] | 上划删除 | Android 平板 dev | 宽屏下在第 2 张上划 | 图片按画廊语义加入隐藏，预览切到相邻图 | 第 2 张被隐藏（共 36 → 35），预览切到第 3 张；测完用 `remove_images_from_album` 从隐藏画册移出还原 |
| [x] | 滑动后返回键关闭 | Android 平板 dev | 打开预览、左滑两次、按一次返回 | 一次返回即关闭预览，网格不留选中 | 修复前：滑一次后返回栈多出多选栈位，第一次返回不关预览；修复后栈位始终只有预览一个，一次返回关闭，无残留选中 |
| [ ] | 手机竖屏不回归 | Android 手机 dev | 打开预览左右滑、上划删除、返回 | 与修复前一致 | |
| [ ] | Web 窄屏预览 | Web | 窄窗口打开预览 | 走桌面 Dialog 分支，缩放 / 切图 / 关闭正常 | 此前 Web 窄屏渲染 Dialog 却走紧凑分支（关闭时不清理 Panzoom 等），现与模板一致 |

## Android 宽屏布局让开系统栏

targetSdk 36 强制 edge-to-edge，`MainActivity` 把系统栏 inset 注入成 `--sat` / `--sab` / `--sal` / `--sar`，由 CSS 各自留白。以前只有紧凑布局（底部 tab、主区顶部）用了它，平板宽屏的「侧栏 + 主区」两边都没垫：顶部头像和页头压在状态栏下，底部内容被导航栏盖住。现在非紧凑布局下侧栏垫上 / 下 / 左并按 `--sal` 加宽，主区垫上 / 下 / 右，背景仍铺到系统栏下面；ElDialog 的桌面样式不再排除 Android。曾试过在原生层给内容根节点加 padding、彻底去掉 safe-area CSS，但预览时图片四周会多出一圈浅色系统栏带，已放弃。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 平板横竖屏无遮挡 | Android 平板 dev | 横屏、竖屏打开画廊、画册 | 侧栏头像与页头在状态栏下方；列表滚到底时最后一行在导航栏上方 | 横屏画廊滚到底最后一行完整、画册页三栏底部无遮挡；竖屏（776 宽，仍是宽屏布局）画廊同样正常。设置页未看 |
| [x] | 预览仍沉浸 | Android 平板 dev | 打开图片预览 | 预览铺满全屏（含系统栏下方），顶部控件不压状态栏 | 图片延伸到状态栏与导航栏下方 |
| [x] | 亀ちゃん不被导航栏挡住 | Android 平板 dev | 默认位置看亀ちゃん；把它往下拖到底、再往上拖 | 脚底在导航栏上方；拖动跟手、不跳位，拖到底被夹在导航栏上方 | 宿主 margin 等于安全区，`left` / `bottom` 改为相对安全区，拖动起点与夹取都扣掉 margin。竖屏实测：离视口底 54.6px（8 + 导航栏 47）；上拖 200px 位移正好 200px；再拖到底回到 54.6px |
| [ ] | 手机横屏刘海 / 侧边导航 | Android 手机 dev | 横屏（宽度 ≥ 768）且导航栏或刘海在侧边 | 侧栏加宽让开左侧，主区让开右侧 | |
| [ ] | 手机竖屏不回归 | Android 手机 dev | 竖屏紧凑布局 | 与修改前一致 | 只改非紧凑布局 |
| [ ] | 桌面不回归 | 桌面 dev | 打开主窗口 | 侧栏宽 64px，无多余留白 | 桌面 inset 全为 0 |
| [x] | 平板弹窗与桌面一致 | Android 平板 dev（横屏 / 竖屏） | 打开「开始收集」等 ElDialog | 与桌面同样限高、header / footer 固定、仅 body 滚动，上下让开状态栏与导航栏；宽度按组件自身 width，不再是 90vw | `dialogs.css` 原先整套规则挂在 `html:not(.platform-android)` 上，平板走 ElDialog 分支却被排除，弹窗按内容撑高（1544px > 视口 1163px），底部「开始收集」落在导航栏下。去掉平台门控、限高与边距叠加 `--sat` / `--sab`，90vw 只在 `max-width: 767.98px` 下生效。「开始收集 → 网络」实测：横屏弹窗 71–690（视口 776），竖屏 90–1058（视口 1163），宽 600px，表单在 body 内滚动，底部按钮在导航栏上方；返回键可关闭 |
| [ ] | 手机弹窗 | Android 手机 dev | 打开仍用 ElDialog 的弹窗 | 宽 90vw，限高后内容在 body 内滚动 | 手机端过去不限高 |


## Web 版前端静态资源走 CDN

生产 web 构建（`isWeb && command === "build"`）的 Vite `base` 指向 `https://cdn.kabegame.com/web/`，`index.html` 仍由二进制内嵌返回；`deploy-web.sh` 先经服务器暂存目录把其余文件 `cp` 进 OSS 挂载点 `/mnt/oss/web/`，校验入口脚本 MIME 后再换二进制。插画移到 `src/assets/`，web 用按显示尺寸压缩的 WebP、本地模式用原图，未引用的那份由 `dropUnreferencedSrcAssets` 从产物删除。

2026-10-28：macOS 宿主用 `vite build` 分别出 web / 桌面前端到会话 scratchpad（未经 `deno task build:web`，二进制未重编、未部署）。web 产物按 `deploy-web.sh` 第 0 步同样的命令上传到线上 OSS（新文件名带哈希，只增，不影响线上页面）；浏览器验证用 puppeteer 在有界面 Chrome 里让 `demo.kabegame.com` 的文档请求返回新构建的 `index.html`，RPC 仍打线上后端（10-24 版本）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | web 产物走 CDN 前缀 | 宿主 `vite build --mode web` | 查看 `index.html` 与 chunk 内的资源 URL | 脚本、样式、modulepreload、`icon.png`、插画都以 `https://cdn.kabegame.com/web/` 开头 | 入口 `https://cdn.kabegame.com/web/assets/index-D89OIi2J.js` |
| [x] | 桌面产物不变 | 宿主 `vite build`（桌面模式） | 同上 | 资源 URL 仍以 `/` 开头 | `/assets/index-…js`、`/icon.png` |
| [x] | 插画只带一份 | 两种模式各构建一次 | 列出 `assets/` 里的 png / webp | web 只有 5 张 WebP，桌面只有 5 张 PNG，代码引用一致 | 加插件前两边各多出另一份（web 多 8 MB 原图） |
| [x] | OSS 上传与响应头 | 线上 OSS | 按 `deploy-web.sh` 第 0 步上传后 `curl` 入口脚本、CSS、WebP | JS 为 JavaScript MIME，CSS 为 `text/css`，带 `Access-Control-Allow-Origin: https://demo.kabegame.com`，支持 gzip | 47 个文件上传约 8 s；JS 为 `application/x-javascript`。直接 rsync 到挂载点会把 JS 标成 `application/octet-stream`，已改为暂存目录 + `cp` |
| [x] | 浏览器从 CDN 加载 | 有界面 Chrome，新 `index.html` | 打开 `/gallery`，再整页打开 `/surf` | 所有脚本 / 样式 / 插画来自 CDN，无失败请求、无控制台错误；吉祥物与冲浪 logo 正常解码 | CDN 35 个请求（JS 20、CSS 9、WebP 5、icon 1）全部 200，源站 `/assets/` 0 个；FCP 572 ms；站立图 344×792、冲浪 logo 540×540 |
| [ ] | 图库缩略图出图 | 有界面 Chrome，新 `index.html` | 打开 `/gallery` 等缩略图加载 | 首页缩略图正常显示 | load 后 6 s 内统计到 0 张已解码缩略图，期间没有请求空状态 / 失物图，判断是等待时间不足；之后两次复测都卡在本机客户端证书弹窗上，未完成 |
| [ ] | `deploy-web.sh` 全流程 | 宿主 + 服务器 | `deno task build:web` 后 `bash scripts/deploy-web.sh` | 先传 OSS、校验入口 MIME，再传插件、换二进制；线上页面资源全部来自 CDN | 未执行，需要重编二进制并重启线上服务 |
| [ ] | 部署后首屏 | 线上 demo | 清缓存打开首页，按慢速 4G 再测一次 | 首次绘制、首个 pageview 明显提前 | 部署前的同口径对照：不限速 FCP 6.9 s → 1.8 s，慢速 4G 18.2 s → 5.6 s |
| [x] | 本地模式插画：吉祥物站立图、冲浪 logo | 桌面 CEF dev | 经 CDP 读画廊页吉祥物与畅游页 logo 的 `currentSrc` / 尺寸并截图 | 加载 `src/assets` 下的原图 PNG，显示与改动前一致 | `/src/assets/kamechan/stand.png` 668×1540、`/src/assets/swim.png` 1254×1254，截图正常 |
| [ ] | 本地模式插画：挥手、空状态、空封面、失物图 | 桌面 / Android dev | 点吉祥物挥手；打开空画册与空图库；触发图片丢失 | 显示原图 PNG | 未在 app 里触发；构建产物里这几张也只引用 PNG |
