# 场景壁纸：显示与场景宿主

> [场景壁纸文档](../WPE_SCENE.md) 的一章：应用页的显示链、场景宿主 iframe、属性与快速路径。总体形态、各阶段状态与全部章节的索引在总览里。

## 显示：`ImageContent` → `WpeWallpaperContent` → `WpeSceneView`

2026-11-15 壁纸显示重构（`.claude/plans/wpe-import/phase-wallpaper-refactor.md`）之后，场景和网页壁纸在桌面、图库预览、应用背景走同一条
路：`ImageContent` 的 wallpaper 形态（判定 `isWpeWallpaperContentType`，在 `targetKind.ts` / `mediaMime.ts`）挂 `WpeWallpaperContent`，
它挂 `WpeSceneView`（宿主 iframe）。桌面外面再套 `Wallpaper`，只管铺放与过渡（[WPE_IMPORT.md](../WPE_IMPORT.md)「图库接入」「WPE 显示组件」）。

- **一张壁纸一个宿主**：`WpeWallpaperContent` 按图片 id 挂载，宿主自己读属性、编译、持有 GPU 设备；换壁纸、卸载都先卸载它（终止编译、
  销毁设备）。桌面换场景时新旧两层在过渡期间短暂并存（两个宿主），过渡结束卸载旧层（用户定）。
- **状态流转 loading → live / failed**（`ImageContent` 管显示）：
  - `loading`：缩略图（目标的 `previewPath`，即行的 `thumbnail_path`）打底并模糊，正中是阶段、计数与进度条（见下「加载进度」）。
    `ImageContent` 在缩略图出来时发 `ready`：桌面的 `Wallpaper` 据此开始过渡，所以桌面也看得到加载过程（以前保留上一张直到出结果）。
  - `live`：出首帧（`WpeWallpaperContent` 的 `live`）且挂上满 300 ms 才淡入揭开实时画面（`wallpaperLive`）。
  - `failed`：`WpeWallpaperContent` 报 `fail(reasons)`（编译类退回、宿主不可用、超时），当原图加载失败：实时层收起，停在清晰的缩略图上，
    底部留一行红字原因；缩略图也坏了才丢失。原因进桌面调试快照 `sceneFallback`（`; ` 连接）。
  - **超时**（在 `WpeWallpaperContent`，2026-11-15 由 10 s 改 30 s）：挂上宿主后 `SCENE_RESULT_TIMEOUT_MS = 30s` 内既没首帧也没退回（Worker 卡住、取设备挂起）时报 `fail(["render:timeout"])` 并 **卸载宿主**。**每收到一条加载进度重新计时**（见下「加载进度」），大场景慢慢加载但一直在动时不会被提前判失败。本机实测编译到首帧 0.3–0.6 s，大场景几秒；壁纸窗口 init 看门狗只等设置与目标、不等画面。编译类退回宿主仍挂着（改属性后可能重新可渲染），只有超时卸载，所以超时后不会再切回实时画面。
- **加载进度**（壁纸显示重构步骤 2，宿主 `src/progress.ts`、应用页 `wpeSceneProgress.ts`）：宿主只在**首次加载**时按阶段经 postMessage 报 `{ type: "kabegame:wpe-scene-progress", stage, done, total }`（不走 `wpe_scene_report`：只给同一页面里的父组件，每条不用过 Rust），重编译（改属性、改设置）时旧画面一直在画、不报，被新的加载取代后旧加载不再报。同一阶段 100 ms 内只发一条（阶段最后一条 `done >= total` 照发），阶段变化立即发。字面量两边各一份，测试比对。
  - 阶段：`compile`（Worker 的对象循环，每个对象之前报已处理的权重，权重 = 1 + 它的 effect 数，读完 scene.json 就知道总数；Worker 协议多一种 `progress` 消息，`client.ts` 先认它、不当读文件请求）→ `decode`（主线程解 mip，开解前报 `0 / 总数`）→ `prepare`（编译、解码完就进入 `0 / 1`：文本排版、声音、媒体、用户纹理、脚本 `init`、取 WebGPU 设备，期间没有计数）→ `gpu`（建 GPU 场景，按着色器程序计数）→ `frame`（画第一帧之前 `0 / 1`，等完视频首帧报 `1 / 1`，紧接着报 ready）。之后的管线、粒子预热、排版是同步的，发不出消息。
  - 应用页：`WpeSceneView` 只认自己 iframe 发的、格式对的消息，原样 emit `progress`；`WpeWallpaperContent` 在出结果之前转发并重新计时；`ImageContent` 的 wallpaper 形态画进度（见 [WPE_IMPORT.md](../WPE_IMPORT.md)「图库接入」），桌面同样画（新层的缩略图出来后可见）。总进度按 `WPE_SCENE_PROGRESS_WEIGHTS`（页面 5 / 编译 50 / 解码 10 / 准备 20 / GPU 10 / 首帧 5，`page` 是挂上 iframe 到第一条消息）换算；一次加载里只增不减、阶段只往前走；没有消息时按 150 ms 一拍在当前阶段区间里逼近上沿的 90%（时间常数 3 s），宿主阻塞时条也在动。
  - 「开始渲染」日志末尾带各段用时（`SceneLoadProgress.summary`）：`（等目标与设置 / 编译 / 解码 / 准备 / 取设备 / 建 GPU 场景 / 首帧 各 N ms）`，重新加载的 debug 日志同样带；权重照它调。2026-11-15 实测：3 层的小场景 931 ms 里编译 632 ms；82 层、33 个 mip 的大场景 2.4–5.9 s 里编译约一半、准备与取设备约 1/3。
  - 之后的变化：同一张场景改属性重编译时宿主在同一设备上换场景，画面一直是旧场景直到新场景就绪，`ImageContent` 不回到加载态，也不闪缩略图。改属性后不能渲染了就退回预览图，退回后又能渲染了就切回实时画面。`ready` 每个目标只发一次。
