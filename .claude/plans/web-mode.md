# --mode web：Web 端部署方案

## Overview

在 Tauri 打包之外增加一个 `web` 构建模式，产出：
- **Rust WebSocket 服务器**（复用现有 Axum + tokio）：处理 RPC 请求 + 实时事件推送
- **纯静态 Vue 前端**：与本地 Tauri 版共享同一套业务代码，仅替换 IPC 适配层

服务器端维持与 CLI daemon 相同的 `EventBroadcaster` / `GlobalEmitter` 单例，每个 WebSocket 连接调用 `subscribe_filtered_stream()` 订阅全部事件，super 用户的操作（写命令）实时推送给所有连接中的 web 客户端。

权限模型：
- 普通访问：只读能力（浏览画册、查看图片等）
- super 访问：`?super=1` query 参数；nginx 层通过客户端证书验证拒绝非授权请求

不支持的功能（web mode 禁用）：
- 虚拟盘（Dokan / FUSE）
- 壁纸设置（系统 API 不可用）
- 本地文件选择器（tauri-plugin-picker）
- CLI daemon IPC（ipc-client/ipc-server 仍在，但不启动 socket 监听）

## Scope

### In
- 新增 `Mode.WEB = "web"` 及构建管线适配
- 新增 `src-tauri/app-web/` crate：纯 Axum 二进制（无 Tauri 依赖），复用 `kabegame-core`
- 前端 `apps/main/` 新增 `web-client.ts` 适配层，隐藏 Tauri invoke / listen 差异

### Out
- 不修改现有 app-main / app-cli 任何逻辑
- 不支持 iOS、Android
- 不做服务端渲染（SSR）

## 协议设计

### 连接握手

```
GET /ws?super=1   # super 用户（nginx 限制）
GET /ws           # 普通只读用户
```

连接建立后服务端立即推送一帧 `{"type":"connected","super":true|false}`。

### RPC（客户端 → 服务端）

JSON-RPC 2.0：

```json
{"jsonrpc":"2.0","id":1,"method":"get_albums","params":{}}
```

响应：

```json
{"jsonrpc":"2.0","id":1,"result":{...}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}
```

非 super 用户调用写操作返回 `code: -32001, message: "forbidden"`。

### 服务端事件推送（服务端 → 客户端）

复用 `DaemonEvent` 的 serde JSON 序列化，包在 notification envelope 里：

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"TaskChanged","taskId":"...","diff":{...}}}
```

事件通过 `EventBroadcaster::subscribe_filtered_stream(DaemonEventKind::ALL)` 直接转发，**零额外拷贝**。

### 文件服务

复用现有 HTTP server 路由（`/file`、`/thumbnail`、`/plugin-doc-image`、`/proxy`），在 web mode 下同一个 Axum Router 同时托管静态前端资产 + 文件 API + WebSocket 升级端点。

## Plan

### 1. 构建系统（`scripts/plugins/mode-plugin.ts`）

- 新增 `Mode.WEB = "web"`，加入 `Mode.modes`
- `prepareEnv` hook：web mode 设 `VITE_KABEGAME_MODE=web`，加 `--cfg kabegame_mode="web"` Rust flag
- `beforeBuild` / `copyBin`：web mode 跳过 Dokan/FFmpeg DLL 复制
- `packagePlugins`：web mode dev 时同样打包插件

### 2. 新 crate `src-tauri/app-web/`

文件结构：

```
src-tauri/app-web/
  Cargo.toml          # bin crate，依赖 kabegame-core（features = ["ipc-server"]）
  src/
    main.rs           # 启动 tokio rt，初始化 core，启动 axum server
    ws_server.rs      # WebSocket handler：握手、RPC dispatch、事件推送
    rpc/
      mod.rs          # dispatch_rpc(method, params, is_super) -> Value
      commands.rs     # 直接复用 app-main/src/commands/* 的纯函数（或提取到 core）
    static_files.rs   # 嵌入编译后的 Vue dist（include_dir!）
