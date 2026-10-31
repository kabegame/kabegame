# WPE Scene 壁纸 · 阶段 3 前期调研

> 状态：调研完成（2026-10-26），未写任何代码。上级：[../PLAN.md](../PLAN.md) 决策 9（Scene 走 WebGPU）。
>
> 证据标注：**[本机]** 本机 WPE 安装（WE 2.8.0.42，`D:\Applications\Steam\steamapps\common\wallpaper_engine`）的 assets / 默认项目；
> **[REA]** 对 `wallpaper64.exe`（SHA-256 `40e2ce02…`）的 Ghidra 静态分析，只读已定义字符串与数据区，未观察执行；
> **[DLL]** 对 `bin/scenescript64.dll` 的字节扫描；**[LWE]** 社区实现 linux-wallpaperengine（非官方，GPLv3，C++/OpenGL 3.3）；
> **[RePKG]** 社区解包器（非官方，MIT）；**[官方]** docs.wallpaperengine.io；**[真机]** 在运行中的 Kabegame dev（CEF 149）里只读求值。
> 社区资料与 REA 冲突时以 REA 为准并注明。

---

## 一、结论摘要

**Scene 由什么组成。** 一个 Scene 壁纸是 `project.json`（`type: scene`，`file` 指向 `scene.json`）加一组资源：`scene.json` 描述相机、
全局参数（bloom / 视差 / 清屏色 / 正交投影尺寸）与按序合成的图层（image / particle / sound / text / light / model）；image 图层指向
`models/*.json` → `materials/*.json` → shader 名 + `.tex` 纹理；每个 image 图层可挂一串 `effects`，每个 effect 是一组全屏 pass
（`effect.json` 声明 passes / fbos，pass 指向材质，材质指向 `shaders/effects/*.frag|vert`）。粒子由独立 `particles/*.json`
（emitter / initializer / operator / renderer / controlpoint / children）驱动。SceneScript 是嵌在 `scene.json` 属性值里的 ES 模块源码。
创意工坊发布时这些文件打进 `scene.pkg`（简单目录表容器）、纹理统一是 `.tex`（自有容器，LZ4 分块，支持 DXT / RGBA8 / R8 / RG88 等与
动画帧表）。本机 **19 个默认项目全部是未打包形态**（没有任何 `scene.pkg`），而创意工坊目录里**没有 scene 型**，所以 pkg 解析只能靠
社区规格 + 以后自测订阅。

**shader 方言是什么。** 作者用 GLSL 风格书写（`attribute` / `varying` / `uniform sampler2D` / `gl_Position` / `gl_FragColor`），但调用的是
WPE 自己的中性内置函数（`texSample2D`、`mul`、`frac`、`saturate`、`CAST2/3/4`、`CAST3X3`）。**[REA] Windows 上 WPE 把它翻成 HLSL：**
二进制内嵌了一张宏头（`#define vec2 float2 … #define texSample2D(s,u) s.Sample(s##SamplerState,u)`）、`#define HLSL 1 / HLSL_SM40 1`、
以及用正则 + 模板生成 `cbuffer`、`struct VS_INPUT / VS_OUTPUT / PS_INPUT / PS_OUTPUT`、`VS_OUTPUT main(VS_INPUT IN)` 的源到源翻译器，再经
`d3dcompiler_47.dll` 的 `D3DCompile` 编译到 `vs_5_0 / ps_5_0 / gs_5_0`（回退 `4_1`），缓存为 `shaders/blobsSM40/<sha1>.dxs`
（`SHDV0069` + `DXBC`）。Android 包用 GLES3（`blobsGES3/*.gxs`，`SHDD0066`）。这说明方言本身**不绑定任何真实 API**，是一门小 DSL，
翻到 WGSL 与翻到 HLSL 是同构的工作。

**WebGPU 路线可行性：可行，且比预想的顺。** [真机] 当前 CEF（Chromium 149）主窗口里 `navigator.gpu` 可用，适配器为 NVIDIA，
features 含 `texture-compression-bc`（DXT1/3/5 可直接上传，无需 JS 解压）、`shader-f16`、`float32-filterable`、`dual-source-blending`、
`timestamp-query`；`maxTextureDimension2D` 16384、`maxBufferSize` 2 GiB；WebGL2 同样可用。SceneScript 的宿主引擎是 **V8**
（[DLL] `scenescript64.dll` 28 MB，含 837 处 `V8` / 250 处 `v8::`、`import.meta`、`BigInt`），不是 LWE 用的 QuickJS——Kabegame 直接在
浏览器 V8 里以 ES 模块跑作者脚本即可，语义最接近原版。

**三大风险。**
1. **shader 方言的完整覆盖**：137 个内置 shader + 46 个 effect（173 对 frag/vert）+ 粒子 shader，大量 `#if COMBO` 分支、
   `mat4x3 g_Bones[]` 骨骼、几何着色器（`.geom` 4 个，粒子在 D3D 用 GS 展开 billboard，GL 路径用顶点着色器展开）。WGSL 没有几何着色器、
   没有预处理器，翻译器必须自带预处理（`#include` / `#if` / COMBO 展开）并把 GS 路径改走 `HLSL_GS40_DISABLED` 的顶点分支。
2. **pkg / tex 只能靠社区规格**：本机无 `.pkg` 样本；`.tex` 有 440 个样本可验证解析器，但 `TEXB0004` 的 mp4 视频纹理、`TEXS` 动画帧与
   `rgba1010102 / rgba16f` 等新格式在本机样本里缺席。
3. **效果与粒子的行为语义**：46 个 effect 的 pass 组合（fbo 缩放、`previous` 绑定、ping-pong）与 60 余个粒子 initializer / operator /
   renderer 的数值语义，公开资料只有 LWE 的部分实现（它明确不支持光照、puppet 之外的 passthrough、部分 renderer），要靠本机默认项目
   逐个对照。

---

## 二、资源清单

### 2.1 本机 `assets/` 统计 [本机]

