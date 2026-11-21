# 场景壁纸：渲染器

> [场景壁纸文档](../WPE_SCENE.md) 的一章：渲染器、帧率、播放速度、图层渲染图、general 字段、泛光与 HDR、层级。总体形态、各阶段状态与全部章节的索引在总览里。

## 渲染器

`apps/wpe-scene/src/render/` 把 `SceneBundle` 画到 `<canvas>` 上（WebGPU）。`bundle.unsupported` 非空时一律不画（这时 mip 可能没解码），退回作者预览图。

| 模块 | 职责 |
|---|---|
| `device.ts` | `navigator.gpu` 适配器与设备；适配器有 `texture-compression-bc` 就开 |
| `textures.ts` | 按 `compile/tex.ts` 的 `TEXTURE_FORMATS`（格式支持范围的唯一来源，P4b）连同全部 mip 上传：0 RGBA8888 → `rgba8unorm`、4 DXT5 → `bc3-rgba-unorm`、6 DXT3 → `bc2-rgba-unorm`、7 DXT1 → `bc1-rgba-unorm`、8 RG88 → `rg8unorm`、9 R8 → `r8unorm`、12 BC7 → `bc7-rgba-unorm`，原样上传、不转通道；FreeImage 位图 `copyExternalImageToTexture` 到纹理尺寸的左上角；采样器 |
| `programs.ts` | 着色器模块 + `getCompilationInfo()` 检查、bind group layout、顶点布局、混合状态、管线（目标格式与是否写 alpha 随目标；网格另传顶点布局与剔除，P5c） |
| `mesh.ts` | 模型网格（P5c）：按 mdl 格式与着色器属性的语义建顶点布局（`meshVertexLayout`，含占位属性）、索引补齐、视锥剔除 `frustumCulled`（纯函数） |
| `uniforms.ts` | 按翻译结果的 std140 布局打包 uniform 块；内置 uniform |
| `layout.ts` | 图层四边形、世界矩阵与沿父链的可见性（P4a）、正交 / 透视粒子的视图投影（透视图层同用后者，P5b）、组的局部正交 `groupViewProjection`（P5b）、样式铺放与画布尺寸（纯函数） |
| `math.ts` | 最小 mat4（列主序）；法线矩阵照 WPE 按快速倒数平方根归一化各轴（P5c） |
| `graph.ts` | 图层渲染图：把每个图层排成步骤（直接上屏 / 合成链 / passthrough / 快照 / copy / swap / 粒子；P5b 加组合层的 `compose` 与 `clear`、fullscreen 的拷贝、组的 `subtree`；P5c 加模型的 `mesh`），fbo 尺寸，`swap` 的名字 → 实体对应（纯函数，见下） |
| `scene.ts` | 一份 bundle 在某个设备上的全部 GPU 资源与每帧编码（`GpuScene`，照 `graph.ts` 的步骤执行，ops 按图层分组）；粒子层的模拟器与顶点缓冲；模型层的网格缓冲与每帧视锥剔除（P5c）；`checkRenderable` 自查；`buildableLayers` 与 `visibleObjects` 的可见性跳过 |
| `state.ts` | CPU 侧场景状态 `SceneState`（`P3a`）：图层的可变字段、材质常量覆盖、泛光参数与脏集合；就地写落在它上面，`GpuScene.sync` 每帧取脏项。不依赖 GPU，单测在 Node 里核对「就地 = 重编译」 |
| `renderer.ts` | `SceneRenderer`：设备、画布上下文、时钟、帧循环、cover 铺放，场景可无缝替换 |
| `clock.ts` | 可暂停的时钟、帧时钟（帧时间钳到 `[0.0001, 0.25]`，P4a）、帧节流 |
| `bloom.ts` | 泛光链：`planBloom`（纯函数：RT、步骤、`g_RenderVar0`、HDR 参数换算）与 `BloomChain`（建 RT / 管线 / uniform，逐步编码） |

