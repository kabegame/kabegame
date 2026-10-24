# v4.6.1 regression

## 自定义 Tauri 插件目录合并

2026-10-24：macOS 上完成静态校验；未运行桌面或 Android 应用。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Workspace 与依赖解析 | macOS / Cargo / Deno | 读取 Cargo metadata，安装 Deno workspace 依赖并执行前后端检查 | 五个插件均从 `src-tauri/tauri-plugin-*/` 解析，前后端检查通过 | `cargo metadata --no-deps --locked`、`deno install --frozen` 和 check-kabegame driver 均通过；vue-tsc / cargo check 0 error；前端包链接指向新目录 |
| [x] | 文档与路径一致 | 仓库 / apps/docs | 搜索旧目录名，核对文档目录树与插件文件内容 | 无旧目录引用，插件源码完整保留 | 已跟踪文件与相关目录无旧引用；109 个已跟踪文件迁移前后哈希核对，仅 pathes Cargo.toml 按预期调整依赖；无新增忽略命中，schema 仍忽略；`git diff --check` 通过 |
| [ ] | Android 插件接线 | Android dev | 启动应用，选择媒体、分享、设置壁纸并运行任务 | 插件加载正常，数据路径、权限和任务通知行为正常 | 当前无运行中的应用，待真机验证 |

## 运行配置页桌面页头间距

2026-10-24：前端类型检查、`AutoConfigs.vue` 的 Prettier 检查及 `git diff --check` 通过；全仓格式检查报告 8 个未修改文件的既有格式问题。以下真机项目未执行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 桌面页头间距 | 桌面 CEF | 在画廊与运行配置页之间切换，检查「我的配置」与「插件推荐」 | 运行配置页头上、左、右均有 20px 间距，与画廊一致；下方标签、筛选和列表不重复缩进 | 当前无运行中的应用，待真机验证 |
| [ ] | 紧凑布局 | Android / 窄屏 Web | 打开运行配置页并切换两个标签 | 页头保持全宽，内容区保留原有左右及底部 20px 间距，无水平溢出 | 待真机验证 |

## 四格漫画模板独立编号

2026-10-24：在 macOS PhotoCraft 查看更新后的 `4koma/template.psd`，确认四个画格与独立的 `编号1`–`编号4`；实际运行 `scripts/compose-comic.py` 并目视检查生成的 3072×2048 PNG。验证产物位于 `.kabegame/debug/compose-comic-check/`（不入库）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 画格定位 | macOS / Python | 运行 `--show-regions` | 左上、右上、左下、右下依次为 `(77,55,757,508)`、`(779,55,1459,508)`、`(77,525,757,978)`、`(779,525,1459,978)`，每格 680×453 | 已实测 |
| [x] | 编号与背景保留 | macOS / Python / PNG | 用四张不同纯色图片合成，检查编号与画格外背景 | 1–4 完整盖在对应画格上，无原占位图残留；画格外背景不变 | 已目视检查 3072×2048 输出；原尺寸逐像素检查编号不透明像素与画格外背景，画格中心为透明 |
| [x] | 尺寸与适配模式 | macOS / Python | 分别使用 cover / contain / stretch、具名参数，再输出 3072×2048 | 顺序正确、四格中心颜色正确，成品尺寸与请求一致 | 三种模式均实际运行；2 倍输出中心颜色与尺寸断言通过 |
| [x] | 旧模板兼容 | macOS / Python | 从 HEAD 提取旧 PSD，调用更新后的加载逻辑 | 无独立前景编号时，结果与旧逻辑一致 | 原尺寸 RGBA 逐像素对比通过；Python 语法解析通过 |

## 过滤走查 Phase F：前端按画册事件收紧刷新

2026-10-24：仅前端 refreshOn、补丁消费与测试 / 文档，不新增 SQL，不修改 Rust 或 third/。
以下严格对应 phaseF.md「验证」表。
2026-10-24 在 macOS 桌面 CEF dev 真机验证：在 pathqlSource.ts 的请求入口与事件窗口刷新处、事件源、预览 `resolveCurrentImage` 用 debug ingest 插桩（session `album-phaseF`，`// DEBUG-ALBUM`，验证后已删除），每个场景前后发 marker，按事件 ts 分段、按 kind + key 归到观察方计数；「n 次」均指该观察方由事件窗口触发的 pathql 读取次数（用户操作请求另计、不算入）。写操作经页面内 IPC 直接调用（不经 `ctx.mutate`），只观察事件驱动的刷新。测试图为现生成的本地导入副本（8754–8764），测试画册 / 标签 / 两个本地导入任务测后删除；收藏 8、隐藏 1103 计数、hide 开 / 无画册关、画廊排序与查询、画册页选中与排序已还原。首测时第 6、13、16 行因画册树分区根判断过宽未通过；修复 AlbumTreeView.vue 的分区根结构 / 补丁判断后，同日以同一 session 复测这三行及第 7、14 行的树部分（测试画册测后删除，插桩已删）。
自动化验证（2026-10-24）：`deno task test -c kabegame --skip cargo` 通过（53 files、565 tests）；check-kabegame driver 执行 `deno task check -c kabegame` 通过（退出码 0，vue-tsc / cargo check 均 0 error，保留既有 warnings）；修改范围的 Prettier 检查与 `git diff --check` 通过。这些结果不代替真机勾选。

| 状态 | 场景 | 预期 | 备注 |
| --- | --- | --- | --- |
| [x] | 画廊收藏 / 取消收藏一张图 | 画廊 0 次，心形原地变化；预览 0 次重解析；画册树只重读系统区 | 画廊行与总数 0 次（右键菜单「收藏 / 取消收藏」文案原地切换）；预览两种形态均 0 次重解析（列表内 ImageInfo、hide 开时预览已隐藏图的裸 id），对照：裸 id 预览的图加入普通画册时重解析 1 次、标签面板 1 次；画册页上收藏 / 取消收藏只重读树系统区 extra 各 1 次 |
| [x] | 画廊开「无画册」后收藏一张在普通画册里的图 | 画廊 1 次，图出现 | 行与总数各 1 次，图出现；取消收藏同样各 1 次，图消失 |
| [x] | 画廊 hide 开，隐藏 / 取消隐藏任意一张图 | 行与总数各 1 次（不按图判断） | 隐藏、取消隐藏各：行 1 次、总数 1 次 |
| [x] | 画册页 hide 关，隐藏本画册一张图 | 网格 0 次，卡片打灰；页头计数 0 次 | 网格行与总数 0 次，卡片带 image-item-hidden；页头计数 0 次（树系统区 extra 1 次）；取消隐藏同为 0 次 |
| [x] | 画册页 hide 开，隐藏任意一张图 | 网格行与总数各 1 次；页头计数 0 次 | 隐藏本画册外的图：网格行、总数各 1 次，页头计数 0 次；取消隐藏同样各 1 次 / 0 次（树带 hide/ 前缀的各 extra 全部重读，属已知边界） |
| [x] | 重命名当前画册 | 网格 0 次；页头详情 1 次；树 page 1 次、extra 0 次 | 网格 0 次、页头详情 1 次、树 extra 0 次；树 page 只有所在父目录页 1 次。首测时 4 个分区根 page 也各多读 1 次，修复 AlbumTreeView 分区根判断后复测通过。补测根级画册 PF-C 改名：只刷新普通分区根 page 1 次 |
| [x] | 重命名子画册 | 页头详情 0 次、计数 0 次 | 页头详情 0 次、计数 0 次；复测时树只刷新子画册直接父目录页 1 次，分区根与祖先页不再多读 |
| [x] | 重命名祖先画册 | 页头详情 1 次（面包屑更新）、计数 0 次 | 页头详情 1 次、计数 0 次 |
| [x] | 新建子画册 | 页头详情 1 次、计数 0 次 | 页头详情 1 次、计数 0 次 |
| [x] | 把带图的子画册移出当前画册 | 页头详情与计数各 1 次 | 移出：页头详情 1 次、计数 1 次；再移回同样各 1 次 |
| [x] | 删除当前画册 | 页头回落到最近存活的祖先；计数不为它多读 | 选中回落到 PF-Root（albumIdPath 变为根）；详情事件读 1 次后切到根，计数只请求新 key album-tree/<根> 1 次，没有为被删画册重读计数 |
| [x] | 删除一个标签目录，当前图挂着它下面的标签 | 标签面板 1 次，标签消失 | 预览打开挂 pf-ld/pf-l 的图，删除 pf-ld：标签面板 1 次，pf-l 消失 |
| [x] | 删除一个折叠分支深处的画册 | 只重读它祖先所在页的计数 | 删 PF-B/B1/B2/B3（B 折叠）：只有祖先所在的普通分区根 page + extra 各 1 次。首测时标签、本地文件夹、系统分区根也多读，修复后复测通过 |
| [x] | 删除一个与当前画册无关的画册 | 页头详情与计数 0 次 | 页头详情 0 次、计数 0 次；复测时树只有普通分区根 page + extra 各 1 次，其它分区根不再多读 |
| [x] | 删除当前画册的子画册 | 页头详情与计数各 1 次 | 页头详情 1 次、计数 1 次 |
| [x] | 移动一个折叠分支深处的画册 | 只重读新旧两侧祖先所在页的计数 | 把折叠的 PF-B2 移到折叠的 PF-C 下：只有普通分区根 page + extra 各 1 次。首测时其它分区根也多读，修复后复测通过 |
| [x] | 在当前画册子树内部挪动子画册 | 页头详情 1 次、计数 0 次 | 页头详情 1 次、计数 0 次 |
| [x] | 画册页按画册顺序 / 按时间排序时拖动排序 | 前者网格重读，后者 0 次 | 以 IPC update_album_images_order 代替拖动：按画册顺序时网格行、总数各 1 次；按时间 0 次 |
| [x] | 画廊删除一张不在当前画册的图 | 画册页总数 0 次 | 停在画册页，删除导入副本 8763：画册页网格行、总数、页头计数均 0 次 |
| [x] | 往普通画册加图（下载输出画册） | 只重读该画册所在分区的树 extra | 本地导入带 outputAlbumId（根画册 PF-D）与 IPC 加入 PF-C 各一次：都只重读普通分区根 extra 1 次，系统 / 标签 / 本地文件夹 extra 0 次 |
| [x] | 画廊重命名任意画册 | 画廊 0 次（未开「无画册」、未用标签搜索时） | 0 次 |
| [x] | 画廊用标签搜索时给图挂上匹配的标签 | 画廊刷新，图出现 | 标签搜索 pf-l 时把图挂到 pf-l：行与总数各 1 次，图出现 |
| [x] | 任务详情开「无画册」后把一张图加入画册 | 网格刷新，图被剔除（现状不刷新） | 行与总数各 1 次，图被剔除。注：从画册页用 router.push 直接进任务详情时网格未发请求（空状态），整页刷新后正常，判断为测试导航方式问题，未深究 |
| [x] | 画廊只开 hide，往普通画册加图 | 侧栏 0 次 | 打开「时间」维度弹层（gallery/hide/date/_kb_co）后往普通画册加图：侧栏 0 次；对照：同一弹层下隐藏 / 取消隐藏一张图各 1 次 |

## 过滤走查 Phase E：画册事件协议对齐

