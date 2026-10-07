# v4.5.0 regression

本版回归 checklist。任何改动可预见的回归路径，要在上线前 check 完毕。
按「操作」一步步点，对照「预期」，通过就把第一列勾上。

## 搜索表达式（且 / 或 / 非 / 分组 / 转义）+ 高级条件双重取非边界

搜索框输入改为表达式：`,` 且、`;` 或、前置 `!` 非（多重 `!` 两两抵消）、`()` 分组，`\` 转义、`"…"` 字面量。
由 `utils/searchExpr.ts` 解析 / 规范打印；勾选维度作用在**每个词**上（词 = 任一维度含它，`!词` = 所有维度都不含）——
多维度时逗号的含义从「同一维度内同时含」变为「逐词跨维度」。`serializeSearchTerm` 把语法树展开成
`search` 段 + `~any`/`~not`；`foldSearchTree` 解析后按勾选维度并集把连续节点读回语法树，重新序列化逐段一致才折叠，
高级条件边界外壳 `~not/~not/…/~end/~end` 不参与折叠。语法错误的输入不提交，底部说明指出位置。
后端元数据 / 原生元数据搜索谓词对 LEFT JOIN 的 NULL 列加 `COALESCE`，取非时不再丢掉没有元数据的图。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 解析 / 序列化 / 折叠自动化 | 前端 Vitest | `npx vitest run`（apps/kabegame） | 23 个文件、227 个用例通过（含 500 棵随机语法树往返、边界不混淆、旧路径兼容） | 已实测；vue-tsc 通过 |
| [x] | 取非不丢 NULL 行 | Rust e2e | `test-kabegame` driver：`kabegame-core --test dsl_e2e` | 40 个用例通过；新增用例在修复前于 metadata 上只剩 1/122 张 | 已实测；夹具补了 `search_text` 列与 `image_metadata` 表 |
| [ ] | 示例表达式 | 桌面 CEF / Web | 只勾「标签」，输入 `(girl; boy), cute, !genshin` | 结果为含 cute、含 girl 或 boy、不含 genshin 的图；底部说明读作「（含「girl」或含「boy」）和含「cute」和不含「genshin」」 | |
| [ ] | 多维度取非 | 桌面 CEF / Web | 勾显示名 + 标签，输入 `!genshin` | 显示名或标签任一处含 genshin 的图都被排除 | |
| [ ] | 元数据取非 | 桌面 CEF / Web | 只勾「元数据」，输入 `!一个不存在的词` | 计数等于全部图片数（没有元数据的图不被排除） | 修复前会只剩有元数据的图 |
| [ ] | 转义与引号 | 桌面 CEF / Web | 本地路径搜 `Foo (1).jpg`、`a\,b`、`"a, b"`、`\!x` | 各自按字面匹配；刷新后输入框显示规范形 | |
| [ ] | 语法错误不提交 | 桌面 CEF / Web | 输入 `(girl;` 停顿 | 底部红字指出第 1 个字符括号未闭合，列表不重查；补上 `)` 后才应用 | |
| [ ] | 只用逗号、单维度不变 | 桌面 CEF / Web | 只勾一个范围，用逗号搜索，对比改动前 | URL 与结果均不变 | |
| [ ] | 旧多维度逗号链接 | 桌面 CEF / Web | 打开改动前保存的「多范围 + 逗号」搜索链接 | 结果不变；条件显示为高级 OR 组（新语法无法表达「同一范围内同时含」） | |
| [ ] | 高级条件边界 | 桌面 CEF / Web | 简单搜索输入 `!a`，高级里再加一条搜索 `b` 与一个媒体类型条件，刷新 / 前进后退 | URL 含 `~not/~not/…/~end/~end`；两部分各自留在原处，计数正确 | |
| [ ] | 旧 URL 兼容 | 桌面 CEF / Web | 打开改动前保存的带单分支 `~any` 高级条件的链接 / 历史记录 | 高级条件仍显示在高级区 | |
| [ ] | 详情页 | 桌面 CEF | 画册 / 任务 / 畅游详情里用 `!`、括号搜索并追加高级条件 | 路由正常、结果正确 | |

## 预览中删除后按设置的切图方向接续

「设置 → 通用 → 切图方向」提供自动（默认）、上一张、下一张三档。`ImageGrid.resolvePreviewAnchor`
在自动模式记住本次预览最近一次上/下一张的切换方向（关闭预览复位为下一张），固定模式则直接使用设置方向。
删除 / 隐藏 / 滑动移除当前预览图后：往后接续同下标那张（原行为）；往前接续旧顺序里最近一张仍在视图的
上一张，本页前面已无图片时交给分页器翻到上一页末张。本页被删空时不再关闭预览，改为翻到上一页末张。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 方向接续自动化 | 前端 Vitest | 执行 `deno task test -c kabegame --skip cargo` | 自动、固定上一张、固定下一张均通过 | 已实测；vue-tsc 通过 |
| [ ] | 设置默认值与持久化 | 桌面 CEF / Web / Android | 首次打开设置，再依次选择上一张、下一张并重启 / 刷新 | 默认选中「自动（跟踪上一次）」；选择后保持不变 | |
| [ ] | 往后切后删除 | 桌面 CEF / Web | 预览中按右键切到下一张，删除当前图 | 显示原来的下一张，与改动前一致 | |
| [ ] | 往前切后删除 | 桌面 CEF / Web | 预览中按左键切到上一张，删除当前图 | 显示原来的上一张；连续删除持续往前 | |
| [ ] | 固定上一张 | 桌面 CEF / Web / Android | 设置切图方向为「上一张」，不手动切图，隐藏或删除预览中的图片 | 始终接续原来的上一张；位于页首时按需翻到上一页末张 | |
| [ ] | 固定下一张 | 桌面 CEF / Web / Android | 设置切图方向为「下一张」，先往前切图，再隐藏或删除当前图片 | 忽略最近切图方向，接续原来的下一张 | |
| [ ] | 往前切删到本页首张 | 桌面 CEF / Web，图片多于一页 | 在第 2 页往前切到本页第一张后删除 | 翻到第 1 页并显示其末张，提示「已进入上一页」，弹窗不关闭 | |
| [ ] | 第一页首张往前删除 | 桌面 CEF / Web | 第 1 页往前切到首张后删除 | 退到同下标那张（原下一张），不关闭 | |
| [ ] | 关闭后方向复位 | 桌面 CEF / Web | 往前切后关闭预览，重新打开某张图直接删除 | 按下一张接续 | |
| [ ] | 隐藏 / Android 滑动移除 | 桌面 CEF / Android | 往前切后用隐藏或上滑移除 | 同样按上一张接续 | |

## 预览跟随下载刷新翻页并保留缩放

`ImageGrid` 先应用网格快照，再协调当前预览图的位置。图被挤出本页时保持传给弹窗的旧
`ImageInfo`，按 rank 请求翻页；直到目标快照找到同一 id 才更新对象。空 rank 转单图，错误保留等待态，
隐藏/删除继续优先结算锚点；在途定位防重随快照更新失效，支持持续下载期间多次跨页。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 预览协调自动化 | 前端 Vitest | 执行 `deno task test -c kabegame --skip cargo` | 20 个文件、154 个用例通过；包括 21 个跟页用例、2 个分页边界交接用例、4 个实际加载状态用例 | 已实测；前端类型检查通过 |
| [x] | URL 目标等待页面确认 | 桌面 CEF + CDP | 把列表/rank IPC 读取暂时延迟 250ms，在第 1 页加载时通过 URL 指定第 5 页的 id 2712 | 第 1 页就绪后才查 rank；目标页未就绪前 prop 为 null 且预览未打开，第 5 页确认后传对象并打开 | 已实测；读取与 URL 入口共用应用逻辑，未测试独立 Web 部署；恢复原页面 |
| [x] | 就绪入口统一协调 | 前端 Vitest | 加载中换 URL、手动翻页、改过滤、重新开跟页；定位错误与同 seq 重复结果 | 不查旧页；新快照就绪后跟随目标；错误/防重不能当作不存在 | 已实测 |
| [x] | 下一张跨页交接 | 桌面 CEF + Vitest | 预览页尾图，点下一张；等待交接期间改变页面 | 正常选择新页首图，不被跟页拉回；过期页的 id 不覆盖新视图 | 已实测 |
| [x] | 真实跟页链路保持预览实例 | 桌面 CEF + CDP | 在第 5 页应用含 id 2610 的临时内存快照，放大 2 倍，再应用不含该图的真实快照 | 真实 rank/导航/查询自动回第 6 页；全程 2 倍，预览容器和图片 DOM 不变；目标快照到达后更新为对应行 | 已实测；无数据库写入，恢复原页码与缩放；不替代插件下载回归 |
| [ ] | 下载挤出页面保留缩放 | 桌面 CEF | 在按时间倒序的页面末尾预览并缩放/拖动，运行插件下载直到图被挤出本页 | 自动翻到目标页；id、缩放和平移保持，箭头恢复 | 目标页快照到达之前也保持旧对象 |
| [ ] | 持续下载多次跨页 | 桌面 CEF | 保持同一张图预览，持续下载足够多的新图 | 可多次自动跟页，没有一次性定位限制 | 自动化覆盖再次跨页和 rank/fetch 间再次位移 |
| [x] | 竞态取消与降级 | 前端 Vitest | 延迟 rank 后切图/手动翻页；关闭跟页；rank 返回空集 | 迟到结果不导航；禁用时不查 rank；空集转单图 | 已实测 |
| [x] | 主动移除锚点优先 | 前端 Vitest | 捕获移除锚点后应用不含当前图的快照 | 显示同下标图片，不定位旧 id | 已实测 |

## ImageGrid 移除拖动滑动

## kabegame-cli 优先经应用 IPC 执行

CLI 的 PathQL、插件导入/运行和单文件导入通过 `Backend` 共用一套业务组合：同数据目录的主程序
可用时走 IPC，否则回退 CLI 本地运行时。`PluginRun` 的解析、配置合并与任务提交统一在
`commands::task::run_plugin`；`data import-image` 改为 `local-import` 任务并移除 `--metadata`。

| 是否完成 | 标题 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | Rust 编译检查 | 本机 | `.claude/skills/check-kabegame/driver.sh --skip vue` 与 `-c kabegame-cli --skip vue` | app/core/CLI 无 error | 已实测 |
| [x] | core 参数解析单测 | 本机 | `.claude/skills/test-kabegame/driver.sh kabegame-core --lib commands::task` | key=value、positional、options 名称映射和未知 key 报错均通过 | `3 passed / 0 failed / 0 ignored` |
| [x] | CLI 单测 | 本机 | `.claude/skills/test-kabegame/driver.sh kabegame-cli` | 全部通过；`--metadata` 已被 clap 拒绝 | `20 passed / 0 failed / 0 ignored` |
| [x] | app/local PathQL 一致 | dev app + debug CLI | app 运行时用 `--data dev` 构建的 CLI 查询 `images://gallery/all/x10x/1`，再以 `--via local` 查询 | 两者输出一致；app 模式顶部显示主程序版本 | 已实测：`x5x/1` 两种模式输出逐字节一致，stderr 显示「经主程序执行（版本 4.5.1）」；单次约 0.04s |
| [x] | 单文件导入与去重 | dev app + debug CLI | 向 `/父/子` 画册导入图片，再重复导入 | 任务抽屉出现 `local-import`；画廊/画册立即刷新；CLI 分别打印成功/去重计数 | 已实测（未加入画册）：画廊计数 1457→1458 实时刷新，任务抽屉出现本地导入；重复导入打印「去重 1」。`--album` 仅验证了不存在路径经 IPC 报「未找到画册树路径」，未向真实画册写入 |
| [x] | 临时包与已安装插件 | dev app + debug CLI | 两种模式各运行 `.kgpg --id test-x --var k=v --dry-run` 和已安装 id | 最终配置一致；未知 key 均列出可用 key；实际运行日志/进度正常 | 已实测：konachan 已安装 id 与 `.kgpg --id konachan-ipc-test` 两种模式 dry-run 输出一致（含默认配置合并、`end_page` 转数字）；`--var max_pages=1` 两种模式报同样的可用 key；`--id` 用于 id 模式报错 |
| [x] | 取消任务 | dev app + debug CLI | `plugin run` 执行中按 Ctrl-C | CLI 经选中后端取消，任务状态变为 canceled | 已实测：app 模式 konachan 运行 12s 后 SIGINT，CLI 打印「任务已取消」，任务抽屉显示已取消（下载 2 张）；stderr 无 `[DEBUG]` |
| [x] | WebView 宿主能力 | dev app + debug CLI | app 模式运行 WebView 插件，再加 `--via local` | app 模式可运行；local 模式明确报只支持 V8 | 已实测：app 模式 `plugin run webpage --var url=https://konachan.net/post --var backend=webview` 发现 81 张、完成 81 张；`--via local` 报只支持 v8（`webpage` 的 script_type 为 builtin，改动前本地同样不可跑）。注意：运行期间不要用 playwright 连 CDP，会劫持 WebView 原生下载导致「Native download failed」 |
| [x] | 插件导入 | dev app + debug CLI | 导入正常 `.kgpg`，再导入坏包 | 正常包使插件列表立即刷新；坏包在 CLI 本地解析阶段失败且无目录残留 | 已实测：随机字节 `.kgpg` 在本地解析阶段报「读取 KGPG v3 头部失败」，插件目录无残留；app 模式重新导入 konachan.kgpg 成功 |
| [x] | 数据目录门控 | dev app + prod 构建的 CLI | app 运行时用默认（prod）构建的 CLI，再加 `--via app` | auto 提示目录不同并回退 local；app 强制模式报错 | 已实测：默认（prod）构建的 debug CLI 在 dev app 运行时 auto 提示「数据目录不同」并回退 local；`--via app` 报同样原因 |
| [x] | 主程序未运行 | 关闭 app | 执行 auto 与 `--via app` 命令 | auto 立即本地执行，无 10s 等待/无弹窗；app 强制模式报未连接 | 已实测（以不同 `TMPDIR` 模拟 socket 不存在，未关闭 app）：auto 0.06s 内本地执行、无弹窗；`--via app` 报连接失败 |
| [ ] | 任务 panic 兜底 | dev app（debug 构建） | 临时在某插件执行路径注入 `panic!`（或复现上一行的修复前场景）后运行任务 | 任务变为「失败」，日志含「任务执行时发生内部错误（panic）」；其余任务照常执行，运行名额被释放 | `worker_loop` 以 `catch_unwind` 包住 `run_task`；仅代码检查，未注入 panic 实测 |
| [ ] | CLI 日志语言跟随应用设置 | dev app + 以 `--data dev` 构建的 debug CLI | 应用设置切到中文 / 英文后分别执行 `data import-image` 或 `plugin run` | 日志文案与应用界面语言一致，无 `{"_i18n":...}` 原文；`--via local` 同样跟随设置 | local 模式已实测（设置 zh → 中文日志）；app 模式待重启 dev app 后验证 |
| [ ] | 重复导入不再卡死任务 | dev app（debug 构建）+ 下载间隔 > 0 | 对同一已入库文件反复执行 `data import-image`（或 GUI 拖入同一文件）数十次 | 每次都是「去重 1」并完成；终端无 `attempt to subtract with overflow`；任务抽屉无停在「运行中 0%」的本地导入 | 修复前偶发：`local-import` 的 start_time 比当前时间晚 1ms，`wait_after_download_if_needed` 下溢 panic 掉 task worker |
| [ ] | IPC 调试与旧版协议 | 本机 | 设 `KABEGAME_IPC_DEBUG=1`；再用旧 app 配新 CLI | 开关打开时恢复 DEBUG；旧 app 下 auto 回退且不挂起 | `KABEGAME_IPC_DEBUG=1` 已实测恢复 DEBUG；旧版 app 未测（无旧版二进制） |
| [x] | CLI 移除 `--data` | dev app + 以 `--data dev` 构建的 debug CLI | `plugin run <id> --data dev`；再不带参数执行 `plugin run <id> --dry-run`、`plugin import`、`pathql query` | 前者被 clap 拒绝（退出码 2）；后三者使用 `.kabegame/debug/data`，dev app 运行时走 app 模式 | 已实测：`--data dev` 退出码 2；不带参数的 `plugin run --dry-run`、`plugin import`、`pathql query` 均显示「经主程序执行」并使用 `.kabegame/debug/data`；`plugin run --help` 不再含 `--data` |
