# WPE 壁纸兼容 · 第二阶段：Web

> 状态：Phase 1 完成（2026-10-25）；Phase 2 完成（2026-10-26）；Phase 3、4 已实现（2026-10-27，真机回归进行中）；Phase 5 已实现（2026-10-28，真机回归待做）；Phase 6 暂时跳过；Phase 6a 已实现（2026-10-28，真机回归待做）；Phase 7 方案已写（2026-10-28，关键决策待确认）；Phase 8 为实现清单
>
> 上级总纲：[../PLAN.md](../PLAN.md)（阶段路线第 2 行）。第一阶段 Video 已完成初步真机测试。
>
> 本目录文件：
> - `PLAN.md`：本文件，第二阶段计划（总体设计 + Phase 路线 + 实现清单）。
> - [`API.md`](API.md)：Phase 1 的产出，WPE Web 壁纸接口参考、运行环境、兼容矩阵与难点方案（已完成）。
> - [`phase-2-wallpaper-vue.md`](phase-2-wallpaper-vue.md)：Phase 2 点级方案——壁纸窗口 Vue 化、`WallpaperStage` 组件、预览内嵌。
> - [`phase-3-web-import-preview.md`](phase-3-web-import-preview.md)：Phase 3 点级方案——Web 导入、`/wpe` 网页 MIME、CSP、`WallpaperStage` iframe 分支、预览「桌面画布」；文末为关键决策。
> - [`phase-4-file-host-input.md`](phase-4-file-host-input.md)：Phase 4 点级方案——桌面 `file://` 宿主与鼠标转发。
> - [`phase-5-shim-host.md`](phase-5-shim-host.md)：Phase 5 点级方案——运行时垫片、`file:` 来源判定与受限 IPC、拉取 / 推送协议、预览桥。
> - [`phase-6a-file-preview.md`](phase-6a-file-preview.md)：Phase 6a 点级方案——预览 iframe 改走 `file://`，与桌面共用运行时目录拦截。
> - [`phase-7-user-properties.md`](phase-7-user-properties.md)：Phase 7 点级方案——用户属性存储、属性面板、显示条件、本地化、`file` / `directory` 属性。
> - `phase-N-<名称>.md`：其余 Phase 开工前的点级方案（待写）。

## 总体设计思路

WPE 的 Web 壁纸是一个普通网页目录：`project.json` 的 `type` 为 `web`，`file` 指向 `index.html`，页面用相对路径引用
同目录的 js / css / 图片。WPE 用内置 CEF 加载它，并向页面注入一组全局接口：页面在全局定义
`window.wallpaperPropertyListener`，WPE 在加载时和用户改属性时回调 `applyUserProperties`，在全局设置变化时回调
`applyGeneralProperties`（主要是 FPS 上限），暂停时回调 `setPaused`；页面调用 `window.wallpaperRegisterAudioListener`
等注册函数接收音频频谱和系统媒体信息。Kabegame 的壁纸窗口本来就是 CEF，所以第二阶段的本质是**在 Kabegame 里复刻
这套宿主环境**：把页面按原目录加载起来，在页面脚本运行前装好同名接口，再由 Kabegame 充当 WPE 的角色往里推数据。

入库模型完全沿用第一阶段：一个壁纸目录一行，`local_path` 是目录，`type` 是 `x-wpe/web`，`thumbnail_path` 直接引用
作者的 `preview.*`，不复制、不改写用户目录。不同的是 Web 行没有可播放媒体，`compatible_path` 留空；所有页面资源都经
第一阶段已有的目录服务 `/wpe/<imageId>/<rel>` 访问，入口页的相对引用自然落在同一前缀下，目录服务的越界校验就是页面
能读到的文件边界。

**壁纸的渲染只有一份：`WallpaperStage.vue`**。Phase 2 先把壁纸窗口 Vue 化：壁纸窗口与主窗口加载同一个
`index.html`（`?window=wallpaper`），`main.ts` 按窗口种类分发到两套 bootstrap；壁纸窗口的根 `WallpaperWindow.vue`
负责 IPC（设置、当前壁纸、ready 握手、看门狗），渲染交给纯组件 `WallpaperStage`。图库侧的接入点是 `ImageContent`：
它保留缩略图 → 原图的降级链条，只在 `x-wpe/*` 行要以原图形态显示时切到 `WpeWallpaperContent`（取目标、读设置）→
`WallpaperStage`；`ImagePreviewDialog` 再把它放进按主显示器分辨率定尺寸、整体缩放的「桌面画布」里，用户看到的就是
设到桌面上的样子，并且可以交互（桌面窗口挂在 WorkerW 下收不到鼠标，预览里可以）。Video / Web 以及之后的 Scene
（WebGPU）都只在 `WallpaperStage` 里实现一次，桌面、预览、应用背景自动一致。点级方案见
[phase-2-wallpaper-vue.md](phase-2-wallpaper-vue.md)。

