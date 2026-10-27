# WPE Web 壁纸接口参考与兼容矩阵（Phase 1 产出）

> 状态：Phase 1 产出（2026-10-25），随 Phase 3 / 4 落地持续修订（最近 2026-10-27）。上级：[PLAN.md](PLAN.md)。
> 第六节起的「Phase」列与 PLAN 当前的 Phase 路线一致；鼠标转发的逆向细节见 [WPE_INPUT_RE.md](WPE_INPUT_RE.md)。
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
> 本机样例（只读）：
> - **主样例：创意工坊 `3679122549`，即 kaguya（「[16:9] 超かぐや姫 All-in-One」）**，`D:\Applications\Steam\steamapps\workshop\content\431960\3679122549`，Kabegame dev 库 id 12097。
>   - 入口 `index.html` + 混淆过的 `script.js`（带 `selfDefending`，格式化后会死循环，只能原样读）+ `style.css`；
>     歌单、封面、MV、字幕全从 `data.json` 经 `fetch` 解析，媒体在 `music/` `mv/` `cover/` `subtitle/` `background/` `thumb/`。
>   - 定义 `wallpaperPropertyListener.applyUserProperties` / `applyGeneralProperties`（§5.1 实测）；用了 4 处 `localStorage`；页面有点击交互和鼠标视差（`bg_mouse_sensitivity`）。
>   - 属性：`schemecolor`、`text_color`、`visualizer_color`（color），`bg_mouse_sensitivity`、`playback_rate`、`audio_sensitivity`（带 `step` 的小数滑块），
>     `custom_user_bg`（file，`filter: "*.jpg|*.png|*.jpeg|*.webp"`，无默认值）。
>   - 后续 Phase 的验收都以它为准。
> - 字段与写法的补充证据：
>   - 创意工坊 `796697921`，即 Slideshow（directory 属性、`condition`、`group` / `text` 条目）。
>   - 官方默认项目 `corsair_collection`、`corsair_o_tron`，位于 `…\wallpaper_engine\projects\defaultprojects\`（RGB、键盘）。

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
| `step` | 滑块步长，可为小数（如 `0.1`、`0.25`） | [样例] kaguya 的 3 个滑块 |
| `filter` | file 属性的可选文件过滤，`|` 分隔的通配符，如 `"*.jpg|*.png|*.jpeg|*.webp"` | [样例] kaguya 的 `custom_user_bg` |
| `fileType` | file / directory 属性的文件类型，由编辑器写入 | [REA] 字符串 `fileType`、`directory`、`ondemand`、`fetchall` 相邻；样例未出现 |

**显示条件 `condition`**

- [官方] 原文是 "a JavaScript-compatible if condition"，示例为 `showclock.value == true`。
- [样例] 实际写法比文档复杂，包括：
  - `effect.value.endsWith('pulse') === true && pulseanimation.value !== 'static'`
  - `effect.value.startsWith('rainbow') === false`
  - `showbottom.value > 0`
  - 裸真值 `backgroundImageVisible.value`
- 也就是说，条件里会用到字符串方法、`===` / `!==` / `>`、`&&`，以及直接引用其它属性的 `.value`。

**滑块精度**：[官方] 编辑器里有 Fraction 与 Precision（默认 2）选项，但文档没给 JSON 字段名。[样例] kaguya 的小数滑块写成 `step`（`0.1` / `0.25`），没有 `precision` / `fraction`；面板按 `step` 取值即可，Precision 是否另有字段**未确认**。

## 二、属性类型

| 类型 | 推给页面的值 | 面板行为 | 来源 |
|---|---|---|---|
| `color` | 空格分隔的 0–1 浮点三元组，如 `"1.0 0.1 0.25"`；页面自己乘 255 | 取色器 | [官方] properties |
| `slider` | 数字 | `min` / `max`，`editable` 显示输入框 | [官方]；[样例] |
| `bool` | `true` / `false` | 复选框 | [官方] |
| `combo` | `.value` 为选中项的 value，`.text` 为标签（官方建议只用 value） | 下拉 | [官方] |
| `textinput` | 字符串 | 文本框 | [官方] |
| `file` | 本地绝对路径；页面自己拼 `'file:///' + value` | 文件选择，按 `filter`（或 `fileType`）过滤；可以没有默认值 | [官方]；[样例] kaguya |
| `directory` | `.value` 表示是否已设置；文件经目录接口单独给，见第三节 | 文件夹选择，`mode` 决定交付方式 | [官方] |
| `group` | 不推（未确认） | 分组标题 | [样例] 796697921 有 7 个，文档未写 |
| `text` | 不推（未确认） | 纯说明文字，`text` 可含 HTML | [样例] 796697921 有 7 个，文档未写 |

- 可选文件类型：
  - 图片：`.jpeg .jpg .png .bmp .gif .svg .webp`，文档还写了 `.pnga`。
  - 视频：`.webm .ogg .ogv`。[官方] properties
- Web 壁纸里的视频官方只保证 WebM / Ogg / OGV。[官方] overview

## 三、全局接口清单

所有接口挂在页面的 `window` 上。WPE 用一段注入脚本提供它们，那段脚本在页面脚本之前执行（[REA] 见第四节）。Kabegame 用 all-frames 初始化脚本复刻这段注入，见第六节第一行。

### 3.1 宿主回调：`window.wallpaperPropertyListener`

页面必须在全局、任何事件之外定义该对象，否则会漏掉加载时的首批推送。[官方] propertylistener

**推送语义**：该对象由页面自己定义，注入脚本不定义它，也不拦截对它的赋值（[REA] 注入脚本只定义 `wallpaperRegister*` /
`wallpaperMediaIntegration` / `___wpx*`）。推送时机由宿主决定，每次推送都在那一刻读 `window.wallpaperPropertyListener`，有对应回调就调用，没有就丢弃：
- 页面晚于首推才赋值，收不到首推，也不会补推；
- 页面中途换成另一个对象，之后的推送打到新对象上。

首推时刻（[REA] §4.8）：宿主的推送在页面加载期间排队，**整页加载结束**（晚于 `window` `load` 事件的同步处理）后按序投递；
加载结束后的推送立即投递。所以在 `DOMContentLoaded` 或 `load` 回调里定义 listener 也能收到首推。

| 回调 | 签名 | 触发时机 | 边界 | 来源 |
|---|---|---|---|---|
| `applyUserProperties` | `(properties) => void`，`properties = { [key]: { value, text?, ... } }` | 加载时推一次，之后用户改属性时推 | **只含值变化的键**，页面逐键判断存在性 | [官方] |
| `applyGeneralProperties` | `(properties) => void` | 加载时推一次，之后 WPE 全局设置变化时推 | 已确认有 `fps`（数字，0 应视为不限）；[REA] 推给页面的是主程序发来的整份全局设置 JSON，其中 `language` 已被换算成 WPE 语言码（连字符形式，36 项码表从 `0x14011ed20` 读出，如 `en-us`、`zh-chs`、`zh-cht`、`ja-jp`、`ko-kr`；由 `steamlanguage` 的 `english` / `schinese` / `tchinese` / `japanese` / `koreana` 等名称映射）；除 `fps` / `language` 外还有哪些字段取决于主程序，未确认 | [官方] fps；[REA] |
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

这些接口没有公开文档，页面不应依赖。垫片只把 `wallpaperGetUtilities` 定义成返回空对象的函数（WPE 把它挂成原生函数，§4.8），其余不提供。

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
> 追记：也许可以用chromium的原生PageLifecycle暂停
- [REA] WPE 注入了一段运行时脚本（全局标记 `___STAHP`）。暂停状态变化时宿主执行一段 JS（命令 4，只在状态真的改变时发）：
  - 暂停：先 `if(listener&&listener.setPaused&&!window.___wpxAnimLocked){listener.setPaused(true);}`，再 `window.___wpxPause();`；
  - 恢复：先 `window.___wpxUnpause();`，再同样带判断地 `setPaused(false)`。
  - 即页面的 `setPaused(true)` 在冻结之前、`setPaused(false)` 在解冻之后被调用。
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
- [REA] 转发全部在 `webwallpaper64.exe` 里，完整证据见 [WPE_INPUT_RE.md](WPE_INPUT_RE.md)。要点：
  - 不装鼠标钩子：主线程约 200Hz 的循环里轮询 `GetKeyState(VK_LBUTTON)` 与 `GetCursorPos`。
  - 移动：光标坐标一变就 `SendMouseMoveEvent`（`ScreenToClient` 换算），不做命中判定、不检查显示器、不发 leave；`modifiers = 0`，**不带左键标志**，所以页面里拖不动东西、也不会启动拖放。
  - 点击：`SendMouseClickEvent(MBT_LEFT, clickCount = 1, modifiers = 0)`；左键状态变化时用 `WindowFromPoint` 加类名 / 属性判定光标下是不是桌面，按下只在命中桌面时发，抬起无论落在哪里都发。
  - 不转发滚轮、右键、中键。键盘经 `WH_KEYBOARD_LL` 收集，只在本地文件壁纸上安装，且要求上一次按键落在桌面上、桌面图标已隐藏（`FWF_NOICONS`）。
  - 浏览器以窗口模式（非 OSR）嵌在宿主窗口下，挂载后与 Explorer 线程解除输入队列关联（`AttachThreadInput(…, FALSE)`），否则会抢走 Explorer 的鼠标捕获、桌面框选失效。
  - 暂停期间跳过整段鼠标轮询。

### ~~4.6 兼容补丁~~（不做）
- [磁盘] + [REA] WPE 自带 `assets/zcompat/web/<workshopid>.json`，本机有 5 个。内容是对指定壁纸的 js 文件做 `replace` → `insert` 的文本替换，例如给 `texImage2D` 调用加空值判断。
- [REA] 有日志 `Failed writing compat fix at %S`，说明 **WPE 会把补丁写回壁纸目录**。Kabegame 不写用户目录，只能在加载时按同一份规则在内存中替换：
  预览走 `/wpe` 响应体；桌面是 `file://` 加载，要在 CEF 资源层替换响应（初始化脚本做不到，它改不了别人的文件内容）。
