# v4.7.0 regression

## 合并：WPE 与路径轮播 / 基本信息芯片

2026-10-27：feat/wpe-import 合入 main 时，rotator 改为 main 的路径轮播，WPE 规则落在 `collect_available` 的逐张检查（`RotationSource.allow_wpe`）；基本信息面板改为 main 的芯片排版，WPE 行显示「Wallpaper Engine · 类型」芯片；预览弹窗的桌面判定统一用 `USE_PSWP`。合并在临时 worktree 完成，未真机运行。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 窗口模式轮播含 WPE | 桌面 CEF | 轮播路径包含 WPE 视频 / 网页行，窗口模式连续切换 | WPE 行正常被选中并显示 | 未验证 |
| [ ] | 原生模式跳过 WPE | 桌面 CEF | 同一路径切到原生模式连续切换 | 跳过 WPE 行，只设普通图片；位置照常前进 | 未验证 |
| [ ] | Plasma 插件跳过 WPE | Linux KDE | 插件模式轮播含 WPE 行的路径 | 跳过 WPE 行，图片与视频照常 | 未验证 |
| [ ] | 基本信息 WPE 芯片 | 桌面 CEF | 打开 WPE 行详情 | 类型位置显示「Wallpaper Engine · 视频 / 网页」芯片，不可点筛选；大小 / 尺寸芯片照常 | 未验证 |
| [ ] | 预览网页壁纸 | 桌面 CEF | 预览 WPE 网页行，左右切图 | 桌面画布正常，切图箭头与工具条行为同合并前 | 未验证 |
| [ ] | 换行符 | 任意 | 新克隆后 `git ls-files --eol` | 除补丁与 `.bat` 外均为 `i/lf w/lf` | 已在合并 worktree 验证索引侧 |

## 壁纸窗口 Vue 化

2026-10-26：壁纸窗口改为 `index.html?window=wallpaper` + `WallpaperWindow.vue` + `WallpaperStage.vue`，纯重构。静态验证：check-kabegame driver 的 vue-tsc 0 error；cargo check 因运行中的 dev app 占用 `target/debug` 的 CEF 文件（`cef-dll-sys` 复制阶段 `os error 32`），改用独立 `CARGO_TARGET_DIR` 跑同一 driver，0 error。真机为 Windows 11 桌面 CEF dev（窗口模式，轮播开启），经 CDP 读壁纸窗口 DOM 与 dev 调试面板验证——壁纸窗口挂到 WorkerW 后 `shot --url wallpaper` 等帧超时无法截图，但页面本身不降频（调试面板帧率 MIN 141 / AVG 144）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 入口分发 | Windows 桌面 CEF | `targets` 列出窗口，读壁纸窗口的脚本与 DOM | 壁纸窗口 URL 为 `index.html?window=wallpaper`、只加载 `main.ts`，页面无组件库元素；html / body 透明；默认截图仍是主窗口 | 实测 body / html 背景 `rgba(0,0,0,0)`、无 `.el-*` 元素；主窗口截图正常 |
| [x] | 图片显示 | Windows 桌面 CEF | 当前壁纸为普通图片时读 `img.base` | 原图加载完成、铺满 2560×1440，ready 握手 `ready invoked: yes` | `naturalWidth` 5512 |
| [x] | 五种样式 | Windows 桌面 CEF | 依次设样式 fit / tile / center / stretch / fill | 图片 `object-fit` 依次为 contain / （tile 显示平铺层、图片层隐藏）/ none / fill / cover，调试面板 `last style ts` 与 `mode` 立即更新 | 逐项读 DOM 符合 |
| [x] | 过渡 fade / slide / zoom | Windows 桌面 CEF | 轮播开启时切过渡（触发一次轮播） | top 层类名依次 `top <过渡> prep` → `top <过渡> enter` → 提交后回到 `top`，base 换成新图 | 三种都观察到完整序列；首次切 slide 未触发轮播，重试后正常。2026-10-26 页面内 MutationObserver 精确计时（12093 → 12091 视频切视频、fade）：prep 679ms → enter 689ms（两帧 rAF 10ms）→ 1494ms 提交（800ms 动画走完由 transitionend 触发），1400ms 兜底未介入；此前「两帧 rAF 约 2s」是 CDP 轮询类名的测量假象 |
| [x] | 调试面板帧率 | Windows 桌面 CEF dev | 读壁纸窗口 `.debug-panel` 第一行 | 显示 `fps: MIN n AVG n`，与主窗口 FrameMonitor 同一 store、300ms 采样；WorkerW 下播放 WPE 视频时接近显示器刷新率 | 2026-10-26 实测 MIN 141 / AVG 144（144Hz 屏） |
| [x] | 过渡 none | Windows 桌面 CEF | 过渡为 none 时换壁纸 | 直接替换 base，无 prep / enter | 窗口重建后初始为 none，直设 base |
| [x] | 视频与音量 / 倍速 | Windows 桌面 CEF | 设普通视频 426，再把音量改 0.5、倍速改 1.5 | base 视频播放（未静音、`currentTime` 前进），音量与倍速实时生效 | 读到 `volume 0.5`、`playbackRate 1.5`；测后已恢复 1 / 1 |
| [x] | WPE 视频作者属性 | Windows 桌面 CEF | 在 slide 过渡下从视频切到 WPE 视频 12091 | 播 `compatible_path`；视频→视频走 top 层 prep → enter 后 base / top 元素交换；`schemecolor` 成为留边背景色，`object-position` 50% 50% | 背景 `rgb(113, 69, 160)`；该壁纸无翻转 / 偏移 / 颜色属性，transform 与 filter 为空，翻转与滤镜未能用真实数据验证 |
| [x] | 关闭再开启窗口模式 | Windows 桌面 CEF | 切到原生模式再切回窗口模式 | 壁纸窗口销毁后重建，ready 握手完成并显示当前壁纸 | 重建后 `targets` 重新出现壁纸窗口，图片已加载；另经一次 dev 重启（应用冷启动直接建窗）同样握手并显示 |
| [x] | 看门狗计数 | Windows 桌面 CEF | 设 `sessionStorage.wallpaperInitRetry=2` 后 reload 壁纸窗口 | init 跑完后重新握手并清零计数 | 重载后计数为 null、图片已加载；真正的 init 卡死重载未能人为制造 |
| [x] | dev 调试面板 | Windows 桌面 CEF | 读 `.debug-panel` | label / ready / 三个时间戳 / mode / media / transition / rawPath 与原面板一致 |  |
| [x] | 主窗口不受影响 | Windows 桌面 CEF | 主窗口正常使用；派发 Ctrl+Shift+R | 画廊正常渲染（组件库样式在）；Ctrl+Shift+R 重载主窗口 | `performance.timeOrigin` 变化、重载后仍在 `/gallery` |
| [x] | 图库 WPE 视频预览不变 | Windows 桌面 CEF | `/gallery?pvwimgid=12091` 打开预览并拖进度到 60s | 普通视频预览：`<video>` 播 `compatible_path`，有 `VideoControls` 与进度条，seek 生效；不出现壁纸组件 | 进度显示 `01:00 / 01:58` |
| [ ] | 视觉核对 | Windows 桌面 CEF | 肉眼看桌面壁纸的过渡动画、tile、WPE 留边色 | 与重构前一致 | 壁纸窗口无法经 CDP 截图，需人工看桌面 |
| [ ] | macOS 窗口壁纸 | macOS 桌面 CEF | 同上各项 | 同上 | 本机为 Windows，未验证 |
| [ ] | release 构建 | Windows / macOS 打包 | 安装包里开启窗口壁纸 | `tauri://localhost/index.html?window=wallpaper` 能加载并分发到壁纸 bootstrap（asset 协议忽略 query） | 未打包验证 |