页面是第三方代码，必须与 Kabegame 自己的界面隔离。`WallpaperStage` 用**跨源 iframe** 承载 Web 壁纸，`src` 指向本地 HTTP
服务的 `/wpe/<id>/`。HTTP 服务的源（`http://127.0.0.1:<port>`）与应用前端的源不同，页面拿不到父页面 DOM，也拿不到
Tauri IPC（Phase 1 已真机确认）。宿主与页面之间只走 `postMessage`：`WallpaperStage` 内的 `WpeWebHost` 发「属性 / 通用设置 / 暂停 / 音频帧 /
媒体信息」，页面里的垫片把它们翻译成 WPE 的回调。垫片由目录服务在返回 `.html` 时**在 `<head>` 最前面插入一个
`<script>`** 注入，保证先于作者脚本执行，不依赖 CEF 的初始化脚本机制。

接口按「页面能否离开它正常显示」分级实现。属性回调是硬需求：绝大多数 Web 壁纸在 `applyUserProperties` 里才完成初始化，
不推作者默认值就是白屏或缺样式，所以垫片加载后立刻按 `project.json` 的 `general.properties` 推一次作者默认值，
这一步与第一阶段视频的「作者默认值层」同源。通用设置、暂停、目录属性次之。音频可视化和媒体集成需要 Rust 侧新能力
（Windows 回环采集 + FFT、系统媒体会话），放到靠后的Phase；没实现前注册函数存在但永不回调，页面按文档本就要能在
「没有数据」时正常工作。RGB 外设接口只提供空实现，永不触发 `onPluginLoaded`。

用户可调属性是 Web 壁纸体验的核心，但它需要在 Kabegame 里新建一套「逐壁纸设置」：按 `project.json` 渲染属性面板
（类型、顺序、分组、显示条件、本地化），把用户值存在 Kabegame 自己的库里，改动经事件推给正在显示该壁纸的所有宿主。
存储形态和面板位置在 Phase 7 开工前再定。

已知的结构性难点有三个，都留给 Phase 1 调研后再定方案，不在本计划里拍板：
`file` / `directory` 属性按 WPE 约定给页面本地绝对路径、页面自己拼 `file:///`，而 HTTP 源的页面加载不了 `file://`；
本地 HTTP 服务的端口每次启动随机分配，页面的 `localStorage` 随源变化而丢失；
壁纸窗口挂在 WorkerW 下收不到鼠标，WPE 的鼠标交互（视差、悬停控制条）无法直接复现。

## 现状锚点

**a. 导入任务只入库 Video，Web 计入跳过**（`src-tauri/kabegame-core/src/crawler/wpe_import.rs:342`）
```rust
        match &project_result {
            Ok(project) if project.kind == WpeKind::Video => {   // 现状：只有 Video 分支
                if run.params.is_dry_run {
                    // ...
                } else {
                    match import_wpe_video(&task_id, project, run.params.output_album_id.as_deref())
                        .await
                    // ...
            // 现状：其它类型（含 Web）走跳过分支，按类型计数写日志
```

**b. 格式表已有 `x-wpe/web` 占位**（`src-tauri/kabegame-core/src/media/image_type.rs:178`）
```rust
    MediaFormat {
        key: "x-wpe/web",                    // 现状：只占位，没有任何行使用
        mime: "application/x-wpe-project",
        extensions: &[],
        aliases: &[],
        browser_safe: false,
        native_wallpaper_safe: false,
    },
```

**c. 目录服务：入口 307 跳转 + 目录内文件直出**（`src-tauri/kabegame/src/http_server.rs:353`、`:489`）
```rust
async fn handle_wpe_entry(UrlPath(id): UrlPath<String>) -> Response {
    // ... authorize_wpe_row(&id) → read_project(&dir)
    let location = format!("/wpe/{}/{}", encode_relative_path(&id), encode_relative_path(file));
    Redirect::temporary(&location).into_response()   // 现状：跳到入口；视频阶段因 CEF <video> 报错而弃用
}
// ...
        .route("/wpe/{id}/", get(handle_wpe_entry))
        .route("/wpe/{id}/{*rel}", get(handle_wpe_file))   // 现状：按扩展名定 MIME 原样直出，不改写 HTML
```

**d. 本地 HTTP 服务端口每次启动随机**（`src-tauri/kabegame/src/http_server.rs:591`）
```rust
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))   // 现状：端口 0，内核分配
        .await
        .map_err(|e| format!("bind file server failed: {e}"))?;
    // 页面源 http://127.0.0.1:<port> 随之变化，localStorage 跨重启不保留
```

**e. 壁纸窗口只区分「图片 / 视频」，WPE 只认视频**（`apps/kabegame/src/wallpaper.ts:125`）
```ts
function isWpeTarget(target: WallpaperTarget): boolean {
  return (target.type || "").trim().toLowerCase().startsWith("x-wpe/");
}

function isVideoTarget(target: WallpaperTarget): boolean {
  const type = (target.type || "").trim().toLowerCase();
  if (type === "x-wpe/video" || type === "video" || type.startsWith("video/")) return true;
  if (type) return false;          // 现状：x-wpe/web 会落到「图片」分支
  return isVideoPath(target.path);
}
```

**f. CEF 运行时的 IPC 垫片只注入主 frame**（`src-tauri/tauri-runtime-cef/src/ipc.rs:61`）
```rust
    pending.webview_attributes.initialization_scripts.insert(
        0,
        InitializationScript {
            script: POST_MESSAGE_SHIM.to_string(),
            for_main_frame_only: true,     // 现状：子 frame 没有 IPC 入口，跨源 iframe 天然隔离
        },
    );
```
Tauri 自身的 `__TAURI_INTERNALS__` 初始化脚本是否同样只进主 frame、子 frame 直接 POST `cef-ipc://` 会不会被 ACL
拒绝，需要在 Phase 1 真机确认。

