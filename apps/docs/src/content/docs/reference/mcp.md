---
title: MCP URI 与工具参考
description: Kabegame 本地 MCP 服务器的 URI scheme、分页规则与写入工具完整参考。
---

本页是 Kabegame 本地 MCP 服务器的完整接口参考，面向插件作者与 MCP Host 集成方。如果你只想知道怎么在 Claude Desktop / Cursor 里用上这个服务，先看 [MCP 服务](/guide/mcp/)；如果你要走 stdio 通道，见 [安装 MCP Bundle](/guide/mcp-bundle/)。

:::note
本页表格中的「since 版本」尚未在源码层做显式门禁。在业主方确认各端点与工具所属的发布版本之前，所有行统一填为「—」。
:::

## 端点与连接

| 项 | 值 |
|---|---|
| URL | `http://127.0.0.1:7490/mcp` |
| 端口 | `7490` |
| 绑定 | `127.0.0.1`（仅回环，无鉴权） |
| Transport | StreamableHTTP（rmcp 1.4，`LocalSessionManager`） |
| 启动时机 | 应用启动时自动拉起（仅桌面） |
| 平台 | Windows / macOS / Linux（仅桌面），Android 不暴露 MCP |

:::caution
服务仅绑定 `127.0.0.1`，没有任何鉴权层。一旦通过反向代理 / 隧道把 7490 暴露出去，远端可直接对你的画廊执行读取与写入操作。
:::

### Server instructions

连接后，服务器会在 MCP 握手的 `instructions` 字段里返回一份 cheat sheet：包含 URI 速查、字段清单、`plugin://` 瘦身提示，以及「不支持删除」的说明。Host 侧可以把它直接作为系统提示的一部分。

## 五类 URI scheme 一览

| Scheme | 路径形态 | Entry / List | 支持 `?without=` | 返回 | MIME | since 版本 |
|---|---|---|---|---|---|---|
| `images://` | `id_{id}` / `id_{id}/metadata` / `gallery/...` / `x{N}x/{page}` | 两者 | — | `ImageInfo` / metadata JSON / `Vec<ImageInfo>` | `application/json` | — |
| `albums://` | `all` / `id_{id}` | 两者 | — | `Vec<Album>` 或 `Album` | `application/json` | — |
| `tasks://` | `all` / `id_{id}` | 两者 | — | `Vec<TaskInfo>` 或 `TaskInfo` | `application/json` | — |
| `surf_records://` | `all` / `id_{id}` | 两者 | — | `Vec<SurfRecord>` 或 `SurfRecord` | `application/json` | — |
| `plugin://` | `` / `{id}` / `{id}/icon` / `{id}/description_template` / `{id}/doc` / `{id}/doc_resource/{key}` | 两者 + 子资源 | — | 瘦身的 Plugin / 二进制 / 文本 | 多种 | — |

:::caution
`provider://`、`image://`、`album://`、`task://`、`surf://` 已停用。请改用 `images://` 与复数表资源 scheme。
:::

## `images://`

### 图片与 metadata

| 形态 | 返回 | MIME | since 版本 |
|---|---|---|---|
| `images://id_{id}` | 完整 `ImageInfo`（含 `metadataId`） | `application/json` | — |
| `images://id_{id}/metadata` | 爬取时 metadata（tags、作者、URL 等，可能数十 KB） | `application/json` | — |

图片缺失返回 `resource_not_found`；metadata 行缺失返回 `metadata_not_found`。

### 画廊路径示例

| 路径 | 含义 |
|---|---|
| `images://gallery/all` | 所有图片第 1 页，按爬取时间升序 |
| `images://gallery/all/desc/x100x/1` | 所有图片第 1 页，最新在前，每页 100 张 |
| `images://gallery/album/{albumId}/x100x/1` | 指定画册第 1 页 |
| `images://gallery/album/{albumId}/desc/x100x/1` | 指定画册第 1 页，最新在前 |
| `images://gallery/date/2024y/03m/desc/x100x/1` | 2024-03 爬取图片第 1 页，最新在前 |
| `images://gallery/media-type/image/x100x/1` | 仅图片媒体类型，第 1 页 |
| `images://gallery/wallpaper-order/x100x/1` | 壁纸历史第 1 页 |
| `images://x100x/1` | 原始 `images` 表第 1 页 |