| 目录 | 文件数 | 内容 |
|---|---|---|
| `shaders/` | 137 | 59 `.frag` + 59 `.vert` + 4 `.geom` + 14 `.h` + 1 json；`HLSL/` 7 个 DX11 回退 / 播放列表过渡 shader；`base/` 2 个 model 头 |
| `effects/` | 1041 | 46 个 effect 目录，各含 `effect.json`、`materials/`、`shaders/`、`preview/`；合计 173 frag / 173 vert / 540 json / 74 tex |
| `materials/` | 585 | `cookie / editor / fonts / gradient / lut / models / particle / pattern / util`；229 tex + 200 tex-json + 52 gif |
| `models/` | 7 | `util/{composelayer,composelayer_depthtest,fullscreenlayer,projectlayer,solidlayer,solidlayer_depthtest}.json`、编辑器相机 `.mdl`（`MDLV0017`） |
| `particles/` | 6 | 示例粒子 json |
| `presets/` | 880 | 编辑器预设（813 json） |
| `scenes/` | 249 | `gifs`（gif 壁纸模板 `gifscene.json`）、`videoplayer`、粒子编辑器场景等 |
| `scripts/` | 4 | `jsclasses/baseclasses.js`（Vec2/Vec3/Vec4/Mat 等）、`jsmodules/{wecolor,wemath,wevector}.js` |
| `zcompat/` | 11 | `scene/shaders/<workshopid>/` 两组 shader 替换补丁 + `web/` 5 个 |

shader 方言内置函数使用频次（全部 `.frag/.vert/.h`）：`texSample2D` 1066、`mul` 350、`mix` 308、`CAST3` 150、`CAST2` 143、`saturate` 133、
`frac` 88、`CAST4` 64、`CAST3X3` 63、`texSample2DLod` 40、`lerp` 37、`atan2` 25、`discard` 11、`ddx/ddy` 各 8、`mod` 2、`fract` 2。
预处理指令：`#include "common*.h"` 218 处；`#if MASK` 109、`#if PERSPECTIVE == 1` 69、`#if KERNEL == n` 各 49、`#if SKINNING` 45、
`#if NORMALMAP` 38、`#if LIGHTING` 38、`#if REFLECTION` 34、`#if MORPHING` 30、`#ifdef HLSL_SM30` 21、`#ifdef HLSL` 18、`#if SPRITESHEET` 12。
171 个文件带 `// [COMBO]` 元数据。

### 2.2 默认项目（`projects/defaultprojects/`）[本机]

19 个项目，14 个 scene 型（`project.json` 的 `type`）；另 `audiophile` / `techno` 没有 `type` 字段但 `file` 为 scene json；`sheep` 是 exe；
2 个 web。**全部未打包**（无 `scene.pkg`），资源以 `materials/*.tex(+.tex-json)`、`models/*.json`、`shaders/*.frag|vert`、
`effects/<name>/…`、`particles/*.json`、`sounds/*.wav` 形式散落，并带 `shaders/blobsSM40/*.dxs` 编译缓存（67 个）与 `blobsGES3/*.gxs`。

| 项目 | 对象数 | 图层类型 | effects | 脚本 | 用户绑定 | 音频 | 复杂度 / 用途 |
|---|---|---|---|---|---|---|---|
| eagleflag | 1 | image | 0 | 0 | 0 | 否 | 最简：单图层 + 自定义 `flag` shader |
| beach | 3 | image | 0 | 0 | 0 | 否 | 三张静态图层 + 自定义 `flowimage` / `swayimage` shader、`constantshadervalues` |
| deep_space | 2 | image | 0 | 0 | 0 | 否 | 静态 |
| shimmering_particles | 5 | particle ×4 + image | 0 | 1 | 9 | 否 | 粒子 + `visible.user.condition` + bloom + 一段 `applyUserProperties` 脚本 |
| retro | 3 | model + image | 0 | 0 | 0 | 否 | 含 3D model 图层 |
| neon_sunset | 5 | image ×3 + model ×2 | 1 | 0 | 0 | 否 | 单 effect |
| razer_vortex | 3 | image | 3 | 3 | 7 | 否 | effect + 脚本 |
| razer_bedroom | 18 | image | 15 | 6 | 17 | 否 | 多 effect（scroll / tint / godrays / filmgrain） |
| dino_run | 36 | image ×32 + sound ×2 + text ×2 | 22 | 3 | 3 | 否 | 最复杂：SceneScript 小游戏（`engine.registerAsset`、`thisScene.createLayer`、`input.cursorWorldPosition`、文本图层、声音） |
| arsenal / dna_fragment / ricepod / fantasticcar / demon_core / audiophile / techno | 3–8 | model 为主 + particle / light | 0 | 0 | 0 | 部分 | 3D 模型（`.mdl`）、光照、音频可视化 |

全部默认项目中 scene.json 的 `general` 键并集：`ambientcolor bloom bloomhdrfeather bloomhdriterations bloomhdrscatter bloomhdrstrength
bloomhdrthreshold bloomstrength bloomthreshold camerafade cameraparallax cameraparallaxamount cameraparallaxdelay cameraparallaxmouseinfluence
camerapreview camerashake camerashakeamplitude camerashakeroughness camerashakespeed clearcolor clearenabled farz fov hdr nearz norecompile
orthogonalprojection skylightcolor supportsaudioprocessing zoom`。材质用到的 shader 名：`genericimage2` 48 次（绝对主力）、`generic` 6、
`genericparticle` 5、其余为项目自定义。effect 使用：`scroll` 30、`tint` 9、`godrays` 1、`filmgrain` 1。

### 2.3 创意工坊 [本机]
`workshop/content/431960/` 只有 `2725770343`（video）与 `796697921`（web），**没有 scene 型**；因此 `.pkg` 解析暂无本地样本。

---

## 三、格式规格

### 3.1 `.pkg` 容器
| | 内容 |
|---|---|
| 已确认 [LWE `PackageParser.cpp`] | 头部为长度前缀字符串，必须以 `PKGV` 开头（如 `PKGV0001`…）；随后 `uint32 count`；每项 `sizedString filename` + `uint32 offset` + `uint32 length`；目录表读完时的文件位置记为 `baseOffset`，数据区从此开始 |
| 推断 | 条目数据位置 = `baseOffset + offset`（LWE 的 `Package` 结构有 `baseOffset` 字段，读取处未展示；RePKG 同理）。长度前缀串的编码为 `uint32 len + bytes`（RePKG 行为，未在源码中直接看到） |
| 未知 | 不同 `PKGV00xx` 版本间是否有差异；[REA] 主 exe 定义串里**没有** `PKGV`，推断 pkg 读取在 `resourceutil64.dll` 或由 `resourcecompiler64.exe` 侧完成，本次未分析该 DLL |