**g. 本机 Web 样例**（创意工坊 `796697921`，Slideshow）
- 目录：`index.html` + 20 余个 js / css + `keyframes.html` 等子页面 + `preview.jpg/png/svg`。
- `project.json` 的 `type` 是大写 `"Web"`（`project.rs` 已小写归一）；属性 120 余个，类型分布：
  `bool` 50、`slider` 38、`combo` 11、`color` 7、`group` 7、`text` 7、`file` 1、`directory` 1。
  `group` 与 `text` 是官方文档没列的展示型条目；属性还带 `index`、`order`、`condition`（如
  `"backgroundImageVisible.value"`）、`editable`、`min` / `max`。
- 页面实际用到 `window.wallpaperPropertyListener`、`window.wallpaperRegisterAudioListener`，并且自己带了
  「不在 WPE 里时模拟属性和音频」的回退代码。
- 安装目录的 `defaultprojects` 另有 2 个 web 型。

---

## Phase 路线

| Phase | 内容 | 产出 | 依赖 |
|---|---|---|---|
| Phase 1 | 接口整理（公开资料 + 本机样例 + 运行环境调研） | `API.md` 与兼容矩阵；三个难点的方案建议 | — |
| Phase 2 | 壁纸窗口 Vue 化 | 同 `index.html` 分发；`WallpaperStage`（纯渲染）/ `WallpaperWindow`（IPC 根）；删除 `wallpaper.html` / `wallpaper.ts`；壁纸行为不变 | — |
| Phase 3 | Web 导入 + 预览内嵌 | `x-wpe/web` 入库；`WallpaperStage` 加跨源 iframe 分支；`ImageContent` 对非视频 WPE 行切到 `WpeWallpaperContent`；预览「桌面画布」；`/wpe` 补网页 MIME；CSP `frame-src` 放行本地 HTTP 源 | Phase 2 |
| Phase 4 | 桌面 `file://` 宿主 + 鼠标转发 | CEF 补丁 0004 按浏览器开文件访问；壁纸窗口对网页壁纸主 frame 导航到 `file://` 入口、切走导航回应用页；运行时按壁纸目录拦截 `file:` 请求、`file://` 文档不注入 Tauri 脚本；Windows 桌面鼠标移动 / 左键点击转发 | Phase 3 |
| Phase 5 | 运行时垫片与宿主协议 | all-frames 垫片；`file:` 来源判定 + `wpe-web-capability`；桌面「拉取命令 + `listen` 推送」、预览「`postMessage` ↔ 父页面调命令」；作者默认值与界面语言 | Phase 4 |
| Phase 6 | 桌面窗口收尾（暂时跳过） | FPS 上限、暂停冻结、多显示器、轮播口径 | Phase 5 |
| Phase 6a | 预览 iframe 改 `file://` | 主窗口登记两项文件访问能力（0004 + CEF 补丁 0005）、`set_wpe_web_preview` 设根目录并返回入口、前端给 iframe 赋 `src`、CSP `file:`；预览与桌面同一套 Rust 拦截，`localStorage` 同源；删除 `/wpe` 目录服务 | Phase 5 |
| Phase 7 | 用户属性 | 逐壁纸属性存储与面板、显示条件、本地化、`file` / `directory` 属性（两种宿主都生效） | Phase 6a |
| Phase 8 | 音频可视化与媒体集成 | 系统回环采集 + 频谱、系统媒体会话信息推送 | Phase 6 |
| — | RGB 外设、鼠标交互 | 空实现 / 暂不做（见待定决策） | — |

Phase 2 不涉及 Web 壁纸，但它是后面所有渲染的落点；Phase 3 落地后，Web 壁纸在预览和桌面里都能显示「无属性」状态的页面，用来验证目录服务、MIME 和隔离；Phase 5 再补属性。

---

## Phase 1 — 接口整理

### 目标
把 WPE Web 壁纸的全部宿主接口整理成一份可以直接对照实现的参考 `API.md`，并给每一项标出 Kabegame 的实现优先级。
只整理和调研，不改主仓库代码。

### 资料来源
- 官方文档 `docs.wallpaperengine.io/en/web/`：入门、用户属性、显示条件、属性翻译、音频可视化、媒体集成、
  FPS 上限、RGB 外设（含 iCUE 子页）、调试。
- 本机样例：创意工坊 `796697921` 与 `defaultprojects` 里的 2 个 web 型，看真实页面怎么用这些接口、`project.json`
  里有哪些文档没写的字段。
- 社区资料只作补充，并在 `API.md` 里逐条标注「非官方」，例如音频数组的社区说明、早期论坛帖。
- 需要确认 WPE 自身行为而公开资料没写的点（加载方式、`file://` 访问、`localStorage` 归属），用 REA 对
  `wallpaper64.exe` 静态查证，与第一阶段的视频链路调研同一方法。

### `API.md` 的结构
1. **`project.json` 的 web 相关字段**：`type`、`file`、`preview`、`general.properties`、`general.supportsaudioprocessing`、
   `localization`，以及属性条目的公共字段 `type` / `value` / `text` / `order` / `index` / `condition` / `editable`。
