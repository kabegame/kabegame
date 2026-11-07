# P3-0 — 场景宿主：渲染器与脚本同处一个隔离 realm（架构试验，2026-11-02 提出）

> 总计划见 [PLAN.md](PLAN.md)。实施拆成三步：
> - [phase-3-0a-host-channel.md](phase-3-0a-host-channel.md)：宿主与应用之间的通路（后端命令、垫片拉取、控制与状态事件）；
> - [phase-3-0b-renderer-move.md](phase-3-0b-renderer-move.md)：渲染器迁进宿主、应用页改成 iframe 外壳；
> - [phase-3-0c-frame-process.md](phase-3-0c-frame-process.md)：子 frame 不再跨窗口复用渲染进程（CEF 08，全局）、同进程 iframe 每帧只派发一次 rAF（CEF 09）。
> 本文件是 P3-0 的总述、已定决策与阶段 0 / MVP 的实测记录。
> 下一步（正式 P3，2026-11-03 定）：[phase-3a-bindings.md](phase-3a-bindings.md)（属性绑定与快速路径）→ [phase-3b-script-runtime.md](phase-3b-script-runtime.md)（脚本运行时）→ [phase-3c-runtime-graph.md](phase-3c-runtime-graph.md)（运行时渲染图）。

> **形态更新（2026-11-02，用户定）**：宿主不再用 `index.html?window=…` 分支的不透明源 iframe——下面「阶段 0 实测」证明那条路
> 读不了 `file:`、建不了 Worker、IPC 来源为 `null`。改成和网页壁纸一样的 **`file:` iframe**：
> - **项目**：`apps/wpe-scene` 是独立的前端项目（纯 TS + Vite；MVP 起初用了 Vue，2026-11-02 用户定去掉），不是共享包。
>   - 构建到 Tauri resources 下的一个目录；后端命令返回它 `index.html` 的 `file:///` 地址，主窗口 / 壁纸窗口的应用页把它赋给 iframe（CEF 补丁 05）。
>   - iframe 的 sandbox 同网页壁纸（`allow-scripts allow-same-origin`），保持 `file:` 来源。
>   - 编译与渲染代码（现 `apps/kabegame/src/wpe-scene`）迁移时整体挪进这个项目。
> - **读文件**：宿主直接 `fetch(file:)`（补丁 04 + 闸门）。应用的范围解析器给宿主目录一个专门范围：
>   - 根为宿主目录；
>   - 放行 WPE 安装目录的 `assets`、`config.json`，以及库里的场景壁纸目录。
> - **与应用通信**：只走 Tauri IPC，不用 postMessage。
>   - 例外（2026-11-02，用户定）：暂停与音量沿用网页壁纸已有的音量消息（父页面 → 垫片的 `postMessage`），消息多带 `paused`，垫片转成 WPE 网页 API 的 `setPaused`。见 [phase-3-0a-host-channel.md](phase-3-0a-host-channel.md)。
> - **场景宿主是一种特殊的网页壁纸**（2026-11-02，用户定）：
>   - 同一套 sandbox、同一份 `wpe-web-capability`，与网页壁纸同信任级别；
>   - 同样应答 ping / pong，按 `image-changed` 跟随用户属性（`userProperties`）；
>   - 场景专用命令另由按确切地址注册的 `wpe-scene-host-capability` 放行，不在宿主侧 deny 网页壁纸的命令与事件。
>   - `localStorage` 与网页壁纸共用 `file://` 存储区：允许。
>   - 同一窗口里的 `file:` frame 互相可达（补丁 04，网页壁纸之间本来如此）：接受。
>   - IPC 来源 = 宿主文档 URL（补丁 07 + `file_document_origin`）。
>   - 专用 capability 按运行时解析出的确切路径注册（不用路径通配，防止工坊内容造同名目录冒充），`frames: "sub"`，窗口限 main / wallpaper。
>   - 状态上报（ready / fallback）也走命令。
> - **取舍**：范围按文档路径算、不分实例，宿主（以及 P3 里同 realm 的第三方脚本）能读库里所有场景壁纸目录与 WPE 资源，读不到别处。按实例收窄要让解析器拿到文档 URL 的 query，以后再做。