`images://gallery/...` 直接返回 `Vec<ImageInfo>`；不再返回旧 `provider://` 的 Dir / Image 混合 `entries` 结构，也不支持 `?without=`。

### `ImageInfo` 字段（camelCase）

`id`、`url`、`localPath`、`pluginId`、`taskId`、`surfRecordId`、`crawledAt`（unix 秒）、`metadataId`、`thumbnailPath`、`favorite`、`localExists`、`hash`、`width`、`height`、`displayName`、`type`（`"image" | "video"`，注意 serde key 是 `type` 而不是 `mediaType`）、`lastSetWallpaperAt`、`size`（字节）。

:::note
列表类端点只返回图片基础字段。需要爬取期 metadata 时单独读 `images://id_{id}/metadata`。
:::

## `albums://`

| 形态 | 返回 | since 版本 |
|---|---|---|
| `albums://all` | `Vec<Album>`（全部画册） | — |
| `albums://id_{id}` | 单个 `Album`，缺失返回 `resource_not_found` | — |

## `tasks://`

| 形态 | 返回 | since 版本 |
|---|---|---|
| `tasks://all` | `Vec<TaskInfo>`（全部任务） | — |
| `tasks://id_{id}` | 单个 `TaskInfo`，缺失返回 `resource_not_found` | — |

## `surf_records://`

| 形态 | 返回 | since 版本 |
|---|---|---|
| `surf_records://all` | `Vec<SurfRecord>`（全部记录） | — |
| `surf_records://id_{id}` | 单个 `SurfRecord`，缺失返回 `resource_not_found` | — |

## `plugin://`

| 形态 | 返回 | MIME | since 版本 |
|---|---|---|---|
| `plugin://` | `Vec<Plugin>`，瘦身 | `application/json` | — |
| `plugin://{id}` | 单个瘦身 `Plugin` | `application/json` | — |
| `plugin://{id}/icon` | Base64 图标 PNG | `image/png` | — |
| `plugin://{id}/description_template` | EJS 描述模板 | `text/plain` | — |
| `plugin://{id}/doc` | 默认语言的 `doc.md` | `text/markdown` | — |
| `plugin://{id}/doc_resource/{key}` | `doc_root` 内单个文件 | 按扩展推断（见下） | — |

`doc_resource` 的 MIME 推断：`.png` → `image/png`，`.jpg` / `.jpeg` → `image/jpeg`，`.webp` → `image/webp`，`.svg` → `image/svg+xml`，`.gif` → `image/gif`，其它回落到 `application/octet-stream`。

「瘦身」指剥离了 `docResources`、`iconPngBase64`、`descriptionTemplate` 三个重字段；这些内容要通过上面的子路径单独拉取。

## 通用分页规则

- **页码从 1 开始。`page 0` 是非法值，一律视为错误。**
- 页大小跟随用户设置 `galleryPageSize`，可选 **100 / 500 / 1000**，默认 100。其它值会被规整回 100。
- 第 N 页从 `(N - 1) * page_size` 处开始。
- 非 SimplePage 路径（Greedy 路径）使用固定的内部 `LEAF_SIZE = 100`，不跟随用户设置。

分页上下文与 `galleryPageSize` 的具体行为见 [画廊](/guide/gallery/)。

## 预置资源（`list_resources`）

服务器预先声明六条可列举的资源，方便 Host 在 UI 里直接展示：

| URI | 名称 | 说明 |
|---|---|---|
| `images://gallery/all` | Gallery images | 画廊默认图片页 |
| `images://x100x/1` | Raw image rows | 原始 `images` 表第 1 页 |
| `albums://all` | All albums | `Vec<Album>` |
| `tasks://all` | All tasks | `Vec<TaskInfo>` |
| `surf_records://all` | All surf records | `Vec<SurfRecord>` |
| `plugin://` | All plugins (trimmed) | 瘦身列表 |

## 资源模板（`list_resource_templates`）

共十条模板，供 Host 动态拼接：

- `images://id_{imageId}`、`images://id_{imageId}/metadata`
- `albums://id_{albumId}`、`tasks://id_{taskId}`、`surf_records://id_{surfRecordId}`
- `plugin://{pluginId}`、`plugin://{pluginId}/doc`、`plugin://{pluginId}/icon`、`plugin://{pluginId}/description_template`、`plugin://{pluginId}/doc_resource/{resourceKey}`

## 写工具（Rust MCP 服务器）