## WPE 壁纸导入（第二阶段 Phase 4：桌面 `file://` 宿主 + 鼠标转发）

2026-10-27：桌面壁纸窗口遇到 `x-wpe/web` 时由 Rust（`wpe_web_host`）把整个窗口导航到入口的 `file://`，切走时导航回记住的应用页；CEF 补丁 0004 只对壁纸窗口开 `allow_file_access_from_file_urls`，运行时在 `OnBeforeResourceLoad` 按当前壁纸目录拦截 `file:` 请求，`file:` 文档不注入初始化脚本；Windows 轮询式鼠标移动 / 左键转发；删除 `DEBUG-WPE-FILE` / `DEBUG-WPE-INPUT` 临时代码（含 dev 全局 `allow-file-access-from-files` 开关）。静态验证：check-kabegame driver 的 vue-tsc 与 cargo check 均 0 error（dev 占用默认 target，改用独立 `CARGO_TARGET_DIR`）；单测见本节末行。真机：实现期间 dev 未在运行；其后 2026-10-27 在 dev 上补测，结果见各行备注。测试壁纸：kaguya `3679122549`（库内 id 12097）、Slideshow `796697921`（12099）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 0004 生效 | Windows 桌面 CEF dev | 确认 dev 已重建（全局开关已删），把 kaguya 设为壁纸 | kaguya 页面 `fetch('data.json')` 200，整页渲染（封面、歌词、播放器） | 2026-10-27 真机（Windows 11 dev，CDP）：临时全局开关已删，壁纸窗口 `fetch('data.json')` 200，歌单、封面、歌词、播放器完整渲染，音频播放中 |
| [x] | 导航到 `file://` | Windows 桌面 CEF dev | 窗口模式下 `invoke('set_wallpaper_by_image_id', { imageId: '12097' })`，`targets` 看壁纸窗口 | 壁纸窗口 URL 变为 `file:///D:/Applications/Steam/.../3679122549/index.html`；stdout 有 `[wpe-web-host] 壁纸窗口 → file:///…` | 2026-10-27 真机（Windows 11 dev，CDP）：壁纸窗口 URL 为 `file:///…/3679122549/index.html` |
| [x] | 目录拦截 | Windows 桌面 CEF dev | `eval --url 3679122549` 依次 `fetch('data.json')`、`fetch('file:///C:/Windows/win.ini')`、`fetch('../796697921/project.json')` | 第一个 200，后两个 `Failed to fetch`，stderr 记 `[cef-runtime] deny file: … OutsideRoot` | 2026-10-27 真机（Windows 11 dev，CDP）：`data.json` 与子目录 `cover/Remember.png` 200；`win.ini`、兄弟壁纸 `project.json`、目录 `./music/` 均 `Failed to fetch`。stderr 未查看 |
| [x] | 初始化脚本隔离 | Windows 桌面 CEF dev | 壁纸页面里 `typeof __TAURI_INTERNALS__` | `"undefined"` | 2026-10-27 真机（Windows 11 dev，CDP）：`__TAURI_INTERNALS__` / `__TAURI__` / `window.ipc` 均为 `undefined` |
| [x] | 只作用于壁纸窗口 | Windows 桌面 CEF dev | 主窗口（应用页）里 `fetch('file:///C:/Windows/win.ini')` | 失败（主窗口未登记文件文档策略，偏好与拦截都不作用） | 2026-10-27 真机（Windows 11 dev，CDP）：主窗口 `fetch('file:///C:/Windows/win.ini')` → `Failed to fetch` |
| [~] | 切回应用页 | Windows 桌面 CEF dev | kaguya → 普通图片 → 普通视频 → kaguya | 切到图片 / 视频时壁纸窗口回到 `index.html?window=wallpaper` 并正常显示（ready 握手 yes）；再切回 kaguya 又导航到 `file://`；网页 → 网页（kaguya → Slideshow）直接换 `file://` 入口 | 2026-10-27 真机（Windows 11 dev，CDP）：kaguya → 图片 12823 回到 `index.html?window=wallpaper`，图片已加载（opacity 1）；再切回 kaguya 又导航到 `file://`。视频与网页→网页未测 |
| [ ] | 鼠标转发 | Windows 桌面 CEF dev | 在 kaguya 页面经 CDP 挂 `mousemove` / `mousedown` / `mouseup` 计数，用户在桌面空白处移动、点击，再点在别的应用窗口上 | 桌面移动 / 点击后计数增长且 down / up 成对；点在别的应用窗口上 `mousedown` 不增长（移动仍增长，与 WPE 一致）；Explorer 照常收到点击 | 未验证：需要 dev 运行并由用户在桌面上实际操作 |
| [x] | 桌面框选不被吞 | Windows 桌面 CEF dev | 网页壁纸生效时在桌面空白处拖拽框选图标、单击 / 双击图标 | 框选矩形正常出现并选中图标；图标交互不受影响；页面仍收到 down / up | 2026-10-27 用户实测：wemt 挂载后补 `AttachThreadInput(…, FALSE)` 拆输入队列（同 WE，见 `2-web/WPE_INPUT_RE.md`）后，框选与各种拖动均不再被吞 |
| [ ] | 拖动页面图片不挂住 | Windows 桌面 CEF dev | 在桌面上按住 kaguya 页面里的图片拖动后松开，再继续移动 / 点击 | 不启动拖放（与 WE 一致），桌面上不会多出图片文件；之后页面仍响应鼠标，点击主窗口无系统提示音 | 未验证：移动注入改为 `modifiers=0`；修改前实测会启动 OLE 拖放挂住、图片被拖到桌面 |
| [ ] | 开机即网页壁纸 | Windows 桌面 CEF dev | 当前壁纸为 kaguya 时切原生模式再切回窗口模式（或重启 dev） | 窗口重建 → 应用页 ready → 导航到 `file://`，鼠标转发重新启动 | 未验证：dev 未运行 |
| [ ] | 离开窗口模式 | Windows 桌面 CEF dev | 网页壁纸时切到原生模式 | 窗口销毁，`wpe_web_host` 复位（根目录清空、转发线程退出），无残留线程注入报错 | 未验证：dev 未运行 |
| [ ] | 图库预览不变 | Windows 桌面 CEF dev | 打开 12099 预览 | 仍是 `/wpe/<id>/` 跨源 iframe 桌面画布，可交互 | 未验证：dev 未运行；本次未改预览代码 |
| [ ] | macOS | macOS 桌面 CEF | 窗口模式设网页壁纸 | 导航到 `file://` 并可读同目录文件；不转发鼠标 | 本机为 Windows，未验证 |
| [x] | 单测 | `tauri-runtime-cef` / `kabegame` | `test-kabegame` 跑 `file_access` / `input_forward` / `subprocess` | 目录内文件放行（含查询串）、百分号编码路径解码、`..` 与 `%2e%2e` 越界拒绝、兄弟壁纸目录与同前缀目录拒绝、目录本身与不存在拒绝、无根全拒、非 file URL 拒绝、符号链接拒绝（能建链接时）、登记表语义；桌面根窗口类名判定 | 2026-10-27：`tauri-runtime-cef` 13 个（`file_access` 10 + `subprocess` 3）与 `kabegame` 的 `input_forward` 1 个全部通过；Windows 无建符号链接权限时符号链接断言自动跳过 |