2026-10-24：实现 Phase E 点 1–6，仅对齐协议与机械适配，保留 Phase B 后的既有刷新口径；不实现 Phase F 的收紧。
2026-10-24 在 macOS 桌面 CEF dev 真机验证（二进制晚于全部 Phase E 源码改动，收到的都是新事件名）：在前端事件源与事件窗口刷新入口用 debug ingest 插桩（session `album-phaseE`，`// DEBUG-ALBUM`，验证后已删除），按事件 ts 排序读取；测试图为现生成的本地导入副本，测试画册、标签、本地文件夹、任务与下载图测后删除，画廊 / 画册页选择、收藏与隐藏计数、Web 服务器已还原。未勾选的行未真机验证。
运行时事件与次数验收应使用 debug ingest 固定 session、按 ts 排序；不得包装 invoke 或按网络请求计数。
本节协议覆盖后文 Phase A / B 的历史事件名记录；VS Code 扩展由主会话在外部仓库单独修改。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 普通画册加入可见 / 隐藏图 | 桌面 CEF / IPC | 同批加入普通图和已隐藏图 | 一条 album-images-added，imageIds 包含全部实际新增；无 reason 或隐藏状态拆分 | macOS：同批加入普通图 8621 与已隐藏图 8622，一条 album-images-added，imageIds 为两张，无 reason、无拆分 |
| [x] | 隐藏 A 与收藏中的图 | 桌面 CEF | 把同时属于 A、收藏的图片加入隐藏画册 | 仅隐藏画册一条 added，不带 memberships / images，不给 A、收藏发事件；hide 开的画廊、画册页刷新剔除，hide 关时只打灰 | 2026-10-24 复测（改为不带成员表与图片行后，session `album-hide2`）：隐藏 8753 只有隐藏画册一条 added，载荷仅 albumId / ancestorPath / imageIds / seq；画廊 hide 开行与总数各 1 次后剔除，hide 关 0 次、卡片打灰；画册页 hide 开网格行与总数各 1 次剔除、hide 关网格 0 次打灰，页头计数均 0 次 |
| [x] | 取消隐藏 | 桌面 CEF / IPC | 从隐藏画册移出图片 | 隐藏画册一条 deleted，只有 imageIds；hide 开的视图刷新，hide 关时按 id 取消打灰 | 2026-10-24 复测：隐藏画册一条 deleted，仅 imageIds；画廊 / 画册页 hide 开行与总数各 1 次后图回来，hide 关 0 次、取消打灰；画册树分区根仍按原保守口径重读（Phase F 收紧） |
| [x] | 删除隐藏图 | 桌面 CEF | 删除同时属于其它画册的隐藏图 | images-deleted 加每个原属画册一条 album-images-deleted，均有 imagesDeleted: true；不当作取消隐藏 | macOS：删除同属 PE-A、收藏的隐藏图 8622：images-deleted 一条，隐藏 / 收藏 / PE-A 各一条 album-images-deleted，均带 imagesDeleted: true，无 memberships / images |
| [x] | 拖动 / 外部改序 | 桌面 CEF / IPC / MCP | 拖动排序，调用 set_album_images_order 与 add_images_to_album.image_orders，混入不存在 id | 一条 album-images-change，只含实际改序的成员 id；无命中或值未变不发 | macOS：IPC update_album_images_order 混入不存在 id 与值未变 id，只发一条 album-images-change，imageIds 仅实际改序的 1 张；全部未变 / 无命中不发。MCP set_album_images_order 同样只含实际改序 id、无命中不发。界面拖动与 add_images_to_album.image_orders 未测 |
| [x] | 删除带子画册的根 | 桌面 CEF | 删除带图、含折叠深层子画册的根 | 一条 albums-deleted，仅根及真实路径，无成员事件 / 空 order；树根和已展开子孙消失，祖先计数刷新 | macOS：PE-P/PE-R 下两层子画册（c2 分支折叠未加载）各带图，删 PE-R 只有一条 albums-deleted，仅根及 `/P/R/` 路径，无成员事件；树中 R 与已展开子孙消失，PE-P 计数 5→1，页头 1 张 / 0 子画册，库内子孙与成员行清空 |
| [x] | 下载挂多个新标签 | 桌面 CEF / CLI | 下载一张带多个新标签的图 | 一条 albums-added，加每个实际新增成员叶子一条 album-images-added | macOS：konachan tags 模式下载 maozi_tutu 2 张。第一张一条 albums-added（新叶子 konachan/artist/maozi_tutu）加 16 个叶子各一条 album-images-added；第二张无 albums-added、16 条 added。本次只新建 1 个叶子（其余标签已存在），多个新叶子同批未覆盖 |
| [x] | 本地文件夹同步状态 | 桌面 CEF | 同步本地文件夹并切换同步模式 | folderStatus 单画册 patch；批量规整为一条 albums-change，补丁不带 parentId / ancestorPath | macOS：同步后每个画册一条 album-changed { id, folderStatus }；PE-LF 切 recursive / none 各一条 albums-change（4 个补丁，只含 syncMode）；所有补丁无 parentId / ancestorPath |
| [x] | 移动折叠深层画册 | 桌面 CEF | 移动有展开子孙的画册，再操作其子孙 | 一条 album-moved 带新旧路径；两侧目录与祖先计数刷新，树 / 页头 / 标签持有路径前缀立即改写 | macOS：move_album 两次（P→A、A→P，带展开的 M/M1/M2）各一条 album-moved 带新旧路径；新旧父目录与根 extra 刷新、计数正确，移动后展开状态保留；随后给 M2 加图只刷新新链 P / M / M1 的 extra，不刷旧父 A；M1 改名一条 album-changed { id, name }；页头面包屑变为 PE-A/PE-M/PE-M1/PE-M2。标签叶子 pe-l 从 pe-ld 移到 pe-ld2，预览标签面板标题变 pe-ld2/pe-l，点击跳到新路径 |
| [x] | 本地文件夹改链 / 转换提升 | 桌面 CEF | 一次改链同时移动祖先和子孙，再把子树转普通画册 | 每个改父级的根各一条 moved，祖先在前、子孙 old 接续前序移动；改名另有 name 补丁；提升同样发 moved | macOS：先建 s1 本地文件夹画册再建父目录 PE-LF，改链为 s1 一条 album-moved（只发根，d1 不单发）；把 s1 转普通画册：一条 album-moved（提升到根）加一条 albums-change（s1、d1 的 albumType / syncFolder / folderStatus）。同一次改链同时移动祖先与子孙、改名 name 补丁未触发 |
| [x] | 现有页面刷新口径 | 桌面 CEF | 依次浏览画廊、画册、任务、畅游、侧栏、预览和标签面板，隐藏 / 取消隐藏 / 改名 / 删除画册 | 与既有口径相同；空 order 依赖改听 albums-deleted；本阶段不按图 / 分区收紧 | macOS：画廊（hide 开）、隐藏画册页、任务详情、画册树、画册页头、预览标签面板、插件维度过滤弹层在隐藏 / 取消隐藏 / 收藏 / 改名 / 移动 / 删除画册时照常更新，口径未收紧；本行操作期间挂了 console.error / warn / 未捕获错误收集器，结果为空。畅游页未测 |
| [x] | 成员表外键迁移 | 桌面 CEF / 开发库 | 已有库升级到 v046，迁移前造画册不存在、图片不存在、image_id 为空串的成员行 | 悬空行被清理、其余成员与排序保留，外键检查为 0，索引保留 | 单测覆盖四类脏行；开发库副本实跑 84822 行全保留、0 悬空、外键检查与 integrity_check 通过；dev 重启后真实开发库已升到 v046 |
| [x] | 写入不存在的画册 / 图片 | 桌面 CEF / IPC | 调用 add_images_to_album：画册 id 不存在；画册存在但图片 id 为空串或不存在 | 前者报「画册不存在」；后者 added 0、不写行、不发成员事件 | macOS：两种调用均被拦下，库中 0 行；单测覆盖外键开启下的跳过 |
| [ ] | 虚拟盘 / VS Code 扩展 | Windows / 外部扩展 | 隐藏、加入图片、删除画册后查看目录与背景 | 虚拟盘按 albumId 通知，隐藏画册事件整体失效画册目录；外部扩展按新事件订阅后照常更新 | 主会话已改外部扩展订阅（新旧事件名并列），未联调；虚拟盘 vd_listener 只在 Windows 生效，本机未测 |

自动化验证（2026-10-24，测试与真机分开记录）：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 图片与画册事件协议 | Rust / 临时 SQLite / EventBroadcaster | test-kabegame driver：kabegame-core --lib storage::image_events --features ipc-server | 普通增删不拆分、隐藏成员表含收藏、取消隐藏完整行 / 超限省略、删图标记、排序实际命中；批量新增、根删除、改链连续前缀、转换提升、补丁去位置与按数量分流 | 2 passed；命令与日志见本次交付说明 |
| [x] | 画册存储 | Rust / 内存 SQLite | test-kabegame driver：kabegame-core --lib storage::albums | 层级、改链、标签、类型转换、删除与同步模式保持正确 | 23 passed |
| [x] | 本地文件夹 | Rust / 临时目录 | test-kabegame driver：kabegame-core --lib local_folder | 同步、导入、改链、转换和成员写入不回退 | 41 passed |
| [x] | 前端全量回归 | macOS / Vitest | npx vitest run --maxWorkers=2 | 新事件、补丁、订阅方、连续移动与收起节点路径测试通过 | 51 files passed；529 tests passed。首次运行退出 1（旧夹具失败、无完整汇总）；修正夹具后限制 2 workers 完整通过 |
| [x] | 前端与 Rust 检查 | macOS / standard | check-kabegame driver（deno task check -c kabegame） | vue-tsc 与 cargo check 0 error | 退出码 0；vue-tsc 0 error、cargo 0 error；既有 warnings 保留 |

## 过滤走查 Phase B：前端图片视图按内容刷新

只改前端 refreshOn 与补丁门控，不新增 SQL / 后端命令，不涉及 Phase C / D。
2026-10-23 在 macOS 桌面 CEF dev 真机验证，在事件窗口刷新入口用 debug ingest 按 kind + key 计数（`// DEBUG-FILTER`，验证后已删除）；新增用本地导入代替下载，两者走同一条 `images-added`。未勾选的行未真机验证，自动化测试记录另列。
后台删除页外图只刷新总数、不重读当前页行。
2026-10-24 以同样方法补测剩余项（session `filter-phaseB`，插桩已删除）；测试图、任务、临时画册与畅游记录测后删除，视图、壁纸、Web 服务器已还原。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 不同插件新增 | 桌面 CEF / Android | 画廊筛插件 Y，下载插件 X | 当前网格行与总数 0 次事件重读 | macOS：筛 konachan 导入 local-import，画廊 0 次；对照筛 local-import，行与总数各 1 次 |
| [x] | 不同媒体类型新增 | 桌面 CEF / Android | 画廊筛视频，下载图片 | 当前网格行与总数 0 次事件重读 | macOS：路径 `media-type/video` 下导入 PNG，画廊 0 次 |
| [x] | 默认新增 | 桌面 CEF / Android | 默认画廊下载图片 | 正常刷新行与总数 | 不判断新增排序位置；macOS：行与总数各 1 次 |
| [x] | 跨任务新增 | 桌面 CEF / Android | 任务 A 详情停留，任务 B 下载 | 任务 A 网格 0 次事件重读 | macOS：任务 A 详情页导入（新建任务 B），0 次 |
| [x] | 整理缩略图 | 桌面 CEF / Android | 整理仅补 thumbnailPath / compatiblePath | 就地补丁，0 次事件重读 | 元数据补丁另按查询依赖；macOS（2026-10-24）：导入 >512KB 的 PNG（生成独立缩略图），删其缩略图文件后按区间只开补缩略图整理：单张 `image-changed {thumbnailPath}`、两张 `images-change` 各带 thumbnailPath，画廊行与总数 0 次，卡片元素未重建、img 换成新缩略图；HEIC 测试图删兼容副本后开补兼容副本整理，`image-changed {compatiblePath}`，0 次。Android 未测：无设备 |
| [x] | 设壁纸排序依赖 | 桌面 CEF | 轮播 / 设置壁纸，分别默认排序与按设壁纸时间排序 | 默认 0 次重读；按设壁纸时间重读 | macOS（2026-10-24）：单次 `set_wallpaper_by_image_id`（未开轮播），默认按时间降序只收 `image-changed {lastSetWallpaperAt}`，0 次；按设壁纸时间降序行与总数各 1 次，该图排到首位。测前当前壁纸为 null，测后 `clear_current_wallpaper_image_id` 还原 |
| [x] | 名称依赖 | 桌面 CEF / Android | MCP 改名，分别默认、按名称排序、按名称搜索 | 默认只打补丁；名称排序 / 搜索重读 | macOS：默认排序 0 次；按名称排序行与总数各 1 次（补丁触发由行与总数共用）；2026-10-24 补测：查询 `search/display-name/pb`（核对 computedPath）下改名，行与总数各 1 次，改出搜索词的图被剔除；对照只勾元数据搜索 `search/metadata/pb` 时改名 0 次。Android 未测 |
| [x] | 隐藏显示 | 桌面 CEF / Android | hide 关闭，隐藏一张图 | 图片变灰，不因隐藏事件重读 | 另测后台操作；用户 mutate 仍主动请求；macOS：后台加入隐藏画册，0 次，卡片带 `image-item-hidden` |
| [x] | 隐藏过滤 | 桌面 CEF / Android | hide 开启，隐藏一张图 | 不先变灰，重读后消失；取消隐藏重读补回 | 画册由自身 hide / unhide 事件刷新；macOS：行与总数各 1 次，MutationObserver 全程未见变灰，卡片消失；2026-10-24 补测 hide 开启下 `remove_images_from_album`（隐藏画册）取消隐藏：行与总数各 1 次，图回到原位。注意 hide 开启时任何隐藏成员变化都刷新，即使该图不在当前过滤结果内（筛 konachan 时隐藏 local-import 图，行与总数各 1 次）。Android 未测 |
| [x] | 后台删除页外图 | 桌面 CEF / Android | 从其它入口删除本页外图片 | 本页行不刷新，总数刷新 1 次 | macOS（2026-10-24）：升序第 1 页外删除，仅总数 1 次、行 0 次；对照删除本页图，行与总数各 1 次 |
| [x] | 预览期间下载 | 桌面 CEF / Android | 打开裸 id 预览，再下载新图 | 预览不重新解析；当前图删除才重新解析，字段只打补丁 | 相关成员事件仍重读；macOS：预览中导入并 MCP 改名，弹窗元素未重建，标题经补丁更新 |
| [x] | 任务归属置空 | 桌面 CEF / Android | 删除任务 / 清理已完成任务 | taskId: null 单图 / 批量补丁只打到行与预览（「打开任务」按钮消失），任何网格 0 次事件重读 | 当前任务详情仍按任务删除离开；macOS：画廊开着导入图的预览，从页面外 `delete_task`，画廊 0 次重读（仅 tasks://status 1 次），弹窗未重建，按钮 1→0；2026-10-24 补测 `clear_finished_tasks`（库内只有本次 2 个已完成任务，共 3 张图）：1 条 `images-change` 带 3 个 `taskId: null`，画廊行与总数 0 次、tasks://status 2 次，预览弹窗未重建，按钮 1→0。Android 未测 |
| [x] | 侧栏与畅游计数 | 桌面 CEF / Android / Web | 插件 / 媒体 / 日期 / 大小 / 宽高比组合过滤，改变新增归属与隐藏状态 | 侧栏按减格上下文；畅游按记录 id / surfRecordId 补丁，删除一律刷新，hide 开启才因隐藏刷新 | Web 日期保守视为可能；macOS（2026-10-24，侧栏即维度 chip 下拉面板，只观察打开的面板）：筛 konachan 开媒体面板导入 local-import 图 0 次，开插件面板（减格后无条件）`plugin/_kb_co` 1 次；筛 local-import 开媒体面板 1 次；日期 2020 开大小面板 0 次、2026-10 时 1 次；大小 50MB- 开宽高比面板 0 次、2MB-5MB 时 1 次；宽高比 16x9- 开日期面板导入竖图 0 次、-3x4 时 1 次。插件面板：改名 0 次；hide 开启隐藏 1 次、关闭 0 次；删除 1 次。畅游页 15 个站点计数：本站新增只刷新该站 1 次、其余 0；hide 关闭隐藏 / 取消隐藏 0 次，开启时各站各 1 次；删除各站各 1 次。pluginId / metadataId 补丁未能真机造出（单测覆盖）；Android / Web 未测 |
| [x] | 畅游网格 | 桌面 CEF / Android | 站点图片网格（`/surf/:host/images`）：本站 / 他站新增、hide 开 / 关隐藏、删除 | 本站新增重读、他站 0 次；hide 开启隐藏重读且不先变灰，关闭时 0 次并变灰；删除持有行重读行与总数、页外只刷新总数 | macOS（2026-10-24）：本地 HTTP 服务 + 临时畅游记录 127.0.0.1，内容页调用 `surf_download_image`。127.0.0.1 网格本站新增行与总数各 1 次；hide 开启隐藏行与总数各 1 次、MutationObserver 未见变灰；hide 关闭取消隐藏 / 隐藏 0 次、卡片带 `image-item-hidden`；wallhaven.cc 网格他站新增 0 次、删除页外图仅总数 1 次；127.0.0.1 网格删除持有图行与总数各 1 次。临时记录与图片已删除。Android 未测 |
| [x] | 画册详情 | 桌面 CEF / Android | 画册详情：导入不在画册的新图；把测试图加入 / 移出该画册；hide 开启隐藏画册内测试图 | 导入 0 次；加入 / 移出重读；隐藏重读剔除且不先变灰 | macOS（2026-10-24，临时画册）：导入 0 次；加入、移出各行与总数 1 次；hide 开启隐藏行与总数各 1 次（本画册 `hide` 成员事件），未见变灰，图被剔除；取消隐藏各 1 次补回。临时画册已删除，画册路径设置已还原。Android 未测 |
| [x] | 任务详情隐藏 | 桌面 CEF / Android | 任务详情：hide 开 / 关下隐藏本任务测试图 | hide 开启重读剔除，关闭 0 次并变灰 | macOS（2026-10-24）：hide 开启隐藏行与总数各 1 次、未变灰、图消失，取消隐藏各 1 次补回；hide 关闭隐藏 0 次，卡片带 `image-item-hidden`。Android 未测 |
| [x] | 带过滤时页头分母 | 桌面 CEF | 画廊筛插件 Y，导入插件 X 的图 | 页头「分子 / 未过滤总数」的分母应随新增更新，分子不变 | macOS（2026-10-24）：首测未通过（分母停在旧值）；ImageGrid 计数批在有分母时对任何 images-added 刷新后复测，筛 konachan 导入 local-import 图，页头 `530 / 3922` → `530 / 3923` |
| [ ] | Phase B（其它平台） | Android / Web | 同上各项 | 同上 | 未测：本轮无 Android 设备，Web 不测 |

