# WPE Web 壁纸接口参考与兼容矩阵（Phase 1 产出）

> 状态：Phase 1 完成（2026-10-25）。上级：[PLAN.md](PLAN.md)。
>
> 来源标记：
> - **[官方]**：`docs.wallpaperengine.io/en/web/` 原文。
> - **[样例]**：本机 WPE 目录里的真实壁纸，只读。
> - **[REA]**：对 WE 2.8.42 二进制的静态查证。
>   - `bin/webwallpaper64.exe`：SHA-256 `51173dab…6d9d`，链接 CEF `146.0.11+g3a0fcf1`（Chromium 146.0.7680.179）。
>   - `wallpaper64.exe`：主程序。
> - **[实测]**：2026-10-25 在运行中的 Kabegame dev 上经 CDP 实测。Kabegame CEF 报告为 Chrome 149。
> - **[非官方]**：社区资料，附链接。
>
> 本机样例：
> - 创意工坊 `796697921`，即 Slideshow，`D:\Applications\Steam\steamapps\workshop\content\431960\796697921`。
> - 官方默认项目 `corsair_collection`、`corsair_o_tron`，位于 `…\wallpaper_engine\projects\defaultprojects\`。

---

## 一、`project.json` 中与 Web 相关的字段

| 字段 | 说明 | 来源 |
|---|---|---|
| `type` | `"web"`；样例里也有大写 `"Web"`，需小写归一 | [官方] localization 示例；[样例] 796697921 |
| `file` | 入口 html，相对壁纸目录 | [官方] localization 示例；[样例] 全部 |
| `preview` | 预览图 | [样例] |
| `general.properties` | 用户属性表，键是属性 key，见第二节 | [官方] localization 示例；[样例] |
| `general.supportsaudioprocessing` | `true` 时 WPE 才发送音频数据；编辑器检测到注册了音频监听后自动写入 | [官方] visualizer；[样例] 796697921、corsair_o_tron |
| `general.localization` | `{ "<语言码>": { "ui_xxx": "文案" } }`，语言码如 `en-us`、`de-de`、`zh-chs`，完整列表在 WPE 安装目录的 `locale/` | [官方] localization |
| `workshopid` / `workshopurl` / `tags` / `contentrating` / `ratingsex` / `ratingviolence` / `visibility` / `approved` / `version` | 创意工坊元数据，与第一阶段一致 | [样例] 796697921 |
| `official` | 官方默认项目才有 | [样例] corsair_* |

**属性条目的公共字段**

| 字段 | 说明 | 来源 |
|---|---|---|
| `type` | 属性类型，见下表 | [官方]；[样例] |
| `value` | 作者默认值 | [官方]；[样例] |
| `text` | 面板标签；以 `ui_` 开头时按 `localization` 翻译；可含 HTML，如 `<br><small>` | [官方] localization；[样例] 796697921 |
| `order` | 面板排序 | [官方] localization 示例；[样例] |
| `index` | 编辑器内部序号，样例中与 `order` 同时出现 | [样例] 796697921 |
| `condition` | 显示条件，是 **JavaScript 表达式**，见下文 | [官方] displaycondition；[样例] |
| `editable` | 滑块是否显示数值输入框 | [样例] 796697921 有 38 处，corsair_* 有 3 处 |
| `min` / `max` | 滑块范围 | [样例] |
| `options` | combo 选项数组 `[{ "label": "...", "value": "..." }]`；样例里也出现过没有 `label`、只有 `value` 的项 | [官方] localization 示例；[样例] corsair_collection |
| `mode` | directory 属性的模式：`ondemand` 或 `fetchall` | [官方] properties；[样例] 796697921 的 `customdirectory` |
| `fileType` | file / directory 属性的文件类型，由编辑器写入 | [REA] 字符串 `fileType`、`directory`、`ondemand`、`fetchall` 相邻；样例未出现 |

**显示条件 `condition`**

- [官方] 原文是 "a JavaScript-compatible if condition"，示例为 `showclock.value == true`。
- [样例] 实际写法比文档复杂，包括：
  - `effect.value.endsWith('pulse') === true && pulseanimation.value !== 'static'`
  - `effect.value.startsWith('rainbow') === false`
  - `showbottom.value > 0`
  - 裸真值 `backgroundImageVisible.value`
- 也就是说，条件里会用到字符串方法、`===` / `!==` / `>`、`&&`，以及直接引用其它属性的 `.value`。

**滑块精度**：[官方] 编辑器里有 Fraction 与 Precision（默认 2）选项，但文档没给 JSON 字段名。本机样例都是整数滑块，没有出现 `step` / `precision` / `fraction` 字段。**未确认**。

## 二、属性类型

| 类型 | 推给页面的值 | 面板行为 | 来源 |
|---|---|---|---|
| `color` | 空格分隔的 0–1 浮点三元组，如 `"1.0 0.1 0.25"`；页面自己乘 255 | 取色器 | [官方] properties |
| `slider` | 数字 | `min` / `max`，`editable` 显示输入框 | [官方]；[样例] |
| `bool` | `true` / `false` | 复选框 | [官方] |
| `combo` | `.value` 为选中项的 value，`.text` 为标签（官方建议只用 value） | 下拉 | [官方] |
| `textinput` | 字符串 | 文本框 | [官方] |
| `file` | 本地绝对路径；页面自己拼 `'file:///' + value` | 文件选择，按 `fileType` 过滤 | [官方] |
| `directory` | `.value` 表示是否已设置；文件经目录接口单独给，见第三节 | 文件夹选择，`mode` 决定交付方式 | [官方] |
| `group` | 不推（未确认） | 分组标题 | [样例] 796697921 有 7 个，文档未写 |
| `text` | 不推（未确认） | 纯说明文字，`text` 可含 HTML | [样例] 796697921 有 7 个，文档未写 |

- 可选文件类型：
  - 图片：`.jpeg .jpg .png .bmp .gif .svg .webp`，文档还写了 `.pnga`。
  - 视频：`.webm .ogg .ogv`。[官方] properties
- Web 壁纸里的视频官方只保证 WebM / Ogg / OGV。[官方] overview

## 三、全局接口清单

所有接口挂在页面的 `window` 上。WPE 用一段注入脚本提供它们，那段脚本在页面脚本之前执行（[REA] 见第四节）。

### 3.1 宿主回调：`window.wallpaperPropertyListener`

页面必须在全局、任何事件之外定义该对象，否则会漏掉加载时的首批推送。[官方] propertylistener

| 回调 | 签名 | 触发时机 | 边界 | 来源 |
|---|---|---|---|---|
| `applyUserProperties` | `(properties) => void`，`properties = { [key]: { value, text?, ... } }` | 加载时推一次，之后用户改属性时推 | **只含值变化的键**，页面逐键判断存在性 | [官方] |
| `applyGeneralProperties` | `(properties) => void` | 加载时推一次，之后 WPE 全局设置变化时推 | 已确认有 `fps`（数字，0 应视为不限）；[REA] 同一处还引用 `language`、`steamlanguage`，推测也推界面语言（**未确认**） | [官方] fps；[REA] |
| `setPaused` | `(isPaused: boolean) => void` | 暂停 / 恢复时 | 可选；WPE 暂停时本就冻结页面的计时与动画，见 4.4 | [官方]；[REA] |
| `userDirectoryFilesAddedOrChanged` | `(propertyName: string, changedFiles: string[]) => void` | directory 属性在 `fetchall` 模式下，文件新增或修改时 | 列表是**完整本地路径**，页面拼 `file:///`；WPE 会监视目录变化（[REA] `FindFirstChangeNotification`） | [官方]；[REA] |
| `userDirectoryFilesRemoved` | `(propertyName: string, removedFiles: string[]) => void` | 同上，文件删除时 | 同上 | [官方] |

