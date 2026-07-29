# MCP Server 架构与 PathQL 契约

## 主题

本文记录 Kabegame 桌面端 MCP Server 的模块边界、能力判定、PathQL 发现工具与分页护栏。
重点是说明哪些约束属于 MCP 层，避免为了限制 MCP 返回量而破坏 Provider DSL 的通用查询语义。

## 涉及文件

- `src-tauri/kabegame/src/mcp_server.rs`：rmcp 3.0 ServerHandler、资源/模板/工具声明、资源读取、PathQL 发现与分页护栏。
- `src-tauri/kabegame/src/mcp_service.rs`：绑定 `127.0.0.1`、启动/停止/restart 和 graceful shutdown。
- `src-tauri/kabegame/src/mcp_capabilities.rs`：能力元数据、URI → read capability、工具名 → write capability 的映射。
- `src-tauri/kabegame/src/commands/mcp.rs`：面向设置页的 Tauri getter/setter、端口切换与能力清单。
- `src-tauri/kabegame-core/src/providers/dsl/`：MCP 读取所消费的 PathQL provider 树。
- `src-tauri/pathql-rs/src/provider/runtime.rs`：`runtime.list/count/note/fetch`。
- `src-tauri/pathql-rs/src/compose/build.rs`：SQL 组装和末尾分页渲染。

## 四个模块的分工

### `mcp_server.rs`

协议层的单一入口。它负责：

- 声明预置资源、15 条资源模板和 5 个工具。
- 将 `images://`、`albums://`、`tasks://`、`surf_records://`、`plugin://` 读取交给 Provider Runtime。
- 对返回行反序列化、单条/列表形态、插件二进制/文本子资源做协议适配。
- 在 `resources/read` 和 `list_pathql_entry` 前执行 capability 检查。
- 对未显式分页的大型 images 集合执行 MCP 专用分页护栏。
- 通过 `/mcp` 暴露 rmcp 3.0 StreamableHTTP service。

### `mcp_service.rs`

只管理 HTTP 服务生命周期，不解释 MCP 请求。它绑定回环地址，根据设置启动、停止或切换
端口，并保存 shutdown sender 与后台任务句柄。服务状态以 settings 为权威来源。

### `mcp_capabilities.rs`

定义设置页与协议层共享的能力清单。read 能力按 URI scheme 和 path 映射；write 能力按工具名
映射。这里不执行读取或写入，只回答“这个请求属于哪个 capability”。

### `commands/mcp.rs`

连接设置系统与 `McpService`。开启服务时先成功绑定端口再落盘 enabled；运行中改端口会重启；
disabled capability 列表直接写入 settings。`get_mcp_capabilities` 将能力元数据提供给前端。

## 能力体系

### Read：按 URI path 判定

`read_capability_id(scheme, segments)` 根据路径区分能力，例如：

- `images://gallery/...` → `images.read.gallery`
- `images://x100x/1` → `images.read.raw`
- `images://id_{id}` → `images.read.by_id`
- `images://id_{id}/metadata` → `images.read.metadata`
- 其它表资源按 list / by_id，plugin 再细分 info、icon、doc 等子资源

`read_resource` 和 `list_pathql_entry` 都复用 `is_uri_capability_enabled`。发现工具没有独立
capability；它发现哪个 scheme/path，就受该读能力约束。

### Write：绑定工具名

`capability_for_tool` 将 4 个写工具绑定到各自 capability：

- `rename_image`
- `create_album`
- `add_images_to_album`
- `set_album_images_order`

`list_tools` 过滤禁用工具，`call_tool` 再做一次执行前检查。

### `read_capability_id = None` 的收紧规则

`None` 不再表示无条件放行。现在仅当**同一个 scheme 下仍有至少一个 read capability 开启**
时才放行。结果是：

- 关闭全部 images read 后，`images://` 裸根也拒绝。
- `fail-images://` 等未注册 scheme 没有同类 read capability，直接拒绝。
- 部分 images read 仍开启时，`images://` 裸根可用于发现；进入具体路径后再按精确 capability 判定。