自动化验证（2026-10-23）：

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Phase B 单测与前端回归 | macOS / Vitest | `deno task test -c kabegame --skip cargo` | 新增判断各维度、秒 / 毫秒日期、unknown、any / not、搜索模式、逐字段依赖、隐藏补丁门控、删除触发（行包含 / 总数全刷）、预览解析、adapter 与计数相关性均通过 | 51 files passed；527 tests passed |
| [x] | 前端类型与 Rust 检查 | macOS / standard | `.claude/skills/check-kabegame/driver.sh`（包装 `deno task check -c kabegame`） | vue-tsc 与 cargo check 通过 | 退出码 0；vue-tsc 0 error、cargo 0 error；既有 warnings 保留 |

## 过滤走查 Phase A：图片事件协议拆分

本节覆盖本次协议拆分；后文既有的 `images-change(reason)` / 隐藏 `image-changed` 记录为历史验收，
不代表当前协议。以下是 Phase A 当时验收记录；刷新相关性以新增的 Phase B 节为准，整理与迁移循环仍待后续阶段。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 字段补丁出口与事件登记 | Rust / EventBroadcaster 全量订阅 | 运行 `storage::image_events`（启用 ipc-server） | 0 张及空字段不发；同 id 合并、后到覆盖；1 张发 patch、多张发 patches；新事件可全量订阅与解析名字 | 2026-10-23：2 passed |
| [x] | 新增完整行与 IPC 载荷往返 | Rust / serde | 运行 `phase_a_image_event_protocol` | images-added 携带完整 camelCase ImageInfo，含 imageMetadataId；反序列化不丢字段 | 同上，覆盖 localPath / crawledAt 等别名 |
| [x] | 删除、隐藏与删除任务出口 | Rust / 临时 SQLite / EventBroadcaster | 实际添加并隐藏 / 取消隐藏 / 删除图片；删除任务、清除完成任务 | 删除只发 images-deleted；隐藏增删仅发 album-images-change；删除 / 清理任务为原属图片发 taskId: null 补丁，再发 TaskDeleted | 2026-10-23 补 taskId 补丁后重跑 `storage::`：102 passed |
| [x] | metadata 迁移补丁与去重 | Rust / V8 / 临时 SQLite | 运行 `metadata_migration` | 每张图片一个最终 metadataId 补丁；去重覆盖最终 id；同 metadata 的图片不再分组共享 diff | 23 passed；循环结构未改 |
| [x] | 整理与查询映射 | Rust | 运行 `organize`、`providers::query::tests` | 缩略图策略与查询不回退，整理仍按原批次发补丁 | 5 + 16 passed |
| [x] | 前端补丁、四 adapter、分面与计数 | Vitest / happy-dom | `deno task test -c kabegame --skip cargo` | 单图 / 多图共用窗口；收藏 / 隐藏独立窗口；四 adapter 保持宽刷新；任务 / 畅游新增从行判断归属 | 49 文件、439 用例通过，含新增 13 项 adapter 矩阵 |
| [x] | 删除任务后离开详情 | Vitest / happy-dom | 任务删除读到空行，分别模拟有 / 无浏览历史 | 有历史 back，否则 replace /gallery；卸载后停止观察 | 随前端全量测试通过 |
| [x] | 主应用与 CLI 回归 | macOS Rust | `deno task test -c kabegame --skip vue -- --lib`（跳过下行受限项）、CLI 全量 | MCP、轮播与 CLI 既有行为不回退 | 主应用 35 passed / 1 filtered；CLI 27 passed；测试时临时创建 target/debug/Frameworks → ../Frameworks，结束清理 |
| [ ] | HTTP 监听路由用例 | macOS 沙箱 Rust | `http_server::tests::media_routes_only_accept_wildcard_path_form` | 本地临时端口绑定后验证媒体路由 | 完整 app --lib 实跑为 35 passed / 1 failed；失败原文：`bind test listener: Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }`。此文件未修改 |
| [x] | 完整类型与编译检查 | macOS standard | `deno task check -c kabegame`（经 check-kabegame driver） | vue-tsc 与 cargo check 均通过 | 最终 0 / 0 error，退出码 0；未运行 cargo fmt -p、未改 third/、未提交 |
| [x] | 本地导入真机链路 | 桌面 CEF dev（macOS） | 经 `start_task` 起 local-import，导入一张带 EXIF 的测试 JPEG | 一条 images-added，完整行；画廊出现新图 | 2026-10-23 macOS CEF dev，debug ingest `phase-a-verify`：1 条 `images-added`，载荷 23 个 camelCase 字段（含 taskId / surfRecordId:null / pluginId:local-import / imageMetadataId:8638），无 images-change / image-changed；画廊 rows 与 count 各请求 1 次，总数 4275→4276，新图在首位 |
| [x] | 下载真机链路 | 桌面 CEF dev（macOS） | safebooru id 范围 1–2、3–4 两个小任务，第二个任务运行时打开其详情页 | images-added 带 taskId 与已挂 imageMetadataId；任务详情刷新 | 同上：每张图一条 `images-added`（4 张，id 8416–8419），均带 taskId、pluginId:safebooru、imageMetadataId 8639–8642；详情页网格在两次新增窗口内各重读 1 次，2 张图出现 |
| [x] | 删除真机链路 | 桌面 CEF dev（macOS） | 右键删除导入的测试图；再批量删除 4 张下载图 | 只发 images-deleted，只带 id；画廊行与总数更新 | 同上：单删 1 条 `images-deleted {imageIds:["8415"]}`，总数 5460→5459（隐藏过滤关闭时）；批量 1 条带 4 个 id，另有既有的按画册拆分 `album-images-change` reason=delete（标签画册 113 条），画廊只请求 2 次；无 image-changed / images-change |
| [ ] | 下载 / 本地导入 / 删除（其它平台） | Android / Web | 同上 | 同上 | 未测：本轮只有 macOS 桌面 dev |
| [x] | 隐藏 / 取消隐藏真机链路 | 桌面 CEF dev（macOS） | 右键隐藏导入的测试图（隐藏过滤开）；关过滤后取消隐藏、再隐藏、再取消隐藏 | 只发 album-images-change add-hidden / delete-hidden；开过滤时剔除，关过滤时变灰 / 恢复 | 2026-10-23 同上：四次操作各只有 1 条 `album-images-change`（reason 依次 add-hidden / delete-hidden / add-hidden / delete-hidden，albumIds 为隐藏画册），0 条 image-changed / images-change；开过滤时图被剔除、总数 4280→4279；关过滤时卡片带 `image-item-hidden` 变灰，取消隐藏后恢复 |
| [x] | MCP 改名真机链路 | 桌面 CEF dev（macOS） / MCP HTTP | 临时开启应用 Web 服务器，MCP `rename_image` 改测试图名称，测完关闭 | 单张 image-changed，字段就地更新，视图照旧刷新 | 同上：1 条 `image-changed {patch:{id:"8415",displayName:"phaseA-renamed.jpg"}}`，无 reason；画廊照旧宽刷新 1 次；预览标题显示新名称 |
| [x] | 设壁纸真机链路 | 桌面 CEF dev（macOS，窗口模式） | 对本地导入的测试图调用 `set_wallpaper_by_image_id` | 单张 image-changed，只带 lastSetWallpaperAt，无 reason | 2026-10-23 macOS CEF dev，debug ingest `phase-a-verify-2`：1 条 `image-changed {seq:12, patch:{id:"8422", lastSetWallpaperAt:1792765473}}`，无 reason；画廊照旧宽刷新 1 次；壁纸窗口显示测试图。测后 `clear_current_wallpaper_image_id` 恢复原状态（原本为 null，壁纸窗口为空），系统桌面图片全程未变 |
| [x] | 原生元数据懒挂载真机链路 | 桌面 CEF dev（macOS） | 把测试图的 `image_metadata.parser_version` 置 0（直接写 dev 库），重载页面后打开其预览 | 单张 image-changed，只带 imageMetadataId；EXIF 面板正常 | 同上：打开预览即触发（原生元数据面板折叠时也会请求），1 条 `image-changed {seq:13, patch:{id:"8422", imageMetadataId:8646}}`；旧行 8645 删除，新行 parser_version=1；展开面板显示 Make / Model / Software 3 项 |
| [x] | 整理补字段真机链路 | 桌面 CEF dev（macOS） | 把两张测试图的 thumbnail_path 置空、其中一张原生元数据置过期（三张原本就没有 compatible_path），只对含测试图的区间 [5455, 5458) 运行整理，只开补缩略图 / 补兼容副本 / 补原生元数据（去重、清除失效、删源文件均关） | 按图片数量分流，多张发 images-change；按 id 合并字段，无 reason；界面就地更新 | 同上：1 条 `images-change {seq:14}` 带 3 个补丁：8420 {thumbnailPath, compatiblePath, imageMetadataId:8647}、8421 {thumbnailPath, compatiblePath}、8422 {compatiblePath}；无 reason；库内字段一致，旧元数据行 8643 删除；画廊卡片照常加载，宽刷新 1 次 |
| [ ] | 整理补字段、原生元数据懒挂载、设壁纸（其它平台） | Android / Web | 同上 | 同上 | 未测：本轮只有 macOS 桌面 dev |
| [x] | 当前任务被删 | 桌面 CEF dev（macOS） | 打开本次创建的 safebooru 任务详情，从页面外调用 `delete_task`（等价抽屉删除） | 无图片事件；详情离开 | 2026-10-23 同上：只有 `tasks-change TaskDeleted`，0 条图片事件；详情页重读任务行为空后回到 /gallery。注意：`images.task_id` 外键为 ON DELETE SET NULL，删任务后该任务图片的 task_id 实际被清空（8418 / 8419 已核实），不发图片事件。此观察早于 tasks.rs 补发 taskId 补丁的改动，改动后的行为见下一行 |
| [x] | 删除任务后原属图片 taskId 补丁 | 桌面 CEF dev（macOS） | 起 1 张、2 张两个 local-import 任务；在普通画廊打开其图片预览并展开「图片信息」，确认有「打开任务」按钮后，从页面外调用 `delete_task` | 1 张发 image-changed、多张发 images-change，补丁为 `{id, taskId: null}`；预览中「打开任务」按钮就地消失，无需重开 | 2026-10-23 macOS CEF dev，debug ingest `phase-a-verify-2`：单图任务 1 条 `image-changed {seq:8, patch:{id:"8420", taskId:null}}`；双图任务 1 条 `images-change {seq:11, patches:[{id:"8421",taskId:null},{id:"8422",taskId:null}]}`；两次 `.detail-open-task-btn` 都从 1 变 0，预览未关闭。「清除已完成任务」未真机测：任务列表里还有用户自己的 1 个已完成任务，会被一起清掉，按约定跳过（Rust `storage::image_events` 已覆盖） |
| [ ] | Windows 虚拟盘 | Windows | VD 浏览时下载 / 删除 / 改名 | 新增通知对应任务目录、图片增删 / 字段补丁刷新画廊树 | 用户确认不测 |


