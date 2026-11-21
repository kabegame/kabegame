# 场景壁纸：音频、媒体与用户资源

> [场景壁纸文档](../WPE_SCENE.md) 的一章：音频频谱 uniform、用户纹理、纹理变体、媒体、快捷方式（P11）。总体形态、各阶段状态与全部章节的索引在总览里。

## 音频频谱 uniform（P11a）

六个 `g_AudioSpectrum{16,32,64}{Left,Right}` 就是场景频谱（上一节的 `SceneSpectrum`）的三块左右声道。WPE 每次绘制把渲染线程归一化好的数组按 `4n`
字节拷进常量缓冲（rea-p4e-audio 3.4、rea-p11-textures 第 6 节），实测 32 段、16 段由 64 段两两取最大、左右声道各自算，工程没声明
`supportsaudioprocessing` 时全 0，没有平均声道的 uniform（`.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md`「音频 uniform」）。

- **能力表**：六个名字在 `compile/features.ts` 的 `AUDIO_UNIFORMS`，并进 `ENGINE_UNIFORMS`，不再报 `uniform:g_AudioSpectrum*`。
- **写入**：`render/uniforms.ts` 的 `frameBuiltins` 收 `FrameInput.audio`（`SpectrumUniforms`，`SceneSpectrum` 本身就是这个形状），直接给数组引用；
  翻译器把 `uniform float g_AudioSpectrum16Left[16]` 反射成 `array<vec4<f32>, 16>`、`declared: "float"`，`UniformBlock.set` 每个元素只写 `.x`。
  没给频谱时写全 0。渲染器把自己的 `spectrum` 交给 `GpuScene.update`：频谱在帧开头推进，粒子、脚本、uniform 这一帧读的是同一份值，同 WPE。
- **订阅**：`bundle.audio` 也认读这六个 uniform 的程序（`readsAudioUniforms`：翻译器标了 `unused` 的、带 `meta.material` 的同名作者常量都不算），
  开关仍只看 `project.json` 的 `supportsaudioprocessing`。三个桌面平台都有回环采集：Windows（WASAPI）、macOS 14.2+（Core Audio 进程 tap）、Linux（PipeWire 输出设备监听，2026-11-21 真机核对过：订阅成功、频谱与音频粒子随音乐变化、静音后归 0），见 [../WPE_IMPORT.md](../WPE_IMPORT.md)「音频与媒体集成」；采集打不开（macOS 14.2 以下、Linux 没有 PipeWire）时频谱全 0。
- **确定性回放**：dev 探针的 `ParticleAudioFrame` 另带 32 / 64 段，读回那一帧把截至这一帧的频谱交给 `update`；kabegame-dev 的
  `replay.timeline.audio` 读录制（`kbp rdc consts --no-clock` 的输出或带 `frames[].audio` 的轨迹），按帧号对齐、缺的段按两两取大往下推。
- **验收**：生成工程 `p11-bars`（六个数组各画一排色块，`ignore/p11/defs/p11a.py`）4 帧和 WPE 整帧逐像素相同。真实壁纸的复制工程走查
  （Liberty `3502090109`、少女 `3825170583`、Miku `3585875739`）见 `phase11/phase-11a-audio.md`「实施记录」。

**已知差异：**
- **fxc 重新结合连乘**：fxc 把 `g_Time * a * a`（a 是 uniform）算成 `g_Time * (a * a)`，我们照 WGSL 源码顺序算 `(g_Time * a) * a`。两种结合在一部分帧上
  舍入不同，坐标差约一个 ulp；按扰动坐标采样的 effect（少女的 `waterripple`）在 alpha 边缘差 1–2 级、几十到一百多个像素。复制工程里把源码改成
  fxc 的结合后这些帧归零（`ignore/p11/a/walk/ripple/`）。fxc 的优化规则没有逐条复刻。
- **片元的零星舍入差**：和顶点无关，最大 1 级、每帧 0 到几十个像素，出在落在舍入中点附近的像素上（Liberty 的音频条 pass 用 numpy 复算过，
  两边离精确值的偏差分布相同）。陡边上能见到 2 级：P6c 走查 `3810092560` 的水波 effect（waterwaves）按 `sin` / `pow` 扰动 UV 再双线性采样，
  WPE 是 fxc 的 DXBC、我们是 WGSL 经 Dawn，UV 在 float 舍入量级上不同，偶尔跨过 GPU 双线性 1/256 子纹素权重的台阶（依据 `ignore/p6/cw/cmp/`）。
  「中点」不是 .5：P13e 走查（2026-11-15，本机 NVIDIA、D3D11 与 Dawn D3D12 相同）按整张 RT 的 float64 复算测出，硬件把浮点写进 RGBA8
  （有混合）时，第 n 级往上取的门槛是 `n + t(n)`：t(n) 每升 1 级降约 1/256，大约每 16 级跳回约 .56（测到的段 n = 9–16、61–148 里
  跳在 16、64、80、96、112、127、143；如 n = 9 → .5252、15 → .5017、16 → .5598、61 → .5088、64 → .5593、126 → .504、127 → .562）；两边在 n + t(n) 两侧各取一边，确定性工程、
  地面光照、体积光正面里每一处差 1 级的像素都正好落在这个门槛上（`ignore/p13/e/fc_front_threshold.py`、`fc_ground*.py`、`fc_front_mesh.py`）。
  透视场景插值的世界坐标有 float 误差（顶点按 1/256 像素对齐到网格，两边顶点的 float 舍入不同就可能对齐到相邻的网格点），门槛附近的
  不确定带宽到 ~1e-3 级，聚光锥边这类梯度大的地方更宽（`p13e-spot` 立方体上一个像素离 WPE 的门槛 0.0034 级，相当于 1/526 像素）。
- **场景比窗口大时的上屏**：2026-11-18 之前产品先画场景分辨率再缩，WPE 按窗口分辨率直接画；2026-11-19 起产品也按窗口（画布）分辨率画（见「铺放与帧循环」），这一项不再有。dev 探针按窗口尺寸画时本来就没有：Liberty（3840×2160 场景、1920×1080 窗口）4 帧和 WPE 逐像素相同，音频条与模糊 pass 的零星舍入差在这个分辨率下也没出现（[phase-render-size](../../../.claude/plans/wpe-import/3-scene/phase-render-size.md)「步骤 2」）。

## 用户纹理（P11b）

材质 pass 的 `usertextures` 让某个纹理槽在运行中换成场景外的图。WPE 只有一套做法，来源有三种：用户属性（`scenetexture`）、系统伪属性（媒体封面）、快捷方式图标。加载材质时每个有效项登记成「槽号 → 来源」；来源的值变了，下一帧开头重跑这个材质的纹理解析，每个槽按当前值取纹理。P11b 照这个形状做、只接属性来源，封面（P11c）与图标（P11d）以后往同一张来源表里放数据；P11c 已接上封面（见「媒体（P11c）」）。依据：读码 [rea-p11-textures](../../../.claude/plans/wpe-import/3-scene/phase11/rea-p11-textures.md) 第 1、2 节与 [rea-p11b](../../../.claude/plans/wpe-import/3-scene/phase11/rea-p11b.md)，实测 [p11-REPORT](../../../.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md)「属性纹理」「P11b 补测」（M1–M9），计划、实施记录与走查见 [phase-11b-usertextures.md](../../../.claude/plans/wpe-import/3-scene/phase11/phase-11b-usertextures.md)。面板、取值与 `file:` 放行见 [WPE 导入文档](../WPE_IMPORT.md)「用户属性」。

