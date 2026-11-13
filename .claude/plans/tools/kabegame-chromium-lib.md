# kabegame-chromium：vite 持有 CDP 连接，stdio MCP 单独成包

> 来源：2026-11-08 的 `ignore/` 基建工具盘点（本地存档 `ignore/tools-inventory.md`）。用户定（2026-11-08）：
> - **归属：** 驱动 dev 应用的 CDP 工具归 `kabegame-chromium`。
> - **vite：** 维持 CDP 的 WebSocket 连接和状态，对外提供 REST 接口。可以直接调，也可以经 MCP 调。vite 不做 MCP。
> - **MCP：** 只做 stdio，作为单独的 app 包放 `apps/`，单独管理依赖（`@modelcontextprotocol/sdk`），不构建直接能跑。它提供 vite 已有的能力，以及别的封装好的工具和资源。
> - **探活：** 分两层，vite 在不在；经 vite 探 CDP 在不在（预期在，除非热重载重启）。
> - **去掉的：** playwright。安卓的 adb forward 放进 vite（安卓 dev 用 `--mode android` 跑，vite 知道）。命令行不用 bash，用 JS / TS。
>
> `wpe-renderdoc` 扩展、粒子对比 skill 等其它工具暂不定，本计划不碰。

## 总体设计思路

`kabegame-chromium` 现在是 bash 的 `driver.sh` 加 playwright 的 `cdp.mjs`。每次调用都重新找端口、重新连接，做完截图、求值、点击就断。看界面够了，做验收不够。

场景壁纸 P3、P4 的验收于是在 `ignore/` 里另长出一条裸 WebSocket 的 CDP 库链，约 260 个脚本靠它做这些事：调应用命令、找场景宿主、在宿主里跑探针、渲染取图、测画面哈希、导入和移除测试工程。这些操作天然有状态：attach 到宿主 iframe 的 session、开出来的屏外宿主、在跑的探针任务、收集中的控制台消息。现在每个脚本自己从头建一遍，脚本一退出就全丢。

**改造后分两块，中间是 REST：**

1. **vite 插件 `kabegame-dev`（`scripts/kabegame-dev/`）持有连接和状态，对外是 REST。**
   - vite 本来就是 dev 的集合点：桌面 app 起来后向它登记 CDP 端口，debug ingest 也走它；它和 app 同生共死，只在 dev 存在。
   - 插件在 vite 进程里持有：
     - 到 app 的唯一一条 CDP 连接；
     - 找 CDP 端点的全部逻辑（桌面读登记，安卓按 vite 的 `isAndroid` 走 adb）；
     - 宿主句柄、控制台缓冲、后台任务这些状态。
   - 对外是 `/__kabegame_dev/*` 下的 REST：JSON 进出，截图直接回 `image/png`。
   - **不依赖任何 MCP 的东西。** 脚本用 `fetch` 或 curl 就能直接调，验收脚本不必经 MCP。
2. **stdio MCP 是单独的包 `apps/kabegame-dev-mcp/`**（`@kabegame/dev-mcp`，自己的 `package.json` 管 SDK 依赖，Deno 直接跑 TS，不构建）。由 Claude Code 拉起，和会话同生共死，不依赖 vite 活着。它提供三类东西：
   - **探活 `status`**：两层，vite 在不在；经 vite 问 CDP 在不在。CDP 预期在，不在时多半是 vite 热重载重启，报原因和下一步；
   - **vite 已有能力的工具**：一对一包 REST 接口；
   - **封装好的工具和资源**：
     - 不需要 vite 的，比如读应用日志、比两份画面哈希基线；
     - 多次调用组合成一步的，比如「渲染某张场景一帧」自己开屏外宿主、渲染、关掉，「等任务完成」；
     - MCP 资源：探活、目标列表、任务、应用日志。

   工具表是静态的：vite 不在时工具照常列出，调用时报清楚是哪一层不在，所以不需要 `tools/list_changed`。vite 重启后 REST 没有会话要恢复，下一次调用自然就通了，一个 Claude 会话里一直可用。

**typed 客户端**（`apps/kabegame-dev-mcp/src/client.ts`）MCP 自己用，脚本也能 import。`kabegame-plugin` 的 `app-run.sh` 改写成用它的 `app-run.ts`。`driver.sh`、`cdp.mjs` 删掉。

去掉 playwright 之后，三个老问题一起没了：
- **进不了场景宿主：** 场景宿主是跨进程的 iframe，playwright 的 page 级连接进不去；裸连接用浏览器级的 flatten session，进得去。
- **被别的窗口拖累：** playwright 一连就 attach 全部 page，任一窗口忙都会卡住握手；裸连接只 attach 用到的目标。
- **劫持下载：** playwright 会改写浏览器的下载行为；插件不发 `Browser.setDownloadBehavior`。

几个关键决定：
- **端点发现只在 vite 里。** 桌面读 debug server 收到的登记（内存，再读落盘的 `cdp-port.json`），并用 `/json/version` 的 `webSocketDebuggerUrl` 验活。安卓每次连接前重新 `pidof`（pid 每次启动都变），复用应答的转发、清掉指向旧 socket 的转发。不再用 `lsof` 扫端口：vite 是唯一来源。
  - 代价：不经 vite、直接跑编好的 dev 二进制时没有这组工具。现在的 `driver.sh` 靠扫描兜底能连上，这条路径以后不支持。
- **状态放 vite，组合放 MCP。** 要持有连接或句柄的都在 vite；只读文件、或几次 REST 调用拼起来的，放 MCP。vite 保持小而通用，MCP 可以随需要加封装，不碰 vite。
- **长任务走任务表。** 画面哈希要渲染 60 次，导入要等后台任务完成，几分钟的事。这类任务由 vite 起，REST 立刻返回任务 id，再查进度和结果。MCP 另给一个「等任务完成」的封装。
- **宿主校验保留。** 只信任「入口脚本 = 磁盘上产物入口」的新 frame（P3c 的教训：旧 frame 跑旧代码，档位选项会被悄悄忽略）。
- **测试工程只移除、不删除。** 只调 `batch_remove_images`，只动路径在仓库 `ignore/` 下的行；有一行不符就整批拒绝。绝不调 `batch_delete_images`（盘点发现 11 个旧脚本调了它，会连源文件一起删）。
- **只接受本机访问。** REST 只接受回环地址的请求，`Origin` 只认 localhost / 127.0.0.1（防 DNS 重绑定），和 debug server 同一套判断。
- **`ignore/` 里的旧脚本不动**，继续按原样能跑；以后的步骤改用 REST 或 MCP。

## 现状锚点

**a. 技能入口是 bash + playwright，每次新建连接**（`.claude/skills/kabegame-chromium/driver.sh:339`；`cdp.mjs`）
```bash
case "$SUB" in
  status) cmd_status ;;                              # 现状：vite / 登记 / lsof 扫描三条路找端口
  targets | shot | eval | click | text)              # 现状：交给 playwright 的 cdp.mjs，用完即断
    PORT="$(resolve_port)" || exit 4
    KABEGAME_CEF_DEBUG_PORT="$PORT" node "$SKILL_DIR/cdp.mjs" "$SUB" "$@"
    ;;
esac
# --android：adb pidof → @webview_devtools_remote_<pid> → adb forward tcp:0（现状：在 bash 里）
```

**b. vite 上的 CDP 端口登记**（`scripts/vite-debug-server.ts:73`；接入 `vite.config.pub.ts:31`；安卓判定 `vite.config.pub.ts:18`）
```ts
export function kabegameDebugServer(options: KabegameDebugServerOptions): Plugin {
  let cdp: CdpRegistration | null = null;   // 现状：app POST /__kabegame_cdp/register 写这里并落盘 cdp-port.json，只给 driver.sh 查
}
export const isAndroid = process.env.TAURI_PLATFORM === "android" || process.env.VITE_ANDROID === "true";
```

**c. 裸 CDP 连接与宿主工具在 `ignore/`**（`ignore/p3a/cdp.mjs`、`ignore/p3c/step3/lib.mjs`）
```js
export async function connect(port) {
  const ws = new WebSocket(ver.webSocketDebuggerUrl);   // 浏览器级连接，flatten session
}
const DIST_INDEX = resolve(REPO, "target/debug/resources/wpe-scene/index.html"); // 现状：不认 CARGO_TARGET_DIR
export const PREVIEW_ID = "12880";                                                // 现状：库内 id 写死
```

**d. 渲染取图、导入移除、画面哈希各写各的**（`ignore/hdr-macro/fix/ours.mjs`、`ignore/p4/b1/import.mjs`、`cleanup.mjs`、`ignore/p3c/step3/baseline.mjs`）
```js
for (let i = 0; ; i++) { /* 现状：每个脚本自己拼 __kabegameSceneProbe.chunk，14 处 */ }
const PROJ = "D:\\Codes\\kabegame\\ignore\\p4\\proj";              // 现状：路径写死
const IDS = ["12888", "12889", "12880", "12881", "12885", "13114"]; // 现状：P4 靠 --ids 传 135xx
```

**e. 依赖 driver.sh 的地方**
```text
.claude/skills/kabegame-plugin/scripts/app-run.sh   CHROME=…/driver.sh；经它 eval __TAURI_INTERNALS__.invoke 跑插件任务
.claude/skills/kabegame-plugin/SKILL.md:82、249、278；references/webview.md:107   C=…/driver.sh 的用法示例、playwright 劫持下载的提醒
cocs/debug/DEBUG_INGEST.md:197–213、cocs/README.md:287   CDP 端口寄存「交给 kabegame-chromium skill / driver.sh」
cocs/surf/ANDROID_SURF.md:332   playwright 下发的下载行为
scripts/vite-debug-server.ts:15、scripts/plugins/component-plugin.ts:174   注释
```

**f. workspace 与 MCP 配置**（`package.json:5`、`deno.json`、`.mcp.json`）
```jsonc
"workspaces": ["apps/*", "packages/*", …]                 // 现状：apps/ 下的包自动是 workspace 成员
{ "nodeModulesDir": "manual", "nodeModulesLinker": "hoisted" } // 依赖提升到根 node_modules，deno install 在根执行
{ "mcpServers": { "kabegame": { "type": "http", "url": "http://127.0.0.1:7490/mcp" }, "agent-browser": {…}, "renderdoc": {…} } }
```

## 点 1 — vite 插件的核心模块（新增 `scripts/kabegame-dev/`）

不依赖 vite 和 MCP，只用 `fetch`、`WebSocket`、`node:fs`、`node:child_process`（adb）。

- **新增** `cdp.ts`：
  - `connectCdp(webSocketUrl)`：浏览器级 WebSocket，flatten session，提供 `send`（带超时）、`on`、`targets`、`attach`、`detach`、`evaluate`、`close`，连接断开时拒绝全部待回请求；
  - 目标判定 `isMain` / `isWallpaper` / `isSceneHost`、按 URL 子串选目标：`isMain` 用 `driver.sh` 那条规则（应用自身页面，即 :1420、`tauri:`、`tauri.localhost`，路径不以 `.html` 结尾）；
  - 不发 `Browser.setDownloadBehavior`，不开全局 auto-attach。
- **新增** `endpoint.ts`：
```ts
/** 当前 CDP 端点 { kind: "desktop" | "android", port, webSocketUrl, pid?, serial? }，或失败的那一层与原因。 */
export function resolveEndpoint(options: { android: boolean; debugDir: string }): Promise<Endpoint | EndpointError>;
```
  - **桌面**：读 `vite-debug-server.ts` 导出的登记，用 `/json/version` 的 `webSocketDebuggerUrl` 验活（vite 的 SPA 兜底对任意路径回 200，不能只看状态码）；
  - **安卓**（移植 `driver.sh` 的 `resolve_android_port`）：
    - `adb shell pidof <包名>`（缺省 `app.kabegame.dev`，`KABEGAME_ANDROID_PACKAGE` 覆盖）；
    - 在 `/proc/net/unix` 里确认 `@webview_devtools_remote_<pid>` 存在；
    - `adb forward --list` 里有指向这个 socket、且应答的转发就复用，否则 `adb forward tcp:0` 新建；
    - 移除指向别的 `webview_devtools_remote_*` 的旧转发；
    - `ANDROID_SERIAL` 照常生效。
- **新增** `paths.ts`：`ROOT`；`TARGET`（`CARGO_TARGET_DIR` 或 `ROOT/target`）；`SCENE_DIST`（`TARGET/debug/resources/wpe-scene`）；`DEV_DATA`（`ROOT/.kabegame/debug/data`）。
- **新增** `page.ts`：`listTargets`；`evaluate(目标, 表达式)`；`screenshot(目标, { selector?, clip?, fullPage? })`（`clip` 是矩形 `{ x, y, width, height, scale? }`，CSS 像素、相对目标页面视口；三者互斥。目标是场景宿主时，按 iframe 在主窗口里的位置换算后从主窗口截）；`click(目标, 选择器)`（取元素中心派发鼠标事件，不等可操作性，相当于原来的 `force: true`）；`text(目标, 选择器)`；`console` 流（按目标收集 `Runtime.consoleAPICalled`）。目标是 `main` / `wallpaper` / `url:<子串>` / `host:<句柄或 instance>`。
- **新增** `app.ts`：`invoke`（在主窗口求值 `__TAURI_INTERNALS__.invoke`，不包装它）、`mainState`、`openPreview` / `closePreview`（Vue 内部，失败返回原因）、`appState`（当前壁纸、模式、暂停、禁用、场景后处理、过渡、样式、轮播、路由）。
- **新增** `scene.ts`（只在桌面）：
  - `sceneHosts`；
  - `openHost({ hidden = true, scene })`：
    - 屏外 iframe，不碰用户的预览；
    - 只信任入口脚本等于 `SCENE_DIST/index.html` 入口的 frame，并要求 dev 探针在（宿主要用 `--mode development` 构建）；
    - `scene` 缺省取库里第一张 `x-wpe/scene`；
  - `hostTask`：在宿主里起 Promise、轮询取结果，宿主主线程 90 s 无应答才放弃，槽位放 `window.__kbTask`；
  - `renderFrame`：先 `renderFrame`，再按 chunk 取回 PNG，目录由 `wpe_scene_target` 按图片 id 取。
- **新增** `library.ts`：
  - `importProjects(dirs)`：
    - 逐个 `wpe_recognize_dir`，再一次 `start_task(wpe-import, extraDirs)`；
    - 翻页 `pathql_fetch images://gallery/media-type/x-wpe/scene/_kb_x500x/<页>`，按目录找行；
    - 返回 `{ <目录>: { image, task } }`。
  - `removeProjects(manifest, { allowPrefix })`：
    - 先用 `wpe_scene_target` 核对每行都在 `allowPrefix`（缺省 `ROOT/ignore`）之下，任一不符整批拒绝；
    - 只调 `batch_remove_images`，再 `delete_task`。
- **新增** `hash.ts`：`hashBaseline`。每张场景三档、固定时刻各渲染两次，两次不同就停。记录输入（目录、用户属性、metadataId、工程文件摘要）、每档 sha256 与元数据、宿主入口。格式和现在的 `hash-*.json` 相同。
- **新增** `jobs.ts`：任务表 `start / get / list / cancel`（协作式取消，收 `AbortSignal`），保留最近 20 个结果。

## 点 2 — REST 接口（新增 `scripts/kabegame-dev/rest.ts`、`plugin.ts`）

前缀 `/__kabegame_dev`。请求和响应都是 JSON，截图回 `image/png`。出错时回 `{ error, layer }`：CDP 不可用回 503 并带端点结论，参数错回 400，句柄或任务不存在回 404（提示 vite 可能重启过）。

| 方法 与 路径 | 做什么 | 平台 |
|---|---|---|
| `GET /health` | `{ vite: true, android, cdp: Endpoint \| EndpointError, session }`：经 vite 探 CDP，同时报连接、句柄、任务的摘要 | 都有 |
| `GET /targets` | page 与 iframe 目标（URL、类型、父目标） | 都有 |
| `POST /eval` | `{ target, expression, timeoutMs? }` → 值 | 都有 |
| `POST /screenshot` | `{ target, selector? \| clip? \| fullPage? }` → PNG。`clip` 截矩形 `{ x, y, width, height, scale? }`（CSS 像素） | 都有 |
| `POST /click`、`POST /text` | `{ target, selector }` | 都有 |
| `POST /invoke` | `{ command, args? }` → 值 | 都有 |
| `POST /console`、`GET /console/:id?since=`、`DELETE /console/:id` | 开始收集 / 取新增 / 停 | 都有 |
| `GET /app/state` | 应用状态快照 | 都有 |
| `GET /android/screen` | `adb exec-out screencap` → PNG | 安卓 |
| `GET /hosts`、`POST /hosts`、`DELETE /hosts/:h` | 列出 / 开 / 关场景宿主（开返回句柄与产物入口） | 桌面 |
| `POST /hosts/:h/eval` | 在宿主里求值 | 桌面 |
| `POST /hosts/:h/render` | `{ imageId, time?, postprocess? }` → `{ meta, png }`（PNG 用 base64） | 桌面 |
| `POST /projects/remove` | `{ manifest, allowPrefix? }` | 桌面 |
| `POST /jobs` | `{ kind: "host-task" \| "hash-baseline" \| "projects-import", params }` → `{ id }` | 桌面 |
| `GET /jobs`、`GET /jobs/:id`、`DELETE /jobs/:id` | 列出 / 查（状态、进度、结果）/ 取消 | 都有 |