组件 `apps/kabegame/src/components/wallpaper/WpeSceneView.vue` 是自取数据的子组件，地位等同网页壁纸的 iframe（怎么挂上来见 [HOST.md](HOST.md)「显示」一节）：
- **props**：`target`、`paused`、`interactive`。
- **数据**：宿主的 `SceneHost` 接收垫片 `applyUserProperties`（`user[key].value` 组成 `userProperties`）、在 Worker 里编译、建渲染器。
- **重载**：垫片监听本张图的 `metadataId` 字段补丁并只交付变化键，`SceneHost` 的**应用函数**按绑定表分成就地写与重编译（P3a，见 [HOST.md](HOST.md)「属性与快速路径」）；只有重编译才在同一设备上换场景，时钟不重置。父页面下发的后处理 / 反射 / 阴影 / 体积光变了也重新加载（见 [COMPILE.md](COMPILE.md)「场景后处理档位」的「设置来源」）。
- **纹理缓存**：FreeImage 纹理的解码结果按目标缓存（`TextureDecodeCache`），改属性重编译不再解码 4K PNG；换目标或卸载时释放。
- **强制渲染**（2026-11-17 用户定，原 dev 的 D4）：设置「强制渲染」（WPE 设置字段组的开关，桌面是全局键 `wpeSceneForceRender`、预览与应用背景是这张壁纸的预览设置 `forceRender`，默认关，打开一律先确认，见 [WPE_IMPORT.md](../WPE_IMPORT.md)「壁纸设置与预览设置」）经场景设置消息的 `forceRender` 交给宿主（只认 `true`），变了整场重新加载（应用页的 `ImageContent` 把它当实时画面的刷新键，切换时直接重挂宿主、加载进度从 0 重走，宿主里这条路径只剩兜底）；开着时有不支持项也照常编译、解码并渲染（渲染器自查仍生效，真画不出来照样退回），日志「强制渲染（设置），不支持项：…」。dev 构建另可 `localStorage["kabegame-dev-scene-force-render"] = "1"`（主窗口与壁纸窗口同源共用，和设置取或，日志写「（dev）」），用来看半成品的构图，例如 bedroom 的脚本颜色按 `value` 静态显示。应用背景一律强制渲染；预览里场景显示不了时，底部红字原因下面有「我就要看」链接、桌面是一行指向壁纸设置的文字（见 WPE_IMPORT「壁纸设置与预览设置」），预览名称右边的警告色「强制渲染」只看设置。
- **emit**：渲染出第一帧 `ready`；不能渲染 `fallback(reasons)`。
- **生命周期**：换目标或卸载时终止编译、销毁 GPU 资源与设备；设备丢失时重建一次渲染器，一分钟内再丢就退回。
- **注意**：调用方传来的 `target` 往往是响应式 Proxy，交给 Worker 前必须拷成普通值，否则 `postMessage` 克隆失败。

**坐标与矩阵**
- WPE 场景坐标原点在左下、y 向上，`origin` 以像素计。WebGPU 的 NDC 同样 y 向上，渲染目标与纹理第 0 行都在上方（与 D3D 相同，翻译器按 `HLSL` 路径），所以全程不翻转。
- 顶点在模型空间：以图层中心为原点、未缩放的 `size`。
  - `g_ModelMatrix` 是世界矩阵 `W_parent · T(origin) · Rz·Ry·Rx · S(scale)`，角度为弧度、正角度为逆时针（P4a 起带父链与三轴旋转，见「层级（P4a）」；P1 只处理 z 轴）。
  - 视图投影为 `ortho(0…w, 0…h)`，`w` / `h` 是 `orthogonalprojection`；z ∈ [−2000, 2000] 映射到深度 `0.00025·z + 0.5`（反向 Z，`ORTHO_DEPTH`，P4a 起照 WPE 抓帧，原来是 ±10000）。
  - 场景 JSON 的相机 `eye` 对正交场景不起作用：LWE 的投影里 `translate(eye)` 与 `lookAt` 恰好抵消（抖动加在 eye 上的偏移会平移画面，见 [CAMERA.md](CAMERA.md)「相机：视差、抖动与缩放（P5a）」）。eagleflag 的 eye 有 (−378, −186) 的偏移，预览图里画面并未平移。
- 矩阵按列主序写进 uniform：翻译器把 `mul(v, M)` 改写成 `M * v`，缓冲里放「列向量」约定的数学矩阵，与 glm 的 `value_ptr` 相同。
- **纹理坐标**：图像顶边对应 v = 0。按图层主纹理（基础材质槽位 0）的 UV 缩放 = 图像尺寸 / 纹理尺寸（`width / textureWidth`，WPE `FUN_1402091e0`）收缩。
  WPE 把 1920×1080 的图放进 2048×2048 这类纹理，同一张图层各槽位的填充比例一致；FreeImage 形态的纹理尺寸已改成图像尺寸，UV 为 1。

**绑定与 uniform**
- **绑定**：照翻译器约定，全部在 group 0。
  - binding 0：两阶段共用的 uniform 块。
  - 纹理槽位 n：`textures[].binding`（1 + 2n）；采样器：`samplerBinding`（2 + 2n）。
  - 着色器声明了、材质没绑的槽位绑全 0 的占位纹理，同 D3D 空 SRV 的读数。