## 原生元数据一图一行

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 独占写入与替换 | Rust / 内存 SQLite（外键开启） | 运行 `storage::images::native_metadata_tests::replace_attaches_new_row_and_deletes_old_row` | 首次挂新行；同哈希图片各占一行；再次写入换新 id、旧行删除 | 2026-10-23：`deno task test -c kabegame-core --skip vue -- --lib native_metadata`，15 passed（含新增 4 项） |
| [x] | 图片不存在 | Rust / 内存 SQLite（外键开启） | 运行 `storage::images::native_metadata_tests::replace_missing_image_returns_error_without_inserting_row` | 返回 `native-metadata:image-not-found`，不插入元数据 | 2026-10-23：`deno task test -c kabegame-core --skip vue -- --lib native_metadata`，15 passed（含新增 4 项） |
| [x] | 历史共享行重解析 | Rust / 内存 SQLite（外键开启） | 运行 `storage::images::native_metadata_tests::replace_preserves_historical_shared_row_with_foreign_keys` | A 换新行成功，B 仍指向旧行，外键拒绝不回滚替换事务 | 2026-10-23：`deno task test -c kabegame-core --skip vue -- --lib native_metadata`，15 passed（含新增 4 项） |
| [x] | 历史共享行删除 | Rust / 内存 SQLite（外键开启） | 运行 `storage::images::native_metadata_tests::remove_preserves_shared_row_until_last_image_is_removed` | 批量移除 A 成功且共享行保留；再单张移除 B 后共享行删除，任务计数与画册成员正常 | 2026-10-23：`deno task test -c kabegame-core --skip vue -- --lib native_metadata`，15 passed（含新增 4 项） |
| [x] | PNG 参数预览与搜索 | 桌面 CEF dev | 打开带 PNG 参数的图片预览，查看原生元数据，再按其中参数搜索 | 面板正常，原生元数据搜索命中；版本过期时换新 id，预览缓存与搜索成员更新 | 2026-10-23 dev（CDP）：图片 437 预览面板渲染 `parameters`，`get_image_native_metadata` 返回 v1，`image_metadata_id` 仍为 2164、未写新行；`search/native-metadata/playing dodoco` 命中 436、437，与库内计数 2 一致。过期：把 2540/6239/7272 共享的行 3607 置 `parser_version=0` 后预览 2540，换上独占新行 8631（v1），3607 被外键拒删而保留，6239/7272 仍指向它。预览缓存与搜索成员的事件刷新未单独观察 |
| [x] | 整理逐图补充 | 桌面 CEF dev | 对两张同哈希且原生元数据缺失或过期的图片执行补充整理 | 两图均解析并独占不同元数据行，补充计数按图片累计 | 2026-10-23 dev（CDP，只开「补充原生元数据」）：上条遗留的 6239/7272 各得 8632/8633，最后一张替换后 3607 删除；另把 2535/6228 共享的 3602 置过期再整理，`organize-finished` 报 `backfilled: 2`，两图得 8636/8637，3602 删除；全程孤儿行 0 |
| [x] | 历史共享行界面删除 | 桌面 CEF dev / SQLite | 只读查询 `SELECT image_metadata_id, COUNT(*) FROM images WHERE image_metadata_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1` 找共享行；在界面删除其中一张，查看另一张预览，再删最后一张 | 首次删除成功、另一张仍显示原生元数据、共享行仍在；最后一张删除后共享行消失 | 2026-10-23 dev（CDP，经用户同意）：共享行 1868（图片 83、6560）。为保留源文件改用「从图库移除」命令（与删除共用删行代码）：`batch_remove_images([6560])` 成功，1868 保留，83 的 `get_image_native_metadata` 仍返回 v1 且未重写；`remove_image(83)` 后 1868 删除，孤儿行 0，两张源文件仍在磁盘 |

编译检查：2026-10-23 `deno task check -c kabegame` 的 vue-tsc 与 kabegame-core 通过；主应用当时因 `surf_get_record_images` 命令注册缺少宏而失败（`src-tauri/kabegame/src/lib.rs:546`），已由用户另行修复，真机 case 运行在 20:30 启动的 dev 构建上。

## 畅游记录移除最新图片字段

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 记录反序列化与站点图片查询 | Rust / 内存 SQLite | 运行 `dsl_e2e::plural_resource_schemas_fetch_and_deserialize_rows` | 删除字段后记录仍可反序列化为 `SurfRecord`，按 host 查询图片及隐藏图片路径正常 | 2026-10-23：1 passed |
| [ ] | 站点记录与事件 | 桌面 CEF | 打开畅游页，进入已有站点，修改站点名称后返回 | 站点列表、名称、图标及访问时间正常；记录读取与新增事件不包含 `lastImage` / `last_image` | |
| [ ] | PathQL 站点元数据 | 桌面 CEF / CLI | 查询 `surf_records://all`、`surf_records://id_<id>`，列举 `images://gallery/surf` | 站点字段与列表正常，均不包含最新图片字段；站点图片仍可按 host 查询 | |

## 插件来源资源、变更事件与推荐配置观察方（Phase C 步骤 1–3）

三种来源按版本寻址；推荐配置统一观察 `plugin://…/recommended` rows。以下 case 交由人工真机验收，
运行时请求与事件次数使用 debug ingest 固定 session 记录，以事件 ts 判定顺序，验完删除临时插桩。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 来源树与版本 | 桌面 CEF / MCP | 展开 plugin:// → installed、byStore；查询错误版本、旧仅 id 路径和未缓存商店插件 | 根 fetch 仍是已安装 lite 列表；根 list 只有 installed/byStore；错误版本和未缓存为空，无下载 | 部分实测（桌面 CEF pathql_list/fetch）：根列 installed/byStore，installed 33 个、byStore 只列 4 个已缓存包；pixiv installed 1.5.2 与 byStore 1.2.11 provider 不同；旧路径、错误版本、未缓存均 not found。MCP 客户端未测 |
| [x] | 商店 provider | 桌面 CEF | 打开未安装但已缓存插件的商店详情 PathQL tab，选择 provider | byStore 对应版本的 provider 列表与 DSL 正常，不要求安装 | anime-pictures 0.7.0 商店详情列出 5 个 provider，与已安装同版本逐字段一致 |
| [ ] | 已安装、商店与预览推荐 | 桌面 CEF / Android / Web | 打开已安装插件详情、未安装商店详情、本地 kgpg 预览及收集对话框 | 对应 installed/byStore/byPreview 推荐均显示，声明顺序不变；导入态正确 | 部分实测（桌面）：pixiv 已安装 9 项、anime-pictures byStore 5 项、konachan 本地 kgpg byPreview 2 项均显示；Android / Web、收集对话框未测 |
| [x] | 首次读取与禁用 | 桌面 CEF / debug ingest | 打开自动配置页推荐 tab，再离开或禁用 | 每个声明推荐的插件 key 读一次；无旧动态 HTTP 请求；禁用无观察 key | 停在「我的配置」tab 0 次；切到推荐 tab 后 12 个插件各读 1 次，均为 installed 路径 |
| [x] | 导入与删除 | 桌面 CEF / debug ingest | 导入一项推荐，再删除最后一项匹配配置 | 每次至多一条该插件 plugin-changed，只含变化 path；只有该插件 key 重读一次，已导入状态跟随变化 | 导入 anihonet「每日手机排行」：1 条 imported:true，仅 anihonet key 重读 1 次，按钮变「已导入」；删除：1 条 imported:false，仅该 key 重读 1 次，按钮恢复 |
| [ ] | 无关配置变化 | 桌面 CEF / debug ingest | 只改配置名、计划时间；导入重复匹配配置 | 推荐导入态不变时无 plugin-changed，推荐 key 0 次读取 | 部分实测：改名 + 计划时间 20:00→21:30：0 条事件、0 次读取；重复匹配配置未测 |
| [ ] | 匹配字段与换插件 | 桌面 CEF | 修改 URL/变量/headers/dry-run，或把配置改为另一个插件 | 相关插件导入态实际变化才推送，旧、新插件各自刷新 | 部分实测：end_page 5→6→5 依次推送 false / true；换插件只有单测覆盖 |
| [ ] | 覆盖安装与卸载 | 桌面 CEF | 同版本重装、升级、卸载插件 | 覆盖安装 plugin-changed 带完整含 version 插件；store 更新；升级换 key 并退订旧 key，旧版本空；卸载无旧缓存内容 | 部分实测：同版本重装 e-shuushuu 推送完整插件 JSON（含 version）、store 同步；在推荐 tab 重装 konachan 只重读 konachan 1 次。升级、卸载未测 |
| [ ] | 失败与竞态 | 桌面 CEF / debug ingest | 推荐读取失败、手动刷新恢复；请求在途时切换来源或版本 | 已有卡片保留；首次失败移除骨架，恢复可重读；旧 key 晚到不覆盖新内容 | |
| [ ] | MCP 推荐发现与权限 | MCP 客户端 / Bundle | 展开三种来源版本下的 recommended，读单个含斜杠 path；关闭 recommended 能力 | 目录 list 声明路径、fetch 有序行；单项为对象；路径按 asset 规则转义；禁用后读取被拒绝 | 预览仅凭已有 token |
| [ ] | 旧 CLI / IPC 返回 | 桌面 CLI / IPC 客户端 | 新增、更新、删除运行配置 | add/update data 保持旧单行，delete 保持 null；前端也直接收到单行/null | 统一观察方后的兼容回归见文末 |

## 删除未挂载的头部筛选下拉

`GalleryFilterControl`（及 `GalleryTimeFilterSubmenu`、时间菜单树函数、`HeaderFeatureId.GalleryFilter`、两个独占 i18n 键）自查询栏改为 chip 后不再挂载，整体删除；时间文案函数 `buildTimeMenuScopeLabels` / `formatTimeFilterDetail` 保留。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 画廊与时间 chip | 桌面 CEF | 整页刷新画廊；在时间 chip 面板选年份，再清除 | 页面无报错、总数正常；chip 显示格式化后的日期文案，清除后恢复「全部时间」 | 2026-10-22：总数 4287，选中后 chip 为「시간별 · 2026 연간」，清除后恢复 |

## 三个小消费方迁到 kbEvents（Phase C）

隐藏图数、畅游站点计数与画册页头部统一观察 pathql `all` key；事件相关性由核心窗口投票，用户操作经 `pathqlRequest$` 请求。2026-10-22 在 macOS CEF dev 上用 debug ingest 按 key 统计请求次数，并用 CLI `pathql query --entry` 核对数值。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 隐藏图数 | 桌面 CEF / Android | 打开清理隐藏图入口，在其它入口隐藏、取消隐藏、清理图片 | 首次显示准确计数，隐藏画册成员变更后更新；无关画册事件不重读 | 桌面：挂载请求 1 次（1,164，与 CLI 一致）；隐藏 1 张 → 请求 1 次、变为 1,165；往无关画册加图 0 次。清理与 Android 未测 |
| [ ] | 畅游首次加载与记录增删 | 桌面 CEF / Android | 进入畅游页，新增 / 删除站点记录 | 每站点计数准确；只请求新进入的 key，删除记录后停止观察对应 key | 桌面首次加载已测：14 个站点各请求 1 次，抽查 3 个与 CLI 一致；记录增删未测 |
| [x] | 畅游 hide 切换 | 桌面 CEF / Android | 切换隐藏过滤，慢请求期间再切回 | 请求新 hide 的各站点 key，新结果到达前保留旧数不闪 0，旧结果不覆盖当前计数 | 桌面：14 个新 key 各请求 1 次，计数 52,4,84 → 52,5,88 直接跳变、无 0（与 CLI 一致），切回恢复；慢请求由单测覆盖 |
| [ ] | 畅游事件范围与离页 | 桌面 CEF + debug ingest | 两个站点同时存在，向单站点下载；离开畅游页后继续下载 | 携带 surfRecordIds 时只刷新对应记录；缺范围时全部刷新，空数组不刷新；离页不再观察 | 只测了缺范围：插件下载不带 surfRecordIds（后端把空数组发成缺省），14 个 key 全部刷新，3 分钟内各 32 次，与旧实现口径相同；单站点下载与离页未测 |
| [ ] | 画册首屏与快速切换 | 桌面 CEF / Android | 直接进入画册详情，快速切换两个画册 | 首屏 loading 同步开启，不误回落收藏；旧 key 的迟到响应不覆盖新画册 | 桌面：停在子画册连续整页刷新 3 次都没有回落；切换画册时 A、B 各请求 1 次；快速切换由单测覆盖 |
| [ ] | 画册类型与计数 | 桌面 CEF / Android | 打开普通 / 本地目录 / 标签 / 标签目录画册 | 名称、祖先、子孙数正确；分别使用子树图片 / 直接图片 / 直接子画册计数，固定空 hide 前缀 | |
| [x] | 画册结构与成员事件 | 桌面 CEF + debug ingest | 改名祖先、移动子画册（检查新旧位置）、删除当前画册；向后代加入 / 移出图片 | 祖先链结构变化更新详情，严格后代结构及成员变化更新计数；无关兄弟不触发；删除当前画册正常回落 | 停在「测试」：自身加 / 移图 A0 B1（277↔278）；父画册加 / 移图 A0 B0；改名自身或父画册 A1 B0；建 / 删子画册 A1 B1；子画册加图 A0 B1；子画册移出 A1 B1；兄弟画册的建、改名、删 A0 B0；删除当前选中的子画册后回落到父画册 |
| [ ] | 刷新与类型转换等待 | 桌面 CEF / Android | 手动刷新，将本地文件夹画册转换为普通画册；制造慢计数与读取失败 | 等 A 与当前 B；A 改变 B 后继续等新 B；失败、切换或离页均无残留等待 / 转圈 | 桌面手动刷新已测：A、B 各请求 1 次，加载遮罩 255ms 消失；转换、慢计数、失败未测（由单测覆盖） |
| [ ] | Web 事件 | Web SSE | 另一窗口修改隐藏图、畅游图片或当前画册 | 与桌面相同的相关 key 更新 | |

## 树模型迁到 pathql 观察方（Phase C）