- [样例] 本机订阅的网页壁纸都不在这 5 个之内。

### 4.7 视频属性对 Web 的作用
- [REA] 同一可执行文件里有：
  - `document.documentElement.style.filter = 'contrast(…) brightness(…) saturate(…) hue-rotate(…deg)'`，对应 `wec_*`；
  - `document.documentElement.style.transform = 'scaleX(-1)'`，对应 `alignmentfliph`。
- 说明第一阶段的颜色调整与水平翻转这组标准属性，对 Web 壁纸也以 CSS 作用在 `<html>` 上。是否在面板里出现、默认值如何，**未确认**。

### 4.8 宿主与页面的通道（推 / 拉）
[REA] 2026-10-27 对 `webwallpaper64.exe` 静态分析（函数名为 Ghidra 默认命名，没有运行 WPE）。同一进程也承载图片 / 视频壁纸，
对象 `+0x360` 区分 0 网页、1 图片、2 视频，下文只说网页。

**宿主 → 页面：拼 JS 字符串，在主 frame 里 Eval；页面加载完成前排队。**
- 主程序经命名管道下发命令，webwallpaper64 的浏览器进程把每条命令拼成一段 JS：
  - 命令 6（用户属性）：负载是 `{ properties, name }`。`name` 必须等于命令 1 记下的当前 URL，否则整条丢弃（防止旧壁纸的属性打到新页面上）。
    `properties` 里的 directory 属性先按 `fetchall` / `ondemand` 处理，再整体拼成
    `if(window.wallpaperPropertyListener&&window.wallpaperPropertyListener.applyUserProperties){…applyUserProperties(<JSON>);}`。
  - 命令 7（全局设置）：换算 `language` 后把整份 JSON 拼进带同样判断的 `applyGeneralProperties(...)`；同一负载里的 `fps`、
    `processpriority`、`videoaudiooutput` 也被进程自己消费（例如 `fps` 改主循环帧率）。
  - 命令 4（暂停）：见 §4.4。