- **顶点布局**：按 `attributes` 的 location 交错排列；`a_Position`、`a_TexCoord` 来自四边形，其它属性补默认值。模型网格不走这条，按 mdl 的格式与属性语义建布局（P5c，见 [MODELS.md](MODELS.md)「静态网格（P5c）」的「绘制」）。
- **uniform 打包**：
  - 按 `offset` 写；标量 / 二三分量向量的数组按 `stride` 16 写前几个分量；`mat3` 列步长 16；整数写成 `i32` / `u32`。
  - 值来源：`drawUniformValues`（纯函数）先写内置值，再用材质常量覆盖。材质常量取自 `SceneState.constants`（编译期初值就是 `pass.uniforms`），就地改值时同一个函数重算，所以两条路逐字节一致（单测核对）。
  - **材质常量的取值照 WPE**（`compile/materialValues.ts`，`.claude/plans/wpe-import/3-scene/vector-constant-REPORT.md`，`p4b-vec` 实测）：缺键插注解缺省（先转字符串，所以数字缺省进向量不铺满）；setter 里数字进向量铺满，字符串进向量先清零、只按空格切、逐段 `atof`（`"a, b"` 得 (a, b)；照 UCRT 也认带符号的 `inf` / `infinity` / `nan`，P10b），float 只收数字，布尔 / 数组不写；`{user}` 先写 JSON 的 `value`，再把属性值交给同一个 setter，带 condition 的、布尔 / 下拉字符串 / 颜色绑 float 的都不写；就地写与脚本写回用同一个 setter、整体重写。同键不同类型被翻译器拆开的两半共用合并类型与缺省：取**读到它的**片元一半，片元没读时取读到的顶点一半（P7d，WPE 每阶段只收被使用的键、合并时片元覆盖顶点）。槽位只数被读的键（WPE 按键名排序给被使用的键分配，48 个 float 为上限）；被读的顶点一半比合并类型宽（多读下一个键的存储）与超过 48 个 float 照报 `constant:mixed-type:<键>` / `constant:slots`，语料 0 处。按用户决定不复刻同阶段同键只上传后声明的、按声明行子串定类型两条。
  - **图层的向量字段同这组 setter**（P6b 1e-3 复核，`compile/bindings.ts` 的 `layerVectorValue`）：`origin`、`scale`、图像层 `color`（vec3，`FUN_1401a4230`）与 `parallaxDepth`（vec2，`FUN_1401a3fc0`）和材质常量是 WPE 的同一组 setter（对象描述符表 `ignore/p3-userprops/notes/descriptors-decomp.txt`），编译期与就地写共用 `setterValue`：滑块数字绑 `scale` 时三个分量都是它，字符串少写的分量为 0；属性值写不进（布尔、条件换成的布尔）时留 JSON 的 `value`，运行中不改字段、不标脏。P1 起这里用 `numbers`，数字只得一个分量，`layerLocalMatrix` 再把缺的 y、z 补成 1：`3836725625` 的「时钟大小」0.72 让文字纵向拉长 1 / 0.72 倍；语料 34 张场景、245 个字段是这种绑定。`angles` 走另一个 setter（`FUN_1401df2f0`，没读透、语料没有标量绑它），照旧。
  - 只有 `g_Time`、`g_Frametime`、`g_Daytime`、`g_PointerPosition(Last)`、`g_PointerState`、`g_ParallaxPosition`（P5a）每帧刷新；被就地改过的 draw 由 `update` 整块重写一次；视差或相机（抖动、缩放）变了的那一帧，全部 draw 的矩阵与眼位重写一遍（P5a）。
  - **就地刷新**（`GpuScene.refreshLayer` / `refreshPass`）：图层状态变化只重写由图层算出的那组名字（`LAYER_UNIFORMS`：矩阵、`g_Color*`、`g_Alpha` / `g_UserAlpha`、`g_CompositeColor`），`pass.uniforms` 里有的名字一律不动（材质值优先，如 passthrough 的 `g_Color4 = (1,1,1,1)`、材质自带的 `g_UserAlpha`）；材质常量变化重写本 pass 的全部常量。
- **内置 uniform**：P2a 起按 WPE `FUN_1400d8300` 校正（PLAN P2a「内置 uniform」），名字表 `features.ts` 的 `ENGINE_UNIFORMS` 与 `uniforms.ts` 写的值一一对应。
  - 变换：`g_ModelViewProjectionMatrix`（及 Inverse）、`g_ModelMatrix`（及 Inverse）、`g_ViewProjectionMatrix`、`g_NormalModelMatrix`（世界矩阵 3×3 的三个本地轴各自归一化，照 WPE 用快速倒数平方根；P5c 前是逆转置，见 [MODELS.md](MODELS.md)「静态网格（P5c）」的「绘制」）。
  - 逆矩阵（`g_*Inverse`）：WPE 写常量缓冲时一律现算 `FUN_14005f730`（单精度余子式，rea-matrix-order 2.5），我们用照它搬运的 `uniformInverse`（`render/inverseF32.ts`），和 WPE 逐位相同（单位阵的逆非对角是 −0）；奇异时取单位阵（WPE 写进 inf / NaN，没有样本）。2026-11-15 前用 `math.ts` 的 double 求逆，末位常差 1 ulp：直接上屏的绘制在 8 位输出上看不出来，跨帧反馈的 8 位 RT 会放大（P13a `cursorripple`），见 [phase-f32-inverse](../../../.claude/plans/wpe-import/3-scene/phase-f32-inverse.md)。
  - 效果矩阵（w、h 取图层 `size`）：效果 pass 的 `g_EffectModelMatrix` = 图层世界矩阵 × scale(w/2, h/2)、`g_EffectModelViewProjectionMatrix` = 图层 MVP × 同一缩放、`g_EffectTextureProjectionMatrix` 与后者相同；上屏 pass 前两者不缩放、纹理投影 = MVP × scale(w/2, h/2)；各 Inverse 由对应矩阵求逆。直接上屏与基础 pass 沿用 P1（模型 / MVP，纹理投影单位阵）。
  - 对象：`g_Color4` = (color · k, alpha)、`g_Color` = color · k、`g_Alpha` / `g_UserAlpha` = alpha；k 在 LDR 下为 1（brightness 只在 HDR 下乘）。只在基础 pass 设一次：effect pass 沿用同一组值，passthrough 上屏置 (1, 1, 1, 1)。材质有 `Alpha` 时被覆盖。模型对象固定为 1，不读 `color` / `alpha` / `brightness`（P5c）。
  - 纹理：`g_Texture<n>Resolution` = (纹理宽, 纹理高, 图像宽, 图像高)，空槽 (2, 2, 2, 2)；`g_Texture<n>Texel` = (1/纹理宽, 1/纹理高, 纹理宽, 纹理高)，空槽 (0.5, 0.5, 2, 2)。合成 RT、fbo、快照按各自尺寸（纹理 = 图像）。`g_Texture<n>MipMapInfo` 还没实现（用到报 `uniform:`）。
  - 屏幕：`g_TexelSize` = 1 / 屏幕尺寸、`g_TexelSizeHalf` = 0.5 / 屏幕尺寸、`g_Screen` = (w, h, w/h)。WPE 取窗口（后备缓冲）尺寸，画合成 RT、fbo 时也不随目标变；我们取场景目标尺寸，与窗口同分辨率时等价。
  - 时间：`g_Frametime` = 本帧间隔，钳到 `[0.0001, 0.25]`；`g_Time` = 钳后帧时间的累加（P4a 起，`FrameClock`，见 [PARTICLES.md](PARTICLES.md)「粒子（P4a）」的「绘制」），超过 432000（5 天）归零；`g_Daytime` = h/24 + m/1440 + s/86400 + ms/8.64e7。
  - 指针：`g_PointerPosition` = 光标在画布上的归一化坐标（原点左上、y 向下，WPE 取窗口归一化坐标；P1 曾按 LWE 换算成场景坐标、左下原点），`g_PointerPositionLast` = 上一帧；`g_PointerState` = (按下, 按下, 本帧刚按下, 0)，还不跟踪按键（P6），恒为 0。粒子控制点跟随指针用的是另一个量（光标下的场景点，`FrameInput.cursor`），见 [PARTICLES.md](PARTICLES.md)「粒子（P4c）」的「指针」。`g_ParallaxPosition` = 视差点除以场景宽高再钳到 0…1，见 [CAMERA.md](CAMERA.md)「相机：视差、抖动与缩放（P5a）」。
  - 其它：`g_Texture0Rotation` = (1, 0, 0, 1)、`g_Texture0Translation` = 0、`g_LightAmbientColor` / `g_LightSkylightColor` 取 `general.ambientcolor` / `skylightcolor`。
  - 材质值优先于对象值：例如 beach 的云层材质 `Alpha` = 0.26，对象没有 alpha。LWE 会用对象值覆盖材质值，这里不照搬。
