# 应用日志（tracing）

主程序、Web 版与 CLI 的运行日志统一走 `tracing`：分级、按模块 target 过滤、按天落盘，并经应用内置事件循环推给订阅了日志的客户端（应用内「查看日志」、`kabegame-cli log tail`、Web super 模式）。前端经 `tauri-plugin-tracing` 写入同一管线。

## 涉及文件

- `src-tauri/kabegame-core/src/logging/`：订阅器装配（`mod.rs`）、级别过滤 `AppFilter`（`filter.rs`）、按天滚动文件（`file.rs`）、`AppLogLayer` 与 `LogRecord` 环形缓冲（`layer.rs` / `record.rs`），以及 `kb_debug!` 宏。
- `src-tauri/kabegame/src/logging_setup.rs`：主程序装配入口（注入 debug ingest 层、绑定日志目录）。
- `src-tauri/kabegame/src/commands/app_logs.rs`：`get_app_logs` / `start_app_log_stream` / `stop_app_log_stream` / `open_logs_dir`。
- `src-tauri/kabegame/src/web/server.rs`（`GET /logs`）、`web/dispatch.rs`（`get_app_logs`）。
- `src-tauri/kabegame-core/src/ipc/ipc.rs`（`IpcRequest::AppLogs`）、`ipc/events.rs`（`AppEvent::Log`、`AppEventKind::default_kinds`）。
- `src-tauri/kabegame-cli/src/log_tail.rs`：`log tail`。
- 前端：`apps/kabegame/src/utils/logger.ts`、`services/appLogs.ts`、`stores/appLogs.ts`、`components/logs/AppLogDialog.vue`，工具箱条目在 `header/globalToolsRegistry.ts`。

## 订阅器结构

全进程只有一个全局订阅器，由 `kabegame_core::logging::init` 安装（幂等）。它是一个 `Registry` 加若干**各带过滤器的层**：

| 层 | 输出 | 过滤 |
| --- | --- | --- |
| 控制台 | stderr（dev 且是终端时带颜色）；Android 不挂 | `AppFilter` |
| 文件 | `<data_dir>/logs/kabegame.<UTC 日期>.log`，无 ANSI | `AppFilter` |
| `AppLogLayer` | `LogRecord` → 2000 条环形缓冲；有订阅方时广播 `AppEvent::Log` | `AppFilter` |
| debug ingest（仅 debug 构建） | 批量 POST 到 Vite dev server，见 [DEBUG_INGEST.md](DEBUG_INGEST.md) | 只放行 `kabegame::debug` 与前端 `kb-debug` 的 TRACE 事件 |

用 per-layer filter 而不是全局 `EnvFilter`：debug ingest 需要 TRACE 级别的特定 target，而其余三层固定在 info / debug，两者不能共用一个阈值。`try_init` 同时安装 `LogTracer`，tauri / wry / tao 等使用 `log` crate 的依赖也进入同一管线（`AppLogLayer` 用 `normalized_metadata` 还原它们的 target）。

### 级别

- 本仓库的 target（`kabegame*`、`pathql_rs`、`tauri_runtime_cef`、`tauri_plugin_pathes`）与前端（`webview`）：release 为 info，dev 为 debug。
- 其余依赖：warn。`tauri_plugin_tracing` 设为 info，只为让它 `log` 命令外层的 span（带窗口 label 字段 `w`）对过滤器可见。
- 后端级别不提供设置项，查看器只在前端过滤。需要更细的日志时用环境变量 `KABEGAME_LOG` 覆盖，语法同 `tracing_subscriber::filter::Targets`，只覆盖其中提到的 target，例如：

```text
KABEGAME_LOG=kabegame_core::ipc=trace          # IPC 逐帧日志（原 KABEGAME_IPC_DEBUG）
KABEGAME_LOG=webview=debug,hyper=debug         # 前端 debug 日志 + hyper
KABEGAME_LOG=info                              # 依赖 crate 默认级别改为 info
```

解析失败时退回默认级别，并在订阅器就绪后记一条 warn。

### 落盘

