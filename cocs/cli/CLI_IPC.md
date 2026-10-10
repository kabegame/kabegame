# CLI 与应用 IPC

`kabegame-cli` 对数据与运行时状态采用“应用优先、本地回退”：主程序正在运行、IPC 协议兼容且两端
指向同一个数据目录时，由主程序持有 Storage、Provider、插件缓存、任务调度和事件广播；否则 CLI
才在自身进程初始化同一套 core 运行时。`pathql query` 是只读例外，总在 CLI 本进程执行。这样既保留
无 GUI 的独立可用性，也避免写操作在主程序与 CLI 中同时维护缓存和调度器。

## 分层与边界

- `kabegame_core::commands` 放领域操作。IPC 只是这些操作的协议镜像，app handler 只做参数/响应转发。
- CLI 的 `Backend { Local, App(IpcClient) }` 组合一次业务流程：`Local` 直接调用 core，`App` 发 IPC。
- 读写数据库，或依赖/改变插件缓存、Provider 注册、任务调度、事件广播的操作走 `Backend`。
- 纯文件系统读取留在 CLI。本地 `.kgpg` 的 canonicalize、解析与导入前校验不会发给主程序。
- `plugin new`、`plugin pack`、`pathql generate`、`pathql query` 不需要 `Backend`。

## 模式选择

全局参数 `--via auto|app|local` 默认为 `auto`。CLI 先通过 `AppPaths` 算出本次命令的数据目录（只由构建时的 `kabegame_data` cfg 决定，CLI 没有运行时
`--data` 参数），再以
短超时执行 `IpcClient::connect()` 与 `Status`：

1. `Status.ipcProtocol >= IPC_PROTOCOL_VERSION`（当前为 v2：加入任务并发实时调整变体和
   `PluginRunParams.max_concurrent_downloads`）；
2. `Status.dataDir` 与 CLI 的数据目录规范化后相同。

两项都满足才选 `App`。socket / 命名管道地址按 `debug_assertions` 区分：debug 构建（`deno task dev` 的
app、默认 debug 的 CLI）用 `kabegame-dev.sock` / `\\.\pipe\kabegame-app-dev`，release 构建用
`kabegame.sock` / `\\.\pipe\kabegame-app`，dev app 不会与已安装的 release 版抢同一地址。但这只按构建
profile 区分，不按 `kabegame_data` 区分（debug 构建可以是 `--data prod`，release 构建也可以显式 `--data dev`），
因此仍不能把“连得上”当成数据目录相同；`dataDir` 比对用于阻止 dev CLI 误操作 prod app（或反过来）。协议版本门控则保证新 CLI 不会
把改变过字段的请求发给旧主程序。

`auto` 在主程序未运行时静默回退；协议过旧或目录不同时在 stderr 打印提示再回退。`app` 遇到任一
失败直接报错，`local` 不探测主程序。

`pathql query` 不参与上述模式选择并忽略 `--via`；它直接初始化只读 Storage 和已安装插件 provider。

## 领域操作

### PluginRun

`commands::task::run_plugin` 是 `PluginRun` 的唯一实现。它解析已安装 id 或临时 `.kgpg`，校验宿主是否
能运行 WebView，合并插件默认值、用户保存的 `userConfig` / `httpHeaders` / `outputDir` 与本次参数，
并把 `--max-downloads` 写入 `PluginRunParams.max_concurrent_downloads`，再通过
`commands::task::start_task` 提交。app handler 传 `webview_available=true`（Android 除外），
CLI local 传 `false`；因此 app 模式可运行 WebView，local 模式只运行 V8。

### TaskSetMaxConcurrentDownloads

`task concurrency <task-id> <正整数|global>` 只调整主程序注册表中的运行中任务，因此强制使用 app
IPC，不能回退 local。`TaskSetMaxConcurrentDownloads` 转发到唯一领域命令：先持久化任务列，再更新
`Task` 的原子上限、广播 `TaskChanged` 差量并唤醒下载容量等待者。`global` 序列化为 `null`，表示跟随
应用全局设置；主程序未运行、协议低于 v2 或任务已结束时返回明确错误。

### import-image

