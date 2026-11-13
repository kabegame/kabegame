# WPE Scene 壁纸 · 阶段 3 计划（多 Phase）

> 状态（2026-11-01）：决策 D1–D7 全部按推荐确认。**P1-0（着色器翻译器 `wpesl2wgsl` + wasm 构建链）已完成**，结果见点 P1-0；
> **`scene.pkg` 读取（`wpe-scene/compile/pkg.ts`）已完成**：本机创意工坊 scene 全是 pkg，原 P9 的 pkg 提前进 P1-3。**P1-1（scene 入库）已完成并真机验证**（29 张：默认 16 + 工坊 13）。**P1-2（WPE 安装目录交给前端）已完成**。**P1-3（前端编译管线）已完成**，本机 29 张语料与 CEF 里的 Worker 编译都验证过。**P1-4（WebGPU 渲染器 + `WpeSceneView.vue`）已完成**：P1 三张真机渲染，全语料 Tint 0 error；beach 与 WPE 桌面实拍一致（作者 `preview.jpg` 另有后期，不能当基准）。**P1-5（接入 `WallpaperStage`）已完成**：图库预览与桌面实时渲染，加载期间不闪预览图；场景 → 场景切换有 0.2–0.4 秒空档待定。
> P2a / P2b、P3-0（场景宿主，3-0a–3-0c）已完成；**P3（SceneScript）**于 2026-11-03 定方案（D14），拆成 [3a](phase-3a-bindings.md) / [3b](phase-3b-script-runtime.md) / [3c](phase-3c-runtime-graph.md)，见「P3 — SceneScript」一节。
> **2026-11-11 重分（D15）**：P6 之后不再按壁纸分节。W1–W6、旧 P7 / P8、K、旧 P9 按能力拆散，已被 P2–P6 吸收的划掉，剩下的排成 P7–P13 与「按需」；旧名到新名见「旧名对照表」。
> 上级：[../PLAN.md](../PLAN.md) 决策 9（Scene 走 WebGPU）。调研：[RESEARCH.md](RESEARCH.md)（格式、方言、WebGPU 可行性）。
> 翻译器契约：[src-tauri/wpesl2wgsl/README.md](../../../../src-tauri/wpesl2wgsl/README.md)；场景文档：[cocs/wpe/WPE_SCENE.md](../../../../cocs/wpe/WPE_SCENE.md)。
> 本文件取代调研 §5–§7 里与现架构不符的部分。调研写于网页壁纸改成 `file:` iframe 之前，其中的 `/wpe/<id>/` HTTP 路由、
> `kb-wpe` 协议、「渲染器放进跨源 iframe」都已不适用。样本数据来自对本机 WPE 安装
> （`D:\Applications\Steam\steamapps\common\wallpaper_engine`）的只读扫描。

---

## 总体设计思路

**按样本渐进，而不是按子系统一次做全。** 本机有 29 个 scene 样本：`defaultprojects` 16 个（散文件目录），创意工坊 13 个（全部打包成 `scene.pkg`，用户仍在订阅）。
按它们用到的能力从少到多排成 P1–P6、W1–W6、P7–P8，每个 Phase 让一组具名样本**完整正确**：先是 1–3 层静态图层 + 自定义 shader，
再是 effect 链与混合模式、SceneScript、粒子、透视与静态网格、复杂脚本小游戏；然后是工坊的视频纹理、层级、媒体集成、交互与骨骼动画；
最后是 3D 模型场景（D7）。每个 Phase 只加这组样本需要、而前面还没有的能力，做完就能拿这几张对照验收。
（已更新：P4 起改成按语料覆盖一类能力的全部用法，不再只做几张样本；2026-11-11 起 P6 之后的分节也按能力，不再按壁纸，见 D15。）

**能力表让「完成」可以机器检查。** 编译场景时算出它用到的特性（图层类型、shader 变体、effect、粒子算子、脚本 API、
纹理格式……），与「当前已实现」的表比对，未实现项列进 `unsupported`；清单非空时整张退回预览图，不画半成品（D4）。
每个 Phase 的验收分两半：机器查目标样本的 `unsupported` 为空，再真机对照项目自带的预览图（作者在 WPE 里截的；我们不运行 WPE）。
scene 导入从 P1 起打开，样本一入库就有预览图，渲染能力随 Phase 逐张解锁。

**编译和运行都在前端，Rust 只做导入。** 「读懂 WPE」的工作在 `apps/kabegame/src/wpe-scene/`：
- **资源解析层**：依次查项目目录的散文件、项目的 `scene.pkg`、WPE 安装目录的 `assets/`（与 linux-wallpaperengine 的挂载顺序相同）。
  全部样本都依赖 `assets/`，至少要 `shaders/common*.h` 与内置 shader。文件用 `fetch(file:)` 读：应用页主 frame 的 `file:` 子资源本来就免检，
  不改闸门，也不加命令；pkg 条目带 `Range` 头只读该区间。
- **编译**：JSON 类型化与默认值、`.tex` 解码（容器、LZ4；DXT 保持压缩直传 GPU；内嵌 PNG / JPG 交给 `createImageBitmap`）、特性检查。
  着色器交给 wasm 翻译器 `wpesl2wgsl`，见下一段。编译管线不碰 DOM 与 GPU，vitest 能在 Node 里跑本机语料。
- **运行**：建 pipeline、上传纹理、算 uniform、合成图层、执行 effect pass、模拟粒子、驱动脚本。

Rust 侧只有两处小改动：导入接受 scene 行；把 WPE 安装目录随壁纸目标交给前端。`kabegame-core` 不出现 scene 模块。

**着色器：WPESL 原文直接进 wasm。** 翻译器 `wpesl2wgsl`（`src-tauri/wpesl2wgsl`，编成 wasm，不链进应用）接收一个材质 pass 的
`.vert` / `.frag` **原文**，内部完成全部步骤：
- **方言处理**：注释元数据（`// [COMBO]`、采样器注释）→ 宏表 → 预处理（`#include`、条件编译）→ 改写成 Vulkan GLSL 450；
- **翻译与反射**：naga 输出 WGSL，同时给出 uniform 块的 std140 布局、纹理绑定号与 location。

前端只负责三件事：按 `missing` 读头文件、给出 COMBO、给出绑定纹理的槽位与格式。主线程负责 fetch，把 `ArrayBuffer` 零拷贝转交给 Worker；
解析与翻译都在 Worker 里做，避免主窗口打开预览时卡图库。Worker 自己读不了 `file:`，因为 CEF 补丁 07 关掉了 worker 的 `file:` 工厂。

**信任边界不变。** 渲染器是我们自己的代码，跑在应用页主 frame。场景里唯一的第三方可执行代码是 SceneScript，放进不透明源的
sandbox iframe（只给 `allow-scripts`），每帧经 `MessageChannel` 交换输入与绑定值：拿不到 IPC、读不到应用存储，也碰不到文件（D1）。
（已更新：P3-0 起编译、渲染与脚本都在场景宿主 `file:` iframe 里，宿主与网页壁纸同信任级别；D14 起脚本在宿主内的同源子 frame 里同步执行，只是隔离、不是安全边界。）
shader 是第三方源码，但要先经 naga 解析和校验、再经浏览器自己的 WGSL 校验，才进 GPU。

**`scene.pkg` 是资源解析层的一个来源。** 创意工坊发布的 scene 把 `scene.json` 与全部项目资源打进 `scene.pkg`，目录里只剩
`project.json` 与预览图。读取移植自 linux-wallpaperengine（`wpe-scene/compile/pkg.ts`，已完成）：先读目录表，再按条目区间带 `Range` 头
`fetch`。包最大有 336 MB（内嵌 4K60 视频纹理），所以绝不整包读入；渲染器与翻译器都不感知资源来自散文件还是 pkg。

**范围与平台。** 与网页壁纸一样只在 Windows 渲染（`wpe::discover::platform_supported`），其它平台的 scene 行只显示预览图，
wasm 也只在真要渲染时才加载。上级计划的阶段 3 / 4 合并为本阶段（D6）。

---

## 样本复杂度分级（本机只读扫描，2026-11-01）

> 这张表是 2026-11-01 按样本排的旧分法，保留作样本的能力清单。表里 W1–W6、P7–P9 各行的能力现在分到哪一节，见「旧名对照表」（D15）。

| Phase | 样本 | 相比上一档新增的能力 |
|---|---|---|
| P1 | eagleflag · deep_space · beach | 1–3 个 image 图层，正交相机；内置 `genericimage` + 项目自定义 shader（`flag` 顶点动画、`flowimage`、`swayimage`，都用 `g_Time`）；COMBO `TINT`；normal / translucent / additive 混合；纹理 RGBA8888 与 DXT5、ClampUVs；材质 `usershadervalues` 绑定用户颜色（eagleflag 的 `flagcolor1/2`） |
| P2 | razer_vortex · razer_bedroom（静态） | `genericimage2`（`version=2`、`BLENDMODE` COMBO）；`colorBlendMode` 11 / 12；`copybackground` + `solid`；effect 链（vortex `tint` ×3 且用项目覆盖的 `effects/rz` shader；bedroom `scroll` ×9 + `tint` ×6，均单 pass）；PNG 纹理（`.tex` 内嵌 FreeImage 13）；3840×2160 正交；hdr + bloom（bedroom）；24 处 `{user}` 绑定；脚本绑定暂取 `value` 默认值 |
| P3 | razer_vortex · razer_bedroom（完整） | SceneScript：`applyUserProperties`（vortex 写 `thisObject.colormode`）、每帧 `update`（bedroom 6 段）、`import … from 'WEColor'`（`hsv2rgb`）、`Vec3` |
| P4 | shimmering_particles | 4 个粒子系统：emitter `sphererandom`；initializer `lifetimerandom sizerandom velocityrandom colorrandom angularvelocityrandom rotationrandom`；operator `movement oscillateposition alphafade oscillatealpha angularmovement`；renderer `sprite`。另有 `instanceoverride` 绑用户属性、自定义 `particle` shader（`WORLDBLUR` `USERCOLORBLEND`）、5760×1080 三屏正交、脚本改 `bloomstrength`、9 处用户绑定 |
| P5 | retro · neon_sunset | 静态 `.mdl` 网格（MDLV0014，无骨骼 / 动画段）作为 model 图层（retro 1 个、neon_sunset 2 个，`neongrid` 151 KB）。neon_sunset 另有：透视相机（`orthogonalprojection: null`）、`fullscreen` / `passthrough` 层、`filmgrain` effect、`BLENDMODE=12`、`parallaxDepth`、`assets` 里的 `materials/util/noise.tex`、11 个颜色 / 滑块属性 |
| P6 | dino_run | 32 层；`scroll` ×21 + `godrays`（5 pass、2 fbo）；spritesheet（`TEXS` 帧表，COMBO `spritesheet=1`）；文本 ×2（项目 otf 字体）；声音 ×2；脚本 `createLayer / destroyLayer / sortLayer / getLayer / getLayerIndex / registerAsset / thisObject.getMaterial`、`localStorage.get/set`（`LOCATION_GLOBAL`）、`cursorDown`、`input.cursorWorldPosition`；`camerafade` |
| W1 | 工坊 3656079027 超时空辉夜姬 | 工坊里最简单的一张：没有脚本、视频、文本。`genericimage4` 的 `#require LightingV1` 已实现（[lighting-REPORT](lighting-REPORT.md)）；`parent` 层级（5 处）与形状对象 `shape: "quad"` + `lightshafts`（原写作「带 `effects` 的分组节点」，2026-11-07 核对是形状对象，见 [sample-gaps](phase4/sample-gaps.md) §2.1）；effect `shake` ×2、`iris`；sprite 粒子（复用 P4）；7 处用户绑定 |
| W2 | 工坊 3429479356 MGS4 · 3600630828 樱羽艾玛 | 视频纹理（`.tex` 内嵌 4K MP4：MGS4 一段 707 MB，樱羽两段 200 + 95 MB）；文本与声音；简单脚本（`thisScene.enumerateLayers`、`thisLayer.text / alpha`、`getLayer`、`applyUserProperties`）；`g_AudioSpectrum` 音频条（工坊 effect `Simple_Audio_Bars`）；rope 粒子 + 跟随指针的控制点；`shine`（5 pass、2 fbo）、`blurprecise`、`opacity`；3840×2650 非 16:9 正交 |
| W3 | 工坊 3470764447 伊蕾娜·昼夜 | `parent` 层级 31 处；5 段视频按时段切换；脚本 `engine.canvasSize`、`engine.registerAudioBuffers`、`mediaThumbnailChanged`；`colorBlendMode` 21 / 31；带 `camera` 的对象；16 个文本 |
| W4 | 工坊 3611425904 五河琴里 · 3146703458 P3R 音乐播放器 · 3351163962 椎名真白 | 交互：按图层命中的 `cursorClick / Down / Up / Move / Enter / Leave`；声音图层由脚本控制（`play / pause / stop / isPlaying`，P3R 8 个声音、琴里 4 段语音）；`systemfont_*`；`engine.setTimeout`、`WEMath / WEVector`；材质 `genericimage3`、`flat`；effect `sharpen_filter`、`transform`、`foliagesway`、`iris`、`blend`；粒子 `turbulence`、`sizechange`；真白 53 个文本、448 处用户绑定 |
| W5 | 工坊 2932157836 星浴 · 3524852519 伊蕾娜·初晨偎风 · 3219908811 初音·胧月 | 媒体集成（`mediaPlaybackChanged / PropertiesChanged / ThumbnailChanged / TimelineChanged`）；跨脚本 `shared`（含可拖动图层）、`engine.setInterval`、`getAnimation`、`thisLayer.getParent`；粒子 `vortex`、`controlpointattract`、`children: eventfollow`；大量内置 effect（`waterwaves` `waterripple` `shake` `pulse` `transform` `chromaticaberration` `spin` `perspective` `twirl` `blendgradient` `motionblur` `blurradial`）、`composelayer`；R8 / RG88（AlphaChannelPriority） |
| W6 | 工坊 3351072238 妃咲 · 3409595232 长安雪 · 3554161528 空崎日奈 | puppet warp：MDLV0021 / MDLV0023 带骨骼（MDLS）与动画（MDLA），skinning 经 `defines` 传 `BONECOUNT`；DXT3（格式 6）；`REFRACT` / `PARALLAX`、`depthparallax`、`g_PointerPosition` / `g_ParallaxPosition`；粒子 `ropetrail` `spritetrail` `mapsequencearoundcontrolpoint` `oscillatesize`；effect `waterflow` `bloom` `color_grading` `rounded_mask` `hue_shift` `clipping_mask`；脚本 `localStorage` |
| P7 | dna_fragment · techno · audiophile | 纯 3D 模型场景（全部是 `.mdl`、透视），各自用项目 shader。mdl 新旧格式都有：MDLV0004（dna_fragment、audiophile）、MDLV0023 混 MDLV0014（techno）。audiophile 要音频（`supportsaudioprocessing`），接 Phase 8 的音频源；dna_fragment 带一个简单粒子（复用 P4） |
| P8 | demon_core · arsenal · fantasticcar · ricepod | 光照（light 图层、ambient / skylight）；内置 `generic` 的 `lightmap` / `normalmap` / `reflection` / `detailinalpha`（arsenal）；车漆 shader 的 `normalmap` / `metal` / `paintwork` / `specularalpha`（fantasticcar）；`spritetrail` renderer、`camerashake`、无内容的变换节点、`selfillum`（ricepod）。`#require LightingV1` 与图层光照已提前实现（lighting-REPORT），这里剩阴影、PRELIGHTING 与遗留灯 |
| P9 | 按需 | 本机样本都没用到的能力（如 `attachment`、`cursorripple` / `depthparallax` 等内置 effect、`fluidsimulation`），拿到新样本再排 |

