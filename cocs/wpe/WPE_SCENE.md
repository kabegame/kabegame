# Wallpaper Engine 场景壁纸（`x-wpe/scene`）

> 状态：阶段 3 P1-0（着色器翻译器 `wpesl2wgsl` 与 wasm 构建链）、`scene.pkg` 读取、P1-1 导入、P1-2 `sceneAssets`、P1-3 前端编译管线、P1-4 渲染器（`wpe-scene/render/` + `WpeSceneView.vue`）、P1-5 接进 `WallpaperStage`（scene 层）已落地：图库预览与桌面壁纸窗口都实时渲染能渲染的场景，其余显示作者预览图。
> P2a（图层渲染图、effect 链、colorBlendMode、`_rt_FullFrameBuffer` 快照、FreeImage `.tex`、设置「场景后处理」与 `disabled` 档）已落地：本机当时 29 张里新解锁 razer_vortex；随后 P3b 解锁 razer_bedroom，见下「场景脚本」。
> P2b（泛光与 HDR，「开启」/「超高」档）已落地：LDR 泛光链、HDR 8 级金字塔与收尾都用 WPE assets 原件翻译，链路隔离验证与 WPE 抓帧逐像素一致（见下「泛光与 HDR」）；bedroom 开启或超高档可见光晕。
> P3-0b：编译、渲染与 dev 探针已迁进 `apps/wpe-scene`，应用页只承载 iframe；画面与 ping 的真机回归待验收。
> P3a（属性绑定表与就地写）已落地；P3b（场景脚本运行时，最小 API）进行中：razer_bedroom 已实时渲染，见下「场景脚本（P3b）」。
> P4a（图层层级、粒子底座与档 1、`instanceoverride` 就地生效、粒子生命周期）已落地：新解锁 shimmering_particles 与工坊 3062029089；工坊 3304642534 的脚本用到未实现的 API，被新加的脚本 API 检查（`script:api:*`）挡住，仍显示预览图。见下「层级（P4a）」「粒子（P4a）」。
> P4b（纹理格式 R8 / RG88 / DXT1 / DXT3、粒子帧表、档 2 模块与发射时序、噪声模块、`REFRACT` / `CUTOUT`、`instanceoverride.colorn`）已落地：新解锁 6 张工坊场景，能渲染的从 14 张到 20 张。见下「粒子（P4b）」。
> P4c（粒子控制点与指针跟随、`controlpointattract`、世界空间与「粒子先于脚本」的帧顺序、`spritetrail` 拖尾与 `sprite` 的三种朝向）已落地：新解锁工坊 `1838478131`、`3832772446`，能渲染的从 20 张到 22 张，带粒子的场景里粒子用法完全覆盖的从 22 张到 44 张。见下「粒子（P4c）」。
> 计划：[.claude/plans/wpe-import/3-scene/PLAN.md](../../.claude/plans/wpe-import/3-scene/PLAN.md)；
> P4 粒子：[phase-4-particles.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4-particles.md)（总计划）、[phase-4a-base.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4a-base.md)（P4a 与实施记录）、[phase-4b-tier2.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4b-tier2.md)（P4b 与实施记录）、[phase-4c-controlpoints.md](../../.claude/plans/wpe-import/3-scene/phase4/phase-4c-controlpoints.md)（P4c 与实施记录）、[p4-particles-REPORT.md](../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)（实测与读码结论）；
> 格式调研：[RESEARCH.md](../../.claude/plans/wpe-import/3-scene/RESEARCH.md)。

## 总体形态

- **渲染**：场景壁纸在前端渲染，用 WebGPU 跑在 `WallpaperStage` 的 scene 层，壁纸窗口与图库预览共用；资源由前端 `fetch(file:)` 读取。
- **编译**：资源依次查项目目录散文件、项目的 `scene.pkg`、WPE 安装目录的 `assets/`。场景 JSON、`.tex` 解码都在前端 TypeScript。
- **着色器**：WPE 着色器交给 wasm 版翻译器 `wpesl2wgsl`。
- **Rust 侧**：只有导入，以及把 WPE 安装目录交给前端；`kabegame-core` 不出现 scene 模块。
  - 导入：`x-wpe/scene` 入库，创意工坊形态的入口在 `scene.pkg` 里，有包就算入口存在，`hash` / `size` 取包（`WpeProject::content_path`）；
    没有 `type` 但入口是 `.json` 的按场景处理。
  - 壁纸目标的 `sceneAssets`：`<WPE 安装目录>/assets` 绝对路径列表（`wpe::discover::scene_asset_dirs`，安装目录只有一个，来自设置 `wpeEngineDir`），只对场景行计算，其它类型、Android、没找到 WPE 安装目录时为空。
  - 壁纸目标的 `previewPath`：场景行的 `thumbnail_path`（导入时就是作者的 `preview.*`），不能渲染时 scene 层显示它；缩略图为空或回落成壁纸目录本身时不填，其它类型不填。
  - `isWpeWallpaperContentType` 认网页与场景：两者的图库预览都走 `WpeWallpaperContent` → `WallpaperStage`；网格缩略位仍是作者预览图；应用背景与预览同一条 `ImageContent` 原图形态，也实时渲染（见下「接入 `WallpaperStage`」）。
- **平台**：随 `wpe` feature，与网页壁纸相同：三个桌面平台都走场景宿主，Android / Web 的 scene 行显示预览图。没有 WPE 安装目录或 WebGPU 不可用时退回预览图。本文的真机数据都来自 Windows。

## 光照（`#require LightingV1`）

调查与对比数据见 [lighting-REPORT](../../.claude/plans/wpe-import/3-scene/lighting-REPORT.md)。

- `#require` 在 WPE 里是**预处理期现场生成源码**，不是文件引用：`LIGHTING` 非 0 时按 `LIGHTS_*` 生成灯光 uniform 与 `PerformLighting_V1`，否则什么都不插。
  `genericimage4` 顶层那条无条件的 require，在 `LIGHTING=0` 时等于空行。逐灯的 PBR 计算在公开头文件 `common_pbr_2.h`，翻译器 `library.rs` 只负责遍历灯。
- **灯数不看灯对象**：`LIGHTS_*` 取 `general.lightconfig`，每种灯 4 位。灯对象只负责填数组：多的丢掉，少的槽位全 0。没有这个键的场景里灯对象不起作用，开了 `LIGHTING` 的材质只剩环境光。
- **`"light": "point"` 是遗留灯**，不进这些数组；V1 灯是 `lpoint` / `lspot` / `ltube` / `ldirectional`。
- 宿主 `compile/lights.ts` 把灯对象换算成 uniform（编译期常量，绑了 `{user}` 的字段登记重编译），宏经 `litDefines` 传给翻译器，只在最终 `LIGHTING` 非 0 时生效。
- 光照路径自己的宏只有 `LIGHTS_*`。`SHADERVERSION` 是翻译器的平台宏（69），`genericimage3` 按它选公式。
- **全局引擎宏**（[hdr-macro-REPORT](../../.claude/plans/wpe-import/3-scene/hdr-macro-REPORT.md)）：`HDR`、`SCENE_ORTHO` 经 `engineDefines` 传给全部着色器，关闭时不写键：`common_blending.h` 用 `#ifdef HDR`，传 0 会让 LDR 场景也走 HDR 分支。`TEX<n>FORMAT` 只给声明了 `formatcombo` 且按名字绑定的槽位定义，运行时槽位（`previous`、`bind`、passthrough）不定义。`HLSL_GS40_DISABLED` 不能定义，WPE 没有这个宏。
- **边界**：只实现无 effect 图层。带 effect 或 passthrough 的图层报 `lighting:prelighting`，effect 自己开光照报 `lighting:effect`，阴影 / cookie 报 `lightconfig:*`，体积光报 `object:castvolumetrics`，`genericimage2` 开光照报 `uniform:g_LightsPosition`。
- 本机语料没有一张真的开 `LIGHTING`，这条路径靠 `ignore/lighting/` 的测试工程和 WPE 1:1 对比（最大差 1）。普通图层带法线图时另有 UV 内缩的差异（已知，最大 10）。

## 着色器翻译器 `wpesl2wgsl`

完整契约（请求 / 结果、绑定布局、uniform 打包、内部流程、已知不支持、测试）见
[src-tauri/wpesl2wgsl/README.md](../../src-tauri/wpesl2wgsl/README.md)。要点：

| 项 | 内容 |
|---|---|
| 位置 | `src-tauri/wpesl2wgsl/`，workspace 成员；编成 wasm，不链进应用。naga 30.0.1 的源码嵌在 `naga/`（P7a）：裁掉了用不到的前后端，GLSL 前端的行为补丁也改在这里，清单见 `naga/KABEGAME.md` |
| 构建 | `deno task build:wpesl2wgsl` → `bin/wasm/wpesl2wgsl/wpesl2wgsl.wasm`（git 忽略，约 1.4 MB），需要 rustup 目标 `wasm32-unknown-unknown` |
| 进前端 | kabegame 命令不带 `--skip vue` 时，`Wpesl2wgslPlugin` 拷到 `apps/wpe-scene/src/wpesl2wgsl/`；缺失只告警，场景退回预览图 |
| 前端接口 | `apps/wpe-scene/src/wpesl2wgsl/index.ts`：`loadWpesl2wgsl()`、`translateWithIncludes(translator, request, readInclude)` |
| 输入 | 一个材质 pass 的 `.vert` / `.frag` 原文、按需提供的头文件、COMBO、绑定的纹理槽位与格式 |
| 输出 | 两段 WGSL；uniform 块（group 0 / binding 0，两阶段共用，std140 偏移）；纹理绑定（槽位 n → 纹理 `1 + 2n`、采样器 `2 + 2n`）；attribute / varying 的 location；最终 COMBO |
| 本机语料 | 2026-11-12（P7c）：WPE 安装目录 167 对通过 161 对；全部场景实际发出的 798 个请求全部通过，语料里没有因着色器翻译退回的场景，输出 WGSL 回读与 Tint 都是 0 失败。**请求夹具**（P7a）：语料扫描录下编译管线真实发出的全部请求（`kbp corpus scan --extra requests:<目录>`），语料测试重放并和旧导出**逐字节**比较，改翻译器时据此判断哪些输出变了（README「测试」） |
| 规则来源 | WPE 先把方言转成 HLSL 再交给 fxc，所以翻译器照 WPE 的文本处理（P7b：`#if` 只解析一个表达式、多余的 `#endif` 忽略、宏后者覆盖前者、声明名带分量只取名字、`main` 之前的 `float` 数组是打包形态）与 fxc 的隐式转换（P7c：naga GLSL 前端的 HLSL 模式，截断、铺满、混算截到窄的、非布尔条件 `!= 0`、片元 varying 按顶点的类型）。只在 GLSL 本来会报错的地方生效，原来能翻译的输出逐字节不变。规则表与 fxc 依据见 README「HLSL 隐式转换」与 `naga/KABEGAME.md` |

翻译结果里的几个约定会直接影响渲染器：
- **平台宏**：照 WPE 的 Windows HLSL 路径，定义 `HLSL`（WebGPU 坐标约定与 D3D 相同）。
- **没有几何着色器**：`GS_ENABLED` 保持未定义，粒子走顶点着色器展开四角。
- **uniform 数组的打包**：标量 / 二三分量向量的 uniform 数组按 16 字节步长补成四分量向量。打包时看 `stride` 与 `declared`。

## `scene.pkg`

创意工坊发布的场景把 `scene.json` 与项目资源打进 `scene.pkg`，壁纸目录里只剩 `project.json` 与预览图。读取在
`apps/wpe-scene/src/compile/pkg.ts`（`ScenePkg`），格式与流程移植自 linux-wallpaperengine（GPLv3，与本项目同许可）的
`PackageParser.cpp` / `Package.cpp`：

```text
sizedString header        // "PKGV00xx"；sizedString = u32 小端长度 + 字节
u32         count
count × { sizedString name, u32 offset, u32 length }
<数据区>                   // 条目在「目录表结束处 + offset」
```

- **只按区间读**：包可达数百 MB（内嵌 4K60 视频纹理），`ScenePkg` 经 `RangeRead` 先读 64 KiB 目录表（不够加倍），条目再按 `[base + offset, + length)` 读。
  主线程用带 `Range` 头的 `fetch(file:)`：应用页主 frame 实测返回 200、正文正好是请求区间、没有 `Content-Range` 头；跨过末尾截短，起点越界则 fetch 失败。
- **条目名**：UTF-8、正斜杠，按原样精确匹配（有中文和末尾空格）；同名取第一条。没有该条目返回 null，由资源解析层继续查下一个来源。
- **校验**：头部必须以 `PKGV` 开头；目录表截断、字符串或条目数异常、读到的条目长度不对都抛 `PkgFormatError`。长度过长通常意味着 `Range` 被忽略。
- **视频纹理**：`.tex` flags 含 Video（32）时唯一的 mip 是完整 MP4；本机工坊样本的 `isVideoMp4` 字段为 0，判断要看 flags。
- **测试**：`pkg.test.ts` 的单测用内存构造的包；设置 `KABEGAME_WPE_ROOT`（WPE 安装目录）后另跑本机工坊目录里的每个 `scene.pkg`，只读。

## 编译管线

`apps/wpe-scene/src/compile/` 将项目转成渲染器唯一输入 `SceneBundle`。`SceneFs` 依次查项目散文件、`scene.pkg`、各个 `sceneAssets`；返回来源标签 `project` / `pkg` / `assets`。路径先规范化并拒绝 `..`、盘符与 UNC。同一相对路径的查找结果（含未命中）及整文件内容在一次编译中缓存，多个 shader 共用的 include 只读一次。

读取器只提供 `readWhole(path)` 与 `readRange(path, start, end)`。主线程的 `FetchSceneReader` 用 `fileToUrl` + `fetch(file:)`：JSON / shader 直接整读，`.tex` 用首个 4 KiB 区间读取判断散文件是否存在，并把这段头部字节交给解析器复用。`scene.pkg` 条目的长度由目录表给出，相邻小条目共用 64 KiB 区间窗口；大 mip 仍直接按区间读。散文件不探测大小。CEF 主窗口实测整读、Range、HEAD 的 `file:` 响应都没有 `Content-Length`，Range 也没有 `Content-Range`；起点越界和文件不存在都报 `TypeError: Failed to fetch`。区间响应按流读取，一旦超过请求长度立即取消并报错。`.tex` 只读容器头、mip 表与支持的 mip；Video flag 的 MP4 只记录区间，不读视频本体。每个解析到的文件带 `location: { path, offset }`（散文件为自身、pkg 条目为 `scene.pkg` 与数据区偏移），供主线程直接区间读。

**effect 资源的查找范围**（`SceneFs.readScoped` / `resolveScoped`，参数 `ResourceScope { dir, first }`）：WPE 内置 effect 的材质、着色器、纹理放在 effect.json 所在目录下（`assets/effects/tint/materials/effects/tint.json`），项目自带的 effect（如 razer 系的 `effects/tint/effect.json`）把它们放在项目根，而 assets 的同名 effect 目录里另有内置版本。effect.json 来自 assets 时（`first`）先查 effect 目录再查根；来自项目 / pkg 时先查根下的项目 / pkg 文件，再查 effect 目录，最后才是根下的 assets 文件。头文件都在 `shaders/` 根，不按 effect 查。

`compileScene({ projectDir, sceneAssets, userProperties, reader, translator, postprocess?, force?, exhaustive? })` 返回：

| 字段 | 内容 |
|---|---|
| `general` | 正交尺寸、清屏色与开关、相机、`ambient` / `skylight`、`postprocess`（解析出的档位与场景实际的泛光 / HDR 状态）、`bloom`（泛光参数，缺键补 WPE 默认值、未换算） |
| `bloom` | 泛光链（`compile/bloom.ts` 的 `SceneBloom`：`hdr` 与各 pass 编好的 WPE util 材质）；泛光实际关着时为 null |
| `layers` | 按场景合成顺序的图层：`object`（scene.json 的 `objects` 下标，稳定键）、`parent`（父对象的 `objects` 下标，P4a）、变换、尺寸、颜色、可见性与 `visibleBound`（`visible` 绑了用户属性，运行时可变，**不可见也要建 GPU 资源**）、基础材质的 `passes`；`colorBlendMode`；启用的 `effects`（每个带 `source`、`fbos` 与按序的 `steps`：`draw` / `copy` / `swap`）；colorBlendMode ∉ {0, 31} 时的 `passthrough` pass；粒子对象的 `particle`（解析后的粒子系统与粒子材质的 pass，P4a，见「粒子（P4a）」） |
| `programs` | `wpesl2wgsl` 成功结果，保留 WGSL、uniform 布局、纹理绑定与顶点属性 |
| `textures` | 格式枚举、图像尺寸与纹理尺寸、采样 flags、mip 字节；视频只带 MP4 区间；FreeImage 形态只带 `encoded`（PNG / JPG 的磁盘区间，`mips` 由主线程解码后填）。`unsupported` 非空时，编译器可能只读头部，`mips` 因此可能为空 |
| `bindings` | 属性绑定表（P3a）：编译期每处解析 `{user}` 的地方登记一条「属性名（可带 condition）→ 目标」，按登记顺序；同一属性可以有多条。宿主按它把属性增量分成就地写与重编译（见「场景宿主」的「属性与快速路径」） |
| `unsupported` | 去重排序的未实现能力键；非空时渲染器不得使用这份 bundle，须显示作者预览图 |

pass（`ScenePass`）里：`key` 是本 pass 的稳定键（scene.json 坐标：基础材质 `objects/<i>/passes/<k>`、effect `objects/<i>/effects/<j>/passes/<k>`、passthrough `objects/<i>/passthrough`、泛光 `bloom/<pass>`），绑定表与就地刷新都按它找回 draw；`textures` 是槽位 → bundle 纹理；`runtime` 是运行时提供的槽位（`_rt_FullFrameBuffer` 快照或本 effect 的 fbo 名，来自材质 `textures` 或着色器注解 `default`）；`framebuffer` 是「需要帧缓冲」（`needsFramebuffer`，见下「图层渲染图」）。着色器声明了、材质没给的槽位按注解 `default` 绑定（同 LWE 先取着色器默认值），如 tint 的遮罩 `util/white`；effect 实例的 `passes` 按顺序对应 effect.json 的绘制 pass，覆盖 `combos` / `constantshadervalues` / `textures`（`null` 保留材质值）。

- **快速退回**：缺省时一旦 `unsupported` 非空就不再编译后面的图层与 effect（这时清单只是部分），退回的场景更早显示预览图——工坊场景完整编译要翻译几十个 effect 着色器、上百次读取，快速路径只需 2–4 次。`exhaustive: true` 列全（语料统计用），`force: true`（dev 强制渲染，D4）也照常编译并解码 mip。
- **后处理档位**：`postprocess` 是设置值（缺省 `follow`），跟随时读 WPE 的 `config.json`，见下「场景后处理档位」。

### 能力表（`features.ts`）

能力键以 `类别:具体能力` 命名，例如 `camera:perspective`、`tex:format:<n>`、`tex:video`、`uniform:g_AudioSpectrum16Left`、`combo:SPRITESHEET`、`effect:<目录>:<字段>`、`particle:<类别>:<模块>`、`script:api:<分组>.<成员>`、`script:callback:<名>`、`value:animation`、`shader:flag:parse:…`、`render:bloom:<pass>`、`assets:missing`。原则是**只报真正改变画面的特性**，中性字段逐项写明依据后放行（依据多来自 WPE 2.8.42 的只读逆向，`.claude/plans/wpe-import/3-scene/p2-REPORT.md`；P4a 的在 `phase4/p4-particles-REPORT.md`）。脚本由 P3b 运行时执行，运行期的脚本错误只进脚本诊断、不加入 `unsupported`；但脚本里静态看得出的未实现 API 报 `script:api:*`、整张退回（2026-11-07 改定，见下）。其它渲染能力键照常决定是否退回预览图：

| 放行 | 依据 |
|---|---|
| general 的 `bloom` / `hdr` 与全部 `bloom*` 调节项 | 由后处理档位裁决，泛光 / HDR 已实现（P2b，见「泛光与 HDR」）；其中的脚本交给 P3b 运行时 |
| general 的 `cameraparallax*`、`camerashake*`、`zoom` | 视差、抖动、正交缩放已实现（P5a，见「相机：视差、抖动与缩放（P5a）」）；透视场景开 `camerashake` 照报 `general:camerashake`（归 P5d），正交场景里解析出的常量 `zoom` ≤ 0 照报 `general:zoom` |
| `camerafade`、`camerapreview`、`norecompile`；正交投影下的 `farz` / `fov` / `nearz`；`supportsvideo` | 加载淡入 / 编辑器选项 / 透视另报 `camera:perspective` / 只决定 D3D 设备标志 |
| 对象 `copybackground` | 只对 passthrough 模型生效，普通图像模型上没有渲染效果；passthrough 模型照报 `model:passthrough` |
| `solid`、`ledsource`、`locktransforms` | 渲染路径不读（推断与鼠标命中有关）/ Razer Chroma 灯效来源 / 编辑器锁定 |
| `brightness` | 只在 HDR 下乘进 `g_Color4` / `g_Color`（B10），LDR 下不生效 |
| `parallaxDepth`；`alignment` 为 `center`；`perspective` 为 false；模型 `autosize` | 视差已实现（P5a），绘制时只用根对象的值 / 居中是恒等 / 透视另报 / `size` 与模型 `width` / `height` 都缺失时取基础纹理的图像尺寸 |
| 模型 `cropoffset`、对象 `config`；translucent / additive 或 `depthtest: disabled` 的 pass 上的 `depthwrite: enabled` | P5a 前置，实测中性：编辑器的裁剪偏移导入时已并进 `origin` / 只在托盘与播放列表读 / 这两种 pass 不写深度；其余 `depthwrite:*` 照报（P5d）。模型 JSON 的布尔键只认 `true`，见「相机：视差、抖动与缩放（P5a）」的「前置几条」 |
| `colorBlendMode` | 0 普通、31 上屏改 additive、其它走 passthrough，都已实现 |
| 模型 `solidlayer` | 合成 RT 按图层 `size`，上屏不做 UV 内缩。`assets` 的 `solidlayer.json` 用 `flat`、不带纹理；`instanced` 另报 `model:instanced` |
| effect.json 的元数据键（`name`、`group`、`preview`、`dependencies`、`gizmos`…） | 编辑器显示用 |
| 对象 `parent`（灯除外）；没有内容的分组节点 | 层级已实现（P4a，实测），见「层级（P4a）」；不再报 `object:parent` / `object:empty` |
| general 的 `gravitydirection` / `gravitystrength` / `windenabled` / `winddirection` / `windstrength` | 实测中性：同一工程只改这 5 个键，两份轨迹对解析模型最大差 6.7e-5、1.9e-5，16 个系统的 y 都不漂移；场景重力若生效每帧会偏约 0.08 像素（`proj/p4a-wind`）。读码也没找到引擎读取点 |
| general 的 `perspectiveoverridefov` | 不是中性，解析成透视粒子的 fov（`SceneGeneral.perspectiveOverrideFov`，缺省 95°，钳到 [0.1°, 179.9°]），实测 `d` 逐位相符；绑属性时走重编译 |
| 材质 `alphawriting: "default"` | 读码：`default` 映射成 0，绘制时 0 什么都不做（`0x140157201`），等于没写；`enabled` / `disabled` 照报 `material:alphawriting` |
| 粒子 `instanceoverride` 的 `alpha` / `size` / `count` / `speed` / `lifetime` / `rate` / `colorn` / `color` 与 `id`；`controlpoint0..7` / `controlpointangle0..7` 的静态值 | 已实现、就地生效（见「粒子（P4a）」，`colorn` 见「粒子（P4b）」）；控制点的静态值在建系统时生效（P4c，见「粒子（P4c）」的「控制点」，绑了属性报 `particle:instance:controlpoint:user`）；`id` 是编辑器键。`brightness` 只在 HDR 且系统 `flags` 没有 bit3 时生效，那时取非默认值才报 |
| `.tex` 头标志 alpha-priority（`0x80000`） | P4b 实测中性：同一张 RG88 纹理有无这个标志，图像层与粒子整帧逐像素相同；读码看全二进制只把它放进采样器缓存的哈希键 |

- **着色器不按名字白名单**：翻译器把材质常量（带 `meta.material` 的 uniform）与 COMBO 都当普通输入。真正依赖引擎的三类逐项核对：没有 `meta.material` 的内置 uniform 必须在 `ENGINE_UNIFORMS`（与 `render/uniforms.ts` 写的值一一对应，单测核对）里，否则报 `uniform:<名字>`；值非 0 的引擎 COMBO（`SPRITESHEET`、`ALPHATOCOVERAGE`、光照 / 反射 / 蒙皮 / 变形 / 预光照）报 `combo:<名字>`；`_rt_*` 纹理只认 `_rt_FullFrameBuffer` 与本 effect 的 fbo，其它报 `texture:rendertarget:<名字>`。
- **effect** 不再整条报 `effect:<名字>`：逐项检查实例、effect.json、fbo 与命令（`copy` / `swap` 之外的命令、swap 操作数不是本 effect 的 fbo、绘制目标不是本 effect 的 fbo 都报），材质与着色器同基础材质。未启用的 effect（`visible` 为 false 或绑定结果为 false）整步跳过，不检查能力。
- **COMBO 不能绑用户属性**（P3a）：材质 pass 与 effect 实例的 `combos` 里只要有对象值就报 `combo:user-binding`、整张退回。WPE 的 COMBO 只按整数读，写成 `{user, value}` 会让它断言中止整个进程（I3），对象也绝不交给翻译器。本机 26 张样本 0 处这么写。
- **条件可见**（P3a）：`{user: {name, condition}}` 不再报 `visible:condition`，图层 `visible` 的绑定就地切换（见「场景宿主」的「属性与快速路径」）。本机 shimmering_particles 的 5 个备选图层与工坊 3549863808 / 3637191856 因此少了一项。
- **脚本（P3b）**：`scene.json` 内的脚本先保留 JSON `value` 作编译期初值，再由运行时求值、调用回调并写回；不按导出名做静态放行，也不报 `value:script`。运行期的脚本错误只影响相应脚本或回调，不进 `unsupported`。
- **脚本 API**（2026-11-07 改定，`compile/scriptApi.ts`）：会执行的脚本里调用或访问了 WPE 有、我们没实现的 API，报 `script:api:<分组>.<成员>`、整张退回，例如 `script:api:thisScene.createLayer`、`script:api:layer.getParent`、`script:api:input.cursorWorldPosition`。改定前的约定是「不做静态扫描，调用时报错只禁用回调」，结果 3304642534 的音频条静默缺了一整组。导出了运行时还不调的回调（光标、媒体等）同样报 `script:callback:<名>`（P6 前置）。规则见「场景脚本（P3b）」的「脚本 API 检查」。
- **层级**（P4a）：`object:parent` 只剩灯带父对象时报（`lights.ts` 用本地 `origin`，挂在父链下的位置没和 WPE 比过）；父链成环报 `object:parent-cycle`。
- **粒子**（P4a）：不再整条报 `object:particle`，按模块表细分成 `particle:*`，键的形态见「粒子（P4a）」的「编译」。
- **关键帧值**（P4a）：`{animation: {…}, value}` 报 `value:animation`。以前它被解析成 `undefined`，属性静默退回缺省值、能力表不报。`animation` 是对象才算（puppet 的整数 id 不算），同时挂了 `user` / `script` 也报；覆盖 scene（`general`、图层字段、effect 实例、`instanceoverride`）、材质常量、模型 JSON、`effect.json`、粒子系统级键与模块字段、控制点和子系统条目（`isKeyframedValue` / `scanValue`）。语料里挡住 32 张，都不是原来能渲染的。

**FreeImage 形态 `.tex`**（`freeimage` 为 13 PNG / 2 JPEG，mip 数据是整份图片文件）：Worker 不读这些字节，只记 `encoded` 区间。纹理尺寸取头里的**图像**尺寸（WPE 解码前把头里的纹理尺寸强制改成图像尺寸，所以 UV 为 1；razer_vortex 头写 4096×4096、图像 3840×2160，两组都是 3840×2160，见 `tex.ts` 的 `freeImageTextureSize`）。主线程 `decode.ts` 的 `TextureDecodeCache` 按区间读、`createImageBitmap`（`colorSpaceConversion: "none"`、`premultiplyAlpha: "none"`）解码，缓存键是文件路径与字节区间；`WpeSceneView` 每个目标一份，改属性重新编译时直接命中，换目标或卸载时关闭全部位图，每次解码后只留本 bundle 用到的项。其它 FreeImage 格式报 `tex:freeimage:<n>`，LZ4 包着的报 `tex:freeimage-lz4`。

### 场景后处理档位（`postprocess.ts`）

设置「场景后处理」`wpeScenePostprocess`（tauri 后端：core `SettingKey::WpeScenePostprocess`，命令 `get_wpe_scene_postprocess` / `set_wpe_scene_postprocess`，只接受 `follow` / `disabled` / `enabled` / `ultra`，非法值读回 `follow`；设置页壁纸分区，桌面平台）：

- **跟随 WPE**（默认）：只读 `<WPE 安装目录>/config.json`（由 `sceneAssets` 的上一级定位，与 assets、`ui_` 词条同一套 `wpe::discover::engine_dir`），取第一个 Steam 用户的 `general.user.postprocessing`。WPE 只认 `disabled` / `ultra` / `displayhdr`，其它非空值当「开启」，缺失或读不到当 `disabled`；`displayhdr` 按「超高」处理（我们输出到普通画布）。
- **场景实际状态**：泛光 = 档位不是关闭，且 `general.bloom` 的生效值不是 false（缺键即开；写成属性对象时取绑定属性的当前值，没有绑定取对象的 `value`）；HDR = 档位为超高，且 `general.bloom`、`general.hdr` 的生效值都是 true（规则同泛光，缺键不算）。G3 曾推断属性对象不算，工坊 3286859278（`bloom` 为 `{user: "postprocessing", value: true}`）的超高档抓帧证伪了这一点：WPE 照样走 HDR。
- **泛光参数**：`bloomstrength` / `bloomthreshold` / `bloomtint` / `bloomhdrstrength` / `bloomhdrthreshold` / `bloomhdrfeather` / `bloomhdrscatter` / `bloomhdriterations`，缺键依次取 2 / 0.65 / (1, 1, 1) / 2 / 1 / 0.1 / 1.619 / 8（WPE 场景构造函数），属性对象取生效值（`postprocess.ts` 的 `bloomParams`）。
- **重新判定**：每次加载都解析档位；`WpeSceneView` 每次重载经 IPC 读设置，并订阅 `setting-change`，`wpeScenePostprocess` 变了就重新加载（壁纸窗口不装 settings store，组件自己读）。WPE 自己的设置改了要等下一次加载才生效。