- **新增** `plugin.ts`：
```ts
/**
 * dev 专用（apply: "serve"）。挂 /__kabegame_dev/* 的 REST；只接受回环地址，带 Origin 时只认 localhost / 127.0.0.1。
 * CDP 连接懒建立，断开后下次请求经 resolveEndpoint 重连。vite 关闭（含改配置自动重启）时关掉全部宿主句柄（移除屏外
 * iframe）、取消任务、断开 CDP。
 */
export function kabegameDev(options: { workspaceRoot: string; android: boolean }): Plugin;
```
- **修改** `scripts/vite-debug-server.ts`：导出 `currentCdpRegistration(debugDir)`（内存优先，再读落盘）。
- **修改** `vite.config.pub.ts`：`plugins` 里接上 `kabegameDev({ workspaceRoot, android: isAndroid })`。

## 点 3 — stdio MCP 包（新增 `apps/kabegame-dev-mcp/`）

- **新增** `package.json`：`@kabegame/dev-mcp`，`private`，`type: module`。依赖 `@modelcontextprotocol/sdk`、`zod`，只在这个包里声明。workspace 是提升安装，装在根 `node_modules`。
- **新增** `src/client.ts`：REST 的 typed 客户端。
  - 每个接口一个函数，外加 `health()`、`waitJob(id, { onProgress })`；
  - vite 端口取 `KABEGAME_DEV_SERVER_PORT`，缺省 1420；
  - 连接失败统一抛出带层级的错误（「vite 不在」/「CDP 不在」+ 原因）。

  MCP 用它，脚本也能 `import` 它。
- **新增** `src/main.ts`：SDK 的 `McpServer` + `StdioServerTransport`，日志写 stderr。Deno 直接跑：
```text
deno run --allow-net=127.0.0.1,localhost --allow-read --allow-write --allow-env apps/kabegame-dev-mcp/src/main.ts
```
  `--allow-write` 给落盘截图和画面哈希结果。不给 `--allow-run`：adb 只在 vite 里调。
- **新增** `src/tools.ts`，工具分三类：
  - **探活：** `status`。
    - 第 1 层：vite（`/__kabegame_dev/health`）在不在。不在：dev 没跑，请用户启动 `deno task dev -c kabegame`（安卓加 `--mode android`），不代起；
    - 第 2 层：health 里的 CDP 结论。不在时说明可能原因：vite 刚热重载、app 还在编译、app 已退出；安卓是没设备、app 没在跑、没有调试 socket。
  - **vite 能力的一对一工具：** `targets`、`eval`、`screenshot`（回 image，可落盘）、`click`、`text`、`invoke`、`console`、`app_state`、`android_screen`、`hosts`、`host_open`、`host_close`、`host_eval`、`host_render`、`projects_remove`、`job`。
  - **封装好的工具：**
    - `render_scene`：给图片 id，自己开屏外宿主、渲染、关掉，回图片和元数据；
    - `hash_baseline`：起任务并等完成，期间用 MCP 进度通知报进度；参数是 `ids`，或 `from`（旧基线按目录对应），结果写 `out`；
    - `projects_import`：起任务并等完成，清单写进给定文件；
    - `hash_compare`：只读两个文件，按 `input.path` 对应，比哈希与 unsupported，不需要 vite；
    - `app_log`：`mark` / `since`，直接读 `.kabegame/debug/data/logs/kabegame.<UTC 日期>.log`，跨日期也能读，不需要 vite。
- **新增** `src/resources.ts`：
  - `kabegame-dev://health`：探活结果；
  - `kabegame-dev://targets`；
  - `kabegame-dev://jobs`、`kabegame-dev://jobs/{id}`；
  - `kabegame-dev://app-log/{date}`：资源模板，最后 2000 行。
- 工具表是静态的：vite 不在时照常列出，调用时报是哪一层不在。所以不用 `tools/list_changed`，dev 晚于会话启动也不用重连。

## 点 4 — 迁移与文档

- **删除** `.claude/skills/kabegame-chromium/driver.sh`、`cdp.mjs`（playwright 不再用；仓库里 `apps/docs`、`scripts/take-screenshots.ts` 自己的 playwright 依赖不动）。
- **删除** `.claude/skills/kabegame-plugin/scripts/app-run.sh`，**新增** `app-run.ts`：参数不变，用 `client.ts` 的 `invoke` 调 `refresh_plugins` → `start_task` → 轮询 `get_task` / `get_task_logs`，超时 `cancel_task`，输出不变。
- **修改** `.claude/skills/kabegame-plugin/SKILL.md`、`references/webview.md`：示例改成 MCP 工具或 REST（`curl -s localhost:1420/__kabegame_dev/eval -d '{"target":"url:surf",…}'`）的写法；「playwright 劫持下载」的提醒改为「CDP 连接不改下载行为」，改之前先实测一次，没测就写明未测。
- **修改** `cocs/debug/DEBUG_INGEST.md`、`cocs/README.md`：CDP 端口寄存的消费方改成 `kabegame-dev` 插件，补 `/__kabegame_dev` 一句；`cocs/surf/ANDROID_SURF.md:332` 的 playwright 那句改写；`scripts/vite-debug-server.ts:15`、`scripts/plugins/component-plugin.ts:174` 的注释。
- **修改** `.mcp.json`：加 `"kabegame-dev": { "command": "deno", "args": [上面的运行参数] }`。加完要在 Claude Code 里 `/mcp` 重连或重开会话，这一步由用户做。
- **修改** `.claude/skills/kabegame-chromium/SKILL.md`：整篇重写。
  - **`description`：** 加上「调应用命令、操作场景宿主、渲染场景帧、画面哈希、导入 / 移除测试工程」。
  - **正文：**
    - 架构（app → vite 登记 / adb，vite 持有连接、对外 REST，MCP 探活与封装）；
    - MCP 工具与资源表、REST 接口表；
    - 脚本写法（import `client.ts`，或直接 `fetch`）；
    - 长任务；
    - 安卓；
    - 端点链路（原「端口是怎么串起来的」）。
  - **Gotchas：** 保留仍成立的几条（壁纸窗口截不到图、Android WebView 连过 CDP 后附件下载不再触发），新增几条：
    - 宿主要用 `--mode development` 构建；
    - 只信任新加载的宿主；
    - vite 重启会丢句柄和任务；
    - `openPreview` 依赖 Vue 内部；
    - 只用 `batch_remove_images`；
    - 不经 vite 跑 dev 二进制时没有这组工具。
- **修改** `AGENTS.md`「架构 / 单体仓库布局」加一行 `apps/kabegame-dev-mcp/`。`AGENTS.md:168` 的技能名不变。

## 分批

- **第 1 批（不需要新依赖，dev 跑着就能做）：**
  - 点 1、点 2：vite 插件、REST 与单测；
  - 点 3 里的 `client.ts` 和它的单测。`apps/kabegame-dev-mcp/package.json` 先不写依赖，只有包名等字段。
  - 端到端只测 REST。
  - 改 vite 配置所引用的文件（`vite-debug-server.ts`、`vite.config.pub.ts`）放在最后一次做完，vite 只重启一次；`scripts/kabegame-dev/` 在接上之前不被 vite 引用，开发时不触发重启。
- **第 2 批（依赖装好之后）：**
  - 点 3 的 MCP 本体（`main.ts`、`tools.ts`、`resources.ts`）；
  - `package.json` 加依赖，`.mcp.json`；
  - 点 4 的删除、迁移与文档。

  依赖要用户停 dev 时装。

## 验收

子代理实现，Claude 独立验收。

**两点提前说明：**
- **装依赖要停 dev。** 新包的依赖要在根执行 `deno install`，按约定 dev 在跑时不能装。实现和单测（vite 侧）不需要 dev；MCP 包的单测和端到端，要先装好依赖、再请用户起 dev。
- **改插件文件会让 vite 自己重启一次**（vite 监视配置文件的依赖）。app 前端会重连 HMR、可能整页刷新。dev 本身不重启，CDP 登记有落盘，不受影响。

- **单测：**
  - vite 侧（`deno test scripts/kabegame-dev/`）：
    - 端点发现：桌面用假的登记和假的 `/json/version`；安卓用假的 adb，覆盖复用转发、清旧转发、没设备、没 socket；
    - REST 路由：回环与 `Origin` 校验，404 / 400 / 503 的形状；
  - MCP 侧（`deno test apps/kabegame-dev-mcp/`）：
    - 用一个假的 REST 服务测 `status` 的两层结论；
    - vite 不在时工具照常列出、调用报层级；
    - `hash_compare` 按目录对应；
    - `app_log` 跨日期。
- **端到端（桌面，dev 在跑）：** 先用 curl / `client.ts` 打 REST；`.mcp.json` 加好、用户重连后，再从 Claude Code 里调一遍 MCP。
  - **基础工具：**
    - `status`、`targets`；
    - `eval main document.title`、`eval url:wallpaper …`；
    - `screenshot` 回图；`click`、`text`；
    - `invoke get_wallpaper_mode`；
    - `console`：开始收集后在页面里 `console.log`，`read` 读得到。
  - **场景宿主：** `host_open` → `host_eval` 读探针 → `host_close` 后没有残留 iframe。
  - **画面哈希：** 宿主产物和 P4c 步骤 1 那轮相同时，`hash_baseline from=ignore/p4/c1/out/hash-after.json` 完成后，`hash_compare` 报 30 组全同。
  - **渲染：** `render_scene` 一张干净场景，PNG 的 sha256 和基线里同档同时刻的记录相同。
  - **测试工程：**
    - `projects_import ignore/p4/proj/p4c-cp` → `render_scene` 能渲染 → `projects_remove` 后库里的行和任务都没了，目录和文件都还在；
    - 用路径在 `ignore/` 外的清单调 `projects_remove`，整批拒绝，库不变。
  - **不留痕迹：** `app_state` 在验收前后一致，没有残留宿主。
- **会话内保持：** 验收中途碰一下插件文件让 vite 重启。重启期间 `status` 报第 1 层或第 2 层不在；起来后，同一个 Claude 会话里下一次调用照常成功；旧句柄回 404，提示重开。
- **dev 晚于会话启动：** 停着 dev 开会话，工具照常列出，调用报「vite 不在」；起 dev 后同一会话里直接可用。
- **迁移：** `app-run.ts` 跑一个 V8 插件的小任务，输出和原 `app-run.sh` 同一格式；全仓库 grep 不再有 `kabegame-chromium/driver.sh`、`cdp.mjs` 的引用。
- **安卓：** 有设备、用户起了 `--mode android` 的 dev 时验：`status`、`targets`、`eval`、`screenshot`、`android_screen`、`invoke`；没有就记下未验。
- **安全：** 非回环来源、`Origin: http://evil.example` 的请求被拒。
- **类型与格式：** `deno check` 新增的 TS；根 tsconfig 覆盖到的部分过 `check-kabegame --skip cargo`；Prettier。

## 风险

1. **探针接口变了，接口要跟着改。** `renderFrame`、`chunk` 是 `apps/wpe-scene/src/dev/` 的 dev 探针，改探针时同步 `scene.ts`，SKILL.md 写明这层依赖。
2. **vite 重启丢状态。** 句柄、任务、控制台流都在 vite 进程里。接口要回 404 并说明，不能静默返回空。
3. **测试会改 dev 库。** 导入、移除只用 `ignore/` 下的测试工程，验收后核对没有残留。
4. **少了不经 vite 的兜底。** 只重启 vite、或直接跑 dev 二进制时，`driver.sh` 原来靠 `lsof` 扫描能连上，以后不行。桌面 vite 重启期间登记有落盘，起来就恢复。
5. **下载劫持。** 去掉 playwright 后，桌面 CEF 预期不再被劫持下载，要在 `kabegame-plugin` 的 WebView 流程里实测一次再改文档。Android WebView 连过 CDP 后附件下载不触发的问题和 playwright 无关，照旧保留。
6. **REST 与 MCP 两份描述。** 接口改了要同时改 `client.ts` 和工具描述。`client.ts` 是唯一的 typed 入口，MCP 工具只经它调，单测覆盖每个接口至少一次。

## 实施记录

### 第 1 批 — vite 插件、REST 与 client（2026-11-08）

子代理实现，Claude 独立验收。

- **新增** `scripts/kabegame-dev/`：
  - 核心模块：`paths`、`cdp`、`endpoint`、`session`、`page`、`app`、`scene`、`library`、`hash`、`jobs`；
  - REST 与 vite 胶水：`rest`、`plugin`；
  - 计划外加的：`types`（REST 共用类型）、`errors`、`backend`（不经 vite 也能组装）、`localHttp`（本机直连的请求与 WebSocket，见下）；
  - 单测：`node:test` 写，`deno test` 跑。
- **新增** `apps/kabegame-dev-mcp/package.json`（只有包名等字段，没写依赖）、`src/client.ts` 与单测。
- **修改** `scripts/vite-debug-server.ts`：登记移到模块级，导出 `currentCdpRegistration`；`vite.config.pub.ts` 接上 `kabegameDev`。

和计划不同、或计划没写、由代理按证据定的：

- **错误码：** 除 400 / 404 / 503，另用：
  - 422：页面抛错、找不到目标或元素、应用命令被拒；
  - 504：超时；
  - 403：来源不对、测试工程护栏；
  - 405、409（宿主产物问题）、413；
  - 500：插件内部错误。
- **安全：** 另校验 `Host` 头。DNS 重绑定时，同源 GET 不带 `Origin`。
- **测试工程护栏比计划严：**
  - `allowPrefix` 本身必须在 `<仓库>/ignore` 之内，导入目录也一样；
  - 移除时核对清单里的目录和库里实际目录一致；
  - 任务必须是只导入前缀下工程、且已结束的 `wpe-import`。
- **应用状态：** `get_wallpaper_disabled` 已不存在，改用 `get_wallpaper_enabled`。
- **渲染结果：** `meta.sha256` 是探针算的 RGBA 像素摘要，另回 PNG 文件本身的 `pngSha256`。
- **eval：** 在 vite 进程里用 `new Function` 只编译、不执行，判断是表达式还是语句块；不会像原 `cdp.mjs` 那样把同一段代码跑两遍。
- **截图：** 屏外宿主截不到，回 422，提示改用渲染接口。
- **本机请求一律直连**（Claude 验收时发现的 bug）：本机环境有 `HTTP_PROXY=127.0.0.1:7890`。Deno 的全局 `fetch` 和 `WebSocket` 发往 127.0.0.1 也走代理，vite 不在时代理回 502，client 误报成「vite 在但没有插件」；vite 到 CDP 的 WebSocket 原先也在走代理。改成 `localHttp.ts`：`node:http` + `agent: false` 的 `localFetch` 和最小 WebSocket 客户端。Node、Deno 都直连，也不受 `NODE_USE_ENV_PROXY` 影响。代理单测放子进程里跑，因为 Deno 第一次请求后就缓存了代理设置。

验收结果：

| 项 | 结果 |
|---|---|
| 单测（不设 `NO_PROXY`，带代理环境） | `scripts/kabegame-dev/` 15 组 65 步、`apps/kabegame-dev-mcp/` 4 组 9 步全过（Claude 自跑）；`deno check`、Prettier 通过；根 tsc 错误数 867 → 867，新文件 0 个 |
| 探活与安全（Claude 实测） | `/health` 报 vite 在、桌面 CDP 47370 应答；`Origin: http://evil.example` 回 403；client 连空端口报 vite 层 |
| 基础接口（Claude 实测） | `invoke get_wallpaper_mode` → `window`；`eval main location.pathname` → `/gallery`；`clip` 200×100 在 DPR 1.5 下得 300×150 的 PNG，内容是主窗口左上角 |
| 截图（代理端到端） | 整页 1779×1145、元素 180×60、`clip` 150×75、`clip` 加 `scale 2` 300×150，尺寸全部对得上 |
| 场景宿主 | 开、在宿主里读探针、渲染、关；关完没有残留的屏外 iframe |
| 画面哈希 | 旧脚本参照（88 s）和新任务（92 s）同一份宿主产物，30 组哈希、档位、尺寸、格式、unsupported、输入全部相同 |
| 渲染 | 13515 ultra、13534 enabled 两张的像素摘要和参照相同 |
| 测试工程 | 导入 `p4c-cp`（图片 14176）后能渲染；移除后行和任务都没了，场景行数 154 → 154，目录里 30 个文件的大小和 mtime 不变；`ignore/` 外的清单、混合清单都整批拒绝，库不变 |
| 会话内保持 | 改插件文件触发 vite 重启后，下一次调用直接成功，旧句柄回 404；另外不经页面刷新验证了收尾路径：iframe 被移除、任务被取消 |
| 不留痕迹 | 结束时应用状态和开始时一致，没有残留宿主 |

**没在真环境验的：**
- 安卓：只有用假 adb 的单测；
- 壁纸窗口的正向求值：当前壁纸关着，没有壁纸窗口；
- 哈希基线的 `from` 参数；
- 非屏外的预览宿主：用户开着预览，没有接管。

**vite 重启了 3 次：** 接入 1 次、测会话内保持 1 次、修代理 1 次。每次 app 主窗口都会整页刷新。`deno.lock` 没变。

**测试行：** 开发期间导入、移除过两次 `p4c-cp`（14175、14176），都只用 `batch_remove_images` 移除，任务已删。

### 第 2 批 — stdio MCP、迁移与文档（2026-11-08）

依赖由 Claude 在用户停掉 dev 后装：`apps/kabegame-dev-mcp/package.json` 加 `@modelcontextprotocol/sdk` ^1.32.2、`zod` ^3.25.76（对齐 `node_modules` 里已有的 zod，避免装两份），在根 `deno install`。`deno.lock` 里已有包的版本都没变，删掉的行是新 Deno 把 peer 依赖后缀写得更短。代码由子代理实现，Claude 独立验收。