- 目录 `AppPaths::logs_dir()` = `<data_dir>/logs`（dev 为 `.kabegame/debug/data/logs`），文件名 `kabegame.YYYY-MM-DD.log`，日期由 `tracing-appender` 按 **UTC** 切分；行内时间戳是本地时区。保留 14 个文件（`logging::MAX_LOG_FILES`）。
- 直接用 `RollingFileAppender` 同步写，不用 `tracing_appender::non_blocking`：发布版是 `panic = "abort"`，后台写线程的 guard 放在 static 里永远不会 drop，崩溃前最后几行必丢；info 级别写入量小，同步写可以接受。
- 订阅器在 `run()` 开头就装好，但 `AppPaths` 要等 `tauri-plugin-pathes` setup 后才有，所以文件层晚绑定：`init_pre` 第一步调用 `logging::attach_log_dir`（Web 在 `init_app_paths_for_web` 之后）。绑定前的日志只在控制台和环形缓冲里。
- CLI 不绑定文件，只打 stderr；CLI 面向用户的输出仍走 stdout。
- 控制台与文件共用 `logging/format.rs` 的单行格式 `时间 级别 target: 消息 k=v`，与查看器「复制」、CLI `log tail` 一致；不打印 span。不用 tracing-subscriber 的默认格式，是因为它会把前端日志打成 `log{w=main}: : 消息 =<调用位置>`（插件的空 target、外层 span 与空名字段）；这里与 `AppLogLayer` 共用 `record_target` / `RecordVisitor`，同样改写成 `webview:<窗口>` 并丢掉位置字段。
- `install_panic_hook` 在原 hook 之前记一条 `kabegame::panic` 的 error（线程名、位置、消息）。

## 日志事件与订阅

`LogRecord { seq, ts, level, target, message, fields }`（camelCase 序列化）。`seq` 在入环形缓冲时于同一把锁内分配，缓冲内严格有序；但广播在锁外，多线程打日志时到达顺序可能与 seq 不一致，订阅方按 seq 去重 / 排序。前端日志的 `target` 是 `webview:<窗口 label>`；插件附带的调用位置（空名字段）被丢弃——前端统一经 `utils/logger.ts` 调用，取到的总是包装函数自身。

`AppEventKind::Log` 是**仅显式订阅**（`is_opt_in`）的事件种类：

- 「订阅全部」一律用 `AppEventKind::default_kinds()`（`ALL` 去掉 opt-in 种类）：主事件循环转 Tauri / `/events` SSE、`subscribe_all_stream`、IPC `SubscribeEvents` 的空 kinds。所以日志不会默认推给前端、Web 客户端或 CLI。
- `AppLogLayer` 广播前先看 `receiver_count(Log)`，没人订阅时只写环形缓冲，不序列化、不入队。

三个出口都先订阅、再拉历史，按 seq 去重合并（先订阅是为了不漏掉拉历史期间的日志）：

| 出口 | 历史 | 实时 |
| --- | --- | --- |
| Tauri 主窗口 | `get_app_logs { sinceSeq?, limit? }` | `start_app_log_stream { onLogs: Channel }` 起转发任务（订阅 `[Log]`，200 ms 或 200 条攒一批经 Channel 推回调用页，替换旧任务）；`stop_app_log_stream { streamId }` 只停 id 匹配的那个，迟到的关闭请求不会停掉新开的推送。**不用全局事件**：Tauri 对 `listen` 时没指定 target 的监听者一律放行，`emit_to("main", ..)` 挡不住，畅游导航栏、爬虫窗口这些有事件监听权限的页面都能收到（实测畅游导航栏曾收到 `app-logs`）。两个命令只在 `main` 权限里 |
| Web（仅 super） | JSON-RPC `get_app_logs`（`requires_super`） | `GET /logs?super=1` SSE，`event: log`、`id` 为 seq；无 super 返回 403。不经 `/events` 的全局总线，避免推给所有 Web 客户端 |
| IPC / CLI | `IpcRequest::AppLogs { since_seq, limit }` | `SubscribeEvents { kinds: ["log"] }` |