### 3.2 `.tex` 纹理
| | 内容 |
|---|---|
| 已确认 [本机 440 个样本 + REA 字符串 + LWE `TextureParser.cpp` / `Texture.h`] | 布局：`"TEXV0005\0"`（9 字节）→ `"TEXI0001\0"` → `uint32 format` → `uint32 flags` → `uint32 textureWidth, textureHeight`（容器尺寸，2 的幂或 NPOT）→ `uint32 width, height`（图像有效尺寸）→ `uint32`（忽略）→ `"TEXB000x\0"` → `uint32 imageCount` → 版本相关字段 → 每张图 `uint32 mipCount` + mip 列表 → 若动画则 `"TEXS000x\0"` 帧表。本机容器版本分布：`TEXB0003` 242、`TEXB0004` 99、`TEXB0001` 42、`TEXB0002` 29；[REA] exe 内有 `TEXV0005 / TEXV0004 / TEXI0001 / TEXB0004 / TEXS0003` 字面量 |
| format 枚举（LWE，与本机样本分布吻合：0→257 个、4→72、9→60、8→51） | 0 ARGB8888、1 RGB888、2 RGB565、4 DXT5、6 DXT3、7 DXT1、8 RG88、9 R8、10 RG1616f、11 R16f、12 BC7、13 RGBa1010102、14 RGBA16161616f、15 RGB161616f；[本机] `shaders/common_fragment.h` 另定义 3 ETC1_RGB8、5 ETC2_RGBA8（移动端） |
| flags 位 | 1 NoInterpolation、2 ClampUVs、4 IsGif、8 ClampUVsBorder、32 Video、524288 AlphaChannelPriority（RG88/R8 时 alpha 在 G/R）；本机出现过 0/1/2/3/4/5/6/7/18/66/524288/524290/524292 |
| TEXB 版本差异 | 04：`uint32 FreeImageFormat` + `uint32 isVideoMp4`，非 mp4 时按 03 规则读；03：`uint32 FreeImageFormat`；01/02 无额外字段。mip 条目：04 先有 2 个忽略 uint32 + 以 NUL 结尾的 JSON 串 + 1 个忽略 uint32；然后 `uint32 width, height`；02+ 再 `uint32 compression` + `int uncompressedSize`；最后 `int compressedSize`；`compression == 1` 时为 **LZ4 block**（`LZ4_decompress_safe`），否则原始字节。FreeImageFormat 非 UNKNOWN 时 mip 数据是整张 PNG/JPG/GIF 等图片文件而非像素 |
| TEXS 动画 | `TEXS0001/02/03` + `uint32 frameCount`（03 再 `gifWidth, gifHeight`）+ 每帧 32 字节：`frameNumber, frametime, x, y, width1, width2, height2, height1`（01 为整型 + 两个忽略字段）。本机 61 个 tex 含 `TEXS`（粒子动画贴图），另有 `.tex-json` 的 `spritesheetsequences` 覆盖帧网格 |
| `.tex-json` 侧车 [本机 379 个] | `format`（rgba8888 224、r8 60、rg88 50、rgba8888n 19、dxt5n 9、dxt5n+ 6、dxt5 5、rgb888 4、rg88n 2）、`clampuvs`、`nonpoweroftwo`、`nomip`、`alphachannelpriority`、`spritesheetsequences[{frames,width,height,duration}]`、`bleedtransparentcolors`、`nointerpolation`、`srgb`、`spritesheet`、`frameduration`、`imagesequence`、`halfmip`、`forcerawcompression` |
| 未知 | `TEXB0004` mip 条目 JSON 的内容；视频纹理（`isVideoMp4`）的播放方式；`TEXV0004` 旧版布局 |

### 3.3 `scene.json`
| | 内容 |
|---|---|
| 已确认 [本机 16 个 scene json 聚合 + LWE `Object.h`] | 顶层 `camera {center, eye, up}`、`general {…}`（§2.2 键并集）、`objects []`、`version`。对象公共键：`id name origin angles scale locktransforms parallaxDepth visible`。**image**：`image`(→models json) `size alignment alpha brightness color colorBlendMode copybackground perspective solid effects[] ledsource instanceoverride`。**particle**：`particle`(→particles json) `instanceoverride{id,alpha,count,size,lifetime,rate,speed,color,colorn}` `particlesrc`。**sound**：`sound[] playbackmode volume startsilent mintime maxtime muteineditor`。**text**：`text font pointsize color alpha anchor horizontalalign verticalalign blockalign padding limitwidth maxwidth limitrows maxrows limituseellipsis opaquebackground backgroundcolor backgroundbrightness depthtest size`。**light**：`light color intensity radius`。**model**：`model skin reflected`。effect 条目：`file id name username visible passes[{id, combos, constantshadervalues, textures}]` |
| 值的三种形态 | 常量（`"0.1 0.2 0.3"` 字符串向量 / 数字 / 布尔）；用户绑定 `{ "user": "<属性名>" 或 { "name", "condition" }, "value": 默认 }`；脚本绑定 `{ "script": "<ES 模块源码>", "value": 默认 }`。`visible.user.condition` 是与属性值比较的字符串（如 `"0"`、`"1"`） |
| [REA] exe 内 scene 相关键 | `orthogonalprojection hdr displayhdr cameraparallaxmouseinfluence bloom sound supportsvideo objects model supportsaudioprocessing presetproperties initalwproperties ultra`；对象 API 名 `dependencies attachment rotateObjectSpace lookAt lookAtYaw setParent parallaxDepth sortorder getTransformMatrix getAttachmentOrigin getAttachmentAngles solid disablepropagation getParent` |
| 推断 | gif 壁纸在 WPE 内部被转成 scene（[REA] `assets/scenes/gifs`、`gifscene.json`、`materials/background.gif`）；`parent` / `attachment` 形成图层层级（LWE `ObjectData.parent`，深度上限 32） |
| 未知 | `colorBlendMode` 的数值表；`alignment` 字符串全集；`perspective` 对 2D 图层的几何 |