- 所有 JS 走同一个出口 `FUN_14001d650`：
  - 已就绪：封成 CEF 进程消息 `ExecuteJavaScriptAsync` 发给渲染进程，渲染进程在 `OnProcessMessageReceived` 里取**主 frame** 的
    V8 上下文 `Enter → Eval → Exit`；
  - 未就绪：存进一个先进先出队列。
- 就绪标志：
  - 命令 1（加载 URL）调用的导航函数 `FUN_14000bd80` 先清空队列，再把标志置假；
  - 浏览器侧 `CefLoadHandler::OnLoadingStateChange(isLoading=false)`（`FUN_1400120a0`，虚表槽 `0x14011ded0`）把标志置真，
    先重放 RGB 插件注册（`onPluginLoaded`），再按入队顺序发出队列里的 JS。
- 结论：
  - 加载期间到达的推送，等 Chromium 报告整页停止加载（晚于 `window` `load` 事件的同步处理）后一次性投递；之后到达的立即投递。
  - 页面不需要也没有任何缓存，listener 在投递那一刻不存在就丢掉（§3.1）。
  - 页面自己 `location.reload()` 不会让标志复位（只有命令 1 复位），刷新后的页面能否再收到属性取决于主程序是否重推。
- 渲染侧 `OnLoadEnd`（`FUN_140012a80`）另发 `OnRendererLoadEnded` 给浏览器进程，浏览器进程经管道回报主程序命令 14。
  主程序收到后做什么没有分析（`wallpaper64.exe` 未反编译），见第九节。