`recent_logs(since_seq, limit)` 返回 `since_seq` 之后（不含）**最新**的至多 `limit` 条，按 seq 升序。新增 `AppLogs` 请求不升 IPC 协议版本：旧主程序会明确报「Unknown request」，不是静默丢字段（见 [CLI_IPC.md](../cli/CLI_IPC.md)）。

Web 的 super 只是 `?super=1` 查询参数，没有认证；日志的暴露范围与现有 super 写权限是同一个信任模型。服务器日志含本地路径、请求等内部信息，不要对非 super 开放。

### 防回环

`AppLogLayer` 用线程局部标记丢弃自身处理期间产生的日志。异步路径没有这层保护，所以**事件管线上的逐事件日志只能用 `trace!`**（低于默认阈值，不进广播层）：IPC 连接处理、订阅转发、`EventBroadcaster` 转发任务、`/logs` SSE、Tauri 日志转发任务。否则「推一条日志 → 记一条日志 → 再推一条」会无限放大。debug ingest 的发送线程失败时只直接写一次 stderr，不经 tracing。

## 前端

- `utils/logger.ts` 的 `logger.trace/debug/info/warn/error(...args)`：Tauri 下调 `@fltsci/tauri-plugin-tracing`（插件的 `log` 命令以空 target 发事件，外层 span 带窗口 label），Web 下回落 `console.*`。
- 插件只注册命令（`tauri_plugin_tracing::Builder::new().build()`），**不**开 `with_default_subscriber`、不挂它的 `WebviewLayer`；订阅器始终由 `kabegame_core::logging` 装配。权限 `tracing:allow-log` 只在 `capabilities/main.json(.handlebars)` 里给主窗口与壁纸窗口。
- `bootstrap/app.ts` 把 Vue `errorHandler`、`window` 的 `error` / `unhandledrejection` 转成 `logger.error`（Web 不挂，浏览器本来就会打印）。设置 `errorHandler` 会关掉 Vue 默认的控制台输出，所以处理器里补回 `console.error`。
- 「查看日志」在工具箱的维护分组（`globalToolsRegistry.ts`，Web 只在 super 时出现）。模块前缀按 `::` 分段匹配（`kabegame` 不命中 `kabegame_core::…`，`webview` 命中 `webview:main`），CLI `--target` 同规则。`stores/appLogs.ts` 打开时订阅、关闭即退订；前端最多保留 5000 条，「清空」后不会补拉旧日志。列表固定行高、单行省略，点击一行在下方看完整消息与字段。

## 写日志的约定

- 用 `tracing::{error, warn, info, debug, trace}!`，不要再写 `println!` / `eprintln!`（`build.rs` 的 `cargo:` 指令、CLI 面向用户的输出、CEF helper 子进程、第二实例转发退出路径除外）。
- 级别：初始化失败、不可恢复 → error；失败但已降级或可重试 → warn；启动进度、服务启停、迁移结果、任务生命周期 → info；排查细节 → debug；逐事件 / 逐帧 → trace。
- 不加 `[模块]` 前缀，模块路径就是 target，过滤与查看器都按它分组。只有跨模块、无法由模块路径表达的分类才写 `target: "kabegame::<名字>"`。
- 结构化上下文优先写成字段：`tracing::warn!(task_id = %id, "下载失败: {e}")`，查看器与 CLI 会单独显示。
- 环境变量开关式的详细输出（`PATHQL_DEBUG`、`KABEGAME_SQL_DEBUG` 等）保留开关，输出也走 tracing。

## 已知限制

- 前端连续快速打日志时，记录顺序（seq）可能与调用顺序不一致：每条日志是一次独立的异步 IPC，到达后端的先后不保证。需要严格顺序的排查请用 debug ingest 并按事件自带的 `ts` 排序。

- Android 不挂控制台层（stderr 不进 logcat），只有文件与查看器。
- CEF helper 子进程（`kabegame-cef-helper`）不装订阅器；`tauri-runtime-cef/src/subprocess.rs` 仍用 `eprintln!`。
- 第二实例在 `try_forward_to_existing_instance_and_exit` 里转发后直接退出，早于订阅器安装，那条提示仍是 `println!`。