这项规则同时约束资源读取和发现工具，不能只在 `list_resources` / `list_tools` 的展示层过滤。

## `list_pathql_entry` 与 PathQL 契约

PathQL 是懒树，`resources/list` 只暴露少量静态入口，不能枚举完整画廊。发现工具每次只走一层：

1. `runtime.resolve(uri)` 验证当前路径可解析。
2. `runtime.count(uri)` best-effort 得到当前集合总数；失败时 `total = null`。
3. `runtime.note(uri)`取得当前 provider 的可读说明。
4. `runtime.list(uri)` 枚举直属 child，再用 `offset` / `limit` 截取返回窗口。
5. `child_runtime_path` 将 child name 追加并 percent-encode；对每个 child 调 `runtime.note`，
   仅当 `include_counts = true` 且窗口不超过 50 项时调用 `runtime.count`。

因此发现依赖 `runtime.list/count/note` 三件套：

- `list` 决定“下一段有哪些合法值”。
- `count` 给出集合规模并帮助模型计算页数。
- `note` 解释当前节点/子节点的用法与组合约束。

返回的 child path 已可直接交给 `resources/read` 或继续发现，不得再次编码。`limit` 默认 100，
最大 200；超过上限返回 `limit_exceeded`，而不是静默截断。

画廊组合的关键语义：

- 路径上的过滤条件按 AND 累积。
- `filter_comb` 在已有过滤后再接一个维度。
- `sort` 是 `all` 的兄弟，不是 `all` 的子节点。
- `desc` 反转当前排序。
- `hide` 是排除隐藏图片的前缀。

## 分页护栏

`resources/read` 对 images 请求执行 MCP 层护栏：

- 单段 `id_*` 是单图，不检查。
- 末段全部为 ASCII 数字时视为已经以页号收尾，不检查。
- 其它 images 路径先 `runtime.count(uri)`；总数超过 500 时返回
  `pagination_required`，data 为 `{ uri, total, maxRows, howTo }`。

调用方应把集合补成 `/x<N>x/<page>`，页码从 1 开始。当前判定有一个已知漏网：末段恰为纯数字
的搜索词（例如 `gallery/search/display-name/2024`）会被误当成页号；调用方仍应在完整搜索路径
之后追加显式分页。

## 禁区：不能给 `gallery_all_router.json5` 加 `limit`

不要为了让 `images://gallery/all` 在 MCP 中默认只返回 100 行，而给
`gallery_all_router.json5` 的 query 增加 `limit: 100`。

`runtime.count()` 的实现是：

```sql
SELECT COUNT(*) FROM (<inner>) AS pq_sub
```

而 `<inner>` 来自 `build_sql`。`src-tauri/pathql-rs/src/compose/build.rs:72` 会在 SQL 末尾调用
`render_pagination`，所以 DSL 中的 LIMIT 会被保留在 COUNT 的子查询内。结果不是“读取最多 100，
计数仍为全量”，而是 `count("images://gallery/all")` 也塌成 100。

这会同时：

- 打断前端画廊总数与页数计算。
- 破坏所有复用同一 Provider Runtime 的消费者。
- 使 `src-tauri/kabegame-core/tests/dsl_e2e.rs` 中
  `assert_eq!(count("images://gallery/all"), 120)` 失败。

**分页护栏只能放在 MCP 层。** Provider DSL 必须保留真实集合与真实 COUNT 语义。

## `note` 与 `meta` 的分工

- `note` 是给人和模型读取的节点说明，写在**被说明的 provider 自己身上**。MCP 发现工具会把
  当前节点和每个 child 的 note 下发给模型。
- `meta` 是 `ChildEntry` 携带的 JSON 实体数据，例如 album 行、plugin manifest 或下游路由
  需要的结构化属性。

不要把说明文字塞进 `meta`，也不要把 album/plugin 实体 JSON 写进 `note`。二者分别服务于
“解释路径”与“传递实体数据”，混用会让 MCP 模型与其它 Provider 消费者同时失去稳定契约。