2. **属性类型表**：每种类型的定义字段与推给页面的值格式。

   | 类型 | 定义字段 | 推给页面的值 |
   |---|---|---|
   | `color` | `value` | 空格分隔的 0–1 浮点三元组，如 `"1.0 0.1 0.25"` |
   | `slider` | `min` / `max` / `step` / `precision` / `value` | 数字 |
   | `bool` | `value` | `true` / `false` |
   | `combo` | `options[{label, value}]` / `value` | 选中项的 `value` |
   | `textinput` | `value` | 字符串 |
   | `file` | — | 本地绝对路径，页面自己拼 `file:///` |
   | `directory` | `mode: ondemand / fetchall`、文件类型 | 是否已设置；文件经目录接口单独给 |
   | `group` / `text` | `text` | 只用于面板展示，不推给页面（待核实） |

3. **全局接口清单**（下表为已从官方文档确认的部分，Phase 1 补齐签名、触发时机与边界）：

   | 接口 | 方向 | 要点 |
   |---|---|---|
   | `wallpaperPropertyListener.applyUserProperties(props)` | 宿主 → 页面 | 加载时推一次，之后只推变化的键；值在 `props.<key>.value` |
   | `wallpaperPropertyListener.applyGeneralProperties(props)` | 宿主 → 页面 | 主要字段 `fps`（用户 FPS 上限） |
   | `wallpaperPropertyListener.setPaused(isPaused)` | 宿主 → 页面 | 可选实现；WPE 暂停时本就冻结渲染进程 |
   | `wallpaperPropertyListener.userDirectoryFilesAddedOrChanged(name, files)` | 宿主 → 页面 | `directory` 属性 `fetchall` 模式，`files` 为完整路径列表 |
   | `wallpaperPropertyListener.userDirectoryFilesRemoved(name, files)` | 宿主 → 页面 | 同上 |
   | `wallpaperRequestRandomFileForProperty(key, cb)` | 页面 → 宿主 | `ondemand` 模式，回调 `(propertyName, filePath)` |
   | `wallpaperRegisterAudioListener(cb)` | 页面注册 | 128 个浮点，0–63 左声道、64–127 右声道，低频在前；约 30 次每秒；偶尔超过 1；需 `supportsaudioprocessing` |
   | `wallpaperRegisterMediaStatusListener(cb)` | 页面注册 | `{ enabled }` |
   | `wallpaperRegisterMediaPropertiesListener(cb)` | 页面注册 | `{ title, artist, subTitle?, albumTitle?, albumArtist?, genres?, contentType }` |
   | `wallpaperRegisterMediaThumbnailListener(cb)` | 页面注册 | `{ thumbnail(base64 PNG), primaryColor, secondaryColor, tertiaryColor, textColor, highContrastColor }` |
   | `wallpaperRegisterMediaPlaybackListener(cb)` | 页面注册 | `{ state }`，常量在 `window.wallpaperMediaIntegration`（数值待确认） |
   | `wallpaperRegisterMediaTimelineListener(cb)` | 页面注册 | `{ position, duration }`，部分播放器不提供 |
   | `wallpaperPluginListener.onPluginLoaded(name, version)` | 宿主 → 页面 | `led` / `cue` 插件就绪通知 |
   | `wpPlugins.led.setAllDevicesByImageData(data, w, h)` | 页面 → 宿主 | RGB 外设；Kabegame 只做空实现 |
   | `window.cue.*` | 页面 → 宿主 | iCUE SDK 子集；Kabegame 只做空实现 |

4. **运行环境约定**：WPE 用什么 URL 加载页面（`file://` 还是自定义协议）、是否放开 `file://` 跨文件访问、
   `localStorage` 的归属与持久化、允许的视频格式（官方只保证 WebM / Ogg）、音频自动播放、鼠标与键盘输入转发、
   暂停时的行为、多显示器下是否每屏一个实例。
5. **兼容矩阵**：每个接口一行，列出 Kabegame 的优先级（P0 不实现就白屏 / P1 常用 / P2 少用 / 空实现 / 不做）、
   落在哪个Phase、实现方式一句话。
6. **难点的方案建议**：给出 `file://` 路径、`localStorage` 源、鼠标输入三个问题各自的可选方案与推荐，交给用户决策。

### Phase 1 需要真机确认的点（不改代码，用 CDP 在运行中的 app 里试）
- 跨源 iframe 里 `window.__TAURI_INTERNALS__` 是否不存在；子 frame 直接 `fetch("cef-ipc://…")` 是否被拒绝。
- iframe 加载 `/wpe/<id>/` 时 307 跳转是否正常（视频的 Format error 只出现在 `<video>`）。
- 本机 Slideshow 样例在 iframe 里不推任何属性时的表现，用来评估「作者默认值」的必要性。

**结论（2026-10-25，详见 [API.md 第五节](API.md)）**：前两项已验证；第三项**未验证**，原因是库里没有 `x-wpe/web` 行，
而且 `/wpe` 对 `.html` 返回 `application/octet-stream`，入口页无法在 iframe 里渲染，留到 Phase 3 补 MIME 后再测。
Phase 1 还发现了 8 处与本计划设计冲突或缺失的地方，列在 [API.md 第八节](API.md)，Phase 3 / 4 / 6 开工前要先处理。