- **混合**：照 LWE `CPass::setupRenderFramebuffer`，颜色与 alpha 用同一组因子；其余模式关闭混合。
  - translucent：`src-alpha` / `one-minus-src-alpha`
  - additive：`src-alpha` / `one`
  - normal：`one` / `zero`
  - 画到场景目标的 pass 不写 alpha（LWE 最后一个 pass 前 `glColorMask(…, false)`），场景 alpha 一直是清屏时的 1；画进合成 RT / fbo 的 pass 写四通道，合成链带着 alpha 走到上屏。
  - 组里例外（P5b）：子孙「画到场景」的绘制落在组的合成 RT 里，直接画的写 RGBA，组 `copybackground: false` 时 alpha 用 One / One / Max，见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图像模型标志（P5b）」的「组」。

### 帧率（2026-11-16）

设置「帧率」（桌面全局键 `wpeFps`，预览与应用背景是每张壁纸的 `previewSettings.fps`；整数或 `"follow"`，默认 30）限制场景宿主的帧循环，也推给网页壁纸。

- **范围**：同 WPE 设置界面的帧率滑块，10 到显示器最高刷新率（`runtime.frequencymax`，rea-wpe-settings.md）。上限由 `get_display_max_refresh_rate` 现查（macOS `NSScreen.maximumFramesPerSecond`，Windows `EnumDisplaySettingsW` 的当前模式，取所有在线屏的最大值；Linux 取不到按 60），只用于界面；存储层只钳 [10, 1000]（`kabegame_core::wpe::fps`）。
- **生效值只在 Rust 算一次**：`wpe_web_get_state` 按调用方（父页面）窗口取设置（壁纸窗口取全局，主窗口取这张图的预览设置，同媒体集成的分流），`"follow"` 解析成 WPE `config.json` 的 `general.user.fps`（缺键按 WPE 的缺省 15；跟随不可用时 30），放进 `general.fps`。垫片照 WPE 网页壁纸协议调 `applyGeneralProperties(general)`，场景宿主在 `main.ts` 的 `wallpaperPropertyListener` 上接同一个回调，所以帧率不走父页面的场景设置消息。
- **跟随只读一次**：`config.json` 第一次读成功后缓存到进程退出（WPE 自己也只在启动时读它），文件不存在时不缓存。
- **改值就地生效**：桌面改全局键 → `setting-change` 带 `wpeFps` → 垫片重拉；预览改设置 → `metadataId` 补丁 → 垫片重拉；`general` 变了才回调。宿主 `setGeneral` → `SceneRenderer.setMaxFps`：节流器改上限，`GpuScene.setFrameRate` 改粒子 operator 遍数（1–20 两遍，`particlePasses`）与 rope 读的 `fps`，下一帧生效，不重新加载、不重新预热（预热固定一遍，drag 用实际帧时间，切遍数没有残留状态）。`load` 在 `await GpuScene.build` 期间收到的新值，换上新场景前补设一次。WPE 运行中改 fps 也是就地推给场景（0x467 → +0x18c）；粒子遍数是否同样当帧切换没有实测【推】。
- **高于刷新率**：rAF 按刷新率回调，实际帧率封顶在刷新率；粒子遍数与 rope 的 `min(fps, R)` 仍按设置值算，与 WPE 读设置一致。
- **随帧率变化的行为**：`engine.frametime` / `runtime`、`engine.setInterval` 的节拍、视频纹理「30 个渲染帧没画到就暂停」都按渲染帧走，限帧后自然跟着变，与 WPE 相同。场景脚本的 `applyGeneralSettings` 在 WPE 的声明里只带 `language`（`lib.sceneScript.d.ts`），与帧率无关。