### 3.4 model / material / effect json
| | 内容 |
|---|---|
| 已确认 [本机 + LWE `Material.h` / `Effect.h`] | **model**：`{ material, width, height, autosize?, fullscreen?, passthrough?, solidlayer?, puppet? }`。**material**：`passes[{ shader, blending(normal/translucent/additive/alphatocoverage), cullmode(nocull/…), depthtest, depthwrite, textures[], usertextures, combos{}, constantshadervalues{}, usershadervalues{} }]`；[REA] 另有 `alphawriting`、`keepaspect`、`usertexturereference`、`usershortcut_`。**effect**：`{ version, name, description, group, performance, preview, passes[{ material, target?, bind[{name,index}], command? }], fbos[{ name, scale, format }], dependencies[] }`。本机 46 个 effect：多数 1 pass 0 fbo；`blur` 4 pass 2 fbo（1/4 分辨率 ping-pong）、`godrays`/`shine` 5 pass 2 fbo、`localcontrast` 4/2、`motionblur` 2/2、`fluidsimulation` 18 pass 3 fbo（最重） |
| 绑定名语义 [LWE `CPass.cpp` + REA] | `previous` = 上一 pass 的输出；`_rt_FullFrameBuffer`、`_rt_MipMappedFrameBuffer`（反射）、`_rt_4FrameBuffer`、`_rt_8FrameBuffer`、`_rt_Bloom`、`_rt_Reflection`、`_rt_shadowAtlas`、`_rt_FullAlphaMask(Intermediate)`、`_rt_imageLayerComposite_<id>_a/_b`、`_rt_imageLayerAlbedo_<id>`、`_rt_volumetrics*`、`_alias_*` 为引擎提供的目标；fbo `scale` 是分母（4 = 1/4 分辨率），`format` 如 `rgba_backbuffer` |
| 未知 | `command` 的取值（LWE 只实现 `copy`）；`_rt_FullAlphaMask` 等的填充时机 |

### 3.5 shader 方言
| | 内容 |
|---|---|
| 已确认 [REA 内嵌宏头 + 翻译模板，地址 0x140486898–0x140488200；本机源码] | 语法：GLSL 1.x 风格声明（`attribute`、`varying`、`uniform`、`lowp` 修饰、`gl_Position`、`gl_FragColor`、`main()`），表达式用 HLSL 风格内置（`mul(v, M)` 行向量左乘、`frac`、`saturate`、`lerp`/`mix` 均可、`atan2`、`ddx/ddy`、`texSample2D(s, uv)`、`texSample2DLod`、`texSample2DCompare`、`texLoad2D`、`texSample3D`、`texSample2DBackBuffer`），类型 `vec2/3/4 mat3/4 mat4x3 uvec4 ivec4 uint int`，构造宏 `CASTI/CASTU/CASTF/CAST2/CAST3/CAST4/CAST4U/CAST3X3`。Windows 翻译：上述宏头 + `#define HLSL 1 / HLSL_SM40 1`（GS 可用时 `#define GS_ENABLED 1`）；按正则 `(\w+)\s+%s\s+(\w+)(\[[\d\w]+\])?` 收集 `uniform` 进 `cbuffer …:register(b…)`，`attribute` 进 `struct VS_INPUT` 并配语义（`TEXCOORD / COLOR / TANGENT / BLENDINDICES / BLENDWEIGHT / SV_VERTEXID / SV_INSTANCEID`），`varying` 进 `VS_OUTPUT`/`PS_INPUT`，`gl_Position`→`SV_POSITION`，`gl_FragColor`→`OUT.gl_FragColor : SV_TARGET`，`void main()` 替换为 `VS_OUTPUT main(VS_INPUT IN)` / `PS_OUTPUT main(VS_OUTPUT IN)`，`#include` 由引擎解析（`shaders/` 根）；编译目标 `vs_5_0 / ps_5_0 / gs_5_0`，回退 `vs_4_1 / ps_4_1`；光照相关生成常量 `g_LPoint_* g_LSpot_* g_LTube_* g_LDirectional_* g_LFeature_Shadow*` 受 `LIGHTS_POINT / LIGHTS_SPOT / LIGHTS_TUBE / LIGHTS_DIRECTIONAL / *_SHADOW / *_COOKIE` 宏控制 |
| COMBO 与 uniform 元数据 [官方 + 本机] | `// [COMBO] {"material","combo","type":"options","default","options":{…}}` → `#define <COMBO> <值>`；`uniform T name; // {"material","label","default","range","linked","type":"color","group","hidden","nobindings","combo","mode":"opacitymask|rgbmask|flowmask","paintdefaultcolor","requireany","require":{…},"formatcombo","components":[…]}`；采样器 `g_Texture0..7`，纹理格式注入 `TEX<n>FORMAT` 宏（本机 `common_fragment.h` 据此选法线解码分支；[REA] `TEX0FORMAT` 字面量） |
| 内置 uniform（本机全集 + 官方表） | 时间 / 输入：`g_Time g_Frametime g_Daytime g_PointerPosition g_PointerPositionLast g_PointerState g_PointerScale g_ParallaxPosition g_Screen g_TexelSize g_TexelSizeHalf`；矩阵：`g_ModelMatrix(+Inverse) g_ModelViewMatrix g_ModelViewProjectionMatrix(+Inverse) g_ViewProjectionMatrix g_NormalModelMatrix g_Alt* g_EffectModelMatrix g_EffectModelViewProjectionMatrix(+Inverse) g_EffectTextureProjectionMatrix(+Inverse) g_LayerModelMatrix`；相机：`g_EyePosition g_View{Forward,Right,Up} g_Orientation{Forward,Right,Up}`；纹理：`g_Texture<n>Resolution`（xy 物理尺寸、zw 有效尺寸）`g_Texture<n>Rotation g_Texture<n>Translation g_Texture<n>Texel g_Texture<n>MipMapInfo`；颜色：`g_Alpha g_Color g_Color4 g_TintColor g_TintAlpha g_UserAlpha g_Brightness`；光照：`g_LightAmbientColor g_LightSkylightColor g_LightsPosition[4] g_LightsColorRadius[4] g_LightsColorPremultiplied[3]`；bloom：`g_Bloom{Strength,Threshold,Scatter,Tint,BlendParams}`；骨骼 / 变形：`g_Bones[BONECOUNT](mat4x3) g_BonesAlpha[] g_MorphWeights[12] g_MorphOffsets[12]`；粒子：`g_RenderVar0..4`；音频：`g_AudioSpectrum{16,32,64}{Left,Right}[]`、`g_AudioBounds g_AudioFrequency{Min,Max} g_AudioMultiply g_AudioPower` |
| 顶点属性 [本机 + REA] | `a_Position a_TexCoord a_TexCoordVec4 a_TexCoordVec4C1..C5 a_TexCoordVec3C4/C5 a_TexCoordC2..C5 a_Color a_Normal a_Tangent a_BlendIndices(uvec4) a_BlendWeights` |
| 几何着色器 | 本机 4 个 `.geom`（播放列表过渡、粒子）；粒子 `.vert` 用 `#if HLSL_GS40_DISABLED` 区分「GS 展开 billboard」与「顶点着色器自己算四角」。**WGSL 无 GS**，必须走 `HLSL_GS40_DISABLED` 分支并由我们提供四顶点实例化 |
| 与 LWE 翻译器的差异 [LWE `ShaderUnit.cpp`] | LWE 翻到 GLSL 330：`mul(x,y)→(y)*(x)`、`frac→fract`、`saturate→clamp`、`texSample2D→texture`、`atan2→atan`、`ddy(x)→dFdy(-x)`、`gl_FragColor→out_FragColor`，`#include` 文本插入到最后一个声明之后、`#require LightingV1` 打桩返回 0（不支持光照），不支持 float/string combo。可作为 WGSL 翻译器的对照用例集 |
| 未知 | `#ifdef HLSL_SM30` 分支的用途（SM3 旧路径）；`texSample2DBackBuffer` 的 MS 版本何时启用；`PLATFORM_ANDROID` 等平台宏全集 |