### Phase 1 不做
- 不写任何主仓库代码，不改 `wpe-import` 任务。
- 不追 WPE 编辑器专属接口（编辑器预览、属性自动探测写回 `project.json` 等）。

---

## Phase 2 起的实现清单

以下按 Phase 列出要做的事，粒度到「点」；每个 Phase 开工前另写 `phase-N-<名称>.md`，补现状代码块与目标代码块。

### Phase 2 — 壁纸窗口 Vue 化
点级方案见 [phase-2-wallpaper-vue.md](phase-2-wallpaper-vue.md)。要点：
- Rust：壁纸窗口改加载 `index.html?window=wallpaper`；抽出 `build_wallpaper_target` 供后续按 id 取目标复用。
- 前端入口：`main.ts` 按 `?window=` 动态导入 `bootstrap/app.ts` 或 `bootstrap/wallpaper.ts`；删除 `wallpaper.html` /
  `wallpaper.ts` 与 rollup 第二入口。
- `WallpaperStage.vue`（纯渲染：双层过渡、tile、WPE 视频属性、音量 / 倍速、`paused` / `interactive`，可嵌入任意容器）
  与 `WallpaperWindow.vue`（IPC 根：设置、当前壁纸、ready 握手、看门狗、dev 面板）。
- 不改任何壁纸业务行为；图库侧不动（WPE 视频的预览 / 背景继续走普通视频链路，保留 seek）；回归覆盖壁纸窗口全部既有功能。

### Phase 3 — Web 导入 + 预览内嵌
点级方案见 [phase-3-web-import-preview.md](phase-3-web-import-preview.md)（接入点原始定义在 [phase-2-wallpaper-vue.md](phase-2-wallpaper-vue.md) 末尾）；方案末尾列有 7 条关键决策待确认。
- **修改**（`WallpaperStage.vue`、`http_server.rs`、`tauri.conf.json`）
  - `WallpaperStage` 新增 Web 分支：跨源 iframe 加载 `/wpe/<id>/`，切走即销毁；过渡沿用双层机制。
- **新增**（预览内嵌）
  - 命令 `get_wallpaper_target_for_image(imageId)`（复用 `build_wallpaper_target`，ACL 补白名单）。
  - `ImageContent` 新增 `wallpaper` 模式：非视频 WPE 行（web / scene）的原图形态渲染 `WpeWallpaperContent`
    （取目标、读 `settingsStore`）→ `WallpaperStage`；`x-wpe/video` 继续走 `<video>` 链，`VideoControls` / seek 不变。
  - `ImagePreviewDialog` 对非视频 WPE 行外包 `WallpaperDesktopCanvas`（主显示器分辨率 + 缩放，可交互），不挂
    `VideoControls`；应用背景层自动受益。
  - `/wpe` 目录服务补网页资源 MIME（html / js / css / json / svg / 字体 / wasm 等）。
  - CSP `frame-src` 增加 `http://127.0.0.1:*`（现状只有 `'self' blob: data: about:`，dev 下 Tauri 不注入 CSP 所以 Phase 1
    实测没撞上，prod 会拦）。
- **修改**（导入，`crawler/wpe_import.rs`、`commands/wpe.rs`、`wpe/scan.rs`）
  - 导入分派增加 `WpeKind::Web` 分支 `import_wpe_web`：`type = x-wpe/web`，`thumbnail_path` 引用作者预览，
    `compatible_path` 留空，`hash` / `size` 取入口 html，宽高留空，`metadata` 存 `project.json` 原文，
    `tags` 挂 `WPE/<tag>`；已入库行幂等，只补画册成员。
  - `WpeSourceInfo` 增加 `web` 计数，`pending` 口径改为「Kabegame 已支持的类型且未导入」。
- **修改**（前端）
  - `WallpaperImportDialog.vue`：统计 chip 增加「网页」数量，汇总文案按已支持类型计算。
  - `mediaMime.ts`：`wpeKind` 识别 `web`。
  - `ImageContent.vue`：`x-wpe/web` 在网格里与视频一样只显示预览图。
  - `ImageBasicInfoPanel.vue`：类型显示「Wallpaper Engine · 网页」。
- **修改**（审计）
  - 第一阶段为 `x-wpe/video` 加过的分流点逐个确认对 `x-wpe/web` 同样成立：删除护栏、整理跳过、虚拟盘隐藏、
    原生壁纸拒绝、拖出 / 复制禁用。

### Phase 4 — 桌面 `file://` 宿主 + 鼠标转发
点级方案见 [phase-4-file-host-input.md](phase-4-file-host-input.md)。要点：
- CEF 补丁 0004（已写、已编译）：建窗 `extra_info` 的 `kabegame.allow_file_access_from_file_urls` 按浏览器打开文件访问偏好。
- 运行时：按 label 登记「允许 `file://` 文档」的窗口与当前允许根目录；`file:` 资源请求越界取消；`file://` 文档不注入初始化脚本；
  公开鼠标注入 API。