`compileSceneInWorker(input)` 在主线程建立 module Worker，先把 wasm 编译成可克隆的 `WebAssembly.Module`，再发 `start`。Worker 以带 `id` 的 `file` 消息请求 `range` / `whole`，主线程执行 fetch 并用 `file-result` 回传 transferable 字节；读取失败时回传错误的类型名与消息（`protocol.ts` 的 `encodeFileError` / `decodeFileError`），Worker 端还原成同类型，`SceneFs` 才能把 `TypeError: Failed to fetch` 认作「不存在、查下一个来源」。Worker 完成后以 `done` 回传 bundle 与所有 mip 的 ArrayBuffer；错误用 `error`。`AbortSignal` 取消时终止 Worker。Worker 不直接访问 `file:`。

测试：宿主在 `apps/wpe-scene`，运行 `deno task --cwd apps/wpe-scene test`、`deno task --cwd apps/wpe-scene typecheck`（整仓 `deno task test -c kabegame --skip cargo` 会连 `apps/kabegame` 一起跑）。设置 `KABEGAME_WPE_ROOT` 为 WPE 安装目录且有前端 wasm 时，语料测试会只读编译当前全部默认与工坊场景（后处理固定为关闭）：断言 eagleflag / deep_space / beach / razer_vortex / razer_bedroom 的 `unsupported` 为空、其它样本非空，且快速路径与 `exhaustive` 的结论一致；模拟 CEF `fetch(file:)` 统计运行时形态（快速路径）每张的请求次数、失败数与读取字节数，限制无单字节探测、请求不超过 150 次、读取量小于 64 MiB。`p2a.test.ts` 另核对 vortex / bedroom 的结构与三档后处理。`p3a.test.ts`（`compile/` 与 `render/` 各一份）核对绑定表生成、全语料「读过的属性都登记」、取值换算、就地 = 重编译的 uniform 字节、条件可见、可见性跳过与泛光级数、`planApply` 分类、加载期间增量。

## 渲染器

`apps/wpe-scene/src/render/` 把 `SceneBundle` 画到 `<canvas>` 上（WebGPU）。`bundle.unsupported` 非空时一律不画（这时 mip 可能没解码），退回作者预览图。

| 模块 | 职责 |
|---|---|
| `device.ts` | `navigator.gpu` 适配器与设备；适配器有 `texture-compression-bc` 就开 |
| `textures.ts` | 按 `compile/tex.ts` 的 `TEXTURE_FORMATS`（格式支持范围的唯一来源，P4b）连同全部 mip 上传：0 RGBA8888 → `rgba8unorm`、4 DXT5 → `bc3-rgba-unorm`、6 DXT3 → `bc2-rgba-unorm`、7 DXT1 → `bc1-rgba-unorm`、8 RG88 → `rg8unorm`、9 R8 → `r8unorm`，原样上传、不转通道；FreeImage 位图 `copyExternalImageToTexture` 到纹理尺寸的左上角；采样器 |
| `programs.ts` | 着色器模块 + `getCompilationInfo()` 检查、bind group layout、顶点布局、混合状态、管线（目标格式与是否写 alpha 随目标） |
| `uniforms.ts` | 按翻译结果的 std140 布局打包 uniform 块；内置 uniform |
| `layout.ts` | 图层四边形、世界矩阵与沿父链的可见性（P4a）、正交 / 透视粒子的视图投影、样式铺放与画布尺寸（纯函数） |
| `math.ts` | 最小 mat4（列主序） |
| `graph.ts` | 图层渲染图：把每个图层排成步骤（直接上屏 / 合成链 / passthrough / 快照 / copy / swap / 粒子），fbo 尺寸，`swap` 的名字 → 实体对应（纯函数，见下） |
| `scene.ts` | 一份 bundle 在某个设备上的全部 GPU 资源与每帧编码（`GpuScene`，照 `graph.ts` 的步骤执行，ops 按图层分组）；粒子层的模拟器与顶点缓冲；`checkRenderable` 自查；`buildableLayers` 与 `visibleObjects` 的可见性跳过 |
| `state.ts` | CPU 侧场景状态 `SceneState`（`P3a`）：图层的可变字段、材质常量覆盖、泛光参数与脏集合；就地写落在它上面，`GpuScene.sync` 每帧取脏项。不依赖 GPU，单测在 Node 里核对「就地 = 重编译」 |
| `renderer.ts` | `SceneRenderer`：设备、画布上下文、时钟、帧循环、cover 铺放，场景可无缝替换 |
| `clock.ts` | 可暂停的时钟、帧时钟（帧时间钳到 `[0.0001, 0.25]`，P4a）、帧节流 |
| `bloom.ts` | 泛光链：`planBloom`（纯函数：RT、步骤、`g_RenderVar0`、HDR 参数换算）与 `BloomChain`（建 RT / 管线 / uniform，逐步编码） |

组件 `apps/kabegame/src/components/wallpaper/WpeSceneView.vue` 是自取数据的子组件，地位等同 web 层的 iframe（接进 `WallpaperStage` 的方式见下一节）：
- **props**：`target`、`paused`、`interactive`。
- **数据**：宿主的 `SceneHost` 接收垫片 `applyUserProperties`（`user[key].value` 组成 `userProperties`）、在 Worker 里编译、建渲染器。
- **重载**：垫片监听本张图的 `metadataId` 字段补丁并只交付变化键，`SceneHost` 的**应用函数**按绑定表分成就地写与重编译（P3a，见「属性与快速路径」）；只有重编译才在同一设备上换场景，时钟不重置。监听 `setting-change` 的 `wpeScenePostprocess`，档位变了也重新加载；每次重载都经 `get_wpe_scene_postprocess` 读一次设置。
- **纹理缓存**：FreeImage 纹理的解码结果按目标缓存（`TextureDecodeCache`），改属性重编译不再解码 4K PNG；换目标或卸载时释放。
- **dev 强制渲染（D4）**：dev 构建下 `localStorage["kabegame-dev-scene-force-render"] = "1"`（主窗口与壁纸窗口同源共用）时，有不支持项也照常编译、解码并渲染（渲染器自查仍生效），日志里列出不支持项；用来看半成品的构图，例如 bedroom 的脚本颜色按 `value` 静态显示。
- **emit**：渲染出第一帧 `ready`；不能渲染 `fallback(reasons)`。
- **生命周期**：换目标或卸载时终止编译、销毁 GPU 资源与设备；设备丢失时重建一次渲染器，一分钟内再丢就退回。
- **注意**：调用方传来的 `target` 往往是响应式 Proxy，交给 Worker 前必须拷成普通值，否则 `postMessage` 克隆失败。

**坐标与矩阵**
- WPE 场景坐标原点在左下、y 向上，`origin` 以像素计。WebGPU 的 NDC 同样 y 向上，渲染目标与纹理第 0 行都在上方（与 D3D 相同，翻译器按 `HLSL` 路径），所以全程不翻转。
- 顶点在模型空间：以图层中心为原点、未缩放的 `size`。
  - `g_ModelMatrix` 是世界矩阵 `W_parent · T(origin) · Rz·Ry·Rx · S(scale)`，角度为弧度、正角度为逆时针（P4a 起带父链与三轴旋转，见「层级（P4a）」；P1 只处理 z 轴）。
  - 视图投影为 `ortho(0…w, 0…h)`，`w` / `h` 是 `orthogonalprojection`；z ∈ [−2000, 2000] 映射到深度 `0.00025·z + 0.5`（反向 Z，`ORTHO_DEPTH`，P4a 起照 WPE 抓帧，原来是 ±10000）。
  - 场景 JSON 的相机 `eye` 对正交场景不起作用：LWE 的投影里 `translate(eye)` 与 `lookAt` 恰好抵消（抖动加在 eye 上的偏移会平移画面，见「相机：视差、抖动与缩放（P5a）」）。eagleflag 的 eye 有 (−378, −186) 的偏移，预览图里画面并未平移。
- 矩阵按列主序写进 uniform：翻译器把 `mul(v, M)` 改写成 `M * v`，缓冲里放「列向量」约定的数学矩阵，与 glm 的 `value_ptr` 相同。
- **纹理坐标**：图像顶边对应 v = 0。按图层主纹理（基础材质槽位 0）的 UV 缩放 = 图像尺寸 / 纹理尺寸（`width / textureWidth`，WPE `FUN_1402091e0`）收缩。
  WPE 把 1920×1080 的图放进 2048×2048 这类纹理，同一张图层各槽位的填充比例一致；FreeImage 形态的纹理尺寸已改成图像尺寸，UV 为 1。

**绑定与 uniform**
- **绑定**：照翻译器约定，全部在 group 0。
  - binding 0：两阶段共用的 uniform 块。
  - 纹理槽位 n：`textures[].binding`（1 + 2n）；采样器：`samplerBinding`（2 + 2n）。
  - 着色器声明了、材质没绑的槽位绑全 0 的占位纹理，同 D3D 空 SRV 的读数。
- **顶点布局**：按 `attributes` 的 location 交错排列；`a_Position`、`a_TexCoord` 来自四边形，其它属性补默认值。
- **uniform 打包**：
  - 按 `offset` 写；标量 / 二三分量向量的数组按 `stride` 16 写前几个分量；`mat3` 列步长 16；整数写成 `i32` / `u32`。
  - 值来源：`drawUniformValues`（纯函数）先写内置值，再用材质常量覆盖。材质常量取自 `SceneState.constants`（编译期初值就是 `pass.uniforms`），就地改值时同一个函数重算，所以两条路逐字节一致（单测核对）。
  - **材质常量的取值照 WPE**（`compile/materialValues.ts`，`.claude/plans/wpe-import/3-scene/vector-constant-REPORT.md`，`p4b-vec` 实测）：缺键插注解缺省（先转字符串，所以数字缺省进向量不铺满）；setter 里数字进向量铺满，字符串进向量先清零、只按空格切、逐段 `atof`（`"a, b"` 得 (a, b)），float 只收数字，布尔 / 数组不写；`{user}` 先写 JSON 的 `value`，再把属性值交给同一个 setter，带 condition 的、布尔 / 下拉字符串 / 颜色绑 float 的都不写；就地写与脚本写回用同一个 setter、整体重写。同键不同类型被翻译器拆开的两半共用片元那一半的类型与缺省。按用户决定不复刻同阶段同键只上传后声明的、按声明行子串定类型两条。
  - 只有 `g_Time`、`g_Frametime`、`g_Daytime`、`g_PointerPosition(Last)`、`g_PointerState`、`g_ParallaxPosition`（P5a）每帧刷新；被就地改过的 draw 由 `update` 整块重写一次；视差或相机（抖动、缩放）变了的那一帧，全部 draw 的矩阵与眼位重写一遍（P5a）。
  - **就地刷新**（`GpuScene.refreshLayer` / `refreshPass`）：图层状态变化只重写由图层算出的那组名字（`LAYER_UNIFORMS`：矩阵、`g_Color*`、`g_Alpha` / `g_UserAlpha`、`g_CompositeColor`），`pass.uniforms` 里有的名字一律不动（材质值优先，如 passthrough 的 `g_Color4 = (1,1,1,1)`、材质自带的 `g_UserAlpha`）；材质常量变化重写本 pass 的全部常量。
- **内置 uniform**：P2a 起按 WPE `FUN_1400d8300` 校正（PLAN P2a「内置 uniform」），名字表 `features.ts` 的 `ENGINE_UNIFORMS` 与 `uniforms.ts` 写的值一一对应。
  - 变换：`g_ModelViewProjectionMatrix`（及 Inverse）、`g_ModelMatrix`（及 Inverse）、`g_ViewProjectionMatrix`、`g_NormalModelMatrix`。
  - 效果矩阵（w、h 取图层 `size`）：效果 pass 的 `g_EffectModelMatrix` = 图层世界矩阵 × scale(w/2, h/2)、`g_EffectModelViewProjectionMatrix` = 图层 MVP × 同一缩放、`g_EffectTextureProjectionMatrix` 与后者相同；上屏 pass 前两者不缩放、纹理投影 = MVP × scale(w/2, h/2)；各 Inverse 由对应矩阵求逆。直接上屏与基础 pass 沿用 P1（模型 / MVP，纹理投影单位阵）。
  - 对象：`g_Color4` = (color · k, alpha)、`g_Color` = color · k、`g_Alpha` / `g_UserAlpha` = alpha；k 在 LDR 下为 1（brightness 只在 HDR 下乘）。只在基础 pass 设一次：effect pass 沿用同一组值，passthrough 上屏置 (1, 1, 1, 1)。材质有 `Alpha` 时被覆盖。
  - 纹理：`g_Texture<n>Resolution` = (纹理宽, 纹理高, 图像宽, 图像高)，空槽 (2, 2, 2, 2)；`g_Texture<n>Texel` = (1/纹理宽, 1/纹理高, 纹理宽, 纹理高)，空槽 (0.5, 0.5, 2, 2)。合成 RT、fbo、快照按各自尺寸（纹理 = 图像）。`g_Texture<n>MipMapInfo` 还没实现（用到报 `uniform:`）。
  - 屏幕：`g_TexelSize` = 1 / 屏幕尺寸、`g_TexelSizeHalf` = 0.5 / 屏幕尺寸、`g_Screen` = (w, h, w/h)。WPE 取窗口（后备缓冲）尺寸，画合成 RT、fbo 时也不随目标变；我们取场景目标尺寸，与窗口同分辨率时等价。
  - 时间：`g_Frametime` = 本帧间隔，钳到 `[0.0001, 0.25]`；`g_Time` = 钳后帧时间的累加（P4a 起，`FrameClock`，见「粒子（P4a）」的「绘制」），超过 432000（5 天）归零；`g_Daytime` = h/24 + m/1440 + s/86400 + ms/8.64e7。
  - 指针：`g_PointerPosition` = 光标在画布上的归一化坐标（原点左上、y 向下，WPE 取窗口归一化坐标；P1 曾按 LWE 换算成场景坐标、左下原点），`g_PointerPositionLast` = 上一帧；`g_PointerState` = (按下, 按下, 本帧刚按下, 0)，还不跟踪按键（P6），恒为 0。粒子控制点跟随指针用的是另一个量（光标下的场景点，`FrameInput.cursor`），见「粒子（P4c）」的「指针」。`g_ParallaxPosition` = 视差点除以场景宽高再钳到 0…1，见「相机：视差、抖动与缩放（P5a）」。
  - 其它：`g_Texture0Rotation` = (1, 0, 0, 1)、`g_Texture0Translation` = 0、`g_LightAmbientColor` / `g_LightSkylightColor` 取 `general.ambientcolor` / `skylightcolor`。
  - 材质值优先于对象值：例如 beach 的云层材质 `Alpha` = 0.26，对象没有 alpha。LWE 会用对象值覆盖材质值，这里不照搬。
- **混合**：照 LWE `CPass::setupRenderFramebuffer`，颜色与 alpha 用同一组因子；其余模式关闭混合。
  - translucent：`src-alpha` / `one-minus-src-alpha`
  - additive：`src-alpha` / `one`
  - normal：`one` / `zero`
  - 画到场景目标的 pass 不写 alpha（LWE 最后一个 pass 前 `glColorMask(…, false)`），场景 alpha 一直是清屏时的 1；画进合成 RT / fbo 的 pass 写四通道，合成链带着 alpha 走到上屏。

### 图层渲染图（`graph.ts` + `scene.ts`，P2a）

依据 WPE 2.8.42 的只读逆向（p2-REPORT B5–B8、PLAN P2a；与 LWE 冲突时以 WPE 为准）。`planLayer(layer, textures)` 是纯函数，把一个图层排成步骤；`GpuScene` 照步骤建资源、逐帧编码。

- **直接上屏**（P1 路径原样保留）：没有启用的 effect，且 colorBlendMode ∈ {0, 31}。基础 pass 用图层几何画到场景，31 时混合改 additive。eagleflag / deep_space / beach 都走这条。
- **合成**：有启用的 effect，或 colorBlendMode ∉ {0, 31}。
  - 基础 pass 关闭混合（不透明写入、保留 alpha），正交投影把图层四边形画满合成 RT，UV 只采样纹理的有效区域；
  - effect 逐 pass：没有 `bind` 时槽 0 = 上一步输出（当前合成 RT）；有 `bind` 时只按 bind 赋值，找不到的名字（如 `previous`）= 当前合成 RT。`target` 是本 effect 的 fbo 就画进 fbo，缺省或 `compose: true` 写进合成链（ping-pong 下一张）；画全屏四边形，混合用 pass 自己的；
  - 上屏：只有最后一个启用 effect 的最后一个绘制 pass 用图层世界四边形、场景视图投影 × 图层模型矩阵画到场景，借用基础材质的 blend（colorBlendMode 31 强制 additive）；
  - colorBlendMode ∉ {0, 31}：effect 都留在合成链，最后用 passthrough 材质上屏（combos `BLENDMODE = cbm`、`FOG_COMPUTED = 1`，槽 0 = 最终合成 RT，`g_Texture4` 由注解默认绑到快照，颜色 (1,1,1,1)，blend 取基础材质的）。材质看 `scene.json` 顶层 `version`：> 2 用 `effectpassthrough_4.json`（genericimage4），否则 `effectpassthrough.json`（genericimage3），见 `bundle.ts` 的 `passthroughMaterial`。没有 effect 时也走「基础 pass → 合成 RT → passthrough」。
- **合成 RT 数** = min(2, 写进合成链的次数)：基础 pass、每个 effect 的最后一个绘制 pass 与每个 `compose` pass 各写一次，上屏那次不算，即 WPE 的 `min(2, passthrough + Σ(1 + compose))`；第 n 次写进 `n % 2`。尺寸取基础材质槽 0 纹理的图像尺寸（没有纹理或模型 `solidlayer` 取图层 `size`），max(4, ·)；格式 LDR `rgba8unorm`、HDR `rgba16float`。合成 RT 按尺寸与采样方式跨图层共享（WPE `sc.<W>.<H>…`），采样跟随基础纹理的 clamp / nointerpolation。
- **fbo**（effect.json `fbos`）：格式 `rgba_backbuffer` / `rgb_backbuffer` 随 HDR，其它查格式表（`FBO_FORMATS`：rgba8888、rgb888、rg88、r8、rg1616f、r16f、rgba16161616f、rgb161616f），不认识的按 rgba8888；尺寸 W′ / H′ 取 `width` / `height`（≤4096）否则合成 RT，`fit`（≤4096）时 W′ < H′ 则 h = min(fit, H′)、w = W′/H′·h，否则 w = min(fit, W′)、h = H′/W′·w，截断后整除 `scale`，最小 2；`unique` 每层独占，否则按名字、尺寸、格式、寻址共享；`clear` 创建后清成该色；`uvs: "repeat"` 重复寻址，否则 clamp。
- **命令**：`copy` = `copyTextureToTexture` 把 source 整张拷到 target（格式必须一致）；`swap` 不做 GPU 工作，只交换后续 pass（含之后各帧）里这两个名字指向的实体（`FboBindings`），引用 fbo 的 bind group 按当前对应取并缓存。
- **UV 内缩**（`layout.ts` 的 `uvInset`）：上屏的四边形两端各缩 `0.15 / 分母`，float32 逐步算，包括直接上屏、最后一个 effect 上屏和 passthrough 上屏；基础 pass 和 effect 中间 pass 不缩，模型 `solidlayer` 不缩。分母是基础纹理的纹理尺寸，走合成路径时也是，不是合成 RT；没有纹理时是图层 `size` 的整数部分。
- **`_rt_FullFrameBuffer` 快照**：场景目标整张 `copyTextureToTexture` 到独立纹理，**绝不采样正在写的目标**。每图层至多拷一次，时机是三处里最早满足的一处：图层开始时（基础材质需要帧缓冲，或走 passthrough）、需要帧缓冲的 effect 的第一个 pass 之前、上屏 pass 之前；内容都是画到本图层之前的场景（合成链不画进场景）。本帧还没画过场景时先清屏再拷。WPE 第一处另有「非 fullscreen 或有子层、无 passthrough 父层」的条件；`fullscreen` 与 `passthrough` 对象仍报 unsupported，P4a 放开父子层后照样恒成立。
- **需要帧缓冲**（`bundle.ts` 的 `needsFramebuffer`，WPE `FUN_1401515b0`）：某个纹理槽最终解析到的名字是 `_rt_FullFrameBuffer`，解析顺序是材质 `textures` 里给的名字 → 着色器注解 `default`；effect 里任一 pass 需要，该 effect 就需要。
- **编码**：画到场景目标的步骤合并进同一个 render pass；画进合成 RT / fbo、拷快照与 copy 时先结束场景 pass，之后以 `load` 接着画。场景目标带 `COPY_SRC`。
- **可见性运行时可变**（P3a）：ops 按图层分组（泛光的 op 单独放在最后），`encode` 先按 `SceneState` 的 `visible` 过滤（`visibleObjects`），不可见图层整段跳过——包括它的快照与 copy / swap；全部图层都不可见时只清屏（泛光照旧跑）。`visible` 绑了用户属性（`visibleBound`）的图层即使当前不可见也建资源，`checkRenderable` 同样检查；没有绑定、写死 `false` 的图层照旧不建。
- **effect 开关运行时可变**（P3c）：
  - **编译**：`visible` 绑了属性或挂了脚本的 effect 不管当前开关都进 bundle，纹理和 fbo 加载时建好，`enabled` 记当前值，`visibleBound` 标记可变。写死关闭、没有绑定的不进 bundle，也不读它的文件。
  - **不支持项归属**：effect 自己的不支持项记在 `effect.unsupported`，只有开着才并进场景级。打开带不支持项的 effect 走整场重编译，所以它不算可变。
  - **预建**：WebGPU 的管线绑定了混合、目标格式与写掩码，WPE 的着色器不绑，所以加载时用 `variantPlans` 枚举 n + 2 份计划，覆盖全部管线键：全开、全关，以及每个可变 effect 的上屏角色。预建失败不影响当前画面，只把图层标成不能就地切换，之后切这一层走整场重编译。
  - **切换**：`sync` 当场重排该图层，和加载共用 `buildLayer`，所以脚本写的开关同一帧就画。开关真的变了才清 fbo，同一帧关了又开也算变了。
- **还没做**：精灵表单帧；基础材质多 pass 仍报 `render:multi-pass`。
- **颜色空间**：WPE 在 gamma 空间混合，纹理、离屏目标（LDR `rgba8unorm`、HDR `rgba16float`）与画布都用非 sRGB 格式，不做转换；HDR 只是让数值可以超过 1。
- **Tint**：着色器模块开头加 `diagnostic(off, derivative_uniformity);`。WGSL 要求隐式求导只在一致控制流里，HLSL 没有这条限制；naga 不做一致性分析，翻译器发现不了。本机语料里 `effects/depthparallax` 原样会被拒。报告行号时扣掉这一行。

### general 字段、清屏与相机（P3c）

`GENERAL_FIELDS`（`compile/bindings.ts`）列出 WPE 里只改字段、不用重编译的 17 个 general 键（P5a 加了 `zoom`）。编译、就地写和脚本读写都走 `generalValue`，所以就地结果和整场编译相同。

| 字段 | 运行时 |
|---|---|
| `clearcolor`、`clearenabled` | `encode` 每帧读，不走脏项，脚本写入同帧生效 |
| `ambientcolor`、`skylightcolor` | 脏位 `lights`，`sync` 刷进声明了这两个 uniform 的 draw |
| `fov`、`nearz`、`farz`、`camerafade` | 只存值，脚本能读回，正交场景里不影响画面 |
| `camerashake*`、`cameraparallax*`、`zoom` | 渲染器每帧读（P5a）：抖动与缩放在帧开头按脚本之前的值取，视差点按脚本之前的值推进，绘制用的视差开关与 `amount` 取脚本之后的值，见「相机：视差、抖动与缩放（P5a）」的「一帧里的顺序」 |

- **`clearenabled: false`**：颜色和深度都不清，不是清成黑色，初始底色是黑，`clearcolor` 不出现。WPE 画进两张交替的后备缓冲，第 N 帧的底图是第 N−2 帧的成品，两条链互不相交；泛光写回当前缓冲，所以底图含泛光，LDR 每两帧累加一次，HDR 趋于收敛。我们用两张场景目标逐帧交替，泛光的 combine 写当前这张。
- **第二张目标**：当前关着，或 `clearenabled` 绑了属性、挂了脚本（`SceneGeneral.clearVariable`）时，加载就建，从第一帧开始交替，清屏开着也换，运行中关掉时手上正好是 N−2。别的脚本写入时才建，并把当前画面拷过去，这一帧的底图是 N−1，静止内容相同。多一张全尺寸目标，4K LDR 约 32 MiB，HDR 约 63 MiB。
- **HDR 不清屏**：WPE 的后备缓冲存 `lin(x)`，我们的目标存 `x`，所以每帧切完目标先把底图过一次 `lin`（`GpuScene.linearizeBase`）：拷到快照，再全屏画回目标。快照当中转用，因为 `snapshot` 步骤读之前总会重新拷。
- **相机不能绑**：WPE 加载时直接读 `camera` 的字符串，写成对象就跳过。正交且没有 `paths` 时，加载末尾把 `eye` / `center` / `up` 重置成默认值，视图矩阵是单位阵（开抖动时是 `T(−s)`，P5a），JSON 的值被丢弃。所以我们不登记这三个绑定，投影用 `ortho(0…w, 0…h)`（P5a 起绕中心乘 `zoom`），`g_EyePosition` 是 `(W/2, H/2, 2000)` 加本帧的抖动偏移（`layout.ts` 的 `eyePosition`）。

### 泛光与 HDR（`compile/bloom.ts` + `render/bloom.ts`，P2b）

规格来自对 WPE 2.8.42 的逆向，并用 RenderDoc 抓帧逐位核对（p2-REPORT A1–A4、J5，PLAN P2b）。

- **何时跑**：档位不是关闭、场景有对象，且 `general.bloom` 当前开着或绑了属性 / 挂了脚本时，编译期生成 `bundle.bloom`；`encode` 每帧看 `SceneState.bloomEnabled`，开着时在**全部图层之后**把场景目标整张拷进 `_rt_FullFrameBuffer`（与图层共用一张，只在这里多拷一次），跑泛光链，combine 读快照与泛光结果、写回场景目标，之后照常 cover 到画布。没有链或开关关着时，渲染路径与 P2a 完全相同（关闭档五张样本的离屏目标与 P2a 逐字节相同）。
- **着色器**：一律是 WPE `assets/materials/util/` 的原件，经翻译器编译、和图层材质走同一套管线（运行时从用户的 WPE 读，不随应用分发；缺了照常 `material:missing:…` / `shader:…` 退回）。`g_RenderVar0` 只在这些 pass 里由渲染器写（`POSTPROCESS_UNIFORMS`），图层材质里用到照报 `uniform:g_RenderVar0`。场景参数按**材质名**写入（`bloomstrength`、`blend`、`scatter`…，与 WPE 一致），由着色器注解 `{"material": …}` 对到 uniform。
- **共同约定**：每步画全屏四边形、只写 RGB（write mask 7）、关混合（上采样除外），采样线性过滤 + clamp；`g_TexelSize` 取场景目标（WPE 是窗口）尺寸。
- **LDR**（`rgba8unorm`）：`downsample_quarter_bloom`（快照 → `_rt_4FrameBuffer`，W/4，4 tap → `saturate(max(rgb) − threshold)·rgb` → 加饱和 → `× strength × tint`）→ `downsample_eighth_blur_v`（→ `_rt_8FrameBuffer`，W/8，13 tap）→ `blur_h_bloom`（→ `_rt_Bloom`，W/8）→ `combine_ldr`（`scene + bloom`，RGBA8 自然截断）。参数原值写入，不做换算；RT 尺寸 max(2, ⌊W / 除数⌋)。
- **HDR**（`rgba16float`）：场景目标、快照、合成 RT 都是 FP16（`*_backbuffer` fbo 编译期已换算），图层颜色乘 `brightness`（`g_Color4` = (color · brightness, alpha)）。
  - 金字塔：Li 名义尺寸 = 场景 / 2^(i+1)，RT 尺寸向下取整、至少 2（4K 的 L7 是 15×8）。可用级数 = min(w, h) 逐次减半仍 ≥ 1 的次数（最多 8），N = clamp(min(`bloomhdriterations`, 可用级数), 1)。
  - 步骤：`hdr_downsample_bloom`（快照 → L0，soft-knee）→ `hdr_downsample` × (N − 1) → 上采样 u = N−1…1（L(u) → L(u−1)，SrcAlpha / One 加法；u ≥ N−2 用 `hdr_upsample_cubic`，其余 `hdr_upsample`）→ 收尾。
  - `g_RenderVar0` = (tx, ty, −tx, −ty)：下采样取**源**纹素、上采样取**目标**纹素，按**名义**尺寸算（第 i 级 2^(i+1) / W），不随 RT 取整变。
  - 参数（`hdrBloomConstants`，float32 逐步计算，与抓帧常量逐位相等）：`bloomstrength` = (hdrstrength / (1 + scatter^(max(N, 2) − 2)), scatter)，`blend` = (t, t − k, 2k, 0.25 / (k + 1e−5))（k = t · feather），`scatter` 写给两个上采样材质，`bloomtint` 原样。
  - **收尾**：WPE 在 SDR 显示上用 `combine_hdr_upsample` 输出 `saturate(lin(scene + bloom)) · RV0.x`（RV0.x = 1）到 FP16 线性交换链。我们的画布是 8 位、按编码值显示，用同一份 `combine_hdr` 的 `LINEAR=1` 变体 `combine_hdr_upsample_linear`（也是 WPE 原件）输出 `saturate(scene + bloom)`：sRGB 编码是 `lin()` 的精确反函数，两者单调且把 [0, 1] 映到 [0, 1]，所以 encode(saturate(lin(x))) = saturate(x)，在画布上逐值相等，还省掉 pow 往返与 cover 时的编码。之后 cover 把 FP16 目标写进 8 位画布。