补充事实：
- **全部依赖 `assets/`。** 以 2D 样本为例，eagleflag 要 `shaders/common_{fragment,vertex}.h`，且 `flag` shader 本身就在 `assets/shaders/`；
  razer 系要 `genericimage2` + `common_{blending,pbr,vertex}.h`；neon_sunset / dino_run 还要 `models|materials/util/fullscreenlayer.json`。
- **`project.json` 可能没有 `type`。** audiophile、techno 没有这个字段，但 `file` 是 `.json`，WPE 照 scene 处理。现在的识别把它们归成 `Other`，
  不导入。fantasticcar、ricepod 的 `type` 是 scene，只是 `file` 不叫 `scene.json`。
- **材质的 COMBO 与纹理**：eagleflag `flag` 是 `TINT: 1`，纹理 `eagle / flag_normal / cloth`；deep_space `flowimage` 有 4 张纹理，
  `genericimage` 有 1 张；beach 的 `flowimage` / `swayimage` 各 2 张、`genericimage` 1 张；其余均无 COMBO。
- 这 16 张都没有骨骼 / 动画 mdl、视频纹理、`parent` 层级，也没有在 shader 里用 `g_PointerPosition` 或 `g_AudioSpectrum`
  （audiophile 的音频在项目 shader 的 uniform 数组里，P11 再核实）。

创意工坊 13 张（2026-11-01 只读扫描，pkg 解到 scratchpad 后用同一脚本统计）：
- **全是 `scene.pkg`**：版本 `PKGV0018`–`0024` 布局相同，最大 712 MB；条目首尾相接，最后一条结束在文件末尾；
  条目名是 UTF-8 正斜杠路径，有中文、有末尾带空格的。项目自带的工坊依赖放在 `effects|materials|shaders|fonts/workshop/<工坊 id>/` 下。
- **图层材质换成了 `genericimage4`**（22 个材质，`genericimage2` 只剩 10 个）与 `genericparticle`（13 个）。`genericimage4.frag` 在顶层
  **无条件** `#require LightingV1`：`LIGHTING=0` 时它什么都不插，翻译器已按此实现（lighting-REPORT）；
  `genericparticle.frag` 的 require 在条件编译里。主体只在 `LIGHTING || REFLECTION` 下用光照。本机语料没有一张真的开 `LIGHTING`。
- **视频纹理**：`.tex` 的 flags 含 Video（32）。容器多为 `TEXB0004`，FreeImage 字段为 −1、`isVideoMp4` 字段为 **0**，
  按 linux-wallpaperengine 的规则退回 TEXB0003 的 mip 布局；也有直接是 `TEXB0003` 的（P3R）。唯一一个 mip 不压缩，数据就是完整 MP4
  （`ftypmp42` / `ftypisom`），从 mip 数据起点（`TEXB0004` 为第 91 字节、`TEXB0003` 为第 87 字节）到条目末尾。
  所以判断视频要看 flags 的 Video 位，不能照 LWE 只看 `isVideoMp4`；起点按容器版本解析，不能写死。单段最大 707 MB。
- **普遍要音频、文本与层级**：多数用 `g_AudioSpectrum` 或 `engine.registerAudioBuffers`，除辉夜姬外都有文本图层，多数有 `parent` 层级。
  图层材质出现 `genericimage3`、`flat`、`composelayer`。

---

## 现状锚点

**a. scene 不入库**（`src-tauri/kabegame-core/src/wpe/project.rs:46`）
```rust
    /// Kabegame 已支持入库的类型（目前 video 与 web）；scene 落地时只需在这里加一项。
    pub fn is_supported(&self) -> bool {
        matches!(self, Self::Video | Self::Web)   // 现状：scene 行扫描得到但不导入
    }
```

**b. 壁纸目标只为 video / web 准备额外字段**（`src-tauri/kabegame/src/commands/wallpaper.rs:67`、`apps/kabegame/src/components/wallpaper/types.ts:30`）
```rust
async fn build_wallpaper_target(info: ImageInfo) -> WallpaperTarget {
    let wpe_video = if kabegame_core::media::image_type::is_wpe_video_type(info.media_type.as_deref()) { /* 作者视频属性 */ } else { None };
    let web_entry = web_entry_of(&info).await;   // 现状：只有 web 行算入口
    WallpaperTarget { id: info.id, path: info.local_path, media_type: info.media_type, compatible_path: info.compatible_path, wpe_video, web_entry }
}
```
```ts
export interface WallpaperTarget {
  id: string;
  path: string;
  type?: string;
  compatiblePath?: string;
  wpeVideo?: WpeVideoProps | null;
  webEntry?: string | null;   // 现状：没有 WPE 安装目录，scene 需要它解析 assets
}
```

**c. `WallpaperStage` 只有三种媒体，web 层自取数据**（`apps/kabegame/src/components/wallpaper/WallpaperStage.vue:32`、`:173`、文件头注释）
```ts
type MediaType = "image" | "video" | "web";   // 现状：无 scene

/** WPE 网页壁纸：走独立 web 层（iframe），不进 base / top 双层。 */
function isWebTarget(target: WallpaperTarget): boolean {
  return (target.type || "").trim().toLowerCase() === "x-wpe/web";
}
// 文件头约束：组件只靠 props 驱动、不 invoke、不 listen；web 层的 iframe 自己拉取、自己 listen
```

**d. 预览已把 scene 行路由到壁纸形态**（`apps/kabegame/src/utils/mediaMime.ts:38`）
```ts
export function isWpeWallpaperContentType(t: string | undefined): boolean {
  return isWpeMediaType(t) && !isWpeVideoType(t);   // 现状：web 与 scene 都走 WpeWallpaperContent → WallpaperStage
}
```

**e. WPE 安装目录的定位是 `locale.rs` 私有函数**（`src-tauri/kabegame-core/src/wpe/locale.rs:44`）
```rust
/// 各 Steam 库里的 WPE 安装目录 `<库>/steamapps/common/wallpaper_engine`（去重、保持发现顺序）。
fn engine_dirs() -> Vec<PathBuf> {   // 现状：只给 `ui_` 词条查找用
    for root in super::discover::discover_roots() { /* 由创意工坊根 / 项目根反推安装目录 */ }
}
```

**f. 平台门控只 Windows**（`src-tauri/kabegame-core/src/wpe/discover.rs:49`）
```rust
pub fn platform_supported() -> bool {
    platform_supported_on(std::env::consts::OS)   // 现状：os == "windows"
}
```

**g. 着色器翻译器已就位（P1-0 产物）**（`apps/kabegame/src/wpe-scene/wpesl2wgsl/index.ts`）
```ts
export function loadWpesl2wgsl(): Promise<Wpesl2wgsl | null>;   // 现状：wasm 没拷进前端时返回 null
export async function translateWithIncludes(
  translator: Wpesl2wgsl,
  request: TranslateRequest,          // { vertex, fragment, includes?, combos?, textures?: {slot, format}[], defines?, debug? }
  readInclude: (name: string) => Promise<string | null>,   // 现状：缺头文件时按名字回调，读不到返回 null
): Promise<TranslateResult>;          // { ok, vertex/fragment: {wgsl, entryPoint}, uniforms, uniformBlockSize, textures, attributes, varyings, combos } 或 { ok:false, phase, stage, errors, missing, requires }
```
**h. `scene.pkg` 读取已就位**（`apps/kabegame/src/wpe-scene/compile/pkg.ts`，移植自 linux-wallpaperengine 的 `PackageParser.cpp` / `Package.cpp`）
```ts
/** 按字节区间读同一个文件，返回 [start, end)；跨过末尾截短，start 不在文件内时抛错。 */
export type RangeRead = (start: number, end: number) => Promise<Uint8Array>;

export class ScenePkg {
  static open(read: RangeRead, options?: { initialChunk?: number }): Promise<ScenePkg>;  // 现状：先读 64 KiB 目录表，不够加倍
  readonly version: string;          // "PKGV0024"
  readonly entries: readonly PkgEntry[];
  readonly baseOffset: number;       // 数据区起点 = 目录表结束处
  has(name: string): boolean;
  readEntry(name: string): Promise<Uint8Array | null>;   // 现状：没有该条目返回 null；读到的长度不对抛 PkgFormatError
}
```
`apps/kabegame/src/wpe-scene/` 目前只有翻译器胶水与这个文件；`fs.ts`、渲染器、`WpeSceneView.vue` 都还没有。

**i. 导入要求入口是散文件，hash / size 取自入口**（`src-tauri/kabegame-core/src/wpe/project.rs:211`、`crawler/wpe_import.rs:298`）
```rust
    // 已支持入库的类型都要求入口文件存在（video 是视频文件，web 是入口 html）。
    if kind.is_supported() {
        // …
        if !dir.join(file).is_file() {
            return Err(WpeSkip::MissingEntry(file.to_string()));   // 现状：工坊 scene 的 scene.json 在 pkg 里，会被当成缺入口
        }
    }
```
```rust
    let hash = compute_file_hash(&entry).await?;                     // 现状：entry = dir.join(project.file)
    let size = std::fs::metadata(&entry).ok().map(|meta| meta.len());
```

**j. 应用页 `fetch(file:)` 的 `Range` 行为**（2026-11-01 在 dev 主窗口实测，读工坊 `scene.pkg`）
```text
Range: bytes=0-15              → 200，正文 16 字节，约 5 ms（没有 Content-Range / Content-Length 头）
Range: bytes=6781-6800         → 200，正文 20 字节，正是 scene.json 开头（证实条目偏移从目录表结束处算起）
Range 跨过文件末尾             → 200，截短到文件末尾
Range 起点超过文件末尾         → TypeError: Failed to fetch
Range: bytes=-16 / bytes=N-    → 200，后缀与开区间都可用
```

---

## P1-0 — 着色器翻译器与 wasm 构建链（已完成，2026-11-01）

落地的形态（契约细节以 README 为准）：

- **crate `wpesl2wgsl`**（`src-tauri/wpesl2wgsl/`，workspace 成员）：输入 WPESL 原文，内部完成预处理、改写与 naga 翻译，接口见现状锚点 g。
  - naga 30.0.1，开了 `glsl-in` / `wgsl-out`，另开 `wgsl-in` 绕过它只开 `glsl-in` 时的编译错误。
  - C ABI：`wpesl_alloc` / `wpesl_free` / `wpesl_translate`，不用 wasm-bindgen；wasm 无导入，约 1.4 MB。
- **构建链**：
  - `deno task build:wpesl2wgsl`（`scripts/build-wpesl2wgsl.ts`）用根 `Cargo.toml` 的 `[profile.wpesl2wgsl]` 编到 `wasm32-unknown-unknown`，产物 `bin/wasm/wpesl2wgsl/wpesl2wgsl.wasm`；缺目标时报错并给出 `rustup target add` 命令。
  - `scripts/plugins/wpesl2wgsl-plugin.ts`：kabegame 命令不带 `--skip vue` 时在 `prepareEnv` 拷进 `apps/kabegame/src/wpe-scene/wpesl2wgsl/`，内容相同不重写，缺失只告警。
  - 两处产物都 git 忽略；路径常量在 `scripts/paths.ts`。
- **渲染器要遵守的翻译约定**：
  - **绑定**：全部资源在 group 0。binding 0 是 std140 uniform 块，顶点与片元**共用一块缓冲**，成员为两阶段并集；纹理槽位 n 在 binding `1 + 2n`，其采样器在 `2 + 2n`。
  - **uniform 打包**：按 `uniforms[].offset` 写。标量 / 二三分量向量的数组被补成 `vec4` 数组，按 `stride` 16 写前几个分量，原类型见 `declared`。
    `meta` 是声明行尾 JSON，`material` 名即材质 `constantshadervalues` 的键。
  - **location**：attribute 按 `attributes` 的 name → location 建顶点布局；varying 已在两阶段间对齐，渲染器不用管。
  - **COMBO**：材质 pass 与 effect pass 的 `combos` 传给 `combos`。带 `combo` 注释的采样器绑定了纹理就自动置 1；`TEX<n>FORMAT` 由 `textures[].format` 推出。
    所以翻译前要先读出 `.tex` 头里的格式枚举。
  - **平台宏**：`HLSL=1`（WebGPU 坐标约定与 D3D 相同），`HLSL_GS40_DISABLED=1`，`GS_ENABLED` 未定义。
- **测试**：
  - crate 单测 24 项；
  - 本机语料（`KABEGAME_WPE_ROOT` 开启）167 对通过 153 对（91.6%），输出 WGSL 经 naga 回读 0 失败；P1 门槛（`flag` TINT=1、`genericimage`、deep_space / beach 的 `flowimage` / `swayimage`）全过。
    失败的 14 对是 `#require LightingV1` 6、阴影 GS 3、HLSL 隐式截断 2、`BONECOUNT` 1、`sampler2DBackBuffer` 1、编辑器专用 1，都不在 P1–P6 的样本里；
  - 前端胶水 vitest 3 项。
- **未完成，移到 P1 的真机用例**：
  - 浏览器 Tint 是否接受这些 WGSL：在 dev app 的应用页里用 wasm 翻译语料，再跑 `createShaderModule` + `getCompilationInfo`；
  - macOS / Linux 上的 `build:wpesl2wgsl`。

---

## P1 — 导入、编译管线、静态图层（eagleflag · deep_space · beach）

P1 搭出整条骨架，后面每个 Phase 只往能力表里加项。

**点 P1-1 导入（core `wpe/project.rs`、`wpe/scan.rs`）——已完成（2026-11-01）**
- 落地：`WPE_SCENE_PKG`、`WpeProject::content_path`、`import_wpe_scene`；扫描结果加 `scene` 计数，导入对话框显示「场景 n」；
  渲染器接入前 `isWpeWallpaperContentType` 只认 web，场景行在网格、预览与应用背景显示作者预览图。真机：29 张入库、重跑幂等（见回归文档）。