- 应用：Rust 侧 `WpeWebHost` 是壁纸窗口导航的唯一属主——当前壁纸是 `x-wpe/web` 就导航到 `file://` 入口，否则导航回应用页；
  `WallpaperWindow.vue` 对网页壁纸不再渲染 iframe。图库预览仍用 Phase 3 的 HTTP iframe。
- Windows 鼠标转发：照 WPE 轮询光标与左键，移动始终转发、点击只在落在桌面图标层时转发。
- 删除 `DEBUG-WPE-FILE` / `DEBUG-WPE-INPUT` 临时代码。

### Phase 5 — 运行时垫片与宿主协议
> 状态：已实现（2026-10-28），真机回归见 `versions/latest/regression.md`。

点级方案见 [phase-5-shim-host.md](phase-5-shim-host.md)（2026-10-27 按已确认决策 10 重写，2026-10-28 两次修订）。要点：
- 垫片 `webview_js/wpe_shim.js` 以 `initialization_script_for_all_frames` 注入壁纸窗口与主窗口，按地址自判启用。
  传输只有 `pull` / `listen` 两个原语：桌面直接 `invoke("wpe_web_pull_state")` 与 `listen`；预览 iframe 都 `postMessage` 给宿主页，
  宿主页调 `get_wpe_web_state`，并用 `useTauriProxy()` 代为 listen（`kbEvent$` 合并成一条管道转发）。宿主不主动推送。
- 重拉触发：`setting-change` 的 `language`；本张图片的 `metadataId` 补丁（metadata 按 id 不可变，属性一改就换 id）。
  load 后首次全量投递；之后用户属性按键差异、通用属性整份；首次投递后页面换 listener 时补投全量；乱序按垫片的拉取编号丢弃。
- 运行时把 `file:` frame 的 IPC `Origin` 改写成 frame URL（否则回退到应用页、被当成本地来源拿到全部权限），
  并删除 Phase 4 的「`file:` 文档不注入初始化脚本」规则。
- 新增 `wpe-web-capability`（壁纸窗口 + 远程 `file:///*`）：只开 `wpe_web_pull_state` 与事件 `listen` / `unlisten`。
- Tauri 不在导航时清 JS 事件监听：补丁 0011 加 `clear_js_listeners()`，`WallpaperWindow` 每次导航成功后调用。
- 状态 `{ imageId, user, general: { language } }` 只在 Rust 侧计算；`fps`、暂停留给 Phase 6。

### Phase 6 — 桌面窗口收尾
- **修改**（`kabegame/src/wallpaper/rotator.rs`、`commands/wallpaper.rs`）
  - 确认 `x-wpe/web` 只在窗口模式可用（Phase 3 起壁纸本体已能显示 Web，轮播口径在此复核）；
    壁纸目标对 Web 行返回 `wpeWeb`（作者默认值层）。
- **修改**（`apps/kabegame/src/wallpaper.ts`）
  - `applyGeneralProperties({ fps })` 取 Kabegame 的壁纸帧率设置（没有就新增一项全局设置，走 settings 架构）。
  - `setPaused`：沿用壁纸窗口现有的暂停条件（窗口被遮挡、全屏应用、省电等，以 Phase 6 开工时的实现为准）。
- **新增**
  - 多显示器：每个壁纸窗口各一个 iframe，属性变更广播到全部宿主。

### Phase 6a — 预览 iframe 改 `file://`
> 状态：已实现（2026-10-28），真机回归见 `versions/latest/regression.md`。

点级方案见 [phase-6a-file-preview.md](phase-6a-file-preview.md)。HTTP 页面引用 `file:` 在渲染进程就被拦、Rust 侧无钩子，
所以预览也改成 `file:` 文档：主窗口 `allow_file_documents("main")`，预览挂载 / 卸载经 `set_wpe_web_preview` 设 / 清根目录，
垫片按「非顶层 `file:`」判定预览，桥 `postMessage` 用 `"*"`。IPC 三道闸门不受 scheme 影响。真机证实应用页给子 frame 赋
`file:` 的 `src` 同样被 `CanDisplay` 拦下（浏览器侧还有 `FilterURL` 改写成 `about:blank#blocked`）；改为 CEF 补丁 0005
（主窗口建窗前 `allow_app_local_resources("main")`，渲染侧 `GrantLoadLocalResources`、浏览器侧 `GrantRequestScheme(file)`），
该命令设好根目录后返回入口、前端赋 `src`；`WallpaperTarget.webEntry` 随之删除（见 phase-6a「实施记录」，含已撤掉的
浏览器进程导航绕行）。
`/wpe` HTTP 目录服务整个删除（Web 版不提供网页壁纸，应用 Web 服务器也不需要）。同时落实决策 11：WPE 只提供 Windows 桌面，
其它平台对 `x-wpe/*` 只显示预览图。

### Phase 7 — 用户属性
> 状态：方案已写（2026-10-28），关键决策待确认。Phase 6 暂时跳过，本 Phase 依赖 Phase 6a。

点级方案见 [phase-7-user-properties.md](phase-7-user-properties.md)。面板不复刻 WPE 属性页，用 Kabegame 自己的表单组件（用户指定）。要点：
- 用户值存图片 metadata 顶层 `userProperties`（已确认决策 6），只存与作者默认值不同的键。
  core 新增事务原语 `Storage::rewrite_image_metadata`：新行 + 改指 + 删无引用旧行，搜索词沿用旧行。写后发 `image-changed { metadataId }`。