- **样式**：壁纸样式按 Kabegame 语义生效：`fill` 等比盖满、`fit` 等比放进、`stretch` 拉满、`center` 一个场景像素对一个布局 CSS 像素（iframe 里的 CSS 像素，按画布的 `pixelRatio` 换算；放不下就居中裁，预览缩小显示时构图与桌面相同）、`tile` 等比放进后居中重复。WPE 的 Free 不做。2026-11-19 起前四种做进正交投影（见上「铺放」），改样式只换投影边距与清屏色（`GpuScene.resize` 不重建 RT）；`tile` 仍是上屏这一步变（视口加 `offset + uv * scale`、重复采样器）。改样式不重编译、暂停时也会补画一帧。样式走 postMessage（`wpeSceneStyle.ts`，字面量在宿主 `sceneStyle.ts` 另有一份，测试比对）：宿主启动时请求一次，变化时 `WpeSceneView` 主动推。
- **留白颜色**：`fit` / `center` 空出的区域整屏清成 `schemecolor`，不是 `clearcolor`，这和 WPE 一致：对齐为 fill(1) / center(3) / free(4) 时用它代替清屏色（`(alignment & ~2) != 0`，`0x14017fc4c`，实测 `alignment=1` + `schemecolor="1 0 0"` 背景整片变红）。WPE 的优先级是用户值 > `config.json` 的 `general.defaultproperties.schemecolor` > 工程值 > 灰色 `0.5 0.5 0.5`；我们从宿主的属性全集取，用户值已并入，`defaultproperties` 不读（本机没有这个键），灰色兜底照搬。值原样当 0…1 的 RGB，不做颜色空间转换，alpha 为 1。作者建工程时编辑器按素材主色填 `schemecolor`（`getDominantColorFromFile`），所以留白通常和画面配套。用户改色走属性增量，就地生效。退回预览图时留白不是这个颜色，Stage 没有它。
- **指针**（2026-11-19 起）：按画布画的样式（`tile` 以外）`g_PointerPosition` 一律是窗口归一化坐标（同 WPE，render-size 步骤 0b 实测不随对齐方式变），控制点跟随点、P6c 命中都用窗口指针对裁过的 `P·V` 反投影（`GpuScene` 有 `crop` 时的分支，和 dev 探针同一套）；`tile` 仍按铺放换算（`scenePointer` / `sceneCursor`，按所在那一块算）。此前 `fit` / `center` 的指针按铺放换算到场景上，`fill` 裁切另走 P6c 修复 2 的窗口指针反投影。过渡（fade / slide / zoom）对 scene 层整层生效，曲线与 web 层相同。
- **`paused` / `interactive`**：由 `WpeSceneView` 经音量消息的 `paused` 交给垫片，垫片调用宿主的 `setPaused`（停帧冻结时钟）；`interactive` 控制 iframe 指针事件。
- **调试快照**（桌面 `Wallpaper.debugState()`）：`media` 增加 `"scene"`，`sceneFallback` 是当前层显示不了的原因。`delegatesPing()` 逐层转问（`ImageContent` → `WpeWallpaperContent`），宿主垫片首次请求音量后把 ping 交给宿主；未启动时仍由应用页应答。