**目的**：照 WPE 的模型（每个场景一个 V8 Isolate + Context，脚本与渲染同线程同步执行，见 [p3-script-REPORT.md](p3-script-REPORT.md) B / D 节），
把编译与渲染从应用页挪进场景宿主，P3 的脚本也跑在同一个 realm 里：脚本拿到的 `thisLayer`、`thisScene.getLayer()`、`createLayer()` 是真对象，
`update` 的返回值同步写回、当帧生效，不需要每帧消息往返和代理对象。D1 改为本条。
最早按「不透明源 sandbox iframe、编译留在应用页、`MessageChannel` 通信」设计，阶段 0 实测后改成上面的 `file:` 宿主；
旧的总体思路、阶段 1 与验收已删除，现行方案见本节末「阶段 1：渲染器迁进宿主」。

**阶段 0：可行性探针**（按不透明源形态写的历史记录）（先做，结论写进本节；任一条不成立就停下汇报）
1. **宿主形态**（用户定，2026-11-02）：
   - 复用主应用入口，按 `index.html?window=wpe-scene-renderer` 分支，iframe 以 `src` + `sandbox="allow-scripts"` 加载。
   - 照壁纸窗口的做法：`main.ts` 按 `WINDOW_KIND` 动态导入 `bootstrap/wpeSceneRenderer.ts`，`windowKind.ts` 加这一类。
   - 这个 bootstrap 只装渲染器，不装 Vue 组件库、路由、pinia、i18n，也不碰 `@/api` / `invoke` 和走 IPC 的 logger。日志经消息交给应用页。
   - 要实测：不透明源文档加载入口模块脚本与动态 chunk 的 CORS。
     - prod 下 `tauri://` 资源响应要带 `Access-Control-Allow-Origin`；
     - dev 下 Vite 的 `server.cors` 默认只放行 localhost 源，`Origin: null` 可能被拒。
   - 还要实测 `index.html` 里的内联脚本、CSP 注入在宿主里是否照常。
2. **WebGPU**：宿主里 `navigator.gpu` 可用（secure context），能 `requestAdapter` / `requestDevice`、配置画布；主窗口与壁纸窗口都测。
3. **进程隔离与卡死**：
   - 确认宿主是独立渲染进程；
   - 在宿主里人为死循环，看应用页 UI 是否仍能响应；
   - 应用页检测宿主无心跳后移除 iframe，进程是否被回收，场景是否退回预览图。
4. **帧率与节流**：壁纸窗口（WorkerW 下）与预览里，宿主的 rAF 是否满速，跨源 iframe 是否被节流。
5. **隔离核查**：在宿主里试以下几项，预期全部失败：
   - `invoke`（CEF 补丁 19 会给子 frame 注入桥，靠 ACL 拒绝；确认没有 `frames: sub/any` 的 capability 匹配它的来源）；
   - `fetch(file:)`；
   - 访问 `parent.document`；
   - 导航顶层；
   - 开弹窗。
6. **P3 的模块加载方式**：在宿主里跑一段带 `import * as WEColor from 'WEColor'` 的样本脚本，比较三个方案，选一个：
   - `import(blob:)`，需要 CSP 放开 `blob:`，只给宿主页面还是全局；
   - 把模块改写成函数后用 `new Function` 执行（`'unsafe-eval'` 已有）；
   - 专用 scheme 带自己的 CSP。

**阶段 0 实测（2026-11-02，dev、主窗口，MVP：`bootstrap/wpeSceneRenderer.ts` 只回答能力探针，CDP 驱动）**

