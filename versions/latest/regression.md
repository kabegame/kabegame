# v4.6.1 regression

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