图库与设置的接入：
- **图库预览**：`ImageContent` 的 `wallpaper` 形态与网页壁纸相同（`isWpeWallpaperContentType` 认 scene）。预览不看壁纸样式，和单独的图片一样完整显示：`WallpaperPreviewCanvas` 按场景分辨率布局再整体缩放，没有背景。分辨率是图片行的 `width` / `height`：导入时读入口 json 的 `general.orthogonalprojection`（`WpeProject::scene_resolution`，入口在 `scene.pkg` 里时 Rust 读包里这一个条目），所以预览一打开就是正确比例，网格、宽高比筛选与详情面板读的也是它。透视场景没有这个字段，宽高留空，画布按主屏比例。退回时预览图在这块画布里按 contain 显示。作者更新壁纸改了分辨率时行不会跟着变，这时预览多一点留白。样式由调用方的 `fit` 决定（预览 `contain` → `fit`，应用背景 `cover` → `fill`），`WpeWallpaperContent` 不读壁纸目标里存的样式（过渡取默认壁纸目标在当前壁纸模式下的有效过渡，见 [../wallpaper/MULTI_SCREEN.md](../../wallpaper/MULTI_SCREEN.md)）。
- **属性面板**：预览右栏与设置页「当前壁纸」的属性面板对场景也显示（`hasWpeUserProperties`）。场景不显示 `file` / `directory` 属性：渲染器不读用户选的文件，放行也只对网页壁纸目录生效。场景特有的 `scenetexture` / `replacetexture` 后端解析时就跳过了。改属性后垫片按本张 `metadataId` 补丁拉取并把变化键交给 `SceneHost` 的应用函数（就地写或重编译，见「属性与快速路径」）。
- **应用背景**：不按类型分支，与预览同走 `ImageContent` 原图形态，场景与网页壁纸都实时渲染（不交互）。代价是主窗口开着背景时常驻一个 GPU 设备；打开预览时与预览里的场景同时渲染。
- **画布尺寸**（2026-11-07 修正，`render/layout.ts` 的 `canvasSize`）：画布像素 = 布局尺寸 × DPR × **显示缩放**，各边取整；超过 `maxTextureDimension2D` 时宽高按同一比例缩，宽高比不变。
  - **显示缩放由父页面量**：预览画布按内容尺寸布局、再整体 `scale` 进弹窗，这个 transform 加在父页面的 iframe 元素上，iframe 里量不到（`getBoundingClientRect` 在 iframe 里量到的就是布局尺寸）。`WpeSceneView` 用 `displayScaleOf`（`getBoundingClientRect` ÷ `offsetWidth` / `offsetHeight`，两个方向取大的）量，经消息 `kabegame:wpe-scene-display`（`wpeSceneStyle.ts` / 宿主 `sceneStyle.ts` 的 `listenSceneParent`）推给宿主的 `setDisplayScale`。宿主请求样式时必回一次；iframe 尺寸变化（ResizeObserver）、窗口 resize 时量；祖先 transform 变化哪个 observer 都不触发，所以再每 250 ms 轮询，相对变化超过 1e-4 才推。量不出来（未布局、`scale(0)`）时不推，宿主保持上次的值（起初 1）。
  - 宿主帧循环也每 250 ms 核对一次画布尺寸（DPR 变化不触发 ResizeObserver）。桌面窗口没有缩放，显示缩放为 1，结果与只按 DPR 算逐位相同。
  - 修正前按布局尺寸 × DPR 渲染、超 8192 时宽高各自钳：4K 上渲染一张只显示约 1/4 面积的大画面，宽高比还被破坏，预览「适应」下多出 `schemecolor` 留边、画面缩小。
  - 脚本的 `engine.screenResolution` 按显示缩放 1 算（宿主的 `ScreenResolution`，`render/screenResolution.ts`，跨渲染器共用），预览缩小显示时脚本看到的分辨率仍与桌面一致。首次加载的 `init` 早于建渲染器，脚本第一次读时宿主按同一规则（布局 × DPR）量一次记下（`seed`）；2026-11-19 之前这时退回画布元素的缺省 300×150。
  - **`resizeScreen`**（2026-11-19）：渲染器每次量画布（构造时、ResizeObserver、帧循环的 250 ms 核对、`setDisplayScale`）都交给 `ScreenResolution.measure`，和脚本看到的值不同时同步调运行时的 `resizeScreen(宽, 高)`（帧外，先于暂停时的补画），所以 `init` 之后、渲染器建好之前变了的尺寸也会补一次。照 WPE：窗口 `WM_SIZE` → resize `FUN_14017f1b0` 改完 `g_Screen` 尺寸、重建 RT 之后，在 wp.asm `0x14017f700`–`0x14017f7c8` 发给全部 `init` 已跑（状态 2）、导出了它的脚本，按登记顺序，场景标志 `& 0xc000000` 时整轮跳过；参数是 dll `CallCallback` 第 2 号分支（`0x18164e6fa`）建的原型为 `Vec2.prototype` 的新对象，自有 `x`、`y` 是单精度的新尺寸（`max(·, 2)`）；返回值丢弃，出错只禁用这个回调；首次创建不调（加载时那次 resize 早于 `init`）。有意不同：WPE 不比较新旧（还原窗口、设备重建时同尺寸也会再调），我们的量是定期的，只在变了时调。预览放大只改显示缩放，不触发。语料只有 `3838286359`（按 `screenResolution` ÷ 1920×1080 改文本层的 `pointsize` / `maxwidth` / `scale` / `origin`，运行中字段就地重排）；WPE 那边没有运行中改测试窗口尺寸的工具，以读码为准（`TODO:[WPE_SCENE_MCP]`），dev 宿主里改 iframe 尺寸核对过回调与字号。
  - **预览放大与像素预算**（2026-11-19 方案 A 第 3 步，[WPE_IMPORT.md](../WPE_IMPORT.md)「预览放大」）：量到的显示缩放含 Panzoom 的放大，场景目标又按画布像素画，所以放大多少画布就跟到多少，放大后真的更清楚。主窗口（图库预览、应用背景）设预算：`WpeSceneView` 上报 `sceneDisplayScale(实测, { layout, dpr, budget })` = `min(实测, √(SCENE_CANVAS_PIXEL_BUDGET / (布局宽 × 布局高 × DPR²)))`，预算 3840×2160 等量像素，到这以后再放大只是拉伸；桌面壁纸窗口（`WINDOW_KIND === "wallpaper"`）不设预算，只受设备纹理上限。实测 dino_run 预览 100% / 223% / 1000% 的画布 = 场景目标为 976×549 / 2172×1222 / 3839×2160，不重编译。`zoom` 由预览画布 `provide`（`WALLPAPER_PREVIEW_ZOOM`），放大倍数一变下一帧补量一次（Panzoom 也在 rAF 里写 transform），不等轮询。2026-11-15 到 11-18 的规则是封顶到 1（布局 × DPR），因为那时场景目标按场景分辨率画、再大也只是拉伸。

**验证**（2026-11-01，本机 NVIDIA Lovelace，有 `texture-compression-bc`）
- **单测**：`render/render.test.ts` 覆盖矩阵、四边形与 cover、BC 行跨度与 mip、uniform 打包、混合、顶点布局、时钟与节流；设置 `KABEGAME_WPE_ROOT` 后另对 P1 三张样本跑一遍纯逻辑部分。
- **三张 P1 样本**：主窗口真机渲染，与 `preview.jpg` 的中心方形裁切对比。
  - eagleflag、deep_space 构图、方向与颜色一致；deep_space 的旋转取反后差异变大，正角度逆时针得到确认。
  - beach 的几何对上了：把 y 翻转后差异翻倍。作者预览图整体更亮、亮部带柔光、所有图层偏移约 30 px，但与 WPE 桌面实拍（16:9 全屏）对照时构图重合、平均亮度差约 1%，说明是预览图另有后期。**对照以 WPE 实拍为准，作者 `preview.*` 只作参考。**
  - 三张都在动；eagleflag 传 `flagcolor2: "0 0 1"` 后星形变蓝。