- core `wpe::user_props` 解析一次属性定义，三处共用：写命令校验、面板视图（已本地化）、页面状态（作者默认值 ⊕ 用户值）。
- 命令 `get_wpe_web_properties` / `set_wpe_web_user_properties`，只给主窗口。
- 面板：
  - 字段复用 `KbNumber`（补 float `step`）、`KbSelect`、`KbBoolean`、`KbText`、`KbPath`，新增 `KbColor`；
  - 显示条件照 WPE 自己的白名单解释器（`$parse.readOnly`，API.md 第一节）实现，不 eval、失败当 true；标签 HTML 按 ngSanitize 默认白名单净化（去掉链接与图片）；
  - 本地化照 WPE 的查找顺序，WPE 内置词表从用户的 WPE 安装目录只读读取；
  - 草稿即时生效，写入 300ms 防抖、串行。
- 入口：预览右栏（`x-wpe/web` 行替换插件详情）、设置页「当前壁纸」。
- `file` / `directory`：桌面与预览都生效（Phase 6a 之后两者同一套拦截）。
  - 运行时 `file:` 策略加「追加放行」，拉取状态时按调用方 label 放行用户选的路径；
  - 目录文件列表进状态，垫片实现 `userDirectoryFiles*` 与 `wallpaperRequestRandomFileForProperty`。
- 不做：视频行的属性面板（`get_current_wallpaper_target` 不改）、紧凑布局、目录监视。

### Phase 8 — 音频可视化与媒体集成
- **新增**（后端，Windows 优先）
  - 系统音频回环采集（WASAPI loopback）→ 每声道 64 段频谱、约 30 次每秒；只在当前壁纸声明了
    `supportsaudioprocessing` 时启动，切走或暂停即停止。
  - 系统媒体会话（`GlobalSystemMediaTransportControlsSessionManager`）：标题 / 艺人 / 封面 / 播放状态 / 进度，
    变化时推送；封面主色由 Kabegame 计算。
  - 数据经 Tauri 事件推到壁纸窗口，再由 `WpeWebHost` 转给 iframe。
- **新增**（设置）
  - 「媒体集成」开关，对应页面收到的 `{ enabled }`。
- **不做**：Linux / macOS 的音频与媒体集成（WPE 本身不支持这些平台），注册函数照常存在、永不回调。

---

## 已确认决策（2026-10-25）

1. **目录结构**：`wpe-import/` 是总纲，每个阶段一个子目录；第二阶段在 `wpe-import/2-web/`；Phase 1 只做接口整理，产出 `API.md`；实现按Phase推进。
2. **入库模型沿用第一阶段**：目录即一行，`type = x-wpe/web`，作者预览原样作缩略图，不复制、不改写用户目录。
3. **预览内嵌壁纸本体**（2026-10-25，10-26 细化）：壁纸渲染只有一份 `WallpaperStage`；`ImageContent` 对**非视频**
   WPE 行（web / scene）的原图形态切到它，`ImagePreviewDialog` 外包桌面比例画布并缩放，可交互；Web 壁纸在
   `WallpaperStage` 里以跨源 iframe 加载。**WPE 视频除外**：图库里按普通视频对待（`compatible_path` + `<video>`），
   保留 `VideoControls` 与 seek，只有桌面壁纸窗口用 `WallpaperStage` 播它。
4. **Scene 走 WebGPU**（2026-10-25）：第三阶段在 `WallpaperStage` 里用 WebGPU canvas 渲染，预览自然复用。
5. **壁纸窗口 Vue 化**（2026-10-26）：壁纸窗口与主窗口同一个 `index.html`，按 `?window=wallpaper` 分发 bootstrap，
   不再有独立的 `wallpaper.html` / `wallpaper.ts`。

6. **用户属性即元数据**（2026-10-26）：用户可调属性存在图片的 `metadata` JSON 里（与 `project.json` 同一份），不另建表、
   不进 settings。写入入口是 WPE 定制详情面板；保存走元数据不可变语义——新建 metadata 行、图片改指新 `metadata_id`、发
   `image-changed { metadataId }` 补丁；各宿主收到补丁重取目标，再**模拟 WPE 的属性变化事件**（只含变化键的
   `applyUserProperties`）推给页面，不新增 Kabegame 事件类型。详见 phase-3 文档关键决策第 8 条。
7. **Phase 3 关键决策全部按推荐项执行**（2026-10-26）：页面源先 HTTP 后迁自定义协议 **`kb-wpe`**（2026-10-28 追记：Phase 6a 起预览也走 `file:` iframe、与桌面同源，`kb-wpe` 不再需要，HTTP 目录服务已删除）；`file` / `directory` 属性
   本 Phase 不支持；背景层退回缩略图；web 层不参与双层过渡；加 `sandbox`；IPC 主 frame / 白名单源校验纳入 Phase 3。

8. **桌面网页壁纸走 `file://` 主 frame**（2026-10-27）：用户确认安全面可接受。壁纸窗口显示 `x-wpe/web` 时主 frame 直接导航到
   壁纸目录的入口 `file://`，与 WPE 进程模型一致；文件访问由 CEF 补丁 0004 只对壁纸窗口开启，越界读取由运行时按壁纸目录拦截。
   图库预览仍用 HTTP 跨源 iframe（2026-10-28 追记：Phase 6a 起预览也改 `file:` iframe，见 [phase-6a-file-preview.md](phase-6a-file-preview.md)）。先导实验与补丁依据见 [API.md §5.2](API.md)。