| 层 | 位置 | 做什么 |
|---|---|---|
| 编译 | `compile/usertextures.ts`（`parseUserTextures`、`mergeUserTextures`），`compile/bundle.ts` 的 `compilePass` | 每个生效的槽（`textures[i]` 是非空字符串、`i < 10`、项有非空名字）记一条 `UserTextureSlot`：来源、参考尺寸、缺省纹理的点采样 / 夹取位，挂在 `ScenePass.userTextures`；instanced 的 `instance` 与 effect 实例覆盖按槽合并；属性来源在绑定表登记一条就地目标 `{ kind: "user-texture"; name }`，用到的属性名汇总进 `SceneBundle.userTextures`。缺省纹理照旧编进 `ScenePass.textures` |
| 来源表 | `usertex/sources.ts`（`UserTextureSources`） | 宿主一份、跨重编译保留：按属性名存当前值，异步读文件、解码、裁切；同一来源连续改值只认最后一次，后发先至的结果丢掉；静态图按值缓存最近 4 张，来回切换不重复解码；不存 GPU 资源 |
| 裁切 | `usertex/crop.ts` | 照 WPE 的取整（`FUN_1401702f0`）在源图正中裁出最大矩形，比例取参考尺寸，像素一比一；纹理名 `值 + "x" + round(比例·10)`，比例四舍五入到 0.1 相同的槽共用一张、按先建的那个槽的精确比例裁 |
| 解码 | `usertex/png.ts` + `render/userGamma.ts`、`usertex/gif.ts` | 见下「解码」 |
| GPU | `render/graph.ts`（`TextureRef` 的 `user` 变体，`fallback` 是缺省纹理）、`render/scene.ts`（`syncUserTextures`、`rebindUserDraw`、`ensureUserSizing`） | `sync` 收「来源换好了」：槽 0 在图像层上的整层强制重建，其余只重绑 draw；没有槽引用的用户纹理在 `sync` 末尾销毁 |
| 宿主 | `host.ts` | 加载时对 `bundle.userTextures` 的当前值预解码（`primeUserTextures`，上限 5 s），解码完才建场景，第一帧就是用户图；运行中 `applyChanges` → `SceneState.write`（`user-texture` 目标，记 `userWritten`）→ 来源表；暂停与文档隐藏转给来源表的 `setPaused`；实时帧开头 `beginFrame(frametime)` |

**取值与纹理**（WPE 实测）：
- 值是 `/` 分隔的绝对路径。空串、文件不存在、读不出、解码失败都回缺省纹理，不保留上一张，只记一条 debug。属性没声明或不是 `scenetexture`（语料有 `slider`）时值不是字符串，当空串，永远是缺省纹理。
- 参考尺寸四种：缺省纹理 `.tex` 头的**图像**尺寸（不是补到 2 的幂的纹理尺寸），精灵表取 TEXS 头的格宽高（`SceneSheetFrames.cell`，WPE 的 `tex+0xb0/+0xb4`；P11b2 走查前用「归一化帧宽 × 图像尺寸」再取整，`rosepetals` 的 102×128 算成 103、300×200 的图裁成 160 宽，WPE 是 159）；instanced 取对象 `size`（M2，WPE 把它写进 `instance.usertexturereference`）；显式的 `usertexturereference`；缺省是被依赖图层的合成 RT（`_rt_imageLayerComposite_<id>_a`）时取那张 RT 的尺寸，运行中改值按它裁、替换掉 RT，加载时就有值则不生效（M3、M8），第一次改值之后才生效。
- 纹理是 `rgba8unorm`、1 级 mip、没有各向异性，`g_Texture<n>Resolution` = 裁后的 `(w, h, w, h)`；寻址与过滤沿用缺省纹理的夹取位与点采样位，GIF 另强制点采样。超过设备的 `maxTextureDimension2D` 时用缺省纹理、记一条 warning（WebGPU 缺省上限 8192，WPE 是 D3D11 的 16384【推】）。

**换图时要更新的**：
- **任一槽**：这处 draw 的 bind group、`g_Texture<n>Resolution` / `Texel`；组合层（passthrough 模型）与 instanced 在这个 pass 有用户纹理生效时 `g_Color4`、`g_Color`、`g_Alpha` 强制为 1，回到缺省时恢复对象值（WPE 每次绘制现读这一位，rea-p11b 4.3）。
- **图像层的槽 0**：走文本重排同一条整层强制重建 `rebuildLayer(…, { force: true })`。UV 上界是图像 / 纹理尺寸，用户纹理是 1（M1）；内缩 `0.15 / 新纹理尺寸`；instanced 的合成 RT 是裁后的用户图尺寸（M2）；effect fbo 与被依赖图层的独占 RT 按新尺寸换（`ensureUserSizing`）；`fullscreen` 的尺寸。`autosize` 的图层尺寸取参考尺寸，换图前后不变。
- **其它槽**（几乎都是 effect 实例 pass 的槽 1）：不重建，只换 bind group 与常量（`rebindUserDraw`）。

**解码**：
- **静态图**：`createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "from-image" })` 再 `copyExternalImageToTexture`。8 位 PNG（调色板 + `tRNS`、灰度 + alpha）、16 位 RGBA PNG（取高字节）、BMP、ICO 与 WPE 的 FreeImage 逐像素相同，JPEG 的 EXIF 方向一致（M7）。
- **PNG 的 `gAMA`**：宿主自己读这一块，`|2.2·g − 1| ≥ 0.05` 时对 RGB 查 libpng 的 8 位表 `floor(255·(i/255)^(1/(2.2·g)) + 0.5)`（M9）。表在上传时由 GPU 逐字节查（`render/userGamma.ts`），不经 2D 画布读回：画布是预乘 alpha，半透明像素有舍入损失。
- **GIF**（`.gif`）：照 WPE `resourceutil64.dll` 里的 stb 派生解码器逐字节移植，不照 stb 原版：
  - 调色板按 BGRA 存：disposal 2 把调色板项原样填进上一帧写过的像素（R、B 互换），上一帧不透明时用背景色那一项、否则用 transparent 那一项；
  - `bgindex` 只在有全局调色板、非 0、不越界时保留；首帧（含重新开始）只在本帧没有透明位时填背景；
  - disposal 3 恢复两帧之前的画布（没有时按 2 处理），alpha > 128 才写；
  - 只在被画到时推进、每个渲染帧最多前进一帧：剩余时间按 float32 减本帧 `g_Frametime`，≤ 0 才换下一帧，超出部分带到下一帧；延时 = 10 × GIF 的 delay 毫秒，不设下限；无限循环；图层隐藏、壁纸暂停时不推进、也不补时间。
- **视频**（`.mp4 .wmv .avi .m4v .mov .mkv .webm`）：和场景视频同一个播放器 `CodecVideoPlayer`（P9d，见 [SOUND_VIDEO.md](SOUND_VIDEO.md)「视频纹理」），循环、不出声、自己的时钟、30 帧没画到就暂停都同场景视频。先整段读成 Blob（`file:` 响应没有长度，拆包要先知道总长；Chromium 把大 Blob 换到磁盘），再按切片读（`blobRangeReader`）。纹理按裁后尺寸建，裁切写在 `copyExternalImageToTexture` 的源矩形上，几何 UV 不变。第一帧最多等 10 s，建不起来（含 `.wmv`、`.avi`、`.webm` 等拆不了的封装）用缺省纹理（不是透明）。面板只给 `.mp4`，别的扩展名只可能来自手输，同样认。
- **用户视频的颜色**（`ColorRule` 的 `"user"`）：矩阵照码流标签（`colr` → H.264 SPS 的 VUI），没标时按高度：高 > 576 用 BT.709，否则 BT.601，宽度不参与（P9d 步骤 4 在 WPE 实测的分界：720×576、1280×480 → 601，720×578、480×720、1024×700 → 709）。WPE 读用户视频不看标签、只按高度（480² 标 709 → 601、720² 标 601 → 709），算 WPE 的缺陷，我们照标签（有意不同：用户视频不在语料里，没有画面依赖它）。原色、传递函数、范围与色度位置同场景视频。
- 扩展名转小写再判断（`mediaKind`）。GIF 与视频按值共用一份（引用计数），每个纹理名各一份帧状态；不进按值的解码缓存，换走再选回来从头开始（同 WPE）。