- **新增** `apps/kabegame-dev-mcp/src/`：
  - `main.ts`：stdio，日志全走 stderr，stdin 结束就退出；
  - `tools.ts`：22 个工具；
  - `resources.ts`：5 类资源；
  - 纯逻辑模块：`status.ts`（两层探活结论）、`appLog.ts`、`hashCompare.ts`；
  - `sdk.ts`：SDK 门面，见下；
  - 单测与 `testdata/`。
- **新增** `.claude/skills/kabegame-plugin/scripts/app-run.ts`，**删除** `app-run.sh`、`.claude/skills/kabegame-chromium/driver.sh`、`cdp.mjs`。
- **修改**：
  - `.mcp.json`：加 `kabegame-dev`；
  - `kabegame-chromium/SKILL.md`：重写；
  - `kabegame-plugin` 的 `SKILL.md`、`references/webview.md`、`deploy.sh` 注释；
  - `cocs/debug/DEBUG_INGEST.md`、`cocs/README.md`、`cocs/surf/ANDROID_SURF.md`；
  - `AGENTS.md`：单体仓库布局加 `apps/kabegame-dev-mcp/`；
  - `versions/latest/changelog.md`：开发侧一行；
  - 两处注释：`scripts/vite-debug-server.ts`、`component-plugin.ts`；
  - `client.ts`：一处 `declare`，见下。

和计划不同、或计划没写、由代理按证据定的：

- **SDK 门面 `sdk.ts`：** Deno 2.9 只认 `exports` 的 `types` 条件，直接 import `@modelcontextprotocol/sdk/server/mcp.js` 时 `deno check` 报 TS2307。运行时不受影响。门面用 `@ts-types` 指向根 `node_modules` 里的声明。
- **`client.ts` 的 `cause` 改成 `declare readonly`：** `app-run.ts` 不在根 tsconfig 范围里，用 Deno 缺省选项检查时会对 `client.ts` 报 TS4114。
- **不覆盖已有文件：** `hash_baseline`、`projects_import` 的 `out` 已存在时拒绝，要传 `overwrite: true`。
- **`app-run.ts`：** `userConfig` 按严格 JSON 解析（原脚本是嵌进 JS 求值），省略配置时缺省 `{}`，用法错误退出码 2；正常输出不变。
- **curl 示例都带 `--noproxy '*'`：** 本机 curl 访问 127.0.0.1 也走 `HTTP_PROXY`。
- **工具表是静态的：** vite 不在时 22 个工具照常列出，调用报 `[vite]`。会话里不需要 `tools/list_changed`。

验收结果：

| 项 | 结果 |
|---|---|
| 单测（Claude 自跑，带代理环境） | `apps/kabegame-dev-mcp/` 12 组 31 步、`scripts/kabegame-dev/` 15 组 65 步全过 |
| 子进程冒烟（代理） | stdio 拉起 `main.ts`（参数取自 `.mcp.json`）：initialize、tools/list、resources/list、调 `status` |
| 残留引用 | 全仓库（除 `ignore/`）只剩本计划和 `versions/v4.5.1/regression.md` 提到 `driver.sh` / `cdp.mjs` / `app-run.sh` |
| dev 晚于会话、会话内可用 | 用户 dev 起来后、MCP 重连，同一会话里工具直接可用 |
| `status`（Claude 经 MCP） | 两层「就绪」：vite 在，CDP 桌面端口 28159 |
| `screenshot`（Claude 经 MCP） | `clip` 400×240 在 DPR 1.5 下回 600×360 的 PNG，图片直接回到会话 |
| `eval` / `invoke` | 主窗口 `/gallery`、1186×763、DPR 1.5；`get_wallpaper_mode` → `window` |
| `render_scene`（Claude 经 MCP） | 13515 超高档的像素摘要 `3e7c0b7a…` 和画面哈希参照相同；宿主产物已被另一会话重建为 `index--c4joQgu.js`，画面不变；渲染后没有残留宿主 |
| `hash_compare` | 第 1 批的参照与新跑：30 组全同，并提醒两边是同一份宿主产物 |
| `projects_import` / `projects_remove`（Claude 经 MCP） | 导入 `p4c-cp` 得到 14177，能渲染；指向官方默认壁纸 13515 的清单被护栏整批拒绝、库不变；按清单移除后行和任务都没了，目录 30 个文件的大小与 mtime 摘要和导入前相同 |
| `app_log` / `app_state` | 验收期间日志没有 warn 及以上；`app_state` 前后一致 |
| `app-run.ts`（代理） | 参数解析各错误分支；dev 不在时报错退出 1；对着假 REST 跑「自行结束」「限时取消」两条路径，输出格式和调用顺序同原脚本 |

**没做的：**
- `app-run.ts` 在真 app 里跑小任务；
- 去掉 playwright 后桌面 CEF 是否还劫持页面下载（文档写「预期不再劫持，未实测」）；
- 安卓真机；
- `versions/latest/regression.md` 没加条目：dev 工具不进发布包。

## 第 3 批 — 显示窗口、打开预览、截图落盘与缩放（2026-11-08 用户）

**背景：** 第 2 批提交后，用户和另一个会话用了一轮，反馈如下：
- 屏外宿主不跑帧循环；
- `render_scene` 画出 0 个粒子；
- 内联图片是原尺寸（3441×2465，12 MB）；
- `host_close` 的 `before.preview` 不准；
- REST 的哈希任务结果格式没写进文档。

用户定这一批做下面四点，其余反馈（`host_open` 在主窗口不可见时提醒、`app_state` 带主窗口可见性与宿主入口）以后再说。

### 点 1 — 显示窗口
- **新增：**
  - REST `POST /app/show-window`；
  - MCP `show_window`。
- **做法：** 在主窗口里依次 `invoke("plugin:window|unminimize" / "show" / "set_focus", { label: "main" })`。主窗口免 ACL，`capabilities/main.json` 也有 `allow-show`、`allow-set-focus`；不改 Rust。
- **Windows 的前台限制：** 后台进程调 `SetForegroundWindow` 可能只让任务栏闪烁。实测不到前台时，退一步用 `set_always_on_top` 开再关（`main.json` 有 `allow-set-always-on-top`）。结果里报 `document.visibilityState` 与 `document.hasFocus()`。

### 点 2 — 打开图片预览
- **新增：**
  - REST `POST /app/open-preview { imageId }`；
  - MCP `open_image_preview`。
- **做法：** 主窗口导航到 `/gallery`，保留当前 query，加 `pvwimgid=<id>`，再重载页面。图片网格只在挂载时读一次 URL，只 push 参数不会打开预览。
  - 图片在当前视图里就跳到它所在的页；不在就降级成单图预览。不改用户的筛选条件。
  - 等重载完成、预览弹窗打开（确认是这张图），再调点 1 显示窗口、放到前台，让用户看得到在调试哪一张。
- **顺带修 `mainState` 的预览判断：** 现在的选择器是 `.preview-wallpaper-wrapper`，对场景预览不灵（`host_close` 报 `preview: false`）。改成按预览弹窗本身判断，并给出当前预览的图片 id。

### 点 3 — 截图与渲染的输出
`screenshot`、`render_scene`、`host_render`、`android_screen` 统一两件事：
- **落盘：** `save` 可以给路径，也可以给 `"temp"`。`"temp"` 时落到系统临时目录下的 `kabegame-dev/`，自动命名（工具名 + 时间），结果里给出完整路径。**落盘的总是原尺寸。**
- **缩放：** `size: { scale?, maxWidth?, maxHeight? }` 决定回到会话里的图片尺寸，等比、不放大。不给时按长边 1568 等比缩小；原图不超过这个尺寸就原样回。结果里同时报原尺寸和回传尺寸。
- **缩放的实现：** 不依赖页面。新增 `scripts/kabegame-dev/png.ts`：用 `node:zlib` 解码 PNG（只需支持 CEF 截图与探针输出的 8 位 RGB / RGBA），按面积平均缩小，再编码 PNG。MCP 和 REST 共用。
  - REST 的截图与渲染接口加可选的 `resize`，直接调用的脚本也能用；
  - MCP 从 REST 拿原图，落盘原图，再在本地缩小内联的那一份。

### 点 4 — 文档（`.claude/skills/kabegame-chromium/SKILL.md`）
- **屏外宿主是计算沙箱，不跑帧循环。** 它摆在视口外，rAF 不触发（推测 Chromium 对完全不可见的跨进程 iframe 停了渲染）：场景时间停在第一帧，脚本 `update` 只跑一次，粒子不步进。
  - 以前的用法：只调探针里一次跑完、结果确定的接口，即 `renderFrame` 给固定时刻、`renderFrame` 的 `particles: { dts, … }` 回放、`profile`、`scriptCorpus`、`particleTrack` / `particleCorners`；
  - 看实时行为用可见宿主：`open_image_preview` 打开预览，再截图、在那个宿主里求值。
- **`render_scene` 画粒子场景时是预热后的状态。** 不步进，`starttime` 为 0 的系统是空的。探针本身的 `particles` 回放参数还没开放给工具。
- **REST 的哈希任务：** 结果是 `{ ok, unstable, baseline }`，REST 没有 `out` 参数，落盘只在 MCP 版有。
- 新工具 `show_window`、`open_image_preview`，以及 `save: "temp"`、`size` 的用法，写进工具表。

### 实施记录 / 第 3 批（2026-11-09，子代理实现，Claude 已验收）

- **新增：**
  - `scripts/kabegame-dev/png.ts`：`node:zlib` 解码 / 编码 PNG、按面积平均缩小（RGBA 先乘 alpha 再平均）、尺寸约束 `fitSize` / `resizePng`；只认 8 位、不隔行的 RGB / RGBA，调色板、灰度、16 位、隔行、CRC 不对、截断都抛 `PngError`。单测 `png.test.ts`。
  - `apps/kabegame-dev-mcp/src/imageOutput.ts`：图片类工具的落盘（路径或 `"temp"`）、缩小回传、尺寸文本。单测 `imageOutput.test.ts`。
  - REST `POST /app/show-window`、`POST /app/open-preview`；MCP `show_window`、`open_image_preview`。
- **修改：**
  - `app.ts`：`showWindow`、`openImagePreview`、`PREVIEW_PROBE`（按 `ImagePreviewDialog` 的 `exposed.previewVisible` 与 `props.image` 判断，页码取外层 `ImageGrid` 的 `exposed`）；`mainState` 改用它，多了 `previewImageId`。
  - `rest.ts`：截图、渲染、安卓整屏可选 `resize`（GET 用 query）；PNG 响应加 `X-Png-Original-Width` / `-Height`；渲染响应加 `size`。`pngSize` 移到 `png.ts`、`rest.ts` 转出。
  - `types.ts`、`backend.ts`；`client.ts`（`showWindow`、`openImagePreview`、`screenshot` / `androidScreen` / `hostRender` 带 `resize`）；`tools.ts`（四个图片工具加 `size`、`save` 认 `"temp"`）。
  - `SKILL.md`：图片输出、屏外宿主不跑帧循环、`render_scene` 的粒子状态、REST 哈希任务结果、新工具与 REST 路由、Gotchas。

和计划不同、或计划没写、由代理按证据定的：

- **`show_window` 不无条件 unminimize / show**：最小化时才 unminimize、不可见时才 show（同 `startup.rs` 的 `ensure_main_window`）。kbcef 的 `Unminimize` 是 `CefWindow::Restore()`，会把最大化的窗口还原。退一步的置顶：原本就置顶的不取消。
- **「到前台」的判断是 `visibilityState === "visible" && hasFocus()`**，2 s 内没到才走置顶。
- **`open_image_preview`：**
  - 先用 `images://gallery/by_id/<id>` 查图片在不在，不在回 422，不白重载一次；
  - 主窗口里有 vite 开的宿主时回 409：重载会把它们一起销毁；
  - 「确认是这张图」= 弹窗开着、目标 id 相同、弹窗实际在画的 `previewImage` 也是这张、网格不在跳页（`mode` 不是 `locating`）；
  - 安卓：后端照样能调（不显示窗口），没验。`show_window` 只桌面。
- **REST 的 `resize` 不给时回原图**（兼容已有脚本）；MCP 不经 REST 缩小，拿原图、落盘原图、本地缩小。渲染带 `resize` 时 `png` 换成缩小的，`pngSha256` / `pngBytes` 仍是原图的。
- **MCP 缩小失败**（格式不支持）报 `[local]`，原图照样落盘，错误里带路径；`size: { scale: 1 }` 不缩小、不解码。
- **没改**：`open_image_preview` 一返回就截图会截到弹窗淡入（约 0.3 s）、场景还没出首帧。只写进文档与工具描述；要在工具里等淡入结束 / 首帧，要再改 vite 侧、再开一次预览验证，这次没做。

验收结果（子代理自测）：

| 项 | 结果 |
|---|---|
| 单测（带代理环境，不设 `NO_PROXY`） | `scripts/kabegame-dev/` 20 组 83 步、`apps/kabegame-dev-mcp/` 13 组 39 步全过；`deno check` 通过；Prettier 通过；根 tsc 867 → 867，新文件 0 个 |
| 端到端方式 | SDK `StdioClientTransport` 照 `.mcp.json` 拉起 `main.ts`（带当前环境，含 `HTTP_PROXY`） |
| `screenshot` 缺省 | 原图 1779×1145（754 KB），回传 1568×1009（603 KB）；CEF 截图是 8 位 RGB |
| `screenshot size.maxWidth 400` | 回传 400×257（71 KB） |
| `screenshot save "temp"` | 回传 1568×1009；落盘 `%TEMP%\kabegame-dev\screenshot-20261109-000217-540.png` 是 1779×1145 |
| `render_scene 13515 save "temp"` | 原图 1920×1080（3.4 MB，RGBA），回传 1568×882（1.9 MB）；落盘文件 sha256 = REST 的 `pngSha256`，解码后 RGBA 摘要 `3e7c0b7a…` = 探针 `meta.sha256`（和第 1、2 批的参照相同）；残留宿主 0 |
| `show_window`（窗口可见、没焦点） | 路径 focus：`set_focus` 后 `hasFocus` false → true |
| `show_window`（窗口被挡住：`visibilityState` hidden） | `set_focus` 2 s 内仍 hidden，退到置顶：之后 `visible`、`hasFocus` true，1.5 s 后仍 visible；`is_always_on_top` 恢复 false。用时 3.1 s。场景是自然出现的，没去遮挡窗口 |
| `open_image_preview 13515` | 2.8 s；路由 `/gallery` → `/gallery?pvwimgid=13515`；弹窗开着、`props.image` 为裸 id `13515`、标题 Beach（13515 的显示名）；当前视图是「bedroom + 场景」搜索、只有 13523 一张，所以 `mode: "single"`（降级成单图），页码 1 |
| `mainState` 新判断 | 预览开着时 `host_open` / `host_close` 的 `before` / `after` 都是 `preview: true`、`previewImageId: "13515"`（场景预览，旧选择器报 false） |
| 屏外宿主不跑帧循环 | 600 ms 内 rAF：屏外宿主 0 帧（`visibilityState` 仍 visible），预览里的 13515 宿主与应用背景的 13531 宿主各 87 帧 |
| 恢复与不留痕迹 | 关掉自己开的预览后路由回到 `/gallery`、网格同开始（第 1 页、13523），`app_state` 与开始时逐字段相同，没有残留宿主 |

**没在真环境验的：** 安卓（`open_image_preview` 安卓路径、`android_screen` 的 query 缩小只有单测）；`host_render` 带 `size` 只有单测（`render_scene` 走同一条路径）；最小化窗口的 unminimize 路径（不去最小化用户的窗口）。

**vite 重启 1 次**（vite 侧改动先在 scratchpad 的暂存副本里写好、单测、`deno check`、Prettier，再用一条 `cp` 一次性拷回 6 个文件；
vite 控制台在用户终端里看不到，按 `/health` 的会话代数与任务表归零确认重启过，是否被拆成两次无法确认）。`deno.lock` 没变。开屏外宿主时应用日志多一条「场景壁纸 13513 退回预览图」，是缺省场景 13513 本来就退回，和以前各批一样。

Claude 独立验收（不采信自报，另写脚本、照 `.mcp.json` 起 stdio MCP，带 `HTTP_PROXY`、不设 `NO_PROXY`）：

| 项 | 结果 |
|---|---|
| 改动范围 | `git status` 只有本批文件；`phase-4c-controlpoints.md` 是另一会话的，`third/` 与子仓库的 `m` 是原有状态 |
| 单测、检查 | 两个包自跑全过（20 组 83 步、13 组 39 步）；`deno check`（含 `main.ts`、`plugin.ts`）、Prettier 通过；新文件 LF |
| 工具表 | 24 个，含 `show_window`、`open_image_preview` |
| `open_image_preview` 不存在的 id | `[app]` 报「图片 999999999 不存在」，主窗口 `performance.timeOrigin` 不变（没重载） |
| `screenshot size.maxWidth 0` | SDK 参数校验拒绝 |
| `screenshot size.maxHeight 300` + `save "temp"` | 回传 466×300；落盘原图 1779×1145 |
| `screenshot inline false` + `save "temp"` | 不回图，只落盘 |
| `render_scene 13515 size.scale 0.25` + `save "temp"` | 回传 480×270；落盘 1920×1080，文件 sha256 = `pngSha256`，解码 RGBA 摘要 = `meta.sha256`（`3e7c0b7a…`） |
| REST `/screenshot` 带 `resize.maxWidth 300` | 回 300×193，`X-Png-Original-*` 为 1779×1145；不带 `resize` 回原图 |
| REST `/android/screen` 在桌面 | 400 `platform` |
| **`open_image_preview 13523`（图在当前视图里，子代理只测到 `single`）** | 2.1 s；`mode: "in-view"`、第 1 页、`resolved`；窗口本来就在前台，走 focus 路径、两步跳过；1.2 s 后截图是 13523（Razer Bedroom）的场景预览、弹窗不透明 |
| 恢复 | 关预览后路由回 `/gallery`、网格同开始；`app_state` 与开始时逐字相同；只剩应用背景的宿主 13531 |