- **修改** `is_supported` 加入 `Scene`；`type` 缺失且 `file` 以 `.json` 结尾时识别为 `Scene`（audiophile、techno）。
- **修改** scene 的入口校验：`file` 是散文件，**或**目录里有 `scene.pkg` 即可（创意工坊形态）。Rust 不解析 pkg，入口是否真在包里交给前端编译时判断。
- **修改** hash / size：有散文件入口时照旧取入口；否则取 `scene.pkg`（最大 336 MB，与视频壁纸哈希整个 mp4 同量级）。
```rust
        // 修改：scene 的入口可以在 scene.pkg 里（创意工坊发布形态），Rust 只看包是否存在
        let packed = kind == WpeKind::Scene && dir.join(WPE_SCENE_PKG).is_file();
        if !dir.join(file).is_file() && !packed {
            return Err(WpeSkip::MissingEntry(file.to_string()));
        }
```
```rust
    pub fn is_supported(&self) -> bool {
        matches!(self, Self::Video | Self::Web | Self::Scene)   // 修改：新增 Scene
    }
```

**点 P1-2 WPE 安装目录交给前端（core `wpe/discover.rs`、`wpe/locale.rs`，app `commands/wallpaper.rs`，前端 `types.ts`）——已完成（2026-11-01）**
- 落地：`discover::engine_dirs`（由 `locale.rs` 挪来并公开）、`discover::scene_asset_dirs`（只列存在的 `assets` 目录）；
  `WallpaperTarget.scene_assets: Vec<String>` 由 `scene_assets_of` 在 blocking 线程现算，只对 `x-wpe/scene`；Windows 上找不到安装目录时打一条 warn。
- **修改** `locale.rs::engine_dirs` 挪到 `discover.rs` 并公开，供 `locale` 与壁纸目标共用。
- **修改** `WallpaperTarget` 加 `sceneAssets`：只对 scene 行、只在 Windows 计算，值是各 WPE 安装目录下的 `assets` 绝对路径（按发现顺序）。
```rust
    WallpaperTarget {
        // …
        web_entry,
        scene_assets,   // 新增：scene 行的 `<WPE 安装目录>/assets` 列表；其它类型、非 Windows 为空
    }
```
```ts
  webEntry?: string | null;
  /** scene 壁纸解析内置资源的 `<WPE 安装目录>/assets` 绝对路径（按顺序查找）；其它类型、非 Windows 为空。 */
  sceneAssets?: string[];   // 新增
```

**点 P1-3 资源解析与编译（新增 `apps/kabegame/src/wpe-scene/compile/`）——已完成（2026-11-01，codex 实现 + Claude 复核）**
- 落地：
  - `fs.ts` / `model.ts` / `tex.ts` / `shader.ts` / `features.ts` / `bundle.ts`，以及 `protocol.ts` / `worker.ts` / `client.ts`；入口是 `compileScene` 与 `compileSceneInWorker`。
  - 语料：29 张中 P1 三张 `unsupported` 为空，其余 26 张都非空。单张最多读 7.6 MB、请求不超过 150 次，视频本体不读。
  - CEF dev 里 Worker 编译五张样本，每张 0.16–0.35 秒。
- 与原方案的差异：
  - **散文件不探测大小**：CEF 的 `file:` 响应没有 `Content-Length`。最初用单字节 Range 二分探测，每张要 300–950 次请求。改为：
    - json / shader 直接整读，失败即未命中；
    - `.tex` 用首个 4 KiB 区间读兼做存在判断；
    - 一次编译内缓存查找结果与内容；
    - pkg 相邻小条目共用 64 KiB 窗口。
  - **Worker 回传读取错误时保留类型**（`encodeFileError` / `decodeFileError`），否则「不存在」会被当成真错误。
  - **已有不支持项时 mip 不解码**：之后的纹理只读头，所以 `unsupported` 非空时 `textures[].mips` 可能为空，渲染器不得使用。
  - **能力表按白名单从严**：未知的 `general` / object / model / pass 字段只要取值非空就报，任何非 `TINT` 的 COMBO 也报。
    因此工坊样本的清单里有很多噪声项，例如 `general:farz`、`general:zoom`、`general:camerashakeamplitude`。P2 / W1 解锁时要逐项判断中性还是真影响画面，再从严中放开。
- **新增** `fs.ts`：`SceneFs`，`read(rel)` 依次查项目目录散文件 → `scene.pkg`（`ScenePkg.readEntry`，现状锚点 h）→ 各 `sceneAssets`。
  越界（`..`、绝对路径、反斜杠逃逸）一律拒绝；pkg 条目名按原样精确匹配。
  读文件经注入的 reader：主线程实现用 `fetch(file:)`，pkg 用带 `Range` 头的 `RangeRead`（现状锚点 j），并按流读取、超过请求长度立即取消，
  防止 `Range` 万一被忽略时读入整包；vitest 实现用 Node `fs`。`scene.pkg` 不存在时 fetch 失败，视为没有这个来源。
- **新增** `model.ts`：P1 只覆盖到用到的字段，未知字段记入 `unsupported`，不报错：
  - scene.json：`camera`、`general.orthogonalprojection / clearcolor / clearenabled`，image 对象的 `origin / scale / angles / size / alpha / color / visible`；
  - model json：`material`、`width / height`；
  - material json：`passes[].shader / blending / cullmode / depthtest / textures / combos / constantshadervalues / usershadervalues`。

  值的三种形态（常量 / `{user}` / `{script}`）统一成一个联合类型。
- **新增** `tex.ts`：`TEXV0005 / TEXI0001 / TEXB0001–0004` 头、mip 表、LZ4 block 解压。P1 只需格式 0（RGBA8888）与 4（DXT5），其余格式进 `unsupported`。
  头里的格式枚举同时作为翻译请求的 `textures[].format`。
- **新增** `shader.ts`：着色器只做「读文件 + 调翻译器」，**不做任何方言处理**：
  - 读 `shaders/<名字>.vert|.frag`：项目目录优先，effect 的着色器优先查该 effect 自己的 `shaders/`；
  - 调 `translateWithIncludes`，`readInclude` 按同样的根顺序查 `shaders/<include 名>`；
  - `combos` 取材质 pass 与 effect pass 的 `combos`，`textures` 取已绑定的槽位与 `.tex` 格式；
  - 结果以 `(shader, combos, 纹理槽位与格式)` 为键缓存。
  - `ok: false` 时把 `phase` 与首条错误记进 `unsupported`，例如 `shader:flag:require:LightingV1`。
  - wasm 不可用（`loadWpesl2wgsl()` 为 null）时记 `shader:wasm-missing`。
- **新增** `features.ts`：已实现特性表与检查函数。`bundle.ts`：组装成 `SceneBundle`，是渲染器唯一的输入。
- **新增** `worker.ts`：在 Worker 里跑解析与翻译；主线程按 Worker 要的路径 fetch 文件，以 transferable 把字节交过去。
```ts
/** 一个 scene 壁纸编译后的完整描述：渲染器只读它，不再解析 WPE 的任何文件。 */
export interface SceneBundle {
  general: SceneGeneral;       // 新增：相机、正交尺寸、清屏色（已套默认值与当前用户属性）
  layers: SceneLayer[];        // 新增：按合成顺序
  programs: SceneProgram[];    // 新增：每个 (shader, combos, 纹理) 一个，内容即 wpesl2wgsl 的成功结果（WGSL、uniforms、textures、attributes）
  textures: SceneTexture[];    // 新增：解码后的纹理（格式、尺寸、mip 字节或 ImageBitmap、采样方式）
  unsupported: string[];       // 新增：用到但未实现的特性；非空时退回预览图
}
```

**点 P1-4 渲染器（新增 `apps/kabegame/src/wpe-scene/render/`、`WpeSceneView.vue`）——已完成（2026-11-01，opus 子代理实现 + Claude 复核）**
- 落地：`math` / `layout`（四边形、模型与视图投影、cover、指针，移植 LWE `CImage` / `Camera`）、`textures`（RGBA8 / BC3 全 mip）、`uniforms`（std140 + 内置 uniform 照 `CPass.cpp`）、
  `programs`（Tint 检查、绑定布局、混合）、`scene`（`GpuScene`）、`renderer`（设备、cover、帧循环、无缝换场景、设备丢失）、`clock`、`errors`（退回原因键）；`WpeSceneView.vue` emit `ready` / `fallback(reasons)`。
  `get_wpe_web_properties` / `set_wpe_web_user_properties` 放宽到 `x-wpe/scene`。开发依赖 `@webgpu/types`（TS 5.9 的 lib.dom 没有 WebGPU 类型）。
- 与原方案的差异 / 实现选择：
  - **相机**：正交场景直接用 `ortho(0…w, 0…h)`，不用 `eye`。LWE 的 `ortho·translate(eye)` 与 `lookAt` 恰好抵消；WPE 是加载末尾把三个值重置，视图为单位阵（L2），结果相同；eagleflag 的 eye 是编辑器残留偏移，预览图里画面没有平移。
  - **Tint 前言**：每个模块开头加 `diagnostic(off, derivative_uniformity);`。HLSL 允许分支里隐式求导，WGSL 不允许；不加时语料里 `effects/depthparallax` 被拒。
  - **`g_Time`**：暂停 / 页面隐藏时冻结，恢复后接着走，换属性重编译不重置；默认上限 60 fps。
  - **多 pass 材质**以 `render:multi-pass` 退回（ping-pong 留到 P2）；只处理 z 轴旋转。
- 对照基准：作者 `preview.jpg` 不可靠（beach 的预览图更亮、带光晕、偏移约 30 px），以 WPE 桌面实拍为准；beach 与实拍亮度差在 1–2%、几何重合。
- 未决：P1-5 要确认壁纸窗口里 `document.hidden` 的取值，否则桌面可能一直停帧。
- **新增** `WpeSceneView.vue`：自取数据的子组件，地位等同 web 层的 iframe。
  - 收 `target / paused / interactive`，自己读用户属性（沿用 Phase 7 读 metadata 的命令），自己 listen 本张的
    `image-changed { metadataId }`，收到后重新编译。
  - `WallpaperStage` 仍保持「只靠 props、不 invoke」。
- **新增** 运行时模块：
  - `device.ts`：适配器 / 设备；`texture-compression-bc` 必需，缺失时进 `unsupported`。
  - `textures.ts`：上传纹理，DXT5 用 `bc3-rgba-unorm`。
  - `programs.ts`：由 `SceneProgram` 建 pipeline 与 bind group layout。
    - group 0：binding 0 uniform 块，供两阶段共用；纹理 / 采样器按 `textures[].binding / samplerBinding`；
    - 顶点布局按 `attributes`。
  - `uniforms.ts`：按 `uniforms[].offset / stride / declared` 打包一块缓冲。
    - P1 需要的内置 uniform：`g_Time`、`g_ModelViewProjectionMatrix`、`g_Texture<n>Resolution`、`g_Color` / `g_Alpha`；
    - 材质常量与用户值按 `meta.material` 对上 `constantshadervalues` / `usershadervalues`。
  - `frame.ts`：rAF 循环。`paused` 时停循环，`document.hidden` 时降频。
- 场景按正交尺寸铺满画布。WPE 对宽高比不一致时的行为（例如三屏 5760×1080 放到单屏上怎么处理）要对照预览图，P1 先按 cover 实现。

**点 P1-5 `WallpaperStage` 接 scene 层（`WallpaperStage.vue`）——已完成（2026-11-01，opus 子代理实现 + Claude 复核）**
- 落地：
  - scene 层挂 `WpeSceneView`，类型判定拆到 `targetKind.ts`（有单测）。web / scene 两层共用淡入淡出等待逻辑。
  - `WallpaperTarget.previewPath` 取场景行的缩略图。
  - `isWpeWallpaperContentType` 认网页与场景。
  - 属性面板对场景也显示，隐藏 `file` / `directory`。
- 与原方案的差异：
  - **加载态**（用户要求）：结果出来前保持加载态，桌面保留上一张。能渲染直接淡入；不能渲染或 10 秒超时才显示预览图。预览图不再垫底，避免先闪预览图再跳成实时画面。
  - **应用背景不分支**（用户决定）：与预览同走 `ImageContent` 原图形态，网页与场景都实时渲染；网页壁纸页面的声音无法从外部静音。
  - **`document.hidden` 不是问题**：壁纸窗口挂在 WorkerW 下时 `visibilityState` 为 `visible`，rAF 144 帧 / 秒，渲染器没改。
- 未决：
  - 场景 → 场景切换会露出 0.2–0.4 秒窗口背后的内容，因为同一时间只允许一个场景。网页 → 网页也有同样的空档。
  - ~~预览「桌面画布」按 4K 渲染~~：已改为按显示尺寸（`getBoundingClientRect` × DPR，帧循环每 250 ms 核对）。
- **修改** `MediaType` 加 `"scene"`，新增 `isSceneTarget`、`enterScene` 与 `teardownScene`。切入切出照 web 层：独立层、淡入淡出、
  切走即销毁、一次只存在一个。`unsupported` 非空或 WebGPU 不可用时，退回预览图（行的缩略图就是 `preview.*`）。
```ts
type MediaType = "image" | "video" | "web" | "scene";   // 修改：新增 scene

/** WPE scene 壁纸：走独立 scene 层（WpeSceneView 的 canvas），不进 base / top 双层。 */
function isSceneTarget(target: WallpaperTarget): boolean {   // 新增
  return (target.type || "").trim().toLowerCase() === "x-wpe/scene";
}
```

**P1 验收**
- eagleflag、deep_space、beach 的 `unsupported` 为空，桌面与预览都正常渲染，与项目预览图一致；改 eagleflag 的旗帜颜色后立即生效。
- 其余 13 张默认样本退回预览图；工坊样本（入口在 `scene.pkg`）照常入库、显示预览图，编译能从 pkg 读出 `scene.json` 并列出 `unsupported`。
- 真机首项：
  - 在应用页用 wasm 翻译本机语料，逐份 `createShaderModule` + `getCompilationInfo`，没有 error 级消息（Tint 的校验，P1-0 只用 naga 回读过）；
  - 壁纸窗口挂在 WorkerW 下时 WebGPU 正常（调研只在主窗口验证过）；
  - 预览与桌面同时渲染不互相影响，打开预览时图库不卡。
- 主窗口与壁纸窗口用 `fetch(file:)` 读 WPE `assets/` 不被拒，日志里没有对应的 `deny file:`。

---

## P2 — effect 链、合成语义与后处理（razer_vortex；razer_bedroom 完整要等 P3）

**实现依据**：WPE 2.8.42 `wallpaper64.exe`（SHA-256 `40e2ce02…5cd993b0`）的只读静态逆向（2026-11-01，REA + Ghidra，见 D8；两轮报告全文与主会话核对记录见 [p2-REPORT.md](p2-REPORT.md)）。
下文的函数名是 Ghidra 自动名，用来回查证据；与 LWE 冲突时以 WPE 为准。两张样本的脚本：vortex 的 3 处脚本都只导出
`applyUserProperties`，bedroom 的 6 处都导出每帧 `update`。