```

关键实现思路（`ws_server.rs`）：

```rust
// 每个连接
async fn handle_ws(ws: WebSocket, is_super: bool) {
    let (mut sink, mut stream) = ws.split();
    // 订阅全部事件
    let mut event_rx = EventBroadcaster::global()
        .subscribe_filtered_stream(&DaemonEventKind::ALL);

    loop {
        select! {
            // 来自客户端的 RPC 请求
            msg = stream.next() => { /* parse JSON-RPC → dispatch_rpc → send result */ }
            // 来自 EventBroadcaster 的推送事件
            ev = event_rx.recv() => {
                let json = serde_json::to_string(&ev).unwrap();
                sink.send(Message::Text(notification_envelope(json))).await?;
            }
        }
    }
}
```

### 3. 权限层（`ws_server.rs`）

```rust
fn is_super_request(req: &Request<()>) -> bool {
    req.uri().query()
        .and_then(|q| serde_urlencoded::from_str::<HashMap<String,String>>(q).ok())
        .map(|m| m.get("super").map(|v| v == "1").unwrap_or(false))
        .unwrap_or(false)
}
```

在 `dispatch_rpc` 中，对写命令列表做 `if !is_super { return Err(forbidden) }`。

写命令列表在编译期用常量 `HashSet` 定义，涵盖所有会修改存储/触发爬取的操作。

### 4. 前端适配层（`apps/main/src/api/`）

新建 `web-client.ts`：

```typescript
// 单例 WebSocket 连接 + pending request map
export function invoke<T>(cmd: string, args?: Record<string,unknown>): Promise<T>
export function listen(event: string, cb: (payload: unknown) => void): () => void
```

`invoke` 通过 JSON-RPC 2.0 发送请求，`listen` 注册 event notification handler。

新建 `ipc.ts` 统一出口：

```typescript
// 根据 import.meta.env.VITE_KABEGAME_MODE 决定实现
export const invoke = isWeb ? webInvoke : tauriInvoke
export const listen  = isWeb ? webListen  : tauriListen
```

所有现有 `import { invoke } from '@tauri-apps/api/core'` 替换为 `import { invoke } from '@/api/ipc'`。

**影响范围**：221 处 invoke 调用 + Tauri event listen 调用（`useEventListener` / `listen` from `@tauri-apps/api/event`）。

### 5. 不支持功能的 fallback（前端）

对 web mode 中不可用的命令（虚拟盘、壁纸设置、文件选择器），在 `ipc.ts` 中 fallback 返回 `{ ok: false, error: "not supported in web mode" }` 或直接隐藏相关 UI 入口（通过 `VITE_KABEGAME_MODE === 'web'` 条件）。

### 6. nginx 配置示例（文档）

```nginx
location /ws {
    # super 用户需要客户端证书
    if ($arg_super = "1") {
        set $need_cert 1;
    }
    if ($ssl_client_verify != "SUCCESS") {
        if ($need_cert) {
            return 403;
        }
    }
    proxy_pass http://127.0.0.1:8765/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
location / {
    proxy_pass http://127.0.0.1:8765;
}
```

## 与现有代码的关系

| 现有组件 | web mode 中的角色 |
|---|---|
| `kabegame-core` | 完整复用（Storage、Crawler、Plugin、Emitter、EventBroadcaster） |
| `EventBroadcaster::subscribe_filtered_stream` | WebSocket 事件推送的核心机制，无需修改 |
| `app-main/src/ipc/handlers/` | 逻辑层可以逐步提取成 `core` 的纯函数供两端共用；初期可在 app-web 中重新实现部分命令 |
| `http_server.rs` 的文件/代理路由 | 整体移入 app-web 的 Axum Router，保持相同路径 |
| `DaemonEvent` / `DaemonEventKind` | 直接序列化成 JSON 推送，无格式转换 |

## Todos

- [ ] `scripts/plugins/mode-plugin.ts`：新增 `Mode.WEB`，并处理构建逻辑
- [ ] 新建 `src-tauri/app-web/Cargo.toml` 和 `src/main.rs` 骨架
- [ ] 实现 `ws_server.rs`：握手、JSON-RPC dispatch、事件推送循环
- [ ] 实现写命令白名单 / super 鉴权
- [ ] 将 `http_server.rs` 的文件服务路由提取为可复用函数，供 app-web Axum Router 引用
- [ ] 前端：新建 `apps/main/src/api/web-client.ts` 和 `ipc.ts` 统一出口
- [ ] 前端：批量替换 `@tauri-apps/api/core` invoke → `@/api/ipc`
- [ ] 前端：替换 `@tauri-apps/api/event` listen → `@/api/ipc` listen
- [ ] web mode 不支持的功能：前端隐藏入口 + 后端返回 not-supported
- [ ] 静态资产嵌入：Vite 产物通过 `include_dir!` 嵌入 app-web 二进制
- [ ] nginx 配置文档
- [ ] `bun dev -c main --mode web` 开发模式（分离 Vite dev server + Rust ws server）