**页面 → 宿主：原生 V8 函数，订阅式。**
- 渲染侧 `OnContextCreated`（`FUN_140013280`）对每个 V8 上下文执行（未见主 frame 判断）：
  - 在 `window` 上挂原生函数：`wallpaperRegisterAudioListener`、`wallpaperRegisterMedia{Properties,Thumbnail,Playback,Timeline,Status}Listener`、
    `wallpaperGetUtilities`、`wallpaperRequestRandomFileForProperty`、`wallpaperOnVideoEnded`、`wallpaperRequestTakeScreenshotResponse`；
  - 然后 `Eval` 运行时脚本（`___STAHP`，§4.4）。
- 订阅：浏览器进程收到 `AudioContextRegistered` 后发管道命令 13，收到 `MediaIntegrationContextRegistered` 也上报主程序。
  数据回程是进程消息 `SendAudioSample`、`SendMedia{Property,Thumbnail,Playback,Timeline,Status}Update`，由渲染进程直接调用页面登记的回调，
  不经过拼 JS 字符串。[推断] 注册函数在渲染进程保存回调后发出上述消息，即主程序在页面注册之后才开始送数据。
- 请求 / 应答：`wallpaperRequestRandomFileForProperty` 走 `RequestRandomFile` → `RequestRandomFileResponse`。
- [推断] 新一次加载开始时（`OnLoadingStateChange(isLoading=true)`）渲染侧释放已登记的回调引用。

**对 Kabegame 的含义**（2026-10-27 决定不照搬，PLAN 已确认决策 10，方案见 [phase-5-shim-host.md](phase-5-shim-host.md)）：
- 只借用两条结论：首次投递不早于 `load`；页面没有 listener 时丢弃。
- 其余换成 Tauri 的拉取 + 订阅：
  - 垫片在文档开始时拉一份完整状态；
  - 桌面 `file://` 页面经受限 capability 调用拉取命令，并 `listen` 推送事件；
  - 预览 iframe 经父页面中转；
  - 差异与投递时机由垫片决定，宿主不排队。

## 五、Kabegame 实测（2026-10-25，dev，主窗口内临时 iframe 指向 `/wpe/12091/`，测后已移除）

| 项 | 结果 | 结论 |
|---|---|---|
| iframe 跟随 `/wpe/<id>/` 的 307 | 跳到 `/wpe/12091/Wallpaper%2D1%2Emp4` 并正常加载（视频文档） | 307 对 iframe 文档加载**正常**，Format error 只发生在 `<video>` 元素上 |
| 父页面访问 iframe DOM | `SecurityError` | 跨源隔离生效 |
| iframe 内 `__TAURI_INTERNALS__` / `__TAURI__` / `window.ipc` | 都是 `undefined` | Tauri 初始化脚本与 CEF IPC 垫片都只进主 frame |
| iframe 内 `fetch('cef-ipc://localhost/', POST)` | **返回 204** | CEF 的 `cef-ipc` scheme 处理器不区分 frame，子 frame 的请求也会交给 Tauri |
| 子 frame 伪造的 IPC 消息（不带 invoke key，回调 id 取自主 frame） | 主 frame 的成功和失败回调**都没触发** | 被 Tauri 静默丢弃；同一条消息从主 frame 发出也被丢弃，而正常 `invoke` 成功、回调通路正常。所以**实际门槛是 invoke key**，子 frame 拿不到它 |
| iframe 内相对 `fetch('./project.json')` | 200，但 `Content-Type: application/octet-stream` | 当时目录服务的 MIME 只来自媒体格式表，`.html` / `.js` / `.css` / `.json` 都拿不到正确 MIME；Phase 3 已补 `/wpe` 网页 MIME 表 |
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
- Chromium 把每个 `file://` 文档当作独立的不透明源，**标签式子资源能加载，`fetch` / XHR 一律失败**。WPE 靠 `--disable-web-security` 绕过（§4.1）。
  对应的命令行开关是全进程生效的，会同时作用于主界面与畅游窗口，所以 Kabegame 只能按窗口打开文件访问，见 §5.2。