### P2a — 渲染图、effect 链、混合模式、后处理档位（`disabled` 档完整）

- **新增** 设置「场景后处理」`跟随 WPE`（默认）/ `关闭` / `开启` / `超高`（D9）。
  - 跟随 WPE：只读 WPE 安装目录的 `config.json` 的 `postprocessing`。WPE 只认 `disabled` / `ultra` / `displayhdr`，其它非空值当「开启」，
    缺失当 `disabled`（`FUN_140046f20` 填默认值，`FUN_14010df40` 判定）；`displayhdr` 按「超高」处理（我们输出到普通画布）；读不到也按 `disabled`。
  - 每次加载场景时解析档位；改设置后正在显示的场景重新判定、重新加载。
  - 场景实际状态：**泛光** = 档位不是关闭，且 `general.bloom` 的生效值不为 false（缺键即开，构造默认标志 0x26，`FUN_140186c90`；
    setter `FUN_14019b4e0` 对 bool 或带 bool `value` 的对象都改位，写成属性对象时取绑定属性的当前值）；
    **HDR** = 档位为超高，且 `general.bloom`、`general.hdr` 都显式为 bool `true`（缺键或写成属性对象都不算）。
    （P2b 更正：属性对象也算，见 P2b「更正 HDR 判定」。）
  - P2a 只实现「泛光关、HDR 关」：泛光或 HDR 实际开启时记 `postprocess:bloom` / `postprocess:hdr`，P2b 去掉；`general.bloom` / `general.hdr` 键本身不再记。
- **修改** 能力表（`compile/features.ts`）只报真正改变画面的特性：
  - `copybackground` 只对 passthrough 模型（`composelayer` / `fullscreenlayer` / `projectlayer`，仍报 `model:passthrough`）生效，普通图像模型上忽略；
    `solid` 不参与渲染（推断与交互有关），忽略。
  - `brightness` 只在 HDR 下乘进颜色，P2a 不乘、不报。
  - `colorBlendMode`：0 普通；31 改成 additive；其它值走 passthrough（见下）。
  - effect 不再整条报 `effect:<name>`，改为逐项检查它的材质、着色器与字段。
  - 其余噪音项（关闭的 cameraparallax / camerashake、`zoom` 1、`ledsource`、零 `parallaxDepth`、居中 `alignment`、`autosize`、
    `camerafade`、`preview`、正交投影下的 `farz` / `fov` / `nearz` 等）逐项给出依据再放行，拿不准的继续报。
- **修改** 脚本绑定（D10）：只导出 `applyUserProperties`、没有 `update` / `init` 的脚本按 `value` 静态处理、不报；其余报 `value:script`（P3）。
  已知限制：用户属性对这类脚本的影响 P3 才生效（vortex 切换 mode 不变色）。
- **新增** 图层渲染图（`FUN_1401ea500` 分配、`FUN_1401e8aa0` 执行、`FUN_1401ebf60` effect pass）：
  - **合成 RT**：只有存在启用的 effect 或走 passthrough 时才分配，最多 2 张 ping-pong。
    - 尺寸取基础材质槽 0 纹理的**图像**尺寸（精灵表取单帧，没有纹理取图层 `size`），再取 max(4, ·)；UV 缩放 = 图像尺寸 / 纹理尺寸（`FUN_1402091e0`）。
    - 格式：LDR `rgba8unorm`，HDR `rgba16float`（P2b）。WPE 按尺寸跨图层共享池（`sc.<W>.<H>…`），可作为优化。
  - **基础 pass**：关闭混合（不透明写入、保留 alpha），正交投影画满合成 RT；`g_Color4 = (color · k, alpha)`，HDR 时 k = brightness，否则 k = 1。
    颜色只在基础 pass 设置一次（`FUN_140208670`）。
  - **effect**：未启用的（`visible` 为 false 或绑定结果为 false）整步跳过，也不计入上屏计数。
    运行时切换可见性会重算合成次数与 pass 数，有变化就重算尺寸、几何、合成 RT 与 passthrough 材质（`FUN_1401e6300` → `FUN_1402065e0`）；
    「最后一个启用 effect」每帧按计数判定。
  - **effect.json 的 `fbos`**：
    - `format`：`rgba_backbuffer` / `rgb_backbuffer` 随 HDR 变化，其它名字查格式表，不认识的按 rgba8888；
    - `scale`：整数除数，默认 1；`width` / `height`：≤4096 时覆盖尺寸；
      `fit`（≤4096 时生效）：W' / H' 取 width / height 或合成 RT 尺寸，W' < H' 时 h = min(fit, H')、w = W'/H'·h，否则 w = min(fit, W')、h = H'/W'·w，
      截断成整数后再除以 scale；width / height / fit 缺省 0xffff，即不生效；
    - `unique`：每层独占，否则同尺寸共享；`clear`：`"r g b [a]"`，创建或 resize 后清成该色；`uvs: "repeat"`：重复寻址，否则 clamp；
    - 尺寸 = 合成 RT ÷ scale，最小 2。
  - **effect.json 的 `passes`**：
    - `command`：缺省为绘制；`copy` = 把 `source` 整张复制到 `target`；`swap` = 不做 GPU 工作，只交换后续 pass 里引用这两个 fbo 的下标；
    - `target` 缺省为合成链；`compose: true` 写入合成 ping-pong；
    - `bind [{name, index}]`：找不到的名字（如 `previous`）= 当前合成 RT。
  - **材质 `textures` 里的 `null`**：由运行时填。没有 `bind` 时槽 0 = 上一步输出；有 `bind` 时只按 bind 赋值，不自动填槽 0。
  - **effect 实例**：`combos` / `constantshadervalues` / `textures` 覆盖与 `{user}` 绑定照旧（`light_speed` 经用户绑定驱动 scroll 的 speedx / speedy）。
  - **上屏**：只有最后一个启用 effect 的最后一个绘制 pass，用图层世界四边形、场景视图投影 × 图层模型矩阵画到场景，
    并借用基础材质的 blend 与深度状态（`FUN_140209160`）；其余 pass 画全屏四边形到各自目标。
    效果矩阵见下方「内置 uniform」。
  - **colorBlendMode ∉ {0, 31}**（`FUN_1401e6f50`、`FUN_1401ebbc0`）：
    - 合成 RT 数 +1，所有 effect 都留在合成 RT；
    - 最后用 passthrough 材质上屏：场景 `scene.json` 顶层 `version` > 2 时用 `effectpassthrough_4.json`（genericimage4），否则用 `effectpassthrough.json`（genericimage3），
      缺键按 0（`FUN_1401ecae0` → 0x1401853b0）。这与显卡、画质设置无关。
      本机默认样本都 ≤1，走 genericimage3；本机工坊 13 张里 11 张 ≥3，走 genericimage4，它无条件 `#require LightingV1`，要等 W1 打桩才能翻译；
    - combos 为 `BLENDMODE = cbm`、`FOG_COMPUTED = 1`，颜色 (1,1,1,1)，blend 取基础材质的，用图层几何上屏；没有 effect 时也走「基础 pass → 合成 RT → passthrough」。
  - **`_rt_FullFrameBuffer`**：场景目标的整帧快照，用 `copyTextureToTexture` 拷到独立纹理，**绝不采样正在写的目标**（LWE 的 GL 反馈环在 WebGPU 里是校验错误）。
    - 拷贝时机，三处都要求本图层还没拷过：
      - 图层开始时：基础材质需要帧缓冲或 cbm ∉ {0,31}；且图层非 fullscreen、或 cbm ∉ {0,31}、或有子层；且没有父层、或父层不是 passthrough 模型；
      - 需要帧缓冲的 effect 的第一个 pass 之前；
      - 最终上屏 pass 之前。
    - 内容 = 画到本图层之前的场景。
    - `g_Texture4` 等注解为 `"default": "_rt_FullFrameBuffer"` 的槽绑定它。
    - 「需要帧缓冲」由材质创建时算出（`FUN_1401515b0`）：材质的某个纹理槽最终解析到的名字是 `_rt_FullFrameBuffer`。
      解析顺序为材质 `textures` 里给的名字，没给取着色器注解的 `default`，都没有则为 `error`。
      effect 里任一 pass 的材质需要，该 effect 就需要（`FUN_1401e7170`）。
      同一张表里 `_rt_Reflection`、`_rt_MipMappedFrameBuffer` 各有自己的标志位，P2 用不到。
  - **颜色空间**：全程在 sRGB 编码空间计算。LDR 场景画完直接上画布，没有合成步骤。
- **新增** `.tex` 的 FreeImage 形态（`freeimage` ≠ −1，mip 数据是 PNG / JPG）：
  - 用 `createImageBitmap` 解码（`colorSpaceConversion: "none"`、`premultiplyAlpha: "none"`）。
  - 纹理尺寸：WPE 解码前把头里的纹理尺寸强制改成图像尺寸（`FUN_14015c8d0`），所以 UV 缩放为 1。
    例如头写 4096×4096、图像 3840×2160 时，两组尺寸都是 3840×2160，两组尺寸都取头字段、不取解码结果。
  - 解码后的纹理跨重新编译缓存，改属性时不重复解码 4K PNG。
- **新增** 内置 uniform 取值（`FUN_1400d8300`，P1 已有的按此校正）：
  - `g_Color4` = (color · k, alpha)；`g_Alpha` = alpha；`g_Color` = color · k。
  - 纹理：
    - `g_TextureNResolution` = (纹理宽, 纹理高, 图像宽, 图像高)，空槽 (2,2,2,2)；
    - `g_TextureNTexel` = (1/纹理宽, 1/纹理高, 纹理宽, 纹理高)，空槽 (0.5,0.5,2,2)；
    - `g_TextureNMipMapInfo` = max(0, mip 信息)，空槽 1。
  - 屏幕：
    - `g_TexelSize` = 1 / 屏幕尺寸，`g_TexelSizeHalf` = 0.5 / 屏幕尺寸，`g_Screen` = (w, h, w/h)；
    - 屏幕尺寸是窗口（后备缓冲）尺寸，在合成 RT、fbo、泛光 pass 里也**不随目标变**。我们按场景目标尺寸取，窗口与场景分辨率相同时等价。
  - 时间：
    - `g_Time` = 逐帧累加的秒数，超过 432000 归零；`g_Frametime` = 本帧 dt；
    - `g_Daytime` = 本地时间的一天中占比，h/24 + m/1440 + s/86400 + ms/8.64e7，范围 [0,1)。
  - 指针：
    - `g_PointerPosition` = 光标的窗口归一化坐标，原点左上、y 向下；`g_PointerPositionLast` = 上一帧的值；
    - `g_PointerState` = (按下, 按下, 本帧刚按下, 0)。
  - 效果矩阵：着色器能力位 4 才写，w、h 取图层 `size`。
    - 效果 pass：`g_EffectModelMatrix` = 图层世界矩阵 × scale(w/2, h/2)；`g_EffectModelViewProjectionMatrix` = 图层开始时的 MVP × 同一缩放；
      `g_EffectTextureProjectionMatrix` 与后者相同。
    - 上屏 pass：前两者不缩放，纹理投影 = MVP × scale(w/2, h/2)。
    - 各 `…Inverse` 由对应矩阵求逆。
- **验收**：
  - razer_vortex 的 `unsupported` 为空，桌面与预览都渲染，与 WPE 真机截图一致（用户当前 WPE 后处理为 `disabled`，vortex 本身 `bloom: false`）。
  - razer_bedroom 仍退回预览图，`unsupported` 只剩 `value:script`（档位不是关闭时另有 `postprocess:*`）；dev 强制渲染下构图与 WPE 一致，颜色因脚本不同。
  - eagleflag / deep_space / beach 不回归。
  - 本机默认样本与工坊样本的 `unsupported` 前后对比：列出新解锁的场景并抽查。
  - 单测覆盖：合成 RT 计数与上屏 pass 选择、`swap` 下标交换、`copy`、快照时机、能力表裁决、档位解析、脚本静态规则。
  - 三档切换后，正在显示的场景按规则重新判定。
- **落地（2026-11-01，opus 子代理实现）**：
  - 编译：`compile/postprocess.ts`（档位）、`compile/decode.ts`（FreeImage 主线程解码与缓存）、`features.ts` 重写、`bundle.ts` 增加 effect / passthrough / 注解默认纹理 / `needsFramebuffer` / `passthroughMaterial`、`tex.ts` 的 `encoded` 与 `freeImageTextureSize`、`fs.ts` 的 `location` 与 `readScoped`。
  - 渲染：`render/graph.ts`（`planLayer`、`fboSize`、`FboBindings`）、`scene.ts` 按步骤执行（`drawMatrices`）、`uniforms.ts` 按「内置 uniform」校正、`textures.ts` 位图上传、`programs.ts` 管线按目标格式与是否写 alpha。
  - 设置：core `SettingKey::WpeScenePostprocess` + `get/set_wpe_scene_postprocess`，前端 descriptor、设置页壁纸分区一行、五种语言；`WpeSceneView` 每次重载读设置、订阅 `setting-change` 重载，按目标持有纹理解码缓存。
  - 验收：vortex 解锁并在预览 / 应用背景 / 桌面实时渲染；bedroom 只剩 `value:script`；P1 三张不回归；单测 / 语料 / 检查全过（见回归文档「场景壁纸 P2a」）。与 WPE 实拍的对照待主会话。
