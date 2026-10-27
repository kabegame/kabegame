---
name: kabegame-chromium
description: 连上跑起来的 kabegame app（桌面 CEF，或经 adb 连 Android dev 包的系统 WebView）做截图与 UI 自动化(CDP)。当需要 screenshot / 看看界面长什么样 / 验证 UI 改动在真实 app 里的效果 / 点击元素 / 在页面里执行 JS / 检查前端运行时状态时使用，安卓上看界面 / 跑 JS 加 --android。区别于 dev:frontend 纯前端预览——这里连的是带完整 Tauri IPC 与真实数据的 app。本 skill 不启动 dev，需用户自己先跑起来。
---

# kabegame-chromium

让 agent 真正"看到"并操作跑起来的 kabegame app——桌面端（CEF）与 Android dev 包
（系统 WebView，见下文「Android」）共用同一套 `cdp.mjs`。

kabegame 桌面端跑在自建 CEF runtime（`src-tauri/tauri-runtime-cef/`）上，本质是
Chromium，所以支持 **CDP（Chrome DevTools Protocol）**。dev 下调试端口默认开启且
**端口随机**，app 起来后把实际端口 POST 给 vite dev server，本 skill 只认死端口
**1420** 去要号，再用 `playwright-core` 的 `connectOverCDP` 连上去截图 / 执行 JS /
点击。

```
deno task dev -c kabegame          用户自己跑（能看到编译进度）
        │
        ├── vite            :1420           ← skill 只认这个死端口
        └── app (CEF)       :<random>       ← 起来后 POST /__kabegame_cdp/register
                                              把号寄存到 vite（内存 + 落盘）
skill ── GET :1420/__kabegame_cdp → 拿到 <random> → connectOverCDP
     └── 要不到 / 号不应答 → lsof 扫 kabegame 进程的监听端口 → 探 /json/version
```

**发现有两条独立的路**，因为 vite 中转会断：登记原本只是 vite 进程内的内存态，
而改 `vite.config.ts`（或它 import 的任何本地文件，比如 `scripts/vite-debug-server.ts`）
都会让 vite restart 并清空它——app 还活着却永远查不到号。现在内存态**同时落盘**到
`.kabegame/debug/cdp-port.json`，vite 重启后读回；再加一条完全不依赖 vite 的
`lsof` 扫描兜底。三条路任意一条通就能用。

**本 skill 不管 dev 的生命周期**。以前它代跑 `deno task dev` 并等就绪，实测很糟：
Rust 冷编译好几分钟、agent 侧看不到任何进度、还会跟用户已有的实例抢 1420 端口。
现在检测不到 dev 就直接让用户自己起——在他自己的终端里编译进度是可见的。

**为什么不用 `deno task dev:frontend` + 无头浏览器**：那条路只有 Vite，没有 Tauri
后端，所有 `invoke`/`listen` 都是 `undefined`，看到的是空数据的空壳；而且
`__ANDROID__`/`__WEB__` 是编译期 define，浏览器里再怎么缩窗也切不出安卓布局——要看安卓
布局就用 `--android` 连真机。

下面路径都相对仓库根（脚本自行 cd，任意子目录可调）。

## 前置

- 用户自己跑着 `deno task dev -c kabegame`（本 skill 不代跑）。
  Android 则是 `deno task dev -c kabegame --mode android`，另需 `adb` 与已授权的设备。
- `node`（≥18，要 `fetch`/`AbortSignal.timeout`）。
- `playwright-core` 已在仓库根 `node_modules`（随 `bun install` 装好）。
  **不需要** `npx playwright install` —— `connectOverCDP` 连的是已有 browser，
  不下载任何浏览器二进制。

## 用法

```bash
S=.claude/skills/kabegame-chromium/driver.sh

$S status                     # dev server / CDP 端口 状态
$S port                       # 打印发现到的 CDP 端口
$S targets                    # 列出所有 page（主窗口/壁纸/crawler/surf）
$S shot /tmp/a.png            # 截图（视口）
$S shot /tmp/a.png --full     # 整页截图
$S eval 'document.title'      # 页面内求值，打印 JSON
$S click '.sidebar-menu-item' # 点击
$S text '.page-header .title' # 取元素文本
```

截图完记得用 Read 真看一眼——空白帧等于没起来。

`status` 的三种结局，对应三种下一步：

| status 输出 | 含义 | 下一步 |
|---|---|---|
| vite `无应答 ❌` + `CDP: 未发现 ❌` | dev 没跑 | 请用户跑 `deno task dev -c kabegame` |
| vite 活着 + `CDP: 未发现 ❌` | app 还没起/还在编译 | 等编译完；或该实例早于本功能，需重启 dev |
| `就绪 ✅` | 可用 | 直接 shot/eval/click |