**能力表**：不再整个报 `material:usertextures` / `effect:*:pass:usertextures`，按项细分照报：
- `usertextures:system`（封面）P11c 起不再报，见「媒体（P11c）」；`usertextures:usershortcut`（快捷方式图标）P11d 起不再报，见「快捷方式（P11d）」；
- `usertextures:particle-sheet` P11b2 起不再报，见下「粒子材质的槽 0」；
- `usertextures:keepaspect`、`usertextures:reference`：对象项的 `keepaspect: true` 与 `usertexturereference`，读码清楚、已实现，语料 0 处，照报到有实测；
- `usertextures:rendertarget:placeholder`（缺省是没被依赖的 `_rt_imageLayerComposite_*`，P8 绑棋盘格）、`usertextures:rendertarget:runtime`（缺省是 `_rt_FullFrameBuffer` 或 fbo）：语料 0 处。

pass 级的 `keepaspect` WPE 不读，改中性。

**粒子材质的槽 0**（P11b2，读码 rea-p11b R6，实测 p11-REPORT M4 与 [phase-11b2-particle-sheet.md](../../../.claude/plans/wpe-import/3-scene/phase11/phase-11b2-particle-sheet.md) 步骤 0）：槽 0 的缺省是精灵表、又绑了 `scenetexture` 时，按属性的**当前值**定这个粒子系统是不是精灵表：有图（文件读得到）就没有帧表——薄格式、不写帧表宏、frame 不推，每个粒子画整张用户图、四边形宽高比跟纹理；没有图（或读不到）就照缺省精灵表一格一格播。属性改值时当场重定。

**和 WPE 有意不同**（2026-11-18 用户定）：WPE 建粒子材质时按当时的值解析 `usertextures`，再按槽 0 纹理的帧表位给系统置 `0x1000000`，只做这一次，材质刷新不通知粒子系统。所以在 WPE 里打开后才选的图被当成原来的精灵表、按旧帧表一格一格画（M4），重新打开才画整张；打开时就有图、之后清空，画的是整张缺省精灵表。这算 WPE 的缺陷，语料画面不依赖它（两张场景的作者缺省都是空串），我们改成当场生效。WPE 三种情形的实测见子计划「步骤 0」。

- **判定**：`compile/usertextures.ts` 的 `particleUserImage`，`compilePass` 在解析完 `usertextures` 之后、写粒子宏之前调：槽 0 是属性来源、值是非空字符串、文件读得到（经编译期的 `SceneReader.readRange` 读第 1 个字节）才算用户图，写进这个变体的 `ParticleSheetSystem.userImage`；`particleDefines` 据此不写帧表宏、`TEX0FORMAT` 按 RGBA8888，`SceneParticle.spriteSheet` 取基础变体的结果。读不到同 WPE 按精灵表（`p11b-sheet-missing` 实测）。封面与快捷方式图标不参与（WPE 加载时它们还是缺省纹理）。
- **改值时**：槽 0 的缺省是精灵表、来源是属性时，`compilePass` 给这个属性另登记一条 `{ kind: "recompile", reason: "layer-structure", path: "objects/<i>/…/usertextures/0" }`。宿主改值时用户纹理照旧就地换，同时按 L6 只重编这个对象（`recompiledObjects` +1，不整场重编译）。新旧粒子定义相同（图换图）时沿用旧的粒子树；有图 ↔ 没图切换时定义变了，这个系统的粒子重新预热一次。对象级重编译是异步的，换上之前旧粒子层照画：`syncUserTextures` 对粒子 draw 也走 `rebindDrawInputs`（重建 bind group、按 `particles.model` 重写 `g_Texture<n>Resolution`），清空时先绑回缺省再释放用户纹理（之前不重绑粒子 draw，清空后提交报 `Destroyed texture used in a submit`、整张退回）。
- **已知差异**：文件读得到但解码失败的值，WPE 是缺省精灵表（有帧表），我们按用户图（没有帧表、画整张缺省纹理）。
- 工程缺省值里写了文件路径的 `scenetexture`（语料没有，作者缺省都是空串）宿主读不到：`file:` 放行只认 metadata 里用户设过的值，这时按「值读不到」走精灵表。
- **走查**（`FINAL_CHECK.md`，2026-11-18）：两张真实壁纸各用 `kbp content isolate` 只留绑了用户纹理的粒子（`3812473896` 的「叶子 2」带子系统、`3799462430` 的「樱花」`randomframe`），粒子 JSON 的随机初始化器收成 min = max、`turbulentvelocityrandom` 去掉、发射距离 0（WPE 的粒子随机数按时间做种、不可复现，同 P4 的做法），材质、usertextures、帧表、renderer、动画模式、对象上的绑定与脚本不动；「为空」与「加载时就有图」两种状态各录 WPE 4 帧（1920×1080、fps 20、后处理 ultra），按日志确定性回放、整帧逐像素比，`randomframe` 的 `R` 两遍注入（先注入 `k/1e5` 认出生序号，再按位置填 WPE 的 `R`）：
  - 逐粒子：位置、旋转、尺寸逐位相同，帧号与淡入淡出的 alpha 比 WPE 大 `1/(rcpps(9)·9)` = 1.0002442（90 个粒子全在 1.0002441–1.0002443），`g_RenderVar1`、纹理、采样器、渲染目标格式相同；
  - 找到并修了一个 bug：精灵表参考尺寸（见上「取值与纹理」），修前「樱花 / 有图」最大差 224、每帧约 440 个像素差 > 32；
  - 剩下的两类都是已知差异：近似倒数（帧号经 ×30 放大成混帧权重差，最大 5.58 级的推算对上实测 5；临时把 `rcp(9)` 换成 `rcpps(9)` 后「叶子 2」从最大 7 降到 3、有差像素降到原来的 3%）；以及用户图色块硬边上的零星 3–10 级（每帧 ≤ 41 个像素）：输入几何逐位相同，是 fxc 的几何着色器与 Tint 的顶点着色器展开四角的浮点舍入，经强缩小（159 宽画进 36 像素、1 级 mip）放大，同类残差在缩小少的「叶子 2」上最大 3。
  - 运行中换图那条是有意不同，没法对 WPE 比，由单测与回归 S4、S8 覆盖。

**dev 探针**：
- `host.userTextures()`：每个属性来源的当前值、状态（`ready` / `empty` / `failed` / `loading`）、解码后的整张尺寸、最近一次解码用时、已登记的纹理名，GIF 的换帧次数。
- 确定性回放（`renderFrame`）没有宿主，自建一份来源表，按 `userProperties` 预解码、等完，并置为暂停。`gifDts`（每项是一帧的 `g_Frametime`，秒）逐帧推进 GIF；`videoTime` 也作用于用户视频。vite 的 `/render` 与 MCP `render_scene` / `host_render` 收 `gifDts`。
- `host.renderFrame(time, key)` 给了 `key` 时存读回的 RGBA，用来按区域和 WPE 比运行中改值后的画面。

