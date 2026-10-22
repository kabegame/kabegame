# v4.6.1 regression

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