- `file://` 源的 `localStorage` 跨重启稳定且与端口无关，所有网页壁纸共用一个 `file://` 源（WPE 也是如此，按显示器隔离）。
- `file://` 主 frame 默认会拿到 Tauri 初始化脚本（含 `__TAURI_INTERNALS__`）；`invoke` 虽被 Origin 校验挡住，壁纸页面也不该看到这些对象，
  所以运行时对开了文件访问的窗口里的 `file:` 文档不注入 Tauri 脚本（§5.3）。
- Phase 3 的预览与桌面都先走 HTTP `/wpe/<id>/` + 跨源 iframe；按 §5.2 的结论，Phase 4 起桌面改为 `file://` 主 frame（PLAN 已确认决策 8），预览保持 HTTP iframe。
- 实验用的临时命令已在 Phase 4 删除。

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
- 打开后页面能读任意本地文件，所以照 WPE 做资源拦截（§4.1 的 `FUN_140016950`），实现见 §5.3。
- 跨源 http 请求仍被 CORS 拦。WPE 是全局 `--disable-web-security`；Kabegame 若要支持，需要在补丁里另改网络服务的
  `URLLoaderFactoryParams.disable_web_security`（Chromium 侧，当前读全局命令行），**第一版不做**，记入已知边界。

### 5.3 两种宿主的现状（Phase 4 落地后）

| 项 | 桌面壁纸窗口 | 图库预览 |
|---|---|---|
| 页面加载 | 壁纸窗口主 frame 整窗导航到入口 `file://`，切走时导航回应用页；导航唯一属主是 Rust `wallpaper/wpe_web_host.rs` | 主窗口里的跨源 sandbox iframe，`/wpe/<id>/` 307 到入口，相对资源同前缀 |
| 文件访问 | CEF 补丁 0004：建窗 `extra_info` 带 `kabegame.allow_file_access_from_file_urls`，只对该浏览器打开偏好 | 不涉及；HTTP 源读不了 `file:` |
| 越界拦截 | `tauri-runtime-cef/src/file_access.rs` 的 `check_file_request`，在 `on_before_resource_load` 里取消：不在当前壁纸目录内（两端都 `canonicalize`）、符号链接、目录、不存在的 `file:` 请求 | `/wpe` 目录服务做 `..` 越界校验 |
| MIME | 由 Chromium 按扩展名判定；`file:` 不走 HTTP 缓存 | `/wpe` 专属网页 MIME 表（`http_server.rs` 的 `wpe_mime_from_path`）。HTML 从 `serve_wpe_html` 产出（`no-store`）；其余文件走共用的 `serve_file_with_mime`（支持 Range），文本类（js / css / json 等）覆盖为 `no-cache`，图片、字体、音视频保持 immutable |
| Tauri 脚本 | 开了文件访问的浏览器里，`file:` 文档（及继承它的 about:blank / srcdoc 子 frame）不注入任何初始化脚本（`subprocess.rs`） | 只注入主 frame，跨源 iframe 里没有 |
| IPC | `file:` 文档 Origin 为 `null`，`cef-ipc` 入口直接拒绝 | `cef-ipc` 只收主 frame 或与 webview 初始 URL 同源的子 frame（`ipc.rs`） |
| `localStorage` 源 | `file://`，跨重启稳定，所有网页壁纸共用 | `http://127.0.0.1:<随机端口>`，随启动变化 |
| 鼠标 | Windows：`wallpaper/input_forward.rs` 每 16ms 轮询，照 §4.5 转发移动与左键；挂载后 `AttachThreadInput(…, FALSE)` 与 Explorer 解除输入队列关联（`tauri-plugin-wemt`） | 页面本身可交互（iframe 接收指针事件） |
| 带声自动播放 | 运行时全局 `autoplay-policy=no-user-gesture-required` | 同一进程，同一策略 |
| WPE 接口 | 没有，Phase 5 补 | 同左 |