## WPE 壁纸导入（第二阶段 Phase 3：Web 导入 + 预览内嵌）

2026-10-26：`x-wpe/web` 入库（`compatible_path` 为空）、`/wpe` 专属网页 MIME 表与 HTML 产出点、CSP `frame-src` 放行 `http://127.0.0.1:*`、`WallpaperStage` 独立 web 层（跨源 sandbox iframe，不参与双层过渡，切走即销毁）、图库 `wallpaper` 形态与预览「桌面画布」、背景层退回预览图、`get_wallpaper_target_for_image`（作者属性改读图片 metadata），以及 `cef-ipc` 只收主 frame 的纵深防御。静态验证：check-kabegame driver 的 vue-tsc 与 cargo check 均 0 error；`kabegame-core --lib wpe` 中 scan / project 用例通过（`wpe::discover` 两个用例在未改动的 `discover.rs` 上失败，属既有问题）；`kabegame` 的 `wpe_web_mime` 与 `tauri-runtime-cef` 的 `ipc::tests` 4 个用例通过。真机为 Windows 11 dev（CEF 149，2560×1440 主屏），本机 Wallpaper Engine 创意工坊 7 个（视频 3、网页 4）+ `defaultprojects` 19 个（网页 2）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | 壁纸文件原地更新 | Windows 桌面 CEF | 网页壁纸已显示过一次后，修改其目录里的 js（或创意工坊更新），切走再切回 | `/wpe` 的 js / css 返回 `Cache-Control: no-cache`，切回后加载新文件，不读旧缓存 | 2026-10-27 发现：3679122549 的 `script.js` 被格式化后触发混淆器 `selfDefending` 死循环，恢复成单行后仍加载旧缓存（一年 immutable）；改为 `no-cache`，待 dev 重建后真机验证 |
| [x] | 扫描计数 | Windows 桌面 CEF | 打开「开始收集 → 壁纸」对话框 | 每张来源卡片显示「N 个壁纸 / N 个可导入 / 视频 v · 网页 w / N 个已导入」，为 0 的类型省略；可导入 = 已支持类型（视频 / 网页）且未入库；全部已入库时底部提示「本机可导入的壁纸都已导入」 | 创意工坊「7 个壁纸 / 0 个可导入 / 视频 3 · 网页 4 / 7 个已导入」，`defaultprojects`「19 个壁纸 / 0 个可导入 / 网页 2 / 2 个已导入」；删掉一行后变为「1 个可导入」并自动勾选该来源 |
| [x] | 导入 web | Windows 桌面 CEF | 提交壁纸任务（创意工坊、`defaultprojects`） | 每个网页壁纸一行 `type=x-wpe/web`，`local_path` 为目录，缩略图为作者 `preview.*`，`compatible_path` 与宽高为空，`hash` / `size` 取入口 html，标签进 `WPE/<tag>`；scene / application / 其它计入跳过 | 新增 6 行（含 796697921 与 `defaultprojects` 的 corsair_collection / corsair_o_tron），796697921 挂到 `WPE/Abstract`；`defaultprojects` 其余 17 个按 scene / other 跳过 |
| [x] | dry-run | Windows 桌面 CEF | 勾选空跑提交 `defaultprojects` | 日志逐目录「dry-run 跳过」，`images` / `metadata` 行数不变 | 两条 `taskLogDryRunSkipImport`，`images` 8828 / `metadata` 4769 不变 |
| [x] | 幂等 | Windows 桌面 CEF | 再对创意工坊跑一次 | 不新增行，日志「已存在」 | 7 条 `taskLogWpeExisting`，汇总 imported 0 / existing 7 |
| [x] | `/wpe` MIME | HTTP | `curl -I` 入口与 `index.html` / `main.css` / `wallpaper.js` / `project.json` / `preview.jpg`，`--path-as-is` 请求 `../` 越界，`/file/<目录>` | `/wpe/<id>/` 307 到入口；html 为 `text/html; charset=utf-8` + `no-store`，其余为 `text/css` / `text/javascript` / `application/json` / `image/jpeg`；越界与 `/file/<目录>` 404；html 原样返回不注入脚本 | 全部符合 |
| [x] | 网格 | Windows 桌面 CEF | 画廊查看 | 显示作者 `preview.*`，角标「WPE · 网页」（视频行仍为「WPE · 视频」），网格不出现 iframe / video | 6 个网页行均显示 preview.gif / preview.jpg 与「WPE · 网页」；悬停经 CDP 合成指针未命中 `:hover`，悬停不升级由代码（WPE 行固定 thumbnail）保证 |
| [x] | 预览画布 | Windows 桌面 CEF | 打开 796697921 的预览 | 主屏比例画布（角标「桌面预览 · 2560×1440」），页面以「无属性」状态渲染 | Slideshow 显示「Use the settings panel to select a directory of images to display」；iframe 2560×1440，sandbox 正确 |
| [x] | 预览可交互 | Windows 桌面 CEF | 鼠标移到画布左上边缘 | 页面收到 `mousemove`，边缘控件出现 | 左上角播放列表 / 控制面板随移动显现 |
| [x] | 预览箭头唤出 | Windows 桌面 CEF | 预览网页壁纸（kaguya），鼠标从画布中间平移到左 / 右边缘中段，再移回画布中间 | 到达边缘中段时出现上一张 / 下一张箭头（同底部工具条的常驻热区）；从箭头区移回页面后箭头收起；边缘上下两段仍可与页面交互 | 2026-10-27 用户确认：新增 `preview-nav-hotzone`，箭头区 `mouseleave` 到 iframe 时收起 |
| [ ] | 预览工具条操作 | Windows 桌面 CEF | 预览网页壁纸（kaguya），鼠标移到底部唤出工具条，逐个悬停 / 点击全屏左侧的图标 | 右键菜单的可见项（收藏、详情、复制标签、打开、设为壁纸、加入画册、隐藏、移除…；WPE 不显示「欣赏更多」）按菜单顺序排成图标，悬停显示名称，菜单分隔线处有竖线；点击效果与右键菜单相同；收藏 / 隐藏图标随状态切换；图片预览的工具条不变 | 未验证：网页壁纸的右键落在跨源 iframe 里、到不了预览容器 |
| [x] | 预览无视频控件 | Windows 桌面 CEF | 同上 | 没有 `VideoControls`、不走 Panzoom；控制条只剩全屏 | 控制条按钮只有「全屏」 |
| [x] | 预览关闭 | Windows 桌面 CEF | Esc 关闭预览 | iframe 的 page target 消失 | `/json/list` 中 `/wpe/12099` 的 iframe target 消失，DOM 无 `.wallpaper-web-frame` |
| [x] | 设为壁纸 | Windows 桌面 CEF | 窗口模式设为壁纸 | 桌面壁纸窗口出现 web 层 iframe，`pointer-events: none`，媒体层清空，调试面板 `media: web`，ready 握手 yes | `eval --url wallpaper` 读到上述状态（WorkerW 下 CDP 截不到帧） |
| [x] | 切换壁纸 | Windows 桌面 CEF | 图片 → 网页 → 网页 → 图片 → 网页 | 网页切入：iframe load 后 web 层淡入、随后清空媒体层；网页 → 网页：先淡出销毁再加载；网页 → 图片：图片直设 base，web 层淡出后 iframe 先置 about:blank 再移除 | MutationObserver 时间线逐步吻合，iframe 移除在淡出后约 800ms，load 均在 40ms 内；首轮实测发现「先设 src 再插入」的 iframe 偶发停在初始 about:blank（重新赋 src 即恢复），已改为先插入再设 src 并加 3s 补发，修复后 5 次切换无复现 |
| [x] | 过渡 | Windows 桌面 CEF | fade / slide / zoom / none 下切入切出网页 | web 层按对应曲线整层淡入淡出，none 瞬时；媒体层不残留 | fade / slide / zoom 为 0.8s 的 opacity（+transform），none 无过渡；切入完成后 `img.base` src 清空 |
| [ ] | 非窗口模式 | Windows 桌面 CEF | 原生模式设为壁纸 | 提示切换窗口模式 | 未验证：切原生模式会改动本机系统壁纸；守卫按 `is_wpe_type` 前缀判断，本次未改 |
| [ ] | 轮播 | Windows 桌面 CEF | 轮播来源含网页行 | 窗口模式可选中；原生模式跳过 | 未专门验证：轮播开着，期间观察到切换到普通图片，未观察到选中网页行；`is_wallpaper_suitable` 本次未改 |
| [x] | 背景层 | Windows 桌面 CEF | 当前壁纸为网页行且开启应用背景 | 背景显示作者 preview 静态图，不出现 iframe | `.app-background-layer` 内为 `/thumbnail/…/796697921/preview.jpg`，无 iframe |
| [x] | 删除护栏 | Windows 桌面 CEF | `delete_image`（删记录并删源文件）删除 corsair_o_tron 行 | 记录消失，壁纸目录与 `preview.*` 完好 | 目录 13 个文件哈希删除前后一致；随后重新导入恢复（新 id 12100） |
| [ ] | 整理 / 虚拟盘 | Windows 桌面 CEF | 整理覆盖网页行；打开虚拟盘 | 行不被删除、缩略图不被覆盖；虚拟盘不出现网页行 | 未验证：全库整理耗时长且会改写缩略图；护栏按 `is_wpe_row` / `is_wpe_type` 前缀判断，本次未改 |
| [x] | 隔离 | Windows 桌面 CEF | 进 iframe 查全局；父页面读 iframe DOM | `__TAURI_INTERNALS__` / `__TAURI__` / `ipc` 均 undefined；父页面访问被跨源拦截 | 均符合，iframe 源为 `http://127.0.0.1:<port>` |
| [x] | IPC 纵深防御 | Windows 桌面 CEF | iframe 内 POST `cef-ipc://localhost/`；主窗口同样 POST 并 invoke；壁纸窗口重载后握手；畅游窗口主 frame POST | 子 frame 400，主 frame 204，主窗口 invoke 与壁纸窗口 ready 握手正常，畅游主 frame 204 | 子 frame 返回 `400 CEF IPC postMessage is only accepted from the main frame`；其余均符合。另见：畅游页面经 `ipc://` 主通道的 invoke 报 `Origin header is not a valid URL`（Tauri `ipc` handler，与本次 `cef-ipc` 改动无关），待单独排查 |
| [ ] | prod CSP | Windows 打包 | `deno task b` 后装包验证 | iframe 不被 `frame-src` 拦截 | 未验证：dev 不注入 CSP，未打包 |