画册树与侧栏树改为逐页观察 `all` key；只观察可见展开分支，收起保留数据、再展开重读。
结构与补充计数独立，用户操作的 Promise 由模型等待结果，核心请求契约保持即发即返回。
2026-10-22 macOS CEF dev 真机 + debug ingest（`kbEvent$` / 核心请求与投票临时插桩，已删除）验收；分页与读取失败借助临时把树页大小改为 3、给子项查询插入非法段的调试开关，验完还原。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 首次加载 | macOS CEF + debug ingest | 进入画册页 | 4 个分区的结构页与计数各请求 1 次；系统分区隐藏画册计数不带 hide 前缀 | 8 个请求无重复 |
| [x] | 动态下载（展开） | macOS CEF + debug ingest | 展开「好看的视频」，CLI 下载 konachan 1 页（40 张）到其子画册「测试」 | 子项分支只重读计数、结构页不重读；每 key 请求受 500ms 窗口约束；计数随下载增长到准确值 | 61s 内父分支计数 40 次、结构 0 次；测试 179→219、父 182→222 |
| [x] | 展开与收起 | macOS CEF + debug ingest | 收起「好看的视频」后再下载 40 张，再展开 | 收起期间子项分支 0 请求；根分区计数照常更新；再展开结构与计数各补读 1 次 | 65s 内 800+ 事件、子分支 0 请求；测试 219→259 |
| [x] | 分页 | macOS CEF + debug ingest（页大小临时改 3） | 标签分区、子画册分别加载更多 | 只请求新页（结构 + 计数各 1 次），旧页不重读 | |
| [x] | 搜索 | macOS CEF + debug ingest | 输入搜索词再清空 | 各分区逐个替换为新结果，期间不闪空；每个新 key 只请求 1 次；系统分区不重读、按显示名过滤 | 已加载的 2 页标签都按新词重读 |
| [x] | hide 前缀 | macOS CEF + debug ingest | 切换 hide | 只重读依赖前缀的计数（6 个 key 各 1 次），结构页不重读；旧值保留到新值到达 | 好看的视频 262↔280 |
| [x] | 结构与路径 | macOS CEF + debug ingest | 外部调用 add / rename / move / delete / set_label_key | 只刷新路径严格位于其下的可见目录与根分区；收起的目录 0 请求；移动后旧位置无残影 | rename、set_label_key 事件已带 `ancestorPath`；新建画册计数补 0 正确 |
| [x] | 多实例共享 | macOS CEF + debug ingest | 侧栏画册树与「加入画册」选择器同时打开，往画册加一张图 | 共享 key 只请求 1 次，两个实例同时更新 | 选择器挂载时对自己的 key 各请求 1 次（已知边界） |
| [x] | 读取失败 | macOS CEF（调试开关让子项结构查询报错） | 打开开关、点刷新按钮、关闭开关 | 保留上一份子项、无残留转圈；刷新按钮约 0.4s 结束；关闭开关后原 key 重读恢复 | 树内单页失败不会让整次刷新报失败 |
| [x] | 刷新按钮 | macOS CEF | 画册页点刷新 | 当前观察集合请求完成或失败后结束转圈 | 安卓下拉刷新未测 |
| [x] | 侧栏打开时下载 | macOS CEF + debug ingest | 打开日期树并展开 2026 年，下载 40 张 | 两层各按窗口刷新；计数 +40 准确 | 4128→4168 |
| [x] | 侧栏隐藏 | macOS CEF + debug ingest | 关闭日期树弹层期间下载 40 张，再打开 | 关闭期间 0 请求，再打开补读 1 次且计数准确 | 弹层每次打开整树重建，展开态不保留（原有行为） |
| [x] | 高级面板 | macOS CEF + debug ingest | 打开时间候选、收起再展开；候选打开期间下载 40 张 | 下拉不做响应式更新：每次展开重读一次候选；打开期间不随事件刷新 | 候选列举路径为 `…/date/_kb_co` |
| [ ] | 慢计数 | macOS CEF 大标签库 | 展开或刷新，等待图片计数 | 行与子画册数先渲染；旧计数不闪空，extra 先到也正确 | 本机库约 4k 张，计数约 60ms，未能复现秒级场景 |
| [ ] | 插件签名变化 | macOS CEF | 安装 / 更新插件后看插件维度侧栏 | 候选与侧栏插件根刷新 | 未测 |
| [ ] | Web 事件 | Web SSE | 另一窗口增删 / 移动画册、加入成员 | 相关可见页与计数按事件刷新 | 未测 |
| [ ] | Android | Android dev | 画册树展开 / 下拉刷新 / 侧栏 | 同桌面 | 未测 |

## 画廊网格事件与 pathql 数据源迁到 kbEvents（rxjs）

ImageGrid 的行与总数改由 `services/kbEvents` 维护：事件源 `kbEvent$` 与 pathql rows / all 数据源分离，adapter `refreshOn` 每条只对一种事件；写命令（批量删除、加入 / 移出画册、任务图片加入画册）不再带 `view`、不返回快照、照常广播；行读 `pathql_fetch`、总数由 `useLookAll` 观察 `pathql_all` 同快照计数批；行与总数是 pathql 核心上某个 key 的观察方，只看不请求，核心对每个 key 统一 500ms 窗口、任一观察方过滤器同意即刷新。唯一请求入口 `pathqlRequest$.next` 即发即返回，主动请求只有事件窗口与用户操作（路径变化、手动刷新、`ctx.mutate` 完成后）；每个 key 维护 pending 窗口，任一请求返回即取消更早的 pending，观察方看到最后可得的数据与最新请求的 loading / error，失败统一经观察方 `onError`。`dataChangeHub` / `liveQuery` 迁移期保留给其它消费方。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端回归 | macOS Vitest | 全量前端测试 | 全部通过 | 40 个文件、321 项（2026-10-22）；新增 gallery adapter 分母路径与工具栏注入文案用例；kbEvents 用例：防抖窗口、事件共享监听；pending 窗口累计确认（1、2、3 在途，2 先返回即取消 1，3 返回再更新）、loading / error 只属于最新请求且数据可落后于状态、更早请求失败不进状态、新请求清掉旧错误、all key 规范化、整批 results 与 pending 丢弃，序号由前端分配、后注册观察方拿到最后数据与最新状态、无观察方的路径请求返回后即回收；核心窗口：同一 key 多观察方各带过滤器、任一同意即刷新一次并推给全部观察方、统一 500ms 窗口合并多票、观察方全部退订后不再刷新、事件刷新失败推给观察方；观察方：不发请求、最新请求失败调 `onError` 并暴露 `error`、key 为 null 不注册、换 key 后旧结果与旧过滤器不影响新 key |
| [x] | 编译 | macOS | check-kabegame（vue-tsc + cargo check） | 0 error | 本次 vue-tsc 与 cargo check 均通过；web dispatch 在桌面构建中编译，一并覆盖 |
| [x] | 隐藏立即更新 | macOS CEF dev | 画廊右键「隐藏」首张图 | 列表与总数在命令返回后立即更新，不等 500ms；不闪回 | 按 id 校验（后台收集会改变首图与总数，不能只看「首图 + 总数」）：8164 离开网格、`is_hidden=1`、总数 4069→4068；永久删除会删 dev 文件，未真机执行，与隐藏共用 `ctx.mutate` |
| [x] | 请求序列 | debug ingest | 同上操作，记录每次请求的序号 | 操作后直接请求，本次写的事件由核心窗口再请求一次，按序号依次落地；外部写入只有核心窗口请求 | 观察方改造后复测：隐藏时 rows / total 各两次——mutate 用户请求（序号 2）与约 13ms 后核心窗口请求（序号 3，空闲首票立即发出）；外部取消隐藏只由核心窗口各请求 1 次（序号 4），8164 回到首位、`is_hidden=0`、总数回到 4069；临时插桩已删除。`pathqlRequest$` 改造后在视频筛选视图复测（103 / 4057，隐藏 8158）：mutate 请求（序号 2）与事件窗口请求（序号 3）几乎同时发出，3 先返回落地并确认，2 随后返回被丢弃；8158 离开网格、`is_hidden=1`、102 / 4056 |
| [x] | 首次加载与手动刷新 | macOS CEF dev + debug ingest | 整页重载进入画廊；点页头「刷新」 | 行与总数各请求 1 次，观察方先于请求注册；刷新后遮罩收起 | 首次加载与刷新均为 rows / total 各 1 次；`isRefreshing` 随观察方 `loading` 收起，未卡住 |
| [x] | 画廊页头计数（分子 / 分母） | macOS CEF dev + debug ingest | 无筛选进入画廊；切到视频筛选；外部隐藏一张视频再取消隐藏 | 无筛选只读一项 count；有筛选时分子分母同批 `pathql_all`，行另读一次；分子分母同一快照、同次回调更新 | 视频筛选下隐藏 31：rows 与 `all`（`gallery/hide/media-type/video`、`gallery/hide`）各请求 1 次，`all` 返回 `[102, 4050]`；MutationObserver 只记录到 103 / 4051 → 102 / 4050，取消隐藏回到 103 / 4051（`[103, 4051]`）；清空筛选后 `all` 只含 `gallery/hide/all` 一项，页头只显示 4051；数据与筛选已还原、临时插桩已删除 |
| [x] | `pathql_all` 同一读快照 | Rust 单测（临时 WAL 库） | 两条 SQL 计数之间由写连接插入并提交；嵌套读；作用域外再读；panic 后再读 | 批内与嵌套计数相同，作用域外及 panic 清理后能读到新行 | `providers::sql_executor::tests::read_snapshot_pins_connection_and_nested_queries` 已通过；provider 测试共 17 项通过，另覆盖查询类型反序列化、混合批次顺序与整批失败 |
| [ ] | 画册内移除 / 上划移除 / 加入画册 | macOS CEF dev | 画册详情移除图片；加入画册对话框（含任务详情「全部加入」） | 当前画册立即更新；目标画册打开时为新内容 | 收藏画册右键「从画册移除」已实测立即更新；上划移除与加入画册对话框未实测 |
| [x] | 外部写入经事件通道刷新 | macOS CEF dev | 直接调 `remove_images_from_album` 取消隐藏；在收藏画册页直接调 `add_images_to_album` 加收藏 | 画廊 / 画册视图立即刷新，行与总数各读一次 | 防抖首发立即请求；画册视图因包含本画册的 `album-images-change` 刷新，画廊对不相关的收藏变更不触发；测试数据均已还原 |
| [ ] | 后台下载刷新 | macOS CEF dev | 运行收集任务时停留在画廊、任务详情、畅游图片页 | 约 500ms 节奏持续刷新，无关任务 / 畅游记录不触发刷新 | |
| [x] | 离开期间的变更 | macOS CEF dev | 停留在画册页时直接调命令隐藏 / 取消隐藏 8164，再切回画廊 | 回到画廊即为最新行与总数 | 按 id 校验：隐藏后切回 8164 不在、总数 4068，取消隐藏后切回 8164 在首位、总数 4069，行与总数各请求 1 次；`pathqlRequest$` 改造后复测离开期间取消隐藏 8158，切回即在首位、103 / 4057，各请求 1 次；改 kbEvents 源码触发 HMR 后 `@/router` 会重建出未挂到 app 的实例，adapter `isActive` 恒 false、切回画廊为空——属开发期现象，整页重载即恢复，测试前先重载；当前 App.vue 未启用 keep-alive，页面重新挂载读取，旧实例已退订（离开期间无事件日志）；「标脏后重新激活补读」仅单测覆盖 |
| [ ] | 「无画册」与画册改名 | macOS CEF dev | 画廊开启「无画册」，把图片加入画册；改画册名 | 「无画册」视图移除该图；改名后画册视图刷新 | |
| [ ] | Web 版 SSE | Web debug | 另开窗口删除图片 | 画廊经 SSE 事件刷新 | |
| [ ] | Android | Android dev | 隐藏、删除、加入画册 | 与桌面一致 | |

## 画廊字段补丁迁到 kbEvents（Phase B）

ImageGrid 与预览弹窗的字段补丁改用 `imagePatches$`：`image-changed` 与收藏画册的 `album-images-change` 各自经 `batchWindow` 防抖、各自合并成 `imageId → 字段`，再汇成一条交给 `patchMany`；预览弹窗（裸 id 模式）另用 `triggers$` 对 `images-change` / `album-images-change` 重读当前图。两者不再订阅 `dataChangeHub`。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端回归 | macOS Vitest | 全量前端测试 + vue-tsc | 全部通过、0 error | 39 个文件、308 项；新增 `imagePatches$` 用例：两种事件各自开窗、同 id 字段合并、收藏只看收藏画册且按到达顺序取最后一次、无关事件串不发出 |
| [x] | 外部收藏同步 | macOS CEF dev + debug ingest | 页面内直接调 `toggle_image_favorite` 收藏再取消画廊首图（绕开 UI 自身 `ctx.patch`） | 当前行的 `favorite` 随事件立即更新 | 8065：两次各一批补丁，`favorite` true → false，已还原；临时插桩已删除 |
| [x] | `image-changed` 防抖合并 | macOS CEF dev + debug ingest | 直接调命令隐藏 8066，100ms 后取消隐藏 | 首批立即发出 `isHidden: true`，窗口结束时合并发出 `isHidden: false` | 第二批在 +501ms；此时该图因行刷新暂不在视图，结束后回到列表，数据已还原 |
| [ ] | 预览弹窗单图保鲜 | macOS CEF dev | 关闭「预览跟随翻页」，预览一张随后被移出视图的图，再在别处改它的收藏 / 隐藏 | 弹窗内收藏状态即时更新，隐藏后重读当前图 | 裸 id 模式不易触达，未真机 |
| [ ] | Android | Android dev | 后台下载补全缩略图、收藏 | 网格字段即时更新 | |

## 运行配置写后同步（历史验证记录）