- **Tint**：在应用页用 wasm 翻译本机语料 167 对，其中 153 对成功；306 个模块经 `createProgram` 全部通过，0 error / 0 warning。不加前言时只有 `depthparallax` 片元 1 个 error。
- **scene 层（P1-5）**：
  - 单测（当时）`components/wallpaper/WallpaperStage.scene.test.ts`（`WpeSceneView` 用替身；2026-11-15 随 Stage 删除，场景的用例现在在 `WpeWallpaperContent.test.ts`、`ImageContent.wallpaper.test.ts` 与桌面的 `Wallpaper.test.ts`）覆盖类型判定、loading 期间不显示也不发 `ready`、首帧直接淡入、退回才挂预览图、超时、迟到的首帧、没有预览图报错、场景与图片 / 场景互切（同一时间一个实例）、带过渡的淡入淡出、target 置 null。
  - 图库预览：eagleflag、deep_space、beach 实时渲染。其余默认场景与工坊场景（12906，以及预览图是 gif 的 12900，gif 照常动）显示预览图，没有报错。场景 / 网页 / WPE 视频 / 普通图片之间来回切，50 ms 采样始终最多 1 个场景实例、1 个画布，切走后画布清零。
  - 时间线：能渲染的场景从切换到首帧之间只有加载态，没有预览图。eagleflag 改旗帜颜色立即生效，重编译期间画面状态不变。
  - 桌面壁纸窗口：eagleflag 实时渲染、在动；工坊场景显示预览图；图片 → 场景期间保留原图片直到首帧。当时 Wallpaper Engine 也在跑，WorkerW 下 Kabegame 的窗口在 WPE 窗口之上，桌面上看到的是 Kabegame。
  - 预览与桌面同时渲染 beach 时，两边帧率监视器都在 141–144 fps。切换和重编译的瞬间，主窗口最低会掉到 36–72 fps。
- **P2a**（2026-11-01）：
  - 单测：`render/graph.test.ts`（合成 RT 计数与上屏 pass、bind / compose / copy / swap、快照时机、fbo 尺寸、效果矩阵）、`compile/p2a.test.ts`（档位解析、脚本静态规则、能力表裁决、内置 uniform 表与渲染器一致、FreeImage 区间与解码缓存，以及 vortex / bedroom / deep_space 的语料结构）。
  - 能力表前后对比（本机 29 张，`exhaustive`）：新解锁 razer_vortex；razer_bedroom 从 34 项降到只剩 `value:script`；其余场景去掉的都是噪音项，新报出的都是真不支持（RG88 / R8 纹理、音频频谱 / 视差 uniform、工坊着色器翻译失败、引用别的图层的合成 RT）。快速路径下退回场景每张只读 2–4 次。
  - 真机（dev，NVIDIA Lovelace）：vortex 的图库预览、应用背景与桌面壁纸窗口都实时渲染（「3 层、3 个程序」，无 Tint 告警，1 秒两帧变化 16–23%）；eagleflag / deep_space / beach 照常；四档后处理切换时三个实例都在 0.25–0.7 s 内重载，bedroom 按档位报 `postprocess:*`；同一份解码缓存下 vortex 第二次编译不再解码 PNG（149 ms 对 296 ms）；bedroom 强制渲染的构图与作者预览一致，脚本驱动的颜色取静态值。
- **P2b**（2026-11-01）：
  - 单测：`render/bloom.test.ts`（可用级数、N、RT 取整、HDR 参数与 bedroom / shimmering_particles / 工坊 3286859278 抓帧常量逐位相等、LDR / HDR 步骤序列与 RV0、bloom pass 自查）、`compile/p2b.test.ts`（档位 / 泛光 / HDR 判定含属性对象、参数缺键与生效值、编译期泛光链与 `material:missing`、`g_RenderVar0` 只在泛光 pass 放行、brightness、宽松 JSON；语料：bedroom 开启 / 超高档泛光着色器全部翻译通过、COMBO 与材质名对上）。
  - 链路隔离（6 组抓帧，dev 探针）：LDR 的 1/4、`_rt_Bloom` 与最终输出最大差 1/255（≤ 0.009% 的通道）；HDR 的 L0（下采样后、上采样后）逐值相同，只有 bedroom 一个像素差 1 个 FP16 ulp；HDR 最终输出（WPE 线性 FP16 → sRGB 8 位）最大差 1/255，0.4–0.9% 的通道，来自两边在不同空间存 FP16 的舍入；bedroom 开启档泛光全 0 时输出与输入逐字节相同。
  - 真机：关闭档 bedroom / vortex / P1 三张与 P2a 逐字节相同；超高档 vortex 与 P1 三张（`bloom: false`）也逐字节相同；三档切换后 bedroom 只剩 `value:script`；bedroom 超高档强制渲染构图与 WPE 抓帧一致（灯色由脚本决定，静态值不同）；4K 单实例逐帧耗时（编码 + 等 GPU 完成）关闭 5.2 ms、超高 6.4 ms。

## 场景宿主（P3-0，进行中）

设计见 PLAN.md 的 P3-0「形态更新」：编译、渲染与已实现的 P3b 场景脚本都在独立的 `file:` iframe（场景宿主）里；脚本另用其内的同源子 frame 运行，见 [SCRIPT.md](SCRIPT.md)「场景脚本（P3b）」。场景宿主与网页壁纸共用 sandbox 和 `wpe-web-capability`；垫片负责属性补丁与 ping / pong，`SceneHost` 负责加载、渲染、后处理档位和状态上报。应用页的 `WpeSceneView` 只承载 iframe，按实例号认领状态事件。