| 能力 | 结果 |
|---|---|
| 加载入口模块与动态 chunk | dev 下 Vite 默认 CORS 拒绝 `Origin: null`；加 `sceneHostDevCors`（只对 `Sec-Fetch-Dest: script / worker` 回 `ACAO: null`）后通过。prod 的 `tauri://` 资源响应没有 ACAO，要在 runtime 补 |
| secure context / WebGPU / 画布 | 可用（nvidia lovelace，`webgpu` 画布可配置） |
| rAF | 145 fps（主窗口；壁纸窗口未测） |
| 进程隔离 | 是独立进程：宿主死循环 3 s 时，父页面计时器最大间隔 22 ms |
| `fetch(file:)` | 场景目录、WPE assets、工坊 pkg、系统文件全部 `Failed to fetch`（CEF 06 只给最外层主 frame 装 `file:` 工厂）。对照：主 frame 全能读，包括 `C:\Windows\win.ini` |
| `fetch` 应用自身资源（如 wasm） | 失败（CORS，中间件有意只放行脚本加载） |
| `new Worker(url)` | `SecurityError`：不透明源不能用任何 URL 建 Worker |
| `import(blob:)` / `new Function` / `WebAssembly.compile` | dev 下都可用；dev 页面由 Vite 返回、没有 CSP，prod 未测 |
| Tauri IPC | 子 frame 桥已注入（`__TAURI_INTERNALS__` 存在），但 `invoke` 报 `Origin header is not a valid URL`：runtime `ipc_origin` 对 initiator 为 `null` 的请求一律给 `null`，在 ACL 之前就被拒 |
| `parent.document` / `localStorage` | 都被拒（跨源；sandbox 没有 `allow-same-origin`） |

**file: 宿主实测（2026-11-02，P3-0 MVP：按「形态更新」搭宿主、不迁移渲染器；dev、主窗口，CDP 驱动）**

实现记录：
- **项目**：`apps/wpe-scene`（Vite 6 + Vue，`base: "./"`，依赖全在根 `node_modules`，`deno.lock` 只多了 workspace 成员记录）。现在只有一块 WebGPU 画布逐帧清屏。
- **产物**：`<resource_dir>/wpe-scene`。dev 由 `vite.config.ts` 默认值直接写 `target/debug/resources/wpe-scene`（`WpeSceneHostPlugin` 在 dev 开始时构建一次，之后 `deno task --cwd apps/wpe-scene build`），不经 tauri-build 复制：后者只在 `build.rs` 重跑时复制，而 resources 有变化就会让 `build.rs` 重跑、主 crate 重编、dev 重启应用。prod 写 `src-tauri/kabegame/resources/wpe-scene`（gitignore），经 `resources/**/*` 打包；dev 开始时删掉它，免得 `build.rs` 重跑时盖掉 dev 产物。
- **命令** `get_wpe_scene_host_url`：返回 `index.html` 的 `file:///` 地址（盘符大写），宿主没构建时报错；只注册进 `generate_handler!`。
- **范围解析器**（`wallpaper/wpe_scene_host.rs::access_scope_of`，宿主目录优先，其它照旧）：根为宿主目录；放行 `engine_dirs()` 的 `assets/` 与 `config.json`、库内全部 `x-wpe/scene` 目录。场景目录由网页壁纸目录索引顺带维护（`list_wpe_scene_rows` 全量 + 图片事件），不构成网页壁纸范围。宿主目录与 WPE 安装目录在启动与每次取地址时刷新，闸门只读内存。
- **capability**：`init_pre` 里 `add_capability`，`remote` 为宿主 `index.html` 的确切地址（URLPattern 特殊字符逐个转义；盘符冒号不转义会被当成具名组），`frames: "sub"`、窗口 main / wallpaper；只放行 `permissions/wpe-scene-host.toml` 的场景专用命令（`get_wpe_scene_postprocess`）。
- **与 `wpe-web-capability` 的重叠**：宿主同样匹配 `file:///*`，能调 `wallpaper_pong`、`wpe_web_pull_state` / `wpe_web_media_subscribe`（过 ACL 后报 `not inside a web wallpaper`），能监听 `wallpaper-ping` / `image-changed` / `images-change` / `setting-change`。代理起初在宿主侧 deny 了这些；按「场景宿主是一种特殊的网页壁纸」撤掉了 deny 与对齐清单的单测，这些正是宿主要用的。