Rust 端通过 HTTP transport 暴露四个写入工具。Stdio Bundle 会透传这四个非删除写工具，并额外提供资源读取包装，详见下一节。

### `set_album_images_order`

为画册设置手动显示顺序。每次调用最多 100 张；更大的画册需要多次调用。

**输入 schema：**

```json
{
  "album_id": "string",
  "image_orders": [
    { "image_id": "string", "order": 0 }
  ]
}
```

**效果**：调用 `Storage::update_album_images_order`，写入 album_images 表的 order 字段。

**副作用**：手动顺序**不会**立即出现在画廊中——用户必须在画册里把排序模式切到「加入顺序」才看得到新排列。响应文本会提醒模型这一点。

### `create_album`

创建画册，可选挂在 `parent_id` 下作为子画册。

**输入 schema：**

```json
{
  "name": "string",
  "parent_id": "string | null"
}
```

**效果**：调用 `Storage::add_album`，返回新建的 `Album` JSON。

### `add_images_to_album`

把图片加入画册。重复图片被静默跳过。可同步指定每张的 order；未指定则自动追加在当前最后一张之后。

**输入 schema：**

```json
{
  "album_id": "string",
  "image_ids": ["string"],
  "image_orders": [
    { "image_id": "string", "order": 0 }
  ]
}
```

**效果**：调用 `Storage::add_images_to_album`，若提供了 `image_orders` 则再调 `update_album_images_order`。响应文本形如 `"Added X/Y images to album 'id'."`。

**副作用**：画册图片列表变化会通过 `album-images-change` 事件广播；已打开的画册画廊视图会实时刷新。

### `rename_image`

修改图片的显示名。

**输入 schema：**

```json
{
  "image_id": "string",
  "display_name": "string"
}
```

**效果**：调用 `Storage::update_image_display_name`。

**副作用**：通过 `images-change` 事件广播，所有打开的画廊视图刷新，图片的可见名在全局更新。

## MCPB stdio 桥（`kabegame-gallery-node`）

当 Host 只支持 stdio 时（例如 Claude Desktop），需要 MCPB 桥把调用转发到上面的 HTTP 端点。桥本身是一层带强校验的防御性子集，暴露范围比 Rust 服务器窄。

### 运行环境

| 项 | 值 |
|---|---|
| 平台 | `darwin` / `win32` / `linux` |
| Node.js | `>= 18.0.0` |
| MCP SDK | `@modelcontextprotocol/sdk ^1.18.0` |

### `user_config`

| 键 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `kabegame_mcp_endpoint` | string | `http://127.0.0.1:7490/mcp` | 仅回环（`127.0.0.1` / `localhost` / `::1`） |
| `request_timeout_ms` | number | `12000` | `1000`–`60000`，越界自动 clamp |
| `debug_logging` | boolean | `false` | — |

### 桥暴露的工具

所有工具响应都包在 `{ ok, data }` 或 `{ ok: false, code, message, details }` 里。错误码包括：`INVALID_ARGUMENT`、`UPSTREAM_HTTP_ERROR`、`UPSTREAM_MCP_ERROR`、`UPSTREAM_PROTOCOL_ERROR`、`TIMEOUT`、`UPSTREAM_REQUEST_FAILED`、`UNKNOWN_TOOL`、`UNEXPECTED_ERROR`。

#### `read_gallery_provider`

**输入 schema：**

```json
{ "path": "string" }
```

**校验**：非空；不能包含 `..`；不能以 `/` 开头；长度 ≤ 512。

**转发**：`resources/read`，`uri = "images://" + path`；如果 `path` 没有 scheme 且不是 `gallery/`、`vd/`、`id_` 或 `x{N}x/...` 开头，会自动映射到 `images://gallery/{path}`。

:::note
例如 `path = "all/desc/x100x/1"` 会转发到 `images://gallery/all/desc/x100x/1`；`path = "x100x/1"` 会转发到 `images://x100x/1`。
:::

#### `read_image`

**输入 schema：**

```json
{ "image_id": "string" }
```

**校验**：非空，长度 ≤ 256。

**转发**：`resources/read`，`uri = "images://id_{image_id}"`。

#### `read_image_metadata`

**输入 schema：**

```json
{ "image_id": "string" }
```

**校验**：非空，长度 ≤ 256。

**转发**：`resources/read`，`uri = "images://id_{image_id}/metadata"`。

