---
name: kabegame-chromium
description: 连上跑起来的 kabegame dev app（桌面 CEF，或经 adb 连 Android dev 包的系统 WebView）做截图与 UI 自动化（CDP），以及调应用命令、把主窗口带到前台、打开某张图的预览、操作场景宿主、渲染场景帧、按 WPE 抓帧回放粒子（渲染一帧、轨迹、四角）、画面哈希、导入 / 移除测试工程、读应用日志。当需要 screenshot / 看看界面长什么样 / 验证 UI 改动在真实 app 里的效果 / 点击元素 / 在页面里执行 JS / 检查前端运行时状态 / 调 Tauri 命令 / 让用户看到正在调试的那张图 / 渲染某张场景壁纸或比画面哈希时使用；安卓同一套工具，dev 用 --mode android 跑即可。工具经 kabegame-dev MCP（mcp__kabegame-dev__*）或 vite 上的 REST（/__kabegame_dev/*）调用。区别于 dev:frontend 纯前端预览——这里连的是带完整 Tauri IPC 与真实数据的 app。本 skill 不启动 dev，需用户自己先跑起来。
---

# kabegame-chromium

让 agent 真正「看到」并操作跑起来的 kabegame dev app。桌面端跑在自建 CEF runtime（`src-tauri/tauri-runtime-kbcef/`）上，
Android dev 包跑在系统 WebView 上，两者都是 Chromium，都支持 **CDP（Chrome DevTools Protocol）**。

**先调 `status`**（MCP 工具，或 `GET /__kabegame_dev/health`）。截图完记得真看一眼——空白帧等于没起来。

## 架构

```
deno task dev -c kabegame [--mode android]      用户自己跑（能看到编译进度），本 skill 不代起
        │
        ├── app（CEF，CDP 端口随机）── 起来后 POST /__kabegame_cdp/register ──┐
        │   安卓：WebView 的 @webview_devtools_remote_<pid> ── adb forward ──┤
        │                                                                    ▼
        └── vite :1420 ── kabegame-dev 插件（scripts/kabegame-dev/）
                          · 找端点（桌面读登记，安卓走 adb），持有唯一一条 CDP 连接
                          · 状态：宿主句柄、控制台流、长任务
                          · 对外 REST：/__kabegame_dev/*（JSON 进出，截图回 image/png）
                                 ▲                         ▲
            脚本：apps/kabegame-dev-mcp/src/client.ts    stdio MCP「kabegame-dev」（apps/kabegame-dev-mcp/，
                  或直接 fetch / curl                    Claude Code 按 .mcp.json 拉起）：探活、一对一工具、封装工具
```

- **vite 持有连接和状态**：它本来就是 dev 的集合点，和 app 同生共死。连接是浏览器级 WebSocket + flatten session，
  只 attach 用到的目标——进得去跨进程的场景宿主 iframe，也不会被别的窗口忙拖住握手。
- **MCP 只做组合**：不依赖 vite 活着，工具表是静态的。vite 不在时照常列出，调用回 `[vite]`；vite 重启后 REST 没有会话要恢复，
  下一次调用自然就通，同一个 Claude 会话里一直可用。`.mcp.json` 新加或改了这一项后，用户要在 Claude Code 里 `/mcp` 重连或重开会话。
- **MCP 工具只经 `client.ts` 调 vite**：`client.ts` 是 REST 唯一的 typed 入口，接口改了要同时改它和工具描述。

**为什么不用 `deno task dev:frontend` + 无头浏览器**：那条路只有 Vite，没有 Tauri 后端，所有 `invoke` / `listen` 都是
`undefined`，看到的是空数据的空壳；而且 `__ANDROID__` / `__WEB__` 是编译期 define，浏览器里切不出安卓布局——要看安卓布局就用
`--mode android` 连真机。

## 前置

- 用户自己跑着 `deno task dev -c kabegame`（安卓是 `deno task dev -c kabegame --mode android`，另需 `adb` 与已授权的设备）。
- 场景宿主相关（`host_*`、`render_scene`、`hash_baseline`）：宿主产物要用 `--mode development` 构建（要有 dev 探针）。
- 不需要 playwright，也不用装浏览器。

## MCP 工具（`mcp__kabegame-dev__*`）

失败时结果是 `isError`，文本第一行 `[层] 说明`：`[vite]` 第 1 层 vite 不在；`[cdp]` 第 2 层 CDP 不在；`[handle]` 句柄 / 任务 /
控制台流不存在（vite 重启过）；`[target]` 找不到目标；`[page]` 页面里出错；`[app]` 应用命令拒绝；`[host]` 场景宿主；`[guard]`
测试工程护栏；`[platform]` 平台不支持；`[job]` 任务没成功；`[timeline]` 粒子回放的时间线组不出来（WPE 日志 / 轨迹缺帧、读不了）；
`[local]` MCP 本地（参数 / 文件）。

目标写法：`main`（主窗口，缺省）/ `wallpaper`（壁纸窗口）/ `url:<URL 子串>`（page 优先，其次 iframe）/
`host:<宿主句柄或 kbInstance>`。参数里的相对路径一律按仓库根解析。

**多个壁纸窗口**：窗口模式下每块在线屏一个壁纸窗口（macOS），`wallpaper` 只会选中其中一个（不保证是哪个）。
各窗口的地址是 `index.html?window=wallpaper&slot=<n>`，`n` 是 label 在池里的序号（`wallpaper` 为 0、`wallpaper-1` 为 1 …），
要指定某一个就写 `url:slot=<n>`；哪个序号在哪块屏，在该页面里 eval `get_wallpaper_window_assignment`（返回 `{ targetId, audible }`）
或看 `screenX` / `screenY`。同一张网页 / 场景壁纸显示在几个窗口（以及主窗口的应用背景）里时 iframe 的地址相同，`url:` 只会命中第一个。

| 工具 | 做什么 | 要 vite | 平台 |
|---|---|---|---|
| `status` | 两层探活：vite 在不在；经 vite 问 CDP 在不在。不在时报可能原因和下一步 | 不要（探的就是它） | 都有 |
| `targets` | page 与 iframe 目标（URL、类型、父目标、角色 main / wallpaper / scene-host） | 要 | 都有 |
| `eval` | 目标页面里求值（表达式或语句块，Promise 会等） | 要 | 都有 |
| `screenshot` | 截图，`selector` / `clip`（CSS 像素矩形 `{x,y,width,height,scale?}`）/ `fullPage` 三选一；回 image（缺省长边缩到 1568，见下方「图片输出」），可 `save` 落盘原图 | 要 | 都有 |
| `click`、`text` | 取元素中心派发鼠标事件（强制，不等可操作性）；取 innerText | 要 | 都有 |
| `invoke` | 调 Tauri 命令（主窗口里的 `__TAURI_INTERNALS__.invoke`） | 要 | 都有 |
| `console` | `start` / `read`（`since`）/ `stop`：按目标收集控制台消息与未捕获异常 | 要 | 都有 |
| `app_state` | 默认壁纸目标的当前壁纸（`currentWallpaper`）、壁纸模式、暂停、启用、后处理、显示器模式（`displayMode`）、全部壁纸目标的配置（`targets`：目标 id → 轮播路径与位置、按壁纸模式存的样式 / 过渡、当前壁纸）、轮播开关、路由、现有宿主 | 要 | 都有 |
| `show_window` | 把主窗口带到前台：最小化时 unminimize、不可见时 show，再 set_focus；没到前台（Windows 前台限制）时临时置顶再取消。回走了哪条路径、前后的 `visibilityState` / `hasFocus` | 要 | 桌面 |
| `open_image_preview` | 主窗口打开某张图的预览，再 `show_window`。导航到 `/gallery`（保留 query，加 `pvwimgid`）并整页重载；图在当前视图里就跳到它所在的页，不在就降级成单图预览，不改筛选条件。回最终路由、预览开没开、是哪张、在不在视图里 | 要 | 桌面（安卓未验，不显示窗口） |
| `android_screen` | adb 整屏截图（含系统栏、原生对话框）；`save` / `size` 同 `screenshot` | 要 | 安卓 |
| `hosts`、`host_open`、`host_close`、`host_eval`、`host_render` | 列出 / 开（缺省屏外）/ 关场景宿主；宿主里求值；渲染一帧（`save` / `size` 同 `screenshot`，`replay`、`canvas` 同 `render_scene`） | 要 | 桌面 |
| `projects_remove` | 按清单移除测试工程（只 `batch_remove_images`） | 要 | 桌面 |
| `job` | 任务表：列出 / `get` / `cancel` / `wait` / `start` | 要 | 都有（`start` 只桌面） |
| `render_scene` | 给图片 id：自己开屏外宿主、渲染一帧、关掉，回图片与元数据（`save` / `size` 同 `screenshot`）。不给 `replay` 时是固定时刻的一帧、粒子是预热后的状态（见下方「屏外宿主」）；给 `replay` 时按 WPE 的 dt 序列确定性回放粒子再读回（见下方「粒子回放」）。不给 `canvas` 时读回场景目标（场景分辨率）；给 `canvas: [宽, 高]` 时按 `fill` 上屏到这么大的画布再读回（见下方「读回画布」） | 要 | 桌面 |
| `particle_track` | 按 WPE 的一次抓帧回放粒子模拟器，在 `frames`（缺省为抓到的帧）输出和 `rd-*.json` 同格式的轨迹，写 `out`；回摘要（每帧每系统的粒子数、位置范围、时间线信息） | 要 | 桌面 |
| `particle_corners` | 读每个粒子四角的裁剪坐标与像素坐标（和 WPE 的 `gs_out` 比），写 `out`；回摘要（每层画不画、写进顶点的粒子数、前 3 个粒子的四个像素角）。`replay` 同 `render_scene` | 要 | 桌面 |
| `hash_baseline` | 起画面哈希任务并等完成（报 MCP 进度），基线写 `out`；`ids` 或 `from`（旧基线按目录对应） | 要 | 桌面 |
| `projects_import` | 导入 `ignore/` 下的测试工程并等完成，清单写 `out` | 要 | 桌面 |
| `hash_compare` | 只读两份基线，按 `input.path` 对应，比哈希与 unsupported | 不要 | — |
| `app_log` | `mark` / `since`（跨日期）/ `tail`，直接读 `.kabegame/debug/data/logs/kabegame.<UTC 日期>.log` | 不要 | — |

资源：`kabegame-dev://health`（同 `status`）、`kabegame-dev://targets`、`kabegame-dev://jobs`、`kabegame-dev://jobs/{id}`、
`kabegame-dev://app-log/{date}`（某天最后 2000 行，不需要 vite）。

### 图片输出（`screenshot`、`render_scene`、`host_render`、`android_screen`）

- **`size: { scale?, maxWidth?, maxHeight? }`** 只管回到会话里的那份：等比、不放大，几项同时给时取最严。**不给时长边缩到 1568**，
  原图不超过就原样回；要原图传 `{ scale: 1 }`（原图可能有十几 MB，例如 4K 渲染）。
- **`save`** 落盘的**总是原尺寸**：给路径（相对路径按仓库根），或 `"temp"`——落到系统临时目录下的 `kabegame-dev/`，自动命名
  `<工具名>[-<图片 id>]-<本地时间>.png`，结果里给完整路径。`inline: false` 只落盘不回图。
- 结果第一段写「原尺寸 W×H」「回传 w×h（已缩小）/ 原尺寸」「原图已保存：路径」。
- 缩小在 MCP 进程里做（`scripts/kabegame-dev/png.ts`：`node:zlib` 解码、按面积平均缩小、再编码），只支持 8 位、不隔行的 RGB / RGBA
  （CEF 截图是 RGB，探针输出是 RGBA）。别的格式要缩小时报 `[local]` 并给出已保存的原图路径，不会回一张错图。

```text
screenshot {}                                  → 回 1568 宽的图
screenshot { size: { maxWidth: 400 } }          → 只看个大概
render_scene { imageId: 13515, save: "temp" }   → 回缩小的图，原图 1920×1080 落到 %TEMP%\kabegame-dev\render_scene-13515-….png
```

### 屏外宿主是计算沙箱，不跑帧循环

`host_open`（缺省 hidden）、`render_scene`、`hash_baseline` 开的宿主摆在视口外，**rAF 不触发**（推测 Chromium 对完全不可见的跨进程
iframe 停了渲染；`document.visibilityState` 仍是 `visible`）。2026-11-09 实测 600 ms：屏外宿主 0 帧，同时主窗口预览里的宿主与应用背景
的宿主各 87 帧。所以在屏外宿主里：场景时间停在第一帧，脚本 `update` 只跑一次，粒子不步进。

- 屏外宿主只用来调探针里**一次跑完、结果确定**的接口：`renderFrame` 给固定时刻、`renderFrame` 的 `particles: { dts, … }` 回放、
  `profile`、`scriptCorpus`、`particleTrack` / `particleCorners`。
- **看实时行为用可见宿主**：`open_image_preview` 打开那张的预览，再 `screenshot`，或在那个宿主里求值（`hosts` 里 `where: "main"`、
  没有句柄的那个，`eval target=host:<kbInstance>`）。
- **不给 `replay` 时 `render_scene` 画粒子场景是预热后的状态**：不步进，`starttime` 为 0 的系统是空的。要看某一帧的粒子，给
  `replay`（见下一节）。

### 粒子回放（`render_scene` / `host_render` 的 `replay`、`particle_track`、`particle_corners`）

P4 和 WPE 真机核对的三种用法，都是屏外宿主里一次跑完、结果确定的计算（种子固定，不依赖帧循环）：按 WPE 的 dt 序列回放后渲染一帧
（和抓帧逐像素比）、只步进模拟器出轨迹（和 RenderDoc 轨迹比）、读四角（和 `gs_out` 比）。**工具只出结果、不做比较**：比较自己跑
`ignore/p4` 下的脚本（例如 `cmp_track.py`、各步的 `real.mjs` / `replay.test.ts`）。

`replay` 两种写法，给了就不收 `time`（读回那一帧的 `g_Time` 取时间线或 `times` 的末项）：

```text
replay: { timeline: { log, track?, frame?, gap?, cursors?, cursor?, window? }, seed?, passes?, random? }   常用：从 WPE 的一次抓帧组时间线
replay: { particles: { dts, times?, seed?, passes?, random? } }                                  直接给探针（缺省 seed 1、passes 1）
```

真实工坊场景没有 FR、抓帧没有 `[kbp]` 日志：不要手写 `dts`，先用 kbp-tools 的 `kbp content unpack <工坊 ID> --instrument` 解包一份
末尾加了日志图层的副本去抓帧，回放写 `timeline: { log, frame, cursors: "log" }`（不给 `track`），流程见 kbp-tools SKILL.md「真实场景的回放」。

**时间线**（`apps/kabegame-dev-mcp/src/timeline.ts`，脚本也能 import `buildTimeline`）：`log` 是 WPE 日志
`ignore/p4/out/<标签>-log.txt`（只读 `[kbp] 帧号,帧时间,累计时间`，`cursor=True` 生成的工程另带两列屏幕光标，见 kbp-tools 的协议），
`track` 是 RenderDoc 轨迹 `ignore/p4/tracks/rd-<标签>.json`，
`frame` 是回放到的帧（WPE 脚本帧号，即读回的那一帧，缺省为轨迹最后一帧）。规则照 P4 各步的回放脚本：

- 第 f 帧 dt = 日志累计时间第 f 项减第 f − 1 项（第 1 帧就是它自己），四舍五入到 6 位小数；不用 frametime 列（差分不累积舍入）。
  `g_Time` 取日志的累计时间。抓到的帧（轨迹里有的）dt 与 `g_Time` 换成轨迹的 float32 原值。
- **缺帧**：fps 低时日志每 50 帧才刷一次，尾巴会缺。日志和轨迹都没有的帧缺省报 `[timeline]` 并列出；`gap: "split"` 把缺的那一段按
  「后一个已知帧的 g_Time − 它的 dt」与前一帧 `g_Time` 之差平分（dt 同样 6 位小数，`g_Time` 累加），结果里写明平分了哪几帧。平分有误差：
  `p4b-fps10` 的第 151、152 帧平分是各 0.099432，按粒子反推的真实拆分是 0.099343 / 0.099521（`phase-4b-tier2.md` 步骤 3），
  出生在这两帧、对拆分敏感的粒子会偏。缺的那段后面没有已知帧时没法平分，照样报错。
- **`passes`**（operator 遍数）缺省按标签里的 `fps<N>` 推：N 在 1–20 两遍，否则一遍（同 `particlePasses`）；标签先看轨迹的 `tag`，推不出
  再看日志文件名。推不出就 1，结果里会写明——P4a 的 `s15` 这类标签不带 `fps`，要两遍得自己传 `passes: 2`。
- **光标**（P5a 收尾起三个工具都收逐帧光标）：单位是 `g_PointerPosition`（抓帧窗口归一化，原点左上、y 朝下、不钳制），**不要自己换算**：
  工具把它连同窗口尺寸交给探针，探针照渲染器按壁纸样式 `fill` 推出控制点的 cursor（`sceneCursor`，同 kbp replay），窗口和场景同尺寸时原样。
  - `cursors: "log"`：每帧取日志的屏幕光标 ÷ 窗口尺寸（float32），要 `cursor=True` 生成的工程（五列日志）。脚本第 f 帧记下的光标就是
    粒子第 f 帧用的，抓帧期间光标在动（跟随指针的粒子、视差）只有它能复现。日志缺的帧沿用相邻帧，结果里列出；抓到的帧上和轨迹 `pointer`
    逐帧核对，不为 0 时另起一行警告。日志带光标列、却没传 `cursors` 时结果里提示一句。
  - `cursors: "track"`：抓到的帧取轨迹的 `pointer`、其余帧取 `cursor`（缺省 `[0.5, 0.5]`）；WPE 只在抓到的帧记了 `pointer`，别的帧是猜的。
  - 也可以直接给整串（长度 = `frame`）；只给 `cursor` 时每帧都是它。
  - `window: [宽, 高]`：缺省从轨迹 tag、再从日志文件名末尾的 `-<宽>x<高>` 读；`"log"` 推不出就报 `[timeline]`；推不出时（非 `"log"`）
    探针按和场景同尺寸处理。`window` 要和光标一起给。
  - 探针怎么用：`render_scene` / `host_render` / `particle_corners` 把逐帧光标作 `pointers` 交给探针，第 i 帧步进粒子与视差点用第 i 项，
    预热用第 0 项，读回那一帧的 `g_PointerPositionLast` 是上一帧的；`particle_track` 交 `cursors`。`render_scene` 的固定 `pointer` 和时间线
    的逐帧光标不能同给（`[local]`）。

**结果**：`particle_track` 写 `out`（`{ source: "sim", project, tag, frames: [{ frame, dt, systems: { <系统名>: [粒子] } }], skipped }`，
和 `rd-*.json` 同格式、可直接交给比较脚本；帧表系统与拖尾的粒子另带 `thick` = `[vx, vy, vz, frame]`）；`particle_corners` 写 `out`（每层
`{ object, name, perspective, drawn, count, uv, corners, pixels, particles }`，`corners` 是每粒子四角的裁剪坐标 `[x, y, z, w]`，`pixels` 是
场景像素坐标、原点左上）。四角的两点（P4c 步骤 5）：`drawn` 为 false 表示这一层渲染时整次不画（`upright` 的轴平行于视线、朝向是 NaN），
四角照算，和 WPE 的 `gs_out` 一样是 NaN（结果经 JSON 传回、落盘，NaN / ±Infinity 在文件里是 `null`，摘要里显示 NaN）；`count`、`particles` 是**写进顶点的**粒子，拖尾系统去掉了退化的（速度为 0 或平行于视线），
所以拖尾层的 `count` 可以小于存活数（存活数看 `particle_track` 或渲染元数据）。`particle_track` 的场景用户属性取工程
缺省值（探针不收 `userProperties`）。结果超过 32 MB 报 `[host]` 413，减少 `frames` / 用 `limit` 收小。

```text
particle_track   { imageId: 14182, timeline: { log: "ignore/p4/out/p4c-cp-fps60-log.txt", track: "ignore/p4/tracks/rd-p4c-cp-fps60.json", frame: 927 },
                   out: "ignore/p4/xx/sim-p4c-cp.json" }
render_scene     { imageId: 14181, replay: { timeline: { log: "ignore/p4/out/p4b-refract-fps60-log.txt", track: "ignore/p4/tracks/rd-p4b-refract-fps60.json", frame: 907 } } }
particle_track   { imageId: 14180, timeline: { log: "ignore/p4/out/p4b-fps10-log.txt", track: "ignore/p4/tracks/rd-p4b-fps10.json", gap: "split" }, out: … }  → passes 2，平分 151–152
particle_corners { imageId: 14179, replay: { particles: { dts: [720 个 1/60], seed: 1, passes: 1 } }, limit: 64, out: … }
render_scene     { imageId: <id>, replay: { timeline: { log: "<数据目录>/out/<工程>-fps60-1920x1080-log.txt", track: "<数据目录>/tracks/rd-<同一标签>.json", cursors: "log" } } }
                   → 每一帧的光标取日志（工程用 cursor=True 生成），窗口 1920×1080 取自标签
```

2026-11-09 核对：`particle_track` 对 `p4c-cp`（927 帧）和 node 里同一时间线直调 `particles/track.ts` 逐字相同，和 WPE 轨迹的差与
`ignore/p4/c1/out/replay-cp.txt` 逐系统相同；`render_scene` 回放 `p4b-refract` 到 907 帧，RGBA 摘要等于 `b5v/out/real-summary.json`；
`particle_corners` 对 `p4a` 和 `step4/out/ours-p4a-corners.json` 逐位相同（记录见 `.claude/plans/tools/kabegame-chromium-lib.md` 第 4 批）。

### 读回画布（`render_scene` / `host_render` 的 `canvas`）

不给 `canvas` 时读回的是场景目标（场景分辨率，比如 3840×2160），和加这一项之前逐字节相同。给 `canvas: [宽, 高]`（两个正整数，各不超过
16384）时，探针在读回那一帧编码完场景之后，用产品上屏的**同一份**着色器与线性采样器（`apps/wpe-scene/src/render/blit.ts`，渲染器也用它）
按 `fill`（`scenePlacement("fill", …)`，居中盖满裁切，同 WPE 测试窗口）把场景目标铺进这么大的 `rgba8unorm` 纹理，读回它：PNG 与
`meta.sha256` 都是画布的，`meta.width` / `height` 是画布尺寸，另有 `meta.canvas`（不给时 null）与 `meta.sceneTarget`（场景目标尺寸）。
结果第一段写明读回的是什么。

- **和 WPE 抓帧比时传抓帧窗口的尺寸**，比较前不用再缩放。场景是窗口的 2 倍（3840×2160 对 1920×1080）时线性采样正好落在 2×2 的中点，
  输出就是 2×2 平均（实测和浮点平均最大差 0.5，和四舍五入后的平均最大差 1）。
- **画布就是模拟的壁纸窗口，光标按它换算**：探针用 `window ?? canvas`。时间线交给探针的窗口（有逐帧光标时才交）和 `canvas` 不同时报
  `[local]`、不开宿主；REST 同时给 `window` 与 `canvas` 而不同回 400（`field: "canvas"`）。没给逐帧光标时窗口不交给探针，不比较。
- 没给 `canvas`、时间线推得出窗口（标签末尾的 `-<宽>x<高>`）而读回尺寸和它不同时，结果里提示该传的 `canvas`。`canvas` 不反过来喂给
  时间线，也不默认取时间线的窗口（老调用的读回尺寸不变）。
- **只改读回、不改渲染**：`g_Screen`、`g_TexelSize` 等内置 uniform 仍按场景目标算，同产品。**已知差异**：WPE 场景比窗口大时按窗口分辨率
  直接画图层（`3830255100-kbp` 的抓帧：图层画进 1920×1080 的后备缓冲，只有图层合成 RT 是 3840×2160），我们先按场景分辨率画、上屏再缩，
  这部分差别会留在比较结果里（是产品的差异）。
- 宿主产物不认识 `canvas`（改了探针没重建）时 vite 报 409 `[host]`，不会把场景目标当画布交回。

```text
render_scene { imageId: <id>, replay: { timeline: { log: "ignore/p5/inst/out/3830255100-kbp-fps20-1920x1080-log.txt", frame: 173, cursors: "log" } },
               canvas: [1920, 1080] }   → 读回 1920×1080，直接和 WPE 第 173 帧比
```

2026-11-12 核对（`3830255100-kbp`，记录见 `.claude/plans/tools/kabegame-chromium-lib.md` 第 5 批）：不给 `canvas` 时摘要与改动前相同；回放到
173 帧给 `canvas: [1920, 1080]` 的输出和场景目标的 2×2 平均最大差 1；`[1080, 1080]` 和场景目标中间 2160×2160 裁出缩小的图最大差 1。

## REST（`/__kabegame_dev/*`，vite 上）

请求和响应都是 JSON，截图回 `image/png`（带 `X-Png-Width` / `X-Png-Height`，以及原图的 `X-Png-Original-Width` / `-Height`）。
截图、渲染、安卓整屏可选带 **`resize: { scale?, maxWidth?, maxHeight? }`**（GET 用同名 query），规则同 MCP 的 `size`，在 vite 里缩小后再回；
**不带时回原图**。渲染带 `resize` 时 `png` 是缩小后的，`pngSha256` / `pngBytes` 仍说的是原图，`size` 报两者尺寸。
出错回 `{ error, layer, … }`：参数错 400（粒子相关的参数带 `field`，指到错的那一项，例如 `particles.dts[3]`）；来源不对、测试工程护栏 403；句柄或任务不存在 404（提示 vite 可能重启过）；页面抛错、找不到
目标或元素、应用命令被拒、PNG 格式不支持缩小（`png`）422；宿主产物问题、主窗口里有宿主时打开预览 409；CDP 不可用 503（带 `endpoint`
结论）；超时 504；轨迹 / 四角结果超过 32 MB 413；插件内部错误 500。

| 方法 与 路径 | 做什么 | 平台 |
|---|---|---|
| `GET /health` | `{ vite: true, android, cdp: 端点或端点错误, session }`，每次现探 CDP | 都有 |
| `GET /targets` | page 与 iframe 目标 | 都有 |
| `POST /eval` | `{ target, expression, timeoutMs? }` → `{ value, type }` | 都有 |
| `POST /screenshot` | `{ target, selector? \| clip? \| fullPage?, resize? }` → PNG | 都有 |
| `POST /click`、`POST /text` | `{ target, selector }` | 都有 |
| `POST /invoke` | `{ command, args? }` → `{ value }` | 都有 |
| `POST /console`、`GET /console/:id?since=`、`DELETE /console/:id` | 开始收集 / 取新增 / 停 | 都有 |
| `GET /app/state` | 应用状态快照 | 都有 |
| `POST /app/show-window` | 把主窗口带到前台 → `{ front, path, before, after, steps }` | 桌面 |
| `POST /app/open-preview` | `{ imageId, timeoutMs?, show? }` → `{ imageId, before, route, preview, window, ms }`（`preview.mode`：`in-view` / `single`） | 桌面 |
| `GET /android/screen` | `adb exec-out screencap` → PNG；`?scale=&maxWidth=&maxHeight=` 同 `resize` | 安卓 |
| `GET /hosts`、`POST /hosts`、`DELETE /hosts/:h` | 列出 / 开（`{ hidden?, scene? }`）/ 关场景宿主 | 桌面 |
| `POST /hosts/:h/eval` | 在宿主里求值 | 桌面 |
| `POST /hosts/:h/render` | `{ imageId, time? \| particles?, postprocess?, userProperties?, pointer? \| pointers?, window?, canvas?, resize? }` → `{ meta, png(base64), pngSha256, pngBytes, size }`；`particles: { dts, times?, seed?, passes?, random? }` 原样交给探针回放，和 `time` 互斥；`pointers` 是逐帧的 `g_PointerPosition`（和 `particles.dts` 等长、要有 `particles`、不和 `pointer` 同给），`window` 是抓帧窗口 `[宽, 高]`；`canvas` 是读回画布 `[宽, 高]`（两个正整数、各不超过 16384，和 `window` 都给时要相同，否则 400 `field: "canvas"`），`meta` 带 `canvas`、`sceneTarget`（见「读回画布」） | 桌面 |
| `POST /hosts/:h/particle-track` | `{ imageId, dts, times?, frames, passes, seed?, random?, cursors?, window?, tag? }` → 探针 `particleTrack` 的轨迹 JSON（同 `rd-*.json`）；`cursors` 是逐帧的 `g_PointerPosition`，`window` 要和它一起给 | 桌面 |
| `POST /hosts/:h/particle-corners` | `{ imageId, particles?, pointers?, window?, layer?, limit?, postprocess?, userProperties?, wgsl? }` → 探针 `particleCorners` 的各层结果；`pointers` / `window` 同 render | 桌面 |
| `POST /projects/remove` | `{ manifest, allowPrefix? }` | 桌面 |
| `POST /jobs` | `{ kind: "host-task" \| "hash-baseline" \| "projects-import", params }` → 任务记录 | 桌面 |
| `GET /jobs`、`GET /jobs/:id`、`DELETE /jobs/:id` | 列出 / 查（状态、进度、结果）/ 取消 | 都有 |

## 脚本写法

验收脚本不必经 MCP，直接用 typed 客户端（Deno 跑；Node 能直接跑 TS 时也行）：

```ts
import { createClient } from "../../apps/kabegame-dev-mcp/src/client.ts"; // 按脚本位置写相对路径
const dev = createClient(); // 端口取 KABEGAME_DEV_SERVER_PORT，缺省 1420
console.log(await dev.health());
const mode = await dev.invoke("get_wallpaper_mode");
const png = await dev.screenshot("main", { clip: { x: 0, y: 0, width: 200, height: 100 } });
const small = await dev.screenshot("main", { resize: { maxWidth: 800 } }); // 不带 resize 回原图
const opened = await dev.openImagePreview("13515"); // 重载主窗口打开预览，再带到前台；opened.preview.mode 是 in-view / single
const job = await dev.jobStart("hash-baseline", { from: "ignore/p4/c1/out/hash-after.json" });
const done = await dev.waitJob(job.id, { onProgress: (p) => console.error(p) });

// 粒子回放：时间线在脚本里组（同 MCP），再交给宿主
import { buildTimeline } from "../../apps/kabegame-dev-mcp/src/timeline.ts";
const tl = buildTimeline({ log: "ignore/p4/out/p4c-cp-fps60-log.txt", track: "ignore/p4/tracks/rd-p4c-cp-fps60.json" }, { root: "D:/Codes/kabegame" });
const host = await dev.hostOpen({ scene: "14182" }); // 屏外宿主
const track = await dev.hostParticleTrack(host.handle, {
  imageId: "14182", dts: tl.dts, times: tl.times, frames: tl.captured, passes: tl.passes?.passes ?? 1,
});
const frame = await dev.hostRender(host.handle, { imageId: "14182", particles: { dts: tl.dts, times: tl.times, passes: 1 } });
await dev.hostClose(host.handle);
```

出错统一抛 `KabegameDevError`，`layer` 同上。也可以直接 curl（本机设了 `HTTP_PROXY` 时要加 `--noproxy '*'`，否则请求会交给代理）：

```bash
curl -s --noproxy '*' localhost:1420/__kabegame_dev/health
curl -s --noproxy '*' localhost:1420/__kabegame_dev/eval -d '{"target":"url:surf","expression":"location.href"}'
curl -s --noproxy '*' localhost:1420/__kabegame_dev/screenshot -d '{"target":"main"}' -o shot.png
```

`client.ts` 内部用 `node:http` 直连（`localHttp.ts`），不读代理环境变量，不需要 `NO_PROXY`。

## 长任务

画面哈希要渲染几十次、导入要等后台任务完成，都是几分钟的事，由 vite 的任务表跑：`POST /jobs` 立刻回任务 id，再查进度和结果；
结束的任务只留最近 20 个。MCP 的 `hash_baseline`、`projects_import` 自己起任务并等完成，期间发 MCP 进度通知；`job wait` 等任意任务。
MCP 请求被取消时会顺手取消 vite 里的任务（协作式）。

- `hash_baseline`：每张场景按档位（缺省 disabled / enabled / ultra）、固定时刻（缺省 1.5 s）各渲染两次，两次不同就停；格式同旧
  `hash-*.json`。`from` 给旧基线时按 `input.path` 找库里现在的图片 id（测试工程重新导入后 id 会变）。`out` 已存在时拒绝，除非
  `overwrite: true`。10 张 × 3 档约 90 s。
- **直接走 REST 的画面哈希任务**（`POST /jobs { kind: "hash-baseline", params: { ids? | from?, time?, levels?, host? } }`）：结束后
  `GET /jobs/:id` 的 `result` 是 `{ ok, unstable, baseline }`——`baseline` 才是 `hash-*.json` 的内容，`unstable` 是停下的那组
  `{ id, postprocess }`（`ok: true` 时为 null）。**REST 没有 `out` 参数**，不落盘；落盘只在 MCP 的 `hash_baseline` 里做，脚本要自己写
  `JSON.stringify(result.baseline)`。
- `hash_compare`：A、B 按 `input.path` 对应；sha256、stable、postprocess、bloomLevels、尺寸、格式、unsupported（按集合）、输入算差异；
  targetBytes、metadataId 单独列。两边是同一份宿主产物时会提醒「相同只说明可复现」。
- `projects_import` → `projects_remove`：清单 `{ <目录>: { image, task, preexisting } }`，移除时 `manifestFile` 传同一个文件。

## Android

dev 用 `--mode android` 跑时 vite 就知道是安卓（`vite.config.pub.ts` 的 `isAndroid`），端点改由 vite 经 adb 现找：

```
adb shell pidof app.kabegame.dev → <pid>        （KABEGAME_ANDROID_PACKAGE 可覆盖包名，ANDROID_SERIAL 选设备；都是 vite 进程的环境变量）
├── /proc/net/unix 里确认 @webview_devtools_remote_<pid> 存在
├── adb forward --list 有指向这个 socket 且应答的转发 → 复用；否则 adb forward tcp:0 新建
└── 移除指向别的 webview_devtools_remote_* 的旧转发
```

- **只对 dev 包有效**：prod 包 `app.kabegame` 的 devtools 为 false，没有调试 socket。
- **pid 每次启动都会变**，所以每次连接前都重新 `pidof`；转发端口不缓存。
- **主窗口 URL 是 `http://tauri.localhost/...`**（dev 也一样，不是 `:1420`），`main` 已认这个 host。
- **CDP 截图只有 WebView 内容**：系统状态栏、原生权限弹窗、通知、Kotlin 侧 UI（如 picker）都截不到，要看就用 `android_screen`。
- 场景宿主、渲染、测试工程、起任务只在桌面，安卓上报 `[platform]`。

| `status` 第 2 层的端点层 | 处理 |
|---|---|
| `adb` | 找不到 adb：platform-tools 没装或不在 vite 进程的 PATH 里 |
| `device` | `adb devices` 看是否未授权 / 多台设备未设 `ANDROID_SERIAL` |
| `app` | 请用户跑 `deno task dev -c kabegame --mode android` 或手机上打开 dev 包 |
| `socket` | 装的是 prod 包，或 WebView 还没创建完 |
| `forward` | 转发建不起来或不应答，`adb forward --list` 看看 |

## 端点链路

排查「找不到 CDP」时按这条链走：

1. `scripts/plugins/component-plugin.ts` — dev（且非 CLI）注入 `KABEGAME_CEF_DEBUG_PORT=random`。**只在 dev 注入**，build / 打包
   路径不经过这里。显式设了这个 env（含 `=0` 关闭）时尊重用户的值。
2. `src-tauri/tauri-runtime-kbcef/src/runtime.rs` — `remote_debugging_port()` 解析 `random` → 内核分配空闲回环端口，结果 memoize 在
   `OnceLock`（每次重算会让 `CefSettings` 里 bind 的端口和事后上报的对不上）。command-line hook 用的是 `remote_debugging_requested()`
   （纯 env 判断，不分配端口）——它在每个子进程都跑，去分配端口有概率抢掉 browser 进程要用的号。
3. `src-tauri/kabegame/src/debug_ingest.rs` — `spawn_cdp_register()` 轮询 `/json/version` 直到真的应答，**然后**才 POST 给 vite。
   所以「vite 上有登记」等价于「CDP 曾经就绪」。
4. `scripts/vite-debug-server.ts` — `/__kabegame_cdp/register`（POST 登记）与 `/__kabegame_cdp`（GET 查询）。登记在模块级内存里，
   **并落盘**到 `.kabegame/debug/cdp-port.json`（gitignored）；`currentCdpRegistration` 内存优先、没有再读落盘。vite 重启会清空内存，
   落盘是这条链路唯一跨得过重启的环节。
5. `scripts/kabegame-dev/endpoint.ts` — `resolveEndpoint`：桌面读登记，再用 `/json/version` 的 `webSocketDebuggerUrl` 验活；安卓走上面的
   adb 流程。没有别的发现途径（不再扫端口）。
6. `scripts/kabegame-dev/session.ts` — 懒建立唯一一条浏览器级 WebSocket，断开后下一次请求经 `resolveEndpoint` 重连；连接换过，
   旧句柄失效（报 `[handle]`）。
7. `scripts/kabegame-dev/rest.ts` → `apps/kabegame-dev-mcp/src/client.ts` → MCP 工具。

## Gotchas

- **不经 vite 跑 dev 二进制时没有这组工具**：端点只从 vite 的登记里来。只重启 vite 时登记有落盘，起来就恢复。
- **vite 重启会丢句柄、任务和控制台流**（改 `vite.config.*` 或它 import 的本地文件，包括 `scripts/kabegame-dev/` 与
  `scripts/vite-debug-server.ts`，vite 都会自己重启一次，app 页面随之整页刷新）。旧 id 回 404 `[handle]`，重开即可；
  vite 关闭时会移除它开的屏外 iframe、取消任务。`uno.config.ts` 不在 vite 的 config 依赖里，不触发重启。
- **一次改几个插件文件时，vite 可能拷到一半就重启、读到新旧混合的文件**（2026-11-09 实测：一条 `cp` 拷 8 个文件，新 `rest.ts` 生效、
  最后拷的 `backend.ts` 还是旧的，接口回 500 `backend.hostParticleTrack is not a function`；重启进行中的后续改动被合并掉，不会再重启）。
  拷完要打一下新接口核对；不一致就 `touch` 一个插件文件再触发一次重启。
- **登记没有撤销机制**：app 退出后 vite 与磁盘上都仍留着旧端口，所以每次用之前都验 `/json/version`；不应答就报第 2 层 `cdp`。
- **验活必须看 `webSocketDebuggerUrl`，不能只看 HTTP 状态码**：vite 的 SPA 兜底对任意路径都回 200 text/html。
- **随机端口有极小的 TOCTOU 窗口**：探号的 socket 释放后、CEF 真正 bind 前，别的进程可能抢先占上。表现为 CDP 起不来，重启 dev 换个号即可。
- **场景宿主要用 `--mode development` 构建**：dev 探针（`window.__kabegameSceneProbe`，在 `apps/wpe-scene/src/dev/`）只在 development
  构建里有；没有探针时 `host_open` 报 `[host]`。探针接口（`renderFrame` 与它的 `particles`、`particleTrack`、`particleCorners`、
  `chunk`）改了要同步 `scripts/kabegame-dev/scene.ts` 与参数校验 `replay.ts`（不认识的字段一律 400，探针新增参数要在这里放行）。
- **只信任新加载的宿主**：只认「文档入口脚本 = 磁盘上 `<target>/debug/resources/wpe-scene/index.html` 的入口脚本」的新 frame
  （P3c 的教训：旧 frame 跑旧代码，档位选项会被悄悄忽略）。宿主产物重新构建后，旧宿主不会被复用。
- **屏外宿主截不到图，也不跑帧循环**：`screenshot` 报 `[host]`，取画面用 `render_scene` / `host_render`；看动起来的样子用
  `open_image_preview`（见上方「屏外宿主是计算沙箱」）。非屏外宿主（主窗口预览）按 iframe 位置从主窗口截。
- **预览相关依赖 Vue 内部**（dev 构建才有 `__vueParentComponent`）：判断预览开没开、是哪张，看 `ImagePreviewDialog` 的
  `exposed.previewVisible` 与 `props.image`（`host_close` 的 `before` / `after`、`open_image_preview` 都用它，图片、视频、网页、场景都认）；
  页码看外层 `ImageGrid` 的 `exposed`；`host_open hidden:false` 与关预览用 `openPreviewById` / `closePreview`。前端改了可能失效，失败时报原因；
  缺省的屏外宿主不碰用户的预览。
- **`open_image_preview` 会整页重载主窗口**（网格只在挂载时读一次 `pvwimgid`），用户正在看的界面会变：原来的预览被换掉、页码回到
  目标页。主窗口里有 vite 开的宿主时拒绝（`[host]`，重载会把它们一起销毁），先 `host_close`。用完要恢复就关掉预览（`pvwimgid` 随之从 URL
  去掉），路由与 query 就回到原样；页码是网格自己的状态，不在 URL 里，跳过页就要重新导航回原地址。
- **`open_image_preview` 一返回就截图，会截到弹窗淡入的半透明画面**，场景 / 网页壁纸也还没出首帧：等 1 s 左右再截，或先在宿主里求值确认
  在出帧。
- **`show_window` 会抢走用户当前窗口的焦点**，只在要让用户看到某个画面时用。到没到前台看结果里的 `visibilityState`（被别的窗口完全挡住、
  最小化时是 `hidden`）与 `hasFocus`。不会无条件 unminimize / show：CEF 的 restore 会把最大化的窗口还原。
- **测试工程只移除、不删除**：`projects_remove` 只调 `batch_remove_images`，不删磁盘文件；只动目录在仓库 `ignore/` 之下（且在
  `allowPrefix` 之下）的行，任务也必须是只导入这些目录、已结束的 `wpe-import`，有一行不符就整批拒绝、库不变。**绝不调
  `batch_delete_images`**（会连源文件一起删），`invoke` 里也不要调。验收后核对没有残留行与任务。
- **Windows 上壁纸窗口挂到 `WorkerW` 后 CDP 截不到图**：`screenshot target=wallpaper` 等帧超时（`[page]`）。这**不是**页面降频——
  2026-10-26 在页面内直接计时：rAF 稳定约 144Hz（dev 调试面板 `.debug-panel` 第一行有 MIN / AVG 帧率），fade 过渡 prep → enter 相隔
  10ms、提交由 800ms `transitionend` 触发。要测壁纸窗口的时序，在页面里装 `MutationObserver` / `performance.now()` 记时间线，再一次性
  读出，不要靠多次 eval 推算。验证壁纸窗口改用 `eval target=wallpaper` 读 DOM（`img.base` 的 `naturalWidth`、`<video>` 的 `paused` /
  `volume` / `playbackRate`、`.debug-panel` 的文字）。
- **截到全屏壁纸**：选中了壁纸窗口（`index.html?window=wallpaper`）。`main` 的规则是「应用自身页面（:1420、`tauri:` 或
  `tauri.localhost`）且路径不以 `.html` 结尾」；别用 `url:localhost:1420`，它会同时命中壁纸窗口。
- **`click` 是强制点击**：页面上的亀ちゃん吉祥物（`.kamechan-mascot`）是常驻浮层，经常盖住侧栏底部；点不到时检查选择器是否命中隐藏元素。
- **`eval` 查 DOM 少了某些条目**：工具箱里 `整理` / `检查更新` 是自定义 `comp`，渲染在 `.tool-row-comp` 而非 `.tool-row`。
- **截图全白**：页面还在加载；`eval document.readyState` 确认，或稍等后重截。
- **别靠包装 `window.__TAURI_INTERNALS__.invoke` 统计 IPC 调用**：它是不可写、不可配置的属性，赋值静默失败，计数恒为空，会被误读成
  「没有调用」；CEF 下普通 invoke 走 `fetch(ipc://)` 主通道，回退时走 `cef-ipc://` postMessage 桥，抓网络请求看不全。要观测调用次数 /
  顺序，用 `cocs/debug/DEBUG_INGEST.md` 的 debug ingest 插桩（前端 `sendDebugEvent`），本 skill 只负责驱动 UI。
- **下载行为**：原来的 playwright 连接会下发 `Browser.setDownloadBehavior`，把页面触发的下载截走、且断开后仍残留，CEF 的
  `CefDownloadHandler` 收不到。kabegame-dev 插件不发 `Browser.setDownloadBehavior`、不开全局 auto-attach，**预期不再劫持桌面 CEF 的
  下载，但未实测**；测 WebView 插件的页面自发下载前先实测一次，再改这条。
- **Android WebView 连过 CDP 之后，页面附件下载（含 http 的 `Content-Disposition: attachment`）都不再触发 `setDownloadListener` 的
  `onDownloadStart`**，WebView 照样发了请求、服务端看得到 GET，且改回 `default` 也无效（和 playwright 无关）。测页面自发下载必须先
  强制停止应用、全程不连 CDP，由人在手机上点，靠 logcat / debug ingest 被动观察。
- **安全**：调试端口一开，本机任意进程都能完全控制该 browser（读 cookie、执行任意 JS）。所以只在 **dev** 注入、端口**随机**、
  **发布包默认不监听**；要在 dev 下关掉就 `KABEGAME_CEF_DEBUG_PORT=0`，别把这个 env 写进 shell profile。app 侧还有
  `--remote-allow-origins=*`（Chromium 111+ 要求 CDP WebSocket 握手带白名单 origin，否则 403），仅在端口确实开启时追加。
  REST 只接受回环地址的请求，带 `Origin` 时只认 localhost / 127.0.0.1 / [::1]，`Host` 也只认这几个（防 DNS 重绑定）。
- **`cef-example` 不走这条路径**：它在 `examples/cef-example.rs` 里有自己独立的 `Settings`，改 `runtime.rs` 不影响它，也没法拿它验证 CDP。

## 相关

- `.cursor/rules/debug-empirically.mdc` —— 调试要跑真东西，lint 证明不了运行时行为。
- `cocs/debug/DEBUG_INGEST.md` —— 另一条调试路子：前端 / Rust 插桩事件汇总到 NDJSON，与本 skill 共用 `scripts/vite-debug-server.ts`
  这个 vite 侧通道（CDP 端口寄存）。
- `.claude/plans/tools/kabegame-chromium-lib.md` —— 本套工具的设计与实施记录。
- `src-tauri/tauri-runtime-kbcef/README.md` —— CEF backend 架构。