### 3.2 页面主动调用

| 接口 | 签名 | 说明 | 来源 |
|---|---|---|---|
| `wallpaperRequestRandomFileForProperty` | `(propertyKey: string, cb: (propertyName, filePath) => void)` | directory 属性在 `ondemand` 模式下随机取一个文件；页面可以按定时器反复调用 | [官方] properties |
| `wallpaperRegisterAudioListener` | `(cb: (audio: number[]) => void)` | 只调用一次，不要放在 `onload` 里；数据规格见下 | [官方] visualizer |
| `wallpaperRegisterMediaStatusListener` | `(cb: ({ enabled: boolean }) => void)` | 用户在 WPE 设置里开关媒体集成时 | [官方] media |
| `wallpaperRegisterMediaPropertiesListener` | `(cb: ({ title, artist, subTitle?, albumTitle?, albumArtist?, genres?, contentType }) => void)` | `genres` 是逗号分隔的字符串；`contentType` 为 `music` / `video` / `image` | [官方] media |
| `wallpaperRegisterMediaThumbnailListener` | `(cb: ({ thumbnail, primaryColor, secondaryColor, tertiaryColor, textColor, highContrastColor }) => void)` | `thumbnail` 可直接赋给 `img.src`。[REA] 主程序拼的前缀是 `data:image/png;base64,`，即完整 data URL。`highContrastColor` 为黑或白 | [官方]；[REA] wallpaper64.exe |
| `wallpaperRegisterMediaPlaybackListener` | `(cb: ({ state: number }) => void)` | 常量见下 | [官方]；[REA] |
| `wallpaperRegisterMediaTimelineListener` | `(cb: ({ position, duration }) => void)` | 单位为秒；部分播放器不提供，页面要能接受永不回调 | [官方] |

- **音频数据**：[官方] visualizer
  - 固定 128 个浮点。0–63 为左声道，64–127 为右声道，每个声道内低频在前。
  - 值大致在 0–1，偶尔超过 1。约 30 次每秒。
  - 只有 `supportsaudioprocessing: true` 时才发送。
  - [样例] 796697921 还会把 `NaN` / `Infinity` 置 0，宿主最好不要发出这类值。
- **媒体播放常量**：[REA] 注入脚本原文为
  ```js
  window.wallpaperMediaIntegration = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };
  ```
  官方文档另有一处写成 `window.wallpaperMediaIntegration.playback.PLAYING`，二进制里没有这种写法，以 REA 为准。
