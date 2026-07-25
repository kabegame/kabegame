# Debug Ingest 调试方法

本文记录 Kabegame 开发期的 runtime debug ingest 机制。它参考 Cursor Debug Mode 的思路：在运行时代码里临时插桩，把调试事件发送到开发服务器，由开发服务器 tee 到 NDJSON 文件，之后再让人或 agent 读取日志定位问题。

## 涉及文件

- `scripts/vite-debug-server.ts`：Vite dev server middleware，负责接收 debug 事件并写入文件。
- `vite.config.pub.ts`：挂载 `kabegameDebugServer()`。
- `packages/core/src/debugIngest.ts`：前端插桩 helper。
- `src-tauri/kabegame/src/debug_ingest.rs`：Rust 后端插桩 helper。
- `src-tauri/kabegame/src/lib.rs`：后端启动后发送 `backend_started` smoke event。

## 核心语义

只在开发服务器上收集 runtime 日志，不使用 WebSocket。

开发期插桩代码向 Vite dev server 发送 HTTP 请求：

```text
POST http://<vite-dev-server-host>:1420/__kabegame_debug/ingest
```

Vite middleware 会按 `session_id` 写入：

```text
.kabegame/debug/debug-<session_id>.ndjson
```

每行都是一个 JSON 对象。推荐事件结构：

```json
{
  "session_id": "gallery-preview-001",
  "source": "frontend",
  "level": "debug",
  "name": "preview_open",
  "ts": 1780000000000,
  "payload": {
    "image_id": "123"
  }
}
```

`session_id` 用来标识一次 debug 会话。一次排查一个问题时，所有相关前端和后端插桩都应使用同一个 `session_id`。

## Vite Endpoint

### 健康检查

```bash
curl http://127.0.0.1:1420/__kabegame_debug/health
```

返回 debug 日志目录。

Android 真机/模拟器不能用 `127.0.0.1` 访问开发机；这里应使用构建脚本生成 Tauri `devUrl` 时同一个 host。`deno task dev -c kabegame --mode android` 会通过 `KABEGAME_DEV_SERVER_HOST` 把这个 host 注入给 Rust。

### 写入单个事件

```bash
curl -i -X POST http://127.0.0.1:1420/__kabegame_debug/ingest \
  -H 'Content-Type: application/json' \
  --data '{
    "session_id": "manual-smoke",
    "source": "curl",
    "name": "manual_event",
    "payload": { "ok": true }
  }'
```

成功时返回 `204 No Content`。

### 写入 NDJSON

```bash
printf '%s\n%s\n' \
  '{"session_id":"manual-ndjson","source":"curl","name":"line1"}' \
  '{"session_id":"manual-ndjson","source":"curl","name":"line2"}' \
| curl -i -X POST http://127.0.0.1:1420/__kabegame_debug/ingest \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @-
```

### 查看会话列表

```bash
curl http://127.0.0.1:1420/__kabegame_debug/sessions
```

### 查看某个会话尾部

```bash
curl 'http://127.0.0.1:1420/__kabegame_debug/sessions/manual-smoke?lines=200'
```

## 前端插桩

使用 `packages/core/src/debugIngest.ts`：

```ts
import { sendDebugEvent } from "@kabegame/core/debugIngest";

await sendDebugEvent(
  "image_preview_open",
  {
    imageId,
    localPath,
    metadataLoaded,
  },
  {
    sessionId: "preview-debug-001",
    source: "frontend",
  },
);
```

说明：

- `sendDebugEvent()` 只在 `IS_DEV` 下发送。
- 请求失败会被吞掉，不影响应用行为。
- 如果不显式传 `sessionId`，会优先读取 URL query `debug_session`，其次使用 `sessionStorage` 自动生成的 session。

可以这样让一次前端复现使用固定 session：

```text
http://localhost:1420/gallery?debug_session=preview-debug-001
```

## Rust 后端插桩

使用 `src-tauri/kabegame/src/debug_ingest.rs`：

```rust
crate::debug_ingest::spawn_debug_event(
    "preview-debug-001",
    "backend_query_image",
    serde_json::json!({
        "image_id": image_id,
        "path": path,
    }),
);
```

需要等待发送结果时使用 async 方法：