以下记录观察方迁移前的实现及当时验证结果，不代表当前统一观察方已完成真机验收。当前行为与待验收用例见文末「运行配置统一观察方与旧通路删除」。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端回归 | macOS Vitest | 全量前端测试 | 全部通过 | 38 个文件、297 项；新增事件早到、同序号去重、切路径、失败释放、其它配置外部事件放行、累计窗口与总数分离、晚到 HTTP 不覆盖导入态用例 |
| [x] | 编译与兼容入口 | macOS | 桌面 vue-tsc / cargo check；CLI 与 Web feature check | 0 error | 使用 check-kabegame 驱动；CLI 需 --skip vue（无前端目录） |
| [x] | 后端相关测试 | macOS core | commands::task::tests | 全部通过 | 8 项，包含导入内容规范化及忽略名称/定时的匹配规则 |
| [x] | 自身新增、编辑、复制与删除 | macOS CEF dev | 新增与 blue-archive 推荐内容相同且禁用定时的临时配置；改名、改 URL、恢复 URL、复制、删除原件、删除副本 | 命令返回时立即同步行与导入态 | false→true→true→false→true→true→true→false；删除原件后有副本仍为已导入；未等待广播 |
| [x] | 自身操作不重复拉取 | debug ingest config-sync | 连续执行以上 7 次写操作并检查带 ts 的记录 | 不额外重读行或整批推荐 JSON；总数单独补读 | config_write_applied 7 次、config_count_read 7 次；写期间 config_view_read / config_recommended_read 均 0；每次返回 45 项导入态；临时插桩已删除 |
| [x] | 实际推荐导入入口 | macOS CEF dev | 调用 importRecommendedPreset 导入无定时预设 | 返回时列表出现、isImported=true | scheduleEnabled=false；随后走旧形状命令删除，验证异步补位 |
| [x] | 外部事件补位 | macOS CEF dev | 不经主动通道直接调用 delete_run_config | 事件后更新当前行、总数和推荐导入态 | 700ms 后 isImported=false、行已移除；debug ingest 确认补读行与推荐 JSON；未包装 invoke |
| [x] | 筛选移入与移出 | macOS CEF dev | 搜索 config-sync-filter；新增匹配项，再把名字改出筛选范围 | 写响应中的当前视图立即变为 1 行、0 行 | 总数由独立通道更新，不由前端插入/排序推算 |
| [x] | 清理与目视 | macOS CEF dev | 删除本轮全部临时配置，恢复原筛选 | 不遗留数据或定时任务；推荐卡片完整 | 5 条原配置、total=5、45 张已加载推荐卡；已目视截图 /tmp/kabegame-config-sync.png；未启用临时定时任务 |
| [ ] | Android | Android dev | 同样执行导入、编辑和删除 | 与桌面一致 | 沿用既有环境限制：缺 adb 与 Android rusty_v8 / FFmpeg 自建产物，待真机验证 |

## 插件文件按需读取（`/plugin_file`，版本参数 `v`）

列表与事件仅带清单、图标和资源键；文档、模板、推荐配置、资源及脚本从 kgpg 按需读取。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端测试与检查 | macOS | 前端全量 Vitest、check-kabegame、CLI 与 Web feature 检查 | 全部通过 | 前端 292 项；桌面、CLI、Web 类型检查 0 error |
| [x] | 轻量列表 | macOS CEF dev | 读取 `get_plugins`，进入源列表 | 不含 doc / changelog / assets / descriptionTemplate / recommendedConfigs；不预取插件文件 | 35 条记录均无旧字段；debug ingest 只出现 plugin_list_loaded |
| [x] | 白名单、限额与快照 | core 单测 | 运行 plugin:: 过滤集 | 版本/来源隔离、越界拒绝、2MB/10MB 限额、8 项预览 LRU、按需脚本冻结、推荐导入态正确 | 104 项通过，含 package_file 6 项 |
| [x] | HTTP 条件请求与版本 | macOS CEF dev | 文档请求；携带 ETag 再请求；缺失或错误 v | 200 / 304 / 404；文本 UTF-8、普通 no-cache | anime-pictures README 实测 |
| [x] | 文档、更新日志与配图 | macOS CEF dev | 打开 anime-pictures，切更新日志 | 当前语言文档、default 更新日志与 HTTP 图片正常 | 韩文 README；7 个图片元素 complete 且 naturalWidth > 0；已目视截图 |
| [x] | 按 tab 触发 | debug ingest | 从列表打开文档，再切更新日志与配置 | 相应页面才请求对应文件 | README.ko.md → CHANGELOG.md → 5 条推荐 JSON |
| [x] | 商店详情与来源 | macOS CEF dev | 强制进入同版本商店详情，读取带 source 的文档 | 仅从对应商店包读取，与已安装来源隔离 | official_github_release/anime-pictures 返回 store 来源、HTTP 200 |
| [x] | 导入文件预览 | macOS CEF dev | 用 kgpg 预览返回的 preview token 请求正文 | 无需安装即可显示文档；LRU 淘汰后 404 | 导入预览 token 文档实测 200；LRU 淘汰由单测覆盖 |
| [x] | EJS 模板 | macOS CEF dev | 打开已有插件 metadata 的图片详情 | 等模板到达后渲染 iframe，不先闪原始 metadata | X WebView 图片详情 iframe 成功渲染；模板请求由 debug ingest 确认，加载态/晚到请求由前端单测覆盖 |
| [x] | 推荐逐项加载与导入态 | macOS CEF dev | 打开自动配置推荐；导入并删除一个临时禁用定时的预设配置 | 原位替换骨架；导入态随运行配置事件更新 | 45 个占位 → 45 张卡；临时配置导入态 false→true→false，已删除且未启用定时 |
| [x] | MCP 资源 | macOS CEF dev | PathQL 读取 plugin://anime-pictures/doc 与 asset/doc-icon.png | 原有 doc / key / mime / dataBase64 形状不变 | 文档 1 行；doc-icon.png MIME image/png、base64 长 56696 |
| [x] | Web debug | macOS 独立 Web debug + Chromium | 用隔离数据库启动 Web 后端 7490、Vite 1422；打开插件列表、文档、更新日志和配置 | 轻量列表与文档、图片可加载，不逐插件补详情 | 4 条轻量记录（2 已安装 + 2 内建）；debug ingest：get_plugins 1 次、get_plugin_detail 0 次；README.en.md、default CHANGELOG、7 个图片元素均正常；5 条推荐配置，no-store；同源请求 200 / 304 / 错误 v 404 |
| [x] | Web dev 文件代理 | macOS 独立 Web debug | 经 Vite 请求 `/plugin_file/anime-pictures/README.md?v=0.7.0` | 请求转发到 Rust 文件服务，返回 Markdown | 发现并修复代理清单遗漏：修复前 200 text/html（SPA 回退），修复后 200 text/markdown；正文与 banner 图片实测正常 |
| [ ] | Android | Android | 经 Kotlin LocalHttpServer 读文档与图片 | 单 host 转发，版本与缓存头生效 | 2026-10-21 复核：adb 未安装；bin/android/arm64/{rusty_v8-build,FFmpeg-build} 均缺失，无法连接设备或交叉编译；保留待测 |

## 任务级 dry-run（`isDryRun`）

任务记录与自动配置新增冻结字段 `isDryRun`。空跑仍执行插件请求、翻页、解析、日志和进度，但下载队列、
metadata 写入与本地导入后处理在宿主单点短路；任务应以 0 成功、0 失败正常完成。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 数据库迁移 | v042 数据库 | 启动新版应用并查看 schema | 升到 v043；`tasks` / `run_configs.is_dry_run` 默认 0 | dev 库实测 user_version=43，既有 268 条任务均为 0 |
| [x] | V8 dry-run | dev CLI | `plugin run <kgpg> --dry-run --var end_page=1` | 有启动提示和逐图跳过日志；Completed，计数为 0，images / metadata 无新增 | wallhaven 经主程序与 `--via local` 各跑一次：print 级启动提示，24 条跳过下载 |
| [x] | 仅打印配置 | dev CLI | 同一插件改用 `--print-config` | 只打印最终配置，不创建任务、不联网 | 经主程序（协议 v3）执行，tasks 行数不变 |
| [x] | 三类前端入口 | 桌面 CEF | 插件收集、网页收集、本地导入分别打开 dry-run 并提交 | 卡片显示空跑徽标；运行参数显示空跑；三类任务均不入库 | 选源前打开的开关会带入；网页收集 V8 / WebView 后端分别跳过 35 / 29 个下载，快照不写 metadata；本地导入逐文件跳过 |
| [x] | 回填与自动任务 | 桌面 CEF | 再次执行 dry-run 任务；保存为自动任务并触发 | 开关保持；定时任务的 `tasks.is_dry_run = 1` | 自动任务详情与编辑页均显示开启；`run_missed_configs` 触发出 scheduled 任务 |
| [x] | 推荐配置 | 桌面 CEF | 导入带 `isDryRun: true` + `scheduleSpec` 的临时推荐配置 | RunConfig 保留字段，定时触发为空跑；导出仍含 `isDryRun` | 用原始预设 JSON 走 `parsePluginRecommendedPreset` → `importRecommendedPreset` → `runConfigToPresetJson`，未经插件打包；临时配置已删除 |
| [x] | 空跑跳过计数 | dev CLI + 桌面 CEF | 空跑 wallhaven 1 页（经主程序与 `--via local`） | `tasks.dedup_count` 为跳过数，其余计数 0；任务卡片、详情与运行参数只显示一个「空跑跳过」数字；CLI 进度条显示「空跑跳过 N」，结束行为「完成 空跑跳过 N 个」 | 实测 24（进度条从 0 递增到 24）；卡片提示「空跑跳过 24 个」，运行参数「空跑跳过 = 24 个」 |
| [ ] | WebView common | WebView 插件 | 输出 `Kabegame.common.isDryRun` | 普通任务为 false，空跑为 true；`Kabegame.vars` 不混入该 key | 网页收集 WebView 后端带新占位符的 bootstrap 正常运行；`Kabegame.common` 为闭包局部，CDP 读不到，值待用 WebView 插件打印 |
| [ ] | common.baseUrl | V8 / WebView 插件 | 输出 `common.baseUrl` / `Kabegame.common.baseUrl` | 等于插件 `kbBaseUrl`（空串为 null）；不再有 `base_url` 键 | V8 由 `plugin::v8` 单测断言通过；WebView 同上待测 |

## 插件路径类变量（只读 `input` 挂载）

路径类变量（`path` / `file` / `folder` / `file_or_folder`）在任务冻结时解析成 `PluginVfs` 的只读 `input`
挂载，脚本拿到的是虚拟路径（文件 `/{handle}/input/<key>/<文件名>`、文件夹 `/{handle}/input/<key>`），
宿主绝对路径不再进入 JS；`data|cache|tmp` 三个可写挂载与 `downloadImage()` 行为不变。Android 只支持
单个文件（`content://`），文件夹变量在冻结时报错。收集弹窗的路径控件同时获得拖入能力。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 后端单测 | macOS | `test-kabegame/driver.sh kabegame-core --lib plugin::vfs`、`--lib input_mounts`、`--lib try_new_mounts_inputs`、`--lib downloads_from_read_only_input_mount` | 19 + 8 + 1 + 1 项全部通过 | 已运行 |
| [ ] | 文件变量读取 | 桌面 dev | 临时 V8 插件声明 `file` 变量；`plugin run <kgpg> --id kb-input-test --var src=/abs/a.png` | 脚本 `readFile(custom.src)` 读到的内容与源文件一致，`downloadImage(custom.src)` 成功入库，源文件内容/时间不变 | |
| [ ] | 文件夹变量读取 | 桌面 dev | 同一插件声明 `folder` 变量并 `readDir` / 逐文件 `downloadImage` | 整棵子树可读并入库；写入 `input`、rename、删除均报权限错误 | |
| [ ] | 虚拟路径不可写 | 桌面 dev | 脚本对 `custom.src` 调 `writeFile` / `remove` / `rename`，再复制到 `tmp` | 前三者被拒绝（PermissionDenied），复制到 `tmp` 成功 | |
| [ ] | 重复执行重新解析 | 桌面 dev | 任务「再次执行」，期间移动源文件 | 冻结时报「配置不合法」或使用新路径，不会沿用旧挂载 | |
| [ ] | 内建插件不回归 | 桌面 dev | 本地导入、网页收集各跑一次 | 行为不变，不出现 `input` 挂载报错 | |
| [ ] | Android 文件变量 | Android 真机 | 收集弹窗选择文件后启动任务 | 脚本可读到该文件并入图库；文件夹变量在启动前提示不支持 | |
| [ ] | 路径控件拖入 | 桌面 CEF | 收集弹窗中把单个图片 / 单个文件夹拖到路径控件 | 出现「设为「xxx」」浮层，松手后变量被写入；`file_or_folder` 的分段控件切到对应模式 | |
| [ ] | 路径控件拒绝 | 桌面 CEF | 拖入多个文件、拖入目录到 `file` 变量、拖入扩展名不匹配的文件 | 提示「此处不支持拖入这些文件」，变量不变 | |

## 拖入热区改为 `<DragFileZone>` + z 序命中

`v-drag-file` 指令重构为组件：注册表持有响应式 props，命中改为 `document.elementsFromPoint` 取最上层
元素后沿父链找最近热区。修复收集弹窗开着时拖到弹窗上仍导入画廊的问题。画廊 / 画册 / 插件页原有拖入
行为与 `v-pull-to-refresh` 保持不变。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端类型检查 | macOS | `deno task check -c kabegame --skip cargo` | 0 error | 已运行 |
| [x] | 前端全量单测 | macOS | `cd apps/kabegame && NODE_ENV=test deno task test` | 33 个文件 / 271 项全部通过 | `NODE_ENV=production` 下 `@vue/test-utils` 无法记录 emitted，须用 test 环境 |
| [x] | 旧指令清理 | 仓库文本检索 | `grep -rn "v-drag-file\|directives/dragFile" apps/kabegame/src` | 无结果 | |
| [ ] | 弹窗遮挡修复 | 桌面 CEF | 打开收集弹窗，把外部文件拖到弹窗任意区域 | 提示「此处不支持拖入这些文件」，画廊不新增任务 | 原先会导入画廊 |
| [ ] | 画廊拖入不回归 | 桌面 CEF | 把图片 / 视频 / 文件夹拖到画廊网格 | 浮层与 local-import 导入与之前一致 | |
| [ ] | 画册拖入不回归 | 桌面 CEF | 在普通画册、文件夹画册、收藏、隐藏、标签目录分别拖入 | 普通 / local_folder 导入选中画册；收藏 / 隐藏 / 标签目录提示不支持 | |
| [ ] | 插件页拖入 | 桌面 CEF | 把 `.kgpg` 拖到插件页 | 安装插件；同时拖入非 kgpg 不入列表 | |
| [ ] | 下拉刷新 | 桌面 CEF / Android | 插件页、画册页下拉 | `v-pull-to-refresh` 仍然生效 | 指令挂在组件根元素上 |
| [ ] | v-loading 命中 | 桌面 CEF | 页面 loading 遮罩显示时拖入 | 浮层仍按页面热区显示（父链命中） | |