- **档位切换**：`WpeSceneView` 收到 `setting-change` 后整场重编译，`GpuScene` 按新的 HDR 状态重建场景目标格式；预览、应用背景与桌面用同一个设置（D13），不为预览降档。
- **泛光参数就地改**（P3a）：`bloomstrength` / `bloomthreshold` / `bloomtint` / `bloomhdrstrength` / `bloomhdrthreshold` / `bloomhdrfeather` / `bloomhdrscatter` 绑用户属性时就地重算 `BloomChain` 各 pass 的常量并重写 uniform（`BloomChain.setParams`，按 `hdrBloomConstants` 同一套 float32 换算，单测核对与重新建链逐字节相同）。
- **级数就地**（P3c）：金字塔总是建满全部可用级，每帧只用前 N 级。绘制按步骤身份（pass + 输入 + 目标）去重，8 级共 21 个，`setParams` 取出这一级数要用的绘制。每帧下采样整张覆盖，改级数不残留。
- **开关就地**（P3c）：`general.bloom` 是场景位 `SceneState.bloomEnabled`，不含档位，脚本读到的也是它。档位关闭时没有链，位怎么变都没有效果，和 WPE 一致。写死 `bloom: false` 的场景也没有链，被脚本打开时走整场重编译；WPE 这里同帧生效，这是有意的差异，换来带脚本的场景不多占显存。
- **HDR 只在加载时判定**：判定里的 `bloom` 读场景文件的 `value`，不读属性当前值，也不看脚本写入；`hdr` 读属性当前值与脚本覆盖。所以 JSON 为 true、属性为 false 的场景是关着泛光的 HDR 场景，运行中打开是 HDR 泛光。运行中关掉 HDR 场景的泛光，目标格式和 `brightness` 都保持 HDR。`general.hdr` 改值走整场重编译并生效；WPE 运行中改不生效，这里有意不跟。
- **显存**（`GpuScene.targetBytes`，渲染目标类资源，不含纹理）：bedroom 4K 关闭 / 开启 / 超高约 70 / 73 / 161 MiB，HDR 多出的主要是 FP16 的场景目标与快照（各 63 MiB）和金字塔（约 21 MiB）。
- **链路隔离验证（dev 探针）**：`apps/wpe-scene/src/dev/` 在 dev 构建挂 `window.__kabegameSceneProbe`（`vite.config.ts` 的模式常量门控，生产构建里整块被摇掉，已用生产构建确认）：
  - `bloom({ assets, hdr, params, input, references })`：输入 RenderDoc 导出的整帧快照（RGBA16F `.dds` 或 RGBA8 `.png`），跑同一份 `BloomChain`，读回第一步、泛光结果（`_rt_Bloom` / L0）与最终输出，和 WPE 的对应纹理逐像素比（HDR 中间结果按浮点、最终输出把 WPE 的线性后备缓冲按 sRGB 编码成 8 位再比）。图片一律经 GPU 纹理上传、读回，不走 2D 画布（RenderDoc 存的 RT alpha 常为 0，过画布会因预乘丢掉 RGB）。
  - `renderFrame({ projectDir, sceneAssets, postprocess, time, profile, canvas })`：按固定 `g_Time` 渲染一帧、同步读回场景目标，给 SHA-256、PNG、显存估算与逐帧耗时；`chunk(key, i)` 分块取回存下的 PNG。给 `canvas: [宽, 高]`（正整数，不超过 `maxTextureDimension2D`）时，读回那一帧编码完场景之后用渲染器上屏的同一份着色器与线性采样器（`render/blit.ts`）按 `fill` 把场景目标铺进这么大的 `rgba8unorm` 纹理、读回它（和 WPE 抓帧窗口同尺寸比，不用再缩放），光标的换算窗口是 `window ?? canvas`（两个都给而不同时抛错），结果另带 `canvas`、`sceneTarget`；只改读回、不改渲染，`g_Screen` 等仍按场景目标算。不给时逐字节同以前（kabegame-chromium 第 5 批）。

**铺放与帧循环**
- **铺放**：
  - 场景按图层顺序画进场景分辨率的离屏目标（超过 `maxTextureDimension2D` 时等比缩小），清屏色取 `clearcolor`（`clearenabled` 为 false 时黑色）。
  - 再用全屏三角形按 **cover**（等比盖满、居中裁切）铺到画布，输出不透明（`alphaMode: "opaque"`）。
  - 宽高比差很多的场景（如三屏 5760×1080）在 WPE 里怎么处理还没对照，P1 统一 cover。
- **帧循环**：
  - `requestAnimationFrame`，默认上限 60 fps；节拍固定前进，144 Hz 屏上平均 60 fps。
  - 帧时间钳到 `[0.0001, 0.25]`，`g_Time` 累加钳后的值（P4a，同 WPE）；粒子每个实时帧步进一次，补画帧不步进。
  - `paused` 或 `document.hidden` 时停循环、冻结时钟，恢复后 `g_Time` 从冻结处继续，不跳变。
  - 壁纸窗口挂在 WorkerW 下并不被判为隐藏：2026-11-01 实测 `visibilityState` 为 `visible`、`hidden` 为 false，rAF 稳定 144 Hz，桌面场景照常动。所以壁纸窗口也按 `document.hidden` 停帧，没有另加选项。Chromium 里页面隐藏时 rAF 本身就不再回调，只忽略 `hidden` 也换不来帧。窗口被其它窗口完全遮住时 Chromium 的原生遮挡检测可能把页面判为隐藏（未实测），那时停帧正好省 GPU。
  - 暂停期间画布尺寸变化会以同一时刻补画一帧。
- **替换**：`SceneRenderer.load(bundle)` 先在同一设备上建好新场景，再换掉旧的并释放；第一帧提交后等 `onSubmittedWorkDone` 才返回。

**退回条件**（`fallback` 的原因键，见 `render/errors.ts`）
- 编译期：`bundle.unsupported` 原样给出；Worker 编译失败为 `compile:…`。
- WebGPU：
  - 不可用：`webgpu:unavailable`、`webgpu:no-adapter`、`webgpu:device-failed:…`。
  - 场景用到 BC 而适配器不支持：`webgpu:no-bc`。DXT 不做 CPU 解码。
  - 着色器与管线：Tint error 为 `webgpu:shader:<程序>:<阶段>:<行>:<消息>`；管线为 `webgpu:pipeline:…`。
  - 运行期：校验错误 `webgpu:validation:…`、显存不足 `webgpu:out-of-memory:…`、设备丢失 `webgpu:device-lost:…`。
  - 纹理数据：mip 链不一致 `webgpu:texture-mip`、数据不足 `webgpu:texture-data`、BC 尺寸不是 4 的倍数 `webgpu:texture-size`。
- 渲染器自查（`checkRenderable`，按 `planLayer` 的步骤逐个核对，只查 `buildableLayers`）：基础材质多 pass `render:multi-pass`、缺程序 `render:no-program`（粒子程序同样）、粒子着色器有渲染器写不了的顶点输入 `render:particle-attribute:<名字>`、不认识的顶点属性类型 `render:attribute:…`、缺纹理数据 `render:texture-missing:<下标>`、`_rt_*` 名字解析不到 `render:texture-rt:<名字>`、colorBlendMode 混合但 passthrough 没编出来 `render:no-passthrough`、effect 里没有绘制 pass `render:no-final-pass`；建资源时 copy 两端格式不同 `render:copy-format:<图层>`、swap 两端尺寸 / 格式不同 `render:swap-mismatch:…`；泛光链缺 pass 或程序 `render:bloom:<pass>`、着色器声明了渲染图没给的槽位 `render:bloom-slot:<pass>:<槽>`。
- dev 强制渲染（`SceneRenderer.load(bundle, { ignoreUnsupported: true })`）只跳过 `bundle.unsupported`，上面的自查照常生效。

## 接入 `WallpaperStage`（scene 层）

`apps/kabegame/src/components/wallpaper/WallpaperStage.vue` 对 `type === "x-wpe/scene"` 的目标（判定在 `targetKind.ts`）走独立的 **scene 层**，切入切出照 web 层：

- **一次只有一个场景**：层里挂一个 `WpeSceneView`（key 每次挂载递增），它自己读属性、编译、持有 GPU 设备。切走、换场景、target 置 null、组件卸载都先卸载它（终止编译、销毁设备）再做别的。
- **层级**：z-index 3，盖在 web 层（2）之上。
  - 网页 → 场景：场景淡入盖住网页后再销毁 iframe。
  - 场景 → 网页：网页先在场景层下面加载、淡入，场景层再淡出卸载。
  - 场景 → 图片 / 视频：新媒体先直设到 base，场景层淡出后卸载。
- **状态流转 loading → live / fallback**：
  - `loading`：从挂上 `WpeSceneView` 开始，读属性、编译、建设备期间什么都不显示，也不 emit `ready`。图库那边 `ImageContent` 保持加载态；桌面保留上一张壁纸，照 web 层「等 load 再淡入」。
  - `live`：`WpeSceneView` 出首帧（`ready`）就整层淡入实时画面，同时 emit `ready`，中间不出现预览图。
  - `fallback`：`WpeSceneView` 报 `fallback(reasons)`，这时才挂上作者预览图（目标的 `previewPath`，按壁纸样式显示），预览图加载完才淡入并 emit `ready`。原因记进调试快照 `sceneFallback`（`; ` 连接），不是错误。没有预览图或预览图加载失败时 emit `error`（`WpeWallpaperContent` 按非致命处理，只结束加载态）。
  - **超时**：`SCENE_RESULT_TIMEOUT_MS = 10s` 内既没 `ready` 也没 `fallback`（Worker 卡住、取设备挂起）时，按 `fallback(["render:timeout"])` 显示预览图并 emit `ready`。本机实测编译到首帧 0.3–0.6 s；壁纸窗口 init 看门狗首轮 15 s，而且 init 不等 Stage 出画面。超时后 `WpeSceneView` 不卸载，迟到的首帧照样切成实时画面（画布淡入盖住预览图）。
  - 之后的变化：同一张场景改属性重编译时 `WpeSceneView` 在同一设备上换场景，画面一直是旧场景直到新场景就绪，Stage 不回到 loading，也不闪预览图。改属性后不能渲染了就退回预览图，退回后又能渲染了就切回实时画面。`ready` 每个目标只发一次。
- **场景 → 场景**：因为同时只能有一个 `WpeSceneView`，先淡出并卸载旧场景，再走新场景的 loading，中间会露出场景层下面的内容（桌面上是窗口背后的东西，与 web → web 相同）。实测空档约 0.2–0.4 s（transition `none`）。
- **样式**：壁纸样式按 Kabegame 语义生效，几何同图片层（`render/layout.ts` 的 `scenePlacement`）：`fill` 等比盖满、`fit` 等比放进、`stretch` 拉满、`center` 一个场景像素对一个布局 CSS 像素（iframe 里的 CSS 像素，按画布的 `pixelRatio` 换算；放不下就居中裁，预览缩小显示时构图与桌面相同）、`tile` 等比放进后居中重复。WPE 的 Free 不做。宿主画布始终铺满 iframe，只有上屏这一步变（视口加 `offset + uv * scale`，`tile` 换重复采样器），场景本身不重画，改样式不重编译、暂停时也会补画一帧。样式走 postMessage（`wpeSceneStyle.ts`，字面量在宿主 `sceneStyle.ts` 另有一份，测试比对）：宿主启动时请求一次，变化时 `WpeSceneView` 主动推。
- **留白颜色**：`fit` / `center` 空出的区域整屏清成 `schemecolor`，不是 `clearcolor`，这和 WPE 一致：对齐为 fill(1) / center(3) / free(4) 时用它代替清屏色（`(alignment & ~2) != 0`，`0x14017fc4c`，实测 `alignment=1` + `schemecolor="1 0 0"` 背景整片变红）。WPE 的优先级是用户值 > `config.json` 的 `general.defaultproperties.schemecolor` > 工程值 > 灰色 `0.5 0.5 0.5`；我们从宿主的属性全集取，用户值已并入，`defaultproperties` 不读（本机没有这个键），灰色兜底照搬。值原样当 0…1 的 RGB，不做颜色空间转换，alpha 为 1。作者建工程时编辑器按素材主色填 `schemecolor`（`getDominantColorFromFile`），所以留白通常和画面配套。用户改色走属性增量，就地生效。退回预览图时留白不是这个颜色，Stage 没有它。
- **指针**：`fill` / `stretch` 仍取窗口归一化坐标（同 WPE；P4c 步骤 2 补测确认窗口和场景比例不同、WPE 居中盖满裁切时，`g_PointerPosition` 仍是窗口坐标）；其余样式画面不跟窗口对齐，`scenePointer` 换算到场景上，光标效果才落在画面上，留白处的值在 0…1 之外，`tile` 按所在那一块算。WPE 在这些对齐下怎么算没有查过。粒子控制点的跟随点在所有样式下都按铺放反算（`sceneCursor`），和 `g_PointerPosition` 只在 `fill` 下不同，见「粒子（P4c）」的「指针」。过渡（fade / slide / zoom）对 scene 层整层生效，曲线与 web 层相同。
- **`paused` / `interactive`**：由 `WpeSceneView` 经音量消息的 `paused` 交给垫片，垫片调用宿主的 `setPaused`（停帧冻结时钟）；`interactive` 控制 iframe 指针事件。
- **调试快照**：`media` 增加 `"scene"`，`sceneFallback` 是当前退回原因。`delegatesPing()` 在宿主垫片首次请求音量后把 ping 交给宿主；未启动时仍由应用页应答。

图库与设置的接入：
- **图库预览**：`ImageContent` 的 `wallpaper` 形态与网页壁纸相同（`isWpeWallpaperContentType` 认 scene）。预览不看壁纸样式，和单独的图片一样完整显示：`WallpaperPreviewCanvas` 按场景分辨率布局再整体缩放，没有背景。分辨率是图片行的 `width` / `height`：导入时读入口 json 的 `general.orthogonalprojection`（`WpeProject::scene_resolution`，入口在 `scene.pkg` 里时 Rust 读包里这一个条目），所以预览一打开就是正确比例，网格、宽高比筛选与详情面板读的也是它。透视场景没有这个字段，宽高留空，画布按主屏比例。退回时预览图在这块画布里按 contain 显示。作者更新壁纸改了分辨率时行不会跟着变，这时预览多一点留白。样式由调用方的 `fit` 决定（预览 `contain` → `fit`，应用背景 `cover` → `fill`），`WpeWallpaperContent` 不读壁纸目标里存的样式（过渡取默认壁纸目标在当前壁纸模式下的有效过渡，见 [../wallpaper/MULTI_SCREEN.md](../wallpaper/MULTI_SCREEN.md)）。
- **属性面板**：预览右栏与设置页「当前壁纸」的属性面板对场景也显示（`hasWpeUserProperties`）。场景不显示 `file` / `directory` 属性：渲染器不读用户选的文件，放行也只对网页壁纸目录生效。场景特有的 `scenetexture` / `replacetexture` 后端解析时就跳过了。改属性后垫片按本张 `metadataId` 补丁拉取并把变化键交给 `SceneHost` 的应用函数（就地写或重编译，见「属性与快速路径」）。
- **应用背景**：不按类型分支，与预览同走 `ImageContent` 原图形态，场景与网页壁纸都实时渲染（不交互）。代价是主窗口开着背景时常驻一个 GPU 设备；打开预览时与预览里的场景同时渲染。
- **画布尺寸**（2026-11-07 修正，`render/layout.ts` 的 `canvasSize`）：画布像素 = 布局尺寸 × DPR × **显示缩放**，各边取整；超过 `maxTextureDimension2D` 时宽高按同一比例缩，宽高比不变。
  - **显示缩放由父页面量**：预览画布按内容尺寸布局、再整体 `scale` 进弹窗，这个 transform 加在父页面的 iframe 元素上，iframe 里量不到（`getBoundingClientRect` 在 iframe 里量到的就是布局尺寸）。`WpeSceneView` 用 `displayScaleOf`（`getBoundingClientRect` ÷ `offsetWidth` / `offsetHeight`，两个方向取大的）量，经消息 `kabegame:wpe-scene-display`（`wpeSceneStyle.ts` / 宿主 `sceneStyle.ts` 的 `listenSceneParent`）推给宿主的 `setDisplayScale`。宿主请求样式时必回一次；iframe 尺寸变化（ResizeObserver）、窗口 resize 时量；祖先 transform 变化哪个 observer 都不触发，所以再每 250 ms 轮询，相对变化超过 1e-4 才推。量不出来（未布局、`scale(0)`）时不推，宿主保持上次的值（起初 1）。
  - 宿主帧循环也每 250 ms 核对一次画布尺寸（DPR 变化不触发 ResizeObserver）。桌面窗口没有缩放，显示缩放为 1，结果与只按 DPR 算逐位相同。
  - 修正前按布局尺寸 × DPR 渲染、超 8192 时宽高各自钳：4K 上渲染一张只显示约 1/4 面积的大画面，宽高比还被破坏，预览「适应」下多出 `schemecolor` 留边、画面缩小。
  - 脚本的 `engine.screenResolution` 按显示缩放 1 算（`SceneRenderer.screenResolution`），预览缩小显示时脚本看到的分辨率仍与桌面一致。

**验证**（2026-11-01，本机 NVIDIA Lovelace，有 `texture-compression-bc`）
- **单测**：`render/render.test.ts` 覆盖矩阵、四边形与 cover、BC 行跨度与 mip、uniform 打包、混合、顶点布局、时钟与节流；设置 `KABEGAME_WPE_ROOT` 后另对 P1 三张样本跑一遍纯逻辑部分。
- **三张 P1 样本**：主窗口真机渲染，与 `preview.jpg` 的中心方形裁切对比。
  - eagleflag、deep_space 构图、方向与颜色一致；deep_space 的旋转取反后差异变大，正角度逆时针得到确认。
  - beach 的几何对上了：把 y 翻转后差异翻倍。作者预览图整体更亮、亮部带柔光、所有图层偏移约 30 px，但与 WPE 桌面实拍（16:9 全屏）对照时构图重合、平均亮度差约 1%，说明是预览图另有后期。**对照以 WPE 实拍为准，作者 `preview.*` 只作参考。**
  - 三张都在动；eagleflag 传 `flagcolor2: "0 0 1"` 后星形变蓝。
- **Tint**：在应用页用 wasm 翻译本机语料 167 对，其中 153 对成功；306 个模块经 `createProgram` 全部通过，0 error / 0 warning。不加前言时只有 `depthparallax` 片元 1 个 error。
- **scene 层（P1-5）**：
  - 单测 `components/wallpaper/WallpaperStage.scene.test.ts`（`WpeSceneView` 用替身）覆盖类型判定、loading 期间不显示也不发 `ready`、首帧直接淡入、退回才挂预览图、超时、迟到的首帧、没有预览图报错、场景与图片 / 场景互切（同一时间一个实例）、带过渡的淡入淡出、target 置 null。
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

设计见 PLAN.md 的 P3-0「形态更新」：编译、渲染与已实现的 P3b 场景脚本都在独立的 `file:` iframe（场景宿主）里；脚本另用其内的同源子 frame 运行，见下「场景脚本（P3b）」。场景宿主与网页壁纸共用 sandbox 和 `wpe-web-capability`；垫片负责属性补丁与 ping / pong，`SceneHost` 负责加载、渲染、后处理档位和状态上报。应用页的 `WpeSceneView` 只承载 iframe，按实例号认领状态事件。

- **项目** `apps/wpe-scene`：独立的纯 TS + Vite 前端项目，不用 Vue（workspace 成员，依赖全用根 `node_modules` 里已有的；类型检查 `deno task --cwd apps/wpe-scene typecheck`），`base: "./"`。`src/compile/`、`src/render/`、`src/wpesl2wgsl/`、`src/dev/` 均从应用页迁入，`SceneHost` 在首次属性包到达后才加载，后续变化走应用函数（P3a：就地写或重编译，见下）；不直接订阅图片事件。Worker 为自包含 IIFE，wasm 仍由主线程获取、编译后传给 Worker。
- **产物位置**：应用的 `resource_dir`，即 exe 旁的 `resources/wpe-scene/`。
  - dev：`vite.config.ts` 默认输出到 `<CARGO_TARGET_DIR 或 target>/debug/resources/wpe-scene`。`WpeSceneHostPlugin`（`scripts/plugins/wpe-scene-host-plugin.ts`）在 `deno task dev -c kabegame` 开始时构建一次；之后改宿主跑 `deno task --cwd apps/wpe-scene build --mode development`（或带同一 mode 的 `watch`），重载 iframe 即生效，不重编 Rust。
  - 为什么 dev 不走 tauri-build 复制：它只在 `build.rs` 重跑时把 `src-tauri/kabegame/resources/**` 复制进 `target/<profile>/resources`，而 resources 目录有变化本身就会让 `build.rs` 重跑、主 crate 重编、dev 重启应用。dev 同时删掉 `src-tauri/kabegame/resources/wpe-scene` 里上次 prod 构建的残留，免得 `build.rs` 重跑时盖掉 dev 产物。
  - prod：`deno task b` 时构建到 `src-tauri/kabegame/resources/wpe-scene`（gitignore），经 tauri.conf.json 的 `resources/**/*` 打进安装包，安装后同样在 exe 旁的 `resources/wpe-scene`。
  - 只在桌面 standard 模式、不带 `--skip vue` 时构建；Android / Web 不构建。
- **地址**：`get_wpe_scene_host_url`（只给主窗口 / 壁纸窗口的应用页，它们免 ACL）返回 `index.html` 的 `file:///` 地址，盘符大写（Chromium 规范化后的形式，文档 URL 与 IPC 来源因此逐字相同）；宿主没构建时报错。应用页加载时附加 `kbScene=<图片 id>`、`kbInstance=<实例号>`，sandbox 同网页壁纸（`WallpaperStage` 的 `WEB_SANDBOX`）。实例号区分同一窗口中的预览与应用背景。
- **P3-0b 加载与 ping**：`WpeSceneView` 首次收到本 iframe 的可信音量请求时才 emit `alive`；`WallpaperStage.delegatesPing()` 此后把桌面 ping 交给场景宿主垫片，换场景或卸载时收回。宿主没起来时仍由应用页应答，避免反复重载；宿主脚本卡死时垫片不再应答，壁纸窗口看门狗会重载。暂停和音量走与网页壁纸共用的消息协议；状态与日志走 `wpe_scene_report`，日志 target 是 `kabegame::wpe_scene_host`。
- **开发与测试**：dev 构建用 `--mode development`，`vite.config.ts` 的 `__SCENE_DEV__` 只在该模式安装 `window.__kabegameSceneProbe`。CDP 应先按 frame URL 中的 `/wpe-scene/index.html` 选宿主 frame，再调探针。`deno task test -c kabegame --skip cargo` 依次运行 `apps/kabegame` 与 `apps/wpe-scene` 的 Vitest；宿主可单独运行 `deno task --cwd apps/wpe-scene test`，语料测试继续使用 `KABEGAME_WPE_ROOT`。
- **`file:` 访问范围**（`wallpaper/wpe_scene_host.rs` 的 `access_scope_of`，就是注册给 runtime 的解析器：宿主目录优先，其它路径照旧按网页壁纸目录）：
  - 宿主目录里的文档：根为宿主目录，另放行 WPE 安装目录（`wpe::discover::engine_dir`）的 `assets/` 与 `config.json`，以及库里全部 `x-wpe/scene` 行的目录。
  - 场景目录由网页壁纸目录索引顺带维护（`WpeWebDirIndex::scene_dir_grants`，随 `images-added` / `images-deleted` / 带 `localPath` 的补丁更新），但**不**构成网页壁纸范围：场景目录里的 `file:` 文档什么都读不到，应用页也不能把 iframe 导航进场景目录。
  - 应用页导航 iframe：目标只能落在宿主目录（runtime 对导航目标去掉放行项）。
  - 宿主目录与 WPE 安装目录在启动时（`init_heavy_globals`）和每次取地址时刷新，闸门只读内存。
  - 范围按文档路径算、不分实例：宿主能读库里所有场景目录与 WPE 资源。按实例收窄要让解析器拿到文档 URL 的 query，以后再做。
- **IPC**：两份 capability 叠加。
  - 网页壁纸的 `wpe-web-capability`（`file:///*`）同样匹配宿主，网页壁纸的命令与事件宿主都有：`wallpaper_pong`、`setting-change` / `image-changed` / `images-change` / `wallpaper-ping` 监听。垫片拉 `wpe_web_pull_state` 时带 `kbScene` 的 `imageId`；后端只在调用方是宿主入口且 id 是库内场景壁纸时接受，返回与网页壁纸同形的 `user`，`directories` 为空，不写用户文件 grants。普通网页壁纸仍按文档目录认图，忽略传入的 id。
  - 暂停与音量沿用父页面到垫片的 `kabegame:wpe-volume` 消息，新增 `paused`；垫片只在值变化时调 `setPaused`，首次全量属性交付前就已暂停的，交付后补调一次 `setPaused(true)`。`SceneHost` 首次属性包到达后才加载，渲染完成后经 `wpe_scene_report` 报 `ready`，日志经同一命令进入应用日志。
  - 场景专用命令：`init_pre` 里 `add_capability` 注册 `wpe-scene-host-capability`，`remote.urls` 只有宿主 `index.html` 的确切地址（URLPattern 特殊字符逐个转义），不用路径通配；`frames: "sub"`，窗口是 main 与壁纸窗口 label 池（`wallpaper::WALLPAPER_LABELS`，每块屏一个壁纸窗口）；放行 `get_wpe_scene_postprocess`、`wpe_scene_target`（场景目录与 `sceneAssets`）和 `wpe_scene_report`（`ready` / `fallback` 以 `wpe-scene-status` 事件回到调用方窗口，带实例号；`log` 写 tracing）。

### 属性与快速路径（P3a）

WPE 改属性不整场重载：加载期把每个 `{user}` 绑定登记成「属性名 → 目标 + condition」，运行时按增量逐键写字段再调改值回调（`p3-script-REPORT.md` I3）。P3a 照这个形状做，先不碰脚本：

- **一个应用函数，两个来源**：垫片入口 `applyUserProperties(δ)` 只转调 `apply(δ)`。加载期传全集、运行时传增量，先并进累计全集（跳过 `group` / `text` / 空值，按值去重、保留 `type`，不学 WPE 的整项覆盖），再按编译期产出的 `bundle.bindings` 分成两组：**就地写**交给 `SceneRenderer.applyBindings`（写之前先问 `SceneState.needsRecompile`：打开带不支持项的 effect、切换不能就地的图层、打开没有泛光链的场景都要重编译，这时一条都不写）；只要**有任意一条重编译目标**，就带全集整场重编译（重新解析、翻译、建 GPU 场景）。
- **就地写的范围**：材质常量（`usershadervalues` 与 `constantshadervalues` 的 `{user}`）、图层 `origin` / `scale` / `angles` / `alpha` / `color` / `brightness` / `parallaxDepth`（P5a）、图层 `visible`（含条件可见）、effect `visible`、`general.bloom`、泛光参数（含级数）、`GENERAL_FIELDS` 的字段。重编译日志是 `debug`（用户不关心；看探针 `stats()` 判断是否走了快速路径）。
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
  | `usertextures` | 槽名变了就换该槽纹理 | 报 `material:usertextures`，随 W5 |

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

### 场景脚本（P3b）

`SceneHost` 在可渲染且有脚本的场景里创建一个隐藏的、同源 `about:blank` 子 frame，作为该场景全部脚本共享的 realm。同进程同线程，宿主在渲染帧里同步调用脚本；子 frame 隔开脚本修改的全局和原型，但同源同权限，**不是安全边界**。场景退回预览图时不推进脚本；属性重编译、GPU 设备重建和再恢复渲染沿用原 realm、模块实例、`shared`、计时器和 `init` 状态。

| 脚本环境 | 实际处理 |
|---|---|
| 浏览器全局 | 照常保留，`fetch`、`setTimeout`、`window`、`document`、`__TAURI_INTERNALS__` 都可见。这里只对齐语义，不是安全边界；计时请用 `engine` 的方法 |
| `console` | 改写成只有 `log`（宿主 DevTools 控制台）和 `error`（应用日志 warn）；`console.warn()` 抛 `TypeError` |
| `localStorage` | 改写成 WPE 的形状：`get` / `set` / `delete` / `clear` 加 `LOCATION_GLOBAL` / `LOCATION_SCREEN`，没有 `remove`，默认位置是屏幕 |

模块按每个场景动态生成 import map：`compile/scripts.ts` 用 `es-module-lexer` 扫描脚本里的原样说明符；宿主按 `sceneAssets` 顺序查找 WPE 的 `scripts/jsmodules/<说明符小写>.js`，递归扫描模块自身的依赖，把**原样大小写的说明符**映射到相应 `file:` 地址。扫描结果连同缺失结果按 `sceneAssets` 缓存在宿主内存；同一个文件 URL 在 realm 里只求值一次。`scripts/jsclasses/baseclasses.js` 先由 `file:` 作为经典脚本加载，提供 `Vec2` / `Vec3` 等全局词法类、`shared`、`createScriptProperties` 和 `_Internal`；每段用户源码则各自以新的 blob URL 作 ES 模块求值，源码重复也各有模块状态。模块语法错误若 rejection 没有行列，再用 `<script type="module" src=blob:>` 的 `error` 事件补位置；仍取不到时仅记录错误文本。非裸说明符在收集期记为脚本错误，变量形式的动态 `import()` 无法预先扫描。

脚本表只扫描 `scene.json`，用 JSON 坐标作稳定 id，收集 `general`、图层字段、effect 字段、pass 的 `constantshadervalues` 四种来源，并记 owner、图层、初值、值类型、`scriptproperties` 和导入。未启用的 effect 里的脚本也入表，材质 JSON 内的脚本目前不收集。`thisObject` 随 owner 分别是 general、图层、effect 或该 pass 的材质常量对象；general 脚本的 `thisLayer` 为 `null`。后者暴露该 pass 全部有 `meta.material` 的常量，没编译出的 pass 则无法写入。`thisLayer` 与 `thisScene.getLayer(数字)` 按 `scene.json` 的 `objects` 下标定位，图层 API 对象跨重编译保持身份；非图片对象当前也有通用图层项，尚无声音、文本等专用 API。

- **首次加载**：按脚本表顺序逐段求值，再按顺序更新 JSON `scriptproperties`（其中 `{user}` 已解析为当前属性值）并调用 `init(value)` 写回；首帧之前用属性全集做直接绑定、`updateScriptProperties` 与 `applyUserProperties`；首帧先推进计时器、逐段调用 `update(value)` 并写回，再同步 `SceneState` 到 GPU、渲染，最后报 `ready`。
- **属性增量**：在两帧之间按「直接绑定 → `updateScriptProperties` → `applyUserProperties(增量)`」处理，下一帧生效，`init` 不重跑。只有同时带 `type` 和 `value` 的项会传给 `applyUserProperties`；`engine.userProperties` 读累计全集。用户直接绑定覆盖旧脚本写入时撤销该目标的重放值。暂停或 `document.hidden` 时不推进帧脚本和计时器；恢复后继续。
- **返回值与写回**：`init` / `update` 的非 `null`、非 `undefined` 返回值按目标类型转换：布尔只收布尔，数字可展开为向量各分量，向量读取 `x` / `y` / `z` / `w`，角度由度转弧度；类型不符不写，字符串目标目前不写。可写图层变换、透明度、颜色、可见性、亮度、材质常量、effect `visible`、泛光开关与参数、`GENERAL_FIELDS` 的字段；`hdr` 等重编译目标仅在值变化时请求重编译。宿主用 `scriptOverrides` 按稳定路径覆盖 Worker 的编译输入，同一时刻最多一项在途，期间再变化则下一轮合并。返回值写到 `text`、`maxwidth` 等不支持目标时只对该段告警一次，不写画面；这类运行期告警不进 `unsupported`（脚本里直接访问 `thisLayer.text` 这类未实现字段，由下面的「脚本 API 检查」在编译期报）。
- **错误与保留**：模块导入或求值失败，整段不调用；回调抛错只禁用该段的这个回调，计时器抛错只取消该计时器，其余继续。单个回调超过 15 秒时，等它返回后停掉本场景全部脚本并保留已写画面；死循环仍可能卡住宿主，由既有 ping / 看门狗处理。`console.error` 每段每分钟最多向应用日志报 10 条，超出的数量随下一条可上报日志附带。跨重编译保留 realm 与脚本状态，新 `SceneState` 首帧前由 `replayWrites()` 重放脚本最后一次写入。有脚本时，所有**带材质 pass** 的图层即使初始隐藏也预建 GPU 资源，编码时仍按当前可见性跳过。