## WPE 壁纸导入（第一阶段：Video）

2026-10-25：新增 Wallpaper Engine 壁纸目录导入（`x-wpe/video`）、`/wpe/<id>/` 目录服务、删除/整理/虚拟盘/原生壁纸分流与壁纸窗口视频属性复现。静态验证：`cargo check -p kabegame --features standard` 与前端 `vue-tsc` / `vitest` 结果见本节末尾；真机使用本机 Wallpaper Engine 2.8.0.42（Steam 库 `D:/Applications/Steam`，创意工坊 2 个 + `defaultprojects` 19 个）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 自动发现 | Windows 桌面 CEF | 打开「开始收集 → 壁纸」对话框 | 每类来源一张卡片，带「N 个壁纸 / N 个可导入（视频且未入库）/ N 个已导入」标签；有可导入的来源默认勾选；底部显示将导入的数量，全都已入库时提示「本机的视频壁纸都已导入」；同一 Steam 库不会因注册表与 vdf 路径大小写不同而重复计数；`libraryfolders.vdf` 列出的其它盘 Steam 库（含 `431960` 的）也会被发现 | 2026-10-25 真机：创意工坊 2 个（1 视频已入库）、`defaultprojects` 19 个（0 视频），均只出现一次；修复前 `wpe_scan` / `wpe_recognize_dir` / `get_current_wallpaper_target` 未登记 ACL，对话框无结果。2026-10-26 修复 VDF 解析：顶层无花括号导致 vdf 从未解析成功（此前只靠 Steam 安装根兜底，其它盘的库发现不了）、旧格式 `LibraryFolders` 键大小写与统计字段误判为路径；`wpe::discover` 16 用例通过，本机 vdf 两个库（E 盘无 WPE，行为不变），多库真机未验证 |
| [ ] | 手动添加文件夹 | Windows 桌面 CEF | 依次选择创意工坊 `431960` 根、`wallpaper_engine` 安装目录、一个壁纸目录 | 均能识别并追加到自定义文件夹列表；普通目录提示未识别 |  |
| [ ] | 导入视频壁纸 | Windows 桌面 CEF | 提交壁纸任务，导入创意工坊 2725770343 | 生成一行 `type=x-wpe/video`，`local_path` 为壁纸目录，缩略图为 `preview.gif`，标签进入 `WPE/Retro`，创意工坊链接可打开 | 入口视频 276MB，不产生壁纸副本 |
| [ ] | 幂等 | Windows 桌面 CEF | 对同一来源再运行一次任务 | 不新增行；任务日志显示「已存在」并只补目标画册成员 |  |
| [ ] | 网格预览 | Windows 桌面 CEF | 在画廊查看导入的壁纸 | 网格显示作者 `preview.gif`（动图），右上角显示「WPE · 视频」；悬停不加载入口视频 |  |
| [ ] | 预览大图播放 | Windows 桌面 CEF | 双击打开预览并拖动进度 | 只走 `compatible_path`（`/compatible/…`，入口视频本身或兼容副本）播放，不经 `/wpe`，Range 拖动生效 |  |
| [ ] | 应用背景 | Windows 桌面 CEF | 把 WPE 壁纸设为当前壁纸并开启应用背景 | 主界面背景只走 `compatible_path` 播放同一入口视频 |  |
| [ ] | 窗口壁纸与轮播 | Windows 桌面 CEF | 窗口模式下设为壁纸；切换轮播来源到该壁纸所在画册 | 桌面只走 `compatible_path` 播放入口视频；轮播在窗口模式选中 WPE 行 |  |
| [ ] | 非窗口模式拒绝 | Windows 桌面 CEF | 原生模式设为壁纸；从窗口模式切到原生模式 | 前者提示切换窗口模式；后者改用画廊可用图片兜底且不把目录交给原生后端 |  |
| [ ] | 删除护栏 | Windows 桌面 CEF | 删除该记录（含勾选「删除源文件」） | 记录消失，WPE 目录与 `preview.gif` 完好；任务计数正确 |  |
| [ ] | `/wpe` 越界与 `/file` | Windows 桌面 CEF / HTTP | 请求 `/wpe/<id>/../project.json`、`/wpe/<id>/` 与 `/file/<壁纸目录>` | 越界 404；`/wpe/<id>/` 307 到入口；`/file/<目录>` 404 |  |
| [ ] | 整理 | Windows 桌面 CEF | 整理勾选重建缩略图、兼容副本与「移除无法识别媒体」，范围覆盖该行 | WPE 行不被删除、缩略图不被覆盖、兼容副本不按目录重建 |  |
| [ ] | 虚拟盘 | Windows 桌面 CEF | 打开虚拟盘浏览各维度 | 不出现 WPE 行，其余图片计数不受影响 |  |
| [ ] | 详情与操作 | Windows 桌面 CEF | 打开详情；右键查看菜单 | 类型显示「Wallpaper Engine · 视频」并有创意工坊链接；复制 / 分享 / 删除源文件不可用，「在文件夹中显示」打开壁纸目录 |  |
| [ ] | 空跑 | Windows 桌面 CEF | 勾选空跑运行壁纸任务 | 不写库，只统计并记录将导入的目录 |  |
| [ ] | 创意工坊取消订阅 | Windows 桌面 CEF | 移走壁纸目录后刷新图库 | 行仍在并标记缺失，不自动删除记录 |  |
| [ ] | 属性待校准 | Windows 桌面 CEF | 在 WPE 中对照 `fill`（contain）几何与 `wec_*` 滤镜 | 几何与亮度 / 对比度 / 饱和度 / 色相观感接近；差异记录到 WPE 文档 | 计划内的待真机验证项 |