9. **桌面鼠标转发第一版只做移动 + 左键**（2026-10-27）：照 WPE 的轮询方式，不装键盘钩子，不转发滚轮。
10. **宿主协议不照搬 WPE，自己用 Tauri 实现**（2026-10-27）：
    - 桌面壁纸窗口的 `file://` 页面允许注入 Tauri IPC，但只给受限权限（`wpe-web-capability`），推送用 Tauri `listen`；
    - 预览 iframe 用 `postMessage` 向主 frame（应用页）拉取，由应用页调用 Tauri 命令；订阅也 `postMessage` 登记，由应用页代为 listen 并转发（2026-10-28）；
    - `listen` 没有事件名作用域，壁纸页面因此能订阅应用全局事件，用户确认这是可接受的取舍，也算开放给壁纸的一项能力。
    - 依据与 WPE 的对照见 [API.md §4.8](API.md)，方案见 [phase-5-shim-host.md](phase-5-shim-host.md)。
11. **WPE 目前只提供 Windows 桌面**（2026-10-28）：发现 / 导入（`platform_supported` 收窄到 Windows）、桌面 `file://` 宿主、预览 `file:` iframe
    全部按 `target_os = "windows"` 门控；macOS / Linux / Android / Web 对 `x-wpe/*` 行只显示预览图。`/wpe` HTTP 目录服务随 Phase 6a 删除。
    落地见 [phase-6a-file-preview.md](phase-6a-file-preview.md) 点 5c。

## 待定决策（需用户确认）

1. ~~宿主形态~~：已由决策 3 确定。
2. ~~**垫片注入方式**~~ 已定（2026-10-27）：用 Tauri `initialization_script_for_all_frames`，桌面壁纸窗口与主窗口（预览 iframe）同一份垫片、按 `location` 自判是否启用；不改写 HTML 响应。桌面 `file:` 文档照常注入 Tauri 脚本，权限由 ACL 按远程 `file:` 来源限制（已确认决策 10）。细节见 Phase 5 方案。
3. ~~**`file` / `directory` 属性**~~ 已定路线（2026-10-26，phase-3 决策 2）：Phase 3 不支持；Phase 7 前先测本地 scheme，再测 `file://`。原文：WPE 约定页面自己拼 `file:///`，HTTP 源的页面读不了本地文件。Phase 1 调研后在
   「CEF 放开 `file://` 并改用 `file://` 加载页面」「垫片改写路径到白名单路由」「暂不支持这两类属性」之间选。
4. ~~**`localStorage` 持久化**~~ 已定（2026-10-26）：自定义协议 `kb-wpe`，Phase 5 落地；所有网页壁纸共用一个稳定源。
   2026-10-28 追记：Phase 6a 把预览也改成 `file:` 源后与桌面同源，`kb-wpe` 不再需要。
5. ~~**用户属性存储**~~ 已定（2026-10-26）：见已确认决策 6。
6. ~~**桌面鼠标交互**~~ 已定（2026-10-27）：见已确认决策 9，Phase 4 实现。
7. **Phase 8 是否纳入第二阶段**：音频与媒体集成成本最高、Rust 侧全新，可以推到 Scene 之后。

## 待验证

- [x] Tauri 初始化脚本在 CEF 子 frame 中的注入范围：跨源 iframe 里 `__TAURI_INTERNALS__` / `__TAURI__` / `window.ipc`
  都不存在。子 frame POST `cef-ipc://` **会被 CEF 转交给 Tauri**（返回 204），但不带 invoke key 的消息会被静默丢弃，
  子 frame 拿不到 invoke key。门槛是 invoke key，不是 ACL。建议加 frame / Origin 校验作纵深防御，见 API.md 第八节第 4 条。
- [x] iframe 跟随 `/wpe/<id>/` 的 307：正常，Format error 只发生在 `<video>` 元素上。
- [x] `wallpaperMediaIntegration` 常量：`PLAYBACK_STOPPED: 0`、`PLAYBACK_PLAYING: 1`、`PLAYBACK_PAUSED: 2`（REA 注入脚本原文）。
- [ ] `group` / `text` 条目是否会出现在推给页面的 `applyUserProperties` 里：未确认，需要 WPE 真机抓取。
- [ ] Slideshow 样例不推属性时的表现：未验证，等 Phase 3 补 MIME 后再测。

## 资料来源

- [Web Wallpaper Reference Guide](https://docs.wallpaperengine.io/en/web/overview.html)
- [wallpaperPropertyListener 参考](https://docs.wallpaperengine.io/en/web/api/propertylistener.html)
- [User Properties](https://docs.wallpaperengine.io/en/web/customization/properties.html)
- [Audio Visualization](https://docs.wallpaperengine.io/en/web/audio/visualizer.html)
- [Media Integration](https://docs.wallpaperengine.io/en/web/audio/media.html)
- [RGB Hardware Support](https://docs.wallpaperengine.io/en/web/api/rgb.html)