- **持久存储**：WPE `localStorage` 存在宿主 `file:` 来源的浏览器 `Storage` 里，键前缀 `kabegame:wpe-scene:ls:<图片 id>:<g|s>:`，所以场景之间、场景与网页壁纸互相看不到，但共用这个来源的配额。值按 JSON 存取，超配额抛错，由回调包装禁用那一段。`LOCATION_*` 的数值是推断的 0 / 1，脚本拿到的是不透明的值。「清空脚本存储」（只在预览的右键菜单与工具条）只清当前场景，清完重建 realm，`init` 重跑；没有宿主存活时广播没人收、不生效，所以画廊的右键菜单里没有这一项。
- **音频缓冲**：`engine.registerAudioBuffers(16 | 32 | 64)` 只能在模块顶层调，返回 `{ left, right, average }`。宿主第一次收到注册时订阅 `WpeMediaHub`，订阅方式同网页壁纸，只 Windows 有数据源；每帧原地写，脚本持有的数组不变。分辨率 n 的每段取对应 64 / n 个原始段的最大值，含义是推断。着色器的 `g_AudioSpectrum*` 随 W2 做。

**已提供的脚本 API**（以 `script/api.ts` 为准）：

| 对象 | 成员 |
|---|---|
| 全局 | `engine`、`thisScene`、`localStorage`、按当前脚本切换的 `thisLayer` / `thisObject`；`baseclasses.js` 的 `shared`、`createScriptProperties`、向量 / 矩阵类 |
| `engine` | `frametime`、`runtime`、`timeOfDay`、`canvasSize`、`screenResolution`（按显示缩放 1 算的画布像素尺寸，预览缩小显示时仍与桌面一致）、`userProperties`；`setTimeout` / `setInterval` / `clearTimeout`（按渲染帧 dt 推进）；`isRunningInEditor`、`isMobileDevice`、`isDesktopDevice`、`isWallpaper`、`isScreensaver`、`isPortrait`、`isLandscape`、`isObjectValid`；`registerAudioBuffers`、`AUDIO_RESOLUTION_16 / 32 / 64`。时序属性及计时器不能在模块求值时访问 / 登记 |
| `thisScene` | `getLayer`（名称或 `objects` 下标）、`getLayerCount`、`getLayerIndex`（名称或图层对象）、`enumerateLayers`，未命中返回 `null` / `-1`；general 的字段同下一行 |
| 图层对象 | `name`、`id`、`size`（只读写入无效）、`origin`、`scale`、`angles`、`alpha`、`color`、`visible`、`brightness`、`parallaxDepth`（`Vec2`，P5a） |
| `thisObject` 的其它 owner | general 的 `bloom`、`bloom*` 泛光参数、`GENERAL_FIELDS` 的 17 个字段（含 P5a 的 `zoom`），以及写入走重编译的 `hdr`；effect 的 `visible`；材质 pass 中全部带 `meta.material` 的常量。`fog*`、`wind*`、`gravity*` 等还没有 |

**本机语料里出现、当前未提供的 API**：运行时报错最多的是 `thisLayer.getParent` / `getChildren` / `getTextureAnimation`、声音图层 `play` / `stop` / `isPlaying`、`thisObject.getAnimation`、`input.cursorWorldPosition`、图层 `getVideoTexture`；还有 `engine.registerAsset`、`thisObject.getMaterial`。静态扫描另见 `getTransformMatrix`、`thisScene.createLayer` / `sortLayer` / `destroyLayer`、图层 `setFrame` / `getEffect` / `emitParticles` / `getAnimationLayer`、`input.cursorLeftDown`；文本字段 `text`、`maxwidth`、`horizontalalign`、`verticalalign` 及 `cursor*` / `media*Changed` 回调也未接通。语料中的 `scene.getLayer` 是样本伪代码自身的未定义变量；`localStorage.remove`、`console.warn`、`originalOrigin` 也不是应补的 WPE API。

**脚本 API 检查**（2026-11-07 用户改定，提交 `c8ebf098`，`compile/scriptApi.ts`）：改定前不做静态扫描，未实现的 API 在调用时报错、只禁用那个回调，可能画出半成品。工坊 3304642534 就是这样：可视化脚本在 `init` 里调 `thisScene.createLayer` 造另外 63 根音频条，`init` 报错被禁用，`update` 每帧抛错又被脚本自己的 `try/catch` 吞掉，画面静默缺了整组条。现在编译期扫描每段会执行的脚本，用到下表成员就报 `script:api:<分组>.<成员>`、整张退回预览图；运行期的普通错误仍只进脚本诊断。

- **表**（`MISSING_SCRIPT_API`）：WPE 2.8.42 自带的编辑器补全声明 `ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`，加逆向报告 `p3-script-REPORT.md` 的 C、L1、L14 节，逐项减去 `script/api.ts`、`script/environment.ts` 与 `baseclasses.js` 已提供的成员。**实现一个 API 就从表里删一个**：`script/api.test.ts` 双向核对表里的成员确实不在 `ScriptApi` 上、`ScriptApi` 上的成员也不在表里；`scriptApi.test.ts` 核对表里的名字都出自声明或报告（本机测试）。
- **分组**：`thisScene`、`engine`、`input`、`localStorage`、`console` 按根对象匹配；`layer`（图层及声音、文本、粒子、模型等接口）、`effect`、`object`（所有对象都有的 `getAnimation`）按类型分组，不看接收者变量。`thisObject` 按脚本挂在哪里解析：图层 → `layer`、effect → `effect`、材质常量 → 只认 `object`、general → 场景字段（键写 `thisScene.<字段>`）。
- **匹配**：词法扫描成员访问（`a.b`、`a?.b`、`a["b"]`，跳过注释、字符串和正则），不是完整解析器。`root` 项只认根对象直接访问（`play`、`stop`、`text`、`volume` 这类通用名字只认 `thisLayer.` / `thisObject.`）；`any` 项任意接收者都算，只收名字足够独特的，每项写明理由。子对象（纹理动画、视频纹理、动画层等）只能经表里的入口方法拿到，不另收。
- **范围**：只扫 `collectScripts` 收集的 scene.json 脚本；导入说明符无效、整段不会求值的不扫。场景的风、重力字段在能力表里中性，但脚本读写它们照报（脚本读到 `undefined` 会算出 NaN）。
- **3304642534**：报 `script:api:thisScene.createLayer`、`script:api:thisScene.sortLayer`，整场只剩这两项（加检查之前能渲染）。
- **导出回调**（P6 前置，2026-11-11）：WPE 按固定的 19 个回调名调脚本的导出函数（`WPE_SCRIPT_CALLBACKS`，报告 C 节），运行时只调 `init`、`update`、`applyUserProperties`、`destroy`（`script/runtime.ts` 的 `RUNTIME_CALLBACKS`）。脚本导出了其余回调（`MISSING_SCRIPT_CALLBACKS`：`cursor*` 七个、`media*Changed` 五个、`resizeScreen`、`applyGeneralSettings`、`animationEvent`）时报 `script:callback:<名>`、整张退回，否则场景会静默缺交互。导出名由 `scriptExports` 用同一套词法认出（函数、类、`const` / `let` / `var` 含解构、`export { … }`，宁可多认；`export default` 与 `export * from` 不认），2026-11-11 对语料 3491 段与 TypeScript 解析器逐段比对，导出名全部一致。实现一个回调就从表里删一个、加进 `RUNTIME_CALLBACKS`，`api.test.ts` 核对两者合起来恰好是 19 个。语料 165 张里 53 张因此多报（光标 45 张、媒体 28 张，这些场景都另有阻塞），能渲染的 36 张不变。
- **Unicode 空白**：分词时 U+00A0、U+3000、U+FEFF 等是分隔符、不进标识符。语料有脚本写成 `export` + U+00A0 + `function`（3409595232 等），以前整串被切成一个词，导出与成员访问都认不出。

本机 2026-11-04 的 38 张场景中，5 张 `unsupported` 为空、可完整渲染：beach、deep_space、eagleflag、razer_vortex、razer_bedroom；相对 P3a 新解锁的只有 razer_bedroom。23 张含脚本，共收集 638 段（另有 1 段在材质 JSON，未收集）：444 段求值与回调无报错，127 段求值失败，67 段有回调报错；123 段尝试写回不支持目标，209 段导出尚未调用的 `cursor*` / `media*` 回调。仍退回预览图的含脚本场景另有文本、着色器、声音、粒子等渲染阻塞，补 API 本身不等于解锁渲染。

**真机**（2026-11-04 Windows dev）：
- **bedroom 帧开销**：预览与壁纸窗口里 `update` 约 60 次/秒，单次最长 0.1 ms；`frameMs` 均值 0.19–0.22 ms、p95 0.4 ms。
- **与 WPE 抓帧比较**：灯带颜色与 WPE 逐位相等；整帧通道平均差 0.038/255（超高档 0.055/255），残差只在细线与边缘。
- **切「场景后处理」**：三个宿主各重载一次，用时 414–482 ms。重载后 realm 不变、`update` 计数不归零，颜色按墙钟连续、不跳回初值。
- **vortex 切模式**：就地写入，`recompiled` 为空。
- **shimmering**：`bloomstrength` 首次 apply 为 1.0，`glow` 改为 3 后为 1.5，也是就地写入。
- **暂停**：经 `wallpaperPropertyListener` 暂停后，`update` 计数与 `engine.runtime` 都冻结；恢复后接着走，不跳。
- **出错日志**：求值失败与 `init` 报错各记一条带行列的 `warn`，不重复。

宿主的「重新判定 / 重新加载 / 就地更新」是 `debug`，只进宿主自己的 DevTools 控制台，不进应用日志。窗口被完全遮挡时 Chromium 判页面为 hidden、不出帧，脚本随渲染一起停（WPE 按焦点、最大化等设置暂停，触发条件不同）。场景在建 GPU 场景时才失败而退回预览图时，脚本此前已经求值并跑过 `init`。

development 构建的 `window.__kabegameSceneProbe` 提供 `host.scripts()`（逐段状态、导出、禁用回调、错误与调用统计）、`host.read(path)`（读当前目标）、`host.realmCheck(extraSources?)`（另建 realm 检查导入、环境、错误位置与缓存），以及 `scriptCorpus(imageIds)`（逐张独立 realm、固定 dt 跑 120 帧，不建 GPU；生产构建无这些探针）。`scriptCorpus` 返回的 `remainingTestFrames` 是 `{ before, after }`，数的是 `iframe[data-kb-script-realm="1"]`，两者相等才说明没有残留子 frame。`missingApis` 是条目数组（类型、名字、场景数、段数、报错数），连带错误按属性名列出，没有归到根因。存储用临时前缀，跑完清掉，不碰真实场景存过的东西。探针也不统计重编译目标写入次数，使用作者默认属性且不派发 `cursor*` / `media*` 回调。

**已知差异与后续**：realm 无 CSP，变量形式的动态 `import()` 仍可能加载远程模块；API 对象可加任意属性，写入未提供字段可能读回成功但画面无变化；回调里排的微任务（Promise）时机不同：WPE 推断在每个最外层回调返回后冲刷，我们要到本帧任务结束才跑（本机样本没用 Promise）；`thisObject.constructor.name` 我们是 `Object`，WPE 是空串，`String(thisObject)` 两边都是 `[object Object]`。不清屏的场景暂停时改属性，补画的那一帧会推进累加链（回归 D46，用户定为不动）。HDR 不清屏累加时，分界线上有约 1 像素宽的残余差异（回归 D37），推断是 FP16 舍入，没有抓帧证实。单层 mip 纹理的差异和非整数 `size` 的四边形（WPE 截断）没有处理，见 3c 计划「后续」。后续按渲染能力阶段补音频、层级、输入、纹理动画、声音和文本 API，并处理材质 JSON 脚本。当前有意不照搬 WPE 两个缺陷：属性增量不会从 `engine.userProperties` 的已有全集中丢键（未实现的 WPE 内置伪属性本来就不注入）；CLI 颜色改值也不降成字符串。

## 层级（P4a）

图层有了父子关系。层级只改矩阵与可见性，不碰渲染图，图像层与粒子共用。依据是 P4a 步骤 0 的实测（工程 `ignore/p4/proj/p4a`，抓帧 `A:\p4a\`，[p4-particles-REPORT](../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4a 语义的实测核对」）。

| 项 | 规则 | 依据 |
|---|---|---|
| 父对象 | `parent` 是父对象的 `id`，编译期换成 `objects` 下标（`compile/hierarchy.ts` 的 `resolveParents`，存进 `SceneLayer.parent`）；不是有限数字、找不到或指向自己时当根节点；`id` 重复取第一个 | 找不到当根：实测；重复 `id`：没测 |
| 世界矩阵 | `W = W_parent · T(origin) · Rz·Ry·Rx · S(scale)`，角度是弧度（`render/layout.ts` 的 `layerLocalMatrix` / `worldMatrixOf`）；惰性沿父链算，子在父前也成立；`scale.z` 为 0 时按 1（这一条没测） | 实测：5 个图层（三轴旋转、非均匀缩放、三层父链）四角对 RenderDoc 最大差 6.1e-5 像素 |
| 可见性 | `visible` 沿父链继承，自身和所有祖先都可见才画（`effectiveVisible`）；颜色组 `alpha`、`color`、`brightness` 不继承 | 实测：父 alpha 0.25 时子仍是 1；不可见分组下的子层不绘制 |
| 绘制顺序 | 仍是 `objects` 数组顺序，与父子先后无关 | 实测 |
| 分组节点 | 没有 image / model / particle / sound / text / light 的对象。WPE 把它建成只有变换的基类对象，不绘制；不再报 `object:empty`，它上面的 `effects` 不读、不报 | 实测（不绘制）+ 读码 |

- **父链脏传播**：`SceneState` 写 `origin`、`angles`、`scale`、`visible` 时，自身和全部子孙一起标脏；`alpha`、`color`、`brightness` 只标自己。世界矩阵的缓存不进 `SceneState`，每次建场景、每次 `sync` 各建一份，状态变了不会读到旧值。
- **建资源**（`render/scene.ts` 的 `buildableLayers`）：自身和每个祖先都「可能可见」（当前可见、`visible` 绑了属性，或场景带脚本）才建 GPU 资源，`checkRenderable` 同一口径。写死不可见的分组下面的子孙永远画不出来，不建资源，它们的问题也不让整场退回。`visibleObjects` 用继承后的可见性。
- **成环**：WPE 的递归不防环，这种输入本来不该有。从下标小的对象开始走，断掉指回本轮走过节点的那条边，报 `object:parent-cycle`、整张退回；渲染侧沿父链走时另按走过的节点兜底，不会死循环。
- **灯的例外**：灯带有效父对象时仍报 `object:parent`：`lights.ts` 用的是本地 `origin`，灯挂在父链下的位置没和 WPE 比过。本机是 `3453730450`、`3706286085`。
- **语料**（149 个工程，Node 侧编译）：66 张变化，只去掉 `object:parent` 27 张、只去掉 `object:empty` 10 张、两者都去掉 29 张，没有新增项；单靠层级没有新解锁的场景。`angles` 的 x、y 非 0 的图像层在 9 张场景里（1923929928、3219908811、3308867900、3453730450、3462279189、3516174947、3600630828、3823859141、3823864170），都还有别的不支持项，等它们解锁时再和 WPE 比画面。
- **回归**：10 张能渲染的场景 × 三档后处理，30 组画面哈希、显存统计与改动前相同。

## 粒子（P4a）

粒子对象是一种图层，和图像层共用 `objects` 顺序。三层按「谁碰 GPU」划分：

- **编译期**把粒子 JSON 解析成纯数据，放进 `layer.particle`，不碰 GPU；
- **模拟器** `apps/wpe-scene/src/particles/` 是纯 TS，只用 TypedArray，能单测，也能脱离渲染器直接和 WPE 的轨迹比；
- **渲染层**把列写成顶点，粒子是图层计划里的一种步骤。

模拟放在宿主主线程同步跑，脚本与属性写入同一帧生效（与 3b 脚本同步运行的决定一致）。P4a 覆盖档 1：12 个模块加 `sprite`、透视粒子、`starttime` 预热、`instanceoverride`；其余模块按 P4b–P4f 补，见[总计划](../../.claude/plans/wpe-import/3-scene/phase4/phase-4-particles.md)「范围与覆盖」。

证据等级照[报告](../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)：**实测**是 RenderDoc 抓帧或 WPE 日志读到的值，**读码**是逆向 WPE 2.8.42（`wallpaper64.exe` SHA-256 前缀 `40e2ce02`）读到的代码；linux-wallpaperengine 不作证据。粒子带随机，真实样本只比统计量；逐帧、逐像素对比用把随机范围收成 min = max 的确定性工程。

### 编译

- **模块表是唯一事实来源**（`particles/modules.ts` 的 `PARTICLE_MODULES`）：每个模块一条记录，含字段表（形状、正交 / 透视两套缺省值、本节支持的取值、乘哪一项 `instanceoverride`）、用到的列与列标志、执行函数 `run`。解析（`compile/particles.ts`）、能力表（`features.ts` 的 `checkParticleFeatures`）和模拟器分发读同一张表，能力表不会和实现漂移。
- **档 1**：emitter `sphererandom`；initializer `lifetimerandom`、`sizerandom`、`velocityrandom`、`colorrandom`、`rotationrandom`、`angularvelocityrandom`；operator `movement`、`angularmovement`、`alphafade`、`oscillateposition`、`oscillatealpha`；renderer `sprite`（P4a 只认 `orientation: "screen"`；P4c 起 `upright` / `fixed`、`axis`、`flags` 都支持，另加 `spritetrail`，见「粒子（P4c）」）。
- **`layer.particle`**（`SceneParticle`）：`maxcount`、`starttime`、系统 `flags`、按 JSON 顺序的 emitter / initializer / operator（不排序）、renderer、`instanceoverride` 的值，以及粒子材质的 `passes`（不进 `layer.passes`）。`renderer` 缺键或不是数组时补一个 `sprite`，写成 `[]` 不补（读码：WPE 只在不是数组时补）。
- **两套缺省值**（读码）：`general.orthogonalprojection` 是对象，且 `auto: true` 或宽高都非 0 才算正交（`isOrthographic`），字段缺省值按它选。
- **`TEX0FORMAT`**：粒子材质经 `ShaderCompiler` 的 `defines` 参数写，并进缓存键；图层材质的缓存键逐字不变。P4a 时无条件写；P4b 起照 WPE 只在槽 0 纹理是格式 8–11 时写，格式 0、4 时着色器分支相同、画面不变。P4c 起非厚格式的 `sprite` 只要朝向不是 `screen`，对任何格式都写（汇编 `0x1401d3189`），对 `genericparticle` 不影响画面；厚格式（帧表、拖尾）仍只在格式 8–11 时写。
- **`PARTICLE_UNIFORMS`**：`g_OrientationUp/Right/Forward`、`g_ViewUp/Right`、`g_RenderVar0/1`。粒子 pass 的程序检查把它们当引擎 uniform，渲染器在粒子 draw 里写（`render/uniforms.ts` 的 `particleBuiltins`，单测核对两边一致），图层材质里照报 `uniform:*`。
- **COMBO**：粒子材质放行 `WORLDBLUR`、`USERCOLORBLEND`（`shimmering_particles` 自带 `particle` 着色器的分支），P4b 起另放行 `REFRACT`、`CUTOUT`、`NORMALMAP`（见「粒子（P4b）」）。着色器注解的缺省值不算：`genericparticle` 的 `FOG` 缺省 1，只在引擎宏 `FOG_DIST` / `FOG_HEIGHT` 下起作用，渲染器不定义它们。

**能力键**（`features.ts` 的 `checkParticleFeatures` / `checkParticleProgram` / `checkParticleInstance` / `checkObjectFeatures`，模块部分从模块表生成；值为 null 的键当缺键）：

| 键的形态 | 何时报 |
|---|---|
| `particle:<类别>:<名字>` | 表外模块，例如 `particle:renderer:rope`、`particle:initializer:mapsequencearoundcontrolpoint`（P4c 收尾时；`spritetrail`、`controlpointattract` 在 P4c 进表） |
| `particle:<类别>:<名字>:<字段>` | 表内模块的未知字段、形状不对或本节不支持的取值，例如 `particle:emitter:sphererandom:audioprocessingbounds`（P4e）；P4a 时的 `particle:renderer:sprite:orientation` 在 P4c 去掉 |
| `particle:binding:<类别>:<名字>:<字段>`、`particle:binding:system:<键>` | 模块字段、系统级键写成 `{user}` / `{script}` |
| `particle:system:<键>` | 系统级未知键；`emitter` / `initializer` / `operator` 不是数组 |
| `particle:flags:<位值>` | 系统 `flags` bit8 起的高位；bit0–7 支持（bit1 关混帧，P4b 起；bit0 世界空间，P4c 起，原先报 `particle:flags:world`） |
| `particle:children` | 子系统（P4e）。P4a、P4b 时控制点有实际内容报 `particle:controlpoint`，P4c 起控制点全部支持或中性，不再报 |
| `particle:renderers` | 多于一个 renderer（P4c 起仍报，理由见「粒子（P4c）」的「拖尾与 `sprite` 朝向」；P4a 时帧表的 `particle:animationmode`、`particle:sequencemultiplier` 也在这一行，P4b 起支持） |
| `particle:combo:<名字>`、`particle:lighting`、`particle:effects` | 粒子材质放行范围以外的 COMBO（如 `SPECULARMAP`、`DOUBLESIDEDLIGHTING`）；开了光照；带 `effects` 的粒子对象（本机 0 个） |
| `particle:object:<键>` | 粒子对象上的 `alpha` / `color` / `brightness` 取非默认值或绑了属性 / 脚本（WPE 怎么用没测，语料 0 张） |
| `particle:instance:<键>`、`particle:binding:instance:<键>` | `instanceoverride` 的 HDR 下非默认的 `brightness` 与未知键；`color` 绑了属性（`particle:instance:color:user`）、`colorn` 带条件（`particle:instance:colorn:condition`）、`controlpoint*` 绑了属性（`particle:instance:controlpoint:user`）；挂了 `{script}`（P4f）。`colorn` 本身 P4b 起支持；`controlpoint*` 的静态值 P4c 起支持（原先整个报 `particle:instance:controlpoint`） |
| `particle:parse:<文件>` | 粒子 JSON 读不出来 |

模块字段写成关键帧报 `value:animation`（见「能力表」）。P4a 收尾时，语料（149 个工程）里挡住场景最多的粒子键：`controlpoint` 48 张、`turbulentvelocityrandom` 41、`animationmode` 38、`boxrandom` 37、`sizechange` 34、`sequencemultiplier` 34、`children` 31、`alpharandom` 31。粒子材质与纹理第一次进编译，在带粒子的场景上另带出 `tex:animation`（49 张）、`tex:alpha-priority`、`tex:format`、深度等非粒子键。

### 模拟器（`particles/`）

照 WPE 的形状写，不照 linux-wallpaperengine：LWE 在列、`R`、模块顺序、重置这几处都不同。

| 项 | 做法 | 依据 |
|---|---|---|
| 列（`columns.ts`） | 一块 `Float32Array`：基础 17 列（age、life、frame、size、size0、旋转 x、位置、速度、颜色与 alpha 初始值、`R`）加 5 组按标志开关的列（旋转 yz、角速度、上一步位置、颜色当前值、alpha 当前值）；没开的别名到同一列或初始值列，所以没有 bit3 时「重置颜色」是空操作。容量 `maxcount` 向上取到 4 的倍数，`life == 0` 是空槽 | 读码；顶点布局实测 |
| 共用 `R` | 每粒子一列随机数，`oscillate*` 的频率、相位、幅度都由它现算，没有逐粒子的模块状态 | 读码；`oscillateposition` 的 y 偏移实测 |
| 随机数（`random.ts`） | 可设种子的 mulberry32，不复刻 MT19937（WPE 按时间做种，本来不可复现）；保持两个区间 `[0, 1)`、`[1e-5, 1)` 与各模块的抽取顺序 | 读码 |
| 模块顺序 | emitter、initializer、operator 都按 JSON 数组顺序，不排序 | 实测 |
| 帧内顺序（`system.ts` 的 `ParticleSystem.step`） | 年龄增长与判死（`life < age`，严格大于）→ 按 emitter 发射、新粒子填编号最小的空槽、跑 initializer（当帧 `age = 0`，走完整个 dt）→ operator 一或两遍，每遍开头把 `size`、`rgb`、`a` 重置为初始值，乘性模块跑两遍结果不变。P4b 起判死之后先算帧表的 frame 列，P4c 起发射之前更新控制点、全部 operator 之后 `previous ← current`（见「粒子（P4c）」） | 新粒子首帧实测；全序读码 |
| dt | 当帧 `g_Frametime` × `instanceoverride.rate`（下限 0.01），粒子路径不另钳 | 实测 |
| 两遍模式 | WPE 设置 `fps` 在 1–20 时 operator 每帧跑两遍（`h = dt/2`），否则一遍；我们接宿主帧上限 `maxFps`（`particlePasses`，缺省 60，所以一遍）。发射用完整 dt | 实测（fps 5–20 与 21–60 两组） |
| float32 | 列是 `Float32Array`，累加全用 `Math.fround`（`f32.ts`） | 预热步数的实测证明需要 |
| 预热 | 加载时一次跑完 `while (t < starttime)`：步长 `maxcount < 500` 时 0.05、否则 0.2；**固定一遍**；步数按 float32 累加（`starttime 2.5`、步长 0.05 是 51 步，不是 50）；步长不乘 `rate` | 步长、遍数、步数实测。读码曾以为预热也受 `fps` 分支影响，被实测推翻；`rate ≠ 1` 的预热没测 |
| 发射欠账 | 按帧成批，同帧新粒子位置相同；数量 `rate·dt + 累积余数`，受容量限制。`instantaneous` 从累积余数里扣，之后要还债 | 实测：突发 3 个后停 `(1 + 3) / rate` 秒 |
| `instanceoverride` 静态值 | 构造时按基值乘进模块字段（`resolveParticleFields`），预热也用乘过的值；系统 `flags` bit4–7 禁用对应项 | 字段与倍数实测；预热用乘过的值没测 |

几处公式和直觉不同（详见 `rea-p4a.md`）：

- `movement` 是半隐式欧拉，drag 的 `k0 = pow(min(1, 0.025 / dt), 0.7)·dt`，每遍 `v *= 1 − min(drag·k, 0.99999988)`。实测。
- `oscillateposition` 的 ω 就是 `frequency`，不乘 2π；y 比 x、z 多 `2π·R` 的时间偏移。实测。
- `sphererandom` 的距离用 `|p|` 不是 `r`；`colorrandom` 三通道共用一个 t；`velocityrandom` 三轴独立，抽取顺序 z、y、x；`oscillatealpha` 的幅度里多乘一次 `R`。读码。
- WPE 的 `rcpps` 近似倒数不复刻，alpha 因此差约 2.4e-4。

**验收**（回放 WPE 日志的 dt，限 1e-3，坐标过 1000 时 2e-3）：档 1 全部系统在限内，`burst` 1.1e-3，其余 ≤ 9.2e-4；尺寸、颜色、旋转差 0，alpha ≤ 2.4e-4，粒子数逐帧一致。坐标约 1.1e4 的预热样本差到 9.8e-3，判定为输入精度：这个坐标上 float32 一个 ulp 是 9.8e-4，dt 在日志精度内扰动后能得到逐位相同的结果。dt 要用日志的累计时间差分，逐帧累加日志的 dt 列会超限。变异检查：改掉帧内顺序、`R` 共用、`Math.fround`、两遍判断、预热遍数等，各有用例失败。

### 绘制

- **`ParticleStep`**（`render/graph.ts`）：粒子层按 `objects` 顺序和图像层混排，在同一个场景 render pass 里直接画到场景目标；泛光、双缓冲不清屏照走现有路径。`g_ModelViewProjectionMatrix` = 视图投影 × 对象世界矩阵（粒子位置在对象空间）；P4c 起世界空间系统的模型矩阵是单位阵（见「粒子（P4c）」）。
- **顶点**（`particles/vertices.ts` 的 `writeVertices`）：WebGPU 没有几何着色器，每粒子 4 个顶点、6 个索引（`0 1 2 0 2 3`），角点 UV 依次 (0,0)、(0,1)、(1,1)、(1,0)。按槽序写、跳过 `life == 0`，不按年龄排；尺寸、颜色、alpha 取当前值。P4c 起拖尾系统另跳过退化的粒子（`trailDrawable`）。
  - 输入：`a_Position`（位置）、`a_TexCoordVec4`（u、v、旋转 z、尺寸）、`a_TexCoordC2`（旋转 x、y）、`a_Color`（rgba）。
  - 偏移按翻译器反射的 `attributes` 经 `vertexPacking` 排，不写死；现在的顺序是位置、`a_TexCoordVec4`、颜色、`a_TexCoordC2`，步长 52，与 WPE 项目自定义 `particle` 的实测步长相同。认不得的输入报 `render:particle-attribute:<名字>`。
- **缓冲**：每层一个顶点缓冲（按容量建）、全场一份索引缓冲；`encode` 里只传存活的那部分再 `drawIndexed`。步进 P4a、P4b 在 `GpuScene.update` 里，P4c 步骤 4 起挪到 `GpuScene.stepParticles`，由渲染器在脚本之前调用（见「粒子（P4c）」的「世界空间与帧顺序」）。
- **透视粒子**（系统 `flags & 4`，`layout.ts` 的 `particleViewProjection`）：相机在 `(w/2, h/2, d)` 看向 −z、上方 +y，`d = (h/2) / tan(fov/2)`，fov 取 `perspectiveoverridefov`（缺省 95°），所以 z = 0 平面和正交画面重合，+z 朝向相机；反向 Z，near 5、far `max(15000, d + 1000)`。实测：fov 95 / 60、z = 0 / 300 四角最大差 1.7e-4 像素，`w` 逐位一致。
- **正交深度 ±2000**：`ORTHO_DEPTH` 从 10000 改成 2000，深度 = `0.00025·z + 0.5`（反向 Z），图像层与正交粒子相同，与 WPE 抓帧读到的 MVP 一致；|z| > 2000 被裁掉，WPE 同样。
- **帧时钟**（`render/clock.ts` 的 `FrameClock`）：帧时间钳到 `[0.0001, 0.25]`，`g_Time` 累加钳后的值，脚本的 `engine.runtime` / `engine.frametime` 用同一时钟；补画帧的帧时间为 0，粒子不步进。实测：WPE 在 `fps=5` 启动时连续三帧恰好 0.25。LWE 的 `min(dt, 0.1)` 在 WPE 里不存在。这条改了全部场景的时钟，只在单帧超过 0.25 s 时有差别。
- **粒子 uniform**：P4a、P4b 时朝向写死单位基（P4a 实测的工程里 WPE 写的就是单位基；P4c 补测确认对象带 x / y 旋转时不是）；`g_ViewUp` / `g_ViewRight` / `g_RenderVar0/1` 档 1 的两个着色器都不读（抓帧里 `referenced: false`），照语义给，`g_RenderVar*` 写 0。P4b 起帧表系统写 `g_RenderVar1`，折射着色器读视图轴，实测值与 WPE 相同（见「粒子（P4b）」）。P4c 起朝向按 renderer 与绘制用的模型矩阵在 CPU 上现算，拖尾系统写 `g_RenderVar0 = (length, maxlength, minlength, 0)`，其余系统仍写 0（见「粒子（P4c）」）。
- **验收**（风险 7：WPE 的内置 `genericparticle` 走 `PointList` + 几何着色器，我们走顶点展开）：我们翻译出的顶点路径对 WPE 的 `gs_out` / `vs_out`，含三轴旋转（`rot-gs`、`rot-vs`），一帧四角逐位相同，另一帧最大差 5.7e-5 像素。整帧像素（回放 WPE 日志的 dt）：WPE 有内容的 6382 个像素里 6214 个逐字节相同，`util/white` 自然得到 249/255（mip 1–3 是 252，RGB 与 alpha 各乘一次）；其余全在 `capvelocity` 的两行（当时没实现，P4b 步骤 3 补上）。

### `instanceoverride` 就地生效

- **绑定**：`alpha`、`size`、`count`、`speed`、`lifetime`、`rate`、`brightness`（`INSTANCE_FIELDS`）的 `{user}` 登记成就地目标 `{ kind: "particle-instance", object, field }`（`compile/bindings.ts`）；值存在 `SceneState.particleInstances`，`GpuScene.sync` 交给 `ParticleSystem.setInstance`，下一帧生效。
- **从基值重新乘，不累乘**：存活粒子保留出生时的 life、颜色、尺寸、alpha；`size`、`lifetime`、`alpha`、发射速度只影响之后出生的；`rate`、`count` 以及 `speed` 乘的 operator 字段（重力、角力、振荡频率）下一帧就用新值；已结束、新 `rate > 0` 的 emitter 重新打开。实测（`p4a-life`）：已有 54 个仍是旧尺寸、alpha 与出生时的速度，新的 10 个用新值，`rate` 立刻作用于全部粒子。WPE 同样不清粒子。
- **`brightness`**：只在场景 HDR 且系统 `flags` 没有 bit3 时生效（乘实例颜色，没实现）。这时绑定登记成重编译，取非默认值报 `particle:instance:brightness`；LDR 或有 bit3 时中性，照常就地。
- **`colorn` / `color`**：P4b 起实现，就地生效，见「粒子（P4b）」的「`instanceoverride.colorn`」。
- **控制点**：`controlpoint0..7`、`controlpointangle0..7` 的静态值 P4c 起支持，只在建系统时生效（见「粒子（P4c）」的「控制点」）；绑了属性报 `particle:instance:controlpoint:user`（运行时改值没做，语料 0 处）。P4a 时整个报 `particle:instance:controlpoint`。
- **报不支持的**：挂 `{script}` 报 `particle:binding:instance:<键>`（P4f）。
- **整场重编译时粒子重来，含预热**。重编译只有 `general.hdr`、`colorBlendMode`、`size` 三种原因，都很少见。
- **真机**：`shimmering_particles` 改 `count`、`glow`、`style` 各一次，`applied` 0 → 3，`recompiled` 0。

### 生命周期

| 情形 | 行为 | 依据 |
|---|---|---|
| 不可见（含祖先） | 不发射、不步进；还有存活粒子就清空，并复位 emitter 计时（`ParticleSystem.suspend`） | 实测（`p4a-life`：隐藏前 42 个，重新显示约 3 秒后只有 7 个新粒子、间隔 0.5） |
| 重新可见 | 照常发射，**不重新预热** | 同上：重新预热的话会立刻有 20 个 |
| 暂停、`document.hidden` | 时钟冻结，不步进；补画帧也不步进 | 实测：WPE 暂停期间 `g_Time` 不前进 |
| 切换壁纸、整场重编译、卸载 | 粒子缓冲随 `GpuScene` 释放；新场景重新建模拟器并预热 | — |

### 性能

- **真机帧时间**（600 帧）：`shimmering_particles`、`3062029089`、`3304642534` 均值都是 3.2–3.4 ms；每个粒子层模拟加写顶点约 0.1 ms。
- **主线程预算**：Node 实测每个存活粒子每帧约 1 µs 模拟、0.12 µs 写顶点，60 fps 下约 1.5 万个存活粒子。
- **P4a 不设 `maxcount` 上限**：语料最大的 10 万（`3173418061`、`3351163962`）、62.5 万（`2582765611`）都还有别的不支持项挡着，到它们快解锁时再定：设上限，或把模拟挪进 Worker / GPU。
- **预热开销**：`shimmering_particles` 的 3 个 `small_motes` 各预热 200 秒，加载时主线程约 1 秒；默认样式下它们不可见，第一帧就被清空。

### 解锁

- **`shimmering_particles`**：没有不支持项；`dust motes` 200 个，尺寸 43–996（WPE 200 个、40–999），位置、alpha 范围相近；3 个 `small_motes` 被 `style` 隐藏，WPE 同样只画一个系统。
- **工坊 `3062029089`**：没有不支持项；雪 600 帧均值 333 个（WPE 344，容量 360），尺寸 1.02–14.97（WPE 1.02–14.88）。
- **工坊 `3304642534`**：`alphawriting` 修正后能力表一度为空、静态画面和 WPE 一致，但音频条不动（原因见「场景脚本（P3b）」的「脚本 API 检查」）。现在报 `script:api:thisScene.createLayer`、`script:api:thisScene.sortLayer`，仍退回预览图。
- **基线**：10 张原本能渲染的场景 × 三档后处理，30 组画面哈希每一步都与 P4a 之前相同（含 `ORTHO_DEPTH` 与帧时钟的改动）。

### dev 探针与对比台

development 构建的 `window.__kabegameSceneProbe`：

| 探针 | 作用 |
|---|---|
| `particleTrack({ projectDir, sceneAssets, dts, frames, passes, seed? })` | 编译后按给定 dt 序列步进模拟器，输出和 RenderDoc 轨迹同格式的数据，交给 `cmp_track.py` 比 |
| `renderFrame({ …, particles: { dts, seed?, passes? } })` | 建场景（含预热）后按 dt 序列确定性回放再读回；种子缺省 1，第 i 个粒子层用 `seed + i`；可逐帧给指针（`pointers` 连同抓帧窗口 `window`，按 `fill` 推出控制点光标，P5a 收尾，`particleCorners` 同样收，`particleTrack` 的 `cursors` 也带 `window`）。带 `profile` 时另给每个粒子层的模拟 / 写顶点 / 上传开销（`particleMs`） |
| `particleCorners` | 把翻译后的粒子顶点 WGSL 改写成计算着色器，读回我们实际算出的每粒子四角裁剪坐标，和 WPE 的 `gs_out` / `vs_out` 比 |
| `host.particles({ profile? })` | 当前场景的粒子数与分布、开销记录（`profile: true` 开始、`false` 停止）、当前 `instanceoverride` |

对比工具是 `kbp-tools` skill（`.claude/skills/kbp-tools/`，入口 `kbp.py`：`kbp gen` 生成确定性工程、`kbp rdc track` 从抓帧提取轨迹、`kbp replay` / `regress` 按 WPE 时间线回放对照、`kbp cmp` 比较、`kbp sample` 采样），数据在 `ignore/p4/`（不入库：工程 `proj/`、轨迹 `tracks/`、日志 `out/`、回放案例 `cases/`；P4a 各步骤原来的脚本与验收在 `step1/`–`step5/`，照旧能跑）。P4a 逐帧比较的长程阈值：位置 0.5 场景像素、尺寸 0、透明度 0.004。抓 WPE 帧用 `wpe-renderdoc` MCP（`.claude/mcps/wpe-renderdoc/`，用法见 `wpe-renderdoc` skill）：`capture_wallpaper` 一步开窗抓帧并在本会话回放进程里打开，`capture_sweep` 抓一组工程 × 设置；P4a 的真值在 `A:\p4-0\`、`A:\p4a\`，对齐用脚本帧号 = RenderDoc 帧号 + 1。驱动 Kabegame（渲染、粒子轨迹与四角、画面哈希、导入测试工程）用 `kabegame-dev` MCP。产品单测用的夹具与常量表的生成脚本在 `apps/wpe-scene/scripts/fixtures/`。

## 粒子（P4b）

P4b 在 P4a 的底座上沿三条线扩展，底座的形状不变：
- 纹理格式：全局放开，图像层也受益；
- 粒子帧表与档 2 模块：照 P4a 的模块表加记录，能力表跟着少报；
- `genericparticle` 自带的折射与裁切分支。

另把 P4a 留下的 `instanceoverride.colorn` 做完。

依据：
- 步骤 0 的读码：[rea-p4b-modules](../../.claude/plans/wpe-import/3-scene/phase4/rea-p4b-modules.md)、[rea-p4b-render](../../.claude/plans/wpe-import/3-scene/phase4/rea-p4b-render.md)；
- 确定性工程的实测：[报告](../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4b 语义的实测核对」；
- 逐步的验收数据：[子计划](../../.claude/plans/wpe-import/3-scene/phase4/phase-4b-tier2.md)「实施记录」。

验收照 P4a：随机范围收成 min = max，按 WPE 日志的 dt 回放，逐粒子、逐像素和 RenderDoc 抓帧比。

**近似倒数不复刻**：WPE 在 `rcp` / `rsqrt` 的位置用 `rcpps` / `rsqrtps`，结果随 CPU 厂商不同。我们按精确值算，`particles/f32.ts` 的 `rcp`、`rsqrt` 只用来标出这些位置。验收时把它们换成乘 (1 ± 3.7e-4) 的版本，算出误差包络加到限值上；按帧数累积的（`vortex` 每帧一次 `rsqrt`）也照此放宽。

### 纹理格式

| 项 | 规则 | 依据 |
|---|---|---|
| 支持的格式 | `compile/tex.ts` 的 `TEXTURE_FORMATS` 是唯一来源，编译期、渲染器、能力表都读它。<br>- 格式：0 RGBA8888、4 DXT5、6 DXT3（`bc2`）、7 DXT1（`bc1`）、8 RG88（`rg8unorm`）、9 R8（`r8unorm`），都不是 sRGB；<br>- 不在表里的报 `tex:format:<n>`；<br>- FreeImage 形态仍只收格式 0 | 读码：`.tex` 枚举直接查表转 DXGI，加载时不转通道 |
| 单、双通道 | 原样上传，不做 CPU 转换。D3D 与 WebGPU 采样单、双通道纹理时，缺的通道都补 0、alpha 补 1。通道换算由着色器按 `TEX<n>FORMAT` 做，翻译器只给声明了 `formatcombo` 的槽位写这个宏 | 实测：R8、RG88、DXT3 的图像层与粒子逐像素相同；DXT1 粒子、R8 / RG88 图像层个别像素差 1 个色阶 |
| alpha-priority | 头标志 `0x80000` 中性，不再报 `tex:alpha-priority` | 实测 0 个像素不同 |
| NPOT | `g_Texture0Resolution = (纹理宽, 纹理高, 图像宽, 图像高)`；粒子四角 UV 固定 0 / 1，填充区会被采到 | 读码；实测 NPOT 粒子 0 个像素不同 |
| 粒子 `TEX0FORMAT` | 只在槽 0 是格式 8–11 时写（`particleWritesTex0Format`） | 读码 |

顺带修了两处取值，各自有专门的说明：
- 翻译器按材质键拆分两阶段同名 uniform。起因是 `foliagesway` 的顶点 `g_Speed` 与片元 `g_Speed` 绑的是不同的材质键。见 [wpesl2wgsl README](../../src-tauri/wpesl2wgsl/README.md)「两阶段同名 uniform」。
- 材质常量的取值对齐 WPE 的 setter，见上「渲染器」的「材质常量的取值照 WPE」。

### 帧表

| 项 | 规则 | 依据 |
|---|---|---|
| TEXS 解析 | 每帧 32 字节的矩形与时长进 bundle（`TexFrame`）。v1 坐标按 i32 读，v2 / v3 按 f32 读，都按所在图像的第 0 级 mip 归一化 | 读码 |
| 帧表语义只看槽 0 | 材质槽 0 的纹理带帧表时（WPE 的系统标志 `0x1000000`），模拟器维护 frame 列，顶点写 `a_TexCoordVec4C1`（`SceneParticle.spriteSheet`）。其它槽位的帧表纹理（如帧表法线图）当普通纹理，片元用同一个帧内 UV 采它 | 读码；`p4b-refract2` 实测 |
| 宏 | `particleSheetDefines` 写下面三个宏，值为 0 也写键：<br>- `SPRITESHEET` 一定伴随 `THICKFORMAT`；<br>- `SPRITESHEETBLEND` = 系统 `flags` 没有 bit1，且不是 `randomframe`；<br>- `SPRITESHEETBLENDNPOT` 只比宽度（图像宽 < 纹理宽） | 读码 + 实测 |
| `g_RenderVar1` | 只用第 0 帧：`(帧宽 / 纹理宽, 帧高 / 纹理高, 帧数, (纹理高 / 纹理宽) · (帧高 / 帧宽))`（`particleBuiltins(sheet)`） | 读码 + 抓帧常量 |
| frame 列 | 放在判死之后、发射之前算：<br>- `sequence`：`rcp(life)·age·sequencemultiplier` 的原值，大于 1 不回绕，小数部分由着色器取；<br>- `randomframe`：出生时写 `R`，之后不变，不混帧 | 实测：frame 相对差 2.4e-4，是 WPE `rcpps` 的固定偏差；注入 WPE 的 `R` 后逐位相同 |
| 顶点 | `a_TexCoordVec4C1 = (速度 xyz, frame 原值)`，偏移仍按反射布局排 | 读码 + 抓帧 |
| 不支持 | 一张纹理有多个图像报 `tex:animation:multi-image`，没有帧报 `tex:animation:empty`；图像层与 effect 材质的帧表纹理照报 `tex:animation`（图像层帧动画属 P6） | — |

### 发射时序与档 2 模块

模块全部照 P4a 的模块表加记录（字段表、两套缺省值、列、列标志、执行函数），能力表从表生成。

- **发射**：在 `particles/emitters.ts`，`sphererandom` 与 `boxrandom` 共用 `EMITTER_FIELDS`。
  - `duration`、`delay`。
  - emitter `flags` bit1：每帧至多 1 个，`instantaneous` 的欠账照样要还。
  - bit2 周期发射：两态计时，时长从流 A 抽，不补零头；满容量或 `delay > 0` 时整段跳过、计时冻结。
  - `instantaneous` 不乘 `instanceoverride.count`；`maxtoemitperperiod` 乘完再截断。
  - 实测：每帧的粒子数和出生帧都和 WPE 逐个对上。
- **`boxrandom`**：
  - 位置、速度都按 z、y、x 的顺序抽；
  - `distancemin` / `distancemax` 是向量，只收字符串；
  - `distancemin` 非 0 时，粒子只落在盒子四角的块里（实测）。
- **档 2 模块**：
  - initializer `alpharandom`：写 alpha 初值列。
  - operator `sizechange`、`alphachange`、`colorchange`：按生命比例插值，`minps` / `maxps` 遇到 NaN 的行为照 WPE；`colorchange` 的两端是 0–1 的倍数。
  - `sizechange` 的两端乘 `instanceoverride.size`。和 `sizerandom` 同时存在时，尺寸按 `size²` 变（实测）。
  - `oscillatesize`：幅度也乘 `R`。
  - `vortex`：乘 `k`；中心是控制点平移加 `offset`，`offset` 不旋转；`flags` bit0 是圆柱。
  - `capvelocity`：截后速度 WPE 是 99.993（`rsqrtps`），我们是 100.000。
- **噪声类**：在 `particles/noise.ts`、`noiseTables.ts`。
  - `snoise1` / `snoise2` / `snoise3` 逐位移植 WPE 自己的实现与常量表。不能用开源版：二维噪声的梯度条件、三维噪声第 4 个角的哈希都不同。
  - 场景时间 `T` 进模拟器（`ParticleSystem.step(frameDt, time)`）：取**本帧**的 `g_Time`，舍入成 float32，不乘 `rate`。预热期 `T = 0`（实测）。
  - `turbulence` 乘 `k`，不读 `phasemin`。
  - `turbulentvelocityrandom` 用 CRT 的 `sinf` / `cosf`，没测出和 `Math.sin` 的差。
  - `positionoffsetrandom` 的 `octaves` 钳到 [1, 8]。
  - `turbulence` 用短程强制回放验收：湍流场对输入敏感，把日志里 6 位小数的 dt 扰动一下，我们自己的模拟就会发散到上百像素。所以从 WPE 抓帧的 float32 原值出发只走 4 帧，差 ≤ 3.1e-4。
- **照报**：模块上的 `audioprocessing*` 字段（P4e）。`vortex` 用非 0 控制点在 P4b 时照报，P4c 步骤 1 起支持（中心加控制点平移，见「粒子（P4c）」的「控制点」）。

### `REFRACT`、`CUTOUT`、`NORMALMAP`

数学全在 `genericparticle` 的着色器里，引擎只负责三件事。这三件都在 `p4b-refract`、`p4b-refract2` 上和 WPE 逐像素比过，差异最大 1 个色阶。

- **COMBO**：
  - `REFRACT`、`CUTOUT` 是材质写的普通 COMBO。
  - `NORMALMAP` 是采样器 COMBO：槽 1 按名字绑了纹理就定义，WPE 运行时不读注解里的 `require`。
  - `g_Texture1` 声明在 `#if REFRACT || LIGHTING` 里，所以没开折射时 `NORMALMAP` 不起作用。实测：绑与不绑法线图逐像素相同。