vite 无应答但 CDP `就绪 ✅` 是**正常且可用**的：只重启了 vite、或直接跑了编好的
dev 二进制时，扫描兜底照样能找到 app。`CDP 登记 : <旧号>（已陈旧…）` 这行也不是
错误，只是说明 vite 上那条记录过期了，已自动回落到扫描。

### 选窗口

kabegame 同时开着多个 CEF 窗口，实测 `targets` 输出：

```
http://localhost:1420/index.html?window=wallpaper    ← 壁纸窗口（排在前面！与主窗口同一个 index.html）
http://localhost:1420/gallery           ← 主窗口（SPA，路径随路由变）
```

不传 `--url` 时走 `isMainWindow()` 启发式：**应用自身页面（:1420、`tauri:` 或 Android 的 `tauri.localhost`）且
路径不以 `.html` 结尾**。别退回成子串匹配——`localhost:1420` 会同时命中壁纸窗口，
而壁纸排在前面，结果就是截到一张全屏壁纸而不是 UI。

要操作别的窗口先 `targets` 看 URL，再用 `--url` 显式指定：

```bash
$S targets
$S shot /tmp/wp.png --url wallpaper
$S shot /tmp/surf.png --url surf
```

`isMainWindow()` 的「路径不以 `.html` 结尾」对壁纸窗口仍成立（路径是 `/index.html`，主窗口是 `/` 或路由路径），
`--url wallpaper` 子串仍能选中它。

**Windows 上壁纸窗口挂到 `WorkerW` 后 CDP 截不到图**：`shot --url wallpaper` 与裸 `Page.captureScreenshot` 都会等帧
超时。这**不是**页面降频——2026-10-26 在页面内直接计时：rAF 稳定 ~144Hz（dev 调试面板 `.debug-panel` 第一行有
MIN / AVG 帧率），fade 过渡 prep → enter 相隔 10ms、提交由 800ms `transitionend` 触发；之前「rAF 约 1s、靠 1400ms
兜底」的记录是用 CDP 轮询类名造成的测量假象。要测壁纸窗口的时序，在页面里装 `MutationObserver` / `performance.now()`
记时间线，再一次性读出，不要靠多次 eval 推算。验证壁纸窗口改用 `eval --url wallpaper`
读 DOM（`img.base` 的 `naturalWidth`、`<video>` 的 `paused` / `volume` / `playbackRate`、dev 调试面板 `.debug-panel`
的文字）。另外 playwright 的 `connectOverCDP` 会 attach 全部 page，任一窗口忙（如本机在跑 cargo）都会让
所有命令握手超时；此时可直连单个 page 的 `webSocketDebuggerUrl`（`/json/list`）发 `Runtime.evaluate`。

## Android（`--android`）

Android 不用 CEF，但系统 WebView 本身就是 Chromium：Tauri 在 `devtools: true`
（`tauri.conf.json.handlebars` 里是 `{{isDev}}`）时由 wry 调
`WebView.setWebContentsDebuggingEnabled(true)`，WebView 便在设备上监听 abstract unix
socket `@webview_devtools_remote_<pid>`（`chrome://inspect` 走的也是它）。
`adb forward` 到本机端口后就是**真正的 CDP 端点**，不是模拟——`cdp.mjs` 原样可用。

```
deno task dev -c kabegame --mode android     用户自己跑（或手机上直接打开已装的 dev 包）
skill ── adb shell pidof app.kabegame.dev → <pid>
     ├── /proc/net/unix 里确认 @webview_devtools_remote_<pid> 存在
     ├── adb forward --list 有同 socket 的转发且应答 → 复用；否则 adb forward tcp:0 → <port>
     └── connectOverCDP 127.0.0.1:<port>
```

```bash
$S status --android                 # 设备 / pid / socket / 转发端口
$S port --android                   # 打印转发后的本机 CDP 端口
$S shot /tmp/a.png --android        # WebView 截图（物理像素，如 1080x2400）
$S eval 'innerWidth' --android      # 360（CSS 像素，DPR 3）
$S click '.foo' --android
$S screen /tmp/full.png --android   # adb screencap 整屏（含系统栏 / 原生对话框）
```

`--android` 可放在任意位置，也可设 `KABEGAME_ANDROID=1`。

要点：

- **只对 dev 包有效**：默认包名 `app.kabegame.dev`；prod 包 `app.kabegame` 的
  devtools 为 false，没有调试 socket。`KABEGAME_ANDROID_PACKAGE` 可覆盖包名。