- **项目** `apps/wpe-scene`：独立的纯 TS + Vite 前端项目，不用 Vue（workspace 成员，依赖全用根 `node_modules` 里已有的；类型检查 `deno task --cwd apps/wpe-scene typecheck`），`base: "./"`。`src/compile/`、`src/render/`、`src/wpesl2wgsl/`、`src/dev/` 均从应用页迁入，`SceneHost` 在首次属性包到达后才加载，后续变化走应用函数（P3a：就地写或重编译，见下）；不直接订阅图片事件。Worker 为自包含 IIFE，wasm 仍由主线程获取、编译后传给 Worker。
- **产物位置**：应用的 `resource_dir`，即 exe 旁的 `resources/wpe-scene/`。
  - dev：`vite.config.ts` 默认输出到 `<CARGO_TARGET_DIR 或 target>/debug/resources/wpe-scene`。`WpeSceneHostPlugin`（`scripts/plugins/wpe-scene-host-plugin.ts`）在 `deno task dev -c kabegame` 开始时构建一次；之后改宿主跑 `deno task --cwd apps/wpe-scene build --mode development`（或带同一 mode 的 `watch`），重载 iframe 即生效，不重编 Rust。
  - 为什么 dev 不走 tauri-build 复制：它只在 `build.rs` 重跑时把 `src-tauri/kabegame/resources/**` 复制进 `target/<profile>/resources`，而 resources 目录有变化本身就会让 `build.rs` 重跑、主 crate 重编、dev 重启应用。dev 同时删掉 `src-tauri/kabegame/resources/wpe-scene` 里上次 prod 构建的残留，免得 `build.rs` 重跑时盖掉 dev 产物。
  - prod：`deno task b` 时构建到 `src-tauri/kabegame/resources/wpe-scene`（gitignore），经 tauri.conf.json 的 `resources/**/*` 打进安装包，安装后同样在 exe 旁的 `resources/wpe-scene`。
  - 只在桌面 standard 模式、不带 `--skip vue` 时构建；Android / Web 不构建。
- **地址**：`get_wpe_scene_host_url`（只给主窗口 / 壁纸窗口的应用页，它们免 ACL）返回 `index.html` 的 `file:///` 地址，盘符大写（Chromium 规范化后的形式，文档 URL 与 IPC 来源因此逐字相同）；宿主没构建时报错。应用页加载时附加 `kbScene=<图片 id>`、`kbInstance=<实例号>`，sandbox 同网页壁纸（`webSandbox.ts` 的 `WEB_SANDBOX`）。实例号区分同一窗口中的预览与应用背景。
- **P3-0b 加载与 ping**：`WpeSceneView` 首次收到本 iframe 的可信音量请求时才 emit `alive`；`WpeWallpaperContent.delegatesPing()`（桌面经 `Wallpaper` → `ImageContent` 转问）此后把桌面 ping 交给场景宿主垫片，换场景或卸载时收回。宿主没起来时仍由应用页应答，避免反复重载；宿主脚本卡死时垫片不再应答，壁纸窗口看门狗会重载。暂停和音量走与网页壁纸共用的消息协议；状态与日志走 `wpe_scene_report`，日志 target 是 `kabegame::wpe_scene_host`。
- **开发与测试**：dev 构建用 `--mode development`，`vite.config.ts` 的 `__SCENE_DEV__` 只在该模式安装 `window.__kabegameSceneProbe`。CDP 应先按 frame URL 中的 `/wpe-scene/index.html` 选宿主 frame，再调探针。`deno task test -c kabegame --skip cargo` 依次运行 `apps/kabegame` 与 `apps/wpe-scene` 的 Vitest；宿主可单独运行 `deno task --cwd apps/wpe-scene test`，语料测试继续使用 `KABEGAME_WPE_ROOT`。
- **`file:` 访问范围**（`wallpaper/wpe_scene_host.rs` 的 `access_scope_of`，就是注册给 runtime 的解析器：宿主目录优先，其它路径照旧按网页壁纸目录）：
  - 宿主目录里的文档：根为宿主目录，另放行 WPE 安装目录（`wpe::discover::engine_dir`）的 `assets/` 与 `config.json`、文本对象要读的系统字体文件（后端按平台把 13 个 WPE 字体名解析成本机文件、逐个放行，P6b 1b / 1d2，见 [TEXT.md](TEXT.md)「字体引擎 `wpefont`」），以及库里全部 `x-wpe/scene` 行的目录和用户为各场景选的 `scenetexture` 文件（P11b）。
  - 场景目录与用户选的纹理文件由网页壁纸目录索引顺带维护（`WpeWebDirIndex::scene_grants`；目录随 `images-added` / `images-deleted` / 带 `localPath` 的补丁更新，纹理文件按这张场景当前的 metadata **覆盖**，`metadataId` 补丁到达时与 `wpe_web_get_state` 返回前各写一次，同网页壁纸的 `file` 属性），但**不**构成网页壁纸范围：场景目录里的 `file:` 文档什么都读不到，应用页也不能把 iframe 导航进场景目录。
  - 应用页导航 iframe：目标只能落在宿主目录（runtime 对导航目标去掉放行项）。
  - 宿主目录、WPE 安装目录与系统字体在启动时（`init_heavy_globals`）和每次取地址时刷新，闸门只读内存。
  - 范围按文档路径算、不分实例：宿主能读库里所有场景目录与 WPE 资源。按实例收窄要让解析器拿到文档 URL 的 query，以后再做。
- **IPC**：两份 capability 叠加。
  - 网页壁纸的 `wpe-web-capability`（`file:///*`）同样匹配宿主，网页壁纸的命令与事件宿主都有：`wallpaper_pong`、`wpe_web_media_subscribe`、`wallpaper-ping` / `wpe-scene-clear-storage` 监听。用户属性（2026-11-21 起）由父页面 `WpeSceneView` 推送：它按图片 id 调 `wpe_web_get_state`（只给应用页），宿主 iframe 的 load 后推整份、之后推增量（`useWpeStateDelivery`，协议 `wpeWebState.ts`），返回前按同一份 metadata 覆盖这张场景的 `scenetexture` 放行（P11b）；宿主拿不到状态，也收不到设置与图片事件。
  - 暂停与音量沿用父页面到垫片的 `kabegame:wpe-volume` 消息，新增 `paused`；垫片只在值变化时调 `setPaused`，首次全量属性交付前就已暂停的，交付后补调一次 `setPaused(true)`。`SceneHost` 首次属性包到达后才加载，渲染完成后经 `wpe_scene_report` 报 `ready`，日志经同一命令进入应用日志。
  - 场景专用命令：`init_pre` 里 `add_capability` 注册 `wpe-scene-host-capability`，`remote.urls` 只有宿主 `index.html` 的确切地址（URLPattern 特殊字符逐个转义），不用路径通配；`frames: "sub"`，窗口是 main 与壁纸窗口 label 池（`wallpaper::WALLPAPER_LABELS`，每块屏一个壁纸窗口）；放行 `wpe_scene_target`（场景目录与 `sceneAssets`）、`wpe_scene_files`（场景查找范围（散文件、`scene.pkg`、WPE `assets`）的全部文件，脚本的 `__workshopId` 改写用，见 [SCRIPT.md](SCRIPT.md)「运行时建层（P6d3b）」）、`wpe_scene_shortcut_icon`（P11d）和 `wpe_scene_report`（`ready` / `fallback` 以 `wpe-scene-status` 事件回到调用方窗口，带实例号；`log` 写 tracing）。