**验收**（1920×1080，WPE 抓帧 `A:\p11b\`）：
- 生成工程 `p11-ut-ar`、`p11b-npot`、`p11b-inst`、`p11b-rt`、`p11b-rt-init` 整帧 0 差（屏蔽 FR / CLK）。运行中改值的两条路（重绑 draw、槽 0 整层重建）在真 GPU 上和 WPE 的区域哈希相同，宿主 `applied` +1、不重编译。
- GIF：三张手写的测试图覆盖 disposal 0–3、局部调色板、交错、透明背景、`bgindex` 0。WPE 导出的 12 张槽纹理与解码器的逐帧画布逐像素相同；96 次换帧都能用 float32 推进模型复现。
- 真实壁纸的复制工程：3462279189、3351163962（instanced）、3253330537（effect 槽）整帧 0 差；2833017810（HDR，非 2 的幂的槽 0）最大差 1，是 WPE 半精度上屏换算到 8 位的舍入；3783690410 的余差来自场景里的两段视频。

**已知差异**：
- **解码是异步的**：WPE 在下一帧开头同步读文件、建纹理，同帧画出；我们解码完成后的下一帧才换上，大图晚几帧（6000×3000 解码几十毫秒）。首次加载与确定性回放都等解码完，不受影响。
- **JPEG 的色度上采样**：WPE 的 FreeImage 3.18 自带的 libjpeg 与浏览器的 libjpeg-turbo 不同，色块边界上差到几十级，照片上很小。
- **16 位灰度 PNG**：FreeImage 按 `[min(255, 最小值), 最大值]` 拉伸，浏览器只给 8 位。
- **标了色彩标签的用户视频**：WPE 不看标签（只按高度），我们照标签，标签和高度给出的矩阵不同时颜色不同（有意不同，见「解码」）。色度上采样的纵向位置同场景视频的已知差异。P9d 之前标清、未标视频的整体偏色（Chromium 的 `<video>` 拷贝另做 SMPTE-C → sRGB 原色转换）随 `<video>` 一起消失。
- **视频源矩形落在半像素**：WPE 的视频处理器重采样，我们只按整像素取。HDR 视频（PQ / HLG）不做，照常 RGBA8；槽 0 换成用户视频时 `getVideoTexture()` 不做。
- 暂停期间改值新建的 GIF，第一次画到时用的是上一个实时帧的 frametime。
- 几乎不可压缩的大 GIF 解码开销高（1.1 MB 一帧约 29 ms）。
- 显存：用户纹理按原分辨率、只裁不缩（6000×3000 → 3000×3000），一张 4K 方图约 36 MB；合成 RT 池只增不减，反复换不同尺寸的图时旧尺寸的 RT 不回收。

**语料**（183 个工程）：能渲染 88 → 90（`3462279189`、`3783690410`，原来都只差 `usertextures`），没有场景掉出；去掉 `material:usertextures` 30 张、`effect:*:pass:usertextures` 21 张，新增 `usertextures:system` 19 张、`:usershortcut` 3 张、`:particle-sheet` 2 张。用到 `usertextures` 的场景多数还差媒体回调、脚本 API、文本、关键帧等别的节。P11b2（233 个工程）只去掉 `:particle-sheet` 的 2 张，`3799462430`、`3812473896` 解锁，干净 223 → 225。

## 纹理变体（P11e）

WPE 的资源编译器可以把一张底图和若干张「满足某个用户属性条件才贴上去」的补丁编进同一个 `.tex`（源 JSON 的 `variants[]`）。加载时按属性的当前值逐条判定，把命中的变体贴到底图上；运行中改了相关属性，WPE 在帧间原地重载这张纹理、重新判定，下一帧画新的。读码见 [rea-p11e.md](../../../.claude/plans/wpe-import/3-scene/phase11/rea-p11e.md)，计划与实测见 [phase-11e-texture-variants.md](../../../.claude/plans/wpe-import/3-scene/phase11/phase-11e-texture-variants.md)。语料只有 myprojects 的 `3817265356`（属性「腿」切换三种贴图）用到。

**格式**（`compile/tex.ts` 的 `parseTex`，`FUN_14015c8d0`）：
- `TEXB0004` 的 imageCount、FreeImage 格式之后是**条件数 N**（以前照 LWE 当成 `isVideoMp4`、为 1 时每级 mip 前多读一段，WPE 里没有这种布局，语料也一张没有，已删）。N 条 `[u32 组号, u32 变体号, u32 标志, 以 0 结尾的 JSON]`，JSON 是 `{"condition": variantcondition}`。组号 = 源 JSON `variants[]` 的下标 + 1，变体号跨组从 1 连续编号。
- N > 0 时每级 mip 的底图数据之后跟这一级的变体块：`u32 组数`，每组 `u32 条数`，每条 `[组号, 变体号, x, y, w, h, FreeImage 格式, 长度, 数据]`；x、y、w、h 是这一级 mip 上的矩形（每级各写各的，不按比例推）。Worker 只记数据在磁盘上的区间（`TexResult.variants`），同 FreeImage 底图由主线程按区间读、解码。

**判定与选择**（`compile/textureVariants.ts`，`FUN_140174a60`）：
- 对象形式 `{name, condition}`：属性值必须是 **JSON 字符串**且与条件逐字节相等。数字、布尔一律为假（数字 2 不等于 `"2"`），和场景对象 `{user:{…}}` 绑定的判定（`asString` 后比较）不同。
- 字符串形式 `"<属性名>"`：属性值必须是布尔 true。
- 属性不存在为假；JSON 不合规的条件什么都不做（不进表，但每级的变体块照样按 N 读）。
- 按头里的顺序判，**同一组只认第一条命中的**，得到「变体号 → 标志」。

**贴法**（`render/textures.ts` 的 `writeBitmapMips`，`FUN_14015c480`）：每级先写底图，再按文件顺序贴命中的变体；最后一条带标志位 2 的之前的丢掉、它之后的不贴。
- 标志 0：在 (x, y) 处逐行覆盖。我们用 `copyExternalImageToTexture` 写到目标矩形（位图按 `premultiplyAlpha: "none"` 解码、`premultipliedAlpha: false` 写入），逐字节相同。
- 标志位 1（资源编译器的 `blend: "alphablend"`）：只对 RGBA8888，rgb `dst + ((src − dst)·a >> 8)`（r、b 打在一个 32 位里算）、alpha 取较大。**照报** `tex:variant:alphablend`（语料 0 处，`TODO:[WPE_SCENE]`；公式与 WPE 逐像素相同的参考实现在 `ignore/p11/e/ref_variants.py`），强制渲染时不贴。
- 标志位 2：整张替换。**有意不同**：变体是 PNG 时 WPE 把编码后的字节当像素上传，还越界读到文件里下一组变体的头（P11e 点 0 实测）；资源编译器不产生位 2，语料 0 处，我们解码后贴在它的矩形上。
- 出界（宽高为 0、矩形不在这一级里）的条目跳过；解码失败或位图尺寸和条目不符的跳过，不让整张纹理失败。

**运行中换值**：
- 编译期给每张变体纹理条件里的每个属性登记一条就地绑定 `{ kind: "texture-variant", path, name }`，并把编译时的值记进 `SceneTexture.variants.values`（属性不存在的不记）。
- 宿主改值经绑定写进 `SceneState.variantValues`（值照原样，判定要看类型）并标脏；下一次 `GpuScene.sync`（`syncTextureVariants`）重新选择，**命中表变了才**把这张 GPU 纹理的内容重写一遍（底图 + 变体）。尺寸、格式不变，绑定组与着色器都不动，不重编译。
- 纹理按文件路径缓存（同 WPE 只按文件名缓存），同一张 `.tex` 被几个材质用时选择相同、一起换。
- 全部变体位图在加载时一起解码（`decodeEncodedTextureList`），换选择当帧就能重写，不晚帧。
- WPE 的两个副作用不复刻：没有命中时记 `$__default`，此后每次应用该属性都白白重载一次；每次重载重复登记绑定。都不改画面。WPE 开纹理降级（跳过第 0 级 mip）时没读走它后面的变体块、后面解析错位的缺陷也不复刻，我们没有纹理降级。

**照报**（2026-11-21 用户定，语料 0 处，代码里标 `TODO:[WPE_SCENE]`）：
- `tex:variant:raw`：底图或变体是原格式（含 LZ4），WPE 按格式逐行拷（DXT 按块行）。
- `tex:variant:alphablend`：标志位 1。
- `tex:variant:multi-image`：多图像的纹理带条件。
- `tex:variant:no-value`：条件引用的属性定义里没有 `value` 键。WPE 对象形式的判定对空指针解引用（`0x140174d30`），崩溃组合照报；bool 形式在 WPE 里判假，不报。

**实测与走查**：
- **生成工程**（`ignore/p11/defs/p11e.py`）：底图三级 mip、8 条条件、6 组，覆盖同组第一条、跨组先后、每级各自的矩形、数字值、bool 形式、标志位 1 与 2。读回 WPE 抓帧里的纹理各级 mip，和参考实现逐像素比：除标志位 2（WPE 的缺陷）外全部 0 差；运行中 `apply_properties` 换值、换回没有命中的值也都 0 差。
- **我们的渲染**：同一批工程在 1:1 下（窗口等于场景分辨率）和 WPE 整帧逐像素相同（屏蔽 FR / CLK）。
- **`3817265356` 复制工程**（`kbp content isolate --keep 91`，三个取值各一份）：
  - 和 WPE 整帧比，最大差 1–2，每帧 ≤ 617 个像素有差；没有命中、只有底图的那份同样量级，是 3127×2000 的纹理缩小采样的差异，和变体无关；
  - 语料（工坊 + 默认工程）前后 0 张变化；`3817265356` 从 `tex:parse` 退回变成干净。

## 媒体（P11c）

场景脚本的五个媒体回调（`mediaStatusChanged` / `mediaPlaybackChanged` / `mediaPropertiesChanged` / `mediaThumbnailChanged` / `mediaTimelineChanged`）与封面纹理（`$mediaThumbnail` / `$mediaPreviousThumbnail`）。WPE 的媒体集成是三段：
1. 子进程 `winrtutil64.exe` 读系统的当前媒体会话，有变化才发；
2. 主进程按 `windowupdaterate` 定时合并；
3. 场景每帧在脚本阶段开头派发。

P11c 照这三段做，每段放在对应的位置。依据：
- 读码 [rea-p11-media](../../../.claude/plans/wpe-import/3-scene/phase11/rea-p11-media.md) 与 [rea-p11-textures](../../../.claude/plans/wpe-import/3-scene/phase11/rea-p11-textures.md) 第 3、4 节；
- 实测 [p11-REPORT](../../../.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md)「媒体回调与封面」；
- 计划、约定与走查见 [phase-11c-media.md](../../../.claude/plans/wpe-import/3-scene/phase11/phase-11c-media.md)。

**取数据**（Rust，`src-tauri/kabegame/src/wpe_media/`）：
- 网页壁纸的 `WpeMediaHub` 与监视线程（Phase 8）一起用：线程读一次系统数据，交给两个投影（`projection.rs`，纯逻辑，单测喂假读数）。
  - 网页投影保持 Phase 8：时间轴外推、封面缩到 512、`contentType` 缺省 `music`。
  - 场景投影照 `winrtutil`，见下表。
- 订阅按调用方文档定投影：场景宿主的入口文档收场景投影，网页壁纸目录里的文档收网页投影，页面不能自己选。

| 项 | 场景投影的取值 |
|---|---|
| 属性 | 七个串；`contentType` 只有 `music` / `video` / `image` / `""`（`PlaybackType` 1 / 2 / 3 / 其余）；`genres` 用 `,` 连接；超长整段清空（按 UTF-8 字节：`title` / `artist` / `genres` > 1024，另外三个 > 256） |
| 封面 | 原尺寸 PNG（base64）加五色（`sceneThumbnail { png, colors }`），Spotify 预处理之后；比较 PNG 字节，不同才发 |
| 播放 | Playing 1、Paused 2，其余 0 |
| 时间轴 | `Position`、`EndTime` 各自向零截断到整秒，不外推；只在会话切换与 `TimelinePropertiesChanged` 时读，播放状态变化不重推 |
| 去重 | 每类和上次发出的值比，初值是缺省值（所以缺省值一开始不发）；没有会话时每类回到缺省值，不同才发 |

- **信号的处理**照 `winrtutil` 主循环（`media.rs` 的 `collect_batch` / `plan_batch`）：
  - 收到第一个信号后把之后 100 ms 内到的攒成一批；
  - 会话上的三个事件带挂接代数，旧代数的丢掉，等于「丢掉不是当前会话发来的事件」；
  - 一批里有会话切换就只重新挂接（挂接会全部重读）。
  - 依据：走查实测会话退出时它先报一次播放状态，约 17 ms 后系统才切会话，WPE 不发那条。
- **配色**（`colors.rs`）照 WPE，两个投影共用，在原尺寸、Spotify 预处理之后的像素上算：
  - 三色：alpha ≥ 16 的像素进 360 格色相直方图，权重 `(int)(M·s·100)`；
  - `highContrastColor`：主色对黑的对比度 < 2.5 时白、否则黑；
  - `textColor`：次色（对比度 ≥ 2.5 且大于第三色的）/ 第三色（≥ 2.5）/ 否则同 `highContrastColor`；
  - 没有封面时五色全 0；有封面但没选中任何格（全透明、全灰）时三色黑、两个黑白色白。
  - 读码对这两个字段名的对应标反了，以实测为准。
- **Spotify 预处理**：来源 App ID 以 `spotify` 开头时裁掉透明边或把角标区改灰。两处读码标【推】的细节（判定行、「否则若」的归属）按 `projection.rs` 的注释实现，测试只覆盖裁切分支。
- **订阅的补发**照 `AddMediaListener`：先发 `status`；监视在跑时再补非空的几类（`title` 非空、有封面、状态非 0、`duration` 非 0）。
- **「媒体集成」开关**：关掉时场景订阅当场收到 `status { enabled: false }` 和非缺省类的复位。
- **macOS**（2026-11-21）：经 `tauri-plugin-sysmedia` 读系统的 Now Playing（MediaRemote），读数攒 100 ms 后走同一个场景投影（[../WPE_IMPORT.md](../WPE_IMPORT.md)「音频与媒体集成」）。和 Windows 的数据差别：`subTitle` / `albumArtist` 拿不到、是空串；播放器不给 `mediaType` 时（实测 Amazon 网页应用与网易云都不给）`contentType` 为空串，同 Windows 的「类型未知」；自然切歌时新时长与「播放中」比新标题早约 300 ms，脚本会先收到一次「旧标题 + 新时长」。WPE 不在 macOS 上跑，没有逐行对照的对象。
- **Linux**（2026-11-22）：经 `tauri-plugin-sysmedia` 读 MPRIS，同一个场景投影。和 Windows 的数据差别：MPRIS 没有媒体类型，`contentType` 恒为空串；`subTitle` 空串；当前会话由插件按「最近开始播放的那个」选（系统不指定）；`position` 只在播放器报了变化（播放状态、换曲、速率、`Seeked`）时更新，同 Windows「播放器报了才有」。

**合并**（宿主 `src/media/pending.ts`）：
- 消息先进 `MediaPending`，照 WPE 主进程的待发事件：同类只留最后一条，flags 按位或（1 属性、2 封面、4 播放、8 时间轴、0x10 状态）。
- 封面收到就解码（base64 → `createImageBitmap`），解完才并入，后收到的胜出。
- 计时器按 WPE `config.json` 的 `windowupdaterate`（钳到 50–5000，读不到用 1000）刷新：先切出 `flags & 0x1d` 的一条，再切出封面一条，只清 flags。
- 订阅被拒时当场推一条 `{ enabled: false }`。

**派发**（`src/media/scene.ts`、`events.ts`，`script/runtime.ts` 的 `mediaEvent`）：
- 每帧在 `beforeFrame` 的脚本阶段最开头（光标派发之后、动画之前）取空队列。没有脚本的场景也取（只有封面纹理）；暂停时积压，恢复后第一帧全部派发。
- 每条事件按 WPE 的固定顺序：
  1. 有封面先换名：`mediaThumbnail_<N>.system`，计数从 1 起，相同图片、没有封面也换名。增量 `$mediaThumbnail`（有旧名时另带 `$mediaPreviousThumbnail`）走现有的属性路径：绑定表命中 `user-texture` 就地换图，`engine.userProperties` 读到名字字符串，导出了 `applyUserProperties` 的脚本收到 `{}`（增量没有 `type`）。
  2. 再按 状态 → 播放 → 属性 → 封面 → 时间轴 调回调：发给全部已 `init`、导出了该回调的脚本，按登记顺序，返回值丢弃，出错只禁用这个回调。
- 事件对象是 realm 里的普通对象，键序照 dll：
  - 颜色是 `Vec3`，分量 `fround(c / 255)`；`position` / `duration` 是单精度；
  - 只有 `MediaPlaybackEvent` 是全局类（在 `baseclasses.js` 里）。
- `init` 之后、首次 `applyUserProperties` 之前，按场景媒体状态补发一轮（`replayAfterInit`），新建时 `enabled` 为真，所以通常是一次 `{ enabled: true }`。
- `SceneMedia` 与订阅跨重编译保留，`SceneBundle.media`（有脚本导出五个回调之一，或有 `system` 来源的槽）时加载即订阅、只订一次。

**封面纹理**：
- `system` 来源和属性来源同样登记 `user-texture` 绑定（`isDynamicSource`）。
- 来源表多一个 `provide(名字, 位图 | null)`：封面名字不读文件，按交来的图当场生效；只留最近两张与仍被引用的；`null` 是缺省纹理。
- 裁切、纹理名、GPU 侧同属性图片。位图在派发前已解码，换纹理和 WPE 一样同帧完成。

**dev 探针**：
- `host.media()`：订阅状态、最近的消息、待发 flags、队列长度、场景媒体状态。
- `renderFrame` 的 `media: [{ frame, messages }]`：第 `frame` 帧之前把这批消息并成一次刷新、派发，不走计时器；配 `scripts: { consoleGrep }` 看回调。
- vite `/render` 与 MCP `render_scene` 已能转发 `media`，要重启 vite / MCP 才生效。

**实测与走查**（SMTC 夹具同时驱动 WPE 与 Kabegame，`ignore/p11/c/`）：
- 生成工程 `p11-media` 的回调序列逐行相同：
  - 封面换名与 previous 轮换；
  - 超长清空（1025 字节清空、1024 保留、专辑名 257 字节清空）；
  - 停止、整秒时间轴、视频 / 图片类型；
  - 切到别的会话、新会话还没数据时的复位（`contentType` 为空串）、清空显示信息；
  - 颜色逐值相同。
- 两块封面槽（1:1 当前、1:4 上一张）与 WPE 抓帧逐像素相同。
- 重设同一张封面：只重设时两边都不发；连同改标题时系统先报一次没有封面、隔约 5 ms 再报原图，WPE 因此再发一次封面，我们合并后同样一次。
- 三张真实壁纸的复制工程：
  - `2932157836`：除挂 `spin` 的圆形封面（转角跟 `g_Time`）外整帧逐像素相同；
  - `3823859141`：除唱片的 `spin` 外只有文字阴影的模糊边缘差 ≤ 8；
  - `3487328036`：封面对象在复制工程里两边都没画出（缩放挂着音频脚本），背景只差后处理档位。

**已知差异**：
- 首次拿到会话数据：WPE 的子进程等封面解码完才送属性，属性与封面晚一次刷新；我们同步解码，同一次到。
- 新订阅的补发：WPE 对「已有别的监听者」的场景同步补发、下一帧就派发；我们和别的消息一样等下一次刷新，最多晚一个间隔。
- 关掉「媒体集成」：我们当场发 `enabled: false` 与复位；读码推断 WPE 要等重新打开才一起到（未实测）。
- 隐藏的 iframe 里计时器被 Chromium 节流，合并更粗（那时场景本身也暂停）。
- 退回预览图期间媒体事件丢掉，之后能渲染时等下一次变化才跟上。
- 重编译与封面事件撞在一起时，脚本可能多收一次 `applyUserProperties({})`。
- JPEG 封面的配色：解码库不同（WPE 用 FreeImage），平滑渐变的封面主色可能落到别的格；PNG 逐值相同。
- 超长字段的去重按清空后的值比：读码没说清 WPE 比哪个，两个不同的超长标题连着来时我们只发一次。

**语料**（219 个工程，2026-11-14）：能渲染 147 → 157，去掉的只有六个键（`script:callback:media*` 五个、`usertextures:system`），没有新增键、没有场景掉出。解锁：
- `2932157836`、`2974757317`、`3219908811`、`3355291946`、`3470764447`；
- `3482471820`、`3487328036`、`3823859141`、`3823864170`、`3837699827`。

其余用到媒体的场景还差 `combo:SPRITESHEET`、`tex:animation`、图层层级类脚本 API、puppet 等（`openUserShortcut` 在 P11d 实现，见下节）。

## 快捷方式（P11d）

快捷方式是用户在属性面板里给场景配的「点一下就打开」的目标（`usershortcut` 属性）：程序、文件、文件夹、网址或命令行。场景里有两处用到它：
- 图层的 `usertextures` 槽显示它的图标。这是 P11b 来源表的第三种来源，前两种是属性文件和封面。
- 脚本在光标回调里调 `engine.openUserShortcut(属性名)` 启动它。

Windows 与 macOS（macOS 2026-11-21 起，`wpe_shortcut/mac.rs`）。Linux 面板不显示这类属性，宿主拿到的一律未绑定，`openUserShortcut` 返回 `false`，图标槽用缺省纹理；平台开关是 `wpe_shortcut::SUPPORTED`，前端面板同规则，Linux 的代码处标 `TODO:[WPE_SCENE]`。

依据：
- 读码 [rea-p11d](../../../.claude/plans/wpe-import/3-scene/phase11/rea-p11d.md)；
- 实测 [p11-REPORT](../../../.claude/plans/wpe-import/3-scene/phase11/p11-REPORT.md)「P11d 补测」；
- 计划、约定与走查见 [phase-11d-shortcuts.md](../../../.claude/plans/wpe-import/3-scene/phase11/phase-11d-shortcuts.md)。

面板与值的格式见 [WPE 导入文档](../WPE_IMPORT.md)「用户属性」。

**宿主拿到的形状。** 后端（`wpe_web.rs` 的 `scene_user_from_view`）把快捷方式属性给成 `{ type: "usershortcut", value, isbound, commandtype?, file? }`：
- `value` 不是原值，是原值 SHA-256 的前 16 位十六进制，没配时是空串。宿主只用它判断值变了没有，并按它缓存图标；完整路径不离开后端。
- 另外三项是 WPE 给脚本看的字段（`baseclasses.js` 的 `convertUserProperties`，实测）：
  - `commandtype` 是 `file` / `directory` / `website` / `command`；
  - `file`：文件与文件夹只给最后一段名字，网址给整串，命令只给程序部分；
  - 没配时只有 `isbound: false`。
- 宿主把这一项原样放进 `applyUserProperties` 的增量。`engine.userProperties` 出口由 `scriptUserProperties` 剥掉这三项，脚本读到 `{}`，同 WPE。

**图标。** 宿主经 `wpe_scene_shortcut_icon(imageId, name)` 取，这条命令登记在 `wpe-scene-host.toml`：
- 返回 `[宽 u32 LE][高 u32 LE][直通 alpha 的 RGBA]`；没配、取不到、Linux 上是 0 字节。值只取 metadata 的 `userProperties`，不取工程缺省值。
- 取法照 `winrtutil`（`wallpaper/wpe_shortcut/`）：
  - **文件、文件夹、命令**：
    - `SearchPathW` 补 `.exe`，再取 Shell 缩略图缓存（`IThumbnailCache`，256）；
    - 取不到时依次退到：目录的已知文件夹图标、`.url` 的 `IconFile`（`PrivateExtractIconsW`）、按扩展名取系统图像列表（从 JUMBO 起，跳过补了边的假大图）；
    - 后几种是图标句柄，画出来再去预乘：float32，`cvttss2si` 取低字节，`a = 0` 得 0；
    - 最后照 OpenCV 填色：线性缩到 64×64 → `inpaint` TELEA 半径 8 → 放回原尺寸，只改 alpha ≤ 1 的像素的 RGB。
  - **网址**：
    - 带 iPhone Safari 的 User-Agent 请求页面，按 `<link>` 规则挑图标：看 apple-touch-icon 的 `sizes`，再加 `/favicon.ico`，按宽降序稳定排序；
    - 边长不超过 512 的正方形图标保持原尺寸；
    - 乘抗锯齿的圆形遮罩：`r = (min(w, h) >> 1) − 2`，`a = (mask·a) >> 8`；
    - 取不到时用 WPE 的 `webthumbnailfallback.png`（300×300），同样乘遮罩；
    - 缩放的滤镜没读清，先用 Catmull-Rom，标了 `TODO:[WPE_SCENE]`。
  - OpenCV 4.4.0 的三处（8 位定点线性 `resize`、`inpaint` TELEA、`circle` 抗锯齿）逐行移植进 `cv.rs`，只依赖标准库。4.13 重写过 `inpaint`，结果不同，以 4.4.0 为准。
  - **macOS 的文件、文件夹、命令**（`mac.rs`，网址同上、不分平台）。顺序和 Windows 一样，先内容缩略图、再系统图标：
    - 路径不存在、又不带 `/` 时按 `PATH` 找同名的可执行文件（对应 `SearchPathW`）；命令取 shell 命令行（照 shell 规则拆）的第一个词。`PATH` 用登录 shell 的：第一次用到时让 `$SHELL -i -l -c` 打印一次（前后加标记，`.zshrc` 往标准输出打的东西不影响）、进程内缓存，5 s 没打出来就杀掉、用应用自己的 `PATH`，之后不再重试；
    - 符号链接先解析到目标（`iconForFile` 会给符号链接加替身箭头，macOS 26 的 `/Applications/Safari.app` 就是指向 Cryptex 的链接）；
    - QuickLook（`QLThumbnailGenerator`，`Thumbnail` 表示、最长边 256、不要图标装饰）：图片、视频、PDF 在这里得到内容缩略图，对应 Windows 的 Shell 缩略图缓存；回调在 QuickLook 自己的队列上，阻塞线程里同步等，3 s 没回来就取消、退到系统图标；
    - 系统图标（`NSWorkspace.iconForFile`，`CGImageForProposedRect` 取 256 的那一级画成 256×256）：应用、文件夹、可执行文件、`.webloc` 在这里；路径不存在时按扩展名取通用图标（`iconForFileType`），没有扩展名就没有图标；
    - 都画进 sRGB、预乘 alpha 的位图再四舍五入去预乘，最后同样做透明区填色（`finish`）。
    - 没有和 WPE 逐像素对照的对象（WPE 不在 macOS 上跑），实测见下面的走查。
- 宿主侧是 `usertex/sources.ts` 的 `usershortcut` 来源：
  - 键变了才取，解码结果按键缓存；
  - 照 WPE 补透明边到槽的比例（`crop.ts` 的 `padRect`）：比例按 float32，`(int)` 截断，`>> 1` 居中，不裁切；精灵表槽取帧的比例；
  - 纹理名 `usershortcut_<键>x<round(比例·10)>`，格式 `rgba8unorm`、1 级 mip、线性过滤，寻址一律夹取（缺省纹理本来是重复寻址也一样）；
  - 之后走 P11b 的换纹理通路；没有图标时用缺省纹理。

**`engine.openUserShortcut(name)`** 的门禁照 WPE 实测：
1. 只在 `cursorClick` / `cursorDown` / `cursorUp` 里能调（`ScriptRuntime.activeCallback`），否则抛 realm 的 `SyntaxError("Cannot execute user command outside of cursor callbacks.")`。没捕获时照 P3b 禁用这个回调。
2. 参数缺失或不是字符串原始值：返回 `false`，不消耗令牌。
3. 先取令牌（`shortcut/token.ts`），没有就抛 `SyntaxError("Cannot execute more than one user command per cursor click.")`。令牌在左键按下沿、本帧派发之前发，在松开沿、本帧派发之后收（渲染器的 `cursor.end` 钩子），所以同一次点击的 Down / Up / Click 共用一个。
4. 再查属性全集：`type` 为 `usershortcut` 且 `isbound` 时返回 `true`，并把 `{ type: "kabegame:wpe-scene-shortcut", name }` `postMessage` 给父页面；否则返回 `false`。不存在的名字、空值也已经消耗了令牌。

**启动：安全边界在应用页。** 场景脚本跑在宿主页里一个同源、没加沙箱的 realm（P3b），能拿到宿主的 `__TAURI_INTERNALS__`。所以宿主里的门禁只约束守规矩的脚本，不是安全边界。真正的边界有三层：
- **`WpeSceneView`**（`wpeSceneShortcut.ts`）收到消息后核对：
  - 来源是自己的 iframe，`name` 是长度 1–256 的字符串；
  - 自己是可交互的（预览或桌面壁纸）；
  - `navigator.userActivation.isActive` 为真。这是浏览器给真实用户输入的标记，页面伪造不了；点在 iframe 里，祖先 frame 也会被激活，约 5 s 有效。
  - 同一属性 1 秒内至多一次。
- **启动命令**：`WpeSceneView` 用**自己持有的**图片 id 调 `wpe_open_user_shortcut(imageId, name)`。这条命令只登记进 `generate_handler!`，不进任何 `permissions/*.toml`，只有主窗口与壁纸窗口的应用页（免 ACL）调得到；场景宿主调它被 ACL 拒绝（走查实测）。
- **后端**只启动这张图（必须是库内场景）上 `project.json` 类型为 `usershortcut`、且用户在面板里配过的那一项：
  - Windows 调 `ShellExecuteW(NULL, NULL, 路径, 参数, NULL, SW_SHOWNORMAL)`，返回值 > 32 时返回 `true`；
  - macOS（`mac.rs`）按类型分：
    - 文件夹、网址、不带参数的文件交给 `tauri-plugin-opener`（NSWorkspace 用默认程序打开，`.app` 会被启动）；网址照取图标的规则补协议（`www.` 开头的值保存时不补 `https://`，NSWorkspace 不认没有协议的地址）；
    - 命令整条交给用户的登录 shell（`$SHELL -i -l -c`，没有 `$SHELL` 用 `/bin/zsh`）：和在终端里敲一样，`.zprofile` / `.zshrc` 里配的 `PATH`（Homebrew、nvm、pyenv 等）、别名、函数都在，改了立即生效。从 Finder / Dock 启动的应用自己的 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，`/bin/sh -c` 找不到这些命令；只读 `.zprofile` 的登录 shell（`-l`）也不够，nvm、pyenv 等写在 `.zshrc` 里，只有交互 shell 才读。代价是每次多一次 shell 启动（本机 oh-my-zsh 加 nvm 约 0.63 s，从调用到命令跑完约 0.9 s）。不接标准输入输出、不等它结束（另起线程收尸，退出码不为 0 时记 warn），工作目录是用户主目录；子进程先 `setsid()` 脱离控制终端——从终端启动的 Kabegame（dev）带着控制终端，后台的交互 shell 一碰终端就被 SIGTTOU 停住（实测停在 `T` 状态）；
    - 带参数的 `.app` 经 `/bin/sh -c` 跑 `exec /usr/bin/open -a <转义后的路径> --args <参数>`，参数照 POSIX shell 规则拆（`open` 是绝对路径，不必等登录 shell；同样 `setsid`）；其它文件带参数时参数忽略；
    - 启动请求发出去了（opener 成功、`sh` 起来了）就返回 `true`；
  - 没配返回 `false`；
  - 属性不是快捷方式、属性不存在、图片不是场景都报错。

这样一来，恶意脚本最多在用户刚点过壁纸的几秒内，重复打开用户自己给这张壁纸配的目标。

**能力表**：删 `usertextures:usershortcut` 与 `script:api:engine.openUserShortcut`。

**dev 探针**：
- `renderFrame` 收 `shortcutIcons`（属性名 → `{ width, height, rgba }`，`rgba` 是 base64 的直通 alpha 像素）。
- 结果的 `scripts.shortcuts` 按发生顺序列出经过门禁的调用：帧、属性名、返回码（0 失败、1 受理、2 没有令牌）。探针不启动、不发消息。
- 快捷方式属性的 `userProperties` 可以直接给后端形状；裸字符串（含库里的面板值与工程缺省值）当作没配，`isbound: false`。
- MCP `render_scene` 还不转发 `shortcutIcons`，所以缺省的库内用户属性里配过的快捷方式在探针里也当作没配。要看图标，就在主窗口里调 `wpe_web_get_state` 取后端形状、在屏外宿主里调 `wpe_scene_shortcut_icon`，再自己调 `renderFrame`。

**走查**（2026-11-15，生成工程 `p11-shortcut` / `p11-shortcut-v`，`ignore/p11/d/`）：
- **图标**：dev 应用里取到的 7 张和 WPE 的纹理逐像素相同：notepad.exe、`.lnk`、`.url`、文件夹、`calc`、维基百科，以及 `example.com` 取不到图标时的缺省图。
- **门禁**：同一串输入下 9 个用例的脚本日志逐行相同，包括相对帧号、返回值、两种异常的文本。9 个用例是：Down / Up / Click 共用令牌、参数不对、不存在的名字、回调之外、没捕获后禁用、`textinput`、空值。
- **启动**：
  - WPE 用正确的本机哈希时，`cursorDown` 里返回 `true`，打开目标文件夹；
  - Kabegame 应用页调启动命令返回 `true`；
  - 场景宿主调启动命令被 ACL 拒绝；
  - 没配、不是快捷方式、不是场景、只有工程缺省值时都不启动。

**macOS 走查**（2026-11-21，macOS 26.6.2 dev，9135 Minimalist Landscape 的 24 格应用栏）：
- **图标**（核对测试 `dump_shortcut_icons` 加 dev 应用）：Safari.app、Calculator.app、`/Applications`、主目录是系统图标；JPG 与 PDF 是 QuickLook 内容缩略图（256×181、198×256）；`.webloc`、不存在的 `foo.txt` 按类型 / 扩展名取通用图标，没有扩展名的不存在路径没有图标；`cmd:open -a Calculator` 是可执行文件图标，PATH 里找不到的命令没有图标；`web:www.wikipedia.org` 是网站图标。应用栏里五格都出了图标，改值后当场换图。
- **形状**：宿主拿到 `isbound: true` 与对的 `commandtype` / `file`，状态里没有完整路径（网址按 WPE 给整串）；宿主调启动命令被 ACL 拒绝。
- **启动**：Safari、Finder 的 `/Applications`、预览打开图片、Chrome（默认浏览器）打开补了协议的维基百科、`open -a Calculator`、`Chess.app|--kb-test "a b"`（进程参数是 `--kb-test`、`a b`）都起来了；只在 nvm 里有的 `node -e …` 跑出了结果、oh-my-zsh 的别名 `ll` 能用，命令图标按登录 shell 的 `PATH` 找到了 `node`；模拟从 Finder 启动的干净环境（`env -i`，`PATH` 只有系统目录）里读到的登录 shell `PATH` 含 Homebrew、nvm、pyenv、`~/.local/bin`；PATH 里没有的命令返回 `true`、日志记退出码 127；没配返回 `false`，属性不是快捷方式报错。

**已知差异**：
- **返回值**：WPE 的 `true` 表示 `ShellExecuteW` 成功；我们的启动是异步的，`true` 只表示值已配好，启动失败只记日志。
- **macOS 的命令**：整条交给用户的登录 shell，比 Windows 的 `ShellExecuteW`（程序加参数串、不经 shell）能力大：管道、重定向、变量、别名都能用，语法是用户自己 shell 的（fish 用户写 fish 语法）。值只能由本机用户在面板里配，脚本只能触发配好的那一条。
- **类型**：WPE 不查属性类型，`textinput` 里写合法格式的值也能启动；我们只认 `usershortcut`，也只认用户配过的值，不认工程缺省值。
- **本机哈希**：WPE 的值中间有 6 位本机哈希，用来拒绝别的机器上配的值。哈希是 `sha256(MachineGuid 的 UTF-16 连结尾 NUL ‖ 14 27 db 88 1d)` 的前 6 位，走查实测。我们的值只来自本机面板，不带这一段。
- **应用页的两道检查**：用户激活与 1 秒限频，WPE 没有。

**语料**（233 个工程，2026-11-15）：能渲染 175 → 176，解锁 `3660962877`（24 格应用栏）。只去掉两个键：`script:api:engine.openUserShortcut`（6 张）、`usertextures:usershortcut`（5 张）。没有新增键，没有场景掉出。其余 5 张还差 `combo:SPRITESHEET`、`tex:animation`、`thisScene.createLayer` 等。