- **注册函数是否可重复调用**：音频监听早期只保存一个回调，重复注册会覆盖，论坛称后来已修复。[非官方] [Steam 讨论](https://steamcommunity.com/app/431960/discussions/1/312265589446469530)。垫片按「可多次注册、全部回调」实现即可兼容两种写法。

### 3.3 RGB 外设

| 接口 | 说明 | 来源 |
|---|---|---|
| `window.wallpaperPluginListener.onPluginLoaded(name, version)` | 页面定义；`name` 为 `'led'`（通用）或 `'cue'`（iCUE）。[REA] WPE 在 `window` 的 `load` 之后调用 | [官方] rgb；[REA] |
| `window.wpPlugins.led.setAllDevicesByImageData(encodedImageData, width, height)` | RGB 字节串，建议 100×20 | [官方] rgb |
| `window.cue.getProtocolDetails(cb)` / `getDeviceCount(cb)` / `getDeviceInfo(index, cb)` / `getLedPositionsByDeviceIndex(cb)` / `setLedsColorsAsync(leds)` / `setAllLedsColorsAsync(deviceIndexOrArray, color)` / `setLedColorsByImageData(deviceIndexOrArray, data, w, h)` | iCUE SDK 子集 | [官方] icue；[样例] corsair_o_tron 调用 `getDeviceCount` / `getDeviceInfo` / `setAllLedsColorsAsync` |

### 3.4 文档未写、二进制里存在的接口

| 接口 | 推测用途 | 来源 |
|---|---|---|
| `wallpaperGetUtilities` | 未知的工具对象 | [REA] 与注册函数同列 |
| `wallpaperOnVideoEnded` | WPE 把单个视频文件当网页播放时，视频结束的回调 | [REA] 注入的 `v.onended = … window.wallpaperOnVideoEnded()` |
| `wallpaperRequestTakeScreenshotResponse` / `window.__wpxTakeSnapshot` | WPE 给壁纸截图，页面回传 JPEG 字节 | [REA] 注入脚本 |
| `window.___wpxShared.onLoad(fn)` | WPE 内部的「load 之后执行」队列，用来推插件就绪 | [REA] |

这些接口没有公开文档，页面不应依赖。垫片只把 `wallpaperGetUtilities` 定义成空对象，其余不提供。

## 四、运行环境约定

### 4.1 进程与加载方式
- [REA] 主程序为每个 Web 壁纸起独立进程 `bin/webwallpaper64.exe`。启动参数有：
  - `-parenthwnd <hwnd>`：CEF 窗口作为子窗口挂到壁纸宿主窗口。
  - `-cacheId <id>`
  - `-cefcommandline <用户自定义>`：对应 `config.json` 的 `cefcommandline`。
  - `-halfresolution`、`-screensaver`、`-hideCursor`、`-loglevel`
- **页面以 `file://` 加载**。依据有两条：
  - [官方] 要求页面给用户文件路径拼 `file:///`。
  - [REA] 资源拦截函数 `FUN_140016950` 只处理 `file:` 开头的请求。
  - 编辑器调试页（`localhost:<CEF devtools port>`）列出的也是「文件」。[官方] debug
  - 进程参数里没有直接看到入口 URL 字符串，属于强推断。
- [REA] 拦截函数的逻辑：
  1. 先拦截已知挖矿脚本：`coinhive.com`、`arc.io/widget`。
  2. 对 `file:` 请求去掉 `?` 之后的部分，URL 解码。
  3. 查两张白名单，命中就放行。一张是按路径哈希的集合，一张是精确路径列表。结合同一可执行文件里目录监视与 `fileType` / `fetchall` 字符串，推断两张表分别存 directory 属性展开的文件和 file 属性的值。
  4. 否则必须满足三个条件，不满足就记 `Deny request: '%s' is not inside project directory %s.` 等日志并拒绝：
     - 位于项目目录内；
     - 不是符号链接；
     - 是普通文件。
- [REA] Chromium 开关：
  - `disable-web-security`、`disable-site-isolation-trials`；`disable-features` 包含 `IsolateOrigins,site-per-process,HardwareMediaKeyHandling,WebContentsOcclusion,CalculateNativeWinOcclusion…`。
  - `autoplay-policy=no-user-gesture-required`：页面不需要用户手势就能自动播放带声音的媒体。
  - `disable-background-timer-throttling`、`disable-backgrounding-occluded-windows`、`disable-background-media-suspend`、`disable-renderer-backgrounding`：被遮挡也不降频。
  - `disable-gpu-shader-disk-cache`、`force-device-scale-factor`、`high-dpi-support`、`disable-extensions`、`disable-plugins-discovery` 等。
  - 自定义的 `wpx-no-auto-focus`、`wpxex-is-screensaver`。
- 结论：WPE 页面跑在**关掉同源策略的 `file://` 环境**里，跨域 `fetch` 不受限。页面能读到项目目录和用户属性指定的本地文件，其它本地文件被拦截器拒绝。

### 4.2 `localStorage` 归属
- [REA] + 磁盘：CEF 缓存目录是 `<WPE>/ui/wpcache/<cacheId>/`。本机实际只有 `monitor0/`，其中有 `Default/Local Storage/leveldb/`。所以 **cacheId 按显示器划分，不按壁纸**。
- 同一显示器上的所有 Web 壁纸共用一个 profile，又都是 `file://` 源，**`localStorage` 是共享的**。不同显示器之间隔离。
- 本机三个样例都没有使用 `localStorage` / `sessionStorage` / `indexedDB`。[样例]

### 4.3 多屏
- [REA] 每个显示器一个 `webwallpaper64.exe` 实例，各自的 `-parenthwnd` 和 `-cacheId`，例如 `monitor0`。

### 4.4 暂停
- [REA] WPE 注入了一段运行时脚本（全局标记 `___STAHP`），暂停时调用 `window.___wpxPause()`，恢复时调用 `window.___wpxUnpause()`，然后才回调页面的 `setPaused`。
- 暂停的实现方式：
  - 包装 `requestAnimationFrame` / `setInterval` / `setTimeout`：暂停期间新回调进队列，每类最多 1000 个，恢复时补发。
  - 给所有带 CSS 动画的元素设 `animation-play-state: paused`，伪元素用注入的 class 处理。
  - 暂停正在播放的 `<video>` / `<audio>`。
  - 包装 `AudioContext` 构造器以登记全部实例，暂停时 `suspend()`。
- 官方说的「WPE fully freezes the process」与此一致：页面不需要自己处理暂停。

### 4.5 鼠标与键盘
- [样例] 页面确实依赖鼠标：
  - 796697921 在鼠标靠近屏幕边缘时显示控制条（`mousemove`），控制按钮用 `click`。
  - corsair_collection 有 `mousemove` / `click` / `keydown`，`pulseanimation` 里还有一个选项叫 `mousespeed`。
- [非官方] WPE 开发者在论坛说，点击是「检查光标下的窗口后转发给壁纸浏览器」实现的；滚轮和按键出于安全考虑不转发。[Steam 讨论 1](https://steamcommunity.com/app/431960/discussions/1/135513901706643121)、[Steam 讨论 2](https://steamcommunity.com/app/431960/discussions/2/1736588252406358010)
- [REA] 在 `webwallpaper64.exe` 里没有找到鼠标转发相关的字符串。主程序有 `ui_browse_properties_mouse_parallax` 等 Scene 用的鼠标字符串。转发的具体实现**未定位**，这是有限否定，只覆盖已定义字符串。

### 4.6 兼容补丁
- [磁盘] + [REA] WPE 自带 `assets/zcompat/web/<workshopid>.json`，本机有 5 个。内容是对指定壁纸的 js 文件做 `replace` → `insert` 的文本替换，例如给 `texImage2D` 调用加空值判断。
- [REA] 有日志 `Failed writing compat fix at %S`，说明 **WPE 会把补丁写回壁纸目录**。Kabegame 不能这样做，只能在 `/wpe` 响应里按同一份规则在内存中替换。

### 4.7 视频属性对 Web 的作用
- [REA] 同一可执行文件里有：
  - `document.documentElement.style.filter = 'contrast(…) brightness(…) saturate(…) hue-rotate(…deg)'`，对应 `wec_*`；
  - `document.documentElement.style.transform = 'scaleX(-1)'`，对应 `alignmentfliph`。
- 说明第一阶段的颜色调整与水平翻转这组标准属性，对 Web 壁纸也以 CSS 作用在 `<html>` 上。是否在面板里出现、默认值如何，**未确认**。

## 五、Kabegame 实测（2026-10-25，dev，主窗口内临时 iframe 指向 `/wpe/12091/`，测后已移除）

| 项 | 结果 | 结论 |
|---|---|---|
| iframe 跟随 `/wpe/<id>/` 的 307 | 跳到 `/wpe/12091/Wallpaper%2D1%2Emp4` 并正常加载（视频文档） | 307 对 iframe 文档加载**正常**，Format error 只发生在 `<video>` 元素上 |
| 父页面访问 iframe DOM | `SecurityError` | 跨源隔离生效 |
| iframe 内 `__TAURI_INTERNALS__` / `__TAURI__` / `window.ipc` | 都是 `undefined` | Tauri 初始化脚本与 CEF IPC 垫片都只进主 frame |
| iframe 内 `fetch('cef-ipc://localhost/', POST)` | **返回 204** | CEF 的 `cef-ipc` scheme 处理器不区分 frame，子 frame 的请求也会交给 Tauri |
| 子 frame 伪造的 IPC 消息（不带 invoke key，回调 id 取自主 frame） | 主 frame 的成功和失败回调**都没触发** | 被 Tauri 静默丢弃；同一条消息从主 frame 发出也被丢弃，而正常 `invoke` 成功、回调通路正常。所以**实际门槛是 invoke key**，子 frame 拿不到它 |
| iframe 内相对 `fetch('./project.json')` | 200，但 `Content-Type: application/octet-stream` | 目录服务的 MIME 只来自媒体格式表；**`.html` / `.js` / `.css` / `.json` 都不会给正确 MIME** |
| `../` 越界 | 404 | 越界校验生效 |
| iframe 内 `localStorage` | 可用，源为 `http://127.0.0.1:33050` | 端口随机，源随启动变化 |
| iframe 内加载 `file:///C:/Windows/...jpg` | 失败 | HTTP 源的页面读不了 `file://`，与预期一致 |

### 5.1 `file://` 直开窗口实测（2026-10-27，dev，临时命令 `debug_wpe_open_file_window` 开普通 CEF 窗口，`WebviewUrl::External(file:///…/index.html)`）

动机：WPE 自己就是以 `file://` 加载页面（§4.1），验证 Kabegame 不经本地 HTTP 服务、按 WPE 原样加载能走多远。Tauri 与 CEF 运行时都不拦 `file` 协议，窗口能开、标题正确。

| 项 | Slideshow `796697921` | Kaguya `3679122549`（混淆脚本、重媒体） |
|---|---|---|
| 页面渲染 | 正常：播放列表面板 + 「Use the settings panel…」提示（未推属性的状态） | 只有外壳：时钟、播放器 UI；主区域一直 `Loading...`，封面图裂、`<video>` / `<audio>` 无 src |
| `<script>` / `<link>` 相对子资源经 `file://` | 17 个脚本全部执行，`wallpaperPropertyListener` 已定义（5 个回调） | `script.js` 执行，`wallpaperPropertyListener` 已定义（`applyUserProperties` / `applyGeneralProperties`） |
| 页面 `fetch` / XHR 读同目录文件 | `./project.json` → `Failed to fetch` / XHR error | `fetch("data.json")` → `Failed to fetch`，这正是它卡在 `Loading...` 的原因（歌单、封面、MV、字幕全从 `data.json` 解析） |
| `localStorage` | 可用，源为 `file://` | 同左（kaguya 用了 4 处 `localStorage`） |
| `__TAURI_INTERNALS__` | **存在**（初始化脚本仍注入到 `file://` 主 frame） | 同左 |
| `invoke` | 被拒：`Origin header is not a valid URL`（`file://` 页面的 Origin 是 `null`，`cef-ipc` 入口直接拒绝） | 同左 |

结论：
- Chromium 把每个 `file://` 文档当作独立的不透明源，**标签式子资源能加载，`fetch` / XHR 一律失败**。WPE 靠 `--disable-web-security` 绕过（§4.1）。Kabegame 若走 `file://` 路线，必须给 CEF 加 `allow-file-access-from-files` 或关同源策略，而命令行开关是全进程生效的，会同时作用于主界面与畅游窗口，安全面不可接受。
- `file://` 源的 `localStorage` 跨重启稳定且与端口无关，但所有壁纸共用一个 `file://` 源（WPE 也是如此，按显示器隔离）。
- `file://` 主 frame 会拿到 Tauri 初始化脚本（含 `__TAURI_INTERNALS__`），虽然 `invoke` 被 Origin 校验挡住，但壁纸页面不该看到这些对象；HTTP + 跨源 iframe 路线天然没有这个问题。
- 因此 **Phase 3 维持 HTTP `/wpe/<id>/` + 跨源 iframe 路线**：同源 `fetch` / XHR 自然可用，kaguya 这类依赖 `fetch` 的壁纸才跑得起来。`localStorage` 稳定性另行解决（固定端口或固定主机名的自定义协议，见 §7 难点二）。
- 临时命令带 `DEBUG-WPE-FILE` 注释（`commands/window.rs`、`lib.rs`、`permissions/main.toml`），验证完删除。

> **更新（2026-10-27，用户决定安全面可接受，改走 `file://` 主 frame 路线）**：上面的「维持 HTTP 路线」结论作废。

### 5.2 单窗口同源开关可行性与先导实验（2026-10-27）

**能否按窗口控制**：可以，但要给 CEF 打补丁。
- `web_security_enabled` / `allow_file_access_from_file_urls` / `allow_universal_access_from_file_urls` 在 Chromium 里是**每个 WebContents 一份**的
  `WebPreferences`，命令行开关只决定默认值。
- CEF 每次计算偏好都走 `ChromeContentBrowserClientCef::OverrideWebPreferences`（`libcef/browser/chrome/chrome_content_browser_client_cef.cc`），
  其中 `CefBrowserHostBase::GetBrowserForContents(web_contents)` 按浏览器拿到 `browser`，`browser->browser_info()->extra_info()`
  可读到建窗时传入的字典（运行时已用 `extra_info` 传初始化脚本，见 `tauri-runtime-cef/src/subprocess.rs`）。
- CEF 的 `cef_browser_settings_t` 不含这三项（只认全局命令行，`renderer_prefs.cc` 的 `SetDefaultPrefs`）。所以需要补丁 0004：在
  `OverrideWebPreferences` 里读 `extra_info` 标记并打开文件访问偏好。不改公开 API 结构，不需要重新生成 capi / cef-rs 绑定，但要重编 CEF。

**先导实验**：dev 下临时全局追加 `--allow-file-access-from-files`（即上述偏好的全局来源，`runtime.rs` 带 `DEBUG-WPE-FILE`），
重开 kaguya 的 `file://` 窗口：

| 项 | 结果 |
|---|---|
| `fetch("data.json")` | 200，27 首歌 |
| 页面渲染 | 完整：背景、封面、歌词字幕、播放器、时钟；`music/Remember.flac` 自动播放中 |
| `fetch('../796697921/project.json')`（别的壁纸目录） | 200 |
| `fetch('file:///C:/Windows/win.ini')` | **200，可读到任意本地文件** |
| `fetch('https://example.com/')` | `Failed to fetch`（跨源 http 仍受 CORS 约束） |

结论：
- **只开 `allow_file_access_from_file_urls` 就足以让依赖 `fetch` 的网页壁纸跑起来**，0004 补丁的偏好部分只需这一项。
- 打开后页面能读任意本地文件，**必须照 WPE 做资源拦截**（§4.1 的 `FUN_140016950`）：对开启了该标记的浏览器，在
  `ResourceRequestHandler::on_before_resource_load`（运行时已实现该钩子，`webview.rs`）里取消所有不在当前壁纸目录内的 `file:` 请求，
  并拒绝符号链接与非普通文件；`file` / `directory` 用户属性的白名单留到 Phase 7。
- 跨源 http 请求仍被 CORS 拦。WPE 是全局 `--disable-web-security`；Kabegame 若要支持，需要在补丁里另改网络服务的
  `URLLoaderFactoryParams.disable_web_security`（Chromium 侧，当前读全局命令行），**第一版不做**，记入已知边界。

## 六、兼容矩阵

优先级定义：
- **P0**：不实现大多数壁纸白屏或缺初始化。
- **P1**：常用。
- **P2**：少用。
- **空实现**：定义接口但永不回调。
- **不做**：不提供。

| 接口 / 能力 | 优先级 | Phase | 实现方式 |
|---|---|---|---|
| 垫片先于页面脚本执行 | P0 | 3 | 目录服务在 html 的 `<head>` 最前插 `<script>`，脚本同源同步加载 |
| 目录服务给 web 资源正确 MIME | P0 | 2 | `/wpe` 增加 web 扩展名表：html、js、mjs、css、json、svg、woff/woff2/ttf/otf、wasm、webm、ogg/ogv、mp3、wav 等 |
| `applyUserProperties` 首推作者默认值 | P0 | 3 | 垫片握手后宿主推 `{ key: { value } }` 全量；combo 带 `text` |
| `applyUserProperties` 增量推送 | P1 | 5 | 用户改属性后只推变化的键 |
| `applyGeneralProperties({ fps })` | P1 | 3（值）/ 4（设置） | 首推一次；没有对应设置时推 0（不限） |
| `applyGeneralProperties` 的 `language` | P2 | 3 | 推 Kabegame 当前语言，换算成 WPE 语言码（未确认字段名，先不推也可） |
| `setPaused` + 冻结计时 / 动画 / 媒体 | P1 | 3（垫片）/ 4（触发） | 垫片照搬 WPE 的 `___wpxPause` 思路；宿主按壁纸窗口的暂停条件发消息 |
| `localization` 文案 | P1 | 5 | 面板按 Kabegame 语言映射到 WPE 语言码，缺失回退 `en-us`，再回退原文 |
| `condition` 显隐 | P1 | 5 | 必须能求值 JS 表达式（见冲突 1） |
| `file` 属性 | P2 | 5 | 见难点一 |
| `directory` 属性：`fetchall` / `ondemand` | P2 | 5 | 见难点一；`fetchall` 需要宿主监视目录并推增删 |
| `wallpaperRegisterAudioListener` | P1 | 6 | WASAPI 回环 + FFT，128 浮点、约 30Hz、`NaN` 置 0；未实现前空实现 |
| 媒体集成 5 个注册函数 | P2 | 6 | 系统媒体会话；`thumbnail` 用 `data:image/png;base64,` 前缀；未实现前空实现 |
| `wallpaperMediaIntegration` 常量 | P1 | 3 | 垫片直接定义 `{ PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 }` |
| `wallpaperPluginListener` / `wpPlugins.led` / `window.cue` | 空实现 | 3 | 不调用 `onPluginLoaded`；`wpPlugins`、`cue` 不定义，页面按文档会先检查插件已加载 |
| `wallpaperGetUtilities` | 空实现 | 3 | 空对象 |
| `wallpaperOnVideoEnded` / 截图接口 | 不做 | — | WPE 内部用 |
| 自动播放带声音的媒体 | P1 | 4 | iframe 加 `allow="autoplay"`，并确认壁纸窗口的 CEF 自动播放策略 |
| 背景不降频 | P1 | 4 | 壁纸窗口本就常驻；预览场景不需要 |
| 跨域 `fetch`（关同源策略） | P2 | — | 不复刻 `disable-web-security`；页面访问外网 API 依赖对方的 CORS。见冲突 3 |
| `localStorage` 持久化 | P2 | 4 | 见难点二 |
| 鼠标交互 | P2 | — | 见难点三 |
| 兼容补丁 `zcompat/web` | P2 | 3 | 读 WPE 安装目录里的规则，在 `/wpe` 响应体中替换，不写盘 |
| 颜色调整 / 翻转作用于 `<html>` | P2 | 4 | 复用第一阶段的 `wec_*` / `alignmentfliph` 换算，由宿主经垫片设 `documentElement.style` |
| 挖矿脚本拦截 | P2 | 3 | 目录服务不涉及外网；如需对齐，可由 CEF 请求拦截屏蔽 `coinhive.com` / `arc.io/widget` |

## 七、三个难点：可选方案与推荐

推荐只是建议，最终由用户决定。

### 难点一：`file` / `directory` 属性的 `file:///` 路径

WPE 给页面的是本地绝对路径，页面自己拼 `file:///` 交给 `<img>`、CSS `url()` 或 `fetch`。HTTP 源的页面加载 `file://` 会失败（[实测]）。

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 页面改用 `file://` 加载 | 壁纸 iframe 直接指向 `file:///<壁纸目录>/index.html`，CEF 放开 `allow-file-access-from-files`，同时用请求拦截复刻 WPE 的白名单（项目目录 + 属性路径） | 与 WPE 环境逐字节一致，页面零改动 | 要在 `tauri-runtime-cef` 里加 `file:` 请求拦截和 per-browser 白名单；`file://` 源和应用源的隔离、主窗口预览能否加载 `file://` 子 frame 都要重新论证；垫片注入要换成 CEF 初始化脚本或拦截改写 |
| B. CEF 层把 `file:` 请求改道 | 页面仍走 HTTP 源，但在 CEF `GetResourceHandler` 里对**来自 `/wpe` 页面的** `file:///<白名单路径>` 请求，由 Kabegame 读文件返回 | 页面零改动，HTTP 源与隔离模型不变 | 跨源（HTTP 页面加载 `file:`）在 Chromium 渲染进程里可能在发请求前就被拦，需要实测；拦截器要能识别请求方 frame 的源 |
| C. 垫片改写路径 | 宿主给页面的路径换成 `http://127.0.0.1:<port>/wpe-user/<token>/<文件>`；垫片再拦截 `HTMLImageElement.src`、`style.backgroundImage` 等 setter，把 `file:///http://…` 修正回来 | 不碰 CEF | 页面拼接方式五花八门，样例里还有 `fixFilename` 之类的自定义处理，拦截覆盖不全，属于脆弱方案 |
| D. 暂不支持 | 面板里这两类属性显示「暂不支持」，页面收到空值 | 零成本 | 依赖用户图片的壁纸不可用，例如样例 796697921 就是「从文件夹播放图片」 |

**推荐**：Phase 7 前先做一个最小实测验证 B。若 Chromium 在渲染侧就拦掉 HTTP 页面对 `file:` 的请求，则在 A 和 D 之间选。A 改动面大但最贴近 WPE，适合把 file / directory 当成重要能力时选。

### 难点二：`localStorage` 源随端口变化

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 固定端口 | 本地 HTTP 服务优先绑定固定端口，被占用时回退随机 | 改动最小，所有壁纸共享一个源，与 WPE「同屏共享」接近 | 端口冲突时回退会丢数据；固定端口更容易被本机其它程序探测 |
| B. 每个壁纸独立源 | 例如 `http://<imageId>.wpe.localhost:<port>/`，Chromium 把 `*.localhost` 解析到回环 | 壁纸之间隔离，比 WPE 更干净 | 端口仍随机时问题没解决，要配合 A；目录服务要按 Host 分发 |
| C. 宿主代管存储 | 垫片用自己实现的 `localStorage` 替身，读写经 postMessage 交给宿主，存在 Kabegame 库里，按壁纸 id 隔离 | 不依赖端口与源，可以按壁纸清理 | `localStorage` 是同步 API，替身要在页面脚本前预载全部数据；`indexedDB` 等无法覆盖 |
| D. 接受不持久 | 不处理 | 零成本 | 依赖本地存储的壁纸每次重启丢状态 |

**推荐**：A（固定端口 + 冲突回退）。本机三个样例都没用 `localStorage`，需求强度低。若以后要隔离，再叠加 B。

### 难点三：鼠标交互

壁纸窗口挂在 WorkerW 下，桌面图标层在上面，页面收不到鼠标事件。

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 不做 | 记入已知边界 | 零成本 | 视差、悬停控制条、点击交互失效，例如 796697921 的边缘控制条 |
| B. 全局鼠标钩子转发 | 主进程装低级鼠标钩子或 Raw Input；光标位于桌面空白处（命中 WorkerW / 桌面列表视图背景）时，把坐标经 CEF `SendMouseMoveEvent` / `SendMouseClickEvent` 发给壁纸 browser。只转发移动和点击，不转发滚轮和按键，与 WPE 一致 | 与 WPE 行为一致 | 需要判断「点在图标上还是空白处」；CEF 窗口模式下合成事件的可行性要实测；有安全与性能顾虑 |
| C. 只转发移动 | B 的子集，只发 `mousemove` | 能覆盖视差和悬停显示，风险最小 | 点击仍不可用 |

**推荐**：第二阶段先 A，并在 Phase 6 末尾留一个 C 的可行性实测。B 作为后续增强。

## 八、与 PLAN 设计的冲突与缺口

1. **显示条件必须求值 JS**。PLAN 的 Phase 7 写的是「只支持 `<key>.value` 比较与逻辑运算，不 `eval` 任意 JS」。实际样例用了 `.endsWith()` / `.startsWith()` / `!==` / `>`。建议改为在沙箱里求值，例如只注入各属性 `{ value }` 的 `new Function` 加超时，或者在 iframe 垫片侧求值后回传结果。面板运行在 Kabegame 自身界面里，直接 `eval` 第三方字符串不可取。
2. **目录服务 MIME 缺口**。PLAN 的 Phase 3 / 3 默认 `/wpe` 能直接服务网页。实测它对 html / js / css / json 都返回 `application/octet-stream`，必须在 Phase 3 补 web MIME 表，否则 iframe 无法渲染入口页。
3. **WPE 关闭了同源策略**（`disable-web-security`）。依赖跨域请求的壁纸（天气、RSS 之类）在 Kabegame 的 HTTP 源下会被 CORS 拦截。PLAN 没提到这一点。建议记入已知边界。不建议为壁纸窗口全局关闭同源策略，因为它和主界面在同一个 browser 进程里。
4. **CEF IPC 入口不区分 frame**。实测子 frame POST `cef-ipc://` 会被转交给 Tauri，目前只靠 invoke key 挡住。PLAN 假设的「IPC 垫片只注入主 frame，所以天然隔离」只对了一半。建议 Phase 5 在 `tauri-runtime-cef` 的 `cef-ipc` 处理器里校验请求来自主 frame，或校验 Origin 属于应用源，作为纵深防御。这是对 `src-tauri/tauri-runtime-cef` 的改动，范围由用户决定。
5. **`thumbnail` 是完整 data URL**。PLAN 写的是「base64 PNG」。实现时宿主应给 `data:image/png;base64,…`，页面直接赋给 `img.src`。
6. **兼容补丁**。WPE 会把 `zcompat/web` 补丁写回壁纸目录，Kabegame 必须改为响应时在内存中替换。PLAN 未提及，建议放进 Phase 5。
7. **暂停的实现方式**。PLAN 写的是「转发 `setPaused`」。WPE 实际是垫片冻结计时、动画、媒体和 `AudioContext` 后，再回调页面的 `setPaused`。建议 Phase 5 照此实现，否则不处理 `setPaused` 的壁纸暂停后仍占 CPU / GPU。
8. **单个视频文件当网页播放**（`wallpaperOnVideoEnded`、`.webm` / `.ogv` / `.gif` 包装页）是 WPE 对 webm 视频壁纸的内部做法，与 Web 类型无关，不纳入第二阶段。

## 九、仍未确认

- `group` / `text` 条目是否出现在 `applyUserProperties` 里。样例作者自带的回退代码会把整份 `general.properties` 原样推给页面，说明页面能容忍；但 WPE 的真实行为未知。
- `applyGeneralProperties` 是否携带 `language` / `steamlanguage`，以及字段格式。
- 滑块 Fraction / Precision 在 `project.json` 中的字段名。
- `fileType` 的取值格式。
- WPE 鼠标转发的具体实现。

## 资料来源

- [Web Wallpaper Reference Guide](https://docs.wallpaperengine.io/en/web/overview.html)
- [Creating a Web Wallpaper](https://docs.wallpaperengine.io/en/web/first/gettingstarted.html)
- [User Properties](https://docs.wallpaperengine.io/en/web/customization/properties.html)
- [Display Conditions for Properties](https://docs.wallpaperengine.io/en/web/customization/displaycondition.html)
- [Property Translation](https://docs.wallpaperengine.io/en/web/customization/localization.html)
- [Audio Visualization](https://docs.wallpaperengine.io/en/web/audio/visualizer.html)
- [Media Integration](https://docs.wallpaperengine.io/en/web/audio/media.html)
- [FPS Limiter](https://docs.wallpaperengine.io/en/web/performance/fps.html)
- [RGB Hardware Support](https://docs.wallpaperengine.io/en/web/api/rgb.html)
- [iCUE](https://docs.wallpaperengine.io/en/web/api/icue.html)
- [Web Wallpaper Debugging](https://docs.wallpaperengine.io/en/web/debug/debug.html)
- [wallpaperPropertyListener 参考](https://docs.wallpaperengine.io/en/web/api/propertylistener.html)
- [非官方] [Steam：音频监听只保存一个回调](https://steamcommunity.com/app/431960/discussions/1/312265589446469530)
- [非官方] [Steam：点击转发实现](https://steamcommunity.com/app/431960/discussions/1/135513901706643121)
- [非官方] [Steam：滚轮 / 按键不转发](https://steamcommunity.com/app/431960/discussions/2/1736588252406358010)