## 第 4 批 — 粒子回放、轨迹与四角（2026-11-09 用户）

**来源：** 2026-11-09 对照 `ignore/tools-inventory.md` 查缺口，用户定先补这一块。`wpe-renderdoc` 扩展、粒子对比 skill、产品 fixture 生成脚本入库仍不在本计划。

### 总体设计思路

P4 的真机核对有三种用法，都靠 dev 探针现成的接口，工具里一个都没开放：
- **按 WPE 的 dt 序列回放后渲染一帧**：`renderFrame` 的 `particles: { dts, times, seed, passes, random }`。和 WPE 抓帧逐像素比（`ignore/p4/b1/real.mjs --cases`、`b5v/real.mjs`）。
- **只步进模拟器、出轨迹**：`particleTrack`，输出和 RenderDoc 轨迹（`ignore/p4/tracks/rd-*.json`）同格式。
- **读四角**：`particleCorners`，把粒子顶点着色器改成计算着色器，读回每个粒子四角的裁剪坐标和像素坐标，和 WPE 的 `gs_out` 比（P4a 风险 7；P4c 步骤 5 的拖尾和 `sprite` 朝向要用）。

这三种都是一次跑完、结果确定的计算，屏外宿主就能做（第 3 批已核实屏外宿主不跑帧循环，但这几个接口不依赖帧循环）。

**分工照旧：vite 透传，MCP 组装。**
- **vite（REST）** 只做「按图片 id 取场景目录、在宿主里跑探针、取回结果」：渲染接口多收一个 `particles`，原样交给 `renderFrame`；新增两个宿主接口分别跑 `particleTrack`、`particleCorners`，结果是 JSON。参数在 vite 里校验，错在哪一项就报哪一项。
- **MCP** 负责把「WPE 的这次抓帧」变成探针要的参数。一次回放要传几百上千帧的 dt，不可能写在工具调用里。所以 MCP 新增时间线模块，从 WPE 日志（`ignore/p4/out/<标签>-log.txt` 的 `[kbp] 帧,frametime,runtime`）和 RenderDoc 轨迹（`rd-<标签>.json`）组出 `dts`、`times`、逐帧光标，规则和 P4 各步的回放脚本一致。工具只收文件路径和要回放到的帧号。
- 轨迹和四角的结果可能很大（全部帧 × 全部粒子），**落盘为主**：写到 `out`，回到会话里的只有摘要（每帧每系统的粒子数、坐标范围、前几个粒子）。

**时间线的规则**（照 `b5v/real.mjs` 的 `logDts`、`b3/replay.test.ts` 的 `dtsWithGap`、`b4` 的场景时间）：
- 第 f 帧的 dt = 日志里第 f 帧的累计时间减第 f − 1 帧的（第 1 帧就是它自己的累计时间）。用差分、不用 frametime 列，因为日志只有 6 位小数，差分不累积舍入。
- 抓到的帧（轨迹里有的）dt 换成轨迹的 float32 原值，`g_Time` 也取轨迹的值；其余帧的 `g_Time` 取日志的累计时间。
- 日志和轨迹都没有的帧（fps 低时日志每 50 帧才刷一次，尾巴会缺）缺省报错并列出缺哪些帧。可选 `gap: "split"`：把缺的那一段按轨迹里下一帧的 `g_Time` 平分，结果里写明哪些帧是平分出来的（b3 的做法，`phase-4b-tier2.md` 步骤 3 实施记录说明了它的误差）。
- 逐帧光标（`cursors`）：WPE 只在抓到的帧记录了 `g_PointerPosition`（轨迹的 `pointer`）。`cursors: "track"` 时抓到的帧用轨迹值，其余帧用 `cursor`（缺省场景中心 `[0.5, 0.5]`）；也可以直接给整串。光标是「光标下的场景纹理坐标」，抓帧窗口和场景同尺寸时等于 `g_PointerPosition`，不同尺寸时由调用方换算（P4c 步骤 2 的结论），工具描述里写明。

### 现状锚点

**a. 渲染只给固定时刻**（`scripts/kabegame-dev/scene.ts`，`renderFrame`）
```ts
const args = {
  projectDir: target.path,
  sceneAssets: target.sceneAssets,
  postprocess: request.postprocess ?? "disabled",
  userProperties,
  time: request.time ?? 1.5,
  key,
  ...(request.pointer ? { pointer: request.pointer } : {}),
  // 现状：没有 particles，探针的 dt 回放用不了
};
```

**b. MCP 的渲染参数**（`apps/kabegame-dev-mcp/src/tools.ts`）
```ts
const RENDER_FIELDS = {
  time: z.number().optional().describe("g_Time（秒），缺省 1.5（同画面哈希基线）"),
  postprocess: POSTPROCESS.optional().describe("场景后处理档位，缺省 disabled"),
  userProperties: z.record(z.unknown()).optional().describe("用户属性；缺省取库里这张图当前的用户属性"),
  pointer: z.tuple([z.number(), z.number()]).optional().describe("指针位置（场景坐标）"),
  // 现状：没有回放参数；工具描述写着「粒子是预热后的状态、不步进」
};
```

**c. 探针接口已经有**（`apps/wpe-scene/src/dev/install.ts`）
```ts
particleTrack: particleTrackProbe, // { projectDir, sceneAssets, dts, times?, frames, passes, seed?, random?, cursors?, tag? }
particleCorners,                   // { projectDir, sceneAssets, postprocess?, userProperties?, layer?, particles?, limit?, wgsl? }
// renderFrame 的 particles: { dts, times?, seed?, passes?, random? }
```

### 点 1 — vite：渲染透传回放参数（`scripts/kabegame-dev/scene.ts`、`types.ts`、`rest.ts`）
- **修改** `RenderRequest` 加 `particles?: ParticleReplay`（`{ dts: number[]; times?: number[]; seed?: number; passes?: 1 | 2; random?: Record<string, number[]> }`），`renderFrame` 原样放进探针参数。
- **新增** 校验函数 `checkReplay`（点 2 共用）：`dts` 非空、都是有限正数；`times` 与 `dts` 等长、都是有限数；`passes` 只能 1 / 2；`seed` 是整数；`random` 的键是 `objects` 下标、值是 [0, 1) 内的数。不合法回 400，说明是哪一项。
- 给了 `particles` 时探针忽略 `time`（读回那一帧的 `g_Time` 取 `times` 的最后一项或 dt 累计值），结果的 `meta.time` / `meta.frametime` 照常回。

### 点 2 — vite：轨迹与四角（`scene.ts`、`rest.ts`、`backend.ts`、`types.ts`）
- **新增** REST：
  - `POST /hosts/:handle/particle-track`：`{ imageId, dts, times?, frames, passes, seed?, random?, cursors?, tag? }` → 探针 `particleTrack` 的结果（`ParticleTrack` JSON）。
  - `POST /hosts/:handle/particle-corners`：`{ imageId, particles?, layer?, limit?, postprocess?, userProperties?, wgsl? }` → `ParticleCornersLayer[]`。
- 场景目录同渲染，按 `wpe_scene_target` 取；`userProperties` 缺省取库里这张图当前的值。
- `frames` 都在 `[1, dts.length]` 内；`cursors` 与 `dts` 等长、每项两个有限数。
- 走 `hostTask`（宿主里起 Promise 再轮询），超时同渲染。结果直接经 `Runtime.evaluate` 取回；单次结果超过约 32 MB 时回 413 并建议减少 `frames` / `limit`。

### 点 3 — MCP：时间线（新增 `apps/kabegame-dev-mcp/src/timeline.ts`）
```ts
/** 按 WPE 日志与 RenderDoc 轨迹组出探针要的时间线（规则见第 4 批「总体设计思路」）。脚本也能 import。 */
export interface TimelineSource {
  /** WPE 日志里截出的 `[kbp]` 行（`ignore/p4/out/<标签>-log.txt`）。 */
  log: string;
  /** RenderDoc 轨迹（`ignore/p4/tracks/rd-<标签>.json`），可选：给了时抓到的帧用它的 dt、g_Time、pointer。 */
  track?: string;
  /** 回放到这一帧（WPE 脚本帧号，从 1 起），即读回的那一帧；缺省为轨迹里最后一帧。 */
  frame?: number;
  /** 日志与轨迹都缺的帧：缺省报错；"split" 按下一个已知 g_Time 平分。 */
  gap?: "error" | "split";
  /** 逐帧光标："track" 抓到的帧取轨迹 pointer、其余取 cursor；或直接给整串（长度 = frame）。 */
  cursors?: "track" | [number, number][];
  cursor?: [number, number];
}
export interface Timeline {
  dts: number[];
  times: number[];
  cursors?: [number, number][];
  /** 轨迹里抓到的帧号（不超过 frame）。 */
  captured: number[];
  /** 平分出来的帧号。 */
  split: number[];
}
export function buildTimeline(source: TimelineSource): Timeline;
```

### 点 4 — MCP 工具（`tools.ts`、`client.ts`）
- **修改** `render_scene`、`host_render` 加 `replay`：
  - `{ timeline: TimelineSource, seed?, passes?, random? }`（常用），或 `{ particles: { dts, times?, seed?, passes?, random? } }`（直接给）；
  - 给了 `replay` 时不收 `time`；工具描述里「粒子是预热后的状态、不步进」改成「不给 replay 时……」。
  - `passes` 缺省按标签里的 `-fps<N>` 推（1–20 两遍，同 `particlePasses`），推不出就 1。
- **新增** `particle_track`：`{ imageId, timeline, frames?, passes?, seed?, random?, out, overwrite? }`。
  - `frames` 缺省为轨迹里抓到的帧；
  - 自己开屏外宿主、跑、关掉（同 `render_scene`）；
  - 结果写 `out`（`ParticleTrack` JSON，和 `rd-*.json` 同格式，可直接交给 `ignore/p4` 的比较脚本）；
  - 回到会话的是摘要：每帧每系统的粒子数、位置范围，以及时间线信息（回放了多少帧、抓到的帧、平分的帧）。
- **新增** `particle_corners`：`{ imageId, replay?, layer?, limit?, postprocess?, userProperties?, out, overwrite? }`，同样开关屏外宿主、写 `out`、回摘要（每层粒子数、前 3 个粒子的四个像素角）。
- **修改** `client.ts`：`hostParticleTrack`、`hostParticleCorners`，`hostRender` 带 `particles`。
- 相对路径照旧按仓库根解析；`out` 已存在时缺省拒绝。

### 点 5 — 文档（`.claude/skills/kabegame-chromium/SKILL.md`）
- 工具表、REST 表加上新工具和接口；
- 「粒子回放」一节：时间线规则、`gap`、`cursors` 与 `g_PointerPosition` 的区别、`passes` 怎么定、结果格式、和 WPE 比较要自己跑 `ignore/p4` 的脚本（工具不做比较）；
- 第 3 批写的「探针本身的 `particles` 回放参数还没开放给工具」删掉。

### 验收
- **单测：**
  - `timeline.ts`：差分、轨迹覆盖 dt 与 `g_Time`、缺帧报错、`split`、`cursors` 两种写法、`frame` 超出日志与轨迹；
  - vite：`checkReplay` 与两个新接口的参数校验（400 的形状）；
  - MCP：`replay` 与 `time` 互斥，`passes` 从标签推。
- **端到端（dev 在跑；先用 `projects_import` 导入要用的测试工程，验完 `projects_remove`）：**
  - `particle_track`：`ignore/p4/proj/p4c-cp`，时间线取 `out/p4c-cp-fps60-log.txt` + `tracks/rd-p4c-cp-fps60.json`，回放到 927 帧。输出和在 node 里用同一时间线直接调 `particles/track.ts` 的 `particleTrack` 逐位相同（同一份 TS，浏览器与 node 的 float32 运算应一致）；再和 WPE 轨迹比，差和 `ignore/p4/c1/out/replay-cp.txt` 同一量级。
  - `render_scene` 带 `replay`：`p4b-refract` 回放到 907 帧，PNG 的 RGBA 摘要和 `ignore/p4/b5v/out/real-summary.json` 的 `p4b-refract-f907` 相同；不同时查是 P4b 步骤 5 之后的哪次提交改了画面，写明原因。
  - `particle_corners`：P4a 步骤 4 的一组（`ignore/p4/step4/out/ours-*-corners.json` 里挑一组，用同样的回放参数），四角和记录逐位相同；不同时说明原因。
  - `gap: "split"`：一组 fps10 抓帧，平分的帧和 `b3/out/replay.txt` 记录的拆分一致。
  - 不留痕迹：`app_state` 前后一致，没有残留宿主，测试工程已移除。
- **其余照前几批：** `deno check`、Prettier、两个包的单测；vite 侧改动先在临时副本里写好再一次拷回，vite 只重启一次；改动范围只有本批文件。

### 实施记录 / 第 4 批（2026-11-09，子代理实现）

- **新增：**
  - `scripts/kabegame-dev/replay.ts`：回放、轨迹、四角的参数校验（`checkReplay`、`checkTrackRequest`、`checkCornersRequest`、
    `checkRenderReplay`），400 带 `field`。单测 `replay.test.ts`。
  - `scripts/kabegame-dev/scene.test.ts`：用 `node:vm` 造一个真执行表达式的假 CDP（主窗口、宿主各一个上下文），测分块取回、413、
    宿主里抛错，以及三个探针调用的参数透传。
  - `apps/kabegame-dev-mcp/src/timeline.ts`：`parseKbpLog`、`parseTrackJson`、`passesFromTag`、纯函数 `timelineFrom`、读文件的
    `buildTimeline`、`describeTimeline`。单测 `timeline.test.ts`。
  - MCP `particle_track`、`particle_corners`；单测 `particles.test.ts`。
  - REST `POST /hosts/:h/particle-track`、`POST /hosts/:h/particle-corners`。
- **修改：**
  - `scene.ts`：`renderFrame` 透传 `particles`（给了就不传 `time`）；`hostTask` 拆成起任务 + 轮询的 `runHostTask`，新增
    `hostTaskJson`；新增 `particleTrack`、`particleCorners`。
  - `rest.ts`：两条新路由；渲染路由校验 `particles`。`backend.ts`、`types.ts`（`ParticleReplay`、`ParticleTrackRequest`、
    `ParticleTrackResult`、`ParticleCornersRequest`、`ParticleCornersLayer`，`RenderRequest.particles`）、`rest.test.ts`。
  - `client.ts`：`hostParticleTrack`、`hostParticleCorners`；`hostRender` 的 `particles` 经类型带上。
  - `tools.ts`：`render_scene`、`host_render` 加 `replay`；开关屏外宿主抽成 `withSceneHost`，三个封装工具共用，`render_scene` 的行为不变；
    渲染结果多两行：读回那一帧的 `g_Time` / `g_Frametime`，以及各粒子层的存活数。新增错误层 `[timeline]`。`testdata/fakeRest.ts` 的工具表。
  - `SKILL.md`：`description`、工具表、REST 表、错误层，新增「粒子回放」一节、脚本例子与两条 Gotchas；第 3 批写的「`particles` 回放参数
    还没开放给工具」删掉。

和计划不同、或计划没写、由代理按证据定的：

- **校验放在新文件 `replay.ts`，计划写的是 `scene.ts`。** REST 路由在交给后端之前调它，单测能直接测 400 的形状；`scene.ts` 被直接调用
  时再校验一次。
  - 不认识的字段一律 400。探针会静默忽略它们，例如给 `renderFrame` 传逐帧光标。
  - REST 渲染同时给 `particles` 与 `time` 回 400。计划只写了「探针忽略 `time`」。
- **结果按 JSON 文本分块取回。** 计划写的是「结果直接经 `Runtime.evaluate` 取回」。`hostTaskJson` 先在宿主里 `JSON.stringify`、量
  UTF-8 字节数：超过 32 MB 回 413，不取；不超过就按 4 M 字符一块取回，在 vite 里解析。原因是单次 CDP 消息不宜过大，同探针的
  `chunk`。按 JSON 的取值规则，`NaN` 变成 null，`-0` 变成 0。