#### `read_album`

省略 `album_id` 时转发 `albums://all`；提供 `album_id` 时转发 `albums://id_{album_id}`。

#### `read_task`

省略 `task_id` 时转发 `tasks://all`；提供 `task_id` 时转发 `tasks://id_{task_id}`。

#### `read_surf`

省略 `surf_record_id` 时转发 `surf_records://all`；提供 `surf_record_id` 时转发 `surf_records://id_{surf_record_id}`。旧的 host 直查不再支持。

#### `read_plugin`

省略 `plugin_id` 时转发 `plugin://`；提供 `plugin_id` 时默认转发 `plugin://{plugin_id}`。`resource` 可取 `icon`、`description_template`、`doc`、`doc_resource`，其中 `doc_resource` 需要 `key`。

#### `set_album_images_order`

与 Rust 工具同名同形，但在 schema 层显式声明 `maxItems: 100`。

**输入 schema：**

```json
{
  "album_id": "string",
  "image_orders": [
    { "image_id": "string", "order": 0 }
  ]
}
```

**校验**：`album_id` 非空；`image_orders` 长度在 `1`–`100` 之间；每项需非空 `image_id` 与整数 `order`。

### 桥未暴露的能力

MCPB 暴露和 HTTP MCP 同名的四个写工具，并额外提供上面的读工具包装。它仍保持以下限制：

- endpoint 只能指向本机回环地址。
- `read_gallery_provider` 只读取 `images://` 资源，不支持旧 `provider://` 的 `?without=images` 结构目录模式。
- `set_album_images_order` 单次最多 100 张，`add_images_to_album` 单次最多 1000 张。

若 Host 支持 HTTP transport（例如 Cursor），也可以直接连 `http://127.0.0.1:7490/mcp`，跳过 stdio 桥。

## 版本兼容性矩阵

| 能力 | 首次出现版本 |
|---|---|
| `images://` + 复数表 scheme 布局 | — |
| `set_album_images_order` | — |
| `create_album` | — |
| `add_images_to_album` | — |
| `rename_image` | — |
| MCPB stdio 桥 | — |

:::note
源码层未对上述能力做显式 since 门禁；应用一次发布即整套生效。本矩阵的「首次出现版本」待业主方确认后再填写。另见 CHANGELOG：`provider://` 与单数 DB resource scheme 已切换到 `images://` 和复数表 scheme，不存在向后兼容别名，任何缓存的旧 URI 都需更新。
:::

## 边界与错误

- **页码 0 非法**，永远从第 1 页开始。
- **页大小上限 1000**；超出 100 / 500 / 1000 三档的自定义值会被规整回 100。
- **旧 scheme 不再支持**：`provider://`、`image://`、`album://`、`task://`、`surf://` 都会返回 unknown scheme。
- **不要批量拉 plugin 重字段**：`plugin://` 和 `plugin://{id}` 返回瘦身对象，图标、描述模板、文档与文档资源要按子路径单独读取。
- **metadata 懒加载**：图片列表结果只带 `metadataId`，只有 `images://id_{id}/metadata` 会返回完整 metadata。
- **`surf_records://id_{id}` 以记录 id 为键**，不是 host。
- **不提供删除工具**：MCP 没有 delete-image / delete-album。服务器 instructions 明确建议模型把想删的图片收集到一个「待删除」画册里，由用户最终确认。
- **`set_album_images_order` 对用户不可见**：手动顺序要等用户把画册排序切到「加入顺序」才会显示；响应文本会提醒这一点。
- **`set_album_images_order` 分页**：单次最多 100 张，大画册需要多次调用。
- **Android 无 MCP**：服务器仅在桌面启动。
- **无鉴权**：MCP 绑定在 `127.0.0.1`，通过任何方式把 `7490` 暴露出去就等于开放读写。
- **端口冲突**：`7490` 被占用时，MCP 服务器启动失败，仅在控制台打印错误，UI 不会提示。

## 延伸阅读

- [MCP 服务](/guide/mcp/) — Host 接入流程与日常使用。
- [安装 MCP Bundle](/guide/mcp-bundle/) — 在 Claude Desktop 等 stdio Host 上使用。
- [画廊](/guide/gallery/) — `galleryPageSize` 与分页语义的来源。
- [插件使用](/guide/plugins-usage/) — `plugin://` 所对应的用户侧视图。