- **与规格的差异 / 实现选择**：
  - **合成 RT 计数**按「写进合成链的次数」算：基础 pass、每个 effect 的最后一个绘制 pass、每个 `compose` pass 各一次，上屏的不算，min(2, ·)。正常 effect 下等于 WPE 的 `min(2, passthrough + Σ(1 + compose))`；一个 effect 里有多个无 target、非 compose 的绘制 pass 时（WPE 公式没覆盖），这里每个都 ping-pong 一次（推断）。
  - **合成 RT 池**按尺寸 + 采样方式跨图层共享，passthrough 下第 0 张也不独占（WPE 是 `_rt_imageLayerComposite_<id>_a`）；图层依次画、基础 pass 整张覆盖，画面没有差别。非 unique fbo 按名字、尺寸、格式、寻址共享。
  - **没有 bind 时槽 0 = 上一步输出**按字面无条件覆盖材质槽 0；有 bind 时 bind 覆盖材质值。`compose: true` 即使写了 target 也写合成链。
  - **copy** 用 `copyTextureToTexture`，要求两端格式相同（不同就 `render:copy-format` 退回），尺寸取交集；D3D `CopyResource` 要求同尺寸，WPE 遇到不同尺寸的行为未知。
  - **fbo `scale`** 在 width / height / fit 之后统一整除（规格「截断成整数后再除以 scale」只写了 fit 的情形）。
  - **着色器能力检查**不再按名字白名单：没有 `meta.material` 的 uniform 必须在 `ENGINE_UNIFORMS` 里（`uniform:<名>`），值非 0 的引擎 COMBO 报 `combo:<名>`，`_rt_*` 只认快照与本 effect 的 fbo。着色器声明了、材质没给的槽位按注解 `default` 绑定纹理（同 LWE；如 tint 的 `util/white`）。
  - **effect 资源查找**（规格没写）：effect.json 来自 assets 时先查 effect 目录，来自项目 / pkg 时先查根下的项目 / pkg 文件、再查 effect 目录、最后根下的 assets（razer 系项目自带的 `effects/tint` 与 assets 里内置的同名目录并存）。头文件不按 effect 查。
  - **快速退回**（规格没写）：运行时一旦 `unsupported` 非空就不再编译后面的图层与 effect，退回的工坊场景从约 250 次读取降到 2–4 次，预览图更早出现；代价是日志里的清单只是部分。`exhaustive` 列全，语料测试与能力表统计用它。
  - **size 回退顺序**：没写 `size` 时先取模型 width / height，再取基础纹理的图像尺寸（与 LWE 相反）；按 LWE 的顺序 deep_space 的 Background（槽 0 是 480×270 遮罩、模型 1920×1080）会缩成一小块，P1 一直按模型取。
  - **内置 uniform 校正**（P1 已有、取值有变）：`g_Texture<n>Resolution` 空槽由 0 改为 (2,2,2,2)；`g_TexelSize` 由场景分辨率改为场景目标尺寸（不超设备上限时相同）；`g_Daytime` 由 `(时×60+分)/1440` 改为精确到毫秒；`g_PointerPosition` 由场景坐标（左下原点、按 cover 换算）改为画布归一化坐标（左上原点、y 向下）；`g_Time` 加 432000 秒回绕；效果矩阵按 effect / 上屏 pass 分别取值（P1 的直接上屏与基础 pass 沿用原值，纹理投影单位阵）。新增 `g_Texture<n>Texel`、`g_Screen`、`g_Frametime`、`g_PointerState`（不跟踪按键，恒 0）、`g_ModelMatrixInverse` 与效果矩阵的 Inverse。`g_Texture<n>MipMapInfo` 没做，用到照报。
  - **dev 强制渲染**（D4 原本未落地）：`localStorage["kabegame-dev-scene-force-render"] = "1"`，只在 dev 构建生效，渲染器自查仍生效。
  - **config.json 多用户**：取第一个有 `general.user.postprocessing` 的 Steam 用户（WPE 按当前登录用户，我们拿不到）。
- **遗留**：
  - 与 WPE 实拍的 vortex 对照：**已完成**（2026-11-01，按相位扫描对齐后 1920 全图平均差 1.76、95% 像素差 ≤ 6，见 `p2-REPORT.md` J 节）；
    vortex 的「模式」属性要 P3 脚本宿主才生效。
  - **ledsource 图层走 passthrough**（RenderDoc 抓帧证实，`p2-REPORT.md` J 节）：vortex 的 led 层 colorBlendMode 为 0，WPE 仍是
    「基础 pass → 合成 RT → effect 画进第二张合成 RT → passthrough 上屏」，触发它的应是逆向里含义未知的图层标志 0x100（推断即 `ledsource`）。
    我们按普通图层处理（effect 最后一步直接上屏），能力表也把 `ledsource` 当中性放行。这层在屏幕外，画面无差别；
    遇到屏幕内的 ledsource 图层前要对齐：确认 0x100 的置位属性，`needsComposite` / `isPassthroughBlend` 把它算进 passthrough。
  - effect 可见性的运行时切换：现在改属性整场重编译，计数随之重算，没有 WPE 那种不重编的切换。
  - 精灵表单帧（合成 RT 尺寸、`SPRITESHEET` 仍报）；基础材质多 pass 仍报 `render:multi-pass`。
  - `g_EffectTextureProjectionMatrix` 只在 effect / 上屏 pass 按规格取值；没有样本用到，没验证。
  - 主窗口临时画布测试时第一张样本有一次用了约 160 秒才出第一帧（编译 248 ms），之后各张都在 2 s 内，未复现；疑与窗口当时被遮挡、rAF 暂停有关，未定位。
  - P1-5 的场景 → 场景空档仍在。

### P2b — 泛光与 HDR（`开启` / `超高` 档）

- **新增** LDR 泛光（`FUN_140183610` LDR 分支）：
  - 链路：`downsample_quarter_bloom`（`_rt_FullFrameBuffer` → `_rt_4FrameBuffer`，1/4）→ `downsample_eighth_blur_v`（→ `_rt_8FrameBuffer`，1/8，13 tap）
    → `blur_h_bloom`（→ `_rt_Bloom`，1/8）→ `combine_ldr`（`scene + bloom`，a = 1，不截断）。
  - `bloomstrength` / `bloomthreshold` / `bloomtint` 原样写进第一个下采样材质；RT 为 `rgba8unorm`，尺寸 max(2, W / 除数)，线性过滤 + clamp。
- **新增** HDR（`FUN_140183610` HDR 分支、`FUN_140184020` 参数）：
  - 场景目标、合成 RT、`*_backbuffer` fbo 都用 `rgba16float`；brightness 乘进 `g_Color4`。
  - **金字塔**：
    - L0 = 1/2（`hdr_downsample_bloom` 从场景下采样），之后逐级 1/2；
    - 可用级数 = min(w,h) 逐次减半仍 ≥1 的次数，最多 8；N = min(`bloomhdriterations`, 可用级数)，至少 1；
    - 上采样用 additive 混合，u ≥ N−2 用 `hdr_upsample_cubic`，否则用 `hdr_upsample`。
  - **`g_RenderVar0`** = (tx, ty, −tx, −ty)：下采样取源纹素，上采样取目标纹素。
  - **参数换算**：
    - `g_BloomStrength = bloomhdrstrength / (1 + scatter^(max(N,2)−2))`；
    - `blend = (t, t−k, 2k, 0.25/(k+1e−5))`，t = bloomhdrthreshold，k = t·bloomhdrfeather；
    - `scatter` 写给两个上采样材质。
  - **收尾**：
    - 有泛光时 WPE 用 `combine_hdr_upsample` 输出 `saturate(lin(scene + bloom)) · RV0.x`，SDR 显示时 RV0.x = 1（设备虚表 +0x158）。
      `lin()` 是 sRGB 解码，FP16 交换链再按线性显示，所以在普通画布上等价于 `saturate(scene + bloom)`；
    - 无泛光时 `combine_srgb` 等价于 `saturate(scene)`。
- **新增** 缺键默认值（场景构造函数）：strength 2、threshold 0.65、hdrstrength 2、hdrthreshold 1、feather 0.1、scatter 1.619、iterations 8、tint (1,1,1)；
  `clearenabled` 默认开，清屏色为 (clearcolor, 1)，与图层同一编码空间。
- **抓帧证实与补充**（`p2-REPORT.md` J5，bedroom 开启 / 超高档）：
  - 上面的链路、RT 尺寸与格式、`g_BloomStrength` / `blend` / `scatter` / `g_RenderVar0` 数值逐位一致；HDR 下后备缓冲、合成 RT 都是 RGBA16F，`g_Color4` 乘了 brightness。
  - **`g_RenderVar0` 用名义尺寸**：第 i 级的纹素 = 场景尺寸 / 2^(i+1)，不按向下取整后的 RT 尺寸算（L7 实际 15×8，偏移仍按 3840/256、2160/256）；RT 尺寸 floor(场景 / 除数)、至少 2。
  - 上采样混合 **SrcAlpha / One**（着色器输出 a = 1，即加法）；泛光链与 combine 的所有 pass 都只写 RGB（write mask 7），线性过滤 + Clamp。
  - 快照只拷一次（泛光链开始前的 `ResolveSubresource`），combine 读快照与 L0 / `_rt_Bloom`，写回场景目标。
  - LDR 泛光的第一步着色器（assets 原样翻译）是 `saturate(max(rgb) − threshold)·rgb` → `2·c − luma` → `× strength × tint`，常量是场景原值，不做换算。
- **更正 HDR 判定**（`32868-ghost-rider` 超高档抓帧）：工坊 3286859278 的 `general.bloom` 写成属性对象 `{user: "postprocessing", value: true}`、`hdr: true`，
  WPE 照样走 HDR（后备缓冲 RGBA16F、1/2 金字塔与 `combine_hdr_upsample`）。G3「属性对象不算」的推断不成立：
  **HDR = 档位为超高，且 `general.bloom` 的文件值与 `general.hdr` 的生效值都为 true**。
  `bloom` 读场景文件：bool 原样，属性对象取 `value`，不读属性当前值，也不看脚本写入（这张抓帧分不出，P3c 实测查清，见 `p3-script-REPORT.md` K3）。
  `hdr` 读属性当前值与脚本覆盖：WPE 连加载时都只读 JSON，属性不起作用，用户判定是 WPE 的 bug，有意不跟（P3c 已定 12）。
- **验收方法（D13）**：bedroom 的颜色要 P3 才对得上、LDR 泛光又全黑，所以 P2b 用**链路隔离验证**：
  从抓帧导出 WPE 泛光链的输入（整帧快照）与最终后备缓冲，喂给我们的泛光 + combine，逐像素比较；整张场景我们能不能渲染无关。
  要一个只在 dev 构建里存在的测试入口。