## 运行配置页 chip、卡片网格与定时规则扩展

运行配置通过相关子查询关联最后一次任务，页面改为 chip 过滤和页码追加的卡片网格；推荐配置由后端按内容判断
是否已导入。定时 JSON 新增 `hourly`，`weekly` 支持 `weekdays` 多选，v045 会规范化旧数据。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 静态检查与自动测试 | macOS | `deno task check -c kabegame`；定向 core / DSL 测试；前端 Vitest | vue-tsc、cargo check、DSL、迁移、比较口径和定时预览测试全部通过 | DSL 新用例 1 项；ScheduleSpec/v045 2 项；导入比较 1 项；Vitest 35 文件 / 281 项 |
| [x] | 卡片网格与 chip | 桌面 CEF / Web | 切换两个 tab，逐项打开搜索、状态、结果、插件、模式、导入状态 chip | 网格布局稳定；未选择仅显示图标，选择后显示值；打开下拉才查询后端 facet 计数 | macOS CEF 实测：1200px 窗口一行 4 张、卡片 265×137；计数为 0 的取值灰显 (0)；Web 未测 |
| [ ] | 六种排序与分页 | 桌面 CEF / Web | 六种排序均切换正反方向并加载多页 | 顺序与 DSL 一致、无重复；`next` 无计划项在两个方向都位于末尾 | macOS CEF 只验证了「名称 · 倒序」与默认排序的切换和 tooltip；dev 库只有 2 条配置，多页未测 |
| [ ] | 最后任务实时补丁 | 桌面 CEF / Web | 立即运行失败配置、等待结束，再删除最后任务 | 卡片立即进入运行中并转终态；失败过滤下按状态移入/移出；删除后回落到上一任务 | macOS CEF 已过：立即运行后 2s 内转「运行中」，张数实时增长，结束转「成功 · +17 张」；「从未运行」过滤下运行后 500ms 内移出、总数减一。失败路径与删除最后任务未测 |
| [x] | 推荐导入判定 | 桌面 CEF / Web | 导入推荐后改名、改定时、改 user_config | 改名/定时仍为已导入；内容字段变化后恢复未导入 | macOS CEF：45 条推荐逐条走真实导入流程后全部判定已导入、无交叉命中；关定时、改名仍已导入；改 `rating` 后恢复未导入（测试配置已删除） |
| [x] | 定时编辑器 | 桌面 CEF / Web | 设置每小时 :30、每周一三五 08:00，保存并重开 | 卡片、详情、预览与后端下次计划一致；星期多选保留 | macOS CEF：工作日 08:00、每小时 :30、键入 09:05 均保存成功，卡片下次运行与预览一致；时间框固定 24 小时制 |
| [ ] | v045 旧数据 | 含旧 schedule_spec 的数据库 | 启动迁移 daily hour=-1 与 weekly weekday | 分别改写为 hourly 与 weekdays 数组，原计划语义不变 | |
| [ ] | 详情最近任务 | 桌面 CEF / Web | 打开最近失败配置详情 | 顶部显示失败原因，下方最近任务支持打开图片、日志和运行参数 | macOS CEF 已看到「最近任务」列出刚完成的任务；失败提示条未测（无失败配置） |

## 任务列表与自动配置改为 PathQL 分页按需加载

`crawlerStore` 不再在启动时全量拉取任务与运行配置。启动只查询一次 `tasks://status`（各状态计数）作为徽章，之后随
`tasks-change` 去抖重拉；任务抽屉、自动配置页、配置卡片下的关联任务、任务详情、自动配置弹窗各自在可见期间经
`tasks://` / `run_configs://` 分页（游标 `before_<排序键>_<id>`）或按 id 查询，关闭时清空并退订。用户触发的写操作
（调并发、删除任务、清除全部、新建 / 复制 / 编辑 / 删除配置、切换定时）由命令当场返回结果，调用方立即应用。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | DSL e2e | macOS | `test-kabegame/driver.sh kabegame-core --test dsl_e2e` | 54 项通过，含 tasks / run_configs 过滤、状态计数与游标翻页一致性用例 | 已运行 |
| [x] | 迁移单测 | macOS | `test-kabegame/driver.sh kabegame-core --lib migrations` | 25 项通过（含 v044 `idx_tasks_run_config`） | 已运行 |
| [x] | 前端单测与类型检查 | macOS | `deno task check -c kabegame`；`apps/kabegame` 下 `deno task test --run` | vue-tsc / cargo check 无错；Vitest 278 项通过 | 已运行 |
| [x] | 启动请求 | 桌面 dev | 启动后用 debug ingest 统计任务相关调用 | 只有一次 `tasks://status`，没有 `get_all_tasks` / `get_run_configs` | 刷新 `/gallery` 后统计全部 invoke：任务相关仅 `pathql_list tasks://status` 1 次，无 `get_all_tasks` / `get_run_configs`，也无 `run_configs://` 请求；`tasks-change` 订阅者 1 个（徽章），`auto-config-change` 无订阅 |
| [x] | 抽屉首屏与翻页 | 桌面 dev（任务数 > 40） | 打开抽屉并滚动到底 | 首次只拉 20 条加 1 次 count；触底追加下一页，无重复、无遗漏；标题数字等于总数 | 296 条任务：打开时 `tasks://x20x/1` + `pathql_count tasks://` 各 1 次；滚到底共 14 次 `before_<ts>_<id>/x20x/1`，得到 296 条、去重后 296，顺序与一次性 `tasks://x400x/1` 完全一致；标题 296 |
| [x] | 关闭释放与搜索记忆 | 桌面 dev | 输入搜索词后关闭抽屉，再打开 | 关闭后行数据清空、只剩徽章一个 `tasks-change` 处理器；再次打开重新拉取，搜索词保留 | 输入 `hydrus` 得 16 条；关闭后行数 0，`tasks-change` 订阅者 2→1、`auto-config-change` 1→0；再开重新发 `~any/plugin/hydrus/~or/plugin_search/hydrus/~end/x20x/1` + count，输入框仍为 `hydrus`、16 条 |
| [x] | 搜索下推 | 桌面 dev | 分别按插件显示名、插件 id 片段搜索 | 结果与改造前前端过滤一致；结果为空时显示空态 | 17 个词（显示名 `二次元` 11 / `哲风` 2 / `收集` 3 / `本地` 20，id 片段 `AIBooru` 11 / `test` 179 / `nulltest` 35 / `yand` 10 / `PIX` 11 / `-test` 144 / ` hydrus ` 16，以及 `_` `%` `a/b` `'` `~` `zzzqqq`）滚到底后与全量按「插件 id 或显示名子串」前端过滤的 id 序列逐项相同；0 条时显示空态 |
| [x] | 开启期间实时更新 | 桌面 dev | 抽屉打开时新建任务、停止、等待完成 | 新任务插到顶部、进度与状态实时变化；徽章同步 | 抽屉打开时起两个 hydrus 任务：两者依次插到顶部，总数 296→298；A 进度 0→10→…→99.9（waiting_downloads）→100 completed、成功 10；B 成功 3 时停止，下一次采样即 canceled；徽章运行中 0→2→1→0，`statusCounts` 与库一致 |
| [ ] | 写操作当场生效 | 桌面 dev | 删除单个任务、清除全部、调任务并发 | 命令返回即更新行与计数，不等事件；随后到达的事件不导致重复或闪回 | 删除与调并发已通过：UI 删除自建任务后命令路径 `remove` 命中（总数 299→298、canceled 22→21），随后 `TaskDeleted` 再 `remove` 未命中，不重复扣减；运行中任务点「−」「+」，`set_task_max_concurrent_downloads` 返回行即 `patch`（第二次早于事件 3ms），之后两条 `TaskChanged` 与进度事件均无回退。清除全部只验证到确认弹窗：按钮「清除所有任务 (297)」、文案「共 297 个（0 个等待中的任务和 1 个运行中的任务将被保留）」与 `statusCounts` 一致，已点取消。**`clear_finished_tasks` 本身需人工执行** |
| [x] | 配置改名同步 | 桌面 dev | 抽屉打开时到自动配置页改名、再删除某配置 | 抽屉里该配置的定时任务名称随之更新；删除后点定时图标提示配置已删除 | 用自建配置与其 scheduled 任务：改名后抽屉行 `runConfigName` A→B，定时图标 aria 同步为新名；删除配置后该行 `runConfigName` 为 null，点定时图标提示「关联的运行配置已不存在」，未打开弹窗 |
| [x] | 自动配置页 | 桌面 dev | 切换「全部 / 仅启用」与插件过滤，滚动列表；复制、切换定时、删除配置 | 列表与各计数和改造前一致；写操作当场生效 | 修复：从别处（如抽屉里打开的配置弹窗）把一条较旧的配置改成匹配当前过滤时，`usePagedRunConfigs.upsert` 只在它比末行新时才插入，列表已加载完也不补，表现为「仅启用 + hydrus」副标题 11 条、列表只有 10 行。改为「比末行新或已无下一页」即插入，首页返回后先按首页判定有无下一页再合并缓冲事件。复测：外部关闭再开启后行数 11→10→11、末行回到该配置；未过滤且还有下一页时改名旧配置不插入，滚到底 24 条无重复。另以 22 条自建配置（含同 createdAt）测 2×3 种过滤：行序与全量按 `created_at DESC, id DESC` 前端过滤一致，副标题、两个下拉计数均与改造前算法一致；复制、关定时、删除返回即更新行与计数，1.2s 后无重复 |
| [x] | 关联任务分页 | 桌面 dev | 展开某配置卡片的任务列表并滚动到底 | 只加载该配置的任务，可触底翻页 | 自建配置挂 23 个空跑任务：首屏 20 条、hasMore；触底发 `tasks://run_config/<id>/before_<ts>_<id>/x20x/1` 后 23 条，全部属于该配置，顺序与一次性查询一致；只有虚拟列表可见的卡片发 `tasks://run_config/...` 请求 |
| [x] | 定时任务实时出现 | 桌面 dev | 停留在自动配置页，对某配置 `run_missed_configs` 触发一次调度 | 调度器创建的 scheduled 任务立即出现在该配置卡片下，其它卡片不变 | 修复：调度器 `schedule_trigger_once` 写库后没发 `TaskAdded`（改造前靠前端对未知任务的 `TaskChanged` 补拉掩盖），现已补发。实测卡片任务数 2→3，另一卡片 matches=false 未插入 |
| [x] | 任务详情 | 桌面 dev | 新建 hydrus 任务后立即进入其详情页；完成后切到画廊再跑一个任务 | header 已下载数随事件实时增长，运行时间在运行期每秒走、终态停住；离开页面后不再收到本页事件 | 修复：订阅原本挂在 route watch 的 `newId !== taskId` 分支上，路由 store 先同步了 taskId 导致从不订阅（计数停在 0、运行时间为负），且无 keep-alive 时缺 `onUnmounted` 清理会泄漏。改为随组件生命周期 `startLive` / `stopLive`，计时器由任务状态驱动。实测 0→2→4→6 与 DB 一致；离开后订阅者回到 1 |
| [ ] | Android 事件更新 | Android 真机 | 抽屉或任务详情打开时运行任务 | 进度、计数与状态只靠 `tasks-change` 事件实时更新（已去掉安卓每秒兜底轮询），全程不出现卡在运行中 | |


## 运行配置统一观察方与旧通路删除