- **快照**：粒子层计划在本层前面放一个 `snapshot`，和 WPE「每个折射对象画之前拷一次」的时机相同。
  - WPE 的场景目标开了 MSAA，快照是 `ResolveSubresource`。轴对齐、落在整像素上的四边形覆盖率只有 0 或 1，Resolve 前后相同。
  - 存活数为 0 时 WPE 不拷，我们照拷。读快照的每一层在读之前都会自己重拷，所以画面不受影响。
- **视图轴**：正交、透视粒子都是 `g_ViewRight = (1, 0, 0)`、`g_ViewUp = (0, 1, 0)`（抓帧实测）。`g_RefractAmount`、`g_Cutout*` 是普通材质常量。

### `instanceoverride.colorn`

`colorn` 有两种作用方式，可以同时生效。实现在 `particles/colorn.ts`，依据 rea-p4b-render 7.1–7.4。

- **系统色**（`compile/particles.ts` 的 `particleColorSystem`）：加载时从粒子 JSON 原文推出。
  - 按 initializer 顺序找，后面的覆盖前面的：`colorrandom` 取 `((max − min)·0.5 + min)·0.003921569`，min、max 是 0–255 原值。
  - 一个 initializer 都没命中时，取第一个 operator `colorchange` 的 `startvalue`。
  - 都没有时是 (1, 1, 1)，`hascolor` 为假。
  - 结果经 `%.5f` 往返一次。
- **生效**：要同时满足三条：
  - `colorn` 已设（r ≥ 0）；
  - 不是三个分量都和系统色差 < 0.9/255；
  - 系统 `flags` 没有 bit3。
  - `color`（0–255）加载时 ÷255 后经 `%.5f` 往返成 `colorn`。两个键都写时取 `color`。
- **平移**：每个颜色模块的颜色加上「`colorn` 与系统色的 HSV 差」再转回 RGB。
  - 色相取模到 [0, 1)，饱和度、明度钳到 [0, 1]；`rgb2hsv` 全用 float32 除法，`hsv2rgb` 的两次 `fmod` 是双精度。
  - `colorrandom`：min、max 两端各自平移，再插值。
  - `colorchange`：`startvalue`、`endvalue` 两端各自平移。WPE 的 0xc 记录写的是 start 与 Δ；我们换两端，每帧按 `f32(end − start)` 算 Δ，结果相同。
- **实例颜色**（WPE 的系统标志 `0x200000`）：
  - 置位条件：scene.json 根的 **`version` < 5**（缺键为 0），或没有颜色模块。
  - 置位且生效时，新粒子的颜色初值是 `colorn`，颜色模块再乘到它上面。
  - 读码原以为这一位看的是设备档位，P4b 步骤 6 补读后改正。本机语料里用 `colorn` 的 60 张场景，有 29 张 `version` < 5：平移之后还要再乘一次 `colorn`。
- **运行中改值**：`colorn` 绑颜色属性时，登记成就地目标（`particle-instance`，字段 `colorn`）。改值时从基值重算，不累加、不重编译。
  - `colorrandom` 和没有颜色模块的系统，只有之后出生的粒子换色。
  - `colorchange` 是每帧跑的 operator，存活粒子下一帧就换成新渐变。
  - 实测：`p4b-colorp2` 把寿命设成 16 s，让改值前出生的粒子活到抓帧；逐槽和 WPE 相同。
- **照报**：
  - `color` 绑了属性报 `particle:instance:color:user`，`colorn` 带 `condition` 报 `particle:instance:colorn:condition`。这两种 WPE 怎么处理没读到，语料里都是 0 处。
  - 挂脚本照报 `particle:binding:instance:colorn`（P4f）；HDR 下的 `brightness` 照报。
  - 父系统不生效时子系统一律不生效。这条留给子系统（P4e）。
- **验收**：
  - 确定性工程覆盖了 `version` 3、5、缺键，以及运行中改值：逐粒子最大差 3e-8（限值 2e-6）。
  - 整帧像素只有 `colorchange` 的个别粒子差 1 个色阶，因为 WPE 算 t 时用了 `rcpps`。

### 语料与解锁

- **语料**（152 个工程）：
  - 能渲染的场景 14 → 20。
  - 带粒子的 95 张里，粒子用法完全覆盖（不报任何 `particle:*` 键）的从 5 张到 22 张。
- **新解锁**：
  - 步骤 1 的纹理格式解锁 `2854083091`、`3799426930`、`3812822229`、`3829603837`；步骤 3 解锁 `1504316159`、`3820104696`。
  - `3799426930`、`3812822229`、`3829603837` 都用 `foliagesway`，和 WPE 逐像素比只有 0.03%–0.07% 的像素差 1。修正前的 1.3%–35%，是翻译器把两阶段同名 uniform 合并造成的。
  - `2854083091` 的构图和画面与 WPE 一致。
  - `1504316159`、`3820104696` 的雾、雨线和 WPE 的统计量一致。
- **还挡得最多的粒子键**：
  - `particle:controlpoint` 48 张、`particle:children` 32、`spritetrail` 29、`controlpointattract` 28、`rope` 22、`particle:flags:world` 21，分别属 P4c–P4e（其中控制点、`spritetrail`、`controlpointattract`、世界空间在 P4c 全部去掉，见「粒子（P4c）」的「语料与解锁」）；
  - 纹理只剩 `tex:video` 35 张、`tex:animation`（图像层帧动画）14 张。
- **基线**：10 张原本能渲染的场景 × 三档后处理，共 30 组画面哈希。
  - 步骤 2–6 每一步都和前一步相同。
  - 步骤 1 补充的翻译器修正只改了 `2418800402`（凝光，自带 `foliagesway`）。按 WPE 抓帧核对，这是修正带来的。
- `1838478131` 的控制点 0 跟随指针，从 P4b 移到 P4c，已在 P4c 步骤 2 解锁。

### dev 探针与对比台的增补

| 探针 | P4b 增补 |
|---|---|
| `renderFrame` | `pointer`（`g_PointerPosition`，和 WPE 抓帧比时填抓帧里的值）；`particles.random`（按 `objects` 下标、按出生顺序顶替 `R`） |
| `particleTrack` | `times`（每帧的场景时间 `T`，回放 WPE 时填日志的累计时间）；`random` 同上 |
| `particleCorners` | 同样收 `particles.random` |

对比台仍在 `ignore/p4/`：
- `gen_b.py`：生成 P4b 的确定性工程（`p4b`、`p4b-emit`、`p4b-tex`、`p4b-refract`、`p4b-color` 等）。
- `sweep_b.py`：一次会话抓多个工程，另认 `fps,键=值` 与窗口尺寸。
- `rdc_track_b.py`：按 `kbp-meta.json` 认系统，并保存厚格式的 `TEXCOORD1`。
- 各步骤的验收脚本在 `b1/`–`b6/`、`b2v/`–`b5v/`，WPE 参照在 `A:\p4b\`。

## 粒子（P4c）

P4a、P4b 的粒子系统是封闭的：控制点 0 当单位阵，粒子都在对象本地空间，绘制时乘对象的世界矩阵。P4c 给它接上外部输入，底座的形状不变：
- 控制点：成为系统的一份状态，读控制点的模块经执行上下文取值；指针是控制点的一种输入。
- `controlpointattract`：一个普通的 operator，按到控制点的距离改速度。
- 世界空间：坐标系的切换，不是新模块；同时把一帧里粒子的步进挪到脚本之前。
- 拖尾 `spritetrail` 与 `sprite` 的朝向：只碰几何，不碰模拟。

依据：
- 步骤 0 的读码：[rea-p4c-sim](../../.claude/plans/wpe-import/3-scene/phase4/rea-p4c-sim.md)（控制点、指针、`controlpointattract`、世界空间）、[rea-p4c-render](../../.claude/plans/wpe-import/3-scene/phase4/rea-p4c-render.md)（`spritetrail`、`sprite` 朝向）；
- 确定性工程的实测：[报告](../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4c 语义的实测核对」（22 条读码结论全部成立），以及其中的「步骤 2 补测」（指针）、「步骤 5 补测」（对象带 x / y 旋转时的朝向）；
- 逐步的验收数据：[子计划](../../.claude/plans/wpe-import/3-scene/phase4/phase-4c-controlpoints.md)「实施记录」。

验收照 P4a、P4b：
- 控制点、指针、吸引、世界空间：随机范围收成 min = max，按 WPE 日志的 dt 回放，逐粒子和 RenderDoc 抓帧比，近似倒数照旧按误差包络放宽。
- 拖尾与朝向比每个粒子的四角：
  - 离线：把 WPE 的顶点列喂给我们翻译的顶点着色器（Deno 的 WebGPU）；
  - 真机：屏外宿主自己模拟，dev 探针 `particleCorners` 读回 GPU 算出的四角。
- 每一步：变异检查代理与 Claude 各做一组、互不重复，没检出的只有步骤 2 的一处（dev 探针回放帧的 `cursor` 固定在中心，探针没有单测），步骤 4 的一处补用例后检出；以前的回放（`b3`、`b4`、`b6`、`c1`–`c4`）改动前后输出逐字节相同。

### 控制点

实现在 `particles/controlpoints.ts`（`ControlPointSet`），解析在 `compile/particles.ts`（`readControlPoints`）。

| 项 | 规则 | 依据 |
|---|---|---|
| 个数 `n` | `n = max(模块的 controlpoint + 1)`（`controlPointCount`，只数模块表里带 `controlpoint` 字段的模块）。没被引用的控制点不存在，JSON 里给它写什么都不起作用，能力表也不报。只被表外模块（如 P4d 的 `reducemovementnearcontrolpoint`）引用的点在 `n` 之外，模块进表后自动计入 | 读码 1.1 |
| 存储 | 每个点存 `base`、`current`、`previous` 三份仿射变换（3×3 加平移；WPE 每份是 4×4，第 4 行恒为 0 0 0 1） | 读码 1.1 |
| 初值 | `base = I + offset`，`current = previous = base`。JSON 的 `angles` 运行时不读。`offset` 只在是字符串时解析，切分逐字照 WPE：第一个分量从串首 `atof`，之后先跳过非空格、再跳过空格（只认 0x20），所以 `" 5 6 7"` 是 (5, 5, 6)，`"1,2,3"` 是 (1, 0, 0) | 读码 1.2、1.3，`offset` 的切分对过汇编；实测：控制点 1 写 `angles "0 0 1.5708"`，出生点不旋转 |
| 更新时机 | 每帧一次（两遍模式也只一次），在序列帧之后、发射之前；全部 operator 之后 `previous ← current`。加载时先按加载时的 `W` 更新一次、拷 `previous`，再预热，预热每步照常更新 | 读码 1.3、1.5 |
| `instanceoverride` | `controlpointN` 替换 `base` 的平移，不加到 `offset` 上；`controlpointangleN` 替换 3×3（`eulerBasis`，`Rz·Ry·Rx`，弧度）。指针点、`flags 4` 的点、remap 输出的点（`flags & 0x10005`）上不生效。只做静态值，建系统时生效一次；绑了属性报 `particle:instance:controlpoint:user`（语料 0 处） | 读码第 2 节；实测：覆盖 `"0 200 0"` 时出生点 (1060, 740)，`flags 4` 的点覆盖没生效 |
| 发射器（`sphererandom`、`boxrandom`） | 读自己那个控制点的 `current`：出生点加上平移；3×3 只在「世界空间或 `controlpoint ≠ 0`」时旋转出生点和回退方向，但总是交给 initializer 当 `M`，`velocityrandom`、`turbulentvelocityrandom` 乘它 | 读码第 3 节；实测：本地系统里控制点 0 带角度时出生点不转，速度变成 (0, 50) |
| `vortex` | 中心是控制点平移加 `offset`，轴和 `offset` 不旋转 | 读码第 3 节；实测：控制点 1 带角度时粒子 z 一直为 0 |
| 模块的 `controlpoint` 字段 | 取整后按无符号与 7 取小，负数得 7 | 读码（`cmp eax, 7; cmovb`） |
| `flags` 的取值 | 照 jsoncpp 取无符号整数：布尔取 1 / 0，数字取整后取低 32 位（−1 是 `0xFFFFFFFF`）；字符串 WPE 抛异常，这里取 0 | 读码 |

`flags` 各位（优先级 `0x10000` > bit0 > bit2 > 缺省）：

| 位 | 作用 | 依据 |
|---|---|---|
| 1 | 跟随指针，见下「指针」 | 读码 1.6；实测 |
| 2 | `base` 是场景坐标：本地系统 `current = inverse(W)·base`；世界系统里控制点 0 忽略这一位 | 读码 1.5；实测：对象 `scale 2`、`angles 0.5` 时出生点仍在场景 (200, 100) |
| 4 | 父控制点。顶层系统没有父，走缺省更新，唯一的作用是让实例覆盖不生效 | 读码 1.8；实测 |
| 8、`parentcontrolpoint` | 只在父分支里有用，归 P4e（子系统，`particle:children` 照报） | 读码 1.8 |
| 16 | 没有读者 | 读码（有界）；实测和 `flags 0` 相同 |
| `0x10000` | 内部位：remap 模块写的点，`update` 跳过（P4d） | 读码 1.2 |

中性、不报的：JSON 控制点的 `angles`、`locktopointer`（WPE 2.8.42 二进制里没有这个字符串，实测写 `true` 也不跟随）、`parentcontrolpoint`、bit3、bit4，以及下标 ≥ `n` 的点。`W` 奇异时 WPE 是除以 0 得 inf / NaN，这里写 NaN（粒子不画）。

### 指针

控制点 `flags` bit0 的点每帧的平移是「光标下的场景点」`F`。

| 项 | 规则 | 依据 |
|---|---|---|
| 指针点 | `current = base` 后整体覆盖平移，`offset` 被丢弃，3×3 是单位阵（不吃实例覆盖）。本地系统乘 `inverse(W)`（和 `flags 2` 共用一次求逆，`W` 奇异时平移写 NaN），世界系统直接是 `(X, Y, 0)`、不乘 `W`。用本帧的指针 | 读码 1.6；实测：对象 `scale 2` 时世界组和本地组的出生点正好差 100（本地组的 (100, 0) 经对象放大成 200），`angles 0.7`、`scale 2` 的本地组偏移和预测一致；补测：跟随点和当帧指针换算的值差 ≤ 0.02，和上一帧的差几十像素 |
| 反投影（`pointerScenePoint`） | 照 WPE 逐步 float32：`x = 2px − 1`、`y = 2(1 − py) − 1`，用场景的正交 `P·V`（`sceneViewProjection`，不裁切）的逆，把 NDC z = 0 的点反投影；1920×1080 的场景就是 `(px·1920, (1 − py)·1080)`。求逆没按 float32 复刻，回放里 y 最大差 6.9e-5 | 读码 1.6；实测：指针 (1.4115, 0.7398) 那一帧粒子出生在 (2810, 281)，y 不翻转的式子差 518；光标在窗口外照样外推 |
| 光标下的场景纹理坐标（`render/layout.ts` 的 `sceneCursor`） | 画布指针按当前样式的铺放反算：<br>- `fill`：等于 WPE 把居中盖满裁切做进投影的结果，和 WPE 一致；<br>- `fit` / `center`：Kabegame 自己的样式，按同一原则，留白处线性外推（不钳制）；<br>- `stretch`：恒等；<br>- `tile`：取所在那一块（小数部分） | 补测：1920×800、1440×1080 窗口下 WPE 的跟随点都是 `inverse(P·V)` 作用在窗口指针上，即光标下的场景点，朴素换算差 12–45 像素 |
| 和 `g_PointerPosition` 的关系 | 不是一个量。`g_PointerPosition` 照 P2a 不变：`fill` / `stretch` 是画布归一化坐标（补测：WPE 裁切时也仍是窗口坐标），其余样式换算到场景上（`scenePointer`）。两者只在 `fill` 下不同 | 补测 |
| 透视粒子与透视场景 | 透视粒子（系统 `flags & 4`）不用另算：WPE 模拟时栈上是场景的正交投影，透视粒子的 z = 0 平面和正交画面重合。透视场景（`camera:perspective`）照报，所以 `P·V` 只有正交一种。P5a 起它带抖动与缩放、不带视差，而且是上一帧交给场景的相机，见「相机：视差、抖动与缩放（P5a）」的「一帧里的顺序」 | 读码 1.6；P5a 实测 `p5a-shakepar`、`p5a-zoomx*` |

**数据流**：
- 宿主 `pointermove` → `SceneRenderer.setPointer` 只记画布上的原始坐标；
- 开场指针（P5a 收尾）：`interactive` 时 `WpeSceneView` 在 iframe `load` 与宿主 ready 时各问一次 `wpe_scene_cursor`（Windows：`GetCursorPos` + `ScreenToClient` + DPI，同鼠标转发；其它平台 `null`，退回父页面最近一次 `pointermove` / `pointerdown`），按 iframe 显示矩形换成归一化坐标（不钳制），经 `kabegame:wpe-scene-pointer` 交给宿主当初值；宿主收到过真实 `pointermove` 后初值作废（`scenePointerFeed`）。`SceneHost` 记住最近的指针，渲染器建好时先于 `load` 带进去，没有场景时原样记下的指针在 `load` 里按新场景铺放换成 `g_PointerPosition`，所以预热与第一帧就用真实光标；
- 每帧在 `syncPlacement` 之后按当前样式现算 `cursor`，放进 `FrameInput.cursor`，改样式、改尺寸下一帧就对；
- `GpuScene.stepParticles` 每次调用反投影一次，作为 `ControlPointInputs.pointer` 交给每个系统。模拟器只收场景坐标，不知道样式；
- 加载时按新场景的尺寸（`sceneTargetSize`）算一次 `cursor`，给加载时的更新与预热；
- 暂停时照记坐标、不画，恢复后的第一帧用最新值。WPE 暂停时指针冻结、恢复后读当时的光标，效果相同。

**已知差别**：WPE 用全局光标（`GetCursorPos`），光标在窗口外也跟踪。我们开场取一次真实光标（见上，不交互时不取），之后只在宿主收到 `pointermove` 时更新（预览里是光标在 iframe 上时，桌面是鼠标转发时），之外保持最后的值；两样都没有时 `cursor` 取场景中心 (0.5, 0.5)。

### `controlpointattract`

实现在 `particles/operators.ts` 的 `controlPointAttract`（普通版与 blend 版共用），模块记录在 `particles/modules.ts`。

| 字段 | 缺省（正交 / 透视） | 说明 |
|---|---|---|
| `scale` | 512 / 20 | 乘 `instanceoverride.speed`（系统 `flags` bit4 时不乘）；为负时排斥 |
| `threshold` | 512 / 5 | 不乘覆盖 |
| `deletethreshold` | 15 / 0.5 | 按平方比较（WPE 解析期存 float 平方） |
| `flags` | 2 | bit0 删除判定，bit1 钳制，其余位没有读者。缺省 2 即钳制开 |
| `controlpoint` | 0 | 读这个点 `current` 的平移；钳到 0–7 |
| `offset` | `"0 0 0"` | 解析了，执行和删除判定都不读 |
| `origin` | — | WPE 不读这个键（解析段没有它），中性：登记成不参与计算的字段（`vec3str`，写成数字也不报），免得按表外字段报。语料 50 处 |

公式（照 `0x140241554` / blend 版 `0x14024172d` 的汇编）：
```
C  = cp[controlpoint].current.t；ks = k·scale；rT = rcp(threshold)
每槽（含死槽）：d = p − C；L = sqrt((dz² + dy²) + dx²)
  active = L < threshold 且 FLT_MIN < L         （两个都是严格小于；L 为 NaN 时不生效）
  f = (1 − L·rT)·ks；flags & 2 且 L < f 时 f = L；blend 版钳制之后再乘 b
  active 时按 y、z、x 的顺序 v −= (d/L)·f      （逐步 float32）
