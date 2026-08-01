---
name: kabegame-chromium
description: 连上跑起来的 kabegame 桌面 app 做截图与 UI 自动化(CDP)。当需要 screenshot / 看看界面长什么样 / 验证 UI 改动在真实 app 里的效果 / 点击元素 / 在页面里执行 JS / 检查前端运行时状态时使用。区别于 dev:frontend 纯前端预览——这里连的是带完整 Tauri IPC 与真实数据的 app。本 skill 不启动 dev，需用户自己先跑起来。
---

# kabegame-chromium

让 agent 真正"看到"并操作跑起来的 kabegame 桌面 app。

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
                                              把号寄存到 vite
skill ── GET :1420/__kabegame_cdp → 拿到 <random> → connectOverCDP
```

**本 skill 不管 dev 的生命周期**。以前它代跑 `deno task dev` 并等就绪，实测很糟：
Rust 冷编译好几分钟、agent 侧看不到任何进度、还会跟用户已有的实例抢 1420 端口。
现在检测不到 dev 就直接让用户自己起——在他自己的终端里编译进度是可见的。

**为什么不用 `deno task dev:frontend` + 无头浏览器**：那条路只有 Vite，没有 Tauri
后端，所有 `invoke`/`listen` 都是 `undefined`，看到的是空数据的空壳；而且
`__ANDROID__`/`__WEB__` 是编译期 define，浏览器里再怎么缩窗也切不出安卓布局。

下面路径都相对仓库根 `/Volumes/KIOXIA/kabegame`（脚本自行 cd，任意子目录可调）。

## 前置

- 用户自己跑着 `deno task dev -c kabegame`（本 skill 不代跑）。
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
| `无应答 ❌` | dev 没跑 | 请用户跑 `deno task dev -c kabegame` |
| `CDP: 未登记 ❌` | dev 在跑但 app 还没上报 | 等编译/启动完；或该实例早于本功能，需重启 dev |
| `就绪 ✅` | 可用 | 直接 shot/eval/click |

### 选窗口

kabegame 同时开着多个 CEF 窗口，实测 `targets` 输出：

```
http://localhost:1420/wallpaper.html    ← 壁纸窗口（排在前面！）
http://localhost:1420/gallery           ← 主窗口（SPA，路径随路由变）
```

不传 `--url` 时走 `isMainWindow()` 启发式：**应用自身页面（:1420 或 `tauri:`）且
路径不以 `.html` 结尾**。别退回成子串匹配——`localhost:1420` 会同时命中壁纸窗口，
而壁纸排在前面，结果就是截到一张全屏壁纸而不是 UI。

要操作别的窗口先 `targets` 看 URL，再用 `--url` 显式指定：

```bash
$S targets
$S shot /tmp/wp.png --url wallpaper
$S shot /tmp/surf.png --url surf
```

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
   `/__kabegame_cdp`（GET 查询）。登记是**进程内内存态**，vite 重启即清空。

## Gotchas

- **登记是内存态，且没有撤销**。app 退出后 vite 上仍留着旧端口，所以驱动在用之前
  会再探一次 `/json/version`；探不通就报"app 已退出或正在重启"，别以为是发现机制坏了。
- **vite 重启会清空登记**（改 vite config、`__REBOOT__` 开关等）。此时 app 还活着但
  vite 上没号 → 重启 app 侧（或整个 dev）重新上报。
- **随机端口有极小的 TOCTOU 窗口**：探号的 socket 释放后、CEF 真正 bind 前，别的进程
  可能抢先占上。表现为 CDP 起不来，重启 dev 换个号即可。
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

## Troubleshooting

| 症状 | 处理 |
|---|---|
| `没检测到 dev server` | 让用户跑 `deno task dev -c kabegame`，别代跑 |
| `没有 app 上报 CDP 端口` | app 还在编译；或 dev 实例早于本功能（重启）；或 `=0` 关掉了 |
| `登记的端口不应答` | app 已退出/热重启中，等它起来 |
| `没有 URL 含 ...` 的 page | 窗口还没渲染完，或主窗口关了。`targets` 看实际 URL |
| 截图全白 | 页面还在加载；`eval 'document.readyState'` 确认，或 sleep 后重截 |
| `无法加载 playwright-core` | 仓库根跑 `bun install` 恢复依赖 |
| 点击超时 | 目标被浮层遮住；`cdp.mjs` 已 force，若仍失败检查选择器是否命中隐藏元素 |
| `eval` 查 DOM 少了某些条目 | 工具箱里 `整理`/`检查更新` 是自定义 `comp`，渲染在 `.tool-row-comp` 而非 `.tool-row`，选择器要带上 |
| 截到的是全屏壁纸 | 选中了 `wallpaper.html`。别用 `--url localhost:1420`，用默认启发式 |

## 相关

- `.cursor/rules/debug-empirically.mdc` —— 调试要跑真东西，lint 证明不了运行时行为。
- `cocs/debug/DEBUG_INGEST.md` —— 另一条调试路子：前端/Rust 插桩事件汇总到 NDJSON，
  与本 skill 共用 `scripts/vite-debug-server.ts` 这个 vite 侧通道。
- `src-tauri/tauri-runtime-cef/README.md` —— CEF backend 架构。