| 能力 | 结果 |
|---|---|
| 入口模块与动态 import | Vite 默认的 `<script type="module" crossorigin>` 照常执行；`import("./x.js")` 加载宿主目录里的模块成功。不需要经典脚本 |
| secure context / WebGPU | `self.origin` 为 `file://`、`isSecureContext: true`；nvidia lovelace、有 BC，`webgpu` 画布可配置，同一帧读回清屏色 `[29, 29, 40, 255]` |
| rAF | 宿主 1–4 fps，但主页面自己同时也是 1 fps（窗口被遮挡 / 熄屏节流），本次无有效值 |
| `fetch(file:)` 放行 | vortex `scene.json`、`genericimage2.frag`、WPE `config.json`、工坊 2932157836 `scene.pkg` 整读（27,265,482 B）与 `Range` 区间读（16 B / 1000 B，状态 200、无 `Content-Range`）、宿主自己的文件 |
| `fetch(file:)` 拒绝 | `win.ini`、数据目录 `settings.json` / `images.db`、网页壁纸 `index.html`、视频壁纸 `project.json`、WPE 目录里 `assets` 之外的 `version.json`：`TypeError: Failed to fetch`，日志 `OutsideRoot; requester Document(…\wpe-scene\index.html)`、`grants 40` |
| Worker | `new Worker(file:)`（classic / module）与 blob worker 都能建；worker 里的 `fetch(file:)` 全部失败（`requester Deny`），文件仍要宿主主线程代读 |
| `import(blob:)` / `new Function` / `WebAssembly.compile` | 都可用（`file:` 文档没有 CSP）。P3 模块加载三方案都还开着 |
| Tauri IPC | `get_wpe_scene_postprocess` 成功；未放行的报 `Command <name> not allowed by ACL`；`setting-change` 改一次再改回收到两条；其它事件报 ``event `<name>` is not allowed to be listened by ACL`` |
| `parent.document` | `SecurityError: … Blocked a frame with origin "file://" from accessing a cross-origin frame.` |
| `localStorage` | 可用，与全部网页壁纸共用 `file://` 存储区（允许） |
| 进程隔离 | 独立 OOPIF；宿主忙等 3 s，父页面计时器最大间隔 29 ms。但宿主之间不隔离：P3-0b 实测壁纸窗口、应用背景、预览三个宿主共用一个 `file:` 渲染进程（CDP tracing 证实同一 pid），后续处理见 [3-0c](phase-3-0c-frame-process.md)：跨窗口分进程，同窗口仍同进程 |

遗留：
- 壁纸窗口没测（当前不是窗口模式）。
- prod（安装包）没测：地址、capability 与闸门都只在 dev 路径上验证过。
- 宿主没有自己的 CSP。
- 场景的状态拉取：`wpe_web_pull_state` 按调用方文档 URL 认壁纸，宿主是所有场景共用的一个文档，认不出是哪张。渲染器迁移时设计：例如应用页在 iframe 地址的 query 里带图片 id、宿主带着 id 拉取，后端校验该 id 是场景壁纸。