```rust
crate::debug_ingest::send_debug_event(
    "preview-debug-001",
    "backend_query_image_done",
    serde_json::json!({
        "image_id": image_id,
        "elapsed_ms": elapsed_ms,
    }),
)
.await?;
```

说明：

- debug build 下才真正发送；release 下是 no-op。
- 默认目标由环境推导：优先 `KABEGAME_DEBUG_INGEST_URL`；其次用 `KABEGAME_DEV_SERVER_HOST` / `TAURI_DEV_HOST` / `VITE_DEV_SERVER_HOST` 加端口拼出 URL；桌面兜底 `127.0.0.1`，Android 兜底 `10.0.2.2`。
- 发送失败只输出 `[kabegame-debug] failed to send debug event: ...`，不应改变业务流程。

## 环境变量

```text
KABEGAME_DEBUG_INGEST=false
```

关闭 Vite middleware 与 Rust 发送逻辑。

```text
KABEGAME_DEBUG_INGEST_URL=http://127.0.0.1:1420/__kabegame_debug/ingest
```

覆盖 Rust 发送目标。

```text
KABEGAME_DEV_SERVER_HOST=192.168.1.23
KABEGAME_DEV_SERVER_PORT=1420
```

设置 Rust 默认 debug ingest 目标。构建脚本会自动注入；只有开发机多网卡、VPN、真机无法访问自动选择的 IP 时才需要手动覆盖。

```text
KABEGAME_DEBUG_SESSION_ID=preview-debug-001
```

设置 Rust 后端启动 smoke event 的默认 session。

```text
KABEGAME_DEBUG_ALLOW_REMOTE=true
```

允许非 loopback 来源访问 Vite debug endpoint。桌面默认只允许本机回环地址；Android/web dev server 因为需要设备访问，会在 Vite 配置中默认允许远端来源。

```text
KABEGAME_DEBUG_TEE_CONSOLE=true
```

让 Vite middleware 在写文件的同时 `console.debug`。

## CDP 端口寄存

同一个 Vite middleware 还兼职一个与 debug ingest 无关的用途：给 `kabegame-chromium`
skill 寄存 CEF 的 CDP（Chrome DevTools Protocol）端口。

dev 下 `scripts/plugins/component-plugin.ts` 注入 `KABEGAME_CEF_DEBUG_PORT=random`，
`src-tauri/tauri-runtime-cef/src/runtime.rs` 的 `remote_debugging_port()` 让内核分配一个
空闲回环端口（结果 memoize 在 `OnceLock`），`src-tauri/kabegame/src/debug_ingest.rs` 的
`spawn_cdp_register()` 轮询 `/json/version` 直到 CDP 真的应答，然后把端口 POST 给 Vite。

```text
POST http://127.0.0.1:1420/__kabegame_cdp/register   {"port": 51234, "pid": 4321}
GET  http://127.0.0.1:1420/__kabegame_cdp            → {"ok":true,"port":51234,...}
```

要点：

- 登记是 **Vite 进程内内存态**，没有撤销接口：app 退出后端口仍留在上面，vite 重启则清空。
  消费方（`.claude/skills/kabegame-chromium/driver.sh`）在用之前会再探一次 `/json/version`。
- 「vite 上有端口」等价于「CDP 已就绪」——因为后端是探通之后才上报的。
- 只在 dev 注入；build/打包路径不经过 `component-plugin.ts`。显式设 `KABEGAME_CEF_DEBUG_PORT`
  （含 `=0` 关闭）时尊重用户的值。
- 与 debug ingest 共用同一套 loopback 来源校验。

## 推荐排查流程

1. 选择一个短 session id，例如 `preview-debug-001`。
2. 在可疑前端路径和 Rust 路径插入 `sendDebugEvent` / `spawn_debug_event`。
3. 启动 `deno task dev -c kabegame`。
4. 复现问题。
5. 读取 `.kabegame/debug/debug-preview-debug-001.ndjson`。
6. 根据日志修复问题。
7. 删除临时插桩，保留必要的文档或稳定 telemetry。

## 安全边界

- 默认只允许 loopback 访问；不要在局域网暴露该 endpoint。
- 不要写入 token、cookie、完整请求头、用户私密文件路径等敏感数据。
- 大 payload 会影响 dev server，单次请求默认限制为 1 MiB。
- Debug ingest 是开发期工具，不应成为生产行为依赖。