- **时间线：**
  - **dt 舍入到 6 位小数。** 同 b3 / b4 / c1；b5v、step4 的 `logDts` 没舍入。在 p4b-refract f907 / f910、s60 f718 / f725、
    p4c-cp f927 上逐帧核对，进模拟器的 `f32(dt)` 与 drag 系数 `f32(0.025 / dt)` 两种写法全部相同（`ignore/p4/dev4/check-timeline.ts`）。
  - **非抓帧的 `g_Time` 取日志的累计时间，照计划。** b5v、step4 当时没传 `times`，探针按 dt 累加。两者的 float32：p4b-refract f907
    逐帧相同，s60 f725 有 2 帧不同，但四角结果仍逐字相同（见下表）。
  - **平分：**
    - 一段缺帧的结束时刻 = 后一个已知帧的 `g_Time` 减它的 dt（b3 用的是首个抓帧）；
    - dt 舍入到 6 位小数（同 b3），`g_Time` 按 dt 累加（同 b4）；
    - 中间缺的一段也能平分；尾巴缺的一段后面没有已知帧，照样报错；平分出来的时长不是正数时也报错。
  - **日志与轨迹的解析：**
    - 日志只认两列都是 6 位小数的 `[kbp]` 条目（现有 40 份日志全是），用来查出被截断的行；帧号重复或倒退报错（文件里有两次运行）。
    - 轨迹容忍 Python 写出的 `NaN` / `Infinity`：`rd-p4c-sprite-fps60.json` 的 `corners` 里有 `NaN`，直接 `JSON.parse` 会失败。
  - **`passes` 推断：** 先看轨迹的 `tag`，推不出再看日志文件名（`rd-p4b-colorp-fps60.json` 的 `tag` 是 `p4b-colorp-a-base`）。P4a 的
    `s15` 这类标签不带 `fps`，推不出就按 1，结果里写明。
  - **光标：** 只给 `cursor` 时每帧都用它；`cursors` 给了整串时不收 `cursor`。
  - **`Timeline` 多了几个字段：** `frame`、`gaps`、`cursorsFromTrack`、`tag`、`passes`、`log`、`track`。
- **只有 `particle_track` 收逐帧光标。** 计划的 `TimelineSource` 带 `cursors`，但探针 `renderFrame` 只有一个固定的 `pointer`，
  `particleCorners` 固定在场景中心。`render_scene`、`host_render`、`particle_corners` 的时间线里给了 `cursors` / `cursor` 就报 `[local]`，
  不静默丢掉。
- **其余 MCP 细节：**
  - `particle_track` 不收 `userProperties`：探针 `particleTrack` 没有这个参数，用的是工程缺省值。
  - `particle_track` 没有轨迹时，`frames` 缺省为最后一帧；`frames` 超过时间线回放到的帧时报错。
  - `particle_corners` 多一个 `wgsl` 选项（REST 本来就有）。三个封装工具都能用 `host` 指定已开的宿主。
  - `out` 的写法：轨迹是紧凑 JSON，同 `sim-*.json`；四角是 `JSON.stringify(…, null, 1)`，同 step4。
- **暂存副本放在 `ignore/p4/dev4/stage/`，不在 scratchpad。**
  - MCP 包的 npm 依赖，以及 `sdk.ts` 里 `@ts-types` 的相对路径，要能解析到仓库的 `node_modules`。暂存根下临时建了一个指向它的
    junction，用完删了。
  - vite 的根是 `apps/kabegame`，监听不到 `ignore/`。
  - 拷回之前，用暂存代码在独立进程里预跑了全部端到端：`createDevRuntime` 起在 127.0.0.1:14200（另开一条 CDP 连接），MCP 也在进程内，
    不经 vite。
- **vite 重启了 2 次，计划要求 1 次。**
  - 一条 `cp` 拷 8 个文件，vite 在拷到一半时就开始重启：新 `rest.ts` 生效了，最后拷的 `backend.ts` 还是旧的，新接口回 500
    `backend.hostParticleTrack is not a function`。重启进行中的后续改动被合并掉，没有再重启。
  - `touch backend.ts` 再触发一次，之后一致。这一条写进了 SKILL.md 的 Gotchas。
- **宿主产物中途换了：**
  - **开始时是 `index--c4joQgu.js`。** 这是 P4c 步骤 4 验收用的那份：worker 里已经没有步骤 4 删掉的 `particle:flags:world`。
  - **拷回期间（01:19:38）被另一会话重建为 `index-zvkIAUZN.js`。** 它带着那个会话工作区里没提交的 P4c 步骤 5 改动，四角结果多了一个
    `drawn` 字段。
  - **两份产物的结果：** 暂存预跑用旧产物，MCP 端到端用新产物。轨迹在两份产物下逐字节相同；四角的数值全部相同，只多了 `drawn`；
    渲染摘要相同。
  - 我没有重建宿主。
- **node 直调用的源码：** 用 `git archive` 取 HEAD 的快照（`ignore/p4/dev4/head/`），因为工作区里另一会话正改着 `particles/track.ts`
  等文件。工作区源码也跑了一遍，结果相同。

验收结果（子代理自测）：

| 项 | 结果 |
|---|---|
| 单测（带代理环境，不设 `NO_PROXY`） | `scripts/kabegame-dev/` 26 组 105 步、`apps/kabegame-dev-mcp/` 17 组 54 步全过（原来 20 组 83 步、13 组 39 步） |
| 检查 | `deno check` 通过；Prettier 通过；根 tsc 错误数 867 → 867，本包 0 个；`deno.lock` 没变 |
| 端到端方式 | 拷回前：暂存代码的 REST（本进程，14200）+ 进程内 MCP。拷回后：SDK `StdioClientTransport` 照 `.mcp.json` 拉起 `main.ts`，带 `HTTP_PROXY`、不设 `NO_PROXY`，共 26 个工具 |
| `particle_track` p4c-cp（回放 927 帧，输出 924–927） | 21005 字符，和 node 里用同一时间线直调 `particleTrack` 逐字相同：HEAD 快照与工作区源码各跑一遍。927 帧全输出（4.06 MB，43512 个粒子）也逐字相同 |
| 和 WPE 轨迹比（`ignore/p4/dev4/cmp-wpe.ts`） | 11 个不跟随指针的系统，pos 最大差与 `c1/out/replay-cp.txt` 逐系统相同：7.93e-3 到 1.83e-2，vortex-cp 3.88e-1；其余字段为 0。`ptr-offset` / `ptr-io` / `ptr-xform` 不比，同 c1 |
| 逐帧光标 | `cursors: "track"`，`cursor` 取抓帧时的 pointer：和 node 逐字相同；ptr-* 与 WPE 的差从 2.12e3 降到 80（光标语义不在本批核对范围） |
| `render_scene` + `replay`：p4b-refract 回放到 907 帧 | 时间线版、b5v 原参数直给版两种写法：RGBA 摘要都是 `8f144c2f…`，等于 `real-summary.json`；PNG 文件的 sha256 也等于 `b5v/out/ours-p4b-refract-f907.png`；粒子存活数同 `real-summary.json`。新旧两份宿主产物结果相同 |
| `particle_corners` p4a（参数同 `step4/real.mjs`：720 × 1/60，seed 1，passes 1，limit 64） | 和 `step4/out/ours-p4a-corners.json` 逐位相同，2965 个数值。新产物多一个 `drawn` 字段，数值不变 |
| `particle_corners` s60 f725（额外一组） | 时间线版与 step4 原参数直给版逐字相同。和 11-07 的记录只差在 `o2-cap-ab` / `o2-cap-ba` 两层：那时 `capvelocity` 是不支持项、模拟器跳过，到 8910c9d1（P4b 步骤 2、3）才实现 |
| `gap: "split"`：p4b fps10 | 不给 `gap` 时报 `[timeline]`，列出 151–152。给了之后平分 151–152：合计 0.198864 s，每帧 0.099432，和 `b3/out/replay.txt` 一致。passes 从标签推出 2；和 node 逐字相同（124595 字符） |
| 报错路径（经真 MCP） | `replay` 与 `time` 同时给、渲染 / 四角给了光标 → `[local]`；缺帧 → `[timeline]`；dts 有负数、passes 为 3 → SDK 参数校验拒绝；REST 的 400 带 `field`（curl） |
| 测试工程 | 导入 p4c-cp、p4b-refract、p4a、p4b、p4-0（14178–14182，导入前库里没有这些行）。移除后行与任务都没了，场景行数 154 → 154，库里没有 `ignore/` 下的行；165 个工程文件的大小与 mtime 摘要前后相同 |
| 不留痕迹 | `app_state` 前后逐字段相同；最后只剩应用背景的宿主 13531：开始就在，页面重载后 `kbInstance` 变了。拷回后第一次关宿主报「残留宿主 1」，是 vite 重启后主窗口重载、应用背景宿主在那次调用中途重建，被算进去了 |

**没在真环境验的：**
- 超过 32 MB 回 413、多块取回：只有单测。真环境最大的结果 4.06 MB，不到一块 4 M 字符。
- `host_render` 带 `replay`：只有单测（`render_scene` 走同一条路径）。
- `particle_corners` 的 `layer`、`wgsl`：只有单测。

**其它：**
- vite 任务表里另有 2 个别的会话的任务（c4 的画面哈希，导入 p4c-trail / p4c-sprite），不是本批的。
- `versions/latest` 的 changelog / regression 没加：本批只改上面列出的文件，dev 工具也不进发布包。
- 一次性脚本与输出在 `ignore/p4/dev4/`：
  - `check-timeline.ts`、`cmp-wpe.ts`、`cmp-corners.ts`；
  - node 直调的 `track-node.test.ts` 与 `vitest.config.ts`；
  - 端到端的 `e2e.ts`（暂存副本删了以后，只有 `mcp` 模式能跑）；
  - 结果在 `out/`。

Claude 独立验收（不采信自报；照 `.mcp.json` 另起 stdio MCP，带 `HTTP_PROXY`、不设 `NO_PROXY`；脚本在 `ignore/p4/dev4/claude/`）：

| 项 | 结果 |
|---|---|
| 改动范围 | 本批只有 `scripts/kabegame-dev/`、`apps/kabegame-dev-mcp/`、`SKILL.md` 与本计划；`apps/wpe-scene/` 与 `phase-4c-controlpoints.md` 的改动是另一会话的 P4c 步骤 5 |
| 单测、检查 | 两个包自跑全过（26 组 105 步、17 组 54 步）；`deno check`（含 `main.ts` 与 `scripts/kabegame-dev/*.ts`）、Prettier 通过 |
| 时间线（Python 另写一遍规则，`check_timeline.py`，和 `timeline.ts` 的输出比） | `p4c-cp` 927 帧、`p4b-refract` 907 帧、`p4b-fps10`（`gap: "split"`）158 帧：dt 与 `g_Time` 按 float32 逐帧相同；平分的帧都是 151、152；`cursors: "track"` 相同；`passes` 推出 1、1、2 |
| `render_scene` + `replay`（`p4b-refract` 到 907 帧） | RGBA 摘要 `8f144c2f…` 等于 `b5v/out/real-summary.json`；宿主产物 `index-zvkIAUZN.js`（含另一会话未提交的步骤 5 改动） |
| `particle_track`（`p4c-cp` 到 927 帧） | 4 帧 × 14 个系统写进 `out`；11 个不跟随指针的系统和 WPE 轨迹的最大差与 `c1/out/replay-cp.txt` 逐系统相同（`cp-io-pos` 8.06e-3，`vortex-cp` 0.388） |
| 参数护栏 | `inline: false` 不给 `save` 时报 `[local]`，没开宿主 |
| 不留痕迹 | 导入的 2 个工程（两轮各一次）都已 `projects_remove`，`verified.imagesGone` / `tasksGone` 为真；`app_state` 前后逐字相同，只剩应用背景宿主 13531 |

### 补充 — 跟上 P4c 步骤 5 的四角输出（2026-11-09，Claude）

P4c 步骤 5（`a0a84322`）改了探针 `particleCorners` 的结果：新增 `drawn`（朝向是 NaN、渲染时整次不画为 false，四角照算），`count` / `particles` 改成写进顶点的粒子（拖尾去掉退化的）；轨迹里拖尾系统也带 `thick`。

- **修改** `scripts/kabegame-dev/types.ts`：`ParticleCornersLayer` 加 `drawn`，`count`、`particles`、`thick` 的注释按新含义改。vite 原样透传，不用改逻辑。
- **修改** `apps/kabegame-dev-mcp/src/tools.ts`：四角摘要标出不画的层，「存活」改成「写进顶点」；摘要的数字格式化认 `null`。实测发现：NaN 的四角经 JSON 传回成了 `null`，原来的格式化在 `null.toFixed` 上抛错，`particle_corners` 对 `p4c-sprite` 直接报 `[local]`。
- **修改** `particles.test.ts`（加 `drawn` 与 NaN 四角的摘要用例）、`SKILL.md`（结果字段、NaN 在文件里是 `null`）。

验收：两个包单测全过（MCP 17 组 55 步、vite 26 组 105 步），`deno check`、Prettier 通过；另起 stdio MCP 导入 `p4c-sprite`、按 WPE 抓帧回放后读四角：24 层都带 `drawn`，只有 S7（`upright` 轴平行于视线，步骤 0 预测不画）为 false，摘要正常；测试工程已移除，`app_state` 前后相同。脚本 `ignore/p4/dev4/claude/e2e-drawn.mjs`。

## 第 5 批 — 渲染读回指定画布尺寸（2026-11-12 用户）

**来源：** 用户：「render_scene 需要指定大小，这样不用缩放可以和 wpe 抓帧窗口一致」。起因是 `3830255100-kbp` 的端到端（场景 3840×2160、抓帧窗口 1920×1080）：`render_scene` 读回的是场景目标，比较前要自己 2×2 平均缩到 1920×1080（`ignore/p5/inst/cmp_proto.py`）。

### 总体设计思路

`render_scene` / `host_render` 多收一个 `canvas: [宽, 高]`，意思是「把这一帧上屏到这么大的画布，读回画布」。做法照产品：渲染器上屏时把场景目标用全屏三角形、线性采样按壁纸样式铺进画布（`renderer.ts` 的 scene blit），探针在读回那一帧编码完场景之后，用**同一份**着色器、同样的采样器，按 `fill`（`scenePlacement("fill", …)`，等于 WPE 的居中盖满裁切）铺进一张 `canvas` 尺寸的 `rgba8unorm` 纹理，读回它。不给 `canvas` 时读回场景目标，和现在逐字节相同。

画布就是模拟的壁纸窗口，所以它同时是光标的换算基准：探针换算光标用 `window ?? canvas`，两个都给而不相等时报错（REST 回 400，MCP 在时间线交给探针的窗口与 `canvas` 不同时报 `[local]`；窗口只跟着逐帧光标交给探针，没给逐帧光标时不比较，实施时按点 4 定，见实施记录）。`canvas` 不反过来喂给时间线（标签里通常就有 `-<宽>x<高>`），也不默认取时间线的窗口：老调用的读回尺寸不变。MCP 在时间线推得出窗口、没给 `canvas`、读回尺寸又和窗口不同时，结果里提示一行该传什么。

只改读回，不改渲染：内置 uniform（`g_Screen`、`g_TexelSize`）仍按场景目标算，同产品。这一点和 WPE 不同，见下面的已知差异；它是产品的差异，不在这批改。

**已知差异（2026-11-12 核对 `A:\p5inst\3830255100-kbp-fps20-1920x1080\…-frame172.rdc`）：** WPE 把图层直接画进 1920×1080 的后备缓冲（视口 1920×1080，最后一个绘制 770 的目标就是 Present 的 `ResourceId::466`），只有图层合成 RT 是 3840×2160（绘制 28）。也就是说场景比窗口大时，WPE 按窗口分辨率光栅化，我们先按场景分辨率画、上屏再缩。`canvas` 读回的是产品实际显示的画面，和 WPE 比时这部分差别会留在结果里。

### 现状锚点

**a. 探针只读回场景目标**（`apps/wpe-scene/src/dev/probe.ts`，`renderFrame`）
```ts
const encoder = gpu.device.createCommandEncoder({ label: "probe frame" });
scene.encode(encoder, state);
const format = scene.targetTexture!.format as ReadbackFormat;
// 现状：读回场景目标（场景分辨率），不经过上屏
const read = scheduleReadback(gpu.device, encoder, scene.targetTexture!, scene.width, scene.height, format);
```

**b. 上屏的着色器与管线只在渲染器里**（`apps/wpe-scene/src/render/renderer.ts`）
```ts
const BLIT_WGSL = /* wgsl */ `…`;   // 现状：模块内常量
this.blitPipeline = device.createRenderPipeline({ label: "scene blit", layout: "auto", /* … */ targets: [{ format: this.format }] });
this.blitSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
```

**c. 光标的窗口只来自 `window`**（`probe.ts`）
```ts
const pointers = replayPointers(
  { pointer: options.pointer, pointers: options.pointers, window: options.window },   // 现状：没有画布
  [sceneWidth, sceneHeight],
  options.particles?.dts.length,
);
```

### 点 1 — 上屏共用（新增 `apps/wpe-scene/src/render/blit.ts`，修改 `renderer.ts`）
- **新增** `blit.ts`：上屏着色器、建管线（按目标格式）、两种采样器的参数、一次上屏 pass 的编码（清成留白色、视口设铺放矩形、画 3 个顶点），渲染器与探针共用。
- **修改** `renderer.ts` 改用它，行为不变（同一着色器、同一采样器参数、同一 pass）。

### 点 2 — 探针（`apps/wpe-scene/src/dev/probe.ts`、`replayPointers.ts`）
- **修改** `RenderFrameOptions` 加 `canvas?: [number, number]`（正整数，不超过设备的 `maxTextureDimension2D`，否则抛错）。
- **修改** 读回：给了 `canvas` 时，读回那一帧 `scene.encode` 之后在同一个编码器里按 `fill` 铺进 `canvas` 尺寸的 `rgba8unorm` 纹理（留白色黑，`fill` 没有留白），读回这张；PNG 与 `.rgba` 都是画布尺寸。
- **新增** 纯函数（放 `replayPointers.ts`）：光标窗口 = `window ?? canvas`，两者都给而不同时抛错；有单测。
- **修改** `RenderFrameResult`：`width` / `height` 是读回图片的尺寸；新增 `canvas: [w, h] | null`、`sceneTarget: [w, h]`。