**主会话复核（2026-11-02，自写探针 `scratchpad/p30v/verify.mjs`、`sibling.mjs`，dev 主窗口）**：
- 改动范围与报告一致：`git status` 无越界；`third/` 与 `packages/*`、`src-crawler-plugins` 子模块的脏状态是此前就有的。单测 `kabegame wallpaper::wpe_` 14 passed。
- 放行与拒绝的读取、宿主自身的 invoke / listen 复测一致。窗口可见时 rAF 宿主与主页面都是 144 fps（D6 补上）。
- **缺口 1：宿主里再嵌的 `file:` 子 frame 绕过 deny。**
  - deny 只挂在宿主入口这一个地址上。
  - 宿主把子 frame 导航到两类文件，子 frame 的 IPC 来源只匹配 `wpe-web-capability`：
    - 宿主目录里别的文件（`assets/index-*.js`）；
    - 场景目录里的文件（`project.json`）。
  - 结果：能监听 `image-changed` / `wallpaper-ping`，`wpe_web_pull_state` 过 ACL（报 `not inside a web wallpaper`），`wallpaper_pong` 同理可调。
  - 宿主与子 frame 同源，第三方脚本能直接调子 frame 的桥。
  - 其它几种子 frame 没问题：`about:blank` 继承宿主来源，权限同宿主；`srcdoc` / `blob:` 报 `Origin header is not a valid URL`。
  - 修法（建议，两处都在我们自己的 crate）：
    a. 宿主 capability 的 `remote.urls` 从入口地址改为宿主目录的确切绝对前缀（`file:///…/resources/wpe-scene/*`，仍逐字转义）。宿主目录里任何文档都吃 deny。绝对路径不存在冒充问题。
    b. 闸门：`file:` 文档发起的 frame 导航只按文档自己的根目录裁决、不带放行项，同应用页导航的 `Target` 规则（`tauri-runtime-kbcef/src/file_access.rs` 的 `scope_for_request` 要拿到 `is_navigation`）。
       - 宿主就导航不进场景目录 / WPE `assets`，也导航不了自己。
       - 网页壁纸嵌自己目录里的页面不受影响；用户选的文件 / 目录照样能 `fetch`、`<img>`，只是不能当文档打开。
- **缺口 2：同窗口的 `file:` frame 互相可达。**
  - 补丁 04 让 `file:` 文档同源、同进程。主窗口同时有宿主与网页壁纸 iframe 时（如应用背景 + 预览），宿主经 `top.frames[i]` 能：
    - 读网页壁纸的 DOM；
    - 以它的身份 `wpe_web_pull_state`，拿到 `user` / `directories`；
    - 借它的 `fetch` 读它的目录。宿主自己直接读被拒。
  - 网页壁纸之间本来如此，宿主只是加入了同一个池。
  - 根治要让每个 `file:` iframe 各自成进程或来源，要动 CEF / Chromium，并重看补丁 04 的同源与访问语义，成本高。
  - WPE 自己的进程模型未确认（场景在 `wallpaper64.exe` 里原生渲染，网页壁纸由带 CEF 的 `webwallpaper64.exe` 承载，是否每张一个进程不知道）；在 P3 跑第三方脚本前定是接受还是根治。
  - 进程层面：跨窗口的共用由 [3-0c](phase-3-0c-frame-process.md) 的 CEF 补丁 08 拆开；同一窗口里的 `file:` frame 同源、同 BrowsingInstance，仍同进程、互相可达，本缺口不变。
- **用户裁定（2026-11-02）**：
  - 缺口 1 不成立：场景宿主是一种特殊的网页壁纸，本来就要应答 ping / pong、跟随用户属性，子 frame 拿到的网页壁纸权限也是宿主自己该有的。已撤掉宿主侧的 deny 及其对齐单测；修法 a / b 不做。
  - 缺口 2 接受。
  - `localStorage` 允许共用。
  - 宿主去掉 Vue，改纯 TS + Vite。
  - 撤后复测（`scratchpad/p30v/verify2.mjs`）：
    - 宿主没有 Vue，画布读回清屏色；
    - `get_wpe_scene_postprocess`、`wallpaper_pong` 成功；
    - 四个网页壁纸事件能监听；
    - `get_supported_image_types` / `images-added` 仍被拒。
  - 检查：`kabegame wallpaper::wpe_` 13 passed，`cargo check` 与宿主 tsc 0 error。