- **基准抓帧**（`A:\`，均为用户 2026-11-01 所抓）：

  | 目录 | 档位 | 用途 |
  |---|---|---|
  | `A:\neo-sunset\enabled\` | 开启 | LDR 泛光主基准（threshold 0.36、strength 0.5） |
  | `A:\shimmering-particles\{enabled,highres}\` | 开启 / 超高 | LDR 第二样本；HDR 第二样本（scatter 1.13、**feather 0**、threshold 0.7、`bloomhdrstrength` 绑属性 glow、`bloomstrength` 绑只有 `applyUserProperties` 的脚本） |
  | `A:\bedroom\{enabled,highres}\` | 开启 / 超高 | HDR 主基准（N = 8）；开启档泛光全黑（threshold 1），用来验证「泛光为 0 时 combine 不改画面」 |
  | `A:\32868-ghost-rider\highres\` | 超高 | `bloom` 为属性对象时仍走 HDR |

- **范围**：预览、应用背景与桌面同档（D13），不为预览降档；HDR 时的显存（4K 一个实例约多 160 MB）靠预览分辨率优化缓解。
- **验收**：
  - 链路隔离：以上每组抓帧，我们的泛光链中间结果（L0 / `_rt_Bloom`）与最终输出对 WPE 逐像素比较，给出平均差、p99、最大差；
    HDR 输出按 sRGB 编码 WPE 的线性后备缓冲后再比（等价于我们画布上的 `saturate(scene + bloom)`）。
  - 单测：档位 / 泛光 / HDR 判定（含属性对象）、金字塔级数与名义纹素、参数换算（含 feather 0、iterations 小于可用级数）、RT 尺寸取整。
  - bedroom 在超高档 dev 强制渲染下构图与 WPE 一致（颜色因脚本不同）；关闭档画面与 P2a 逐像素相同（不回归）；vortex、P1 三张不回归。
  - 三档切换：bedroom 退回原因只剩 `value:script`；性能记录：4K 超高档单实例的帧时间与显存。
- **落地（2026-11-01，opus 子代理实现）**：
  - 编译：`compile/postprocess.ts`（HDR 改生效值规则；`bloomParams` 与缺键默认值 `BLOOM_DEFAULTS`）、新增 `compile/bloom.ts`（LDR 四个 / HDR 五个 util 材质表、`compileBloom`、只在泛光 pass 放行的 `POSTPROCESS_UNIFORMS = {g_RenderVar0}`）、`bundle.ts`（`bundle.bloom`、`general.bloom`、`layer.brightness`、与图层共用的 `addProgram`；去掉 `postprocess:*`）、`shaderUniforms` 挪进 `shader.ts`、`features.ts` 的 `checkProgramFeatures` 加 `extra`、`model.ts` 的宽松 JSON。
  - 渲染：新增 `render/bloom.ts`（纯函数 `planBloom` / `bloomLevels` / `bloomIterations` / `bloomTargetSize` / `hdrBloomConstants`，GPU 侧 `BloomChain`）；`scene.ts` 按 HDR 选场景目标 / 快照 / 合成 RT 格式、图层颜色乘 `brightness`（`uniforms.ts` 的 `colorScale`）、全部图层之后的 `bloom` 步骤（拷快照 → 链 → combine 写回场景目标）、`targetBytes` 显存估算；`renderer.ts` 的 `sceneStats`；`WpeSceneView` 日志带泛光 / HDR、目标格式与显存。
  - dev 测试入口（D13）：`wpe-scene/dev/`（`probe.ts` 的 `renderFrame` 按固定 `g_Time` 渲染并同步读回场景目标、`bloomProbe.ts` 的链路隔离、`install.ts`），`bootstrap/app.ts` 里 `IS_DEV` 门控；生产模式 `vite build` 确认整块被摇掉。
  - 验收：
    - 链路隔离（6 组抓帧，输入为 RenderDoc 导出的快照，参数取抓帧常量缓冲；差值为 RGB 逐通道）：

      | 抓帧 | 第一步 | `_rt_Bloom` / L0 | 最终输出 |
      |---|---|---|---|
      | neon_sunset 开启 | 1/4：max 1/255，0.0084% 通道差 1 | max 1/255，0.0072% | max 1/255，0.0069% |
      | shimmering 开启 | 1/4：max 1/255，1 个通道 | 逐值相同 | 逐值相同 |
      | bedroom 开启 | — | 全 0，与 WPE 相同 | 与输入逐字节相同（泛光为 0） |
      | bedroom 超高 | L0 下采样后逐值相同 | 上采样后 max 3.8e−6（1 个像素差 1 个 FP16 ulp，相对 9.7e−4） | max 1/255，0.43% 通道 |
      | shimmering 超高（feather 0） | 逐值相同 | 逐值相同 | max 1/255，0.54% |
      | 工坊 3286859278 超高 | 逐值相同 | 逐值相同 | max 1/255，0.88% |

      平均差都 < 0.009/255，p99 都是 0。HDR 最终输出把 WPE 的线性 FP16 后备缓冲按 sRGB 编码成 8 位后再比；剩下的 ±1 来自两边在不同空间存 FP16 的舍入（我们存编码值，WPE 存线性值），量级与 DWM 自己的 8 位转换相当。
    - 参数换算与抓帧常量逐位相等（`g_BloomStrength` 0.1310582309961319 / 0.6489394307136536 / 0.28125885128974915，`blend` 两组），在 `render/bloom.test.ts` 里断言。
    - 关闭档：bedroom（强制）/ vortex / eagleflag / deep_space / beach 的离屏目标与改动前的 P2a 渲染器逐字节相同（同 `g_Time`，SHA-256）；超高档下 `bloom: false` 的 vortex 与 P1 三张也相同；bedroom 开启档（threshold 1，泛光全 0）与关闭档相同。
    - 三档切换（真 app，预览 bedroom + 应用背景 vortex）：每次重新判定、重新加载，bedroom 退回原因都只剩 `value:script`。
    - bedroom 超高档强制渲染：「18 层、12 个程序，泛光 + HDR，3840×2160 rgba16float」，构图、光晕位置与范围同 WPE 抓帧，灯色因脚本不同。
    - 性能（NVIDIA Lovelace，4K，`renderFrame` 连续 120 帧、每帧编码 + 提交 + 等 GPU 完成）：关闭 / 开启 / 超高平均 5.2 / 5.2 / 6.4 ms，p95 8.4 / 9.5 / 10.9 ms；渲染目标显存约 70 / 73 / 161 MiB（超高多出的是 FP16 场景目标与快照各 63 MiB、金字塔约 21 MiB）。预览开着 bedroom 超高档时主窗口 rAF 143 fps（关闭档 139 fps）。
- **与规格的差异 / 实现选择**：
  - **HDR 收尾**用 `combine_hdr_upsample_linear`（同一份 `combine_hdr` 的 `LINEAR=1`，也是 WPE assets 原件）输出 `saturate(scene + bloom)`，而不是 `combine_hdr_upsample` 再在 cover 时编码：sRGB 编码是 `lin()` 的精确反函数，两者单调、把 [0, 1] 映到 [0, 1]，encode(saturate(lin(x))) = saturate(x)，画布上逐值相等；少一次 pow 往返，cover 不用分 HDR / LDR 两种着色器。实测最终输出与 WPE 只差 FP16 舍入（上表）。
  - 快照与图层的 `_rt_FullFrameBuffer` 共用一张纹理，泛光在全部图层之后再拷一次（WPE 也是此处一次 `ResolveSubresource`）。
  - 金字塔照 WPE 建满全部可用级，每帧只用前 N 级（P3c 更正；P2b 原先只建 N 级，改级数只能重编译）：绘制按步骤身份去重，8 级共 21 个，`bloomhdriterations` 能就地改，代价是 N 小的场景多占显存（4K、N = 1 多约 5.5 MiB）。
  - 「屏幕尺寸」取场景目标尺寸（P2a 起的约定）：场景分辨率与窗口相同时与 WPE 等价；shimmering_particles 是 5760×1080，WPE 按窗口 3840×2160 画场景与泛光，我们按场景分辨率，泛光核的像素尺度不同（见遗留）。
  - 参数按 float32 逐步计算（`Math.fround`），与抓帧逐位一致；`g_RenderVar0` 也按 float32 写。
  - 翻译器的槽位格式（`TEX<n>FORMAT`）：泛光槽按 WPE 的 RT 枚举给 `rgb888` / `rgb161616f`；图层材质里合成 RT 槽在 HDR 下仍给 `rgba8888`（着色器不按它分支）。
  - `g_CompositeColor` 不乘 brightness（I4 表里没有它，保持 P2a 取值）。
  - 场景没有对象时不跑泛光链；HDR 而无泛光（只有这种情况）不画 `combine_srgb`，8 位画布本来就截断，等价于 `saturate(scene)`。
  - 规格外：场景 / 材质 / effect JSON 改用宽松解析（去对象 / 数组结尾的逗号）。新订阅的工坊 3286859278 自带 `effects/fluidsimulation/effect.json` 有尾逗号，WPE 照常加载，我们原来在 `exhaustive` 编译时直接抛错、语料测试整个失败。
- **遗留**：
  - 本机能实时渲染的场景（vortex、P1 三张）都是 `bloom: false`，用户在真机上暂时看不到泛光；开着泛光的 bedroom 要 P3、shimmering_particles 要 P4、neon_sunset 要 P5。
  - shimmering_particles 的 `bloomstrength` 绑了只导出 `applyUserProperties` 的脚本：WPE 抓帧里是 1.0（glow 默认 2 × 0.5，推断 WPE 加载时以全部属性调一次 `applyUserProperties`），我们按 D10 取 `value` 1.12。P3 脚本宿主要核对这个初始调用。
  - 场景分辨率与窗口不同的场景（三屏 5760×1080）WPE 按窗口尺寸画，泛光半径按窗口像素；我们按场景分辨率再 cover。要与超宽场景的铺放一起对照 WPE。
  - 桌面壁纸窗口本次没测（当前不是窗口模式，没有改用户的壁纸设置）；与预览共用 `WpeSceneView`，同一条 `setting-change` 通路。
  - HDR 显存：4K 单实例多约 91 MiB，预览分辨率优化（按画布尺寸降场景目标）还没做。
  - HDR 下 effect 的 `copy` 两端格式不同（合成 RT 为 `rgba16float`、fbo 写死 `rgba8888`）时报 `render:copy-format` 退回；WPE 的 `CopyResource` 也要求格式兼容，实际行为未知，没有样本。
  - 帧时间是串行测量（每帧等 GPU 完成），没有用 timestamp query 单独量泛光链的 GPU 时间。
  - `displayhdr` 按超高处理，HDR 显示器输出（`combine_dhdr_upsample`、FP16 交换链）不做（D9）。

### P2 仍未知（按 LWE 约定实现，靠截图兜底）
- `g_ParallaxPosition` 的计算细节（视差功能关闭时用不到）。
- `solid`：渲染侧没有读取点，推断只与交互 / 命中检测有关。
- 材质 `+0x1f8` bit2（「材质自带尺寸」）的置位点；精灵表单帧尺寸的细节（TEXS 帧表）。
- 渲染标志 0x1800000 的设置者（壁纸进程里没有，推断属于编辑器）。
- 图层标志 0x100（触发 passthrough）由哪个属性置位：RenderDoc 抓帧里只有 `ledsource` 图层走了 passthrough，推断是它；可用 REA 查图层属性表里写 `+0x304` 0x100 的 setter 坐实。

## P3-0 — 场景宿主：渲染器与脚本同处一个隔离 realm（2026-11-02 提出）

场景宿主是一种特殊的网页壁纸：独立项目 `apps/wpe-scene`（纯 TS + Vite）构建进 resources，主窗口 / 壁纸窗口以 `file:` iframe 加载，
编译、渲染与 P3 的场景脚本都在里面；与应用之间只走 Tauri IPC。MVP（宿主骨架、`file:` 范围、运行时 capability）已提交（812d1777）。
- 总述、已定决策与实测记录：[phase-3-0-scene-host.md](phase-3-0-scene-host.md)
- 3-0a 宿主与应用的通路：[phase-3-0a-host-channel.md](phase-3-0a-host-channel.md)
- 3-0b 渲染器迁进宿主：[phase-3-0b-renderer-move.md](phase-3-0b-renderer-move.md)
- 3-0c 子 frame 不再跨窗口复用渲染进程（CEF 08，全局）、同进程 iframe 每帧只派发一次 rAF（CEF 09）：[phase-3-0c-frame-process.md](phase-3-0c-frame-process.md)
- 下一步：正式 P3 拆成 [3a](phase-3a-bindings.md) / [3b](phase-3b-script-runtime.md) / [3c](phase-3c-runtime-graph.md)，见下一节。

## P3 — SceneScript（razer_vortex · razer_bedroom 完整）

依据 [p3-script-REPORT.md](p3-script-REPORT.md)（WPE 2.8.42 SceneScript 运行时逆向 A–H，用户属性运行时更新 I1–I10）。目标：脚本在场景宿主主线程上同步执行、照 WPE 的时序与写回规则；用户改属性就地生效、不整场重编译。
2026-11-03 定的方案（见「关键决策」D14）拆成三步，旧草案（不透明源 iframe + 每帧消息往返）作废：
- **3a 属性绑定表与快速路径（不含脚本）**：[phase-3a-bindings.md](phase-3a-bindings.md)。bundle 带绑定表（属性名 → 目标，可带 condition），宿主一个应用函数（加载传全集、运行时传增量），CPU 侧 `SceneState` + 每帧刷脏；材质常量、图层变换 / `alpha` / `color` / `visible`（含条件可见）、泛光参数就地，其余仍重编译；去掉 `visible:condition`。
- **3b 脚本运行时**：[phase-3b-script-runtime.md](phase-3b-script-runtime.md)。可行性探针先行；同源 `about:blank` 子 frame 作独立 realm、`baseclasses.js` 经典脚本 + 每段一个 ES 模块；每帧计时器 → `update` 写回 → 渲染；最小 API + 骨架；出错禁用单个回调、15 s 停全部脚本；重编译保留 realm；删除 `value:script` 与 D10 静态规则；语料给出解锁清单与缺失 API 排行。
- **3c 运行时渲染图**：[phase-3c-runtime-graph.md](phase-3c-runtime-graph.md)。effect 可见性单图层重算（`FUN_1401e6300`）、泛光开关与级数、清屏色 / 环境光 / 相机就地，做到 WPE 的程度。
- **验收样本**：vortex 切「模式」颜色模式跟着变（3b）；bedroom 解锁，彩虹灯带按墙钟循环、与 WPE 同一时刻同色，`light_speed` 改滚动速度（3a）；shimmering_particles 的 `bloomstrength` 首次 apply 后为 1.0（3b，dev 强制渲染下经探针读）；eagleflag / vortex / bedroom 拖属性不重新编译（3a）。

## P4 — 粒子系统（shimmering_particles · 3062029089 · 1838478131 · 2254685070）

总计划见 [phase-4-particles.md](phase4/phase-4-particles.md)。2026-11-07 用户定范围为全部 70 张的粒子用法，目标从跑通一张样本改为建好粒子运行时；层级支持从 W1 提前到 P4a。

- **分节**（P4a–P4f 各有步骤 0，只查本节要用的内容）：P4-0 对比工具与框架问题；P4a 层级、底座与档 1；P4b 帧表、`rg88` / `r8` 与档 2；P4c `spritetrail` 与控制点；P4d 绳与映射；P4e 子系统与音频；P4f 脚本与深度。
- **模块归属**：档 2–4 的模块从 W2、W5、W6、P8 提前到这里；层级从 W1 提前到 P4a；R8 / RG88 从 W5 提前到 P4b。
- **kabegame-sample**（用户自建，2026-11-07）作为 P4 的整场验收样本；按它的调研（[sample-gaps](phase4/sample-gaps.md)）补入 `vortex_v2`、`maintaindistancetocontrolpoint`、世界空间、发射器 `flags`、`static` 子系统、控制点 `flags`、`NORMALMAP`，归属见粒子总计划。它还用到形状对象（W1）和属性关键帧动画（K），P4 做完后还差这两项。
- **绘制方式**：翻译后的 `a_TexCoordVec4` 同时装角点 UV、旋转和尺寸，不用实例化四边形，改成每个粒子 4 个顶点加索引。
- **验收**：粒子用法覆盖 70 张，解锁 `shimmering_particles`、`3062029089`、`1838478131`、`2254685070`；粒子带随机，不比预览图，改用确定性工程和 WPE 逐帧对比。

## P5 — 相机、网格与图像模型标志（retro · neon_sunset · dna_fragment · techno 等 18 张）

总计划见 [phase-5-camera-mesh.md](phase5/phase-5-camera-mesh.md)。2026-11-10 用户定范围为语料里相机、网格与图像模型标志的全部用法，目标从两张样本改为解锁 18 张（能渲染 22 → 40）。

- **分节**：前置（能力表修正）；P5a 视差、抖动与缩放（[子计划](phase5/phase-5a-parallax.md)）；P5b 图像模型标志（组合层、`fullscreen`、`projectlayer`、`nopadding`、`instanced`、图像层 `perspective`）；P5c 静态网格（全部 mdl 版本，不含骨骼与变形）；P5d 透视相机、相机路径、相机对象与深度。
- **从别处移来**：dna_fragment、techno 从 P7 提前到 P5d；相机对象从 W3 提前到 P5d；视差不再等 P6，P4c 已接好指针。深度附件由 P5d 建、P4f 复用。
- **验收**：和 WPE 抓帧比，不比作者的预览图；每节有确定性工程。
- **P5a 已完成**（2026-11-10 – 11-12，[子计划](phase5/phase-5a-parallax.md)「实施记录」「P5a 收尾」）：前置并进了 P5a 步骤 1。能渲染 23 → 36，解锁 13 张（前置 1 张、视差 11 张、抖动 1 张，缩放不单独解锁），和总计划的预期一致；起点 23 是因为同期 P4d 解锁了一张。视差、抖动、缩放的测试工程和 WPE 整帧逐像素一致。收尾另查出视差点初值多 (2, 2) 并对齐，补了开场指针（`wpe_scene_cursor`）与回放逐帧光标。文档见 `cocs/wpe/WPE_SCENE.md`「相机：视差、抖动与缩放（P5a）」。
- **P5b 已完成**（2026-11-12，[子计划](phase5/phase-5b-modelflags.md)「实施记录」「P5b 收尾」）：步骤 0 实测核对读码，1 尺寸来源、UV 内缩与图像层透视，2 组合层（无子层）与 `projectlayer`，3 `fullscreen`，4 带子层的组合层（组），5 `instanced`。P5b 的七个键全部去掉，只新增两个细分键（组里的子孙读快照 1 张、instanced 的用户纹理 9 张）。解锁 `1923929928`，`1333579536` 加上 P4e 的粒子子系统一起能渲染；和总计划预期的「P5b 解锁 1 张」一致；其余用到这些标志的场景大多还差文本、木偶动画、视频纹理。确定性工程和 WPE 整帧最大差 2。文档见 `cocs/wpe/WPE_SCENE.md`「图像模型标志（P5b）」。
- **P5c 已完成**（2026-11-12 – 11-13，[子计划](phase5/phase-5c-mesh.md)「实施记录」「P5c 收尾」）：步骤 0 用自写的 mdl 编码器生成确定性工程、实测核对读码，1 编译（翻译器给属性标 `unused`、mdl 解析、模型图层、细分键），2 绘制（按语义配对的顶点布局、背面剔除、视锥剔除、模型 uniform、法线矩阵）。`object:model` 拆成 `mdl:*` / `model:*` 细分键。解锁 retro，和总计划预期的「P5c 直接解锁的只有 retro」一致；其余 12 张模型场景是透视场景（P5d），或还差反射、音频频谱、相机对象等。确定性工程和 WPE 整帧 0 差异，retro 最大差 1。文档见 `cocs/wpe/WPE_SCENE.md`「静态网格（P5c）」。

## P6 — 声音、文本、交互与动态图层（dino_run 等，用到 106 张）

总计划见 [phase-6-script-text-sound.md](phase6/phase-6-script-text-sound.md)。按语料重扫（2026-11-11，165 张）：文本 91 张、声音 77 张、光标输入与回调 47 张、建层与层级 21 张、图像层帧表 16 张，合计 106 张。目标从 dino_run 一张改为覆盖这几类用法：只做 P6，能渲染 35 → 40；P4、P5 先做完时 45 → 56。

- **分节**：前置（未实现的导出回调照报 `script:callback:*`）；P6a 声音；P6b 文本；P6c 交互；P6d 动态图层与层级 API；P6e 图像层帧表。
- **从别处移来**（D15）：光标回调、`input.*`、声音的脚本控制、`systemfont_*` 原在 W4；文本 API 原在 W2；层级 API 原在 W1 / W5。
- **已经不用做**：`localStorage`（P3b 已实现、持久化）、`camerafade`（能力表当中性）、godrays 等多 pass effect（P2a 起支持）。
- **验收**：和 WPE 比。文本的纹理尺寸、基线与字形包围盒严格一致，像素按误差包络比；声音按日志逐帧比播放状态，出声靠人耳。范围、顺序、验收方式在总计划里待用户定。

## P6 之后的分节（2026-11-11 重分，D15）

P6 之后按能力分节，不再按壁纸。原来的 W1–W6、旧 P7 / P8、K、旧 P9 里，已被 P2–P6 吸收的划掉，剩下的排成 P7–P13 与「按需」，编号就是推荐顺序。旧名的去处见本节末的「旧名对照表」。

统计基于 HEAD `47486b72` 的语料扫描，2026-11-11 用户新下载 13 张后共 165 张（`ignore/p6/out/corpus-new.json`，`ignore/p6/ana_phases.py`）：新的 13 张没带来新的能力类别，新键都能归进已有各节。
- 「用到」是报这一节任一键的场景数。导出了没实现的回调的，按 P6 前置的 `script:callback:*` 计。
- 「只差它」「累计能渲染」都假设 P4–P6 先做完（能渲染 56 张）；累计按表的顺序依次去掉各节的键。
- 各节动工前另写总计划，覆盖数按那时的能力表重算。

| 节 | 内容 | 来自 | 用到 | 只差它 | 累计能渲染 |
|---|---|---|---|---|---|
| P7 | effect 与着色器补全 | W1 前置，W4–W6 的工坊 effect，旧 P9 | 65 | 9 | 65 |
| P8 | 图像层与材质补全 | W1 的形状对象，散项 | 45 | 6 | 72 |
| P9 | 视频纹理 | W2、W3 | 39 | 12 | 89 |
| P10 | 关键帧动画 | K，W5 的 `getAnimation` | 40 | 0 | 92 |
| P11 | 音频、媒体与用户资源 | W2、W3、W5，旧 P7 的音频 | 53 | 2 | 122 |
| P12 | 骨骼与 puppet | W6 | 35 | 5 | 154 |
| P13 | 3D 反射、光照与阴影 | 旧 P7、旧 P8 | 11 | 2 | 165 |

- 各能力在同一批场景上交叉：一张工坊场景常常同时要视频、关键帧、音频和 puppet。所以「只差它」都小，后几节一次解锁很多。
- 全部做完，语料 165 张都能渲染。其中还要 P4f 的 `emitParticles`、P6a 的三维声音，已归进那两节。
- **顺序：** P7 改的是 Rust 翻译器，不碰场景渲染器的共享文件，现在就能和 P4–P6 并行。P8 等 P5b 改完图像层。3D 承接 P5、放在最后，沿用 D7「工坊在 3D 之前」的用意。

## P7 — effect 与着色器补全

总计划见 [phase-7-effects-shaders.md](phase7/phase-7-effects-shaders.md)。按根因分两类：规则类（照 WPE 自己的预处理与改名，34 张用到）不需要类型信息；类型类（HLSL 隐式转换，含 varying 宽度不同与片元写 varying，48 张）把 naga 源码嵌进翻译器（顺便删掉用不到的翻译模块），给 GLSL 前端加 HLSL 隐式转换模式（2026-11-11 用户定）。只做 P7，能渲染 35 → 37；P4–P6 先做完时 56 → 65。

- **翻译失败的工坊着色器**（`shader:*`，64 张）：作者手写的写法，WPE 能编过、我们的翻译器拒绝。
  - 类型：隐式类型转换（标量与向量混算、赋值时截断）、两个阶段的 varying 类型不同；
  - 函数名：`mix`、`texture` 这类 GLSL 名字出现在 WPE 方言里；
  - 预处理：不配对的 `#endif`、`#if` 里的分号；
  - 最多的是工坊 effect `Simple_Audio_Bars` 的几个版本。
  - 类型类的问题要类型信息，规则改写做不到：要么扩展翻译器，要么在 naga 的 IR 上处理（见「风险」）。步骤 0 先查 WPE 自己怎么处理这些写法。
  - 先把 pkg 里的工坊着色器加进翻译器的语料测试（原 W1 前置）。