### 点 3 — vite（`scripts/kabegame-dev/replay.ts`、`scene.ts`、`types.ts`）
- **修改** `RenderRequest` 加 `canvas?: [number, number]`；`checkRenderReplay` 校验（两个正整数、各不超过 16384）与 `window` 冲突（都给且不同回 400，字段 `canvas`）；`renderFrame` 原样转给探针。
- **修改** `RenderMeta` 加 `canvas`、`sceneTarget`。

### 点 4 — MCP（`apps/kabegame-dev-mcp/src/tools.ts`）
- **修改** `RENDER_FIELDS` 加 `canvas`（`render_scene`、`host_render` 共用），描述写明：读回画布、`fill`、同产品上屏；光标按它换算；和时间线推出的窗口要相同；只改读回、不改渲染（`g_Screen` 等按场景目标）；WPE 按窗口分辨率直接画，场景比窗口大时细节会有差。
- **修改** `renderBody`：时间线交给探针的窗口与 `canvas` 不同时报 `[local]`。
- **修改** 结果说明：加一行读回的是什么（「画布 W×H，场景目标 SW×SH 按 fill 铺进去」或「场景目标 SW×SH」）；没给 `canvas`、时间线推得出窗口且与读回尺寸不同时，提示传 `canvas: [W, H]`。

### 点 5 — 文档
- `.claude/skills/kabegame-chromium/SKILL.md`：渲染参数与 REST 渲染请求体加 `canvas`，读回规则与已知差异。
- `.claude/skills/kbp-tools/SKILL.md`「真实场景的回放」：渲染时传与抓帧窗口相同的 `canvas`，比较不用再缩放。
- `cocs/wpe/WPE_SCENE.md`：dev 探针 `renderFrame` 一行加 `canvas`。

### 验收
- **单测**：光标窗口的纯函数；vite 的 `canvas` 校验（非整数、0、超上限、与 `window` 冲突）与转发；MCP 的转发、冲突报 `[local]`、提示行。两个 TS 包与 `apps/wpe-scene` 的单测全过，`deno check`、宿主 tsc、Prettier 通过。
- **端到端**（dev 在跑；`projects_import` 导入 `ignore/p5/proj/3830255100-kbp`，验完 `projects_remove`；宿主改完用 `--mode development` 重建；vite 侧改动在临时副本里写好一次拷回）：
  1. 改动前先用现有宿主渲染一帧（`time` 1.5）记下 `meta.sha256`；改动后不给 `canvas` 渲染同一帧，摘要相同。
  2. 按时间线回放到 173 帧（日志 `ignore/p5/inst/out/3830255100-kbp-fps20-1920x1080-log.txt`，`cursors: "log"`）：给 `canvas: [1920, 1080]` 的输出与不给时的输出按 2×2 平均缩小后逐像素比，最大差 ≤ 1；再和 WPE 第 173 帧比，统计与 `cmp_proto.py` 对缩小图的结果同量级。
  3. 宽高比不同的画布（`[1080, 1080]`）：与场景目标中间 2160×2160 裁出后 2×2 平均缩小的图比，最大差 ≤ 1。
  4. 时间线窗口 1920×1080 时给 `canvas: [1280, 720]`：`[local]` 报错，没开宿主。
  5. 不留痕迹：`app_state` 前后一致，没有残留宿主，测试工程已移除。

### 实施记录 / 第 5 批（2026-11-12，子代理实现）

- **新增** `apps/wpe-scene/src/render/blit.ts`：上屏着色器 `BLIT_WGSL`、两种采样器参数（`BLIT_SAMPLER` / `TILE_SAMPLER`）、`PLACEMENT_BYTES`、
  `createBlitPipeline(device, format)`、`placementUniform`、`createBlitBindGroup`、`encodeBlit`（清成留白色、视口设铺放矩形、画 3 个顶点）。
- **修改：**
  - `renderer.ts`：改用 `blit.ts`，只做抽取。着色器、管线与采样器参数、缓冲大小、label、pass 内的调用顺序都同前；bind group 改在
    `beginRenderPass` 之前取（仍在 `encode` 之后）。
  - `probe.ts`：`RenderFrameOptions.canvas`；`encodeCanvasBlit`（同一个编码器，`scenePlacement("fill", 场景目标宽高, 画布宽高)`，`rgba8unorm`，
    留白黑）；`RenderFrameResult` 的 `width` / `height` 是读回尺寸，新增 `canvas`、`sceneTarget`。
  - `replayPointers.ts`：纯函数 `checkCanvas(canvas, maxDimension?)`、`pointerWindow(window, canvas)`。单测加 3 条（文件内 8 → 11）。
  - vite：
    - `replay.ts`：`MAX_CANVAS = 16384`、`checkCanvas`；`checkRenderReplay` 收 `canvas`。
    - `scene.ts`：转发 `canvas`。
    - `types.ts`：`RenderRequest.canvas`、`RenderMeta.canvas` / `sceneTarget`。
    - 单测加在 `replay.test.ts`、`scene.test.ts`、`rest.test.ts`。
    - `rest.ts` 不用改：渲染路由把请求体原样交给后端，校验在 `checkRenderReplay`。
  - MCP `tools.ts`：`RENDER_FIELDS.canvas`（zod：两个正整数、≤ 16384）、`checkCanvasWindow`、`readbackLines`；`renderBody` 多回
    `timelineWindow`；`render_scene` / `host_render` 的描述。`particles.test.ts` 新增一组 5 条。
  - 文档：kabegame-chromium `SKILL.md`（工具表、新增「读回画布」一节、REST 表）、kbp-tools `SKILL.md`「真实场景的回放」（第 3、5 步与实测）、
    `WPE_SCENE.md` 的 `renderFrame` 一行。

和计划不同、或计划没写、由代理按证据定的：

- **冲突比的是「交给探针的窗口」，照点 4 的写法。**
  - 窗口只跟着逐帧光标交给探针（第 4 批的 `cursorsFor`）。没给逐帧光标时，`canvas` 和推出来的窗口不同也不报错（有单测）。
  - 「总体设计思路」写的是「时间线推出的窗口与 `canvas` 不同时报 `[local]`」，在没给光标时比点 4 宽，取了点 4。
  - 提示行按时间线推出的窗口算，不论交没交给探针。
  - 端到端 4 用 `cursors: "log"` 做，两种读法都满足。
- **vite 多一道 409。** 给了 `canvas`、探针结果的 `meta.canvas` 却对不上时报 409 `[host]`：旧宿主产物不认识这一项，会静默读回场景目标，
  不能把它当画布交回。
- **`RenderMeta.canvas` / `sceneTarget` 标成可选。** 旧宿主产物不回这两项；MCP 的「读回：…」行没有 `canvas` 就按场景目标写。
- **`meta.format` 仍是场景目标的格式。** 画布总是 `rgba8unorm`，注释写明；画面哈希基线（`hash.ts`）读这一项。
- **探针的画布路径包一层 `pushErrorScope("validation")`，只在给 `canvas` 时。** 管线建不出来这类校验错误直接抛出，不静默读回空图。
- **参数先查。** 探针在编译之前查 `canvas` 的形状、和 `window` 的冲突；纹理上限要等取到设备才查。MCP 里 `canvas` 的形状由 SDK 参数校验
  拒绝（zod），和窗口冲突才报 `[local]`。
- **vite 拷回。**
  - 测试文件与 MCP 文件不是 vite 配置的依赖，普通拷回。
  - `types.ts`、`replay.ts`、`scene.ts` 用 `ignore/tools5/swap.py` 换：先复制到同卷的 `ignore/tools5/swap/`，再逐个 `os.replace`，
    三个文件 2.3 ms 换完。
  - 之后 vite 会话重置（第 0 条连接），新的校验与转发都生效。没法直接数重启次数，没看到第 4 批那种一半新一半旧的迹象。
- **暂存在 `ignore/tools5/stage/`，理由同第 4 批。** 根下临时建了指向仓库 `node_modules` 的 junction，并拷了 `.mcp.json`
  （`main.test.ts` 读它）。用完先 `rmdir` 掉 junction、确认仓库依赖还在，再删暂存。

验收结果（子代理自测）：

| 项 | 结果 |
|---|---|
| 单测 | `scripts/kabegame-dev/` 26 组 113 步（本批加 3 步）、`apps/kabegame-dev-mcp/` 20 组 69 步（本批加 1 组 5 步）、`apps/wpe-scene` vitest 64 个文件 1518 条，全过 |
| 检查 | `deno check apps/kabegame-dev-mcp/src/*.ts scripts/kabegame-dev/*.ts` 通过；宿主 `tsc --noEmit` 通过；Prettier（`--ignore-path .prettierignore --check`，改动的 13 个 TS 文件）通过；`deno.lock` 没变 |
| 宿主产物 | `index-CTTG_-O-.js` → `index-DC6GXG04.js`。worker `worker-B1uUPbEL.js` 与 wasm 的哈希不变：wasm 就是 `apps/wpe-scene/src/wpesl2wgsl/` 里那份，另一会话正改着的 wpesl2wgsl Rust 源没进这次构建 |
| 1. 不给 `canvas` | 改动前（旧产物）time 1.5：RGBA 摘要 `4575fa24…`、PNG sha256 `f6080c5c…`，改动后两者都相同。回放到 173 帧不给 `canvas`：改动前后都是 `c114a40e…`，PNG 和 `ignore/p5/inst/out/ours-3830255100-kbp-f173.png` 逐像素相同 |
| 2. `canvas: [1920, 1080]`，回放到 173 帧 | 摘要 `b3e79e08…`。和不给 `canvas` 的输出的 2×2 浮点平均比，最大差 0.50；和四舍五入后的平均比，最大差 1（2073600 个像素里 603631 个差 1），整体偏差 RGB 约 −0.05 / −0.06 / −0.07 |
| 2. 对 WPE 第 173 帧 | 直接比：平均差 0.69、差 > 8 的 0.76%、差 > 32 的 0.02%、最大 73，六个区域平移都 ≤ 0.08 像素。同一段代码对 BOX 缩小图：0.81 / 0.75% / 0.02% / 74（`cmp_proto.py` 当时记的是 0.81） |
| 3. `canvas: [1080, 1080]`（time 1.5） | 摘要 `70136717…`。和场景目标 `x ∈ [840, 3000)` 裁出后的 2×2 平均比，最大差 0.50（浮点）/ 1（四舍五入）；对照：裁切错开 2 个场景像素时最大差 128 |
| 附：`host_render` 带 `canvas: [1920, 1080]`（time 1.5，`host_open` 开、`host_close` 关） | 摘要 `2d435c55…`，和场景目标的 2×2 平均最大差 1 |
| 4. 时间线窗口 1920×1080 + `canvas: [1280, 720]` | `[local] … canvas 1280×720 和时间线交给探针的窗口 1920×1080 不同 … 传 canvas: [1920, 1080]`，用时 2 ms；前后 `hosts` 逐字相同 |
| 提示行 | 回放不给 `canvas` 时：「提示：时间线的窗口是 1920×1080，读回的是 3840×2160；… 传 canvas: [1920, 1080]」。四次渲染的「读回：…」行都对 |
| 产品渲染器 | 用新产物开屏外宿主（13635）：加载时的第一帧 `render(true)` 走了抽取后的上屏，`frameMs` 记下 1 帧（2.2 ms），渲染器还在、没有退回 |
| 5. 不留痕迹 | 导入的 14312 导入前不在库里；`projects_remove` 后 `imagesGone` / `tasksGone` 为真。`app_state` 前后逐字相同。最后只剩应用背景的宿主 13635：开始就在，`kbInstance` 没变，vite 重启没有重载主窗口，它仍跑旧产物 |

端到端方式：
- 第 1 项与不给 `canvas` 的回放用会话里的 MCP，在 vite 拷回之前做（旧 MCP 代码，新宿主产物）。
- 第 2–4 项照 `.mcp.json` 另起 stdio MCP（`ignore/tools5/e2e.mjs`，带 `NO_PROXY`）。
- 比较脚本 `ignore/tools5/cmp5.py`；输出 `out-cmp5.txt`、`out-e2e.json`、`out-e2e.log`，PNG 都在 `ignore/tools5/`。

**没做 / 没在真环境验的：**
- 超过设备纹理上限时探针抛错：只有单测，真环境里 vite 的 16384 先拦下。
- HDR 场景（`rgba16float` 目标）带 `canvas`：没实测，走的是和产品上屏相同的路径。
- `canvas` 对不上时的 409：只有单测。
- 产品渲染器在可见窗口里的上屏没看（约定不开预览），只看了屏外宿主加载时的那一帧。
- `versions/latest` 的 changelog / regression 没加：按约束只改规格列出的文件。

Claude 独立验收（2026-11-12；不采信自报，脚本与输出在 `ignore/tools5/claude/`：直接调 vite REST 的 `e2e.ts`、numpy 参考的 `cmp.py`）：

| 项 | 结果 |
|---|---|
| 改动范围 | 本批只有点 1–5 列的文件、三个包的测试与本计划；工作区里 `gen.py`、`track.py`、`src-tauri/wpesl2wgsl/`、P4 / P5b 计划、`todo.md` 是别的会话的 |
| 代码 | `renderer.ts` 是逐项抽取（着色器、采样器参数、缓冲、pass 同前）；探针在 `encode` 之后取 `targetView` 铺画布，同渲染器 |
| 单测、检查 | 自跑：vite 26 组 113 步、MCP 20 组 69 步、宿主 vitest 1518 条全过；`deno check`、宿主 tsc、Prettier（13 个 TS 文件）通过 |
| 变异 | `pointerWindow` 不取 `canvas`：宿主单测 2 条失败；MCP `checkCanvasWindow` 改成空操作：1 步失败；vite 去掉 `canvas` 与 `window` 的冲突检查（在副本里改，不碰 vite 在用的文件）：2 步失败。恢复后全过 |
| 不给 `canvas` | 回放到 173 帧摘要 `c114a40e…`，和改动前我渲染的 `ignore/p5/inst/out/ours-3830255100-kbp-f173.png` 逐像素相同；time 1.5 `4575fa24…` 同子代理记录 |
| `canvas: [1920, 1080]` 回放到 173 帧 | 摘要 `b3e79e08…`（同子代理）；对 2×2 平均最大差 1（四舍五入）/ 0.5（浮点） |
| 非整数倍、裁切的画布 | numpy 独立实现 `fill` + WebGPU 双线性（坐标 = uv·尺寸 − 0.5）作参考：`[900, 600]`（横向裁切）最大差 1，差 1 的 6.6%；`[1366, 768]`（缩放比 2.81）最大差 1，差 1 的 3.4%。参考横移 1 像素时最大差 183 / 171，比较分得出铺放错 |
| 对 WPE 第 173 帧 | 画布直接读回：平均差 0.686、差 > 8 的 0.76%、差 > 32 的 0.021%、最大 73；场景目标 BOX 缩小：0.812 / 0.75% / 0.021% / 74 |
| REST 护栏 | `window` 1920×1080 + `canvas` 1280×720 回 400 `field: "canvas"`；`canvas: [1920.5, 1080]` 回 400 |
| 不留痕迹 | 导入的 14313 已 `projects_remove`（`imagesGone` / `tasksGone` 为真）；`app_state` 前后逐字相同；只剩开始就在的应用背景宿主 13635 |

没有另起 stdio MCP 验 MCP 层（子代理验过，冲突与提示行另有单测与变异）；本会话的 kabegame-dev MCP 要 `/mcp` 重连才有 `canvas`。

## 第 6 批 — 回放时给 FR 帧号块涂上那一帧的颜色（2026-11-12 用户）

**来源：** 工具缺口清单里的一条：「回放不跑脚本。FR 帧号块在两边颜色不同，比较时要屏蔽。加了抖动和缩放后，它的屏幕位置每个工程都不一样，屏蔽框得逐个现算」。用户同意「回放时把 FR 涂成那一帧的颜色」，并要求验证是否正确。另一条（探针交出读回那一帧的相机，供 `kbp cmp frame` 换算 `kbp-meta.json` 的 bbox）不在本批。

### 总体设计思路

FR 是 `kbp gen` 工程的第一个对象（`solidlayer`，场景坐标 1780–1860 × 10–70），颜色由字段脚本 `FR_COLOR` / `FR_CURSOR` 每帧写：第 N 帧（WPE 脚本帧号，从 1 起）是 `((N % 256) / 255, (⌊N / 256⌋ % 256) / 255, 1)`。探针回放为了确定性不跑脚本，FR 一直是初值 `0 0 1`。但颜色只取决于帧号，而回放到第几帧是已知的（`dts.length`），所以不用跑脚本，直接把「脚本这一帧会返回的值」写进去就行。

分两层。**探针**加一个通用能力 `scriptValues`：调用方给出某个对象某个字段的脚本在读回那一帧返回的值，探针找到 bundle 里挂在这个字段上的字段脚本，用它的绑定目标经 `SceneState.write`（和宿主脚本写回同一条路径，`host.ts` 的 `writeScript`）写进状态。值写在回放开始之前，颜色不影响模拟，只有读回那一帧被画出来。对象按 `objects` 下标或名字找，没有挂脚本时报错，`optional` 的跳过并在结果里写明。探针不知道 FR 是什么。