```
- 只改速度，不改位置。乘的是 drag 系数 `k`，不是步长 `h`；两遍模式每遍 `k/2`，删除判定每遍都做。`scale < 0` 时 `f < 0`，永远不钳。读 `current`，不读 `previous`。
- **删除判定**（`flags` bit0，`attractDelete`）：线段 `[上一步位置, 位置]`（`movement` 每遍开头把位置抄进上一步位置，出生时是出生位置）上离 `C` 最近的点到 `C` 的距离平方不大于 `deletethreshold²` 时 `age = life`（比较是 `!(dt² < |e|²)`，NaN 也删）：本帧照画，下一帧判死。乘加顺序照汇编：先算 `u = r·d`，`s = ((Cz − P0z)·uz + (Cy − P0y)·uy) + (Cx − P0x)·ux`，`e = C − (s·u + P0)`；rea 4.3 按 Ghidra 写的顺序不对，有 1 ulp 的边界用例钉住。上一步位置列只在 bit0 时分配：模块表新增按字段算的列标志 `columnFlagsOf`。
- **控制点个数**：本模块进表后，只被它引用的控制点开始存在，这些点上的指针、实例覆盖从此生效。语料里这样的点 42 处（指针 30、实例覆盖 12），所在场景当时都还因别的键退回。
- **实测**：缺省 `flags` 是 2（不写和写 0、`scale 1e6` 时完全不同）；`origin`、`offset` 中性；`threshold` 严格小于、`scale` 为负排斥、`scale` 乘 `speed`。语料 62 处全用缺省 `flags`，没有 blend 和 `deletethreshold`，43 处排斥；删除判定和 blend 只由读码与单测钉住，回放里 `a-delete` 只核对了粒子数。
- **回放**：`p4c-attract` 的 fps 60（一遍，抓帧拖慢后 dt ≈ 0.074，`k ≠ h`）与 fps 10（两遍）两组，10 个系统里 9 个在限内（差 / 限 0.12–0.97）。`a-default` 两组都超出包络（差 / 限 1.15、28.7）：
  - 单步核对（只用 WPE 自己相邻帧的位置预测下一帧）残差 4.6e-3 / 3.8e-3，在 `rcpps` 量级内；不钳制的假设残差 1.7e3，所以公式成立。
  - 超限来自钳制下每帧减掉整个 `L`，近似倒数的逐值误差一路累积；fps 10 那组还叠上 151–155 帧的 dt 没有记录。
  - 用户接受这处超限（2026-11-08），不改包络、不重抓。

### 世界空间与帧顺序

系统 `flags` bit0 时粒子存世界坐标。

| 项 | 规则 | 依据 |
|---|---|---|
| 模拟 | 控制点缺省更新 `current = W·base`（控制点 0 忽略 bit1），指针点 `(X, Y, 0)`；出生点 `mat3(W·base)·q + (W·base.t + origin)`，**`origin` 不经 `W`**；`velocityrandom`、`turbulentvelocityrandom` 乘 `mat3(W·base)`（含缩放）；`vortex` 的轴固定在世界；已发出的粒子在对象移动、旋转后留在原地 | 读码 5.2、5.5；实测：脚本移动、旋转对象时 5 个世界空间粒子都落在出生时刻的 `W(t)·(100, 0)` 上（残差 ≤ 0.05）；对象转 90° 时 `origin` 不转 |
| 绘制 | WPE 把模型矩阵栈顶换成 `ctx+0xaf0`，平时是单位阵，所以世界空间系统只乘视图投影：`GpuScene.particleModel` 给单位阵，`g_ModelMatrix` 是单位阵、MVP 等于视图投影。对象变换改了照常重写 uniform，仍是单位阵。组合层离屏时 WPE 把它临时设成模型矩阵，我们没有组合层（`model:passthrough` 等照报） | 读码 5.3 |
| `movement` 的 `flags` bit0 | 本地系统里重力先变换成 `g = Mᵀ·g`（`M` 是模拟用的 `W` 的 3×3，含缩放、不归一化；在乘 `h` 之前，两遍模式每遍都做），世界系统不变换。执行上下文的 `model` 每次（含预热每步）从控制点输入的 `W` 取前三列。其余位没找到读者，照报 | 读码 5.4（取 3×3 的 `FUN_1400dd7d0` 原为【推】，步骤 4 对过汇编后为【确】）；实测：`flags 0` 时本地组的重力随对象转，`flags 1` 与世界组沿世界 −y。语料 0 处 |

**粒子先于脚本**：
- 预研：`p4c-world` 的 `w-stay-*` 由脚本每帧平移、旋转对象。按「第 N 帧用第 N 帧的对象变换」回放，世界空间粒子差 2.54 像素，正好是对象一帧的位移；用第 N − 1 帧的，差 0.016。
- 同时日志里脚本读到的 `engine.runtime` 和同帧 `g_Time` 完全相等，P3b 测过脚本写的变换当帧就作用到图层上。所以不是脚本时钟慢一帧，而是 WPE 一帧里先模拟粒子、后跑脚本。
- `SceneRenderer.render` 一帧的顺序因此是 `sync` → `stepParticles` → 脚本（`beforeFrame`）→ `sync` → `update`（只写每帧 uniform，不再步进）→ `encode`。脚本仍在 `try` 外，脚本自己的错误不走 `render:frame` 退回。dev 探针 `renderFrame`、`particleCorners` 同样先 `stepParticles` 再 `update`。
- 效果：脚本移动对象时，世界空间粒子的出生点、本地系统里指针点与 `flags 2` 点用的是脚本运行之前（上一帧）的对象变换，和 WPE 一样晚一帧；绘制照旧用当帧（脚本之后）的对象矩阵。可见性判断也用脚本之前的状态（没有实测）。
- 步进之前的那次 `sync` 把两帧之间写进 `SceneState` 的属性改值推给模拟器，属性改值的延迟不变。
- 加载时的预热照旧用建场景时的 `W`；加载期脚本 `init` 和预热谁先谁后没有实测。
- **验收**：`p4c-world` 13 个系统各 30 个粒子，差 / 限 0–0.587；`w-grav1-l` 从预研时的 1.73e3 降到 2.29e-2；「本帧变换」的变体在 `w-stay-w` 上差 / 限 236，顺序被钉住。`p4c-ptr` 的 `p-world`（世界空间加跟随指针）三组窗口差 / 限 0.62–0.67。应用里的帧循环 2026-11-09 实测：预览 `3832772446`、应用背景 `1838478131` 1.5 秒内 rAF 216 次、粒子在动；`razer_bedroom` 的 6 个脚本 1.5 秒内 `update` 增加 540 次，没有报错、没有被禁用的回调。

### 拖尾与 `sprite` 朝向

| 项 | 规则 | 依据 |
|---|---|---|
| `spritetrail` 字段 | `length` 0.05、`maxlength` 10、`minlength` 0（缺省函数不补这个键，读成 0）；正交、透视一套缺省，原样存，不钳制、不排序（`minlength > maxlength` 时着色器的 `max` 在外层，`minlength` 胜） | 读码 6.1 |
| 宏 | `THICKFORMAT = 1`、`TRAILRENDERER = 1`（`compile/bundle.ts` 的 `particleRendererDefines`），槽 0 带帧表时照旧再写 `SPRITESHEET*`。`sprite` 不写朝向宏，`TEX0FORMAT` 的条件见下 | 读码 6.2、7.8 |
| `g_RenderVar0` | 拖尾系统写 `(length, maxlength, minlength, 0)`，其余仍是 0。WPE 的 `.w` 保留上一次绘制写的值，`genericparticle` 不读 | 读码 6.3 |
| 拖尾几何 | 全在翻译后的着色器里：`L = max(minlength, min(‖v‖·length, maxlength))`，四边形以粒子为中心、沿当帧速度拉长，宽 `size`，宽向 `normalize(cross(p − eyeLocal, v))`，离开视轴时变窄。和帧时间、历史位置无关；模拟器不为拖尾多做任何事，速度照 P4b 写进厚格式顶点。透视粒子的拖尾仍用场景眼位 | 读码 6.4；实测：12 组长度都吻合（含截顶、托底、两者冲突），`v = (60, 80)` 四角逐位相同，宽度正是 `10·2000/√(2000² + dy²)` |
| 朝向解析（`particles/orientation.ts` 的 `readOrientation`） | `orientation` 只认精确的 `"upright"` / `"fixed"`（区分大小写），其它都是 `screen`；`axis` 精确零（−0 也算）换成 (0, 1, 0)，否则归一化（`"0 0 0.000001"` 得 (0, 0, 1)）；派生 `t`（`axis.x == axis.z == 0` 时是 (0, 0, −1)）；`flags` 只存低 8 位，只有 bit0 有读者。拖尾共用这段解析，但几何不读朝向 | 读码 7.1、7.6、7.7，汇编核对 |
| 朝向向量（`orientationVectors` / `orientationBasis`） | 照 `FUN_1402298b0` 在 CPU 上算 `g_OrientationForward / Right / Up`：<br>- `screen`：法线朝相机；bit0 时上方向取相机上方向，否则取对象 Y 轴，再对法线做一次 Gram-Schmidt；<br>- `upright`：绕 `axis` 的圆柱公告板，bit0 时上方向固定为 (0, 1, 0)、`axis` 被忽略；<br>- `fixed`：法线固定为 `axis`、上方向是 `t`，bit0 时两者是世界向量。<br>输入是这次绘制的模型矩阵（本地系统是对象世界矩阵，世界空间系统是单位阵）与正交场景的相机（`VIEW_FORWARD = (0, 0, −1)`、`VIEW_UP = (0, 1, 0)`，透视场景照报） | 读码 7.2、7.4；实测：24 组四角全部吻合，对象转 0.5 弧度时 `flags 0` 随对象转、`flags 1` 保持直立 |
| 何时算 | 朝向只在模型矩阵变化时变，变化会标脏，所以放在静态 uniform 里（`particleUniformValues`）；对象变换就地刷新时重写这三个名字（`PARTICLE_REFRESH_UNIFORMS`，材质值照样优先） | — |
| 退化不画 | WPE 里速度为 0 或平行于视线的拖尾、轴平行于视线的 `upright` 算出 NaN，不画。WGSL 没有可靠的 NaN 判断，`normalize(0)` 各后端不同，都在 CPU 上处理：<br>- 拖尾写顶点时跳过这些粒子（`particles/vertices.ts` 的 `trailDrawable`，照着色器的式子在 float32 里判 `v·v == 0` 或 `c·c == 0`（`c = cross(p − eyeLocal, v)`）；`eyeLocal` 由 `g_EyePosition` 与模型矩阵的逆算，`trailEye`）；<br>- 朝向算出 NaN 时这次绘制整个跳过（draw 的 `hidden`），uniform 照写原值 | 读码 6.4、7.4；实测：速度为 0 的拖尾（`T6`）与轴平行于视线的 `upright`（`S7`），WPE 的 `gs_out` 四角都是 NaN |

- **一个系统多个 renderer 继续报 `particle:renderers`**（2026-11-09 用户定）：
  - WPE 对多个 renderer 按数组顺序各画一次，共用一份顶点、各绑自己的变体材质（实测两种顺序都是两次绘制）。
  - 我们一个粒子层只有一次绘制。支持它要拆成一个系统多次绘制：顶点布局能不能共用、每次绘制各自的 uniform、快照「每对象至多一次」、四角探针按绘制输出。
  - 语料里这样的系统一个都没有；步骤 0 抓的 `T8`、`T8r` 留给以后。
- **`TEX0FORMAT`**：见「粒子（P4a）」的「编译」，非厚格式 `sprite` 的非 `screen` 朝向对任何格式都写。
- **没改的边界**：`renderer: []` 仍按缺省 sprite 画（WPE 不画）；`orientation` 写成非字符串照报（比 WPE 严）。
- **对象带 x / y 旋转**（步骤 5 补测，`proj/p4c-rot`，17 个系统）：
  - 朝向改成现算以后，挂在带 x / y 旋转对象上的 `screen` sprite 不再是写死的单位基。WPE 里 x 旋转 0.6 的 `screen` sprite 是 40×40 的正方形、朝向相机，跟随对象的 `fixed` 是 40×33.01（cos 0.6），和现算一致，写死单位基是错的。
  - 四角离线最大差 1.90e-4 像素，真机（含我们自己模拟的累积）6.87e-4。
  - 干净场景里受影响的只有 `shimmering_particles` 的 3 个 `small_motes_copy1` 层（透视粒子，和单位基最大差 0.391）。它们在默认样式下不可见（屏外宿主实测 `visible` 都是 false，`encode` 整段跳过），默认样式的画面不受影响；`style` 改成 1 时这三层朝向相机。补测照抄了这三层的角度、z 偏移与缩放，和 WPE 吻合。
- **四角验收**：`p4c-trail`、`p4c-sprite` 32 个系统 × 3 帧，离线与真机都和 WPE 最大差 1.14e-4 像素（限 0.01）；`T6`（速度为 0）不写顶点，`S7`（`upright` 轴平行于视线）整次跳过；透视粒子加拖尾（`T10`）用场景眼位，四角同样吻合；`p4c-trail` 只报 `particle:renderers`（`T8`、`T8r`）。

### 语料与解锁

- **语料**（152 个工程，按 P4b 的口径重算：`ignore/p4/c5/coverage_p4c.py`，结果 `out/coverage-p4c.txt`）：
  - 能渲染的场景 20 → 22。
  - 带粒子的 95 张里，粒子用法完全覆盖（不报任何 `particle:*` 键）的从 22 张到 44 张；步骤 1–5 之后依次是 22、26、31、32、44。
  - P4c 去掉的键：`particle:controlpoint` 48 张、`particle:renderer:spritetrail` 29、`particle:operator:controlpointattract` 28、`particle:flags:world` 21（34 个系统）、`particle:instance:controlpoint` 7、`particle:renderer:sprite:flags` 6、`particle:renderer:sprite:orientation` 2。步骤 1 新增的 `particle:controlpoint:pointer`（32 张）在步骤 2 去掉，收尾时没有新增的 `particle:*` 键。
- **新解锁**：
  - `1838478131`（步骤 2）：控制点 0 的 `flags 1` 跟随指针。场景是 3441×2465，桌面 16:9 下 `fill` 正好裁切，这正是要按铺放反算的情形。没有和 WPE 逐帧比这张场景的画面：跟随规则由 `p4c-ptr` 三种窗口的回放核对（WPE 的跟随点和我们的逐帧差 ≤ 0.02），用户在预览和桌面上看过，没有问题（2026-11-08）。
  - `3832772446`（步骤 5，还要步骤 1–3）：20 个透视粒子，`sphererandom` + `alphafade` + 排斥的 `controlpointattract`，renderer 是 `sprite` `flags 1`。被排斥的是控制点 1，它的平移来自 `instanceoverride.controlpoint1`，不跟指针；场景也没有着色器读 `g_PointerPosition`。和 WPE 比画面（2026-11-09，3840×2160 窗口，抓 3 帧）：
    - 静态部分（按抓帧的 `g_Time` 渲染、不步进粒子）：差值大于 32 的像素只占 0.15%，全部落在 WPE 的 20 个粒子上，粒子以外逐像素一致；
    - 粒子（按「前 2061 帧均匀走到抓帧前、抓到的三帧各 0.25 s」回放，比统计量）：粒子数 20 / 19 / 20 对 20 / 19–20；位置范围、尺寸（WPE 53–284，我们 54–292）、屏幕上的四边形边长与中心分布一致。alpha 均值 WPE 0.43，我们 24 个种子均值 0.504、标准差 0.072，WPE 在一个标准差以内，是随机波动。
  - `1923929928` 做完本节只差 `object:perspective`，不算本节解锁。
- **还挡得最多的粒子键**：
  - `particle:children` 32 张（P4e）；
  - `particle:renderer:rope` 22、`ropetrail` 8、`mapsequencearoundcontrolpoint` 8（P4d）；
  - 模块上的 `audioprocessing*` 字段各 4–7 张（P4e）；
  - `particle:binding:instance:rate` 7、`particle:binding:instance:colorn` 5（`{script}`，P4f）。
- **基线**：10 张原本能渲染的场景 × 三档后处理，共 30 组画面哈希，步骤 1–5 每一步都和前一步相同（步骤 1 对 P4b 步骤 6 的记录）。

### dev 探针与对比台的增补

| 探针 | P4c 增补 |
|---|---|
| `particleTrack` | 用全部图层按 `worldMatrixOf` 算每个粒子层的 `W`（静态，不跑脚本），传给预热与每步（步骤 1）；`cursors`（每帧光标下的场景纹理坐标，和 `dts` 等长，回放 WPE 时填轨迹里的 `g_PointerPosition`，抓帧窗口和场景同尺寸时两者相同；第 1 项也用于预热）与 `size`（场景的投影尺寸，给了 `cursors` 时必填；只给 `size` 时跟随点是场景中心，都不给时是 (0, 0)）（步骤 2）；拖尾系统输出速度与 frame（步骤 5） |
| `renderFrame` | `pointer` 同时作 `cursor`，加载时也用它（步骤 2）；先 `stepParticles` 再 `update`（步骤 4） |
| `particleCorners` | `cursor`（缺省场景中心）；每层多给 `drawn`（朝向是 NaN 时为 false，四角照算，同 WPE 的 `gs_out`），`count` 去掉拖尾的退化粒子（步骤 5） |

对比台仍在 `ignore/p4/`：
- `gen_c.py`：生成 P4c 的确定性工程 `p4c-cp`、`p4c-attract`、`p4c-world`、`p4c-trail`、`p4c-sprite`，以及补测的 `p4c-ptr`（步骤 2）、`p4c-rot`（步骤 5）。
- `rdc_track_b.py`：加了指针记录（时钟图层的着色器同时读 `g_PointerPosition`，WPE 当帧用的指针进轨迹）、`gs_out` 四角读取与同系统多次绘制，对 P4b 的工程兼容。
- 读数脚本 `ana_c.py`、`ana_c2.py`、`ana_ptr.py`、`ana_ptr2.py`、`ana_c_render.py`。
- 各步骤的验收在 `c1/`–`c5/`：
  - 每个目录有本步的 `replay.test.ts`、语料 `corpus.test.ts` 与 `corpus_diff.py`、变异检查 `mutate.py` / `mutate_claude.py`，以及以前各步回放的拷贝（`replay-b3/b4/b6/…`），用 HEAD 导出的源码（`head/src`）对工作区逐字节比；
  - 另有：`c1/scan_cp.py`（控制点语料扫描）；`c3/scan_attract.py`、`consts.py`（从 exe 读缺省值与 `FLT_MIN`）、`claude_onestep.py`（单步核对）；`c4/prestudy.test.ts`（帧顺序预研）、`live_*.ts`（应用里的帧循环）；`c5/corners-offline.*`（离线四角）、`live_corners.ts`（真机四角）、`rot_shape.py`、`orient-scan.test.ts`；
  - 收尾和 WPE 比 `3832772446`：`c5/cmp_scene.py`、`wpe_particles.py`、`ours_particles.ts`、`cmp_particles.py`、`alpha_seeds.ts`；覆盖数 `c5/coverage_p4c.py`。
- WPE 参照在 `A:\p4b\p4c-*`、`A:\p4b\3832772446-fps60`，用 `wpe-renderdoc` skill 抓，结束后按字节还原 WPE 的 `config.json`、放回桌面壁纸。新的抓帧用 `wpe-renderdoc` MCP（`.claude/mcps/wpe-renderdoc/`）的 `capture_wallpaper` / `capture_sweep`：WPE 常驻不强杀，改过的设置由 `capture_sweep` 经 `restart_wpe` 改回。

步骤 4、5 与收尾在应用里的验收经 kabegame-dev（`.claude/skills/kabegame-chromium/SKILL.md`）做：
- `projects_import` / `projects_remove` 把确定性工程导入 dev 库、用完移除，并核对没有残留的行与任务；
- `hash_baseline` 跑 10 张干净场景三档的画面哈希；
- `render_scene` 看单张场景的固定时刻画面（不步进粒子）；
- 客户端的 `hostParticleCorners` / `hostRender`（`apps/kabegame-dev-mcp/src/client.ts`）在屏外宿主里按给定 dt 回放后读四角、渲染整帧。

## 粒子（P4d）

P4d 有两块性质不同的内容，底座的形状仍不变：
- 绳（`rope`、`ropetrail`）是新的**绘制**：WPE 用几何着色器把每段一个点展开成三角形带，我们由翻译器把几何着色器展开进顶点着色器。模拟侧只多两份状态：rope 的出生序表、ropetrail 的位置历史。
- 映射类（`mapsequence*`、`remap*`）与距离类（`maintaindistance*`、`reducemovementnearcontrolpoint`、`vortex_v2`）是普通模块，读 P4c 的控制点。`mapsequence*` 是第一批带运行状态的 initializer；两个 maintaindistance 第一次读控制点的 `previous`，由此带出「不可见的帧也更新控制点」。

依据：
- 步骤 0 的读码：[rea-p4d-rope](../../.claude/plans/wpe-import/3-scene/phase4/rea-p4d-rope.md)（绳的段顶点、rope 表、字段与宏、ropetrail 历史）、[rea-p4d-modules](../../.claude/plans/wpe-import/3-scene/phase4/rea-p4d-modules.md)（映射类、距离类、`vortex_v2`、不可见时的行为）；
- 确定性工程的实测：[报告](../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4d 语义的实测核对」；
- 逐步的验收数据与收尾走查：[子计划](../../.claude/plans/wpe-import/3-scene/phase4/phase-4d-ropes.md)「步骤 1–5 实施记录」「收尾 A 实施记录」。下面每条只点出依据是读码还是实测，数字和例外以子计划为准。

验收照 P4a–P4c：随机范围收成 min = max，按 WPE 日志的 dt 回放，逐粒子（绳逐段）和 RenderDoc 抓帧比，近似倒数按误差包络放宽。
- 绳另比几何：离线把 WPE 的 `vs_in` 喂给我们翻译的着色器（Deno 的 WebGPU），和 WPE 的 `gs_out` 逐顶点比；真机由 dev 探针 `particleCorners` 读回整条带子。
- 回放案例在 `ignore/p4/cases/`（`d1`、`d3`–`d6`，`kbp replay`；ropetrail 是 `ignore/p4/d2/replay.test.ts`）；每步 `kbp regress` 现有案例逐字节相同；变异检查子代理与 Claude 各做一组，全部检出（只靠单测的几条在子计划里逐条写明）。

### 绳的绘制：几何着色器展开

| 项 | 规则 | 依据 |
|---|---|---|
| WPE 的画法 | `POINTLIST` 加 `genericropeparticle.geom`：每段一个点，几何着色器输出 `4 + 2·subdivision` 个顶点的三角形带，中间点走三次贝塞尔。`.vert` 的非 GS 分支和 GS 路径不同（没有细分、不看 `ORIENTATION`、`right * uvs.x * 2.0 - 1.0` 的优先级错误），WPE 恒定义 `GS_ENABLED`，所以只能复刻 GS | 实测：所有绳的绘制都是 `PointList`，`dcl_maxout` 随 `subdivision` 0 / 3 / 4 / 16 / 40 是 4 / 10 / 12 / 36 / 68 |
| 翻译器 | 请求带 `geometry`（`.geom` 原文）时定义 `GS_ENABLED`，把几何段拼进顶点段：每段一个实例，`vertex_index` 是第几个输出顶点，第 `vertex_index` 次 `OUT.Append` 的顶点就是输出；结果带 `geometry.maxVertices`。只支持点输入（`IN[0]`）、单条带；`normalize` 的参数是零向量时整个图元落到裁剪体外。规则与限制见 [wpesl2wgsl README](../../src-tauri/wpesl2wgsl/README.md)「几何着色器展开」 | 实测：零长段在 WPE 里是 NaN 顶点（D3D 丢掉含 NaN 的三角形），NaN 段和我们落到裁剪体外的段逐段一一对应 |
| 着色器替换 | rope 两类系统的 pass 一律换成 `genericropeparticle`，不论材质写的是什么；混合、深度、纹理、常量照旧取材质。`ShaderCompiler.compile` 的 `geometry` 选项读 `shaders/<名>.geom`，进缓存键 | 读码第 6 节；`2254685070` 的管线状态和 WPE 一致 |
| 宏 | rope：`THICKFORMAT=1`、`TRAILSUBDIVISION`、`ORIENTATION`。ropetrail：`TRAILRENDERER=1`、`TRAILSUBDIVISION`、`ORIENTATION`，`uvscrolling` 时 `TRAILSCROLLALPHA=1`，`fadealpha` / `fadesize` 为真时 `TRAILFADEALPHA` / `TRAILFADESIZE`，不写 `THICKFORMAT`。两者都只在槽 0 是格式 8–11 时写 `TEX0FORMAT`，不写 `SPRITESHEET*`（`compile/bundle.ts`，`isRopeRenderer`） | 读码 3.4 |
| 管线与绘制 | 翻译结果带 `geometry` 时顶点布局按实例步进（`stepMode: "instance"`）、拓扑是三角形带（`PipelineSpec.topology`，进管线键），`pass.draw(maxVertices, 段数)`，段数为 0 不画。顶点缓冲：rope 按 `capacity` 段，ropetrail 按 `capacity × n` 段。属性检查：rope 6 个、ropetrail 5 个（含一个 `vec3`），别的照报 `render:particle-attribute:*` | — |
| 剔除与朝向 | 绳的光栅化是 `NoCull`；`upright` / `fixed` 只让 u 左右对调，不会整条不画。`ORIENTATION ≠ 0` 时用 P4c 的 `g_Orientation*`；`ORIENTATION 0` 的绳不因它们是 NaN 而跳过 | 实测 R6u：Forward 是 (0, 0, 1)，宽度正好 40 |
| `g_RenderVar0` | rope 写 0（rope 分支不读）；ropetrail 每帧写，见下 | 读码第 4 节 |

**验收**：离线展开 rope 34 组 201 帧、ropetrail 22 组，位置差 ≤ 2.3e-4 像素，uv ≤ 9.5e-7，颜色 0；真机四角 rope 17 个系统 ≤ 0.004 像素，ropetrail 11 个系统 ≤ 4.6e-4。翻译器不带 `geometry` 的请求，177 次翻译、708 个输出文件逐字节不变。

### `rope`

实现在 `particles/rope.ts`（`RopeOrder`、`writeRopeSegments`），模块记录在 `particles/modules.ts`。

| 字段 | 缺省 | 说明 |
|---|---|---|
| `subdivision` | 4 | 钳到 `[0, 32]`，即 `TRAILSUBDIVISION`；一段最多 68 个顶点，语料最大 16 |
| `uvscale` | 1 | 存倒数 `K = 1/uvscale`；写 0 时不改，保持 1 |
| `uvscrolling` | false | 为真时不看 `uvsmoothing` |
| `uvsmoothing` | true | |

- **rope 表**（WPE 的 `sys+0x218`）：存槽号，出生时追加，判死后保序删除（同一槽出现多次也删光），表序就是出生序，同帧出生的按 emitter 顺序排。我们的槽位复用第一个空槽，所以另记这张表和累计死亡数；`clear`（预热、复位都经过它）清空两者。实测：稳态下槽位已复用，绳上的位置仍严格单调。
- **段顶点**：段 k 连接表的第 k、k + 1 项，存活数 ≤ 1 时不画：
```
a = idx[k]  b = idx[k+1]  c = idx[k−1]（首段取 a）  d = idx[k+2]（末段取 b）
a_PositionVec4   = (pos[a], size[a])     a_TexCoordVec4   = (pos[b], TL)
a_TexCoordVec4C1 = (pos[c], k + TP0)     a_TexCoordVec4C2 = (pos[d], size[b])
a_TexCoordVec4C3 = rgba[b]               a_Color          = rgba[a]
```
- **`TL` 与 `TP0`**（整条绳共用，逐步 float32）：
```
R = 第一个 rate 非零的发射器的 rate · io.count               // 不看系统 flags 的禁用位
L = 第一个中点非零的 lifetimerandom 的中点 · io.lifetime        // 没有则 0
Rf = (R·L > 存活数) ? min(fps, R) : R;  N = Rf·L
uvscrolling：TL = N − 1，TP0 = 累计死亡数
否则：TL = 存活数，TP0 = 0；N > 0、!(存活数 < N − 1) 且 uvsmoothing 时
      TL = N − 1，TP0 = saturate((L − age[idx[0]]) / (1/Rf)) − 1   // 先求倒数再除