## Windows 窗口壁纸 WorkerW 挂载

2026-10-25：根据 REA 的 WPE 调用链及已有运行时层级记录，替换 Windows 的 Progman 挂载路径；验证状态以下表为准。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [ ] | WorkerW 层级 | Windows 11 CEF | 开启窗口壁纸，枚举 Progman 子窗口 | 壁纸 HWND 的父窗口是无图标视图的整屏 WorkerW；图标可见且壁纸铺满屏幕 | 待新二进制真机验证 |
| [ ] | 无 Z-order 修正 | Windows 11 CEF | 点击桌面，最小化/隐藏/恢复主窗口，执行 Win+D | 图标始终位于壁纸上方；无 `fix_wallpaper_zorder` 调用 | 待真机验证 |
| [ ] | 生命周期 | Windows 11 CEF | 反复切换窗口壁纸模式 | 每次窗口创建后挂载，退出模式时解绑并销毁，重进不沿用旧 HWND | 待真机验证 |
| [ ] | 多屏/DPI | Windows 11 CEF | 在负坐标副屏与不同缩放显示器上挂载、变更分辨率 | 窗口位置和尺寸与目标监视器一致 | 待设备验证 |
| [ ] | Explorer 重建 | Windows 11 CEF | 受控重启 Explorer 后调用 `wemt_refresh` | 失效宿主被识别，重新发现并挂载 | 待受控验证；自动触发尚未接入 |

静态验证：`tauri-plugin-wemt` 默认特性及 `--no-default-features` 的 `cargo check` 通过；插件格式、前端变更文件 Prettier、`git diff --check` 通过。应用级 `cargo check` 因本机运行中的 CEF 占用其运行时文件，在 `cef-dll-sys` 复制阶段以 `os error 32` 中断；前端 `vue-tsc` 因本机 `node_modules/vitest/dist/chunks/global.d.DVsSRdQ5.d.ts` 文件内容异常（开头 32 字节均为零）而报 `TS1127`。这两项尚不能作为变更代码的通过证据。

## 壁纸轮播：一个 PathQL 路径 + 持久化位置

轮播只认 `wallpaperRotationPath`（不含分页尾）与 `wallpaperRotationPosition`。每次切换先 count 有效路径（原生模式尾部拼 `_kb_fc/media-type/image`），出错回落默认全画廊随机路径，再从当前壁纸 id 经 `~~/rank` 定出的下一张开始取（当前壁纸不在路径里才用持久化位置）；换路径时立即设新路径的第 1 张。入口是查询行 ⋯ 面板的「用当前视图轮播」（路径由 `ImageGrid` 注入），设置页只读展示。切换壁纸模式按当前壁纸 id 经 `~~/rank` 重定位。设置迁移框架对齐数据库迁移，v003 把旧三键换算成路径。Android Worker 改为消费 `rotation_queue.json`。

2026-10-27：macOS 桌面 CEF dev 真机（韩语界面），经 CDP 在主窗口调用命令并点击 ⋯ 面板；测完已恢复 dev 的轮播设置与窗口模式（中途切过原生模式，系统桌面壁纸被换成测试图）。测试画册已删除。「换路径立即切到第 1 张」一行在改为按当前 id 定起点、换路径立即切换后补测；测完恢复路径时立即切到了该视图第 1 张（8743，窗口模式），随后清空了当前壁纸 id，位置为 1。换路径经位置 `-1` + 唤醒轮播线程实现后连跑 4 轮（另有 3 轮带 debug ingest 插桩确认每次换路径只切一次）均与表中一致。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 旧设置迁移 | dev app | 用 v2 的 settings.json 启动 | 迁到 v3，生成 `settings.json.bak-v2`；画廊 + 随机 → `images://gallery/hide/sort/random-<seed>`，位置 0，启用状态等原样 | dev 原为画廊随机、未启用，迁移结果与备份一致。其余五种组合由 v003 单测覆盖 |
| [x] | 按视图逐张前进 | 桌面 dev（窗口模式） | `set_wallpaper_rotation_path("images://gallery/hide/sort/by-id")` 后开启轮播，连续手动切换 3 次 | 位置 0→1→2→3，壁纸依次为视图前 3 张 | 30、31、32，与 `_kb_x8x/1` 前三行一致（窗口模式含视频）。此行测于「换路径立即切换」之前，现在设路径时就已切到 30 |
| [x] | 停开轮播保持位置 | 桌面 dev | 关闭再开启轮播；再用同一路径设一次 | 位置与当前壁纸不变 | 均保持位置 3 |
| [x] | 非法路径被拒 | 桌面 dev | 设 `albums://roots`、`images://gallery/hide/nope-xyz` | 报「轮播路径无效」，设置不变 | 分别报 row missing `local_path` 与 path not found |
| [x] | 切换模式重定位 | 桌面 dev | 窗口模式轮到第一张图片（38）→ 切原生 → 切换一次 → 切回窗口 → 切换一次 | 原生下位置为 38 在图片路径里的序号，下一张是其后的图片；切回窗口后接着 by-id 的下一张 | 窗口位置 8 → 原生位置 1、下一张 45 → 窗口位置 15、下一张 46 |
| [x] | 用当前视图轮播（窗口模式） | 桌面 dev | 画廊加宽高比过滤 + 时间倒序，打开 ⋯ 面板点「用当前视图轮播」 | 写入该视图路径、位置 0、开启轮播；按钮变为「正在轮播此视图」并禁用；成功提示 | 路径 `images://gallery/hide/aspect/16x9-/_kb_fc/sort/by-time/_kb_desc`。测于「换路径立即切换」之前；现在点按钮会立即设该视图第 1 张、位置为 1，按钮 UI 未重测 |
| [x] | 原生模式视频提示与取图 | 桌面 dev（原生模式） | 未选「仅图片」时点「用当前视图轮播」，再手动切换一次 | 提示视频会被跳过；切到的是图片 | 提示出现；切到 8743（webp 2504×1408） |
| [x] | 画册轮播循环与删除 | 桌面 dev | 新建含 3 张图的画册，设为 `album/<id>/sort/by-album-order` 切换 4 次，再删除画册并切换一次 | 按画册顺序 3 张后回到第 1 张；删除后路径回到默认（null），下一次切换写入新的默认随机路径 | 279→280→281→279；删除后路径 null、位置 0；切换后写入 `random-2937306784365644` |
| [x] | 换路径立即切到第 1 张，之后按当前壁纸续接 | 桌面 dev（窗口模式） | 设 by-id 视图后切 2 次；换成倒序视图；同一路径再设一次后切 1 次；换成只看视频的视图后切 1 次；手动设一张不在视图里的图片后再切 1 次 | 每次换路径立即设新视图第 1 张；同一路径再设不切换；之后接当前壁纸的下一张；当前壁纸不在视图里时按位置继续 | 设路径即 30，切换 31、32；倒序立即 8927，再设仍 8927，切换 8926；视频视图立即 30，切换 31；手动设 38 后切到 32，位置 3 |
| [ ] | count 出错回落 | 桌面 dev | 让设置路径失效（如插件扩展路径的插件被卸载）后切换 | 自动换成默认随机路径并从第 1 张开始，启动结果 `fallback: true` | 设置入口会先校验、CLI 不暴露写设置，未找到真机触发手段 |
| [ ] | 设置页只读路径 | 桌面 dev | 打开设置 → 壁纸 | 三个旧控件消失，显示「当前轮播路径」与迁移说明 | 仅类型检查通过，未截图 |
| [ ] | 画册右键设为 / 停止轮播 | 桌面 dev | 画册树右键「设为轮播」，再看树上轮播标记与右键「停止轮播」 | 路径为该画册默认视图，树标记与菜单状态正确 | 未点 UI；同路径的命令层已验证 |
| [ ] | 原生兼容副本 | Windows / Linux 原生模式 | 轮到 WebP / AVIF 图片 | 仍生成并复用 `wallpaper_compatible_path`，桌面正常显示 | rotator 仍把原始 `local_path` 交给原生后端；本机 macOS 未测 |
| [ ] | Android 队列 | Android dev | 设路径并开启轮播，等 WorkManager 触发，再回到应用 | 生成 `rotation_queue.json`；后台按队列换图且只换图片；回到应用后位置与当前壁纸同步 | 本机缺 Android rusty_v8 产物，`--mode android` 交叉检查未能运行，Android 门控代码仅人工复核 |
| [x] | 单测与 DSL 端到端 | 单测 | `deno task test` | 迁移框架、v001–v003、路径工具、`_kb_fc/media-type/image` 接在各类视图尾部的 count / 取行 / rank 一致 | kabegame-core：dsl_e2e 58 项全过；lib 353/355，失败的 `webview_watchdog_suspends_while_host_hidden`、`batch_adds_and_deletes_file_rows` 是并行时共享临时库的建表竞争，单独重跑均通过。前端 Vitest 574 通过。kabegame crate 的测试二进制在 macOS 上找不到 CEF framework 无法启动，rotator 的 `wrapped_position` 单测未跑 |