## 六、兼容矩阵

优先级定义：
- **P0**：不实现大多数壁纸白屏或缺初始化。
- **P1**：常用。
- **P2**：少用。
- **空实现**：定义接口但永不回调。
- **不做**：不提供。

「Phase」列写「已完成」的项已在 Phase 3 / 4 落地，现状见 §5.3。

| 接口 / 能力 | 优先级 | Phase | 实现方式 |
|---|---|---|---|
| 垫片先于页面脚本执行 | P0 | 5 | Tauri `initialization_script_for_all_frames`，桌面壁纸窗口与主窗口各挂同一份垫片；CEF `on_context_created` 在页面脚本之前执行。垫片按 `location` 自判，只在 `file:` 文档或本地 `/wpe/<id>/` 下定义接口，应用页和其它 iframe 里什么都不做。桌面 `file:` 文档照常注入 Tauri 脚本，运行时把 IPC 来源改写成 frame URL，ACL 只给 `wpe-web-capability`。不改写 HTML 响应 |
| 页面读同目录资源 | P0 | 已完成 | 桌面：补丁 0004 按窗口开文件访问 + 运行时目录拦截；预览：`/wpe` 网页 MIME 表 |
| `applyUserProperties` 首推作者默认值 | P0 | 5 | 状态里的 `user` 为 `{ key: { type, value } }`（只含带 `value` 的条目）。垫片拉取：桌面调 `wpe_web_pull_state`，预览 `postMessage` 给父页面、由父页面调 `get_wpe_web_state`。`load` 后首次全量投递，之后按差异投递；首次投递后页面换 listener 时补投全量 |
| `applyUserProperties` 增量推送 | P1 | 7 | 用户改属性后只推变化的键 |
| `applyGeneralProperties({ fps })` | P1 | 6 | 有了帧率设置再推。不推 0：按 `1000 / fps` 算间隔的页面会停住，而不推时页面保留自己的默认值 |
| `applyGeneralProperties` 的 `language` | P2 | 5 | 推 Kabegame 当前语言，字段名 `language`，值用 WPE 语言码（`zh-chs` / `zh-cht` / `en-us` / `ja-jp` / `ko-kr`，§3.1）；语言变化时桌面经 `wpe-web-state` 事件、预览经父页面推送 |
| `setPaused` + 冻结计时 / 动画 / 媒体 | P1 | 5（垫片）/ 6（触发） | 垫片照搬 WPE 的 `___wpxPause` 思路（§4.4）；宿主按壁纸窗口的暂停条件触发 |
| `localization` 文案 | P1 | 7 | 面板按 Kabegame 语言映射到 WPE 语言码，缺失回退 `en-us`，再回退原文 |
| `condition` 显隐 | P1 | 7 | 必须能求值 JS 表达式（见第八节第 1 条） |
| `file` 属性 | P2 | 7 | 见难点一；kaguya 的 `custom_user_bg` 即此类 |
| `directory` 属性：`fetchall` / `ondemand` | P2 | 7 | 见难点一；`fetchall` 需要宿主监视目录并推增删 |
| `wallpaperRegisterAudioListener` | P1 | 5（空实现）/ 8 | WASAPI 回环 + FFT，128 浮点、约 30Hz、`NaN` 置 0 |
| 媒体集成 5 个注册函数 | P2 | 5（空实现）/ 8 | 系统媒体会话；`thumbnail` 用 `data:image/png;base64,` 前缀 |
| `wallpaperMediaIntegration` 常量 | P1 | 5 | 垫片直接定义 `{ PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 }` |
| `wallpaperPluginListener` / `wpPlugins.led` / `window.cue` | 空实现 | 5 | 不调用 `onPluginLoaded`；`wpPlugins`、`cue` 不定义，页面按文档会先检查插件已加载 |
| `wallpaperGetUtilities` | 空实现 | 5 | 空对象 |
| `wallpaperOnVideoEnded` / 截图接口 | 不做 | — | WPE 内部用 |
| 带声自动播放 | P1 | 已完成 | 运行时全局 `autoplay-policy=no-user-gesture-required`，桌面与预览同一进程同一策略 |
| 背景不降频 | P1 | 6 | WPE 关掉了遮挡检测与后台降频（§4.1）；Kabegame 壁纸窗口挂在 WorkerW 下，是否被判为遮挡而降频待测 |
| 跨域 `fetch`（关同源策略） | P2 | — | 不做：桌面只开了 `file:` 访问，跨源 http 仍受 CORS 约束（§5.2）；页面访问外网 API 依赖对方的 CORS |
| `localStorage` 持久化 | P2 | 桌面已完成 / 预览见难点二 | 桌面 `file://` 源稳定；预览源随端口变化 |
| 鼠标交互 | P2 | 已完成（Windows） | 移动 + 左键，照 WPE 轮询转发（§4.5、难点三）；滚轮、右键、键盘不转发 |
| 兼容补丁 `zcompat/web` | P2 | 未排期 | 读 WPE 安装目录里的规则在内存中替换，不写盘：预览在 `/wpe` 响应体替换，桌面要在 CEF 资源层替换响应。本机订阅的壁纸都不受影响 |
| 颜色调整 / 翻转作用于 `<html>` | P2 | 未排期 | 复用第一阶段的 `wec_*` / `alignmentfliph` 换算，由宿主设 `documentElement.style`（桌面执行脚本，预览经垫片） |
| 挖矿脚本拦截 | P2 | 未排期 | 桌面可在 `on_before_resource_load` 里一并取消 `coinhive.com` / `arc.io/widget` 请求 |