TL *= K
```
  存活数正好是 2 时另按特例：`c = a`、`d = b`、`TL = 2`、`TP = 0`，不乘 `K`，也不看滚动和平滑。
- **`fps`** 是宿主的帧上限（`maxFps`，缺省 60），和两遍模式用的是同一个值，不是 WPE 设置的 `fps`。所以 Kabegame 的帧上限和 WPE 设置不同时，绳在填充期（存活数还没到 `R·L`）的 uv 就和 WPE 不同，满了以后相同。
- **依据**：段内容、表序、缺省值、两粒子特例、`uvscale`、滚动在步骤 0 实测成立；`Rf = min(fps, R)` 由收尾 A 的 `r9-fill`（`rate 100`、寿命 2、`maxcount 64`，一直走「没满」）实测：fps 10 下 `TL` 两边都是 19。
- **回放**：`p4d-rope` 16 个系统、两种 fps，段数逐帧相同；位置 ≤ 4.3e-4（坐标过千的 R11 7.3e-4），`TL` 差 0，`TP` ≤ 5.7e-5。

### `ropetrail`

实现在 `particles/ropetrail.ts`（`TrailHistory`、`writeTrailSegments`、`trailRenderVar0`）。

| 字段 | 缺省 | 钳制 |
|---|---|---|
| `length` | 1 | 至少 0.001 |
| `segments`（n） | 4 | `[2, 32]` |
| `subdivision` | 1 | `[0, 32]` |
| `fadealpha`、`fadesize`、`uvscrolling` | false | |
| `uvscale` | 1 | 0 时不改；和 rope 共用 `K` |

- **历史**：每粒子 n 个位置（新的在前）、已存段数 `C`、`uvscrolling` 计数 `U`（u16 回绕）；计时器每系统一个，间隔 `f32(length / n)`，初值 0，复位与预热都不重置它。
  - 出生（全部 initializer 之后）：历史全写出生位置，`C = 1`、`U = 0`。
  - 预热后：高水位以内的每个槽塌缩到当前位置，`C = 1`、`U = 0`。收尾 A 的 `t7-pre` 实测：抓帧时 `h[1]` 是预热结束时的位置，不是出生点。
  - 采样（每帧模拟之后，`dt'` 已乘 `rate`）：存活数为 0 时计时器停走；否则 `timer −= dt'`，`!(0 < timer)` 时 `timer = 间隔`、**余量丢掉**，全部存活粒子的历史后移一格，`h[0]` 写本帧位置，`C = min(C + 1, n)`，`U + 1`。每帧最多采一次，`dt'` 大于间隔也只采一次。预热不采样。
- **段**：每个存活粒子按槽序恒写 n 段。段 0 是 `p → h[0]`，CP0 是 `p`、CP1 是 `h[1]`；段 1 是 `h[0] → h[1]`，CP0 是 `p`；中间段 `h[k−1] → h[k]`，CP 取 `h[k−2]`、`h[k+1]`；末段的 CP1 取终点自身。w 分量不滚动时是 `C·K` 和 `k`，滚动时是 `k` 和 `k − U`。没填满的段零长，由展开的退化规则整段不画，不另外处理。
- **`g_RenderVar0`**（每帧按当时的计时器写）：`z = 1 − max(timer, 0)/间隔`；`w = n − 0.5`；滚动时 `w = (n − 1)·K`、`x = n − 1`，不滚动时 `x`、`y` 写 0。
- **渐隐**：`fadealpha` / `fadesize` 只在 `uvscrolling` 时起作用（宏照写，着色器只在滚动分支里用）。实测：开渐隐、不滚动的 T3 和不渐隐的展开逐位相同。
- **依据**：采样、余量丢掉、每帧一采、钳制、`RV0` 在步骤 0 实测成立；T7（`starttime 1`）在 WPE 里一直没画，是满容量时发射计时冻结（P4b 已实现），周期约 3.94 s，我们的回放同样没有存活粒子。
- **回放**：`p4d-ropetrail` 12 个系统、两种 fps，每帧段数相同；位置 ≤ 4.4e-4，尺寸、颜色、alpha、两个 w 分量差 0，`RV0` ≤ 2.2e-6。

### `mapsequencearoundcontrolpoint`、`mapsequencebetweencontrolpoints`

实现在 `particles/mapsequence.ts`。这是第一批有运行状态的 initializer，模块表为此多了三个钩子：`createState`（每个系统实例一份）、`resetState`（系统复位）、`newPeriod`（周期发射进入新周期，在本帧的新粒子出生之前）；字段多了 `instanceIf`（按解析值决定乘不乘 `instanceoverride`）。

- **序号**：状态是 `seq` 与 `step`，先用后加：`seq′ = f32(step + seq)`。
  - `step`：around `1/max(count, 1e-4)`，between `1/max(count − 1, 1e-4)`。
  - `seq′ > 1`：repeat 时 around 取 `fmodf(seq′, 1)`、between 归零；mirror 时反射、`step` 取反。比较都是严格的，所以 around 的第一圈留着 1.0。
- **清零**：
  - 系统复位（对象不可见且有存活粒子）：两者 `seq = 0`，`step` 不动。实测（步骤 3 的 `ma-hide`）：清空之后逐粒子对上。
  - 新周期：只有 between 在 `flags & 0x20` 时清零（实测 `mb-period32`）。
  - around 不解析 `flags`，记录里那个字是解析暂存区的残留值，取决于这次 WPE 运行里之前解析过什么。四次先行解析（含一次干净重启）里 `count` 都不乘 `instanceoverride.count`，照此实现、不报；配周期发射时新周期清不清零只测到一次（收尾 A 的 `around-period`：这次是不清零），能力表照报 `particle:initializer:mapsequencearoundcontrolpoint:periodic`（语料 0 张）。
- **around**：`M`、`C` 是控制点 `current` 的 3×3 与平移，基向量乘 `M`。保留出生点到轴的距离 `L`，`θ = (Δb·seq + b0)·2π`，`θ = 0` 在 +y、往 +x 转；位置覆盖成 `dirA·L + proj·A + C`；`speedmin` / `speedmax`（乘 `instanceoverride.speed`）的 x 切向、y 径向、z 轴向加到速度上；无条件抽 3 个随机数。`axis "0 1 0"` 时基向量是 `(1, 0, 0)`、`(0, 0, −1)`。
- **between**：两个控制点的平移 `S`、`E`；本地系统按系统原点量垂直分量（**不减** `S`），世界系统先减 `S`；`w = 1 − (2·seq − 1)²`（用 `seq`，不是 `t`）。`flags` 1 / 2 / 4 / 8 分别是垂直分量乘 `w`、速度乘 `w`、尺寸按 `sizereductionamount` 缩、加 `arcdirection` 方向的弧；别的位照报 `…:flags`。`count` 只在 `flags & 0x10` 时乘 `instanceoverride.count`，改值时 `step` 重写成正的新值（mirror 走到一半会回到正向）。不抽随机数。
- **控制点个数**：`controlpointstart` / `controlpointend` 也计入，between 不写字段时也有 2 个点。
- **回放**：`p4d-map` 20 个系统按槽序逐粒子比；between 9 组逐位为 0（`f2` 3.7e-4），around 差/限 0.42–0.69（`sphererandom` 的近似倒数）。「复位不清零」「新周期不清零」两个变体分别超限 9.5e4、5.25e5 倍。

### `remapinitialvalue`、`remapvalue`

实现在 `particles/remap.ts`：一条管线「读输入 → 分量 → 归一化 → 变换 → 输出区间 → 运算写回」，两个模块共用，按种类（init / op）在 18 处取变体，文件头逐条列出。读码确定的取值全做（20 个输入、8 个分量、7 个变换、4 个运算、14 个有效输出）。新字段类型 `vec3splat`：字符串读三个数，数字铺满三分量（`inputrange*` / `outputrange*`）。

最容易弄错的几处（init 对 op）：

| 项 | init（`remapinitialvalue`） | op（`remapvalue`） | 依据 |
|---|---|---|---|
| 输入 `particlesystemtime` | 系统时间 `St`（乘 `rate`） | 场景时间 `T`，和 `runtime` 相同 | 实测 ri-time / rv-time |
| 输入 `lifetimefraction` | 读 frame 列（出生时 0，`randomframe` 时是 `R`） | `rcp(life)·age` | 读码 |
| 归一化 | 三分量各自 `(in − min)/range` | 向量输入 `(in − min)·rcp(range)`；标量输入只用 x 分量的 min 与倒数，夹完再铺满 | 收尾 A 实测 `rv-vec2` / `ri-vec2` |
| `square` / `saw` | `floorf`、`roundf` | 截断、偶舍入 | 实测 rv-square / rv-saw；收尾 A 实测 `ri-square2` / `ri-saw2` |
| 噪声 | `snoise1` / `fbm1`（P4b 的 WPE 噪声），和 `R` 无关 | FastNoise2 二维 Simplex / FBm（`particles/fastnoise2.ts`），种子取每粒子 `R`，y、z 分量再异或 `0x0b3924ad`、`0x493a8e83` | 实测：rv-noise 三分量残差 ≤ 4e-4；FBm 倍频在步骤 4b 的回放里定下 |
| 写 size / opacity / color | 初始值列 | 当前值列（置列标志） | 读码 |
| 输入 `positionbetweentwocontrolpoints` | 读 `outputcontrolpoint0` / `1`（不是 input） | 同左 | 实测 |

- **写控制点**：输出 `controlpoint` 时按 `outputcomponent` 运算后写回 `cp[ocp0].current` 的平移；init 每个新粒子写一次，op 每 4 个槽一组（含死槽）只有槽 `4g` 生效。这个点在建系统时置 `0x10000`（模块表的 `controlPointFlags`），`update` 跳过它、不吃实例覆盖。init 的输入 `controlpoint` / `deltatocontrolpoint` / `directiontocontrolpoint` 先把 `cp[icp0].current` 的平移写成 0（WPE 的 bug，实测 ri-cpbug），照做。
- **控制点个数**：输入或输出是 7、8、16、17、18 号时计 `icp0`、`ocp0`，是 8 号时再计 `icp1`、`ocp1`（`controlPointRefs`）。
- **系统时间 `St`**：每次步进在模拟之前 `St = f32(St + dt′)`；预热期间不累加（收尾 A `st-pre`）；不可见期间也累加（见下「不可见的帧」）。图层时间只在可见时累加。
- **照报**：输入、输出 `timeofday`（写入点没找到），未知的输入 / 输出 / 分量 / 变换 / 运算名；op 的输出 `maxlifetime`（WPE 按 4 个一组写到组尾、把死槽写回非零寿命，存活数下溢后不再发射，复刻不了），init 的照常支持。
- **回放**：`p4d-remap` 26 个系统、`p4d-remap2` 63 个系统（除两个 `timeofday` 与 op 的 `maxlifetime`），两种 fps，差/限 ≤ 0.79。

### 距离类与 `vortex_v2`

实现在 `particles/distance.ts`，四个都是普通 operator，每遍处理 `[0, count)` 的全部槽，逐步 float32、加法顺序照汇编。blend 变体用现成的 `readBlend`。

| 模块 | 要点 | 依据 |
|---|---|---|
| `maintaindistancetocontrolpoint` | 先平移 `Δ = current.t − previous.t`，再拉回 `T = inverse(mat3(current))` 下半径 `distance` 的球面；强度 `variablestrength` 为 0 时是硬约束，否则 `clamp01(vs·h)` | 实测：对象 `scale "2 1 1"` 时落在 400 × 200 的椭圆上 |
| `maintaindistancebetweencontrolpoints` | 两个点的 `current` 与 `previous` 都读；`n` 或 `np` ≤ 2⁻⁴⁶ 时整条跳过（NaN 也跳过） | 读码；实测 mb2-same 是直线 |
| `reducemovementnearcontrolpoint` | 只改速度：`vel *= 1 − clamp01(r·h)`。`distanceouter == distanceinner` 时倒数存 1.0，`reductionouter == reductioninner` 时差存 1.0（两处都是 WPE 的 bug，照做） | 实测 `rm-eq2`：两种 fps 都停在 100/3，按 0 实现会停在 50 |
| `vortex_v2` | 切向 `(r̂ × a)·spd`，`spd` 乘 drag 系数 `k`（不是步长 `h`）；轴的 `(x² + y²) + z² < 0.001` 时取 (0, 0, 1)，否则 `axis·(1/sqrt)` 再乘控制点 `current` 的 3×3；`flags & 2` 时读 `centerforce`（系数 `cf/h`），`flags & 4` 是环形；`n = 0` 或 `\|P′\| = 0` 时照 WPE 写 NaN；`audioprocessingmode ≠ 0` 照报（P4e） | 实测：换成 `h` 差 2.1–2.7，sample-gaps 写的方向是反的 |

- **两遍模式**：`previous` 只在帧尾更新，两遍都看到同一个 `Δcp`，一帧平移两次。这是 WPE 的行为（实测 md-move 在 fps 10 下两倍速跟随，世界空间粒子会跑到对象前面），按现在的结构自然得到。
- **NaN 的钳制**：`clamp01`（`minss(1, maxss(0, x))`）让 NaN 原样通过，`saturatePs` 让 NaN 得 1，按汇编各用在各自的位置；rea 写的「NaN → 0」不对。
- **回放**：`p4d-dist`、`p4d-dist2` 两种 fps，逐帧比较通过的差/限都 ≤ 0.77。`md-hard`、`md-scale`（绝对差 0.04–0.09 像素）与 fps 10 的 `v2-ring-*` 只报告、另做单步核对（每帧换成 WPE 上一帧的状态步进一帧，全部通过）：WPE 的 `rsqrtps` 误差随输入逐帧变化，在把粒子拉回半径的系统里是随机游走，常量偏置的包络界不住。

### 不可见的帧

对象不可见（自身或父链）时，渲染器调 `ParticleSystem.suspend(inputs, frameDt)`，不步进粒子：
1. **控制点照常更新**：按当帧的 `W` 与跟随点更新，帧尾 `previous ← current`；没有存活粒子时也做。依据：读码 rea-p4c-sim 5.6；实测 `p4d-dist2` 的 `hide-r`，「不更新」的变体超限 1156 倍。没有这一条，重新可见的第一帧 `Δcp` 是整段隐藏期间的位移，maintaindistance 的粒子会被一次拽过去。
2. **有存活粒子时复位**（和 WPE 一样，没有粒子时不做）：emitter 计时、模块状态（`mapsequence*` 的 `seq`）、系统时间与图层时间清零，再 `clear`（rope 表与累计死亡数一起清）。
3. **系统时间照常累加**：复位之后无条件 `St += f32(frameDt)·rate`，图层时间不累加。依据：收尾 A 实测 `st-hide`，「不累加」「先累加再复位」都超限，「复位后累加本帧」差 ≤ 7.6e-6；原实现不累加，收尾 A 改正。
4. **不发射**：实测「不可见期间照常发射」的变体四段粒子数都对不上（WPE 不可见期间不发射，或最后一个不可见帧发出的粒子活不到可见，这组数据分不出）。
5. **可见性按脚本之前的状态**（同 P4c「粒子先于脚本」）：实测「按本帧」的变体四段都更差。

### 已知差异

都按「近似倒数不复刻」接受，或是能力表照报的残留行为：
- **`remapvalue` 输出 `speed` 且区间跨 0**：一遍模式下，`o` 过零的那一帧符号取决于 `rcpps` 和精确倒数的差，个别粒子会和 WPE 反向、之后整段反向运动（精确倒数下 `rv-noise` fps 60 有 6 个粒子·帧）。语料里 3815289650 有一处（`fbmnoise`、区间 −5..7），噪声驱动的粒子统计上看不出区别。
- **`maintaindistance*` 与 `vortex_v2` 的 `centerforce`**：`rsqrtps` 的随机游走与 `|P′|/h` 放大，见上「回放」；单步核对在包络内。
- **rope 的 alpha**：`age·rcpps(1)` 少算的量随年龄线性增长（`2254685070` 对照里 ≤ 2.7e-4）。
- **周期发射在计时余量极小时**：fps 10 的 `around-period` 有一个粒子我们早 11 帧发出（周期计时只剩 2e-4、发射余数 1.0001），没查清，留在子计划「未实测清单」；fps 60 逐帧对上。
- **工具边角**：kabegame-dev MCP 的 `particle_corners` / `render_scene` 不传 `fps`，低 fps 下 rope 的 `Rf` 仍按 60 算；dev `particleTrack` 对 rope 系统按槽序输出，不是表序；暂停时改 `instanceoverride` 的 `count` / `lifetime`，rope 的 `TL` 要到下一次步进才更新。

### 语料与解锁

覆盖的口径同 P4b、P4c：带粒子的场景里不报任何 `particle:*` 键的场景数（`ignore/p4/d7/coverage_p4d.py`，结果 `coverage.txt`）。语料在 P4d 期间从 152 个工程涨到 165 个（别的会话加了 13 张，都带粒子），两种口径都给：

| 口径 | 带粒子 | 粒子用法完全覆盖 | 能渲染 |
|---|---|---|---|
| 152 张（P4c 收尾时的名单） | 95 | 44 → 57；步骤 1–5、收尾 A 之后依次 53、53、57、57、57、57、57 | P4d 解锁 1 张（`2254685070`，步骤 1）；HEAD 共 38 张，其余 15 张来自同期别的阶段（P5a、P6a 等） |
| 165 张（现在的全集，基线是 P4c 收尾的代码 `c345e1cd` 重扫） | 108 | 46 → 61（后加的 13 张里 `3486806915`、`3660962877` 由 P4d 覆盖） | 同上，后加的 13 张都还不能渲染 |

- **P4d 去掉的键**（152 张口径的场景数）：`particle:renderer:rope` 22、`particle:initializer:mapsequencearoundcontrolpoint` 8、`particle:renderer:ropetrail` 8、`particle:operator:remapvalue` 2、`mapsequencebetweencontrolpoints`、`maintaindistancebetweencontrolpoints`、`reducemovementnearcontrolpoint` 各 1；165 张口径另有 `particle:operator:vortex_v2` 1。没有新增的 `particle:*` 键；165 张口径的 `3585875739` 把 `vortex_v2` 换成 `vortex_v2:audioprocessingmode`（两个粒子文件都是 mode 3，属 P4e）。kabegame-sample 各步另扫，步骤 5 之后粒子只剩 `particle:children`（另有 `object:shape`、`value:animation`、`depthtest:enabled`）。
- **新覆盖的 13 张**（152 张口径）：只差 `rope` 的 9 张、只差 `mapsequencearoundcontrolpoint` 的 2 张、两者都要的 2 张。只有 `2254685070` 能渲染；`3811764016` 只差 `object:shape`，其余还差文字对象、`model:*` 等 16–59 项。
- **`2254685070`**（收尾 A，鼠标拖尾，用户在测试窗口里移动鼠标抓帧）：绳逐顶点和 WPE 的 `gs_out` 最大差 1.72e-4 像素；挖掉绳的三角形后整帧最大差 1 个色阶；按反推出的光标时间线回放，段数逐帧相同（20 → 8），位置、`CP0` / `CP1`、`TL` 差 0。
- **还挡得最多的粒子键**（152 / 165 张）：`particle:children` 32 / 36（其中只差它的 22 / 24 张）、模块上的 `audioprocessing*` 字段各 2–8 张（P4e）；`particle:binding:instance:rate` 7 / 8、`colorn` 5、`count`、`size` 各 3（`{script}`，P4f）。
- **基线**：10 张干净场景 × 三档后处理共 30 个画面哈希，步骤 1、2、5、收尾 A 各自量过前后，全部相同；步骤 3、4a、4b 没有单独量，步骤 2 之后（`ignore/p4/d2/out/hash-after.json`）和步骤 5 之前（`ignore/p4/d5/out/hash-before.json`）的 30 个哈希逐个相同。

### dev 探针与对比台的增补

| 探针 | P4d 增补 |
|---|---|
| `particleCorners` | 程序带 `geometry` 时第 `id` 个调用算第 `id / maxVertices` 段的第 `id % maxVertices` 个顶点、按段读输入；结果多一个 `rope`（`maxVertices`，ropetrail 另有 `segments`），`corners` / `pixels` 每项是一段的整条带子（同 WPE `gs_out` 还原成带的顺序），rope 的 `particles` 按 rope 表排；选项多一个 `fps`（缺省 60） |
| `particleTrack` | 没有改：rope 系统仍按槽序输出 |