- **effect JSON 的字段：**
  - `fluidsimulation`（WPE 自带的流体 effect，1 张）：pass、bind、fbo 上的 `conditions`（按 COMBO 选），`functions`（`clear` 动作，经脚本 `executeMaterialFunction` 触发），effect 级 `combos`。模拟 RT 跨帧保留，跟着光标动，所以要 P6c。
  - `editable`：`wallpaper64.exe` 里没有这个字符串，推断是编辑器键，按中性放开。
- **varying 的布局（P7e，2026-11-14 加）**：WebGPU 缺省 16 个阶段间变量，语料 5 张超过（`auto_sway` 4 张、示波器 3585875739），运行时建管线失败。照 WPE 的数组长度（`vec3` / `vec4` 数组只剩 `ceil(n / 4)` 个元素）并在超过时打包进 vec4，见 [phase-7e-varyings.md](phase7/phase-7e-varyings.md)。2026-11-14 完成：改后最多 13 个 location，确定性工程与 WPE 逐格一致，3585875739 运行时能画了；不解锁别的场景。收尾另修上界是字面量 0 的 `smoothstep`（fxc 把 `0.0 - lo` 化成 `-lo`，示波器没有声音时整张提亮）。
- **验收：** 翻译器的语料测试覆盖 pkg 里的工坊着色器；解锁的场景和 WPE 同一时刻的画面比。

## P8 — 图像层与材质补全

总计划见 [phase-8-image-material.md](phase8/phase-8-image-material.md)（2026-11-12）。**P8 已完成**（2026-11-14，总计划「实施记录」）：合成 RT 的采样、形状对象、对齐、图层依赖、写入状态五步，解锁 `3656079027`、`3668499717`、`3811764016`、`3812887609`、`3819646765`、`3821678218`；收尾时（183 张）用到 P8 的 57 张能渲染 10 张，P8 的键清零，其余 47 张还差场景脚本、关键帧动画、用户纹理、木偶动画等。按 173 张重算：56 张用到；只做 P8 能渲染 47 → 53，P4–P7 先做完时 60 → 69。和下面的原始范围相比，多了图像层的 `clampuvs`（原先整个算进 P6 文本，15 张），引用自己的合成 RT 已经中性、不在范围里，`alphawriting` 只剩 `cursorripple`；分五步：合成 RT 的采样、形状对象、对齐、图层依赖、写入状态。下面是写总计划之前的原始范围。

- **形状对象** `shape: "quad"`（原 W1，读码见 [sample-gaps](phase4/sample-gaps.md) §2.1）：图像类的子类，边长等于正交高度的正方形；只画最后一个 effect 的 pass，强制 `DIRECTDRAW=1`、强制 additive。语料 18 张，`3821678218` 在 P4b 之后只差这一项。
- **图像层的散项：**
  - 对象 `alignment` 取非 `center`（21 张）、`dependencies`（9 张）、`nointerpolation`（3 张）；
  - 材质 `alphawriting`（6 张）、混合 `alphatocoverage`（2 张）；
  - 引用别的图层合成 RT 的 `_rt_imageLayerComposite_*`（8 张）。
- **依赖：** 等 P5b 改完图像层的几何、UV 和合成 RT。
- **验收：** 每项一个确定性工程，和 WPE 逐像素比。

## P9 — 视频纹理

总计划见 [phase-9-video.md](phase9/phase-9-video.md)（2026-11-12）。**P9a 已完成**（2026-11-13，[子计划](phase9/phase-9a-playback.md)「实施记录」）：视频纹理照 WPE 播放（加载即播、缺省循环、不出声、30 帧没画到就暂停），能渲染 47 → 50（173 张口径）。**P9b 已完成**（2026-11-13，[子计划](phase9/phase-9b-script.md)「实施记录」）：脚本 `getVideoTexture` / `IVideoTexture` 照 WPE 实测，时长取容器头，视频元素挂进宿主页面最上层（看不见的视频暂停后恢复要等约 255 ms）；用到它的 6 张还差别的节，能渲染数不变。按 175 张重算：41 张用到、60 段视频（H.264 59、HEVC 1，其中 1 段装在 Matroska 里）；只做 P9 能渲染 45 → 48，P4–P8 先做完时 70 → 84。和下面的原始范围相比，帧改为拷进普通纹理（不用 `importExternalTexture`），退路从 MSE 改成 Rust 缓存文件或 WebCodecs，静不静音按步骤 0 定。下面是写总计划之前的原始范围。

- `.tex` 的 flags 含 Video（32）时，唯一 mip 是完整 MP4，起点按容器版本解析（见「补充事实」）。语料 39 张。
- **读取：** 按区间读出 MP4，做成 Blob，交给静音循环的 `<video>`，每帧 `importExternalTexture`；解码交给浏览器。
  - 单段最大 707 MB：Blob 的内存占用和 4K60 的解码开销要实测。不行再看 MSE 分段喂入，或由 Rust 把区间解到缓存文件。
- **多段视频**（原 W3）：按时段切换，脚本经 `getLayer` 改 `visible`；不可见的视频暂停解码。
- **脚本：** `getVideoTexture`（6 张）。
- **验收：** 和 WPE 同一时刻的画面比；视频流畅循环；隐藏、切走时停止解码；预览与桌面同时播放的开销实测。

## P10 — 关键帧动画

总计划见 [phase-10-keyframes.md](phase10/phase-10-keyframes.md)（2026-11-13）。按 173 张重算：40 张带关键帧、228 处，42 张用到 P10 的键；只做 P10 能渲染 47 → 47，P4–P9 先做完时 82 → 84。它主要是 P11 / P12 的前置：P4–P10 做完后，这 42 张里 17 张只差 P11、15 张差 P11 + P12。分三节：曲线与自动播放、脚本与事件、联动。灯和相机对象上的关键帧照报，分别随 P13、P5d 做。下面是写总计划之前的原始范围。

- **是什么：** 属性值写成 `{animation: {c0, c1, …, options: {fps, length, mode, …}}, value}`，按时间轴插值，可以和 `user`、`script` 并存。2026-11-07 统计语料 32 张、169 处（不含 puppet 的 `animationlayers`）：图层 `alpha` / `origin` / `angles` / `scale` / `color`、材质常量、`general.zoom` / `bloomstrength`、`instanceoverride` 等。
- **现状：** 能力表报 `value:animation`（2026-11-11 为 38 张），整张退回。
- **脚本：** `thisObject.getAnimation`（26 张）、`thisScene.getAnimation`、导出回调 `animationEvent`。
- **步骤 0：** 求值函数（插值、`loop` / `mirror` / `single` 的时间处理、`startpaused` 时取哪个值）、三种绑定谁优先、`magic` 切线。已读到的部分和查法见 [sample-gaps](phase4/sample-gaps.md) §3.4、§3.5。
- **实现：** 编译期解析成曲线，运行时每帧求值写进 `SceneState`（复用 P3a 的就地路径）；`getAnimation` 建在它上面。
- **验收：** 确定性工程和 WPE 逐帧比；`kabegame-sample` 的 `controlpointangle1`。

## P11 — 音频、媒体与用户资源

总计划见 [phase-11-audio-media.md](phase11/phase-11-audio-media.md)（2026-11-13）。按 173 张重算：75 张用到；只做 P11 解锁 0 张，P4–P10 先做完时 85 → 126（41 张只差 P11）。分四节：音频 uniform（频谱 P4e 已建、数组打包 P7 已做，只剩接线）、用户纹理、媒体、快捷方式；`usertextures` 的三种来源（属性文件、封面、快捷方式图标）照 WPE 并成一个「纹理来源」机制。下面是写总计划之前的原始范围。

三类数据都来自场景外面，宿主只是接收方。
- **音频：** `g_AudioSpectrum*` uniform（26 张）、`supportsaudioprocessing`。
  - 脚本 `engine.registerAudioBuffers` 已在 P3c 点 0 接上 `WpeMediaHub`。场景宿主本身是子 frame，uniform 直接用宿主收到的同一帧。这类 uniform 数组在翻译结果里是补齐过的 `vec4` 数组（见 P1-0）。
  - 和 P4e 的粒子 `audioprocessing*` 共用数据通路，谁先做谁建。
  - audiophile（旧 P7）的音频在这里。
- **媒体：** 导出回调 `mediaStatusChanged` / `mediaPlaybackChanged` / `mediaPropertiesChanged` / `mediaThumbnailChanged` / `mediaTimelineChanged`（30 张，SMTC，Phase 8 的 `WpeMediaHub` 已有数据）；系统纹理 `$mediaThumbnail` / `$mediaPreviousThumbnail`（20 张）。
- **用户资源：**
  - 用户自选的纹理（`scenetexture` 等属性绑在 `usertextures` 上；带 `usertextures` 的 30 张里，除了媒体缩略图都是这种）。场景的属性面板现在隐藏 `file` / `directory`，这类属性要一起补。
  - `usershortcut` 属性与 `engine.openUserShortcut`（1 张；只能在光标回调里调，每次点击至多一次）。打开快捷方式要后端启动用户配置的程序或文件，只放行用户在属性面板里配过的那些。
- **验收：** 固定音频输入下 uniform 与 WPE 一致；播放音乐时媒体回调与封面纹理跟着变；自选纹理与快捷方式在属性面板里能设、能用。

## P12 — 骨骼与 puppet

- MDLV0021 / MDLV0023 的骨骼（MDLS）、动画（MDLA）、变形（MDMP），skinning（翻译器经 `defines` 传 `BONECOUNT`），puppet warp。语料 33 张。
- 对象 `animationlayers`（31 张）、`attachment` 挂点（10 张）；脚本 `getAnimationLayer*`、骨骼与混合形状的 API。
- **依赖：** P5c 的 mdl 解析。P5c 对带这些段的模型报 `mdl:skeleton` / `mdl:animation` / `mdl:morph`。
- **验收：** 确定性工程和 WPE 逐帧比骨骼姿态；puppet 场景和 WPE 同一时刻的画面比。

## P13 — 3D 反射、光照与阴影