## metadata 冻结描述模板（`plugin run --freeze-template`）

CLI `plugin run` 加 `--freeze-template` 后，任务冻结时读一次插件包内 `kbDescriptionTemplate`，`Task::insert_metadata` 写进每行 `metadata.template`。开关只在内存中经 `CrawlTaskRequest` 传递，不入任务记录。详情面板并行获取冻结模板与插件模板，前者非空即覆盖。去重覆盖改挂新行，data 与模板一起被替换，未冻结时清空；metadata 迁移原样拷贝模板，去重按模板分区。IPC 协议升到 v4。

2026-10-26：macOS 桌面 CEF dev 真机实测（`deno task b -c kabegame-cli --data dev` 新建 dev CLI，`deno task dev -c kabegame` 启动时执行 v047 迁移，`metadata` 表新增 `template` 列）。用 `miyoushe`（V8，模板经 `__bridge.getPluginData()` 读表情映射）以 `run-cli.sh` 跑「壁纸」搜索第 1 页；经 CDP 打开预览并读取 iframe DOM，截图在会话 scratchpad。测试 id 产生的图片与任务已清理。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 测试 id 冻结模板渲染 | dev app + dev CLI | 运行 `plugin run <kgpg> --id <id>-test --freeze-template` 后，打开一张测试 id 图片的详情 | 插件详情面板以 iframe 渲染模板，不再只显示原始键值 | `--id miyoushe-ft1` 入库 60 张、3 行 metadata，`template` 全部非空且与包内 `description.ejs` 逐字节一致；`pathql query images://id_<id>/metadata_full` 返回 `template`。测试 id 未安装，详情面板以 iframe 渲染帖子卡片，原始键值 0 项 |
| [x] | 未冻结回退 | dev app + dev CLI | 不加 `--freeze-template`，用新测试 id 跑一次并打开详情 | 未安装插件时显示原始 metadata 键值 | `--id miyoushe-nf1 --no-freeze-template`：metadata `template` 为 NULL，详情面板无 iframe，显示 25 项原始键值 |
| [x] | 冻结模板覆盖插件模板 | dev app + dev CLI | 对已安装插件改本地模板后打包，用已安装 id 加 `--freeze-template` 运行 | 新图片详情使用冻结的新模板；旧图片仍用已安装插件模板 | 已安装 `miyoushe`：先用已安装 id 不冻结跑出旧图，再把加了隐藏标记的模板打包，以路径模式 `--id miyoushe --freeze-template` 跑新图。新图 iframe 含标记，旧图不含。注意：同版本重新打包后，前端内存里的插件模板缓存（`pluginFiles` 按版本 URL 缓存）在 `refresh_plugins` 后仍是旧内容，需要重载页面 |
| [x] | 去重覆盖清空模板 | dev app + dev CLI | 开启「去重时更新元数据」，先带 `--freeze-template` 跑一次，再不带参数跑同一批 | 第二次去重命中后图片改挂新 metadata，详情退回插件模板或原始键值 | 开启「去重时更新元数据」与自动去重（dev 原为关闭，测完已恢复），同一测试 id 不冻结重跑同一批：60 张 URL 去重命中，图片改挂新 metadata（如 12422→12429），新行 `template` 为 NULL，旧冻结行被 GC；详情退回原始键值。命中的旧图若是其它来源，`plugin_id` 也会改为本次 id（符合「插件下载覆盖任意来源」设计）。自动去重关闭时重跑会重复入库，不会命中 |
| [x] | bridge 按测试 id 取数 | dev app | 打开使用 `__bridge.getPluginData()` 的插件模板的测试 id 图片 | 读到测试运行写入的插件数据，模板正常渲染 | iframe 内 `__bridge.getPluginData()` 返回 `miyoushe-ft1` 的数据（`miyoushe_emoticon_map` 3105 项），正文渲染出 13 个表情图片 |
| [ ] | IPC v4 门控 | dev CLI | 主程序运行时执行 `plugin run --freeze-template`，确认走 app IPC | 新 CLI 与新主程序协议一致并走 app；连旧主程序时打印协议过旧并回退本地 | 前半部分已验证：dev app 运行时 CLI 输出「经主程序执行（版本 4.6.1）」，没有协议过旧回退，任务进入 app 任务表。连旧主程序回退本地未测（缺少 v3 主程序） |
| [x] | 迁移保留模板与去重分区 | 单测 | `frozen_template_tests` | 写回新行拷贝模板；data 相同、模板不同的行不合并；改挂到无模板行后旧冻结行被 GC | `deno task test` kabegame-core 通过 |
| [x] | v047 迁移幂等 | 单测 | `v047_metadata_template::tests` | 执行两次只加一列，旧行 template 为 NULL | 通过 |