**MCP** 是 kbp 协议的使用方（时间线本来就解析 `[kbp]` 日志和标签），由它按公式算出读回帧的 FR 颜色，带 `optional: true` 交给探针。缺省开（`replay.fr` 缺省 true），结果里写一行涂了没有、涂成什么。不是 kbp 工程时探针跳过，不影响别的场景。公式在 `gen.py` 的 `FR_COLOR`，MCP 这边是第二份，注释指回去。是否正确由验收里对 WPE 抓帧的解码与整帧比较来保证。

这样 `render_scene` 按时间线回放出来的 FR 块和 WPE 逐像素相同，比较时不再屏蔽它，抖动、缩放之下也不用算屏蔽框。

### 现状锚点

**a. 探针不跑脚本，FR 停在初值**（`apps/wpe-scene/src/dev/probe.ts`，`renderFrame`）
```ts
const state = SceneState.fromBundle(bundle);   // 现状：字段脚本的值只有编译期的 initial（FR 是 "0 0 1"）
// …建场景、回放，没有任何脚本写回
const { time, frametime } = replayReadback(scene, state, { particles: options.particles, /* … */ });
```

**b. 宿主的脚本写回路径**（`apps/wpe-scene/src/host.ts`，`writeScript`）
```ts
const result = state.write({ property: "", target }, scriptWriteValue(value));   // target 是 SceneScript.target
```

**c. 比较时手算 FR 屏蔽框**（`ignore/p5/s4/cmp_frames.py` 头注释）
```text
FR 帧号块（场景 1780–1860 × 10–70）的颜色是脚本帧号，我们的回放不跑脚本，去掉不比；它的屏幕位置按「绕中心缩放 + 抖动平移」现算
```

### 点 1 — 探针（`apps/wpe-scene/src/dev/probe.ts`，纯函数放 `dev/` 下新文件或 `replayPointers.ts` 旁）
- **新增** `RenderFrameOptions.scriptValues?: { object: number | string; field: LayerField; value: number[] | boolean; optional?: boolean }[]`。
- **新增** 纯函数：在 `bundle.layers`（按名字，重名报错）与 `bundle.scripts.list`（`target.kind === "layer"`、同 `object`、同 `field`）里解析出绑定目标；找不到时 `optional` 记为跳过，否则抛错。有单测。
- **修改** `renderFrame`：建好场景之后、回放之前，逐项 `state.write({ property: "", target }, scriptWriteValue(value))`。
- **修改** `RenderFrameResult` 加 `scriptValues: { object: number | null; name: string | null; field; value; applied: boolean }[]`（没给时空数组）。

### 点 2 — vite（`scripts/kabegame-dev/replay.ts`、`scene.ts`、`types.ts`）
- **修改** `RenderRequest.scriptValues`；校验（数组、最多 64 项；`object` 是非负整数或非空字符串；`field` 是图层字段之一；`value` 是 1–4 个有限数或布尔；`optional` 是布尔），不合法回 400；原样转给探针。`RenderMeta.scriptValues`。

### 点 3 — MCP（`apps/kabegame-dev-mcp/src/tools.ts`，公式可放 `timeline.ts`）
- **新增** `replay.fr?: boolean`（`timeline` 与 `particles` 两种写法都收，缺省 true）：读回帧 N = `dts.length`，发 `{ object: "FR", field: "color", value: [(N % 256) / 255, (Math.floor(N / 256) % 256) / 255, 1], optional: true }`。
- **修改** 结果说明加一行：「FR 涂成第 N 帧的颜色 (r, g, b)（objects[i]）」/「场景里没有挂颜色脚本的 FR，没涂」/「没涂（replay.fr: false）」。
- **修改** `render_scene` / `host_render` 描述。

### 点 4 — 文档
- `.claude/skills/kabegame-chromium/SKILL.md`：`replay.fr`、REST 的 `scriptValues`。
- `.claude/skills/kbp-tools/SKILL.md`：`render_scene` 按时间线回放出来的图和 WPE 比时不用再屏蔽 FR（`--exclude-kbp`、手算框）；写在说 FR 屏蔽的地方。
- `cocs/wpe/WPE_SCENE.md`：dev 探针 `renderFrame` 一行加 `scriptValues`。

### 验收
- **单测**：探针的解析（按下标、按名字、重名、没挂脚本时报错与 `optional` 跳过、字段不同不匹配）；vite 的校验与转发；MCP 的公式（N = 1、255、256、941）、`fr: false` 不发、两种回放写法都发、结果说明。三个包全过，`deno check`、宿主 tsc、Prettier 通过。
- **公式与帧号对齐（不经我们的渲染）**：从现有 WPE 抓帧里解出 FR 块的颜色，对文件名帧号 N 应是 `(N % 256, ⌊N / 256⌋ % 256, 255)`。至少含一组 N ≥ 256 的（`p5a-shakepar2` 第 941 帧，或 P4 的高帧号抓帧）。
- **整帧不屏蔽比较**（dev 在跑；`projects_import` 导入，验完 `projects_remove`；宿主重建；vite 侧改动在副本里写好一次拷回）：照 P5a 步骤 3、4 与收尾的做法，按时间线回放到抓到的帧，和 WPE 上屏帧**整帧逐像素比、不挖任何区域**：
  - 纯抖动 `p5a-shake1`、`shaker2`、`shaker01`、`shaker005`、`shakes3`，缩放 `p5a-zoom15`、`zoom08`、`zoompar`、`zoomx15`、`zoomx08`，逐帧光标 `p5a-shakepar2`（第 941 帧，`cursors: "log"`）：当时挖掉 FR 后是 0 差异，现在应整帧 0 差异；
  - 有不是 0 的，先确认差异在不在 FR 块里，再查原因，写进记录。
- **对照（说明比较分得出对错）**：同一组里 `replay.fr: false` 时差异正好落在 FR 块；经 REST 直接给 N − 1 帧的颜色时 FR 块有差。
- **不留痕迹**：`app_state` 前后一致，没有残留宿主，测试工程已移除。

### 实施记录 / 第 6 批（2026-11-12，子代理实现）

- **新增：**
  - `apps/wpe-scene/src/dev/scriptValues.ts`：`resolveScriptValues`（纯函数：对象按下标在 `bundle.layers` 里按 `object` 找、按名字找且重名抛错；
    字段脚本在 `bundle.scripts.list` 里按 `target.kind === "layer"`、同 `object`、同 `field` 找；找不到时 `optional` 记跳过、否则抛错）与
    `applyScriptValues`（先全部解析、再逐项 `state.write({ property: "", target }, scriptWriteValue(value))`，同 `host.ts` 的 `writeScript`）。
    单测 `scriptValues.test.ts` 9 条：内存里编译带 FR 颜色脚本的最小场景，用真的 `SceneState` 核对。
  - MCP `timeline.ts` 的 `frColor(N)`（`gen.py` 的 `FR_COLOR` 的第二份，注释指回去）；`tools.ts` 的 `frScriptValue`、`frLine`、类型 `FrPlan`。
- **修改：**
  - 探针 `probe.ts`：`RenderFrameOptions.scriptValues`；建好场景之后（profile 帧与回放之前）写进状态；`RenderFrameResult.scriptValues`。
  - vite：`replay.ts` 的 `checkScriptValues`（`LAYER_FIELDS`、`MAX_SCRIPT_VALUES = 64`），`checkRenderReplay` 收 `scriptValues`；`scene.ts` 原样转给探针；
    `types.ts` 的 `SceneLayerField`、`ScriptValue`、`ScriptValueResult`、`RenderRequest.scriptValues`、`RenderMeta.scriptValues`。单测加在
    `replay.test.ts`、`scene.test.ts`、`rest.test.ts`（各 1 条）。`rest.ts` 不用改：渲染路由把请求体原样交给 `checkRenderReplay` 与后端。
  - MCP `tools.ts`：`render_scene` / `host_render` 的 `replay` 改成 `RENDER_REPLAY`（两种写法都多一个 `fr`）；`renderBody` 按 N = `dts.length`
    发一项 `scriptValues`；结果多一行 FR；两个工具的描述。`particles.test.ts`：假 REST 像新探针那样逐项回结果，第 4 批两条断言请求体的用例
    跟着改（回放时请求体多了 `scriptValues`），新增一组 5 条。
  - 文档：kabegame-chromium `SKILL.md`（工具表、`replay` 写法、新增「FR 帧号块」一节、REST 表）、kbp-tools `SKILL.md`（FR 协议处记第二份与
    上屏帧核对结果；`cmp frame` 的 FR / CLK 排除处写明按时间线回放的图不用再为 FR 屏蔽）、`WPE_SCENE.md` 的 `renderFrame` 一行。

和计划不同、或计划没写、由代理按证据定的：

- **`particle_corners` 不收 `fr`。** 它和渲染共用 `REPLAY`，但不渲染，涂 FR 没有意义。拆成 `REPLAY`（四角）与 `RENDER_REPLAY`（渲染，另收
  `fr`），四角给了 `fr` 由 SDK 参数校验拒绝（有单测）。
- **重名不论 `optional` 都抛错。** 计划写「按名字，重名报错」；`optional` 管的是「缺」，重名是认不出，不该静默跳过。
- **按下标找时也要在 `bundle.layers` 里。** 只在 `scripts.list` 里有、图层没进 bundle 的对象，`SceneState.write` 会静默什么都不写，这里按
  「找不到对象」处理。
- **结果多一个 `reason`**（只在跳过时），MCP 的结果行把它写出来。
- **vite 多一道 409**（同第 5 批的 `canvas`）：给了 `scriptValues`、`meta.scriptValues` 却不是逐项的数组时报 409 `[host]`：旧宿主产物不认识
  这一项、会静默不写。只有单测。
- **`scriptValues` 不要求有 `particles`**（REST 与探针）：固定时刻的渲染也能写。MCP 只在回放时发 FR。
- **FR 结果行写 8 位值**：「FR 涂成第 941 帧的颜色 (173, 3, 255) / 255（objects[0]）」，和 WPE 上屏帧的像素值直接对得上。
- **端到端的光标与缺帧**（P5a 记录没写，按证据定）：步骤 3、4 的 10 组用轨迹里读回那一帧的 `pointer` 作固定 `pointer`，时间线加
  `gap: "split"`（这些日志多数只刷到第 100 帧，抓帧在 117–132 帧）；`shakepar2` 用 `cursors: "log"`。结果整帧 0 差异，说明和当时的做法一致。
- **暂存在 `ignore/tools6/stage/`**（理由同第 4、5 批）：根下临时建了指向仓库 `node_modules` 的 junction、拷了 `.mcp.json` 与
  `scripts/vite-debug-server.ts`（`plugin.ts` 的依赖，`deno check` 要）。拷回用 `ignore/tools6/swap.py`：测试与 MCP 文件普通复制，`types.ts`、
  `replay.ts`、`scene.ts` 先复制到同卷再 `os.replace`，1.3 ms 换完；之后用 REST 打一个不合法的 `scriptValues` 回 400 `field: "scriptValues"`，
  确认新校验已生效。用完先 `rmdir` 掉 junction、确认仓库依赖还在，再核对副本与仓库逐字节相同后删掉暂存。

验收结果（子代理自测；脚本与输出在 `ignore/tools6/`）：

| 项 | 结果 |
|---|---|
| 单测 | `scripts/kabegame-dev/` 26 组 116 步（本批加 3 步）、`apps/kabegame-dev-mcp/` 21 组 74 步（本批加 1 组 5 步，改 2 条旧断言），`apps/wpe-scene` vitest 67 个文件 1560 条通过、45 条跳过（本批加 1 个文件 9 条；工作区里另有 P5b 会话没提交的改动与测试，一并跑过） |
| 检查 | `deno check apps/kabegame-dev-mcp/src/*.ts scripts/kabegame-dev/*.ts` 通过；宿主 `tsc --noEmit` 通过；Prettier（`--ignore-path .prettierignore --check`，本批 12 个 TS 文件）通过；`deno.lock` 没变 |
| 宿主产物 | `--mode development` 重建：`index-CwAz3KBM.js` / `worker-4CYl8sgH.js`（01:41 别的会话建的）→ `index-DXZMaZLe.js` / `worker-Bv_m5Kmy.js`；wasm 哈希 `8ed07a4d…` 不变（`src/wpesl2wgsl/wpesl2wgsl.wasm` 01:37 已被别的会话更新，01:41 那次就带着）。产物含 P5b 会话在 `apps/wpe-scene` 里没提交的改动 |
| 公式与帧号（`fr_decode.py`，结果 `fr-decode.txt`） | 扫已有 WPE 上屏帧 85 张：正交工程里 FR 块看得到的 **61 张，解出的 (R, G, 255) 全部等于文件名帧号 N 的 (N % 256, ⌊N / 256⌋ % 256, 255)**，相邻帧（N ± 1）的颜色一个像素都没有；其中 N ≥ 256 的 16 张（`p5a-cur3` 491–494、`p5a-shakepar2` 938–941、`p5a-wk-prop` 345–787）。抖动、缩放下块会移动：按颜色找，不按位置，包围盒随抖动平移（如 `shakes3` 三帧 x 1780 / 1777 / 1775）、`zoom08` / `zoomx08` 缩成 64×48。另 12 张 P5a 的块在画面外（`shaker2`、`zoom15`、`zoompar`、`zoomx15` 各 3 张），12 张是 P5b 会话的透视工程（`p5b-persp*`），FR 不是正交下的块，不适用。`p5a-cur3` 的块里有 8 个像素被跟随粒子盖住（4792 / 4800），颜色照样对 |
| 整帧不屏蔽比较（`e2e6.mjs` 经另起的 stdio MCP 调 `render_scene`，`cmp6.py`，结果 `cmp6.txt`） | **11 组全部整帧 0 差异**，不挖任何区域：`shake1` f182、`shaker2` f122、`shaker01` f122、`shaker005` f120、`shakes3` f124、`zoom15` f132、`zoom08` f124、`zoompar` f122、`zoomx15` f119、`zoomx08` f120、`shakepar2` f941，差 > 0 的像素都是 0。FR 块在画面里的 7 组，我们图里帧号色的像素数与包围盒和 WPE 逐一相同（如 `shakepar2` 4800 像素 x 1791–1870 y 1010–1069，`zoom08` 3072 像素）；另 4 组 FR 在画面外，0 差异不涉及 FR。结果行都是「FR 涂成第 N 帧的颜色 …（objects[0]）」 |
| 对照 1：`replay.fr: false` | `shake1` 差 4800 像素、最大 182，`shakepar2` 4800 像素、最大 173，`zoom08` 3072 像素、最大 124：差异的连通块正好是 WPE 图里帧号色的包围盒，块外有差 0；最大差就是初值 `0 0 1` 与 N % 256 的红通道之差。结果行「FR：没涂（replay.fr: false）」，请求体没有 `scriptValues` |
| 对照 2：经 REST 给 N − 1 帧的颜色（`rest6.ts`，直接用 `client.ts`、自己开关屏外宿主） | 三组 FR 块全部有差（4800 / 4800 / 3072 像素，最大差 1），图里是第 N − 1 帧的颜色；同组给 N 帧的颜色时和 MCP 的 PNG 逐像素相同 |
| 报错路径（经 REST，真宿主） | 不存在的对象不带 `optional` → 422 `[host]`「scriptValues[0]：没有叫 "kbp-FR" 的图层」；`CLK` 的 `color`（没挂字段脚本）→ 422「objects[1]（CLK）的 color 没有挂字段脚本」；带 `optional` 时 `applied: false`、`reason` 写明 |
| 不留痕迹 | 导入的 11 个工程（14330–14340，导入前都不在库里）已 `projects_remove`，`imagesGone` / `tasksGone` 为真。渲染那一轮 `app_state`、`hosts` 前后逐字相同；最后只剩应用背景的宿主 13635 |

端到端期间别的会话在用同一个 dev：
- app 在 01:40 到 02:03 之间重启过（CDP 端口 41122 / pid 338184 → 6730 / pid 23904），不是本批做的（vite 重启不重启 app）；
- 有一个 P5b 的画面哈希任务和它的屏外宿主（13513），还开过 13658 的预览；路由在本批端到端开始之前已被改成 `hide/media-type/x-wpe/scene/…`；
- 所以「前后一致」按本批自己每一轮的前后比，不和 01:40 的快照比。

**没做 / 没在真环境验的：**
- 旧宿主产物不认识 `scriptValues` 时的 409：只有单测。
- `host_render` 带 `replay.fr` 只有单测（`render_scene` 走同一个 `renderBody`）；REST 那条路用的是 `client.hostRender`。
- 本会话里的 kabegame-dev MCP 是旧代码，要 `/mcp` 重连才有 `fr`。
- `versions/latest` 的 changelog / regression 没加：按约束只改规格列出的文件。

Claude 独立验收（2026-11-12；不采信自报，脚本与输出在 `ignore/tools6/claude/`：`fr_wpe.py`、自写 stdio MCP 客户端 `e2e.ts`、`cmp.py`）：