### 3.6 粒子系统
| | 内容 |
|---|---|
| 已确认 [本机 json + REA 名称表 0x14048fa00 + LWE `Object.h`] | 顶层：`material maxcount starttime flags animationmode sequencemultiplier emitter[] initializer[] operator[] renderer[] controlpoint[{id,flags,offset,locktopointer}] children[]`。**emitter**：`sphererandom boxrandom layerimage`（字段 `rate origin directions distancemin/max sign instantaneous speedmin/max controlpoint cone delay duration audioprocessing*`）。**initializer**：`lifetimerandom sizerandom alpharandom colorrandom hsvcolorrandom colorlist velocityrandom rotationrandom angularvelocityrandom positionoffsetrandom turbulentvelocityrandom inheritcontrolpointvelocity mapsequencearoundcontrolpoint mapsequencebetweencontrolpoints remapinitialvalue inheritinitialvaluefromevent randomframe`。**operator**：`movement angularmovement alphafade alphachange sizechange colorchange oscillateposition oscillatealpha oscillatesize turbulence vortex vortex_v2 boids controlpointattract maintaindistancetocontrolpoint maintaindistancebetweencontrolpoints reducemovementnearcontrolpoint collisionsphere collisionbox collisionbounds collisionquad collisionplane capvelocity remapvalue inheritvaluefromevent`。**renderer**：`sprite spritetrail rope ropetrail genericropeparticle`（字段 `length minlength maxlength subdivision segments uvscale uvscrolling uvsmoothing fadealpha fadesize orientation screen static`）。**children**：`eventfollow eventspawn eventdeath`。combo：`SPRITESHEET SPRITESHEETBLEND SPRITESHEETBLENDNPOT THICKFORMAT TRAILRENDERER TRAILSUBDIVISION TRAILFADEALPHA TRAILFADESIZE TRAILSCROLLALPHA WRITEALPHA OPACITYMASK ORIENTATION REFRACT WORLDBLUR USERCOLORBLEND` |
| 推断 | 粒子在 CPU 端模拟（LWE 如此；[REA] `_rt_pluginCpuBuffer*` 名字暗示 CPU 路径），每帧上传顶点：位置、`a_TexCoordVec4(uv, rotation.z, size)`、`a_Color`、`THICKFORMAT` 时再带 `velocity + lifetime`；精灵在 GS 或 VS 展开 |
| 未知 | 各 operator 的精确公式（LWE 实现了大半，可对照 `CParticle.cpp` 89 KB）；`boids` / `vortex_v2` / 碰撞类 LWE 未实现 |

### 3.7 SceneScript
| | 内容 |
|---|---|
| 已确认 [官方 + 本机 + DLL] | 语言：ECMAScript（**V8** 引擎，`scenescript64.dll`），**不是** LWE 用的 QuickJS。每段脚本是一个 ES 模块（`'use strict'; export function update(value) {…}`），绑定在某个属性上：`update(value)` 每帧调用并返回新值；可选 `init()`、`destroy()`、`applyUserProperties(changed)`、`applyGeneralSettings`、`resizeScreen`、`cursorEnter/Leave/Move/Down/Up/Click`、`media*Changed`。全局：`engine`（`frametime runtime registerAsset userProperties`）、`input`（`cursorWorldPosition`…）、`thisScene`（`getLayer getLayerIndex createLayer`…）、`thisLayer`、`thisObject`（`getMaterial`…）、`console`、`shared`。模块 `WEColor / WEMath / WEVector`（本机 `assets/scripts/jsmodules`），基类 `Vec2/Vec3/…`（`jsclasses/baseclasses.js`）。官方提供 `lib.sceneScript.d.ts` 类型定义；类名表见官方 reference（`IScene ILayer IImageLayer ITextLayer ISoundLayer IModelLayer IAnimationLayer IEffectLayer IEngine IInput IConsole ILocalStorage IEffect IMaterial IParticleSystem(Instance) IAnimation Mat3 Mat4 Vec2 Vec3 AudioBuffers Media*Event`） |
| 本机用量 | 13 段脚本 / 36 处用户绑定；dino_run 用了 `engine.registerAsset`、`thisScene.createLayer / getLayer / getLayerIndex`、`input.cursorWorldPosition`、`thisObject.getMaterial`、`cursorDown`、`init`、`update`、`applyUserProperties` |
| 未知 | 每个接口的完整签名与返回类型（需拉取 `lib.sceneScript.d.ts`）；`import` 语法形态（本机脚本未见 import） |

---

## 四、渲染流程（WPE 实际做法）

综合 [本机] shader 源码、[REA] 渲染目标名与模板、[LWE] `CImage.cpp` / `CPass.cpp`：

1. **场景坐标**：`general.orthogonalprojection {width,height}` 定义场景像素空间（本机 1920×1080 或 5760×1080 三屏），`camera.eye/center/up`
   构成正交视图；`zoom`、`cameraparallax*`（鼠标视差：`parallaxDepth` 按层深位移）、`camerashake*` 在视图矩阵上叠加。