### 属性与快速路径（P3a）

WPE 改属性不整场重载：加载期把每个 `{user}` 绑定登记成「属性名 → 目标 + condition」，运行时按增量逐键写字段再调改值回调（`p3-script-REPORT.md` I3）。P3a 照这个形状做，先不碰脚本：

- **一个应用函数，两个来源**：垫片入口 `applyUserProperties(δ)` 只转调 `apply(δ)`。加载期传全集、运行时传增量，先并进累计全集（只跳过没有值的项，按值去重、保留 `type`，不学 WPE 的整项覆盖；哪些项算全集见下面「取值规则」），再按编译期产出的 `bundle.bindings` 分成两组：**就地写**交给 `SceneRenderer.applyBindings`（写之前先问 `SceneState.needsRecompile`：打开带不支持项的 effect、切换不能就地的图层、打开没有泛光链的场景都要重编译，这时一条都不写）；只要**有任意一条重编译目标**，就带全集整场重编译（重新解析、翻译、建 GPU 场景）。
- **就地写的范围**：材质常量（`usershadervalues` 与 `constantshadervalues` 的 `{user}`）、图层 `origin` / `scale` / `angles` / `alpha` / `color` / `brightness` / `parallaxDepth`（P5a）、图层 `visible`（含条件可见）、effect `visible`、`general.bloom`、泛光参数（含级数）、`GENERAL_FIELDS` 的字段、用户纹理（`scenetexture` 属性，P11b）。重编译日志是 `debug`（用户不关心；看探针 `stats()` 判断是否走了快速路径）。
- **取值规则**（2026-11-14 修复，`ignore/p3a-missing/` 与 WPE 逐项对照）：
  - **全集里有哪些项**（2026-11-21 `kbprops-kinds` 实测，修 2974757317 的悬浮窗）：工程 `general.properties` 里**带 `value` 键**的每一项都在，不看 `type`：`text`、`group`、不认识的类型、没写 `type` 的都算，值为 `null` 的也算（读到 `null`）；没有 `value` 键的不在。`engine.userProperties` 就是这个全集；首次 `applyUserProperties` 的参数再去掉没写 `type` 的项。后端 `scene_user_props`（`commands/wpe_web.rs`）照这条给宿主：面板能编辑的类型取面板的归一化值，其余项原样给 `{ type, value }`、没写 `type` 的只给 `{ value }`；宿主 `mergeProperties` 只跳过没有值的，`SceneScriptRuntime.applyUserProperties` 挡掉没有 `type` 的。以前三层都跳过 `group` / `text` / 空值，作者拿说明文字属性当初始化开关的脚本（2974757317 的 22 段 `origin` 脚本只在收到 `text` 项 `xian` 时给 `speed` 赋值）读不到，图层位置全是 NaN。网页壁纸的属性（`resolve_web_user_props`）没有对照过，仍按旧规则。
  - 绑定的属性不存在（`project.json` 没声明、也不是 WPE 的内置项）时一律保持 `value`、不比 condition（`model.ts` 的 `resolveValue`；可见性、数值字段、脚本属性都实测过），绑定照样登记。
  - WPE 注入的 14 个内置属性（`alignment*`、`rate`、`wcc_*`、`wec_*`，`compile/builtinProperties.ts`）算存在：编译期全集、宿主首包、`init` 里的 `engine.userProperties` 与首次 `applyUserProperties` 都带着，值是 WPE 默认值，工程声明了同名属性时以工程的为准。`alignment` 照视频壁纸已有的样式对应取（fill / tile 0、fit 1、stretch 2、center 3），运行中改样式作为一条增量走应用函数；其余没有对应设置，取默认值。我们不实现对齐与颜色校正，这些只是数据。
  - 图层标量 `alpha` / `brightness` 照 WPE 的 float setter 不收布尔（条件换成的、布尔属性本身、JSON 里直接写的布尔）：编译期留 `value`（它也是布尔就是 1），就地写不写、不标脏；图层向量字段与材质常量本来就是这样。
  - 空串 condition 算没写条件（`model.ts` 的 `userCondition`，编译期取值与绑定登记都经它，`p3am-empty` 实测）。
  - 图层与 effect 的 `visible` 是同一个 bool setter，只收布尔：不带条件、属性值是数字或字符串时写不进，保持 `value`（编译期 `boolFieldValue`，就地写不写、不标脏；`p3am-empty`、`p3am-num` 实测）。`solid` 没有依据，照旧按「不是 `false` 就算真」。
- **重编译原因**：

  | 原因键 | 触发 | 为什么要重编译 |
  |---|---|---|
  | `postprocess-hdr` | `general.hdr` | 场景目标格式随 HDR 变 |
  | `layer-structure` | `colorBlendMode` / `size` | colorBlendMode 决定 passthrough 有无；size 决定几何与合成 RT（已定 5：不照 WPE 的「运行中改了不生效」） |

