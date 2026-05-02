# Kabegame Gallery MCP Bundle (MCPB)

这是一个可直接打包的本地 MCP Bundle（`*.mcpb`），通过 `stdio` 暴露 MCP 工具，并桥接到本机 Kabegame 的 HTTP MCP 服务（默认 `http://127.0.0.1:7490/mcp`）。

## 功能

桥接器一一映射 `src-tauri/kabegame/src/mcp_server.rs` 暴露的资源 / 工具：

读类工具（包装 `resources/read`）：

- `read_gallery_provider(path, without?)`：`provider://<path>`，支持 `?without=children|images`
- `read_image(image_id)`：`image://{id}` 完整 ImageInfo
- `read_image_metadata(image_id)`：`image://{id}/metadata` 爬取期 metadata
- `read_album(album_id?)`：`album://` 列表 / `album://{id}` 单条
- `read_task(task_id?)`：`task://` 列表 / `task://{id}` 单条
- `read_surf(host?)`：`surf://` 列表 / `surf://{host}` 单条
- `read_plugin(plugin_id?, resource?, key?)`：`plugin://` 列表（trimmed）；`resource` 取
  `info`(默认) | `icon` | `description_template` | `doc` | `doc_resource`（需 `key`）

写类工具（直转上游 `tools/call`）：

- `set_album_images_order`：相册手动排序（单次最多 100 条）
- `create_album`：新建相册（可选 `parent_id` 嵌套）
- `add_images_to_album`：将图片加入相册（已存在的会被静默跳过；可选 `image_orders`）
- `rename_image`：修改图片显示名

## 目录结构

- `manifest.json`：MCPB 清单（`manifest_version: 0.3`）
- `server/index.js`：MCP stdio 服务端实现
- `scripts/check-manifest.js`：manifest 基础自检脚本
- `package.json`：Node 依赖与脚本

## 运行与调试

1. 安装依赖

```bash
npm install
```

2. 可选：校验 manifest

```bash
npm run check:manifest
```

3. 启动 MCP 服务（stdio）

```bash
node server/index.js
```

## 打包为 `.mcpb`

推荐使用官方 CLI：

```bash
npm install -g @anthropic-ai/mcpb
mcpb pack .
```

## 工具输入约束（防御性）

- `read_gallery_provider.path`
  - 必填，非空字符串；禁止 `..`；禁止以 `/` 开头；长度 <= 512
  - `without` 可选，仅允许 `children` 或 `images`（互斥）
- `read_image` / `read_image_metadata`
  - `image_id` 必填，非空字符串，长度 <= 256
- `read_album` / `read_task` / `read_surf`
  - 对应 id（`album_id` / `task_id` / `host`）可选；省略即列出全部
- `read_plugin`
  - `plugin_id` 可选；`resource` 默认 `info`，可选
    `info` | `icon` | `description_template` | `doc` | `doc_resource`
  - `resource = doc_resource` 时 `key` 必填（长度 <= 512）
  - 当 `plugin_id` 省略时，仅允许 `resource = info`（即列出全部）
- `set_album_images_order`
  - `album_id` 必填；`image_orders` 必填数组，长度 1..100
  - 每项必须包含 `image_id`（字符串）和 `order`（整数）
- `create_album`
  - `name` 必填（<= 512）；`parent_id` 可选
- `add_images_to_album`
  - `album_id` 必填；`image_ids` 数组，长度 1..1000
  - `image_orders` 可选数组，长度 1..100；同 `set_album_images_order` 项形态
- `rename_image`
  - `image_id` 必填；`display_name` 必填（<= 512）

## 安全与超时策略

- 仅允许本地 endpoint 主机：`127.0.0.1` / `localhost` / `::1`
- 上游请求全部使用 `AbortController` 超时中断
- 异常统一包装为结构化 JSON 响应（`ok: false, code, message, details`）
- 日志输出到 `stderr`，默认 `info/error`；开启 `KABEGAME_MCP_DEBUG=true` 可查看 `debug`

## 用户配置映射（manifest）

- `kabegame_mcp_endpoint` -> `KABEGAME_MCP_ENDPOINT`
- `request_timeout_ms` -> `KABEGAME_MCP_TIMEOUT_MS`
- `debug_logging` -> `KABEGAME_MCP_DEBUG`

## 测试建议

- 工具返回结构：确认所有工具返回 `content` + `structuredContent`
- 超时行为：将 endpoint 指向无响应地址，确认 `TIMEOUT` 错误
- 主机限制：将 endpoint 配置为非 localhost，确认启动即失败
- Host 集成：导入 `.mcpb` 后确认能列出工具并成功调用