2. **图层逐个合成**：按 `objects` 顺序（`sortorder` 可改）渲染。image 图层：先用图层材质（通常 `genericimage2`，支持 `LIGHTING / REFLECTION /
   NORMALMAP / PBRMASKS / SKINNING / BLENDMODE` combo）把纹理画进该图层的 `_rt_imageLayerComposite_<id>_a`；随后每个 effect 的每个 pass 在
   `_a / _b` 之间 ping-pong，pass 的 `target` 可改写到 effect 自己声明的 fbo（如 1/4 分辨率的 `_rt_QuarterCompoBuffer1`），`bind` 把
   `previous` / 其它 fbo 绑到 `g_Texture<index>`；最后一个 pass 以场景空间四边形合成到场景帧缓冲（`_rt_FullFrameBuffer`），`copybackground`
   时先把背景拷进来，`colorBlendMode` 走 `materials/util/effectpassthrough.json`。
3. **全局后处理**：`hdr` / `bloom*`（`_rt_Bloom`、`_rt_4FrameBuffer`、`_rt_8FrameBuffer`、`blur_h_bloom` / `downsample_quarter_bloom` /
   `combine_hdr`）；`clearcolor` / `clearenabled` 清屏；`camerafade` 入场淡入。
4. **粒子**：CPU 模拟后作为一个图层绘制（additive / translucent），`WORLDBLUR` 按深度模糊，`REFRACT` 采样 `_rt_FullFrameBuffer` 做屏幕折射。
5. **输入**：`g_PointerPosition` 归一化屏幕坐标、`g_PointerState`；`cursorripple / depthparallax / xray` 等 interactive 组 effect 依赖它。
6. **帧率 / 暂停**：WPE 设置里的 FPS 上限与「其它应用全屏时暂停」属于宿主行为，与阶段 2 的 `paused` 语义一致。
7. **shader 编译**：方言 → 宏头 + 模板 → HLSL → `D3DCompile` → 缓存 `.dxs`。[REA] 还有 `shaders/HLSL/dx11fallback.{frag,vert}` 作编译失败回退。

---

## 五、WebGPU 复现方案草图

### 5.1 模块划分（前端，全部在 `WallpaperStage` 的 scene 分支内）
| 模块 | 职责 | 依赖 / 说明 |
|---|---|---|
| `wpe-scene/assets` | 资源定位：先项目目录，再 `assets/`（WPE 安装目录，需要后端告知路径）；pkg 解析（目录表 + Range 读）；缓存 | 经 `/wpe/<id>/<rel>`（或 Phase 4 的 `kb-wpe` 协议）读取；WPE `assets/` 需要新增一个只读路由（它不在壁纸目录内，当前 `/wpe` 越界校验会拒绝） |
| `wpe-scene/tex` | `.tex` 解析：头 / 容器 / mip / LZ4 / TEXS；像素格式映射到 WebGPU（DXT1→`bc1-rgba-unorm`、DXT3→`bc2`、DXT5→`bc3`、BC7→`bc7`、RGBA8→`rgba8unorm`、R8→`r8unorm`、RG88→`rg8unorm`、RG1616f→`rg16float`、R16f→`r16float`、RGB888→展开成 RGBA8）；FreeImage 形态的 mip 用 `createImageBitmap` 解码 | LZ4 block 解压：JS 实现足够（单纹理数 MB，几 ms 级），必要时 WASM；`texture-compression-bc` 不可用时回退 JS 解 DXT |
| `wpe-scene/shader` | 方言 → WGSL：自带预处理器（`#include` 从 `shaders/` 根解析、`#if/#ifdef/#else/#endif` 与 COMBO 宏求值、`// [COMBO]` 与 uniform 元数据提取）；类型 / 内置函数重写（`mul(v,M)`→`M * v` 或 `v * M` 按行向量约定、`texSample2D(s,uv)`→`textureSample(t_s, s_s, uv)`、`frac→fract`、`saturate`、`CAST*`、`mod`、`atan2→atan2`、`ddx/ddy→dpdx/dpdy`、swizzle 写法差异、`discard`、整数/浮点字面量严格性）；声明重排：`uniform` 合并进按 binding 分组的 `struct` + `var<uniform>`，`attribute` → `@location(n)` 顶点输入，`varying` → 中间 struct，`gl_Position`→`@builtin(position)`，`gl_FragColor`→`@location(0)`；采样器与纹理拆成两个 binding；`TEX<n>FORMAT` 宏注入 | 与 WPE 自己的 HLSL 翻译器同构。推荐**手写翻译器**（见 §7 决策 2） |
| `wpe-scene/material` | material / model json → pipeline（blend / cull / depth 状态）、bind group 布局、常量缓冲布局与 `constantshadervalues` / 用户属性填充 | `g_*` 内置 uniform 由统一的 frame / layer / pass 三级 uniform buffer 提供 |
| `wpe-scene/graph` | scene.json → 图层树（parent / attachment）、变换、`visible` / 用户绑定 / 脚本绑定求值、相机与视差 | 用户属性来源遵循阶段 2 决策「属性即元数据」 |
| `wpe-scene/passes` | 图层合成：每层两张 composite 纹理 ping-pong、effect fbo 池（按 `scale` 分配）、`previous` / `_rt_*` 解析、最终合成、HDR bloom 链 | 全部 render pass；fluidsimulation 这类 18 pass 的 effect 后置 |
| `wpe-scene/particles` | CPU 模拟（TypedArray）+ 每帧写顶点缓冲 + 四顶点实例化代替 GS | 后置 Phase |
| `wpe-scene/script` | 在页面 V8 里以 `Blob URL` + `import()` 加载每段脚本模块，提供 `engine / input / thisScene / thisLayer / thisObject / console / shared` 适配对象与 `WEColor/WEMath/WEVector` 模块 | 直接复用阶段 2 的 `postMessage` 隔离？不需要——Scene 脚本不是任意网页，但仍是第三方代码，建议放在与 Web 壁纸相同的跨源 iframe 里运行整个渲染器（见 §7 决策 5） |