- **pid 每次启动都会变**，所以端口不能缓存——驱动每次调用都重新 `pidof` 并核对转发，
  顺手 `adb forward --remove` 指向其它 `webview_devtools_remote_*` 的陈旧条目。
- **主窗口 URL 是 `http://tauri.localhost/...`**（dev 也一样，不是 `:1420`），
  `isMainWindow()` 已认这个 host，不必传 `--url`。
- **CDP 截图只有 WebView 内容**：系统状态栏、原生权限弹窗、通知、Kotlin 侧 UI
  （如 picker）都截不到，要看就用 `screen`。
- **多台设备**时设 `ANDROID_SERIAL`（adb 原生识别）。
- 没有 vite 端口登记这条链路：Android app 不向 vite 上报，一切以 adb 为准。

| 报错 | 处理 |
|---|---|
| `adb 没有可用设备` | `adb devices` 看是否未授权 / 多台设备未设 `ANDROID_SERIAL` |
| `设备上没有在跑的 app.kabegame.dev` | 请用户跑 `deno task dev -c kabegame --mode android` 或手机上打开 dev 包 |
| `没有 WebView 调试 socket` | 装的是 prod 包，或 WebView 还没创建完 |

## 端口是怎么串起来的

改动点分布在四处，排查时按这条链走：

1. `scripts/plugins/component-plugin.ts` — dev（且非 CLI）注入
   `KABEGAME_CEF_DEBUG_PORT=random`。**只在 dev 注入**，build/打包路径不经过这里。
   显式设了这个 env（含 `=0` 关闭）时尊重用户的值。
2. `src-tauri/tauri-runtime-cef/src/runtime.rs` — `remote_debugging_port()` 解析
   `random` → 内核分配空闲回环端口，结果 memoize 在 `OnceLock`（每次重算会让
   `CefSettings` 里 bind 的端口和事后上报的对不上）。command-line hook 用的是
   `remote_debugging_requested()`（纯 env 判断，不分配端口）——它在每个子进程都跑，
   去分配端口有概率抢掉 browser 进程要用的号。
3. `src-tauri/kabegame/src/debug_ingest.rs` — `spawn_cdp_register()` 轮询
   `/json/version` 直到真的应答，**然后**才 POST 给 vite。所以"vite 上有端口"
   等价于"CDP 已就绪"。
4. `scripts/vite-debug-server.ts` — `/__kabegame_cdp/register`（POST 登记）与
   `/__kabegame_cdp`（GET 查询）。登记是进程内内存态**并落盘**到
   `.kabegame/debug/cdp-port.json`（gitignored），GET 时内存为空就读回文件——vite
   restart 会重建 plugin 实例、清空闭包变量，落盘是这条链路唯一跨得过重启的环节。
5. `driver.sh` 的 `discover_port()` — 上面整条链都失灵时的兜底：
   `lsof -a -c kabegame` 列出 app 自己的监听端口，逐个探 `/json/version`。

## Gotchas

- **登记没有撤销机制**。app 退出后 vite 与磁盘上都仍留着旧端口，所以驱动在用之前
  会再探一次 `/json/version`；探不通就回落到扫描，扫不到才报"app 已退出或正在重启"。
- **vite 重启曾经会丢号**（改 `vite.config.ts` 或它 import 的本地文件都会触发
  restart）。落盘 + 扫描兜底之后不再需要重启 app —— 但如果你在排查历史现象，这就是
  "app 明明开着却查不到端口"的根因。注意 `uno.config.ts` **不**触发 restart，它不在
  vite 的 config 依赖里。
- **`cdp_up` 必须校验 `webSocketDebuggerUrl`，不能只看 HTTP 状态码**：vite 的 SPA
  fallback 对任意路径都回 200 text/html，扫到 1420 会被它骗过去。
- **`lsof` 的 `-a` 不能省**：多个选择项默认取**并集**，漏了 `-a` 的
  `lsof -iTCP -sTCP:LISTEN -c kabegame` 会列出本机所有监听端口。
- **随机端口有极小的 TOCTOU 窗口**：探号的 socket 释放后、CEF 真正 bind 前，别的进程
  可能抢先占上。表现为 CDP 起不来，重启 dev 换个号即可。
- **别靠包装 `window.__TAURI_INTERNALS__.invoke` 统计 IPC 调用**：它是不可写、不可配置的属性，
  `eval` 里赋值静默失败，计数恒为空，会被误读成「没有调用」；CEF 下普通 invoke 走 `cef-ipc://`
  postMessage 桥而非 `fetch`，抓网络请求也看不全。要观测调用次数 / 顺序，用
  `cocs/debug/DEBUG_INGEST.md` 的 debug ingest 插桩（前端 `sendDebugEvent`），本 skill 只负责驱动 UI。