### 播放速度（2026-11-17）

壁纸设置「倍速」（视频与场景共用一个值，用户定；桌面全局键仍叫 `wallpaperVideoPlaybackRate`，预览是这张的 `previewSettings.playbackRate`）与预览控制条的
倍速（临时值，用户定：默认取设置值、不保存）。范围统一 0.25–4（应用 `WPE_PLAYBACK_RATE_MIN` / `MAX`、宿主 `PLAYBACK_RATE_MIN` / `MAX`、Rust
的设置与预览设置同样钳到这里，字面量测试比对）。

- **通路**：`ImageContent` 把 `playback.playbackRate`（钳过）交给 `WpeWallpaperContent` 的 `rate` → `WpeSceneView` → 宿主
  `kabegame:wpe-scene-rate`（宿主请求时回、变了再推）→ `SceneHost.setPlaybackRate`，就地换、不重新加载；网页壁纸不吃。
- **帧时间**：`FrameClock` 先把帧时间钳到 `[0.0001, 0.25]` 再乘速度，`g_Time`、`g_Frametime`、粒子、关键帧、puppet、脚本（`engine.runtime` /
  `frametime`）、声音排期、动图都跟着；先钳再乘，速度恒为 ×rate、和帧率正交（不然 4× 在 10 fps 下撞上 0.25 只有 2.5×）。
- **和帧率的关系**：整体推进速度只看真实流逝的时间与倍速，帧率不改速度；帧率改的是切片粒度（≤ 20 fps 时粒子 operator 两遍、drag 系数看帧时间、
  ropetrail 每帧最多采一次），倍速大、帧率低时每帧的步长变大（4× 在 10 fps 下 0.4 s 一步），粒子更粗，这和 WPE 换帧率时的差异同类。
- **自己有时钟的**：视频纹理 `CodecVideoPlayer` 的时钟乘「脚本 `rate` × 宿主速度」（换速度前走过的墙钟按旧速度结清，脚本读到的 `rate` 不含宿主
  速度）；声音元素设 `playbackRate` / `defaultPlaybackRate`（音高照浏览器缺省保持）。用户纹理里的视频没接，照常速。
- **WPE 没有这个功能**：和 WPE 对照时保持 1。

### 图层渲染图（`graph.ts` + `scene.ts`，P2a）

依据 WPE 2.8.42 的只读逆向（p2-REPORT B5–B8、PLAN P2a；与 LWE 冲突时以 WPE 为准）。`planLayer(layer, textures)` 是纯函数，把一个图层排成步骤；`GpuScene` 照步骤建资源、逐帧编码。

- **直接上屏**（P1 路径原样保留）：没有启用的 effect，且 colorBlendMode ∈ {0, 31}。基础 pass 用图层几何画到场景，31 时混合改 additive。eagleflag / deep_space / beach 都走这条。
- **合成**：有启用的 effect，或 colorBlendMode ∉ {0, 31}。
  - 基础 pass 关闭混合（不透明写入、保留 alpha），正交投影把图层四边形画满合成 RT，UV 只采样纹理的有效区域；
  - effect 逐 pass：没有 `bind` 时槽 0 = 上一步输出（当前合成 RT）；有 `bind` 时只按 bind 赋值，找不到的名字（如 `previous`）= 当前合成 RT。`target` 是本 effect 的 fbo 就画进 fbo，缺省或 `compose: true` 写进合成链（ping-pong 下一张）；画全屏四边形，混合用 pass 自己的；
  - 上屏：只有最后一个启用 effect 的最后一个绘制 pass 用图层世界四边形、场景视图投影 × 图层模型矩阵画到场景，借用基础材质的 blend（colorBlendMode 31 强制 additive）；
  - colorBlendMode ∉ {0, 31}：effect 都留在合成链，最后用 passthrough 材质上屏（combos `BLENDMODE = cbm`、`FOG_COMPUTED = 1`，槽 0 = 最终合成 RT，`g_Texture4` 由注解默认绑到快照，颜色 (1,1,1,1)，blend 取基础材质的）。材质看 `scene.json` 顶层 `version`：> 2 用 `effectpassthrough_4.json`（genericimage4），否则 `effectpassthrough.json`（genericimage3），见 `bundle.ts` 的 `passthroughMaterial`。没有 effect 时也走「基础 pass → 合成 RT → passthrough」。
  - 组合层、fullscreen 与组（P5b）换掉的是基础 pass（`compose` / `clear` / 拷贝当前画面）与几何、矩阵，之后的 effect 链与上屏照上面走，见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图像模型标志（P5b）」。