### 5.2 与 `WallpaperStage` 的接缝
- 新增 media 分支 `"scene"`（`WallpaperStageDebugState.media` 已预留 `"web"`，再加 `"scene"`）：目标 `type === "x-wpe/scene"` 时挂一个
  `<canvas>`（或承载渲染器的 iframe），`paused` → 停 rAF 循环并 `device.queue` 空转，`interactive` → 把指针事件喂给 `g_PointerPosition`。
- 过渡：与 web 层一样作为独立层，不参与 base / top 双层。
- 目标组装：`build_wallpaper_target` 对 scene 行返回 `wpeScene`（作者默认属性 + 用户值，来自 metadata），与 video / web 并列。

### 5.3 与阶段 2 各 Phase 的依赖
- Phase 3（Web 导入 + 预览内嵌）：导入分派加 `WpeKind::Scene`（`type = x-wpe/scene`、缩略图作者预览、hash/size 取 `scene.json` 或 `scene.pkg`）；
  `ImageContent` 的 `wallpaper` mode 已覆盖非视频 WPE 行。
- Phase 4（垫片 + `kb-wpe` 协议）：资源读取路径与源稳定性；`kb-wpe` 的整体缓冲对 `.tex`（本机最大 4096² RGBA8 ≈ 64 MB 未压缩，磁盘上 LZ4 后更小）
  与几十 MB 的 `scene.pkg` 需要 Range 或按条目切片——建议 pkg 条目由后端按目录表切片提供（`/wpe/<id>/pkg/<entry>`），避免前端整包下载。
- Phase 6（用户属性 / 属性即元数据）：`visible.user`、`color.user` 等绑定与 `applyUserProperties` 脚本钩子直接消费同一份属性。
- Phase 7（音频）：`g_AudioSpectrum*` 与粒子 `audioprocessing*` 复用同一频谱源。

---

## 六、阶段 3 的 Phase 拆分建议

| Phase | 范围 | 验收样例（本机默认项目） |
|---|---|---|
| 3-P1 调研 | 本文件 | — |
| 3-P2 资源与静态图层 | `.tex` 解析 + WebGPU 上传（BC 直传 / RGBA8 / R8 / RG88）、`scene.json` / model / material 解析、`genericimage2` 无 combo 路径的 WGSL 翻译器最小集（预处理 + 类型 + 内置函数 + 声明重排）、正交相机、图层按序合成、`clearcolor`、`visible` 常量；导入 `x-wpe/scene`；`WallpaperStage` scene 分支 + 预览画布 | `eagleflag`（单层 + 自定义 flag shader）、`deep_space`、`beach`（三层 + `constantshadervalues` + 自定义 shader + `g_Time`） |
| 3-P3 effect pass 链 | effect.json / fbo 池 / ping-pong / `previous` 与 `_rt_FullFrameBuffer` / `scale` 分辨率 / `combos` 与 `constantshadervalues` 覆盖；`scroll tint blur godrays filmgrain` 先行；bloom / HDR 链 | `neon_sunset`（1 effect）、`razer_vortex`（3）、`razer_bedroom`（15，godrays / filmgrain）、`shimmering_particles` 的 bloom 部分 |
| 3-P4 用户属性与脚本 | `visible.user.condition`、`{user}` 绑定、`{script}` 绑定（ES 模块 + 适配对象）、`applyUserProperties` 钩子、`cameraparallax` 鼠标视差、`g_PointerPosition`；对接「属性即元数据」 | `shimmering_particles`（脚本改 bloomstrength、style 切换）、`razer_vortex` / `razer_bedroom` 的脚本 |
| 3-P5 粒子 | CPU 模拟（emitter 3 种、常用 initializer / operator、`sprite` renderer、spritesheet 动画 TEXS）、实例化四边形、`particle` shader 的 `HLSL_GS40_DISABLED` 分支 | `shimmering_particles`（4 个粒子系统）、`arsenal` / `dna_fragment` 的粒子 |
| 3-P6 文本 / 声音 / 复杂脚本 | text 图层（字体渲染到纹理）、sound 图层、`thisScene.createLayer`、`engine.registerAsset`、`input.cursorWorldPosition`、`cursorDown` | `dino_run` |
| 阶段 4（原路线） | 3D model（`.mdl` MDLV0017/0021/0023、skinning、puppet warp）、光照 / 反射 / PBR、`fluidsimulation` 等重 effect、音频驱动、`.pkg` 真实订阅样本回归 | `retro` / `arsenal` / `demon_core` / `audiophile` |

---

## 七、关键决策（需用户确认）

1. **纹理解码路线**
   - A. **BC 直传 + 回退**（推荐）：`texture-compression-bc` 可用时 DXT1/3/5/BC7 直接 `writeTexture`，RGBA8/R8/RG88 原样；不可用时（macOS Metal
     无 BC、部分 Linux）在 JS 解 DXT 到 RGBA8。LZ4 用 JS 实现，必要时换 WASM。
   - B. 全部解到 RGBA8：实现最简单，显存与上传量 4–8 倍，4096² 纹理 64 MB。
   - 另：`macOS` 上 WebGPU 的压缩纹理只有 `texture-compression-astc/etc2` 不保证，BC 一般不可用——A 的回退分支在 macOS 是主路径。
2. **shader 翻译工具**
   - A. **手写「方言 → WGSL」翻译器**（推荐）：WPE 自己也是宏 + 正则 + 模板，方言面很小（§3.5 列表），且需要自带预处理器处理 `#include` / COMBO；
     工作量级：预处理器 + 词法级重写 + 声明重排约 2–3k 行 TS，用 137 个内置 shader 做回归语料。
   - B. 方言 → GLSL（LWE 的做法，几乎只是 `#define`）→ naga（wasm，~5 MB）→ WGSL：GLSL 前端能接住表达式与类型推断，但 naga 的 GLSL 前端
     对 `attribute/varying` 旧语法与 `#include` 需要我们先预处理，且 naga GLSL 前端维护状态一般；引入大 wasm。
   - C. 方言 → HLSL（照抄 WPE 模板）→ 用 tint/dxc wasm：没有现成稳定的浏览器端 HLSL→WGSL。
   - 推荐 A，B 作为 A 卡住时的对照验证工具（离线跑 naga 看翻译结果差异）。