## 图片详情「基本信息」卡片式排版

`ImageBasicInfoPanel` 从「标签：值」两列改为卡片：名称标题（两行省略）→ 源头像 + 源名 + 收藏时间（年 / 月 / 日分别可点）+ 任务按钮 → 媒体芯片（类型种类 / 格式、文件大小、像素尺寸、宽高比矩形框）→ URL 与本地路径行。宽高比框高 22px、宽按比例夹在 12–56px，接近常见比例（1.5% 内）显示 `16:9` 等，否则显示小数；框放不下文字时写在框外。路径从左侧省略、保留文件名。预览侧栏里基本信息不再与原生元数据平分高度，按自然高度显示。

2026-10-26：macOS 桌面 CEF dev 真机，韩语界面，经 CDP 打开画廊预览截图验证；截图在会话 scratchpad。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 卡片排版 | 桌面 dev | 打开一张插件来源图片的预览与详情弹窗 | 名称、源、时间、芯片、链接行按新排版显示，无大片空白 | 预览侧栏：名称两行、PixAI 图标 + 源名 + 时间 + 任务按钮、芯片两行、URL 与路径各一行，面板约 280px 高。首版名称被 flex 压成 0 高、面板平分高度导致链接行被滚出，已修。详情弹窗未单独看 |
| [~] | 筛选入口不丢 | 桌面 dev | 依次点源、年 / 月 / 日、种类、格式、大小芯片、宽高比框 | 均跳到画廊对应筛选 | 宽高比框已验证：点 16:9 图片的框后预览关闭，画廊计数 3127 → 213。其余入口沿用原 `emitGalleryFilter`，未逐个点 |
| [x] | 宽高比框 | 桌面 dev | 分别打开横图（16:9）、方图、竖图（9:16）、超宽图 | 框与图片同比例；横图与方图文字在框内，竖图文字在框外 | 2504×1408 → `16:9` 框宽 39px 文字在框内；1408×1408 → `1:1` 22px；1232×1632 → `3:4` 17px、720×1280 → `9:16` 12px、1104×1824 → `3:5` 13px，文字在框外。超宽图库里没有，未测 |
| [~] | 链接行 | 桌面 dev | 点 URL、点本地路径、点复制按钮、右键本地路径 | 打开链接 / 打开文件 / 复制成功提示；长路径保留文件名，开头的 `/` 不跑到末尾 | 两个复制按钮均弹「클립보드에 복사됨」，`pbpaste` 拿到完整 URL 与路径；路径显示 `… Lumiera （oc）.webp`。点击打开未测（会拉起外部程序） |
| [ ] | 畅游与未知来源 | 桌面 dev | 打开畅游下载的图片与无来源图片 | 畅游显示站点 host 与罗盘图标，点击打开畅游记录；未知来源显示 unknown 且不可点 | |
| [ ] | 视频与缺失字段 | 桌面 dev | 打开视频、无尺寸或无 URL 的图片 | 视频芯片用摄像机图标；缺失字段对应芯片 / 行不显示 | |
| [ ] | 暗色主题与 Android | 桌面 dev / Android dev | 切暗色主题；Android 打开详情 | 芯片、矩形框、链接配色可读；窄屏下芯片自动换行 | |

## Android 平板宽屏预览滑动切图

`ImagePreviewDialog` 的模板在 Android 上一律渲染 PhotoSwipe（`v-if="IS_ANDROID"`），但滑动回流（`swipe` / `reach-boundary` → `requestSwitch`）、换图重置、关闭通知等脚本分支仍按 `uiStore.isCompact`（宽度 < 断点）判断。平板横屏宽度超过断点时 PhotoSwipe 照样显示，滑动事件却被直接丢掉，上层 `previewedId` 不动，窗口被拉回原图。改为与模板同源的常量 `USE_PSWP = IS_ANDROID`。

滑动修好后又暴露同类问题：`ImageGridCore` 预览切图的 watch 只在 `isCompact` 时「预览与选择解耦」，平板宽屏走桌面逻辑把当前图设为选中；而 Android 上有选中即打开多选模式的 `androidSelectionModal` 栈位，压在预览之上，于是滑过之后第一次返回只清掉了这个看不见的多选，预览关不掉。该文件其它 Android 多选判断已是 `isCompact || IS_ANDROID`，补齐剩下三处（切图同步选中、多选时点空白不清空、`exitAndroidSelectionMode`）。

2026-10-26：Android 16 平板 dev 包（横屏 1163×776、竖屏 776×1163 CSS 像素）真机实测，CDP 打开画廊预览，用 `adb shell input swipe` / `keyevent BACK` 真实手势与按键，`adb screencap` 截图在会话 scratchpad。返回键问题用 debug ingest 插桩 + 包装 `modalStack.acquire` 定位，已删除插桩。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 平板横屏左滑下一张 | Android 平板 dev | 打开第 1 张，向左滑两次 | 依次切到第 2、3 张，背景网格跟随定位 | 第 1 → 2 → 3，网格高亮跟到第 3 张 |
| [x] | 平板横屏右滑上一张 | Android 平板 dev | 在第 3 张向右滑 | 回到第 2 张 | 通过 |
| [ ] | 跨页切换 | Android 平板 dev | 在一页最后一张继续左滑 | 加载下一页并切到其首张 | 未测：dev 库只有 36 张，最小页大小 100，只有一页 |
| [x] | 上划删除 | Android 平板 dev | 宽屏下在第 2 张上划 | 图片按画廊语义加入隐藏，预览切到相邻图 | 第 2 张被隐藏（共 36 → 35），预览切到第 3 张；测完用 `remove_images_from_album` 从隐藏画册移出还原 |
| [x] | 滑动后返回键关闭 | Android 平板 dev | 打开预览、左滑两次、按一次返回 | 一次返回即关闭预览，网格不留选中 | 修复前：滑一次后返回栈多出多选栈位，第一次返回不关预览；修复后栈位始终只有预览一个，一次返回关闭，无残留选中 |
| [ ] | 手机竖屏不回归 | Android 手机 dev | 打开预览左右滑、上划删除、返回 | 与修复前一致 | |
| [ ] | Web 窄屏预览 | Web | 窄窗口打开预览 | 走桌面 Dialog 分支，缩放 / 切图 / 关闭正常 | 此前 Web 窄屏渲染 Dialog 却走紧凑分支（关闭时不清理 Panzoom 等），现与模板一致 |

## Android 宽屏布局让开系统栏