对比台在 `ignore/p4/`：
- 确定性工程：步骤 0 的 `gen_d.py`（`p4d-rope`、`p4d-ropetrail`、`p4d-map`、`p4d-remap`、`p4d-remap2`、`p4d-dist`），之后改用 `kbp gen`：`defs/p4d5.py`（`p4d-dist2`）、`defs/p4d6.py`（收尾 A 的 `p4d-close`、`p4d-close-rope`），以及 `d3/gen_around.py`（`p4d-around-ic`）。
- 回放案例 `cases/d1.json`、`d3`–`d6`（`kbp replay`，钩子 `*.hook.ts` 处理 fps 10 日志的缺帧、`R` 的注入与近似倒数的拟合）；离线展开 `kbp corners offline`；各步的快照、补丁与变异清单在 `d1/`–`d6/`，覆盖数在 `d7/`。
- WPE 参照：步骤 0 在 `A:\p4b\p4d-*`，步骤 3 之后在 `A:\p4d\`（wpe-renderdoc MCP 的 `capture_sweep` / `capture_wallpaper`），读取用 `kbp rdc track --points`；步骤 0 的旧轨迹（draws 认法）改名为 `*.rdc_rope.json`。

## 相机：视差、抖动与缩放（P5a）

视差、抖动和缩放都只改相机，不碰几何，也不新增图层种类：
- 每帧在帧开头求一次相机：抖动偏移 s、缩放 `zoom`、视差点 P。
- 每次绘制在视图投影上右乘一个平移。图像层（直接上屏、合成链的每个 pass、passthrough 上屏）和正交 / 透视粒子都经同一个入口 `GpuScene.uniformValues`。
- 同一节还有几条能力表的前置修正：材质 JSON 的注释、深度写入、`cropoffset` 与对象 `config`、模型 JSON 的布尔键。

依据：
- 读码：[rea-p5-camera](../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-camera.md) 5、6 节（抖动、视差）与 `p3-script-REPORT.md` L2（`zoom`）；前置几条在 [rea-p5-mesh](../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-mesh.md) 3 节、[rea-p5-modelflags](../../.claude/plans/wpe-import/3-scene/phase5/rea-p5-modelflags.md) 4、7 节。
- 确定性工程的实测：[报告](../../.claude/plans/wpe-import/3-scene/phase5/p5-REPORT.md)「P5a 语义的实测核对」（读码公式全部成立，补了 float32 临界与「P 不钳制」两处）与「收尾走查」（推翻一处：视差点初值）。
- 逐步的验收数据：[子计划](../../.claude/plans/wpe-import/3-scene/phase5/phase-5a-parallax.md)「实施记录」「P5a 收尾」。下面每条只点出依据是读码还是实测，数字和例外以子计划为准。

验收照 P4：
- 确定性工程的方块是纯色的，按 `g_Color` 认；CLK 层另读 `g_ParallaxPosition`、`g_EyePosition`。
- 按 WPE 日志的时间线回放到同一帧，和 `kbp rdc frame` 的整帧逐像素比；跟随指针的粒子另用 `particle_track` 逐个比。
- 结果：视差 7 组、抖动 5 组、缩放 5 组整帧 0 差异；真实样本按图层位置和相位相关比（见下「语料与解锁」）。
- 抓帧不移动用户的鼠标，指针从 CLK 层读；光标在动的抓帧用逐帧光标日志（见下「dev 探针与对比台的增补」）。

### 一帧里的顺序

`SceneRenderer.render`（`render/renderer.ts`）一帧：
1. 按本帧 `g_Time` 和**脚本之前**的 general 字段算抖动 s（`render/shake.ts`）、取 `zoom`；
2. 推进视差点 P（目标点以 s 作 eye），更新 `g_ParallaxPosition`（`render/parallax.ts`）；
3. `sync` → `stepParticles`：粒子模拟（跟随指针的控制点反投影）用的还是**上一帧**交给场景的相机，带上一帧的 s 与 `zoom`，不带视差；
4. `setCamera({ shake, zoom })`：改场景级视图投影、透视粒子视图投影与眼位；
5. 脚本（`beforeFrame`）；
6. `setParallax`：按**脚本之后**的开关与 `amount` 交本帧视差。视差或相机有一个变了，就把全部 draw 由图层与相机算出的 uniform 重写一遍，一帧至多一次；
7. `sync` → `update`（`g_ParallaxPosition` 随每帧 uniform 写）→ `encode`。

依据：
- 读码：WPE 一帧里先更新对象（粒子模拟，`FUN_1401891a0`），再更新相机（抖动、视差点），最后才跑脚本。
- 实测 `p5a-shakepar`：跟随指针的新生粒子，按「当帧指针 + 上一帧 s」误差 0，按当帧 s 差 0.3 像素。
- 实测 `p5a-wk-zoom3`：脚本写 `zoom` 后画面晚一帧、粒子模拟晚两帧。
- 实测 `p5a-wk-script`：脚本写 `cameraparallaxamount`、`parallaxDepth`，同一帧就画出来。

### 视差

| 项 | 规则 | 依据 |
|---|---|---|
| 目标点 | 指针先钳到 0…1、y 翻成向上（`mx = clamp(ptr.x)`、`my = clamp(1 − ptr.y)`），再在场景中心与指针之间按 `mi = cameraparallaxmouseinfluence` 插值：`P* = s + (W·(0.5(1 − mi) + mx·mi), H·(0.5(1 − mi) + my·mi))`。`mi` 不钳制，可以为负（语料有 −2、−0.21、−0.22）。W、H 是场景的正交尺寸，不是渲染目标 | 读码 6；实测 `p5a-ptr`：`mi` 1、0.5 时 P 为 (1920, 0)、(1440, 270)，各层偏移误差 0；`mi −2` 时反推 P = (−960, 1620)，在场景外 |
| 指针 | 用 `g_PointerPosition`（已按壁纸样式换算，`scenePointer`），和它同源，不是控制点跟随用的反投影。`fill` 下就是窗口归一化坐标，和 WPE 相同；`fit` / `center` / `tile` 换算到场景上，光标落在画面上，留白处被钳到边 | 读码；实测 `2381978484`（8192×5479 的场景放进 16:9 窗口，偏移仍按场景单位）；样式由真机走查 |
| 平滑 | `delay > 0` 时 `k = min(1, (1 − delay/3)·10·dt)`，`P ← P + (P* − P)·k`。dt 是本帧的帧时间（钳过的 `g_Frametime`），k 钳到 1 的帧照用。`delay ≤ 0` 时 P 直接取目标；补画帧 dt 为 0，P 不动。P 不钳制 | 实测 `p5a-delay27` / `29`：逐帧 k 和公式差 < 1e-5，用上一帧的 dt 对不上 |
| `g_ParallaxPosition` | `clamp(P / (W, H), 0, 1)`，只进 uniform，和对象平移无关；在 `ENGINE_UNIFORMS` 里，每帧写 | 实测 `3818481122`：`depthparallax` 读到 (0.75, 0.25)，它的图层深度 0、不动；`mi −2` 时为 (0, 1) |
| 对象平移 | `o = amount · depth(根) ⊙ (origin(根).xy − P)`，z 为 0。根是沿父链走到顶的对象（`layout.ts` 的 `rootObject`，父对象不在图层表里时当根）；`origin` 取当前值（属性、脚本写回之后）；缺省深度 (1, 1)。指针在中心时，原点不在中心的层也有偏移 | 实测 `p5a-static`（`mi 0`，P 恒为中心）7 个方块误差 0：(1460, 540) 深度 (1, 1) 偏 250，(460, 540) 深度 (−0.7, −0.7) 偏 175；根分组深度 (0, 0) 下深度 (1, 1) 的子方块不动 |
| 乘在哪 | 一个对象的每次绘制都把视图投影换成 `VP · T(o)`（`GpuScene.viewProjectionOf`）：直接上屏、effect 的中间 pass（它读的效果矩阵也带视差）、上屏 pass、正交与透视粒子。画进合成 RT 的基础 pass 用自己的整面矩阵，本来就不读 VP。粒子模拟与控制点的指针反投影用不带视差的视图 | 实测 `p5a-fx`：`cursorripple` 第一个 pass 读的 `g_EffectTextureProjectionMatrixInverse` 平移 −25，不带视差应为 −16.67；透视粒子的偏移和正交相同。`p5a-kinds`：跟随粒子的出生点正好是不含视差的反投影点 |
| 初值 | 加载时 P = (W/2 + 2, H/2 + 2)，`g_ParallaxPosition` = (0.5, 0.5)，开场从这里按 k 滑向目标。多出的 2 是 WPE 相机的缺省 eye：加载末尾按 `[G+0xf0]` + (W, H)·0.5 写初值（`0x14018870c`），那时场景的相机还没套进 `G+0xf0`，用的是函数开头写的缺省 (2, 2, 2)（`0x140186db3`）。之后每帧的目标点用真实的 eye，所以这 2 像素只在开场、按 k 衰减。P 归渲染器：重编译保留，渲染器第一次加载时才取初值 | **推翻读码**（读码是场景中心）：收尾走查 `p5a-wk-prop` 把开场残差按各帧 k 折回第 0 帧，四次都是 (2.00, 2.00)，再由 REA 反汇编查清。对齐后 P 和 WPE 反推值差 ≤ 0.001；步骤 2 的 `delay 2.9` 回放差 1 像素就是它 |
| 开关关掉 | `cameraparallax` 关着时 P 不推进（冻结），`g_ParallaxPosition` 保留上一次的值（加载时是 (0.5, 0.5)），不加平移。再打开时 P 从冻结的值接着走，不回中心 | 实测 `p5a-wk-noplx`：没开视差时 `g_ParallaxPosition` 恒为 (0.5, 0.5)。`p5a-wk-prop` 运行中关、开：关着时偏移 0、uniform 不变；「关着照常推进」差 78 像素，「再开时回中心」差 778 像素 |
| 属性与脚本 | `cameraparallax*` 四个字段在 `GENERAL_FIELDS` 里，渲染器每帧读 `SceneState.general`，绑属性就地写。推进 P 用脚本之前的值；绘制时的开关与 `amount` 取脚本之后的值（WPE 绘制时才读，读码 6.3）。`parallaxDepth` 是图层字段：编译期缺省 (1, 1) 并登记绑定，绑属性就地写，挂 `{script}` 的字段脚本写回到它，`thisLayer.parallaxDepth` 读写是 `Vec2`。它和 `origin` 一样整棵子树标脏（子孙的偏移看根）；绑单个数字的属性时铺满两个分量 | 实测 `p5a-wk-script`：6 帧都用这一帧写的 `amount` 与深度画；`p5a-wk-prop`：绑滑块 0.6 时深度 (0.6, 0.6)，运行中改成 0.3 就地生效、不重新加载 |

能力表不再报 `general:cameraparallax`、`uniform:g_ParallaxPosition`，`thisLayer.parallaxDepth` 从脚本 API 缺口表里删掉。

### 抖动

| 项 | 规则 | 依据 |
|---|---|---|
| 公式 | `e = powf(roughness, 3)`；`T = speed²·g_Time`（场景时间，已回绕）；`v = (cos T, sin 1.333T)`（正交时 z 清零）；`0.001f < e` 且 `e ≠ 1` 时把 v 的长度 L 换成 `L^e`、方向不变；`s = v · 0.01·amplitude·H`（`render/shake.ts` 的 `shakeOffset`）。没有随机源，也没有跨帧状态，给定 `g_Time` 就能复现 | 读码 5（`FUN_140199580`）；实测 5 组各 4 帧，`g_EyePosition` 的偏移和公式差 ≤ 1e-4；`roughness 2`（e = 8）改了长度，0.05 不改 |
| float32 | 每步按 `Math.fround` 取整，比较的常量也是 `0.001f`。`roughness 0.1` 时 `powf(0.1f, 3)` 正好等于 `0.001f`，「e > 0.001」为假，不改长度；按 double 算会进改长度的分支，差约 2.5 像素 | 实测 `p5a-shaker01`；单测 `render/shake.test.ts` 能区分两种算法 |
| s 进哪里 | eye 和 center 加同一个 s，正交视图就是 `T(−s)`。每次绘制的视图投影是 `VP · T(o − s)`（没开视差时 `VP · T(−s)`），透视粒子也一样。`g_EyePosition` 是 `(W/2 + sx, H/2 + sy, 2000)`，拖尾判退化的眼位（`trailEye`）读同一个值；视差目标点的 eye 就是 s | 实测 `p5a-shake*`：图层整体平移 −s；`3830255100` 的 `g_EyePosition` 偏 (8.717, 10.165)，17 个对象按「抖动 + 视差点」预测全部吻合 |
| 时机 | 帧开头按本帧 `g_Time` 和脚本之前的字段算，脚本写 `camerashake*` 下一帧生效。粒子步进之后才交给场景（`setCamera`），所以粒子模拟用上一帧的 s；加载后第一帧的模拟与预热用 s = (0, 0) | 读码帧顺序；实测 `p5a-shakepar`（见「一帧里的顺序」）。预热那一条是推断，见「已知差异」 |
| 刷新 | `setCamera` 只改场景级的视图投影、透视粒子视图投影与眼位；全部 draw 的重写和视差合在一次，在 `setParallax` 里。`g_EyePosition` 为此进了 `LAYER_UNIFORMS`。关着时 s 恒为 0，矩阵与眼位逐字节同以前 | — |
| 透视场景 | 透视下幅度是 `0.1·amplitude` 个世界单位、偏移是三维的，归 P5d：能力表只在透视场景报 `general:camerashake`（透视场景整张另报 `camera:perspective`） | 读码 5 |

### 缩放

| 项 | 规则 | 依据 |
|---|---|---|
| 投影 | 正交投影绕场景中心缩放，即 `S(zoom) · P`：x、y 的线性项是 `zoom·2/W`、`zoom·2/H`，按 float32 乘（`layout.ts` 的 `sceneViewProjection(general, zoom)`）。视差偏移与抖动都是场景单位，在缩放之前加，方块的矩阵 = 缩放后的正交投影 · `T(o − s)` | 读码 p3-script-REPORT L2（`0x14017fd50`）；实测 `p5a-zoom15` / `zoom08` 线性项逐位相等，`zoompar` 偏移误差 0，`zoomx*` 差 1e-7 |
| 相机 zoom | WPE 乘的是 `general.zoom × 相机 zoom`。P5a 没有相机对象，相机 zoom 恒为 1；P5d 接上相机来源后再乘 | 读码 |
| 透视粒子 | 相机距离随缩放变：`d = (H/(2·zoom))/tan(fov/2)`，far 仍是 `max(15000, d + 1000)`（`particleViewProjection(general, zoom)`） | 读码 7.2；实测 `p5a-zoomx15` / `zoomx08`：3 帧 MVP 和 WPE 逐项差 < 1e-4，按不带缩放的 d 差上百 |
| 不随缩放变 | `g_EyePosition`（只带抖动）、视差点与 `g_ParallaxPosition`（按场景宽高）、`g_PointerPosition` | 实测，同上 |
| 跟随指针 | 控制点的指针反投影用带缩放的投影，同样是上一帧交给场景的 | 实测：跟随粒子出生点误差 ≤ 3e-4，不带缩放差几百像素 |
| 时机 | 和 s 同一时刻取（脚本之前），一起交给 `setCamera`，`zoom` 变了才重算两份基准矩阵。脚本在第 f 帧写 `zoom`：第 f + 1 帧的画面用它，第 f + 2 帧的粒子模拟才用它。建场景时取编译期的值，预热的反投影带上它 | 实测 `p5a-wk-zoom3`（`zoom` 按帧号 mod 3 轮换）：画面 9 帧都是上一帧写的，跟随粒子 12 个新生点都按两帧前写的 `zoom` 反投影，差 ≤ 2e-4 |
| 字段与能力表 | `zoom` 进 `GENERAL_FIELDS`（float，缺省 1），绑属性就地写，`thisScene.zoom` 能读写（从脚本 API 缺口表删掉）。能力表只在正交场景、不绑属性、解析出的值 ≤ 0 时报 `general:zoom`（投影退化、反投影是 NaN），绑属性时不看值；透视场景里 `zoom` 不起作用（读码 1.4：读取点都在正交分支），不报 | 读码；语料最小 1.0 |

### 开场指针

视差点、`g_ParallaxPosition` 和跟随指针的粒子都要从第一帧起就用真实光标。WPE 每帧 `GetCursorPos`，加载第一帧就用真实光标。我们的宿主原来只在收到 `pointermove` 时更新指针：预览 iframe 开场收不到，桌面鼠标转发只在光标移动时注入。所以打开后视差停在中间，鼠标动一下才滑过去（2026-11-11 真机走查发现，跟随指针的粒子同样受影响）。现在让宿主一开始就拿到一次真实光标：
- **只在可交互时**：应用页 `WpeSceneView`（预览与桌面共用）在 `interactive` 时，于 iframe `load` 与宿主 ready 各调一次 `wpe_scene_cursor`。非 `interactive`（应用背景、不交互的预览）照旧不给指针，视差目标点就是场景中心加 s，只剩静止偏移。
- **Rust**：`wpe_scene_cursor` 在 `src-tauri/kabegame/src/commands/wpe_scene.rs`，`wpe` feature 下注册。Windows 用 `GetCursorPos` + `ScreenToClient`，再除以 `dpi/96`，得到光标在调用方窗口客户区的 CSS 像素，和鼠标转发同一套映射；其它平台返回 `null`。问 Rust 而不只用父页面记的鼠标位置，是因为桌面壁纸窗口的页面收不到鼠标事件，只有注入给 iframe 的。
- **应用页**：按 iframe 的显示矩形换成 iframe 内的归一化坐标，不钳制（`wpeSceneStyle.ts` 的 `scenePointerIn`），经 `kabegame:wpe-scene-pointer` 交给宿主。命令返回 `null`、出错，或在 Web / Android 上时，退回本页最近一次 `pointermove` / `pointerdown`，也没有就不发；等命令期间换了宿主也不发。
- **宿主**：`sceneStyle.ts` 只认父窗口发来的可信消息，当一次 `setPointer`；收到过真实 `pointermove` 之后，初值作废（`scenePointerFeed`）。`SceneHost` 记住最近的指针，渲染器建好时先于 `load` 带进去，`load` 按新场景的铺放换成 `g_PointerPosition`，所以预热与第一帧就用它。

实测：
- 主窗口：`wpe_scene_cursor` 返回 (355.3333, 436)，和页面最后一次 `pointermove` 相同。
- 预览 iframe（「超市冰箱八奈见」）：按初值算法算出 (0.500042, 0.499611)，宿主收到的真实 `pointermove` 是 (0.499999, 0.499092)，差 < 0.4 物理像素。

数据流的其它部分见「粒子（P4c）」的「指针」。

### 前置几条

| 项 | 规则 | 依据 |
|---|---|---|
| JSON 注释 | WPE 用 jsoncpp 读 JSON，缺省允许注释。`parseWpeJson`（`compile/model.ts`）严格解析失败时先去 `//` 行注释与 `/* */` 块注释（字符串里的原样保留），再去尾逗号 | 实测：带 `//` 注释行的材质照常加载（步骤 0）；整行与行内的 `/* */` 同样（收尾走查 `p5a-wk-prop` 的方块 F）。语料只有 fantasticcar 的 `materials/car/glass.json` 一处 |
| 深度写入 | translucent / additive 的 pass 一律不写深度，`depthtest: disabled` 也连带不写。这两种情况下 `depthwrite: enabled` 中性、不报（`features.ts` 的 `writesDepth`）；其余照报 `depthwrite:*`，留给 P5d | 读码 rea-p5-mesh 3.4；实测：translucent / additive 写 `enabled` 时深度开、不写、GREATER，normal 时开、写，`depthtest: disabled` 时深度关 |
| `cropoffset`、对象 `config` | 中性。`cropoffset` 是编辑器裁掉透明边后的偏移，导入时已经并进 `origin`（`wallpaper64.exe` 里没有这个字符串）；对象 `config` 只在托盘与播放列表代码里读 | 实测：写了 `cropoffset "100 100"` 的层、带 `config.passthrough` 的层都画在原点，和对照层相同 |
| 模型 JSON 的布尔键 | `fullscreen`、`nopadding`、`autosize`、`passthrough`、`solidlayer`、`projectlayer`、`instanced` 只认 JSON `true`（`modelFlag`），写成 1 或字符串等于没写；能力表和 `bundle.ts` 读 `solidlayer` 用同一个判断 | 读码 rea-p5-modelflags §7；实测：`fullscreen: 1` 的层照常按 60×60 画在原点 |

语料里模型布尔键全写成 `true`，带注释的 JSON 只有 fantasticcar 一个，所以收紧与注释支持都不改变已有结果。

### 已知差异与只记不补

- **`delay > 3`**：k 为负，P 越走越远。照公式实现，没有实测；语料的 `delay` 最大 2.0。
- **预热时的抖动**：预热与加载后第一帧的粒子模拟用 s = (0, 0)。依据是推断：模拟用上一帧的相机，加载时还没有更新过相机。t = 0 时抖动偏移是 (amp, 0)，不是 0；语料里同时开抖动和跟随指针的场景很少，只记不补。
- **重编译时的 `zoom`**：预热与第一帧的模拟用编译期的 `zoom`。属性改 `zoom` 是就地写、不重编译，只有因别的原因整场重编译、而状态里的 `zoom` 已经改过时才碰得到。只记不补。
- **`zoom` ≤ 0**：运行中改成 ≤ 0 时投影退化、出现 NaN，不处理；能力表只拦编译期的常量（语料最小 1.0）。
- **`alignmentfliph`**：水平镜像时 WPE 把 `mx` 换成 `1 − mx`、`g_ParallaxPosition.x` 翻转。没实现，语料 0 张。
- **命中测试的视差偏移**：WPE 按对象自身（不按根）算，没做，归 W4 的按图层命中。
- **透视场景开视差**：WPE 不移动对象（读码，语料 0 张）。透视场景整张报 `camera:perspective`；P5d 实现透视时，连同透视场景里 `g_ParallaxPosition` 除以 0 再钳制的结果一起核对。
- **壁纸属性 `cameraparallax`**：WPE 设置里给单张壁纸的开关，只把 `mouseinfluence` 归零，静止偏移不变。Kabegame 没有这个开关，按缺省（开）处理。
- **首帧的 `g_PointerPositionLast`**：开场指针之后，首帧的 `g_PointerPositionLast` 仍是 (0.5, 0.5)，和初值之间有一次跳变；WPE 首帧没有核对。
- **P 的精度**：我们用 double 算 P，WPE 存 float32；按 float32 复算差为 0（`fit_delay.py`），接受。

### 语料与解锁

| 步骤 | 去掉的键 | 能渲染 | 新解锁 |
|---|---|---|---|
| 1 前置 | `model:cropoffset` 34 张、`object:config` 14、`depthwrite:enabled` 5 | 23 → 24 | `3778549173` |
| 2 视差 | `general:cameraparallax` 41、`uniform:g_ParallaxPosition` 16、`script:api:layer.parallaxDepth` 1 | 24 → 35 | `2272499163`、`2279259068`、`2381978484`、`2382002554`、`2382120706`、`2382121137`、`2570822804`、`2955749185`、`3000769374`、`3445915391`、`3818481122` |
| 3 抖动 | 正交场景的 `general:camerashake` 7 | 35 → 36 | `3830255100` |
| 4 缩放 | `general:zoom` 6 | 36 | 不单独解锁：这 6 张还被别的键挡着（`2887099508` 的 `zoom` 是关键帧，报 `value:animation`） |

- 每步都不新增键，没有场景不再能渲染。起点是 23 而不是子计划开头写的 22，因为同期 P4d 解锁了 `2254685070`。去掉 `depthwrite:enabled` 的 5 张逐个材质核对过，都属于中性情况。
- **解锁的场景**：
  - 步骤 2 的前 10 张是同一类模板：1–2 个图像层，其中一个带 effect，深度 `0 1` 或 `0 2`，只在纵向动；原点都在场景中心，静止时没有偏移。
  - `3818481122` 的唯一图层深度 (0, 0)、不动，它的 `depthparallax` effect 读 `g_ParallaxPosition`。
  - `3830255100` 有 14 个图像层和 3 个粒子，原点偏离中心几百像素、深度 0.44–1.87，`mouseinfluence` 只有 0.04。它是检验「静止偏移」与抖动的真实样本。
  - `3778549173` 只差一个粒子 pass 的 `depthwrite: enabled`：这个 pass 是 translucent、`depthtest: disabled`。
- **和 WPE 比**：
  - `3778549173`（2560×1440 窗口、fps 20）：静态部分没有一个像素比 WPE 暗，96.86% 完全相同，更亮的 2.65% 是粒子；按均匀帧时间回放粒子，灰烬 2306 对 2306–2316，尺寸、透明度、颜色范围逐位相同，雪花、光晕相近。
  - `2381978484`、`3445915391`、`3818481122`（步骤 0 的 1344×756 抓帧）：按回放渲染整幅场景，照 WPE 的居中裁切缩到同一尺寸，相位相关估计的平移都是 (0, 0)，平均像素差 0.6–2.3（缩放重采样）。`2381978484` 的视差偏移在这个尺寸下约 67 像素，所以这个比较能检出视差错误。
  - `3830255100`（1920×1080）：按 WPE 各层的偏移反推，17 个对象给出同一个视差点（离散 0.001 像素），抖动和 `g_EyePosition` 差 1e-4；按同一 `g_Time` 回放渲染，平均差 0.96，大于 32 的像素占 0.038%（只在轮廓线），5 块区域的平移都在 0.08 像素以内。
- **真机走查**（2026-11-11 用户）：预览里移动鼠标、壁纸样式、桌面壁纸跟随、暂停与应用背景都和预期一致；桌面上光标停在别的窗口上移动时也跟随，和 WPE 相同（Windows 的鼠标转发是轮询光标）。开场原先停在中间，补了上面的「开场指针」后在预览里确认。
- **基线**：10 张原本能渲染的场景 × 三档后处理，共 30 个画面哈希，在步骤 2、3、4、视差点初值对齐与逐帧光标之后各量一次，都和之前的基线相同。基线里没有开视差的场景，所以初值对齐只能说明没改坏别的，对不对靠上面的数值核对。

### dev 探针与对比台的增补

| 探针 | P5a 增补 |
|---|---|
| `renderFrame` | 从加载起逐帧推进视差点与抖动：每帧按 `g_Time` 现算 s，粒子先用上一帧的相机步进，再设本帧的，读回帧带视差与 `g_ParallaxPosition`（步骤 2–4）。收逐帧指针 `pointers`（和 `particles.dts` 等长，不能和 `pointer` 同给）与抓帧窗口 `window`：第 i 帧的 `g_PointerPosition` 取 `pointers[i]`，`g_PointerPositionLast` 取 `pointers[i − 1]`，视差点逐帧用它；控制点光标按 `fill` 从窗口换到场景上，窗口和场景同尺寸或没给 `window` 时原样用（收尾前） |
| `particleCorners` | 同 `renderFrame`。两者「回放到读回帧」的部分合成一处（`replayReadback`），窗口指针的换算在 `dev/replayPointers.ts` |
| `particleTrack` | 跟随点带上一帧的 s 与 `zoom`；`cursors` 收 `window`，按 `fill` 换到场景上 |
| 不给新字段时 | 三个接口逐字节同以前（`kbp regress --corpus` 与画面哈希核对过） |

**回放逐帧光标**（收尾前补的工具）。起因：WPE 开窗后光标在动，跟随指针的粒子、视差点都复现不了，而 RenderDoc 轨迹只有被抓的那几帧有指针。所以光标从测试工程自己的脚本日志取，和 WPE 的帧天然对齐：
- **日志**：kbp-tools 生成库 `write_project(…, cursor=True)` 时，FR 用 `FR_CURSOR`，`[kbp]` 条目是五列 `帧号,帧时间,累计时间,屏幕x,屏幕y`。屏幕坐标是 `input.cursorScreenPosition`，每 10 条刷一次，取不到写 `nan`。缺省仍是三列，旧工程逐字节相同。这类工程在 Kabegame 里编译报 `script:api:input.cursorScreenPosition`（`input` 留给 P6），dev 强制渲染不受影响。
- **时间线**（kabegame-dev MCP 的 `apps/kabegame-dev-mcp/src/timeline.ts`）：新增 `cursors: "log"`，第 f 帧光标 = float32(日志第 f 帧的屏幕光标 / 窗口尺寸)，缺的帧沿用相邻帧并列出来，抓到的帧上和轨迹的 `pointer` 逐帧核对。`window` 缺省从轨迹或日志标签末尾的 `-<宽>x<高>` 读。`"track"`、整串、`cursor` 的单位统一成 `g_PointerPosition`（窗口归一化）。`render_scene`、`particle_corners` 把光标作 `pointers` 连同 `window` 交给探针，`particle_track` 交 `cursors` + `window`。`kbp replay` 案例的 `inputs.cursors` 同样收 `"log"`。
- **依据**：`p5a-cur` / `p5a-cur3` 实测 `cursorScreenPosition` 是壁纸窗口内的像素、y 朝下、不钳制，`g_PointerPosition` 逐位等于 float32(屏幕光标 / 窗口尺寸)。脚本、uniform、粒子模拟用的是同一帧的同一次采样：按日志第 f 帧回放第 f 帧，491–495 个跟随粒子差 ≤ 2.4e-4，错一帧差 340 像素。
- **端到端**：`p5a-shakepar2`（用户在窗口上画圈时抓帧）经 `render_scene`（`cursors: "log"`）整帧和 WPE 比，FR 块外 0 差异，跟随粒子与透视粒子 1800 个白色像素全部相同。

对比台在 `ignore/p5/`：
- 确定性工程：`a0/gen_a.py`（步骤 0 的 `p5a-*`，之后各步按 1920×1080 窗口重抓）、`cur/gen_cur.py`（`p5a-cur*`）、`wk/gen_wk.py`（收尾走查的 `p5a-wk-*`），工程放在 `proj/`。
- 读数：`a0/rdc_dump.py` 在 `qrenderdoc --python` 下无界面导出整批抓帧的常量，`ana_a.py` / `ana_pre.py` / `ana_real.py` 核对。
- 各步的快照、补丁、语料比较与整帧比对在 `s1/`–`s4/`（`cmp_frames.py`、`follow_cmp.py` 等），逐帧光标在 `cur/`，开场指针在 `ptr/`，收尾走查在 `wk/`。
- WPE 参照：步骤 0、1 在 `A:\p5a\`，之后在 `A:\p5a2\`（wpe-renderdoc MCP 的 `capture_wallpaper` / `capture_sweep`）。

## 声音（P6a）

声音对象不画东西：在 `layers` 里仍是一个没有 pass 的图层（层级、名字、`getLayer` 照旧），播放字段另进 bundle 的声音表，由宿主按 WPE 的规则排期播放。渲染图不碰。依据：读码 [rea-p6a-sound](../../.claude/plans/wpe-import/3-scene/phase6/rea-p6a-sound.md)，实测 [p6-REPORT](../../.claude/plans/wpe-import/3-scene/phase6/p6-REPORT.md)「P6a 声音语义的实测核对」（冲突时以实测为准，读码的结论除暂停淡出外都已实测成立）。

分四层，彼此只经很窄的接口相连：

| 层 | 位置 | 做什么 |
|---|---|---|
| 声音表 | `compile/sounds.ts` → `SceneBundle.sounds` | 有非 null 的 `sound` 键就是声音对象（`features.ts` 的 `isSoundObject`，空字符串、空数组也算）。文件按场景的资源查找顺序定位，记磁盘位置（散文件 / `scene.pkg` 加偏移）；找不到的、扩展名不是 wav / ogg / flac / mp3（不分大小写）的不进表。缺省值 `volume` 1（不钳制）、`mintime` 1、`maxtime` 5、`loop`、`startsilent` 假 |
| 排期器 | `audio/scheduler.ts` | 纯 TS、Node 可单测，一个声音对象一个。照读码的 `P`（开始 / 续播）、`U`（每帧）、`V`（音量回调）、`X`（停掉全部）与全局音量规则复刻状态机，只对抽象后端发命令；`play` / `pause` / `stop` / `isPlaying` 也在这里，宿主经 `ScriptApiState.sound(object)` 交给声音层的脚本对象（`script/api.ts`，步骤 2） |
| 播放后端 | `audio/player.ts` | 场景一个 `AudioContext`，每个文件一个 `<audio>`：散文件用 `file:` 地址，pkg 条目按区间读成 Blob（同一条目只读一次）。元素 → `MediaElementAudioSourceNode` → 本声音的增益 → 淡变增益 → `destination`。不整段解码（语料最大一段 114 MB FLAC） |
| 宿主接线 | `audio/sceneSounds.ts`、`host.ts`、`main.ts` | 宿主收到 bundle 就建、立即开始（不等 GPU，WPE 加载时就放）；渲染器每个实时帧在粒子步进之后、脚本之前调 `stepObjects(dt)` 推进排期器（补画帧、暂停时不调，计时冻结）；重编译时声音表没变的对象保留排期器、播放不中断；退回预览图与销毁时释放元素、Blob 和 context |

**播放规则**（实测）：
- `loop` 单文件：元素自己无缝循环。`loop` 多文件：每个放一遍、到时长后带放回随机换下一个（可以连选同一个），中间不留空，切换落在帧边界。
- `single`：放一遍，`isPlaying` 在时长内为真、之后为假，不自动重放。放完之后 `pause` 再 `play` 会从头重放一遍而 `isPlaying` 仍为假（包装层状态自然放完不变，照搬）。
- `random`：从开始播放算起，等「时长 + U(mintime, maxtime)」秒再随机选下一个；两段之间 `isPlaying` 仍为真。选文件与等待的随机数用宿主自己的随机源（WPE 用 CRT `rand()` 与粒子共用的 mt19937，序列本来对不上），只照规则。
- `startsilent`：不放，直到脚本 `play()`。对象音量或全局音量为 0 时不开始、不读文件，变成正数时才从文件开头放（`single` 例外，WPE 的音量回调跳过它）。
- 可见性不影响声音：自身或父层不可见照样放。多个声音在同一次调用里按对象顺序开始。

**音量**：WPE 的增益是 `min(1, volume² · G)`（对象音量取平方，钳在乘积上，实测 `p6a-vol2`），没有渐变。我们的 G 是宿主音量 h：垫片把父页面的音量放进只读的 `window.__kabegameHostVolume` 并派发 `kabegame-host-volume`（只当通知，值总从只读属性读），宿主经 `setHostVolume` 收下；暂停或文档隐藏时 G 为 0。垫片的主增益已经乘 h（接进 Web Audio 的元素不在元素上再乘），所以每个声音的增益节点设成 `min(1, volume²·h) / h`。G 从正变 0：暂停在放的，`single` / `random` 已放完的停掉，计时冻结；从 0 变正：续播，从没开始过的从头开始。`volume` 绑用户属性是就地目标（`{ kind: "sound" }`，`SceneState.sounds`），改值当场生效；脚本写 `volume`（API 写入或字段脚本写回）走同一条路，同样当场生效。

**暂停**：WPE 暂停时全局音量按 `k = min(1, 6·dt)` 指数淡出再暂停、恢复时淡回。播放器的淡变增益用 `setTargetAtTime`（时间常数 1/6 s）；但暂停消息到达时垫片的主增益已立即变 0、排期器也立即暂停元素，所以只有恢复时的淡入听得见。文档隐藏（渲染循环停转）按暂停处理。

**脚本控制**（步骤 2）：只有声音对象的图层有 WPE `ISoundLayer` 的 `play`（= `P`：暂停中续播，否则停掉、重新随机选、从头放）、`pause`、`stop`（= `X`：停并回到开头）、`isPlaying()` 和可读写的 `volume`，别的图层调用照旧报 `TypeError`（WPE 的方法按对象类型登记）。`volume` 读 `SceneState.sounds`，写入落到就地目标、不钳制，宿主写完当场交给排期器（暂停时也生效）；声音对象的 `volume` 挂 `{script}` 时，字段脚本的返回值每帧写回同一个目标。没有播放器时（宿主没建、或已退回预览图）方法什么都不做，`isPlaying` 为假。真机和 WPE 逐条对过 `p6a-play` / `p6a-single` 的调用前后 `isPlaying` 与录音段序列（含 `single` 放完后 `pause` 再 `play` 会重放而 `isPlaying` 仍假）。

**能力表**：不再报 `object:sound` 与声音对象自己的键（`muteineditor`、`attenuation`、`mindistance` 中性）。新键：`object:spatialization`（三维声音，语料 0 张打开）、`sound:playbackmode:<值>`、`sound:binding:<键>`（`playbackmode` / `mintime` / `maxtime` / `startsilent` / `spatialization` 绑了属性或脚本，WPE 没有回调）。场景里有粒子层时，任意接收者访问 `play` / `pause` / `stop` / `isPlaying` 都报 `script:api:particle.<名>`（`scriptApi.ts` 的 `PARTICLE_LAYER_METHODS`）：WPE 的粒子系统也有这四个方法（P4f），而语料里这些调用的接收者绝大多数静态认不出类型，所以宁可多报；这张名单不进 `MISSING_SCRIPT_API`，P4f 实现后删掉。

**已知差异**：
- 开始是异步的：元素拿到元数据才从头放并回报时长，`T` / `Rm` 从那一刻起算；WPE 是同步读完整个文件。等回报期间 `isPlaying` 按 WPE 当场的值（真）。
- 文件读不出在开始时才知道：照 WPE 从列表删掉（宿主记 warn），正在等它开始的用剩下的文件重新选。
- 单声道源：WPE 在本机每个前置声道约 −4.1 dB（OpenAL Soft 的声像，随输出设备变），Web Audio 原样复制到两个声道，同一文件我们这边约响 4 dB，不补偿。
- 预览与桌面同时放同一张场景时各放各的，同网页壁纸。

**语料**（165 个工程）：能渲染 36 → 38（`1967162875`、`3827677885`）；带声音的 77 张里去掉 `object:sound` 及其键，不含声音对象的场景不变。步骤 2 之后仍 38 张：`script:api:layer.*` 与 `sound:volume:script` 消失，有粒子层的场景报 `script:api:particle.play` 38 张、`stop` 29、`pause` 16、`isPlaying` 8。`1514925620`、`3778592720` 只剩 `particle:children`。

**dev 探针**：`__kabegameSceneProbe.host.sounds()` 给宿主音量、暂停 / 隐藏，每个声音对象的模式、当前文件、可用文件、实例状态、`T`、`Rm`、`isPlaying`、增益，以及播放器的 context 状态、淡变值、Blob 数与各元素的状态。