## 七、难点与现状

### 难点一：`file` / `directory` 属性的 `file:///` 路径

WPE 给页面的是本地绝对路径，页面自己拼 `file:///` 交给 `<img>`、CSS `url()` 或 `fetch`。kaguya 的 `custom_user_bg`（自定义背景图）就是这种 `file` 属性。

- **桌面**：页面已是 `file://` 源且开了文件访问，这类路径本身能加载，挡住它的只有运行时的目录拦截。照 WPE 的两张白名单（§4.1 拦截逻辑第 3 步），
  把 `file` 属性的值和 `directory` 属性展开的文件加进当前壁纸的放行集合即可，不需要改页面，也不需要改 CEF。
- **预览**：HTTP 源的页面加载 `file:` 会失败（§5 实测）。可选方案：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| B. CEF 层把 `file:` 请求改道 | 在 CEF `GetResourceHandler` 里对**来自 `/wpe` 页面的** `file:///<白名单路径>` 请求，由 Kabegame 读文件返回 | 页面零改动 | HTTP 页面加载 `file:` 可能在渲染进程发请求前就被拦，需要实测；拦截器要能识别请求方 frame 的源 |
| C. 垫片改写路径 | 宿主给页面的路径换成 `/wpe` 下的白名单路由；垫片再拦截 `HTMLImageElement.src`、`style.backgroundImage` 等 setter，把 `file:///http://…` 修正回来 | 不碰 CEF | 页面拼接方式五花八门，样例里还有 `fixFilename` 之类的自定义处理，拦截覆盖不全，属于脆弱方案 |
| D. 预览不支持 | 预览里页面收不到这两类属性的值，按作者默认值显示 | 零成本 | 预览与桌面在这类属性上表现不同 |

**推荐**：桌面按白名单扩展实现；预览先 D，Phase 7 前实测 B，可行再补。

### 难点二：`localStorage` 的源

- **桌面**：`file://` 源，跨重启稳定，所有网页壁纸共用，与 WPE 同屏共享一致。Kabegame 多个显示器共用一个 CEF profile，所以多屏之间也共享，比 WPE 少一层按显示器的隔离。
- **预览**：`http://127.0.0.1:<随机端口>`，每次启动都会变；与桌面也不同源，预览里写的存储桌面读不到（kaguya 用了 4 处 `localStorage`）。
- PLAN 已确认决策 4 的自定义协议 `kb-wpe` 原本同时解决两边；桌面由 `file://` 解决后，它只影响预览。可选：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. `kb-wpe` 自定义协议 | 预览 iframe 改走固定源的自定义协议 | 预览源稳定 | 要注册新 scheme、同步改 CSP 与目录服务；预览与桌面仍不同源 |
| B. 固定端口 | 本地 HTTP 服务优先绑定固定端口，被占用时回退随机 | 改动最小 | 端口冲突时回退会丢数据；固定端口更容易被本机其它程序探测 |
| C. 接受不持久 | 不处理 | 零成本 | 预览里依赖本地存储的状态每次重启丢失 |