- **和 WPE 的对照**（P3c 后的最终形态）：

  | 属性 | WPE 改值 | 我们 |
  |---|---|---|
  | 图层变换、`alpha`、`color`、`brightness`、`visible`（含条件） | 逐帧读或标脏 | 就地 |
  | 材质常量、`usershadervalues` | 标脏重传，不重编着色器 | 就地 |
  | effect `visible` | 重算合成次数与 pass 数，变了才重建该图层 | 就地，单图层重排；打开带不支持项的 effect 走重编译 |
  | `general.bloom` | 每帧读 | 就地；没有链时打开走重编译 |
  | 泛光调节项，含 `bloomhdriterations` | 脏位，下一帧开头重算 | 就地 |
  | `clearcolor`、`clearenabled` | 只改字段，脚本之后每帧读 | 就地，`encode` 每帧读 |
  | `ambientcolor`、`skylightcolor` | 回调拷进渲染上下文 | 就地，脏位刷 uniform |
  | `fov`、`nearz`、`farz`、`camerafade` | 只改字段 | 只存值，效果随 P5 / W6 |
  | `camerashake*`、`cameraparallax*`、`zoom`、图层 `parallaxDepth` | 只改字段，相机更新与绘制时重读 | 就地，渲染器每帧读（P5a） |
  | `general.hdr` | 运行中改不生效，加载时也只读 JSON | 重编译，改值即生效（有意不跟） |
  | 图层 `size` | 只改字段，不重建几何，画面不变 | 重编译，改值即生效（有意不跟） |
  | `colorBlendMode` | 没有实测，推断属图层结构 | 重编译 |
  | 相机 `eye` / `center` / `up` | 不能绑 | 不登记绑定 |
  | COMBO | 不能绑，写成对象时进程断言中止 | 报 `combo:user-binding` |
  | `usertextures` | 下一帧开头重跑材质的纹理解析，按当前值换该槽纹理 | 属性来源就地换（解码完的下一帧，P11b，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「用户纹理（P11b）」）；封面同一张来源表、同帧换（P11c，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「媒体（P11c）」）；快捷方式图标同一张来源表，取到图标的下一帧换（P11d，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「快捷方式（P11d）」） |

- **没有任何绑定引用的属性**（只给脚本用、或作者声明了却没绑）：P3a 什么都不做，不再重编译。
- **目标用 scene.json 坐标做稳定键**（`objects/<i>`、`objects/<i>/effects/<j>/passes/<k>`、`general`），不用 bundle 下标：未启用的 effect 不进 bundle，下标会随属性值移位；3b 的脚本 realm 跨重编译保留，脚本手里的图层对象也要按这个键找回。
- **加载期间的增量不丢**：每次编译记下所用属性的裸值快照（`compiledWith`）；新场景换上后与当前全集比较（`pendingChanges`），差异再走一次应用函数。加载以退回告终时同样比较，有差异就按当前全集再编译一次（第二次用的就是当前全集，不循环）。
- **退回预览图期间**：没有 bundle 可就地写，任何属性变化都整场重编译一次（改了可能就能渲染，例如关掉不支持的 effect）；仍不支持就照旧退回，不循环（2026-11-03 真机：bedroom 改一项只编译一次）。
- **拖动不跟手（已接受）**：属性面板的滑块每次 `@input` 只更新草稿，写库是尾随 300 ms 去抖、同一时刻只有一个在途，颜色要取色器确认后才发。所以拖动过程中不会逐次写库，宿主在停顿 ≥ 300 ms 或松手后才收到一次增量——场景那时才变，与 WPE 的逐帧跟手不同（已定 6：不加不落库的实时通道）。快速路径本身按「逐帧调用」设计：一次就地应用是 O(该键的绑定数) 的 CPU 计算加下一帧每个脏 draw 一次 `writeBuffer`，3b 的脚本每帧写常量也走它。
- **漏登记是唯一的坑**：编译期某处读了属性却没登记，改了既不就地写也不重编译（表现为「改了没反应」）。新增读取用户属性的编译点时必须同时登记；`p3a.test.ts` 把编译期属性表包成 `Proxy` 记下读过的名字，对本机全部语料断言都在 `bindings` 里。
- **dev 探针**：`window.__kabegameSceneProbe.host` 给 `state()`（当前 `SceneState` 与绑定表）、`stats()`（就地应用次数、重编译记录、`render()` 的 CPU 用时均值 / p95；`applied` 按批计数，一批变化没有重编译目标就记一次，含只改了没有绑定的键；`recompiled` 只记就绪状态下的重编译，退回预览图期间的重编译与退回后的补编译不记，要看宿主控制台或应用日志的「退回预览图」warn）、`renderFrame(t)`（按固定 `g_Time` 渲染**当前**场景并读回 SHA-256，与 `renderFrame` 的整场重编译结果逐字节比）。

**实测**（2026-11-02，dev、主窗口；没有壁纸窗口，当前不是窗口模式，没有改用户的壁纸设置）。由应用页经 CDP 调命令拿地址、建 iframe，在宿主 frame 里执行：