- **`click` 默认带 `force: true`**。页面上的亀ちゃん吉祥物（`.kamechan-mascot`）
  是常驻浮层，经常盖住侧栏底部，普通 click 会一直等 actionability 直到超时。
- **不要把 `http://host:port` 直接喂给 `connectOverCDP`**：playwright 会拼成
  `/json/version/`（尾斜杠），Chromium 对此返回 400 并报 "This does not look like
  a DevTools server"。`cdp.mjs` 已改为先 fetch `/json/version` 取
  `webSocketDebuggerUrl` 再连——这是实测踩出来的，别改回去。
- **安全**：调试端口一开，本机任意进程都能完全控制该 browser（读 cookie、执行
  任意 JS）。所以：只在 **dev** 注入、端口**随机**、**发布包默认不监听**。要在 dev
  下关掉就 `KABEGAME_CEF_DEBUG_PORT=0`。别把这个 env 写进 shell profile。
- app 侧还有 `--remote-allow-origins=*`（Chromium 111+ 要求 CDP WebSocket 握手带
  白名单 origin，否则 403），仅在端口确实开启时追加。
- **`cef-example` 不走这条路径**。它在 `examples/cef-example.rs` 里有自己独立的
  `Settings`，改 `runtime.rs` 不影响它，也没法拿它验证 CDP。
- **playwright 连接会劫持页面触发的下载**。`connectOverCDP` 附着时对 browser/context
  下发 `Browser.setDownloadBehavior allowAndName`，导航/链接触发的下载被 CDP 层截走存进
  `playwright-artifacts-*`，**CEF 的 `CefDownloadHandler`（`on_before_download` 等）完全
  收不到**，且断开连接后该行为仍残留在 browser 上——之后不经 CDP 的手动下载也被吞。
  `host.start_download()` 显式触发的下载不受影响。要测试真实下载链路：保持单条连接，
  连接后先对 browser 级 + `Target.getBrowserContexts` 的每个 context 发
  `Browser.setDownloadBehavior {behavior:"default"}` 再触发（参考实测：驱动每次调用都是
  新 playwright 连接，会重新注入劫持，所以"改回 default"和"触发下载"必须在同一连接内完成）。
  **Android WebView 同样会被劫持，且改回 `default` 也无效**：连过 CDP 之后，页面附件下载
  （含 http 的 `Content-Disposition: attachment`）都不再触发 `setDownloadListener` 的
  `onDownloadStart`，WebView 照样发了请求，服务端看得到 GET。测页面自发下载必须先强制停止应用、
  全程不连 CDP，由人在手机上点，靠 logcat / debug ingest 被动观察。

## Troubleshooting

| 症状 | 处理 |
|---|---|
| `没检测到 dev server` | 让用户跑 `deno task dev -c kabegame`，别代跑 |
| `查不到 CDP 端口（vite 上没登记，本机也没扫到）` | app 还在编译；或 dev 实例早于本功能（重启）；或 `=0` 关掉了 |
| `登记的端口不应答，本机也没扫到别的` | app 已退出/热重启中，等它起来 |
| 扫描兜底不生效（Windows） | git bash 里通常没有 `lsof`，此时只剩 vite 中转（内存 + 落盘）这一条路 |
| `没有 URL 含 ...` 的 page | 窗口还没渲染完，或主窗口关了。`targets` 看实际 URL |
| 截图全白 | 页面还在加载；`eval 'document.readyState'` 确认，或 sleep 后重截 |
| `无法加载 playwright-core` | 仓库根跑 `bun install` 恢复依赖 |
| 点击超时 | 目标被浮层遮住；`cdp.mjs` 已 force，若仍失败检查选择器是否命中隐藏元素 |
| `eval` 查 DOM 少了某些条目 | 工具箱里 `整理`/`检查更新` 是自定义 `comp`，渲染在 `.tool-row-comp` 而非 `.tool-row`，选择器要带上 |
| 截到的是全屏壁纸 | 选中了壁纸窗口（`index.html?window=wallpaper`）。别用 `--url localhost:1420`，用默认启发式 |

## 相关

- `.cursor/rules/debug-empirically.mdc` —— 调试要跑真东西，lint 证明不了运行时行为。
- `cocs/debug/DEBUG_INGEST.md` —— 另一条调试路子：前端/Rust 插桩事件汇总到 NDJSON，
  与本 skill 共用 `scripts/vite-debug-server.ts` 这个 vite 侧通道。
- `src-tauri/tauri-runtime-cef/README.md` —— CEF backend 架构。