- **模型图层**（P5c）：每个网格一个 `mesh` 步骤，按编译期排好的顺序直接画到场景目标，没有合成路径；整层先做一次视锥剔除，见 [MODELS.md](MODELS.md)「静态网格（P5c）」。
- **合成 RT 数** = min(2, 写进合成链的次数)：基础 pass、每个 effect 的最后一个绘制 pass 与每个 `compose` pass 各写一次，上屏那次不算，即 WPE 的 `min(2, passthrough + Σ(1 + compose))`；第 n 次写进 `n % 2`。尺寸（`compositeSize`）：fullscreen 取 `fullscreenSize`；否则取基础材质槽 0 纹理的图像尺寸，没有纹理、模型 `solidlayer` 且不是 `instanced`、组合层取 `round(size)`（P5b）；max(4, ·)；格式 LDR `rgba8unorm`、HDR `rgba16float`。合成 RT 按尺寸与采样方式跨图层共享（WPE `sc.<W>.<H>…`），采样跟随基础纹理的 clamp / nointerpolation；组里的图层按父链上组的层数另分一池（P5b）。
- **fbo**（effect.json `fbos`）：格式 `rgba_backbuffer` / `rgb_backbuffer` 随 HDR，其它查格式表（`FBO_FORMATS`：rgba8888、rgb888、rg88、r8、rg1616f、r16f、rgba16161616f、rgb161616f），不认识的按 rgba8888；尺寸 W′ / H′ 取 `width` / `height`（≤4096）否则合成 RT，`fit`（≤4096）时 W′ < H′ 则 h = min(fit, H′)、w = W′/H′·h，否则 w = min(fit, W′)、h = H′/W′·w，截断后整除 `scale`，最小 2；`unique` 每层独占，否则按名字、尺寸、格式、寻址共享；`clear` 创建后清成该色，要写满 4 个分量才生效（P7d，WPE 解析出 4 个数才置清除位）；`uvs: "repeat"` 重复寻址，否则 clamp；被 `conditions` 去掉的不建。
- **命令**：`copy` = `copyTextureToTexture` 把 source 整张拷到 target（格式必须一致）；`swap` 不做 GPU 工作，只交换后续 pass（含之后各帧）里这两个名字指向的实体（`FboBindings`），引用 fbo 的 bind group 按当前对应取并缓存。WPE 的做法是改写本 effect 全部非 swap pass 的下标、不交换纹理（rea-p7d-fluid 第 3 节），效果等价；一端被 `conditions` 去掉时什么都不做。
- **UV 内缩**（`layout.ts` 的 `uvInset`）：上屏的四边形两端各缩 `0.15 / 分母`，float32 逐步算，包括直接上屏、最后一个 effect 上屏和 passthrough 上屏；基础 pass 和 effect 中间 pass 不缩。分母是基础纹理的纹理尺寸，走合成路径时也是，不是合成 RT；没有纹理时是图层 `size` 的整数部分。不缩的条件分两块（P5b）：直接上屏在模型 `fullscreen`、`nopadding`、`passthrough`、`solidlayer`（含 instanced）时不缩，末 pass 与 passthrough 上屏不看 `nopadding`。
- **`_rt_FullFrameBuffer` 快照**：场景目标整张 `copyTextureToTexture` 到独立纹理，**绝不采样正在写的目标**。每图层至多拷一次，时机是三处里最早满足的一处：图层开始时（基础材质需要帧缓冲，或走 passthrough）、需要帧缓冲的 effect 的第一个 pass 之前、上屏 pass 之前；内容都是画到本图层之前的场景（合成链不画进场景）。本帧还没画过场景时先清屏再拷。快照纹理带 `COPY_SRC`：fullscreen 的合成路径要把它拷进合成 RT 0（P5b）。WPE 第一处另有「非 fullscreen 或有子层、无 passthrough 父层」的条件：组合层的基础 pass 本来就读快照。组里（P5f）：快照拷的是「当前目标」即组的合成 RT，只拷左上角重叠部分，第一处在直接父是组时不拷，effect 前、粒子前照拷，组里的上屏不拷，见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「组里读快照（P5f）」。
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
| `camerashake*`、`cameraparallax*`、`zoom` | 渲染器每帧读（P5a）：抖动与缩放在帧开头按脚本之前的值取，视差点按脚本之前的值推进，绘制用的视差开关与 `amount` 取脚本之后的值，见 [CAMERA.md](CAMERA.md)「相机：视差、抖动与缩放（P5a）」的「一帧里的顺序」 |

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
- **档位切换**：宿主收到父页面下发的新档位后整场重编译，`GpuScene` 按新的 HDR 状态重建场景目标格式。桌面用全局「壁纸设置」，预览与应用背景用这张壁纸的「预览设置」（推翻 D13 的「预览、应用背景与桌面用同一个设置」），不为预览降档。
- **泛光参数就地改**（P3a）：`bloomstrength` / `bloomthreshold` / `bloomtint` / `bloomhdrstrength` / `bloomhdrthreshold` / `bloomhdrfeather` / `bloomhdrscatter` 绑用户属性时就地重算 `BloomChain` 各 pass 的常量并重写 uniform（`BloomChain.setParams`，按 `hdrBloomConstants` 同一套 float32 换算，单测核对与重新建链逐字节相同）。
- **级数就地**（P3c）：金字塔总是建满全部可用级，每帧只用前 N 级。绘制按步骤身份（pass + 输入 + 目标）去重，8 级共 21 个，`setParams` 取出这一级数要用的绘制。每帧下采样整张覆盖，改级数不残留。
- **开关就地**（P3c）：`general.bloom` 是场景位 `SceneState.bloomEnabled`，不含档位，脚本读到的也是它。档位关闭时没有链，位怎么变都没有效果，和 WPE 一致。写死 `bloom: false` 的场景也没有链，被脚本打开时走整场重编译；WPE 这里同帧生效，这是有意的差异，换来带脚本的场景不多占显存。
- **HDR 只在加载时判定**：判定里的 `bloom` 读场景文件的 `value`，不读属性当前值，也不看脚本写入；`hdr` 读属性当前值与脚本覆盖。所以 JSON 为 true、属性为 false 的场景是关着泛光的 HDR 场景，运行中打开是 HDR 泛光。运行中关掉 HDR 场景的泛光，目标格式和 `brightness` 都保持 HDR。`general.hdr` 改值走整场重编译并生效；WPE 运行中改不生效，这里有意不跟。
- **显存**（`GpuScene.targetBytes`，渲染目标类资源，不含纹理）：bedroom 4K 关闭 / 开启 / 超高约 70 / 73 / 161 MiB，HDR 多出的主要是 FP16 的场景目标与快照（各 63 MiB）和金字塔（约 21 MiB）。
- **链路隔离验证（dev 探针）**：`apps/wpe-scene/src/dev/` 在 dev 构建挂 `window.__kabegameSceneProbe`（`vite.config.ts` 的模式常量门控，生产构建里整块被摇掉，已用生产构建确认）：
  - `bloom({ assets, hdr, params, input, references })`：输入 RenderDoc 导出的整帧快照（RGBA16F `.dds` 或 RGBA8 `.png`），跑同一份 `BloomChain`，读回第一步、泛光结果（`_rt_Bloom` / L0）与最终输出，和 WPE 的对应纹理逐像素比（HDR 中间结果按浮点、最终输出把 WPE 的线性后备缓冲按 sRGB 编码成 8 位再比）。图片一律经 GPU 纹理上传、读回，不走 2D 画布（RenderDoc 存的 RT alpha 常为 0，过画布会因预乘丢掉 RGB）。
  - `renderFrame({ projectDir, sceneAssets, postprocess, time, profile, canvas })`：按固定 `g_Time` 渲染一帧、同步读回场景目标，给 SHA-256、PNG、显存估算与逐帧耗时；`chunk(key, i)` 分块取回存下的 PNG。给 `canvas: [宽, 高]`（正整数，不超过 `maxTextureDimension2D`）时，正交场景按这个尺寸直接画（2026-11-14，[phase-render-size](../../../.claude/plans/wpe-import/3-scene/phase-render-size.md)，同 WPE 测试窗口）：场景目标就是 `canvas`，`style`（缺省 `fill`）照 WPE 的对齐方式做进正交投影的四个裁切边距（`render/layout.ts` 的 `alignEdges`，读码 [rea-render-size](../../../.claude/plans/wpe-import/3-scene/rea-render-size.md)），`fit` / `center` 整个目标清成 `schemecolor`，读回场景目标本身；`g_Screen` / `g_TexelSize` / 快照 / 泛光 / 深度按窗口，视差、`g_EyePosition` 仍是场景单位，光标是窗口坐标、跟随点按裁切后的 VP 反投影，透视粒子相机照读码第 5 节；结果的 `render` 写明画法。`renderMode: "scene"` 取旧的「场景分辨率画、读回时用上屏同一份着色器按 `fill` 铺进画布」（kabegame-chromium 第 5 批，逐字节同以前）。2026-11-19 起产品的画法就是给了 `canvas` 时这一份（方案 A）。`resizeFrom: [宽, 高]`（方案 A 第 1 步）：先按它建场景、再 `GpuScene.resize` 换到真正的尺寸，用来验收原地换尺寸；结果带 `resizedFrom`。光标的换算窗口是 `window ?? canvas`（两个都给而不同时抛错）。不给 `canvas` 时逐字节同以前。给 `scriptValues: [{ object, field, value, optional? }]`（`objects` 下标或对象名、图层字段、1–4 个数或布尔）时，探针不跑脚本，按它找到 bundle 里挂在该字段上的字段脚本，建好场景之后、回放之前用绑定目标经 `SceneState.write` 写进状态（同宿主的脚本写回，`dev/scriptValues.ts`），结果的 `scriptValues` 逐项回 `applied`；名字重名、或不带 `optional` 时找不到对象 / 没挂字段脚本抛错。kabegame-dev 回放时用它把 kbp 测试工程的 FR 帧号块涂成读回那一帧的颜色（第 6 批）。给 `scripts: true | { clock?, seed? }` 时探针照宿主跑场景脚本（`dev/probeScripts.ts`：同一个 `createIframeRealm`、`ScriptApi`、`ScriptRuntime`，写回与读取和宿主共用 `script/stateWrite.ts`）：建好场景、视频就绪之后跑 `init` 并整份交一次用户属性，回放的每一帧（含读回帧）设好相机、推进完关键帧动画之后跑一帧（同渲染器 `beforeFrame` 里动画之后的位置；有回放时每一帧都画，每帧都是渲染器的完整顺序 `sync` → 步进 → 相机 → 动画 → 脚本 → `setParallax` → `sync` → `update` → 编码，视差点按帧开头的 general 推进），profile 帧不跑；外部值都来自请求：`engine.runtime` / `frametime` 是回放的这一帧，`screenResolution` 是 `canvas ?? window ?? [1920, 1080]`（`canvasSize` 仍是场景尺寸），`Date` 与 `engine.timeOfDay` 是 `clock`（缺省 2026-01-01T00:00:00Z）加回放时间、`g_Daytime` 跟着它（每帧都画时每一帧），`Math.random` 按 `seed` 的 mulberry32 序列，`localStorage` 只在内存，音频缓冲全 0，声音 / 视频 / 粒子层的脚本方法空操作并计数；要整场重编译的写入做不了、记进结果的 `scripts.recompile`。不和 `scriptValues` 同给；不给时逐字节同以前（kabegame-chromium 第 7 批）。给 `trace: true | { readback?, maxVertices? }` 时，探针把设备换成记录器包过的那个（`render/trace.ts`：设备与队列是转发代理，建出来的纹理、缓冲、编码器、pass 都是真对象、只在实例上加记录用的方法），读回那一帧逐个 pass、逐个 draw 记下目标、管线、绑定、uniform（建 uniform 缓冲处 `traceUniforms` 登记反射，按名字解码，取提交那一刻的值）、索引与顶点，选中的 pass 结束后读回它的颜色附件，存成 `<key>.trace.json` 与 `<key>.pass<下标>.png` / `.f32`（`dev/drawTrace.ts`），用来和 WPE 的 RenderDoc 抓帧逐 draw 对照；`traceUniforms` 在生产构建里是空操作（用宿主的 vite 按 `__SCENE_DEV__ = false` 构建一个只调它的入口核对过：调用处被内联掉、不留 `WeakMap`，记录器整块被摇掉），不给 `trace` 时设备不包、逐字节同以前（`.claude/plans/tools/scene-draw-trace.md`）。