**推荐**：C。预览是临时查看，桌面才是长期运行的地方；`kb-wpe` 是否保留在 Phase 5 方案里定。

### 难点三：鼠标交互

壁纸窗口挂在 WorkerW 下，桌面图标层在上面，页面本身收不到鼠标事件。Phase 4 已照 WPE 的做法实现（Windows，§4.5、§5.3）：
- `wallpaper/input_forward.rs` 每 16ms 轮询光标与左键（WPE 约 5ms）；移动无条件转发、`modifiers = 0`；左键按下只在光标下是桌面（Progman / WorkerW）时转发，抬起总是转发。
- 挂载后 `AttachThreadInput(…, FALSE)` 解除与 Explorer 的输入队列关联，桌面框选不受影响。
- 不转发滚轮、右键、键盘；macOS / Linux 不转发。
- 待定：轮询间隔是否缩到与 WPE 接近的 5–8ms。

## 八、与 PLAN 设计的冲突与缺口

1. **显示条件必须求值 JS**。PLAN 的 Phase 7 写的是「只支持 `<key>.value` 比较与逻辑运算，不 `eval` 任意 JS」。实际样例用了 `.endsWith()` / `.startsWith()` / `!==` / `>`。建议改为在沙箱里求值，例如只注入各属性 `{ value }` 的 `new Function` 加超时，或者在垫片侧求值后回传结果。面板运行在 Kabegame 自身界面里，直接 `eval` 第三方字符串不可取。
2. **垫片注入与推送通道**。PLAN 的 Phase 5 正文按「iframe + `postMessage` + 目录服务改写 HTML」写。桌面已是 `file://` 主 frame，没有父页面，也不经目录服务。注入改用 all-frames 初始化脚本（PLAN 待定决策 2），桌面推送改由 Rust 对主 frame 执行脚本；`WpeWebHost` 这个名字也与 Rust 的 `wpe_web_host` 重名。Phase 5 开工前重写该节。
3. **WPE 关闭了同源策略**（`disable-web-security`）。Kabegame 桌面只开了 `file:` 访问，依赖跨域请求的壁纸（天气、RSS 之类）会被 CORS 拦截，记入已知边界。
4. **`thumbnail` 是完整 data URL**。PLAN 写的是「base64 PNG」。实现时宿主应给 `data:image/png;base64,…`，页面直接赋给 `img.src`。
5. **兼容补丁**。WPE 会把 `zcompat/web` 补丁写回壁纸目录，Kabegame 只能在加载时内存替换；桌面走 `file://`，替换要放在 CEF 资源层。PLAN 未排期。
6. **暂停的实现方式**。PLAN 写的是「转发 `setPaused`」。WPE 实际是垫片冻结计时、动画、媒体和 `AudioContext` 后，再回调页面的 `setPaused`。建议 Phase 5 的垫片照此实现、Phase 6 接触发条件，否则不处理 `setPaused` 的壁纸暂停后仍占 CPU / GPU。
7. **单个视频文件当网页播放**（`wallpaperOnVideoEnded`、`.webm` / `.ogv` / `.gif` 包装页）是 WPE 对 webm 视频壁纸的内部做法，与 Web 类型无关，不纳入第二阶段。

已在 Phase 3 处理：`/wpe` 网页 MIME 表；`cef-ipc` 只收主 frame 或同源子 frame 的请求（§5.3）。

## 九、仍未确认

- 主程序 `wallpaper64.exe` 收到命令 14（渲染侧 load 结束）后是否重推属性，以及首推的命令 6 是紧跟命令 1 发出还是等命令 14。
  webwallpaper64 一侧不论哪种都在页面加载结束后才投递（§4.8），只影响「页面自己刷新后能否再收到属性」。
- `group` / `text` 条目是否出现在 `applyUserProperties` 里。属性 JSON 由主程序生成，webwallpaper64 只处理 directory 条目、不筛选；样例作者自带的回退代码会把整份 `general.properties` 原样推给页面，说明页面能容忍。
- `applyGeneralProperties` 除 `fps` / `language` 外的字段。
- 滑块 Precision 是否另有字段（kaguya 只用了 `step`）。
- `fileType` 的取值格式，以及它和 `filter` 的关系（kaguya 用的是 `filter`）。
- Kabegame 壁纸窗口挂在 WorkerW 下时，是否被 Chromium 判为遮挡而降频。

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