| 项 | 结果 |
|---|---|
| 改动范围 | 本批是 `dev/probe.ts`、新增 `dev/scriptValues.ts`（+ 测试）、vite 三个文件与测试、MCP `timeline.ts` / `tools.ts` / `particles.test.ts`、三份文档与本计划；`apps/wpe-scene` 里 `bundle.ts`、`features.ts`、`graph.ts`、`scene.ts` 与一批测试是 P5b 会话的，不在本批 |
| 代码 | 探针按字段脚本的绑定目标经 `state.write({ property: "", target }, scriptWriteValue(value))` 写，同 `host.ts` 的 `writeScript`；MCP 按 N = `dts.length` 发一项 `optional` 的 FR |
| 单测、检查 | 自跑：vite 26 组 116 步、MCP 21 组 74 步全过；宿主 `src/dev/` 48 条全过；`deno check`、宿主 tsc、Prettier（12 个 TS 文件）通过 |
| 变异 | MCP `frColor` 改成第 N − 1 帧：`particles.test.ts` 失败；恢复后与改前相同 |
| 公式与帧号（只读 WPE 上屏帧，`fr_wpe.py`） | `ignore/` 下 154 张 kbp 工程上屏帧：122 张里第 N 帧颜色是实心矩形、N ± 1 的颜色 0 像素，其中 41 张 N ≥ 256（P4 的 719–957 帧、`shakepar2` 938–941、`wk-prop` 345–787）；块大小 80×60、抖动下 80×59、缩放 0.8 下 64×48。其余：FR 在画面外的 `shaker2`、`zoom15`、`zoompar`、`zoomx15` 和透视工程找不到（透视工程里匹配到的是一条横向渐变，相邻帧号的颜色挨着出现，不是 FR）；`p5a-cur3` 四帧 4800 个像素里 4792 个对（这个工程有跟光标走的粒子） |
| 整帧不挖比较（新 MCP `render_scene`，时间线到轨迹最后一帧、`gap: "split"`、指针取轨迹那一帧的 `pointer`；`shakepar2` 第 941 帧 `cursors: "log"`） | 11 组全部 **0 差异**：`shake1` f182、`shaker2` f122、`shaker01` f122、`shaker005` f120、`shakes3` f124、`zoom15` f132、`zoom08` f124、`zoompar` f122、`zoomx15` f119、`zoomx08` f120、`shakepar2` f941。FR 在画面里的 7 组，我们的 FR 块包围盒和 WPE 的逐个相同（如 `shake1` (1790, 1006)–(1870, 1066)、`zoom08` 64×48 的 (1616, 916)–(1680, 964)） |
| 对照 | `shake1` 加 `replay.fr: false`：差异 4800 像素（最大 182），范围正好等于 WPE 的 FR 块；经 REST 给第 181 帧颜色：同样 4800 像素、最大差 1、范围等于 FR 块；给第 182 帧颜色和 MCP 渲染逐像素相同 |
| 结果说明 | 11 组都写「FR 涂成第 N 帧的颜色 (…) / 255（objects[0]）」，`fr: false` 写「没涂（replay.fr: false）」 |
| 不留痕迹 | 11 个测试工程（14342–14352）`projects_remove` 后 `imagesGone` / `tasksGone` 为真；`app_state` 与宿主列表前后逐字相同（只剩应用背景 13635） |

宿主产物里带着 P5b 会话在 `apps/wpe-scene` 未提交的改动（子代理重建时就在），不影响上面的结论：比较对象是 WPE 抓帧，结果为 0 差异。本会话的 kabegame-dev MCP 要 `/mcp` 重连才有 `replay.fr`。

## 第 7 批 — 回放跑场景脚本（2026-11-14 用户）

**来源：** `.claude/plans/wpe-import/3-scene/FINAL_CHECK.md` 的工具表：「探针不跑脚本，只能逐字段塞值；要能注入 `Date` 等外部值后照常跑脚本」。直接起因是 P5d 步骤 3 的补充走查：语料里 15 个相机对象的 `origin` 挂脚本（多数是按 `engine.canvasSize` 定位的同一个模板），回放不跑脚本就只能把 WPE 的结果塞回去，测不到脚本本身。用户定「如果不能跑就加跑」。

### 总体设计思路

探针的 `renderFrame` 加一个 `scripts` 选项。给了它，探针在自己的 `SceneState` 上照宿主搭一套脚本环境：同一个 `createIframeRealm`、`ScriptApi`、`ScriptRuntime`，不另写运行时。`init` 在建好场景之后、回放之前跑；每一回放帧（包括读回那一帧）在渲染器的同一位置调一次 `runtime.frame(dt)`：设好这一帧的相机之后、`setParallax` 与第二次 `sync` 之前。这个位置和宿主的 `beforeFrame` 相同。profile 帧不跑脚本，它只用来计时。

脚本看得到的外部值全部来自请求，两次同样的请求得到同一张图：
- `engine.runtime` / `frametime`：回放时间线的这一帧（不回放时是 `time` 与 0）；
- `engine.screenResolution`：`canvas ?? window ?? [1920, 1080]`。WPE 是窗口尺寸（`p5d-camo-s4k` 实测：场景 3840×2160、窗口 1920×1080 时 `screen 1920 1080`）；
- `engine.canvasSize`：照旧是场景尺寸，同一次实测 WPE 是 `canvasSize 3840 2160`；
- `Date` / `engine.timeOfDay`：请求给一个起点时刻（毫秒时间戳），随回放时间前进；不给时用固定缺省值，结果里写明。`g_Daytime` 跟着同一个时钟；
- `Math.random`：按请求的种子换成确定序列。它本来就和 WPE 对不上，只保证我们两次相同；
- `localStorage`：只在内存，不碰持久存储；
- 音频缓冲全 0，媒体回调不调；
- 声音、视频、粒子层的脚本方法返回 null，调用次数记进结果。

脚本写回与读取不再写第二份。宿主 `writeScript` / `readScript` 里只依赖状态的那部分提成共用函数，宿主和探针都调（FINAL_CHECK 的例子正是同一条规则写了四份、对了三份）。要整场重编译的写入（`recompile` 目标、打开没有链的泛光等）探针做不了：记进结果，读回帧照常画，调用方据此判断这一帧不可信。

`scripts` 与 `scriptValues` 不能同时给（400）：一个是让脚本自己算，一个是把脚本的结果塞进去，混用分不清是谁写的。给了 `scripts` 时 MCP 不再给 FR 涂色：FR 的字段脚本自己跑，回放从加载后第 1 帧开始，帧号自然和 WPE 对上。

### 现状锚点

**a. 探针不跑脚本**（`apps/wpe-scene/src/dev/probe.ts`，`renderFrame`）
```ts
const state = SceneState.fromBundle(bundle);   // 现状：字段脚本只有编译期的 initial
// …建场景
const scriptValues = applyScriptValues(state, bundle, options.scriptValues);   // 现状：只能塞值（第 6 批）
// …profile 帧、replayReadback：每帧 sync → stepParticles → setCamera → setParallax → update，中间没有脚本
```

**b. 宿主每帧调脚本的位置**（`apps/wpe-scene/src/render/renderer.ts` 的 `render`、`host.ts` 的 `beforeFrame`）
```ts
scene.setCamera(camera);
if (live) this.options.stepObjects?.(frametime);
if (live) this.options.beforeFrame?.(frametime, this.spectrum);   // 宿主：applySpectrum，然后 runtime.frame(dt)
scene.setParallax(drawParallax(this.parallax, state.general, this.perspective), state);
scene.sync(state);
```

**c. 宿主搭脚本环境**（`host.ts` 的 `startRuntime`；写回 `writeScript` 是宿主私有方法）
```ts
const realm = await createIframeRealm({ document, scripts: bundle.scripts, sceneAssets, modules: getJsModuleIndex(sceneAssets), /* … */ });
const api = new ScriptApi(realm, { bundle, state, screenResolution, frametime, runtime, timeOfDay: () => daytimeOf(new Date()), write, read, /* … */ });
const runtime = new ScriptRuntime(realm, { report, write: (target, value) => this.writeScript(target, value), read: (target) => this.readScript(target), /* … */ });
await runtime.load(bundle.scripts);   // 现状：只有宿主会搭
```

**d. `engine.canvasSize` 取场景尺寸**（`script/api.ts` 的 `installEngine`）
```ts
scoped("canvasSize", () => this.vector([this.access.bundle().general.width, this.access.bundle().general.height], 2));
```

### 点 1 — 共用写回（新增 `apps/wpe-scene/src/script/stateWrite.ts`，修改 `host.ts`）
- **新增** `writeScriptState(state, target, value)` → `"applied" | "recompile" | "unsupported"`：文本字段走 `writeText`、其余走 `state.write`，同宿主现在的分支；`readScriptState(state, bundle, target)` 同宿主的 `readScript`。
- **修改** 宿主的 `writeScript` / `readScript` 改调它们；声音音量交给排期器、`recompile` 走 `overrideAndReload` 留在宿主。宿主行为逐字不变，由现有单测锁住。

### 点 2 — 探针的脚本环境（新增 `apps/wpe-scene/src/dev/probeScripts.ts`）
- **新增** `ProbeScriptsOptions { clock?: number; seed?: number }` 与 `createProbeScripts({ bundle, state, sceneAssets, screen, pointers, options })`，返回 `{ load(), frame(dt, time, i), result(), dispose() }`：
  - realm 同宿主（`createIframeRealm`、内存 `localStorage`）；建好后把 realm 的 `Date`（无参构造与 `Date.now`）换成「起点 + 当前回放时间」，`Math.random` 换成按种子的序列；
  - `ScriptApi` 的读写接点 1 的共用函数；`recompile` 结果记进 `result().recompile`（目标路径与次数）；`sound` / `video` / `particles` 返回 null，被调到时计数；
  - `result()`：每段脚本的诊断（同宿主 `scriptDiagnostics`）、`recompile`、未接的 API、实际用的 `clock` 与 `seed`、`screenResolution`。

### 点 3 — 探针接线（`dev/probe.ts`、`dev/particleCorners.ts`）
- **新增** `RenderFrameOptions.scripts?: true | ProbeScriptsOptions`；与 `scriptValues` 同给时抛错。
- **修改** `renderFrame`：建好场景、视频就绪之后 `load()`（`init`）；回放的每一帧（`replayParticles` 的 `afterStep` 与读回帧）在设好相机之后调 `frame`；读回之后 `dispose()`。`RenderFrameResult.scripts`（不给时没有这个键）。
- 不给 `scripts` 时逐字节同以前。

### 点 4 — vite（`scripts/kabegame-dev/replay.ts`、`scene.ts`、`types.ts`）
- **新增** `RenderRequest.scripts`：`true` 或 `{ clock?: 有限数, seed?: 非负整数 }`，与 `scriptValues` 同给回 400；原样转给探针。`RenderMeta.scripts`；宿主产物不认识（给了却没回 `meta.scripts`）时 409 `[host]`，同第 6 批。

### 点 5 — MCP（`apps/kabegame-dev-mcp/src/tools.ts`、`renderFrames.ts`）
- **新增** `render_scene` / `host_render` 的 `scripts` 参数；给了时不发 FR 的 `scriptValues`，结果说明写「FR 由脚本自己画」，另列每段脚本的状态与出错、`recompile`、未接的 API。
- **新增** `renderFrames.ts` 的 `--scripts [--clock 毫秒] [--script-seed N]`。

### 点 6 — 文档
- `.claude/skills/kabegame-chromium/SKILL.md`：`scripts` 一节（外部值的来源与限制）；改掉「探针不跑脚本」的几处。
- `FINAL_CHECK.md` 工具表「确定性回放」一行：脚本能跑了，剩下的缺口（逐帧的 `Date`、音频、媒体录制）照实写。
- `cocs/wpe/WPE_SCENE.md`：dev 探针一行加 `scripts`。

### 验收
- **单测**：共用写回（宿主原有单测全过）；探针脚本环境（`Date` / `timeOfDay` / `Math.random` / `screenResolution` / `canvasSize` 的注入、`init` 与每帧 `update` 的次数与顺序、`recompile` 记录、未接 API 计数、与 `scriptValues` 互斥）；vite 的校验与 409；MCP 的参数与说明。宿主 tsc、`deno check`、vitest、Prettier 通过。
- **不给 `scripts` 时不变**：画面哈希 10 张 × 三档相同；第 6 批的 FR 涂色结果相同。
- **确定性**：同一请求连跑两次，sha256 相同。
- **对 WPE**（kbp 工程的 FR / CLK 都由脚本画，整帧不屏蔽）：`p5d-camo-s`、`p5d-camo-s4k`（窗口 1920×1080）按时间线回放、开 `scripts`，和 WPE 整帧逐像素相同；FR 块在第 N 帧的颜色由脚本算出，和 WPE 相同。
- 测试行 `projects_remove`，宿主产物按合并后的工作区重建。

### 实施记录 / 第 7 批（2026-11-14，子代理实现）

子代理在 HEAD `82653a66` 的独立工作树 `ignore/p5/d3/wt` 里实现点 1–6（`renderFrames.ts` 当时是别的会话没提交的文件，先跳过）。之后 P10a 走查的工具（`replayEncoded`、关键帧动画、`renderFrames.ts`）提交了，我把主工作区的现状三方合并进工作树（`ignore/p5/d3/sync_wt.py`），由同一个子代理把脚本接进 `replayEncoded`、补上 `renderFrames.ts` 的 `--scripts`，验收后拷回主工作区（`copy_back.py`，拷之前核对主工作区没变）。

**和计划不一致或计划没写到的：**
- 共用的除了写回 / 读取，还有重编译写入的去重（`recordRecompileWrite`）和诊断（`scriptDiagnostics`）：探针要和宿主用同一条「值变了才算」的规则，否则每帧写同一个值都会被记成不可信。
- `init` 之后整份交一次 `applyUserProperties`，同宿主首帧之前。
- 跑脚本时补全帧内的 `sync`：每帧步进之前一次，读回帧 `setParallax` 之后一次。视差点逐帧按这一帧开头的 general 推进。
- 读回后结清文本重排，重排过就把这一帧的帧输入再写一次。
- 缺省 `clock` 是 2026-01-01T00:00:00Z，缺省 `seed` 是 1。结果另带运行时告警（最多 100 条）和脚本 console 的最后 50 条。

**Claude 验收（工作树上）：**
- 越界只有计划内的文件。
- 宿主 tsc 0 错误；vitest 130 个文件、3085 条全过。
- `deno test`：vite 插件 26 组 127 步、MCP 25 组 93 步全过；`deno check` 退出码 0。
- 变异：子代理 16 处全部检出。我另做 10 处（`ignore/p5/d3/mutate_d7.py`），第一轮漏了 3 处：
  - 读相机目标总返回 null：步骤 3 就没有这条读路径的单测，补了 `readScriptState` 每种目标的断言；
  - 结清重排后不再写帧输入：补了用例；
  - 宿主写 `script-property` 目标返回 true：这类目标只出现在绑定表里，分支走不到，是等价变异。

  补测后复验两处都检出。
- 宿主 `writeScript` / `readScript` 改调共用函数，逐分支核对行为不变。
- `SceneState` 写 general 是换新对象，所以按帧存引用没问题。

**接进 `replayEncoded`（第二轮）：**
- 帧内顺序照渲染器 `render`：每一帧（含前 n − 1 帧）`sync` → 频谱 → 步进 → 相机 → 关键帧动画 → 脚本 → 视差点（用这一帧开头的 general）→ `setParallax` → `sync` → `update` → 编码（读回帧由探针编码）。宿主的 `beforeFrame` 里也是先动画、后脚本。
- 不给 `scripts` 时两条路径的调用序列与合并前逐项相同（子代理在 16 种组合下拿合并前的文件对照过）。
- 已知的不一致，没动：不跑脚本的路径用动画之后的 general 推进视差点，渲染器用帧开头的；只有关键帧动画写 `cameraparallax*` 时看得出来。
- 每帧一次 `render_scene` 时脚本状态各自从加载跑起，不跨帧延续（写进 SKILL.md）。

**Claude 验收（第二轮，工作树 = 主工作区现状 + 第 7 批）：**
- 宿主 tsc 0 错误；vitest 134 个文件、3179 条全过。
- `deno test`：vite 插件 26 组 127 步、MCP 28 组 108 步全过；`deno check` 退出码 0。
- 变异：子代理 10 处全部检出；我另做 3 处（`mutate_d7c.py`：脚本调用的帧时间与时间对调、`g_Daytime` 不跟回放时间、探针有回放时不把脚本交给回放），全部检出。
- 拷回主工作区之后：拷之前主工作区相对 HEAD 新增的行一行不少。除 `cocs/wpe/WPE_SCENE.md`（同步之后被别人改过，以同步时为基点三方合并，无冲突）外，23 个文件的 HEAD 版本就是同步时的版本，所以它们相对 HEAD 的差别正好是第 7 批。主工作区宿主 tsc、vitest 3179 条、两包 `deno test` 全过。
- **画面哈希**：HEAD `d58a7048` 原样（index-DYUzdWDT.js）对 HEAD + 第 7 批（index-v8Gk0vik.js），10 张 × 三档全部相同。不给 `scripts` 时画面不变。（第一轮两次被别的会话重建共享产物打断，这次没有。）
- **端到端（REST `scripts: true`，宿主 index-v8Gk0vik.js）**：
  - `p5d-camo-s`（原点挂模板脚本）第 184 帧、`p5d-camo-s4k`（场景 3840×2160、窗口 1920×1080）第 131 帧，和 WPE 整帧不排除任何区域逐像素相同；FR 由它自己的脚本画。我们的脚本日志 `canvasSize 3840 2160 screen 1920 1080 origin 1920 1080` 与 WPE 日志相同。
  - 同一请求连跑两次 sha256 相同。
  - 走查的五组复制工程，「脚本自己跑」与「塞值」逐字节相同。
  - 透视样本 `3453730450`（原点脚本用 `Date.now()` 缓入，另有透明度缓入、按帧时间累加的旋转、`init` 定缩放）关掉 `transparentsorting` 后和 WPE 逐像素相同。
- **发现、没修**：WPE 交给字段脚本的向量分量是 float32（日志里 z 是 `500.0000305175781`），我们是 double（`500.00003`）。这次只影响深度，没有看得出的差别。归 P3b 的脚本运行时。