**铺放与帧循环**
- **铺放**（2026-11-19 起按画布分辨率画，[phase-render-size-product](../../../.claude/plans/wpe-import/3-scene/phase-render-size-product.md)）：
  - 同 WPE：场景目标就是画布像素（布局 × DPR × 显示缩放，超 `maxTextureDimension2D` 时等比缩），壁纸样式做进正交投影的四个边距
    （`alignEdges(ALIGNMENT_OF_STYLE[样式], 场景宽高, 画布像素 / pixelRatio)`，读码 [rea-render-size](../../../.claude/plans/wpe-import/3-scene/rea-render-size.md)），
    `fit` / `center` 整个目标清成 `schemecolor`、越出场景边界的图层在留白里看得见；上屏是整块 1:1 拷贝（`stretch`），输出不透明（`alphaMode: "opaque"`）。
    `center` 是一个场景单位对一个布局 CSS 像素（WPE 是一个客户区像素、不看 DPI）。取值规则和 dev 探针给了 `canvas` 时是同一份（`render/renderer.ts` 的
    `desiredTarget`），所以探针和 WPE 的逐像素对照对产品同样成立（eagleflag 产品画面与探针逐字节相同）。
  - `tile` 没有对应的对齐方式，保留旧画法：按场景分辨率画，上屏等比放进后重复。
  - 透视场景同样按画布像素画，上屏铺满。
  - **换尺寸**（窗口、侧栏、全屏、DPR、显示缩放、预览放大）：渲染器去抖 300 ms 后调 `GpuScene.resize(next, state)` 原地换（同 WPE 的
    `FUN_14017f1b0`：只重建按目标尺寸分配的 RT——场景目标与交替目标、深度、快照、泛光链、反射两张 RT、体积光、裁切遮罩、sprite 计数目标——并整层强制重建
    绑定与 `g_Screen` 等静态 uniform；状态、粒子、脚本、关键帧、puppet、计时器都不动）。新资源先在旁边建好、一次同步换上，等待期间旧目标拉伸上屏；
    只改样式或留白色时立即换、不重建 RT；`resize` 失败时宿主整场重新加载兜底（`onResizeFailed`）。全库探针对比「建在 A、换到 B」与「直接建在 B」逐字节相同。
  - 2026-11-14 到 11-18 之间产品先按场景分辨率画、上屏再缩放（小场景如 dino_run 343×193 放大四五倍显示时文字明显糊），方案 A 改掉。
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

## 层级（P4a）

图层有了父子关系。层级只改矩阵与可见性，不碰渲染图，图像层与粒子共用。依据是 P4a 步骤 0 的实测（工程 `ignore/p4/proj/p4a`，抓帧 `A:\p4a\`，[p4-particles-REPORT](../../../.claude/plans/wpe-import/3-scene/phase4/p4-particles-REPORT.md)「P4a 语义的实测核对」）。

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