3. **资源交付方式**
   - A. **后端按需切片**（推荐）：`/wpe/<id>/<rel>` 继续服务散落文件；`.pkg` 由后端解析目录表，提供 `/wpe/<id>/pkg/<entry>` 条目读取（支持 Range）
     与 `/wpe/<id>/pkg/` 的目录 JSON；WPE `assets/` 目录新增只读路由 `/wpe-assets/<rel>`（越界校验到 WPE 安装目录）。
   - B. 前端整包：`fetch` 整个 `scene.pkg` 到内存再切片；几十到几百 MB 时首帧慢、内存翻倍；与 `kb-wpe` 协议的整体缓冲叠加更差。
   - 需要用户定：是否接受 Kabegame 读取 WPE 安装目录（`assets/`）——没有它，任何使用内置 effect / `materials/util/*` 的壁纸都渲染不了
     （本机 14 个 scene 全部依赖）。备选是要求用户在设置里指定 WPE 安装路径，或从 Steam 库发现（阶段 1 已有 `discover_roots`）。
4. **明确不做 / 后置的子系统**（建议阶段 3 不做，归阶段 4）：3D model（`.mdl`、skinning、puppet warp）、光照 / 反射 / PBR（`LIGHTING / REFLECTION`
   combo）、`fluidsimulation` 等多 pass 重 effect、视频纹理（`TEXB0004` mp4）、音频驱动的粒子 / shader（等阶段 2 Phase 7）、`ledsource` RGB 输出、
   编辑器专属（`camerapreview`、`presetproperties`）。
5. **渲染器运行位置**：A. **与 Web 壁纸同一个跨源 iframe 里**（推荐）——SceneScript 是第三方代码，V8 同源隔离最省事，`WallpaperStage` 只多一种
   iframe 内容；B. 直接在应用源的 `<canvas>` 里跑，脚本用 `Function` 沙箱——性能略好但隔离弱。
6. **首个 Phase 范围**：是否按 §6 的 3-P2（静态图层 + `genericimage2` + 三个样例）起步，还是把 effect 链（3-P3）合并进首个 Phase 一次做到
   `razer_bedroom` 可看。推荐分开：翻译器先用无 combo 的最小集跑通，再上 COMBO 展开。
7. **WPE 安装目录依赖的提示**：Scene 壁纸在没有 WPE 安装（如只拷了壁纸目录）的机器上无法渲染，是否在导入时就标记「需要 WPE assets」并在
   详情面板提示，还是渲染失败时再提示。

---

## 八、待验证与未知项

- [ ] `.pkg` 条目 offset 是否相对 `baseOffset`；长度前缀串的编码——需一个真实创意工坊 scene 订阅样本或读 RePKG 源码确认。
- [ ] `TEXB0004` mip 条目里 JSON 串的内容与视频纹理播放路径。
- [ ] `colorBlendMode` 数值表、`alignment` 全集、`perspective` 几何。
- [ ] 效果 pass 的 `command` 取值与 `_rt_FullAlphaMask` 的生成时机。
- [ ] 粒子各 operator 的精确公式（对照 LWE `CParticle.cpp` 与真机观感）。
- [ ] `lib.sceneScript.d.ts` 的完整接口签名（官方 reference 页有链接，未拉取）。
- [ ] WebGPU 在 **Linux / macOS CEF** 下是否默认开启与 BC 支持（本次只在 Windows 真机验证；Chromium 149 在 Linux 可能需要 `--enable-unsafe-webgpu`
  或 Vulkan 后端，仓库 `runtime.rs` 的 `KABEGAME_CEF_GPU_MODE` 已能切 ANGLE 后端）。
- [ ] `mul(v, M)` 的行/列约定在 WGSL 中的等价写法要用一个 `genericimage2` 实例逐帧对比 WPE 截图确认。
- [ ] `#ifdef HLSL_SM30` 分支的作用；`texSample2DBackBuffer` 的 MS 版本。
- [ ] `g_Daytime` / `g_Frametime` 等的更新时机与精度。
- [ ] [REA] 主 exe 定义串里无 `PKGV`，pkg 读取可能在 `resourceutil64.dll`——未分析。
- [ ] zcompat `scene/shaders/<id>/config.json` 的替换规则格式（本机两组样本可读，未展开）。

---

## 九、资料来源

- 本机：`D:\Applications\Steam\steamapps\common\wallpaper_engine\{assets,projects/defaultprojects,bin}`（只读）。
- REA（Ghidra 12.1.4）对 `wallpaper64.exe` 的字符串与数据区读取：Evidence `ev_3893b2…`（宏头与 `texSample2D` 系列）、`ev_72051a…`
  （`#define HLSL 1 / HLSL_SM40 1`）、`ev_9c4f26…`（`PS_OUTPUT` 模板）、`ev_069b4c…`（HLSL 翻译模板与光照常量生成）、`ev_148d85…`
  （`_rt_*` 渲染目标名）、`ev_c49741…`（粒子名称表）、`ev_2c8640…`（材质键、顶点属性、TEX 魔数、`GS_ENABLED`）、`ev_63e36d…`（scene 键、gif 场景模板）、
  `ev_02eb78…`（`d3dcompiler_47.dll` / `D3DCompile`）、`ev_9354…`（`scenescript64.dll` 导出名）、`ev_ba236d…`（`LZ4 error`）、`ev_5c4409…`（`MDLV0023`）。
  会话已 `close_binary`。
- `bin/scenescript64.dll` 字节扫描（V8 标识）。
- linux-wallpaperengine（非官方）：`Data/Assets/Texture.h`、`Data/Parsers/TextureParser.cpp`、`Data/Parsers/PackageParser.cpp`、`Data/Assets/Package.h`、
  `Data/Model/{Object,Effect,Material,Types}.h`、`Render/Shaders/ShaderUnit.cpp`、`Render/Objects/CImage.cpp`、`Render/Objects/Effects/CPass.cpp`、
  `Scripting/ScriptEngine.h` — https://github.com/Almamu/linux-wallpaperengine
- RePKG（非官方）README — https://github.com/notscuffed/repkg
- 官方文档：Scene 指南目录 https://docs.wallpaperengine.io/en/scene/overview.html ；Shader 变量与常量 https://docs.wallpaperengine.io/en/scene/shader/variables.html ；
  SceneScript 介绍 / 参考 / 基础教程 https://docs.wallpaperengine.io/en/scene/scenescript/{introduction,reference,tutorial/basics}.html
- 真机：Kabegame dev 主窗口 `navigator.gpu.requestAdapter()`（2026-10-26，CEF 149，NVIDIA Lovelace）。
