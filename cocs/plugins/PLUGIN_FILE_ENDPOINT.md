# 插件文件按需读取：`/plugin_file`

列表、安装事件和商店详情只返回轻量 `Plugin`：身份、图标、原始 `packageJson`、解析后的配置、资源键 `assetKeys` 与 `fileOrigin`。
文档、更新日志、模板、推荐配置、图片字节、主脚本和迁移脚本不常驻插件 map。安装和扫描时仍校验声明的文本是否存在、UTF-8 与 JSON 是否合法；资源使用 ZIP 未压缩大小检查每文件 2MB、合计 10MB 上限，超限项不进入 `assetKeys`。

## 请求与来源

```text
GET /plugin_file/<plugin_id>/<逐段编码的包内路径>?v=<版本>
GET /plugin_file/<plugin_id>/<path>?v=<版本>&source=<sourceId>
GET /plugin_file/<plugin_id>/<path>?v=<版本>&preview=<token>
GET /plugin_file/<plugin_id>/<path>?v=<版本>&t=recommendedConfig
```

| 参数 | 语义 |
| --- | --- |
| `v` | 必填，必须与指定来源当前记录的插件版本完全一致 |
| `source` | 可选，选择该商店源的已下载 kgpg 缓存 |
| `preview` | 可选，选择导入预览登记的 kgpg；与 source 互斥 |
| `t` | 只接受 `recommendedConfig`，且路径必须是该插件声明的推荐配置 |

无来源参数读取已安装插件。`fileOrigin` 是带 `kind` 的对象：`{kind:"installed"}`、`{kind:"store",sourceId}` 或 `{kind:"preview",token}`。
导入文件登记在容量为 8 的 LRU 中；访问更新最近使用顺序，淘汰后 URL 返回 404。商店安装预览沿用 store 来源。
插件包在持有记录期间假定不被外部改写；安装与更新通过重新解析记录更新版本和白名单。

## 白名单与错误

核心层 `plugin/package_file.rs` 先用 `normalize_asset_path` 归一化请求，再只允许以下条目：

- `package.json`、`kbIcon`；
- `kbDoc`、`kbChangelog` 的全部 locale 路径；
- `kbDescriptionTemplate`、`kbRecommendedConfigs`；
- 通过大小上限的 `assetKeys`。

主脚本、迁移脚本和 provider DSL 不经 HTTP 公开，除非同一条目另被声明为允许公开的文件。路径越过插件根、未声明资源、资源超限、来源或插件不存在、版本不符、缺少版本、ZIP 条目缺失、读取失败、未知 t 均返回 404。该端点只读取 ZIP 条目，不把请求路径当宿主文件路径。

## 响应与缓存

普通文件带 `ETag`（插件版本、kgpg 大小与 mtime）、`Cache-Control: no-cache`。匹配 `If-None-Match` 返回 304；图片使用标准 MIME，Markdown、JSON、其它文本分别使用 `text/markdown`、`application/json`、`text/plain`，文本带 UTF-8 charset。

`t=recommendedConfig` 在宿主读 JSON 后注入 `pluginId`、路径 basename `filename` 和当前 `isImported`；清单内同名字段不能覆盖宿主注入值。
`isImported` 用当前运行配置的插件、URL、规范化变量、HTTP headers 和 dry-run 判断，忽略名称与定时设置。推荐配置始终 `no-store`，不接受条件缓存 304。原 `list_imported_recommended_presets` 命令已删除。

## 平台挂载

桌面本地文件服务、Web debug 与 release 文件服务都合并 `plugin_file_routes()`。Web dev 的 Vite 代理清单必须包含 `/plugin_file`，与 `/rpc`、`/events` 一起转发到 Rust Web 服务（7490）；否则同源文件请求会被 SPA 回退吞掉并返回 HTML。路由提供 CORS，允许 GET / HEAD / OPTIONS、`If-None-Match`，公开 ETag 和 Cache-Control 响应头。
Android 在 Rust 主进程按需启动仅含该路由的 `127.0.0.1:0` axum 服务；`get_http_server_base_url` 将端口交给 picker，Kotlin `LocalHttpServer` 转发 `/plugin_file/*` 的原始路径、查询串与条件请求头，并透传状态、正文和相关响应头。前端始终只使用同一个 HTTP host。

## 前端与脚本生命周期

`utils/fileUrl.ts::pluginFileUrl` 拼接版本与来源 URL。`services/pluginFiles.ts` 按完整 URL 缓存文本 Promise；请求失败删除缓存。插件安装或更新版本变化，以及删除插件时，按 pluginId 失效。
文档和更新日志的语言路径遵循 locale → default，打开相应 tab 才请求。Markdown 的本地图片必须命中 `assetKeys`，然后改写为 HTTP URL；banner 按声明顺序生成同源 URL。
图片详情等模板请求完成后再决定渲染 EJS 或原始 metadata，切换插件时忽略晚到的旧结果。
自动配置推荐 tab 按清单先生成同一个 grid 中的占位卡，各配置独立完成后替换；自身配置写命令直接返回并应用动态导入态，序号去重；外部运行配置事件才防抖重读，期间保留已有卡片。写结果与在途 HTTP 的竞态处理见 [任务与配置按需加载](../downloader-tasks/TASK_DRAWER_LOAD.md#运行配置写操作主动同步结果异步补位)。商店详情只做内存缓存；Dexie 只保留商店图标表。

任务冻结时 `load_script` 从 main 读取源码到 `TaskParams.plugin`，以 `Arc<str>` 保存快照；列表仍只持 backend。内建插件继续携带静态源码。
迁移调度只保留路径，执行时读取迁移脚本。MCP 的 doc / changelog / template / asset 复用按需 ZIP 读取，输出字段形状保持不变。