- dna_fragment、techno、mdl 的全部静态版本、`skin` 都已在 P5；`camerashake` 在 P5a；audiophile 的音频在 P11。
- **反射（旧 P7）：** 对象 `reflected` 与反射 RT、`REFLECTION` COMBO。audiophile 的 grid 还缺 `materials/grid/grid.tex`，开工时核实。
- **光照（旧 P8）：**
  - 已完成（lighting-REPORT）：`#require LightingV1`、`general.lightconfig`、四种 V1 灯对象、无 effect 图层的 `LIGHTING`。
  - 新增遗留灯（`"light": "point"`，`g_LightsPosition` / `g_LightsColorPremultiplied`，`generic*` 与 `genericimage2` 读）。
  - 新增 `PRELIGHTING`（带 effect 或 passthrough 的图层开光照，`g_Alt*`）、effect 自己开光照、阴影投射与 cookie（`lightconfig:directionalshadow` / `pointshadow`，3 张）、体积光（`castvolumetrics`）、雾（`general.fog*`）。
  - 灯挂在父对象下（2 张）：现在灯只取本地位置，所以照报。
- **材质：** 内置 `generic` 的 lightmap / normalmap / reflection；车漆 shader 的 metal / paintwork；`selfillum`；ricepod 的 `sprite` 对象；无内容的变换节点。arsenal 扫描时有 1 处引用解析为空，开工时核实。
- **验收：** 和 WPE 同一时刻的画面比；fantasticcar 的车身 / 条纹 / 轮毂颜色属性生效。

## 按需

- 本机语料现在每个能力都有归属。以后的新样本用到这些节都没有的能力，拿到样本再排，每类各自成节。
- **effect pass 的 final 段矩阵**（2026-11-12 P7d 期间查明，用户定为后续项）：
  - WPE 按 final 标志分矩阵。最后一个启用 effect 里，最后一个 `compose` 之后的 pass 都用上屏那套：MVP 是图层 MVP、模型矩阵是 `W`、效果矩阵不缩放。
  - 我们（P2a）把其中非最后的 pass 当普通 effect pass：单位 MVP、缩放过的效果矩阵。
  - 另有几处小差异：透视图层换相机的范围、非 final pass 的 `g_ViewProjectionMatrix`、`g_EffectModelMatrixInverse`（WPE 没有这个内置名）。
  - 语料 0 处受影响：150 个这类 pass 都不读这些矩阵。等出现受影响的 effect 再做。
  - 规则、证据与修法见 [effect-matrices-REPORT](effect-matrices-REPORT.md)；工程 `ignore/p7d/proj/p7d-mvp`，抓帧 `A:\p7d\mvp`。

## 旧名对照表（D15）

代码注释和其它计划里还在用旧名，等 P4、P5 手上的步骤提交后统一改一次；在那之前按这张表对照。

| 旧名 | 现在的去处 |
|---|---|
| W1 | 层级 → P4a；`shake`、`iris` 能力表已经不报；形状对象 → P8；工坊着色器进翻译器语料 → P7 |
| W2 | 视频 → P9；音频频谱 → P11；文本、`thisLayer.text` → P6；绳与跟随指针的控制点 → P4c / P4d；`shine`、`blurprecise`、`opacity` 能力表已经不报 |
| W3 | 多段视频 → P9；`mediaThumbnailChanged` → P11；相机对象 → P5d；`canvasSize` 已实现；`colorBlendMode` 21 / 31 能力表已经不报 |
| W4 | 光标回调、`input.*`、声音的脚本控制、`systemfont_*` → P6；`setTimeout`、`WEMath`、`WEVector` 已可用；`genericimage3`、`flat` 能力表已经不报；`sharpen_filter` 翻译失败 → P7；粒子 → P4 |
| W5 | 媒体回调 → P11；`getAnimation` → P10；`getParent` → P6；`shared`、`setInterval` 已实现；`composelayer` → P5b；R8 / RG88 → P4b；内置 effect 能力表已经不报，翻译失败的工坊 effect → P7 |
| W6 | 骨骼、动画、puppet → P12；DXT3、`REFRACT` → P4b；视差、`g_ParallaxPosition` → P5a；`localStorage` 已实现；粒子 → P4；`hue_shift`、`clipping_mask` 翻译失败 → P7 |
| 旧 P7 | dna_fragment、techno → P5d；`reflected` 与反射 RT → P13；audiophile 的音频 → P11 |
| 旧 P8 | → P13；`camerashake` → P5a |
| K | → P10 |
| 旧 P9 | `scene.pkg` → P1-3；`fluidsimulation` → P7；`attachment` → P12；其余 → 按需 |

---

## 横切要求（每个 Phase）

- **回归与 changelog**：`versions/latest/regression.md` 写本 Phase 用例，带样本名；`changelog.md` 写一行用户可见变化，例如「新增可渲染的场景壁纸：…」。
- **文档**：每个 Phase 更新 `cocs/wpe/WPE_SCENE.md`（资源解析顺序、bundle 结构、能力表、Worker 分工、脚本宿主协议）与 `WPE_IMPORT.md` 的相关段落；
  翻译器规则变化时同步 `src-tauri/wpesl2wgsl/README.md`。
- **语料测试**：
  - 翻译器：`cargo test -p wpesl2wgsl --test corpus`；
  - 前端编译管线：vitest 在 Node 里用 `fs` reader 跑。

  两者都只在 `KABEGAME_WPE_ROOT` 指向 WPE 安装目录时运行，没有就跳过，CI 不依赖本机文件。
  断言已解锁样本的 `unsupported` 为空、它们用到的 shader 变体全部翻译通过。
- **对照图**：作者的 `preview.jpg` / `preview.gif` 常经过后期处理，只作粗对照；以 WPE 的实际画面为准（D12：可以自己运行 WPE 截图，
  逐 pass 核对时用 RenderDoc 抓帧）。截图前确认 WPE 的后处理档位（用户当前为 `disabled`，不画泛光、不走 HDR），对照泛光时临时调高、用完恢复。
  我们这边用「指定 `g_Time` 渲染 + 同步读回」扫描相位，与 WPE 静帧找最接近的时刻再比，绕开两边时钟起点不同。
- **许可**：Kabegame 本身是 GPLv3，可以移植 linux-wallpaperengine（GPLv3）的代码，在文件头注明出处与原文件路径（如 `pkg.ts`）；
  RePKG 是 MIT；naga 是 MIT / Apache-2.0。
  WPE 自带的 shader、脚本模块和工具材质都在运行时从用户的安装目录读取，不随应用分发。

---

## 关键决策（2026-11-01 全部确认）

- **D1 渲染器位置**：渲染器跑在应用页主 frame（`WallpaperStage` 的 scene 层）。SceneScript 放进不透明源 sandbox iframe，每帧经 `MessageChannel` 同步。
  代价：脚本与渲染器分处两个 realm，`createLayer` 这类调用只能返回代理，每帧多一次消息往返。
  **2026-11-02 更新**（P3-0）：编译与渲染挪进场景宿主（`file:` iframe），脚本与渲染器同处宿主。**2026-11-03 细化**（D14）：同线程、独立 realm——脚本跑在宿主内的同源 `about:blank` 子 frame 里，宿主同步调用，见 [phase-3b-script-runtime.md](phase-3b-script-runtime.md)。
- **D2 着色器翻译**：WPESL 原文直接交给 wasm 翻译器 `wpesl2wgsl`，预处理、改写、naga 翻译都在内部完成，前端不做方言处理。
  P1-0 的本机语料过了门槛。如果以后 naga 接不住，备选方案是 glslang 出 SPIR-V、再由 Tint 出 WGSL（Babylon.js 的路线）。
- **D3 资源读取**：前端 `fetch(file:)`；pkg 是 `SceneFs` 的一个来源，条目带 `Range` 头按区间读（2026-11-01 已实现并提前到 P1）。
- **D4 未实现特性**：整张退回预览图；dev 下加一个开关，可以强制渲染、看半成品。
- **D5 3D 场景**：P7、P8 共 7 张，留在本阶段、排在最后；P6 做完停下评估，若已有工坊样本可先做工坊。（2026-11-11 被 D15 取代：dna_fragment、techno 已在 P5，其余 3D 合成 P13。）
- **D6 阶段合并**：上级计划的阶段 3 / 4 合并成本阶段，不再新建 `4-scene-fx/`。
- **D7 工坊排在 3D 之前（2026-11-01 确认）**：本机已有工坊 scene（2026-11-01 为 13 张），按 D5 的约定排成 P6 → W1–W6 → P7–P8。
  理由：工坊是用户实际订阅的内容，而 3D 默认样本是 WPE 自带的演示；W1 的 `LightingV1` 打桩、W2 的音频订阅也是 P7 / P8 的前置。
  （2026-11-11 被 D15 取代，「工坊在 3D 之前」的用意保留：3D 的反射、光照与阴影排在最后。）
- **D8 合成语义以 WPE 逆向为准（2026-11-01）**：用户同意对 WPE 程序做只读静态逆向（复制到 scratchpad 分析副本，不运行、不附加进程、不写安装目录）；
  计划里只写行为、常量与地址，不搬运反编译代码。LWE 只作参考。
- **D9 后处理档位（2026-11-01）**：Kabegame 设置「场景后处理」，默认跟随 WPE 的 `postprocessing`，也可固定为关闭 / 开启 / 超高；同时充当集显的性能开关。
- **D10 脚本静态规则（2026-11-01）**：P3 之前，带 `update` / `init` 的脚本绑定整张退回；只导出 `applyUserProperties` 的按 `value` 静态显示。
  **2026-11-02 推翻**（[p3-script-REPORT.md](p3-script-REPORT.md) D 节与 H 节）：WPE 加载时在 init 之后用完整属性集调一次 `applyUserProperties`，
  `value` 会被覆盖（shimmering 的 bloomstrength 实为 1.0，不是 1.12）。P3 起这类脚本必须实际运行；P3 之前的静态显示只在属性等于默认值、且脚本结果恰好等于 `value` 时才对。
  实现（`isStaticScript` / `scriptExports`、`value:script`）在 3b 删除。
- **D12 WPE 访问约定修订（2026-11-01）**：早先「只读、不运行、不附加 WPE」是代理自己加的，用户明确为了产品质量放开。
  现在可以运行 WPE、在其中切换壁纸与设置、用 RenderDoc 等工具附加进程抓帧，拿每个 pass、中间纹理与 uniform 的真值核对实现；
  不改动、不删除用户的壁纸、工程与创意工坊内容；为对照临时改的 WPE 设置用完恢复并记录。D8 的静态逆向结论可以用动态抓帧复核。
- **D11 P2 拆分（2026-11-01）**：P2a 渲染图与 `disabled` 档，P2b 泛光与 HDR；属性绑定表挪到 P3，和脚本每帧改 uniform 共用一条通路。
- **D13 P2b 验收与范围（2026-11-01）**：P2b 现在做（不等 P3）；用 RenderDoc 抓帧做链路隔离验证（WPE 的泛光链输入 → 我们的泛光 + combine → 对比 WPE 输出），
  需要一个只在 dev 构建里的测试入口；预览、应用背景与桌面同一档位。
- **D14 P3 方案（2026-11-03 用户定）**：
  - 脚本同步执行、不用 Worker，每帧 计时器 → `update`（返回值当帧写回）→ 渲染；脚本对象直接作用于渲染状态。
  - 脚本 realm 是宿主内的同源 `about:blank` 子 frame（同进程同线程，对应 WPE 渲染线程上的独立 V8 Context），只是隔离、不是安全边界；先做可行性探针，不成立就停下汇报。
  - 单个回调超过 15 s 就在它返回后停掉本场景全部脚本；死循环接受卡住；验收不含任何死循环 / 忙等测试，15 s 规则只用注入时钟单测。
  - 环境对齐 WPE（遮掉 `fetch`、全局计时器等，`console` 只有 `log` / `error`）；未实现的 API 不做静态扫描，调用时报错只禁用那个回调；脚本相关不再进 `unsupported`。
  - API 分阶段：3b 先做最小 + 骨架，做完用本机语料定后续 API 阶段。
  - 属性快速路径分两步：3a 先做材质常量 / 变换 / `alpha` / `color` / `visible` / 泛光参数，3c 做到 WPE 的程度；重编译时保留脚本 realm 与状态，不重跑 `init`。
  - 默认照 WPE（报告 D / I 节），不照搬 `engine.userProperties` 丢内置键、CLI 改颜色成字符串两个缺陷；COMBO 绑用户属性按不支持。
  - 推翻 D10、细化 D1。细节与各自的「已定」「待定」见 [3a](phase-3a-bindings.md) / [3b](phase-3b-script-runtime.md) / [3c](phase-3c-runtime-graph.md)。
- **D15 P6 之后按能力分节（2026-11-11 用户）**：W1–W6、旧 P7 / P8、K、旧 P9 不再按壁纸分。已被 P2–P6 吸收的划掉，剩下的按能力排成 P7–P13 与「按需」，编号即推荐顺序；P5 是 3D 的相机与网格，3D 的其余部分（反射、光照、阴影）合成 P13。见「P6 之后的分节」与「旧名对照表」。取代 D5、D7 的排序。

---

## 风险

- **视频纹理**：工坊样本的主画面多是 `.tex` 内嵌的 4K MP4（单段最大 707 MB），Blob 的内存与解码开销、预览与桌面同时播放时的表现都要在 P9 实测。
- **翻译覆盖面**：P1–P6 的着色器都已通过；`#require LightingV1` 已实现，
  剩阴影与工坊着色器里 HLSL 的隐式截断。翻译器的语料测试还没覆盖 pkg 里的工坊着色器，P7 补上。
  后者需要类型信息，规则改写做不到，遇到时再评估：要么扩展翻译器，要么在 naga 的 IR 上处理。
- **浏览器 WGSL 校验**：naga 输出、naga 回读都通过，但 Tint 还没验证过（P1 真机首项）。
- **合成语义**：效果链、混合模式、`copybackground`、fbo、泛光与 HDR 已由 WPE 逆向取得规格（P2，D8）；剩余未知见「P2 仍未知」。
  WPE 版本升级可能改变这些行为，逆向结论绑定 2.8.42。
- **粒子与脚本语义**：算子公式靠对照；脚本的调用时机与写回规则已由逆向查清（p3-script-REPORT D / I），D14 起脚本与渲染同线程同步执行，`createLayer` 可以返回真对象（P6）；跨 realm 的类型判断与微任务时机的差异见 [3b](phase-3b-script-runtime.md) 风险。
- **GPU 与主线程开销**：预览与桌面同时渲染 4K 场景；壁纸窗口在 WorkerW 下的 WebGPU 行为未验证。
  首次打开的大头是 GPU 进程编译 pipeline，靠 Chromium 的 GPU 着色器磁盘缓存与翻译结果缓存缓解。
- **WPE 安装目录依赖**：只拷了壁纸目录、没装 WPE 的机器上 `sceneAssets` 为空，所有 scene 都会退回预览图；
  `unsupported` 要写明「缺少 WPE 安装目录」，详情面板据此提示。
- **wasm 工具链**：每台开发 / 构建机（含 Linux 22.04 构建 guest、macOS）都要装 `wasm32-unknown-unknown` 目标；缺了只影响场景渲染，前端照常构建。
