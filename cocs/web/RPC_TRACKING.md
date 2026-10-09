# Web 版 `/rpc` 接口埋点

Web 发布版（demo.kabegame.com）在服务端按接口统计 JSON-RPC 调用：每次 `POST /rpc` 都向 umami
发一条以方法名命名的事件，umami 的 Events / Pages 直接按命令拆分。插件和网页前端都不需要改动，也不需要额外的请求头。服务器不读取、不转发
客户端的请求头（IP、UA 等），所以 umami 里所有事件都归到服务器自己这一个访客，看不到是谁在调用。

## 事件

| 字段 | 值 |
| --- | --- |
| `name` | 方法名（如 `pathql_fetch`；未注册为 `(unknown)`） |
| `url` | `/rpc/<方法名>` |
| `hostname` | `KABEGAME_UMAMI_HOSTNAME`，未设置时 umami 记为 `localhost` |
| `data.method` | 已注册的方法名；未注册的方法一律记为 `(unknown)`，避免任意字符串刷爆属性值 |
| `data.ok` | 是否成功返回 `result` |
| `data.code` | 仅失败时出现，JSON-RPC 错误码（`-32001` forbidden、`-32000` internal 等） |
| `data.ms` | 服务端处理耗时（毫秒），不含网络传输 |

网页前端与 `kabegame-server` 插件都走 `/rpc`，两者混在一起统计，单靠方法名区分不出来源。
`/events`（SSE）、`/file` 与 MCP 不在统计范围内。

## 配置

只在 `web` feature 编译时生效（`#[cfg(feature = "web")]`）。桌面端「设置 → 高级」里的 Web 服务器虽然
也复用 `web_routes()`，但永远不会上报。运行时由环境变量开启，缺少任一必填项时整体关闭，启动日志会打印
`RPC tracking disabled`：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `KABEGAME_UMAMI_SEND_URL` | 是 | umami 收集端点，demo 为 `https://umi.kabegame.com/api/send` |
| `KABEGAME_UMAMI_WEBSITE_ID` | 是 | umami website UUID（与 demo 前端的 `kabegame-web` 分开建站） |
| `KABEGAME_UMAMI_HOSTNAME` | 否 | 事件 hostname，demo 填 `demo.kabegame.com` |

demo 服务器上放在 systemd drop-in `/etc/systemd/system/kabegame.service.d/umami.conf`，例如：

```ini
[Service]
Environment="KABEGAME_UMAMI_SEND_URL=https://umi.kabegame.com/api/send"
Environment="KABEGAME_UMAMI_WEBSITE_ID=<website UUID>"
Environment="KABEGAME_UMAMI_HOSTNAME=demo.kabegame.com"
```

改完执行 `sudo systemctl daemon-reload && sudo systemctl restart kabegame`，启动日志应出现
`✓ RPC tracking → …`。

## 实现要点

- **接入点**：`web/server.rs` 的 `rpc_handler` 在 `dispatch` 前后计时，再交给 `web/track.rs`。
  `track::start` 在埋点关闭时返回 `None`，此时没有任何额外开销。
- **不阻塞接口**：事件进入容量 1024 的有界队列，后台 worker 以 8 路并发 POST。队列满（umami 慢或
  不可达）时直接丢弃，不反压 `/rpc`。
- **不走代理**：demo 的 systemd 单元带全局 `HTTPS_PROXY`，埋点客户端用 `no_proxy()` 直连 umami。
- **UA 必须像浏览器**：umami 3.x 用 isbot 过滤，`Kabegame/1.0`、`reqwest/0.11` 这类 `名字/版本` UA
  会被判成 bot，返回 `200 {"beep":"boop"}` 并静默丢弃。这里用
  `Mozilla/5.0 (X11; Linux x86_64) kabegame-web/<版本>`（已用 umami 内置规则实测通过）。
  worker 会把 `beep` 响应当成失败处理。
- **日志不刷屏**：只在「正常 ↔ 失败」切换时各打一行（`[umami] RPC tracking failed` / `recovered`）。

## 涉及文件

- `src-tauri/kabegame/src/web/track.rs`：配置、队列与上报
- `src-tauri/kabegame/src/web/server.rs`：`rpc_handler` 接入点
- `src-tauri/kabegame/src/web/dispatch.rs`：`registered_method`，把方法名收敛到注册表
- `src-tauri/kabegame/src/lib.rs`：web 入口调用 `track::init()`