| 项 | 结果 |
|---|---|
| 来源 | 文档 `file:///D:/Codes/kabegame/target/debug/resources/wpe-scene/index.html`；`self.origin` 为 `file://`；`isSecureContext: true`；子 frame 有 `__TAURI_INTERNALS__` |
| 入口与模块 | Vite 默认产物 `<script type="module" crossorigin>` 照常执行；`import("./x.js")` 加载宿主目录里的模块成功。不需要改成经典脚本 |
| WebGPU | nvidia / lovelace，有 `texture-compression-bc`，`webgpu` 画布可配置；纯 TS 宿主的画布同一帧读回 `[28, 28, 40, 255]`（清屏色） |
| rAF | 窗口可见时宿主与主页面同测 2 s，都是 144 fps、最大间隔 7 ms（窗口被遮挡或熄屏时两边一起降到约 1 fps）。CEF 09 之前，同一页面里有 N 个同进程 iframe 时，每个 widget 每帧都调整页的 `Page::Animate`，宿主 rAF 因而每帧回调 N 次：2026-11-02 三宿主共进程时，主窗口两个宿主各 288.5 次/秒、不同时间戳 144.5 个/秒，壁纸窗口唯一宿主 144.5 次/秒；渲染器按时间戳跳过重复回调，`GPUQueue.submit` 约 60 次/秒。CEF 09 起每个 frame widget 只服务自己 local root 的文档；2026-11-03 Windows dev 主窗口两个宿主各 144.5 次/秒、不同时间戳各 144.5 个/秒，壁纸窗口宿主与应用页也各 144.5 次/秒；宿主内 `about:blank` local 子 frame 与宿主各 145 次/秒。网页壁纸 corsair_collection 与 vortex 宿主同在主窗口时各 144.5 次/秒（修复前此布局为 288）。透明度为 0 的场景宿主（退回预览图或还在加载）现只有 1.5–2 次/秒；tracing 未见宿主主线程长任务，限流层级及修复前为何满速未查清。vortex 淡入未受影响：桌面与应用背景新宿主的首次 rAF（930175 / 930176 ms）与场景层出现 `live` 类（930177 ms）相隔 1–2 ms，之后无大于 40 ms 的间隔；预览路径同样。P3b 的 `update` 已接在渲染器实际渲染帧的状态同步之前，不按原始 rAF 回调次数推进 |
| `fetch(file:)` 放行 | razer_vortex `scene.json`（5395 B）、`assets/shaders/genericimage2.frag`、WPE `config.json`、工坊 2932157836 的 `scene.pkg` 整读 27,265,482 B；`Range: bytes=0-15` 得 16 B（`PKGV0018`）、`bytes=1000-1999` 得 1000 B，状态都是 200、没有 `Content-Range`；宿主自己的文件 |
| `fetch(file:)` 拒绝 | `C:\Windows\win.ini`、Kabegame 数据目录的 `settings.json` / `images.db`、网页壁纸 corsair_collection 的 `index.html`、视频壁纸目录的 `project.json`、WPE 安装目录里 `assets` 之外的 `version.json`：都是 `TypeError: Failed to fetch`；日志 `deny file: … (outside \\?\D:\…\wpe-scene; grants 40; OutsideRoot; requester Document("…\wpe-scene\index.html"))`（40 = WPE 两项 + 38 张场景目录） |
| Worker | `new Worker("./x.js")`（classic / module）与 blob worker 都能起来；但 worker 里的 `fetch(file:)` 全部 `Failed to fetch`（日志 `requester Deny`：worker 的请求归属不到文档）。编译 Worker 要读文件仍得由宿主主线程代读 |
| `import(blob:)` / `new Function` / `WebAssembly.compile` | 都可用（`file:` 文档没有 CSP） |
| invoke | `get_wpe_scene_postprocess` 成功、`wallpaper_pong` 成功，`wpe_web_pull_state` 过 ACL 后报 `not inside a web wallpaper`；`get_wpe_media_integration` / `get_wpe_scene_host_url` / `get_supported_image_types` 报 `Command <name> not allowed by ACL` |
| listen | `setting-change` / `image-changed` / `images-change` / `wallpaper-ping` 成功；「场景后处理」改一次再改回，收到两条 `{ type: "setting-change", changes: { wpeScenePostprocess } }`；`images-added` / `app-log` 报 ``event `<name>` is not allowed to be listened by ACL`` |
| 网页壁纸不受影响 | 同一窗口里的网页壁纸 iframe 照常 `wpe_web_pull_state`、监听 `image-changed`，调 `get_wpe_scene_postprocess` 被拒 |
| 隔离 | `parent.document`、`top.location.href` 报 `SecurityError: … Blocked a frame with origin "file://" from accessing a cross-origin frame.` |
| 宿主里再嵌的 frame | `about:blank` 继承宿主来源，权限同宿主；`srcdoc` / `blob:` 报 `Origin header is not a valid URL`；导航到宿主目录或场景目录里别的文件时只匹配 `wpe-web-capability`，与宿主自己拿到的网页壁纸权限相同 |
| 同窗口的其它 `file:` frame（接受） | 补丁 04 让 `file:` 文档互相同源、同进程。同一窗口里同时有宿主与网页壁纸 iframe 时，宿主经 `top.frames[i]` 能读网页壁纸的 DOM、以它的身份调 `wpe_web_pull_state`（拿到 `user` / `directories`），并借它的 `fetch` 读它的目录（宿主自己直接读被拒）。网页壁纸之间本来就如此，2026-11-02 定为接受 |
| `localStorage` | 可用，与所有网页壁纸同为 `file://` 来源、共用一个存储区（读到网页壁纸写的 5 个键）；2026-11-02 定为允许共用 |
| 进程隔离 | 宿主是独立的 `iframe` target（OOPIF）；宿主忙等 3 s 期间，父页面 10 ms 计时器的最大间隔 29 ms。CEF 08 之前，2026-11-02 壁纸窗口、应用背景、预览三个宿主共用 `file:` 渲染进程 29500。CEF 08 起子 frame 不跨 browser 复用 renderer；2026-11-03 Windows dev 壁纸窗口宿主在进程 61204，主窗口两个宿主同在 74360，主窗口应用页 25184、壁纸窗口应用页 32780。桌面换场景后新宿主仍在 61204、没有回流到 74360；壁纸窗口整窗重载未测。同一窗口的场景宿主与网页壁纸仍因同源、同 BrowsingInstance 而共进程；预览宿主卡死仍会连带应用背景，但不影响桌面。卡死后 iframe 不自动重载，恢复方案见后续 |
| 资源开销 | CEF 08 之前，2026-11-02 三个宿主共进程时私有内存 55 MB。2026-11-03 Windows dev 拆分后，壁纸窗口宿主进程私有 30 MB（当时显示的 12888 退回预览图、不渲染），主窗口宿主进程 84 MB（12888 + 实时 vortex）；多出的一个进程约 30 MB。一个 4K vortex 宿主约占显存 120 MiB（日志估算渲染目标 63 MiB，另有纹理与画布缓冲），GPU 进程私有内存约 50 MB |
| dev 迭代 | 改宿主、`vite build`、重载 iframe，新文件即生效，Rust 不重编 |