`data import-image` 不再直接写图片表，而是提交内建 `local-import` 任务：`paths` 只有 canonicalize 后的
单文件路径，`recursive=false`，目标画册放在 `outputAlbumId`。CLI 在提交前订阅任务事件，完成后从
`TaskChanged` 权威计数打印成功、去重与失败数。`local-import` 没有任意 metadata 注入能力，因此 CLI
不再提供 `--metadata`。

### PathQL 与插件导入

`pathql query` 直接调用 core 的 `commands::image::pathql_entry` / `pathql_list` / `pathql_fetch`，不经
`Backend` 或应用 IPC。它使用 `Storage::init_global_read_only()` 打开现有数据库，设置
`PRAGMA query_only = ON`，不建目录、不建表、不迁移；schema 低于 `LATEST_VERSION` 时要求用户先启动
新版应用完成迁移，高于当前版本则放行。随后以禁用 metadata 迁移的 `PluginManager` 加载已安装插件，
把 extend provider 注册进 runtime。IPC 的 `PathqlEntry` / `PathqlList` / `PathqlFetch` 变体继续保留，
供 CLI 以外的外部集成使用。

`plugin import` 先用不暴露全局状态的临时 `PluginManager` 在 CLI 本地解析 `.kgpg`，再由
`Backend.install_plugin` 落盘；坏包不会触碰主程序插件目录。CLI 本地 runtime 一律使用
`init_global_without_metadata_migrations()`：`plugin import`、`plugin run` 的 local 回退和
`pathql query` 都不会调度 metadata 迁移；应用下次启动全量刷新插件时会按版本门控补跑。经 app 后端
安装插件仍由主程序正常调度迁移。

## SQL 调试

`KABEGAME_SQL_DEBUG` 已设置且不是空串、`0` 或 `false` 时，Storage 在 SQLite 连接打开后立即注册
`SQLITE_TRACE_STMT | SQLITE_TRACE_PROFILE`。STMT 向 stderr 输出 SQLite 展开绑定参数后的完整 SQL，
PROFILE 输出从语句开始到 reset/finalize 的毫秒耗时与 120 字符单行前缀。钩子早于公共 PRAGMA 和迁移，
并挂在写连接和只读池的每条连接上，因此 app 初始化、迁移、PathQL resolve / fetch 和写操作都可见；
并发读取的 trace 行可能交错，PROFILE 行可通过所带 SQL 前缀与对应语句配对。未启用时不注册回调。

### 任务日志渲染

core 的非插件任务日志存为 `{"_i18n":{"k":...,"p":{...}}}` 载荷，界面由 `TaskLogDialog.vue` 翻译。
CLI 在 `src/task_log.rs` 做同样的事：文案唯一来源是前端 `packages/kabegame-i18n/src/locales/<lang>/tasks.json`
（`include_str!` 编译期嵌入，不在 Rust 侧另抄），当前语言缺 key 回退 en，非载荷或未知 key 原样输出。
语言跟随应用设置：提交任务的命令选定后端后调用 `Backend.language()`——app 模式经
`SettingsGetLanguage` IPC 取主程序的值，local 模式取本进程 `Settings::get_resolved_language()`。

## IpcClient 语义

- `connect()` 等待真实连接结果；失败返回 `Err`，不再启动后台连接后立即假成功。
- 未连接时 `request()` 立即失败，连接中的请求最多等待 10 秒；客户端不显示任何原生弹窗。
- 调试日志只在 `KABEGAME_IPC_DEBUG=1` 时通过 `ipc_dbg!` 输出。
- 事件帧直接解为 `Arc<AppEvent>`，使用 unbounded 通道；`subscribe_events()` 一次性取走当前连接的
  receiver，同一连接二次订阅会报错。
- 服务端先解出 envelope 的 `request_id`，不支持的 payload 会收到 `unsupported request` 响应，不会
  因静默丢帧而挂起。

## 涉及文件

- `src-tauri/kabegame-cli/src/backend.rs`
- `src-tauri/kabegame-cli/src/main.rs`
- `src-tauri/kabegame-core/src/commands/task.rs`
- `src-tauri/kabegame-core/src/ipc/`
- `src-tauri/kabegame/src/ipc/handlers/`
