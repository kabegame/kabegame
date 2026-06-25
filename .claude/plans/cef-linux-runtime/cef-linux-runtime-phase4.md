# Phase 4 — 把整个 app 挂上 CEF + 打通 IPC

> 父:[根计划](cef-linux-runtime.md)。前置:Phase 3.x 完成(CEF 渲染/输入/上屏全通,已用 `tall.html` 滚到 3600 验证;CEF 后端本身无 bug)。
>
> **背景结论(Phase 3.3 验证)**:Linux CEF 入口([lib.rs:320](../../src-tauri/kabegame/src/lib.rs))只 `Builder::<Cef>::new().build(context)`,**不挂 `.plugin()/.invoke_handler()/.setup()/http_server`** → 前端能渲染但拿不到后端 → 停在初始态、不可操作。Phase 4 就是补上这一截。
>
> **目标**:Linux 上 kabegame 在 CEF 下**真正可用**——画廊浏览、设置、缩略图/视频(http_server)、`invoke` 命令全通;其余平台不受影响。

## 两大工程块

1. **挂全 app**:让 Wry 全功能路径([lib.rs:333+](../../src-tauri/kabegame/src/lib.rs))的插件/命令/setup 复用到 `Builder::<Cef>`。卡点是**去掉残留的 `Wry` 硬编码**(大部分模块已 `R: Runtime`,仅少数没泛型化)。
2. **IPC 往返**:`invoke()` 前端 → CEF → Tauri 命令分发 → 回包。3.1 已注册 `ipc` scheme 且 `protocol.rs` 处理 `uri_scheme_protocols`,需确认 Tauri 走 `ipc://` 协议还是 `ipc_handler`(postMessage)。

## 现状锚点

**a. 大部分模块已泛型化**(`R: Runtime`):`startup.rs`(`create_main_window<R>`)、`http_server.rs`、`compress_provider.rs`、`content_io_provider.rs`、`commands/surf.rs`。
**b. 残留 Wry 硬编码**:`tray.rs:27` `fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String>`(裸 `AppHandle` 默认 Wry + `Menu<Wry>`)。
**c. 两条 run 路径**:`lib.rs:320` CEF 最小 / `lib.rs:333+` Wry 全功能(plugins + setup + `invoke_handler![…]` + `generate_context!`)。
**d. IPC 契约**:`tauri-runtime` `PendingWebview { uri_scheme_protocols, ipc_handler, initialization_scripts }`;Tauri 另有 `ipc/protocol.rs`(`ipc://`,`Tauri-Invoke-Key` header)。wry 用 `ipc_handler`。

## 子段拆解(每段可独立提交 + 验证)

| 子段 | 主题 | 验收 |
|---|---|---|
| [4.1 完成 Runtime 泛型化](cef-linux-runtime-phase4.1.md) | 去掉 `tray.rs` 等残留 `Wry`,全路径对 `R` 泛型 | Wry 路径仍编译、行为不变 |
| [4.2 共享 builder,CEF 挂全 app](cef-linux-runtime-phase4.2.md) | 抽 `configure_app<R>`,Wry/CEF 共用 | CEF 启动后有 plugins/invoke_handler/setup |
| [4.3 IPC 往返打通](cef-linux-runtime-phase4.3.md) | 确认并接通 `ipc://` 或 `ipc_handler` | 前端 `invoke` 命令成功返回 |
| [4.4 全应用回归 + 收尾](cef-linux-runtime-phase4.4.md) | http_server 资源、tray、退出、清诊断钩子 | 画廊/设置/缩略图可用,平台门控不变 |

建议顺序 4.1 → 4.2 → 4.3 → 4.4(4.1/4.2 是 4.3 的前提:app 不挂上,IPC 无命令可调)。

## 跨子段风险
- **CEF 非 Send/Sync**:`content_io_provider.rs` 已用 channel 代理规避 Wry 跨线程;CEF 同理(provider 跑独立线程)。挂 app 时注意 setup 里直接持 `AppHandle` 的后台任务。
- **setup 副作用**:http_server 启动、organize service、tray、单例——CEF 路径要么复用要么显式跳过,逐项确认。
- **平台插件差异**:picker/share/compress/wallpaper/task-notification 在 Linux 桌面是否全可用(原 Wry Linux 路径已用,理论一致)。
- **IPC invoke key 安全校验**:Tauri 2 的 `Tauri-Invoke-Key` 必须在 CEF 路径正确透传,否则命令被拒。

## 参考
- IPC 范文:`tauri/src/ipc/protocol.rs`、`tauri-runtime-wry/src/lib.rs`(`ipc_handler` ~4588)
- 已实现:`src-tauri/tauri-runtime-cef/src/protocol.rs`(uri_scheme_protocols)、`ipc.rs`(占位)
