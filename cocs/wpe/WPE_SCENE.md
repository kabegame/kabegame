# Wallpaper Engine 场景壁纸（`x-wpe/scene`）

> 状态：阶段 3 P1-0（着色器翻译器 `wpesl2wgsl` 与 wasm 构建链）、`scene.pkg` 读取、P1-1 导入、P1-2 `sceneAssets`、P1-3 前端编译管线、P1-4 渲染器（`wpe-scene/render/` + `WpeSceneView.vue`）、P1-5 接进 `WallpaperStage`（scene 层；2026-11-15 起改由 `WpeWallpaperContent` 挂宿主，见 [scene/HOST.md](scene/HOST.md)「显示」）已落地：图库预览与桌面壁纸窗口都实时渲染能渲染的场景，其余显示作者预览图。
> P2a（图层渲染图、effect 链、colorBlendMode、`_rt_FullFrameBuffer` 快照、FreeImage `.tex`、设置「场景后处理」与 `disabled` 档）已落地：本机当时 29 张里新解锁 razer_vortex；随后 P3b 解锁 razer_bedroom，见 [scene/SCRIPT.md](scene/SCRIPT.md)「场景脚本」。
> P2b（泛光与 HDR，「开启」/「超高」档）已落地：LDR 泛光链、HDR 8 级金字塔与收尾都用 WPE assets 原件翻译，链路隔离验证与 WPE 抓帧逐像素一致（见 [scene/RENDERER.md](scene/RENDERER.md)「泛光与 HDR」）；bedroom 开启或超高档可见光晕。
> P3-0b：编译、渲染与 dev 探针已迁进 `apps/wpe-scene`，应用页只承载 iframe；画面与 ping 的真机回归待验收。
> P3a（属性绑定表与就地写）已落地；P3b（场景脚本运行时，最小 API）进行中：razer_bedroom 已实时渲染，见 [scene/SCRIPT.md](scene/SCRIPT.md)「场景脚本（P3b）」。
> P4a（图层层级、粒子底座与档 1、`instanceoverride` 就地生效、粒子生命周期）已落地：新解锁 shimmering_particles 与工坊 3062029089；工坊 3304642534 的脚本用到未实现的 API，被新加的脚本 API 检查（`script:api:*`）挡住，仍显示预览图。见 [scene/RENDERER.md](scene/RENDERER.md)「层级（P4a）」 [scene/PARTICLES.md](scene/PARTICLES.md)「粒子（P4a）」。
> P4b（纹理格式 R8 / RG88 / DXT1 / DXT3、粒子帧表、档 2 模块与发射时序、噪声模块、`REFRACT` / `CUTOUT`、`instanceoverride.colorn`）已落地：新解锁 6 张工坊场景，能渲染的从 14 张到 20 张。见 [scene/PARTICLES.md](scene/PARTICLES.md)「粒子（P4b）」。
> P4c（粒子控制点与指针跟随、`controlpointattract`、世界空间与「粒子先于脚本」的帧顺序、`spritetrail` 拖尾与 `sprite` 的三种朝向）已落地：新解锁工坊 `1838478131`、`3832772446`，能渲染的从 20 张到 22 张，带粒子的场景里粒子用法完全覆盖的从 22 张到 44 张。见 [scene/PARTICLES.md](scene/PARTICLES.md)「粒子（P4c）」。
> P4e（粒子子系统 `children` 的四种类型、事件实例池、`audioprocessing*` 与场景频谱）已落地：解锁工坊 `3778592720`、`3811798465`、`1514925620`（`1333579536` 与 P5b 一起），带粒子的场景里粒子用法完全覆盖的从 61 张到 93 张（165 张口径）。见 [scene/PARTICLES_ROPE_CHILDREN.md](scene/PARTICLES_ROPE_CHILDREN.md)「粒子（P4e）」。
> P4f（实例覆盖挂字段脚本与 `rate` 的单独路径、HDR 下的 `instanceoverride.brightness`、粒子层的 `IParticleSystem` 方法与 `instance` 对象、一个系统多个 renderer）已落地：带粒子的场景里粒子用法全部覆盖（93 → 108 张，165 张口径），不解锁新场景。见 [scene/PARTICLES_SCRIPT_MODULES.md](scene/PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」。
> P4g（粒子颜色 initializer `hsvcolorrandom` / `colorlist`）与 P4h（粒子 operator `boids`）已落地：语料没有场景用到，解锁 WPE `myprojects` 里的 6 张（5 张「followed by mice」与滴水 `3826719942`）。见 [scene/PARTICLES_SCRIPT_MODULES.md](scene/PARTICLES_SCRIPT_MODULES.md)「粒子（P4g）」 [scene/PARTICLES_SCRIPT_MODULES.md](scene/PARTICLES_SCRIPT_MODULES.md)「粒子（P4h）」。
> P4i（粒子光照：`genericparticle` / `genericropeparticle` 的 `LIGHTING`）已落地：渲染路径和图层共用，只放行能力表；语料没有场景用到，解锁 WPE `myprojects` 的 `3823357259`。见 [scene/PARTICLES_SCRIPT_MODULES.md](scene/PARTICLES_SCRIPT_MODULES.md)「粒子（P4i）」。
> 计划：[.claude/plans/wpe-import/3-scene/PLAN.md](../../.claude/plans/wpe-import/3-scene/PLAN.md)；
> P4 粒子：[phase-4-particles.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4-particles.md)（总计划）、[phase-4a-base.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4a-base.md)（P4a 与实施记录）、[phase-4b-tier2.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4b-tier2.md)（P4b 与实施记录）、[phase-4c-controlpoints.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4c-controlpoints.md)（P4c 与实施记录）、[phase-4d-ropes.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4d-ropes.md)（P4d 与实施记录）、[phase-4e-children.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4e-children.md)（P4e 与实施记录）、[phase-4f-script.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4f-script.md)（P4f 与实施记录）、[phase-4g-color-modules.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4g-color-modules.md)（P4g 与实施记录）、[phase-4h-boids.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4h-boids.md)（P4h 与实施记录）、[phase-4i-particle-lighting.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4i-particle-lighting.md)（P4i 与实施记录）、[p4-particles-REPORT.md](../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)（实测与读码结论）；
> 格式调研：[RESEARCH.md](../../.claude/plans/wpe-import/3-scene/RESEARCH.md)。

## 总体形态

- **渲染**：场景壁纸在前端渲染，用 WebGPU 跑在 `WpeWallpaperContent` 挂的场景宿主里，壁纸窗口与图库预览共用；资源由前端 `fetch(file:)` 读取。
- **编译**：资源依次查项目目录散文件、项目的 `scene.pkg`、WPE 安装目录的 `assets/`。场景 JSON、`.tex` 解码都在前端 TypeScript。
- **着色器**：WPE 着色器交给 wasm 版翻译器 `wpesl2wgsl`。
- **Rust 侧**：只有导入，以及把 WPE 安装目录交给前端；`kabegame-core` 不出现 scene 模块。
  - 导入：`x-wpe/scene` 入库，创意工坊形态的入口在 `scene.pkg` 里，有包就算入口存在，`hash` / `size` 取包（`WpeProject::content_path`）；
    没有 `type` 但入口是 `.json` 的按场景处理。
  - 壁纸目标的 `sceneAssets`：`<WPE 安装目录>/assets` 绝对路径列表（`wpe::discover::scene_asset_dirs`，安装目录只有一个，来自设置 `wpeEngineDir`），只对场景行计算，其它类型、Android、没找到 WPE 安装目录时为空。
  - 壁纸目标的 `previewPath`：场景行的 `thumbnail_path`（导入时就是作者的 `preview.*`），不能渲染时 scene 层显示它；缩略图为空或回落成壁纸目录本身时不填，其它类型不填。
  - `isWpeWallpaperContentType` 认网页与场景：两者都走 `ImageContent` 的 wallpaper 形态 → `WpeWallpaperContent`；网格缩略位仍是作者预览图；应用背景与预览同一条 `ImageContent` 原图形态，也实时渲染（见 [scene/HOST.md](scene/HOST.md)「显示」）。
- **平台**：随 `wpe` feature，与网页壁纸相同：三个桌面平台都走场景宿主，Android / Web 的 scene 行显示预览图。没有 WPE 安装目录或 WebGPU 不可用时退回预览图。本文的真机数据都来自 Windows。

## 分章

正文按主题分在 [scene/](scene/) 下，一章一个文件。别处引用的「WPE_SCENE.md 的某一节」按下表找所在的文件；二级章节标题在这个目录里唯一，也可以直接搜 `## 某一节`。

| 文件 | 内容 | 二级章节 |
|---|---|---|
| [scene/COMPILE.md](scene/COMPILE.md) | 着色器翻译器、`scene.pkg`、编译管线、编译会话与对象片段（活的场景图）、能力表、场景后处理档位 | 着色器翻译器 `wpesl2wgsl`；`scene.pkg`；编译管线（编译会话与对象片段、能力表、场景后处理档位） |
| [scene/RENDERER.md](scene/RENDERER.md) | 渲染器、帧率、播放速度、图层渲染图、general 字段、泛光与 HDR、层级 | 渲染器（帧率、播放速度、图层渲染图、general 字段、清屏与相机、泛光与 HDR）；层级（P4a） |
| [scene/HOST.md](scene/HOST.md) | 应用页的显示链、场景宿主 iframe、属性与快速路径 | 显示：`ImageContent` → `WpeWallpaperContent` → `WpeSceneView`；场景宿主（P3-0，进行中）（属性与快速路径） |
| [scene/SCRIPT.md](scene/SCRIPT.md) | 脚本运行时、交互、层级 / 转向 / effect 访问、对象表与结构 API、运行时建层 | 场景脚本（P3b）；交互（P6c）；层级、转向与 effect / 材质访问（P6d1a）；对象表与结构 API（P6d3a）；运行时建层（P6d3b） |
| [scene/LIGHTING.md](scene/LIGHTING.md) | 光照、反射、sprite 对象、阴影、体积光、雾、灯的运行时（P13） | 光照（`#require LightingV1`）；反射（P13b1：设置与「反射关」；P13b2：平面反射开；P13g：屏幕空间反射开）；sprite 对象（P13c）；阴影（P13d）；体积光（P13e）；雾（P13f1）；灯的运行时（P13f2） |
| [scene/CAMERA.md](scene/CAMERA.md) | 视差 / 抖动 / 缩放、透视相机与相机对象、深度、脚本的相机基准、相机关键帧（P5a、P5d、P5e、P5i） | 相机：视差、抖动与缩放（P5a）；透视相机、相机对象与深度（P5d）；脚本的相机基准（P5e）；相机对象上的关键帧（P5i） |
| [scene/IMAGE_LAYERS.md](scene/IMAGE_LAYERS.md) | 图像模型标志、组与组合层、perspective、全屏组、P8 补全、图像层帧表（P5b、P5f–P5h、P5j、P8、P6e） | 图像模型标志（P5b）；组里读快照（P5f）；文本层的 perspective（P5g）；脚本 `layer.perspective` 与组合层的 perspective（P5h）；全屏组（P5j）；图像层与材质补全（P8）；图像层帧表（P6e） |
| [scene/MODELS.md](scene/MODELS.md) | 静态网格 mdl（P5c）、脚本自定义几何与组里的模型（P14） | 静态网格（P5c）；脚本自定义几何（P14） |
| [scene/TEXT.md](scene/TEXT.md) | 字体引擎 `wpefont`、文本对象与 MSDF（P6b、P6f） | 字体引擎 `wpefont`（P6b 1b 起）；文本对象（P6b 1d 起） |
| [scene/PARTICLES.md](scene/PARTICLES.md) | 粒子底座、纹理与发射时序、控制点与拖尾（P4a–P4c） | 粒子（P4a）；粒子（P4b）；粒子（P4c） |
| [scene/PARTICLES_ROPE_CHILDREN.md](scene/PARTICLES_ROPE_CHILDREN.md) | 绳与拖尾、映射与距离类模块、子系统与音频（P4d、P4e） | 粒子（P4d）；粒子（P4e） |
| [scene/PARTICLES_SCRIPT_MODULES.md](scene/PARTICLES_SCRIPT_MODULES.md) | 脚本接口与多 renderer、颜色 initializer、boids、粒子光照、`layerimage` 发射器（P4f–P4j） | 粒子（P4f）；粒子（P4g）；粒子（P4h）；粒子（P4i）；粒子（P4j） |
| [scene/ANIMATION.md](scene/ANIMATION.md) | 关键帧动画与脚本 `IAnimation`（P10） | 关键帧动画（P10a、P10b） |
| [scene/PUPPET.md](scene/PUPPET.md) | puppet、挂点 / 变形 / 裁切、模型骨骼、动画层脚本 API、骨骼物理、建删层、绘制顺序、局部骨骼（P12） | puppet 与骨骼动画（P12a）；puppet 的挂点、骨骼透明度、变形与裁切（P12b1）；模型对象的骨骼与纹理通道（P12b2）；puppet 动画层的脚本 API（P12c）；puppet 骨骼物理与骨骼脚本 API（P12d）；puppet 动画层的建删（P12e）；puppet 绘制顺序（P12f）；puppet 骨骼的局部读写（P12g） |
| [scene/SOUND_VIDEO.md](scene/SOUND_VIDEO.md) | 声音对象（P6a）、视频纹理与脚本 `IVideoTexture`（P9） | 声音（P6a）；视频纹理（P9a、P9d） |
| [scene/AUDIO_MEDIA.md](scene/AUDIO_MEDIA.md) | 音频频谱 uniform、用户纹理、纹理变体、媒体、快捷方式（P11） | 音频频谱 uniform（P11a）；用户纹理（P11b）；纹理变体（P11e）；媒体（P11c）；快捷方式（P11d） |