运行配置写命令只返回保存后的单行/null；列表、总数、页头失败数与详情通过 kbEvents 观察方保鲜。
任务张数等展示字段只补丁当前最后任务，任务新增/状态变化/删除由核心窗口触发重读。
以下桌面项为 macOS CEF dev 实测（2026-10-22），请求次数来自 debug ingest（只记 `run_configs://` 的 `pathqlRequest$`），插桩已删除；Web SSE 单列一行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 列表首读 | 桌面 CEF | 打开有超过 20 条配置的自动配置页 | 一次 all key 同批读取首 20 行和总数，hasMore 正确，加载态正常结束 | 5 条时：进入页面列表一次 all key（`x20x/1` + count）、失败数一次 list。46 条时：重新 `start` 只发 1 个 `x20x/1` key，20 行、总数 46、hasMore=true、loading 结束；连续新建 41 条只合并为列表 2 次、失败数 2 次 |
| [x] | 换筛选与排序 | 桌面 CEF | 切换状态、最近结果、插件、模式与六种排序及方向 | 换 key 并清空旧行，新行与总数符合路径；旧响应不覆盖新结果 | 11 个筛选值 + 6 种排序×2 方向 + 组合筛选，每次换路径恰好 1 个请求、同步清空为 0 行，落地行序与直接 `pathql_fetch` 完全一致、总数一致；同一 tick 改两个维度只请求 1 次；路径不变不请求；2ms 内连切 enabled→paused 最终为 paused 结果 |
| [x] | 加载更多 | 桌面 CEF | 连续加载第二、三页 | 累计窗口扩大，行与总数同批更新，最终无更多时停止 | 46 条：`x40x/1` → 40 行、`x60x/1` → 46 行且 hasMore=false，各 1 个请求；再调用不发请求；UI「+더 보기」按钮点击同样生效。加载到第三页后新增/删除配置，刷新的是 `x60x/1` 累计窗口（47→46） |
| [x] | 加载更多失败重试 | 桌面 CEF | 让第二页读取失败，再恢复并重试 | 保留首屏数据，重试同一目标 key，不跳页，成功后可继续下一页 | 临时插桩让 `x40x` 的下一次读取 reject：首屏 20 行与总数保留；再点仍请求同一 `x40x/1` key，成功 40 行，再点到 `x60x/1`。失败时界面无错误提示（列表未传 onError） |
| [x] | 新增、导入与复制 | 桌面 CEF | 新建、从推荐导入、复制配置 | 命令返回单行，列表与总数经事件刷新 | `addRunConfig` 返回规整单行（18 字段，无外层包装），列表与失败数各 1 次；从推荐 tab 经页面 `importPreset` 导入 anime-pictures/blue-archive，总数 +1、卡片显示「가져옴」；复制返回单行、总数 +1 |
| [x] | 编辑、开关与删除 | 桌面 CEF | 改名、切换定时开关、删除当前窗口配置 | 每次写后列表与失败数各刷新 1 次 | 历史部分实测（改名、dry-run、删除）之外：`enabled` 筛选下关定时（移出 4→3）、开定时（移入 3→4），`paused` 筛选下关定时移入（42→43）、开定时移出（43→42），每次列表与失败数各 1 次，结果与路径一致 |
| [ ] | 运行中展示补丁 | 桌面 CEF + debug ingest | 运行配置任务，观察成功/失败张数、错误与结束时间；仅改变进度 | 只补丁 lastTask 匹配行，不发请求 | 未跑真实下载（dry-run 张数恒 0）。改用 `plugin:event\|emit` 发合成 `tasks-change`：只含 progress 的 TaskChanged 不改行、不请求；含 `successCount:7, failedCount:2` 的 diff 立即补到 lastTask，期间 0 个 `run_configs://` 请求。真实运行中张数变化待测 |
| [ ] | 任务新增、状态与删除 | 桌面 CEF + debug ingest | 新增配置任务、推进状态、删除最近任务；再改变手动任务状态 | 新增/状态/删除各按窗口刷新 | 新增立即刷新 1 次、窗口合并 pending/running/failed 再 1 次；删除最近任务刷新 1 次：只有该任务时回到未运行，前面还有失败任务时回退到 failed（失败数 0→1）。不属于配置的手动任务状态变化未测 |
| [x] | 页头失败数 | 桌面 CEF | 制造失败、恢复成功、删除最近失败任务与配置 | 失败数随最近结果变化 | aibooru tags 模式填 5 个标签制造 dry-run 失败：页头出现「최근 실패 1개」；再跑成功的 dry-run 任务 → 0；删除该成功任务回退到失败 → 1；删除最近失败的配置 → 0；只有失败任务时删除任务 1→0 |
| [x] | 详情保存后更新 | 桌面 CEF | 打开查看或直接编辑配置并保存，再从外部改名 | 首读不误报缺失，保存后回查看态并显示新内容 | `openExisting(id,"edit")`：首读期间 configLoading=true、showMissing 始终 false、`.acd-missing` 从未出现，约 50ms 后表单填入；改名称/描述后 `handleSave`，回到查看态显示新名与描述，详情 key 首读 1 次 + 保存后事件 1 次。外部改名（历史实测）弹窗刷新 1 次 |
| [x] | 详情被删除 | 桌面 CEF | 打开详情后从另一入口删除；再快速切换配置 | 空 rows 显示已删除，迟到结果不覆盖当前配置 | 弹窗开着时 store 删除：显示「관련 실행 설정을 찾을 수 없습니다」，configLoading=false。A→B 快速切换后手动再请求 A 的 key 并改名 A：弹窗仍是 B，A 的改名不触发弹窗刷新 |
| [ ] | 任务关联配置名 | 桌面 CEF | 打开任务列表时改名、删除关联配置（含首屏读取期间） | 启动期事件不丢，改名后关联行显示新名，删除后清空配置名 | 任务抽屉：改名后行数据与定时图标 title 变为新名；删除后 runConfigName=null，title 回退显示配置 id。`start()` 后立即改名结果正确，但首屏读取与写入先后无法区分（可能直接读到新名），启动期缓冲未被确定性覆盖；配置详情里的关联任务列表（AutoConfigRelatedTasks）未实测 |
| [x] | 推荐导入态 | 桌面 CEF | 导入、编辑匹配字段、复制与删除最后一个匹配配置 | 仍由 plugin-changed 刷新相关来源版本的 recommended 行，计划/名称变更不触发无关推荐读取 | 导入→已导入，recommended 请求 1 次；复制、改副本名称、改副本 userConfig（使其不再匹配）均 0 次请求、仍已导入；删除原件（最后一个匹配）→ 未导入、请求 1 次；删除副本 0 次 |
| [x] | 旧 CLI / app IPC 兼容 | 桌面 CLI + app IPC | 用原请求格式新增、更新、删除配置 | 新增/更新仍返回单行，删除仍返回 null，无外层快照对象，协议版本不变 | dev CLI 无运行配置子命令（只有 plugin / data import-image / pathql / task concurrency）。改用临时 Python CBOR 客户端直连 `kabegame-dev.sock` 发原格式 `storage-add/update/delete-run-config`：status 报 ipcProtocol=3；新增 message=added、data 为 25 字段原始行；更新 message=updated、新名；删除 message=deleted、data=null；均无 configId/reason/config/seq/view；前端列表经事件刷新 |
| [ ] | Web SSE | Web debug | 以上列表、失败数、详情与写操作 | 事件经 SSE 到达后行为与桌面一致 | 未测：本轮只连桌面 CEF dev |
| [x] | 调度器写入下次运行时间 | 桌面 CEF | 复制配置后开启每日定时 | 写命令后调度循环补算 `schedule_planned_at` 并补发 `configchange`，列表经窗口尾部刷新显示下次运行 | 实测（macOS CEF dev）：该配置收到写命令与调度循环各一条 `configchange`，库中 planned_at 已写入；测试配置已删除 |
| [ ] | 列表读取失败提示 | 桌面 CEF | 让首读、加载更多或事件刷新失败 | 弹出「刷新失败」，已有行与总数保留 | 未真机制造失败，类型检查与单测通过 |
| [x] | 推荐 tab 计数 | 桌面 CEF | 停在「我的配置」，再切到「插件推荐」 | 未读取推荐文件时显示插件声明的推荐数，进入推荐 tab 后为实际条目数 | 实测两处都是 45，「我的配置」tab 不发推荐读取 |

## 预览标签面板观察方与 dataChangeHub 删除

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 前端回归 | macOS | vue-tsc；Vitest 全量 | 0 error；全部通过 | 45 个文件、395 项；格式检查通过 |
| [x] | 首读 | 桌面 CEF | 画廊预览深链接打开带标签的图片 | 标签面板显示该图全部标签 | 图片 50：5 个标签，与 `albums://of_image_50/album_kind/label` 一致 |
| [x] | 别处写入成员 | 桌面 CEF | 预览开着时从外部新建标签并挂到当前图 | 经事件窗口刷新，面板出现新标签，面板自身不发请求 | 1 次结果落地、0 次面板请求 |
| [x] | 已挂标签改名 | 桌面 CEF | 预览开着时改名当前图已挂的标签 | 面板文案变为新名 | 1 次结果落地 |
| [x] | 面板内移除 | 桌面 CEF | 点标签的关闭按钮 | 立即消失，随后请求自身 key 一次，结果从数据源落地 | 面板请求 1 次、落地 1 次，结果不含该标签；插桩只记面板请求，自身写入的 `album-images-change` 另会触发一次核心窗口读取（见下方添加 / 读取失败两行），按序号落地 |
| [x] | 删除已挂标签画册 | 桌面 CEF | 预览开着时删除当前图已挂的标签画册 | 面板去掉该标签 | 成员删除与 `album-deleted` 各触发一次窗口刷新；测试标签已删除 |
| [x] | 切图 | 桌面 CEF | 从有 37 个标签的图切到下一张无标签的图 | 立即清空旧标签，请求新 key 一次，显示新图标签 | 8158 → 7339：1 次请求、1 次结果，结果为空，与 PathQL 一致 |
| [x] | 面板内添加 / 当场新建 | 桌面 CEF | 从已有标签添加、新建标签并挂上 | 立即出现，随后请求自身 key 一次 | 图片 7331：AlbumPicker 搜索选中测试标签后 150ms 内出现；面板请求自身 key 1 次，另有自身写入的 `album-images-change` 命中 `refreshOn`、核心空闲首票立即再读 1 次，共 2 次请求、结果均含该标签。当场新建测试标签同样面板 1 次 + 事件 1 次，先返回的事件读取确认后面板那次被丢弃，结果 5 个标签含新建项、对话框关闭；测试标签已删除 |
| [x] | 画册页移除 / 批量删除 | 桌面 CEF | 画册页移除图片、永久删除图片后再打开其它画册视图 | 画册树与各视图经事件刷新，不再依赖本地投递 | 测试画册右键「从画册移除」用户图：网格 `mutate` 与事件窗口各读 1 次，画册树（普通 / 标签 / 本地文件夹根各 1 次）与头部 `album-tree` 计数均在事件到达时刷新，树 3→2、头部 3→2、网格 3→2；标签画册移除 1 张：树 2→1、头部 1장。右键「删除文件」一次性导入的测试图：树 / 头部 / 网格 2→1，画廊计数 5457→5456；停在画廊时删另一张测试图，画廊行与计数经事件各读 1 次，分母 4283→4282。测试画册、标签、导入任务与图片均已删除 |
| [ ] | 移除时预览中的标签面板 | 桌面 CEF | 画册页预览打开时从当前画册移除当前图 | 面板随 `album-images-change` 刷新 | 部分验证：在测试标签画册预览图片后右键移除，事件到达时核心为旧 key `of_image_<id>` 读 1 次（结果为空，正确），但预览约 16ms 后已跟到下一张，面板清空并请求新 key 1 次、显示新图标签，旧 key 结果未落到面板。画册页移除当前预览图必然切图，无法观察面板停在原图时的事件刷新；该路径由「别处写入成员」覆盖 |
| [x] | 读取失败 | 桌面 CEF | 让标签读取失败 | 保留已有标签，控制台 warn | 临时插桩让该 key 读取 reject：外部改名已挂标签触发窗口刷新失败，5 个标签原样保留、warn 1 条；面板内移除后请求失败，本地移除生效、其余 4 个保留，面板请求与事件读取各 warn 1 条；撤销失败后再改名，1 次读取落地显示新名。插桩已删除 |
| [x] | 删除确认框按钮语言 | 桌面 CEF（韩语） | 画廊右键图片「삭제」，再点取消 | 标题与两个按钮均为当前语言，取消不删除 | 标题「삭제 확인」、按钮「취소」「확인」；取消后弹窗关闭。默认文案改取 i18n，删除未使用的「同时删除源文件」复选框 |

## 任务列表 / 状态计数 / 详情观察方

任务列表累计行与总数、常驻状态计数、当前任务详情分别观察 kbEvents pathql key；事件统一由核心窗口刷新，高频字段本地补丁。桌面 CEF 实测时在 `pathqlRequest$` 入口按 `tasks://` key 插 debug ingest 计数，测试任务为 konachan dry-run，验证后已删除。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 打开抽屉首读 | 桌面 CEF（韩语） | 刷新页面后打开任务抽屉 | 启动时 `tasks://status` 请求 1 次；打开抽屉同批读取 `x20x/1` 行与总数 1 次 | 总数 217，与计数一致 |
| [ ] | 关闭重开抽屉 | 桌面 CEF / Android / Web | 关闭抽屉再重开，读取在途时关闭 | 关闭清空并停观察，重开从首窗重读，旧响应不覆盖 | |
| [x] | 滚动加载更多 | 桌面 CEF（韩语） | 217 条任务，触底两次 | 窗口依次 `x40x/1`、`x60x/1`，每次 1 个请求，无重复行 | |
| [ ] | 加载更多失败重试 | 桌面 CEF / Android / Web | 制造第二窗读取失败再触底 | 保留原行和总数，重试同一窗口 | 单测覆盖 |
| [x] | 新任务出现与排序变化 | 桌面 CEF（韩语） | 抽屉打开时启动 dry-run 任务 | 新任务立即出现在最前，总数 217→218；新增与开始运行各触发一次窗口刷新 | 两次请求相隔约 730ms |
| [x] | 任务进度实时 | 桌面 CEF（韩语） | dry-run 任务运行中观察卡片 | 进度、张数就地变化（0→5→26→35），期间不请求列表与计数 | |
| [x] | 状态变化后徽章计数 | 桌面 CEF（韩语） | 取消运行中的测试任务 | `tasks://status` 刷新 1 次，计数 running 1 → canceled 1；卡片显示已取消 | 取消事件同时触发了一次列表窗口刷新（diff 带 startTime），结果正确 |
| [x] | 删除单个任务 | 桌面 CEF（韩语） | 抽屉中删除已取消的测试任务并确认 | 列表与计数 key 各由用户操作与事件窗口请求一次；总数回到 217，canceled 计数消失 | |
| [ ] | 清除已完成 | 桌面 CEF / Web | 同时存在排队、运行、终态任务时清除已完成 | 确认文案使用当前状态计数；清除成功请求列表与计数，保留排队及运行任务，总数准确 | 会删除真实任务，未在用户数据上测 |
| [x] | 搜索与清空 | 桌面 CEF（韩语） | 搜索 `pixiv`、改为 `konachan`、再清空 | 每次换词只请求过滤后首窗与总数各 1 次（0 / 6 / 217 条）；无本地 matches 筛选 | |
| [ ] | 搜索在途时关闭重开 | 桌面 CEF / Android / Web | 搜索读取在途时关闭抽屉再打开 | 旧响应不覆盖当前结果 | |
| [ ] | 配置关联任务与名称 | 桌面 CEF / Android / Web | 打开配置详情关联任务列表并加载更多，改名 / 删除关联配置 | 关联任务按配置路径累计读取；改名按 id 读取并补丁，删除清空关联名 | |
| [x] | 任务详情首读与被删除 | 桌面 CEF（韩语） | 打开测试任务详情，再从抽屉删除该任务 | 进入时 `tasks://id_<id>` 请求 1 次，显示 dry-run 跳过 35 张；删除后重读空行，页面回到通用标题与空态 | |
| [ ] | 任务详情切任务与离页返回 | 桌面 CEF / Android / Web | 运行中任务详情切到另一任务；离页再返回 | 换任务清空后首读一次；离页返回保留旧数据直到重读覆盖，diff 实时补丁 | |
