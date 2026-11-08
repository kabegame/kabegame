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