targetSdk 36 强制 edge-to-edge，`MainActivity` 把系统栏 inset 注入成 `--sat` / `--sab` / `--sal` / `--sar`，由 CSS 各自留白。以前只有紧凑布局（底部 tab、主区顶部）用了它，平板宽屏的「侧栏 + 主区」两边都没垫：顶部头像和页头压在状态栏下，底部内容被导航栏盖住。现在非紧凑布局下侧栏垫上 / 下 / 左并按 `--sal` 加宽，主区垫上 / 下 / 右，背景仍铺到系统栏下面；ElDialog 的桌面样式不再排除 Android。曾试过在原生层给内容根节点加 padding、彻底去掉 safe-area CSS，但预览时图片四周会多出一圈浅色系统栏带，已放弃。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | 平板横竖屏无遮挡 | Android 平板 dev | 横屏、竖屏打开画廊、画册 | 侧栏头像与页头在状态栏下方；列表滚到底时最后一行在导航栏上方 | 横屏画廊滚到底最后一行完整、画册页三栏底部无遮挡；竖屏（776 宽，仍是宽屏布局）画廊同样正常。设置页未看 |
| [x] | 预览仍沉浸 | Android 平板 dev | 打开图片预览 | 预览铺满全屏（含系统栏下方），顶部控件不压状态栏 | 图片延伸到状态栏与导航栏下方 |
| [x] | 亀ちゃん不被导航栏挡住 | Android 平板 dev | 默认位置看亀ちゃん；把它往下拖到底、再往上拖 | 脚底在导航栏上方；拖动跟手、不跳位，拖到底被夹在导航栏上方 | 宿主 margin 等于安全区，`left` / `bottom` 改为相对安全区，拖动起点与夹取都扣掉 margin。竖屏实测：离视口底 54.6px（8 + 导航栏 47）；上拖 200px 位移正好 200px；再拖到底回到 54.6px |
| [ ] | 手机横屏刘海 / 侧边导航 | Android 手机 dev | 横屏（宽度 ≥ 768）且导航栏或刘海在侧边 | 侧栏加宽让开左侧，主区让开右侧 | |
| [ ] | 手机竖屏不回归 | Android 手机 dev | 竖屏紧凑布局 | 与修改前一致 | 只改非紧凑布局 |
| [ ] | 桌面不回归 | 桌面 dev | 打开主窗口 | 侧栏宽 64px，无多余留白 | 桌面 inset 全为 0 |
| [x] | 平板弹窗与桌面一致 | Android 平板 dev（横屏 / 竖屏） | 打开「开始收集」等 ElDialog | 与桌面同样限高、header / footer 固定、仅 body 滚动，上下让开状态栏与导航栏；宽度按组件自身 width，不再是 90vw | `dialogs.css` 原先整套规则挂在 `html:not(.platform-android)` 上，平板走 ElDialog 分支却被排除，弹窗按内容撑高（1544px > 视口 1163px），底部「开始收集」落在导航栏下。去掉平台门控、限高与边距叠加 `--sat` / `--sab`，90vw 只在 `max-width: 767.98px` 下生效。「开始收集 → 网络」实测：横屏弹窗 71–690（视口 776），竖屏 90–1058（视口 1163），宽 600px，表单在 body 内滚动，底部按钮在导航栏上方；返回键可关闭 |
| [ ] | 手机弹窗 | Android 手机 dev | 打开仍用 ElDialog 的弹窗 | 宽 90vw，限高后内容在 body 内滚动 | 手机端过去不限高 |


## Web 版前端静态资源走 CDN

生产 web 构建（`isWeb && command === "build"`）的 Vite `base` 指向 `https://cdn.kabegame.com/web/`，`index.html` 仍由二进制内嵌返回；`deploy-web.sh` 先经服务器暂存目录把其余文件 `cp` 进 OSS 挂载点 `/mnt/oss/web/`，校验入口脚本 MIME 后再换二进制。插画移到 `src/assets/`，web 用按显示尺寸压缩的 WebP、本地模式用原图，未引用的那份由 `dropUnreferencedSrcAssets` 从产物删除。

2026-10-28：macOS 宿主用 `vite build` 分别出 web / 桌面前端到会话 scratchpad（未经 `deno task build:web`，二进制未重编、未部署）。web 产物按 `deploy-web.sh` 第 0 步同样的命令上传到线上 OSS（新文件名带哈希，只增，不影响线上页面）；浏览器验证用 puppeteer 在有界面 Chrome 里让 `demo.kabegame.com` 的文档请求返回新构建的 `index.html`，RPC 仍打线上后端（10-24 版本）。

| 状态 | 项目 | 环境 | 操作 | 预期 | 备注 |
| --- | --- | --- | --- | --- | --- |
| [x] | web 产物走 CDN 前缀 | 宿主 `vite build --mode web` | 查看 `index.html` 与 chunk 内的资源 URL | 脚本、样式、modulepreload、`icon.png`、插画都以 `https://cdn.kabegame.com/web/` 开头 | 入口 `https://cdn.kabegame.com/web/assets/index-D89OIi2J.js` |
| [x] | 桌面产物不变 | 宿主 `vite build`（桌面模式） | 同上 | 资源 URL 仍以 `/` 开头 | `/assets/index-…js`、`/icon.png` |
| [x] | 插画只带一份 | 两种模式各构建一次 | 列出 `assets/` 里的 png / webp | web 只有 5 张 WebP，桌面只有 5 张 PNG，代码引用一致 | 加插件前两边各多出另一份（web 多 8 MB 原图） |
| [x] | OSS 上传与响应头 | 线上 OSS | 按 `deploy-web.sh` 第 0 步上传后 `curl` 入口脚本、CSS、WebP | JS 为 JavaScript MIME，CSS 为 `text/css`，带 `Access-Control-Allow-Origin: https://demo.kabegame.com`，支持 gzip | 47 个文件上传约 8 s；JS 为 `application/x-javascript`。直接 rsync 到挂载点会把 JS 标成 `application/octet-stream`，已改为暂存目录 + `cp` |
| [x] | 浏览器从 CDN 加载 | 有界面 Chrome，新 `index.html` | 打开 `/gallery`，再整页打开 `/surf` | 所有脚本 / 样式 / 插画来自 CDN，无失败请求、无控制台错误；吉祥物与冲浪 logo 正常解码 | CDN 35 个请求（JS 20、CSS 9、WebP 5、icon 1）全部 200，源站 `/assets/` 0 个；FCP 572 ms；站立图 344×792、冲浪 logo 540×540 |
| [ ] | 图库缩略图出图 | 有界面 Chrome，新 `index.html` | 打开 `/gallery` 等缩略图加载 | 首页缩略图正常显示 | load 后 6 s 内统计到 0 张已解码缩略图，期间没有请求空状态 / 失物图，判断是等待时间不足；之后两次复测都卡在本机客户端证书弹窗上，未完成 |
| [ ] | `deploy-web.sh` 全流程 | 宿主 + 服务器 | `deno task build:web` 后 `bash scripts/deploy-web.sh` | 先传 OSS、校验入口 MIME，再传插件、换二进制；线上页面资源全部来自 CDN | 未执行，需要重编二进制并重启线上服务 |
| [ ] | 部署后首屏 | 线上 demo | 清缓存打开首页，按慢速 4G 再测一次 | 首次绘制、首个 pageview 明显提前 | 部署前的同口径对照：不限速 FCP 6.9 s → 1.8 s，慢速 4G 18.2 s → 5.6 s |
| [x] | 本地模式插画：吉祥物站立图、冲浪 logo | 桌面 CEF dev | 经 CDP 读画廊页吉祥物与畅游页 logo 的 `currentSrc` / 尺寸并截图 | 加载 `src/assets` 下的原图 PNG，显示与改动前一致 | `/src/assets/kamechan/stand.png` 668×1540、`/src/assets/swim.png` 1254×1254，截图正常 |
| [ ] | 本地模式插画：挥手、空状态、空封面、失物图 | 桌面 / Android dev | 点吉祥物挥手；打开空画册与空图库；触发图片丢失 | 显示原图 PNG | 未在 app 里触发；构建产物里这几张也只引用 PNG |
