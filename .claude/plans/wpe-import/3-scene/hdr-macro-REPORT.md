# 引擎宏调查：`HDR` 与全部引擎注入宏

WPE 2.8.42，`wallpaper64.exe` SHA-256 `40e2ce02…93b0`（与 p2-REPORT、lighting-REPORT 同一二进制）。地址都是 Ghidra 虚拟地址。实测在主进程 PID 36548 的 `-playInWindow` 窗口，`postprocessing=ultra`、`msaa=none`、`fps=10`，`PrintWindow` 采样，日期 2026-11-07。

**置信度**：**已确认** = 反编译读到且有实测；**实测** = 只有实验；**静态** = 只读到代码；**推断** = 由前两者推出。

工具与原始数据在 `ignore/hdr-macro/`：探针工程生成 `gen.py` / `gen2.py` / `gen3.py` / `gen5.py` / `gen6.py`，WPE 读数 `probe.py` / `cap.py` / `capeagle.py` / `rt.py`，语料差分 `macro-diff.test.ts`（结果 `out/macro-diff.json`、`out/ana.txt`），对比 `cmp.py` / `ana_scan.py` / `ana_pass.py`。

## 结论

**发现两处真实的画面差异，一处已经影响能渲染的场景，一处目前只在测试工程里出现。**

| 宏 | 现在能渲染的场景受影响吗 | 读数 |
|---|---|---|
| `TEX<n>FORMAT` 多定义 | **受影响：`eagleflag`** | 对齐相位后与 WPE 比，现状均差 1.83、差 > 8 的像素 6.22%；按 WPE 语义修正后均差 0.376、1.65% |
| `HDR` 没传 | **不受影响**：10 张能渲染的场景里唯一的 HDR 场景 `razer_bedroom` 走不到任何受影响的代码 | 测试工程里差到 255（`BLENDMODE=29`：WPE `[255,255,25]`，我们 `[0,255,255]`）；传 `HDR=1` 后全图最大差 1 |

- 本机 117 张里，**真实 HDR 且走到受影响代码的只有 `2833017810`**，这张现在有 30 项不支持、不能渲染。它能否出现差异还取决于输入是否过亮，它唯一可见的受影响图层 `brightness` 为 1，没有证据显示会出现差异（见第 5 节）。
- **潜伏 bug**：`HLSL_GS40_DISABLED` WPE 从不定义，我们定义了。`shimmering_particles` 自带的粒子着色器读它，语义和名字相反，定义后会走错分支。今天粒子不编译，所以不影响画面，但要在 Phase 4 之前删掉。
- 其余引擎宏今天都不改变任何像素。`SHADERVERSION` 的值写错了（WPE 是 **69**，不是 62），`HLSL_SM40` 漏了，都只是语义不准。
- **陷阱**：关闭时 `HDR` 必须是**未定义**，不能传 `HDR=0`。`common_blending.h` 用的是 `#ifdef HDR`，传 0 会让 LDR 场景也走 `saturate`。

## 引擎宏总表

按影响从大到小。「改法」里的宏表位置见第 6 节。

| 宏 | WPE 的值与条件 | 我们的现状 | 影响 | 改法 | 证据 | 置信度 |
|---|---|---|---|---|---|---|
| `TEX<n>FORMAT` | 槽位声明 `"formatcombo":true` 且材质**按名字**绑了纹理才定义，值为 `.tex` 格式枚举；`_rt_FullFrameBuffer` 恒为 0（HDR 下也是 0）；`previous` 与 `bind` 的槽位不定义，声明了也不定义 | 每个带格式的槽位都定义，`previous` / `bind` 也定义 | **`eagleflag` 的 `flag` 着色器**：均差 1.83 → 0.376。`deep_space` 的 `flowimage` 同样多定义，但 `DecompressNormal` 不可达，没有差异 | 翻译器按 `formatcombo` 过滤；宿主 `planned` 不传格式 | 探针 `fmt-hdr` / `fmt-ldr`，`FUN_1401a5c40`（0x1401a6953 一带），`0x14016d8f4` 读 `formatcombo` | 已确认 |
| `HDR` | `ctx+0x118 & 0x2000` 时写 `HDR=1`，否则**不定义**。作用于全部着色器 | 只在 `LIGHTING` 非 0 时传 | 能渲染的场景 0 张；`2833017810` 有可达代码但不能渲染；测试工程差到 255 | 宿主经 `defines` 全局传，跟 `postprocess.hdr` | 探针 7 个工程，`hsl-hdr`，`pass-hdr`，`FUN_1401a5c40` | 已确认 |
| `ALPHATOCOVERAGE` | 材质 `blending` 为 `alphatocoverage`（枚举 3）时写 1；图层路径另有写入 | 不写，能力表报 `blend:alphatocoverage` | `3611425904`、`3783690410` 被挡，都不能渲染 | 实现这种混合时由宿主写 COMBO | 探针 `alphatocoverage` 块，`FUN_140154480`、`FUN_140155fc0` | 已确认 |
| `SCENE_ORTHO` | 正交场景写 1（`ctx+0x118` 位 0x400），透视不定义 | 只在 `LIGHTING` 非 0 时传 | 0 张。`genericimage3/4` 在 `LIGHTING \|\| REFLECTION` 下读，`REFLECTION` 现在报 `combo:REFLECTION` | 和 `HDR` 一起移到全局，否则将来 `REFLECTION` 开启时视线方向会错 | 探针 `hdr-on`（有）/ `persp`（无），语料差分 0 处 | 已确认 |
| `SHADERVERSION` | 预处理器 `FUN_14016b0e0` 开头种入，**恒为 69**，全局 | `LIGHTING` 非 0 时给 62，否则不定义 | 0 张。读取只有两处 `#if SHADERVERSION < 62`，都在 `#if LIGHTING` 内，62 与 69 同分支 | 改成 69，放进平台宏 | 探针 `==69` 成立、`>=70` 不成立，反编译 `local_208 = 0x3936`，语料 0 处 | 已确认 |
| `GS_ENABLED` | `ctx+0x118` 位 0x8（壁纸进程恒置）时写 1 | 不定义，有意走「顶点着色器展开四角」分支 | 今天 0 张，粒子报 `object:particle`（70 张） | 保持不定义；Phase 4 要逐项核对两条分支等价 | 探针 `if:GS_ENABLED` 成立，`FUN_140162ac0` | 已确认 |
| `TEX0FORMAT`（粒子） | 粒子路径**无条件**写，`genericparticle` 读它但 `g_Texture0` 没有 `formatcombo` | 粒子未实现 | 今天 0 张 | Phase 4 由宿主经 `defines` 写，并进缓存键。**按 `formatcombo` 过滤后这一条必须单独处理** | `FUN_1401d2340` | 静态 |
| `HLSL_SM40` | 恒为 1（`#define HLSL 1\n#define HLSL_SM40 1\n`，`FUN_1400d5070`） | 不定义 | 0 张，内置与工坊都没有读取 | 加进平台宏 | 探针，语料 0 处 | 已确认 |
| `HLSL_GS40_DISABLED` | **WPE 不定义**，二进制与 assets 都没有这个名字 | 定义为 1 | 今天 0 张（粒子不编译），但**是潜伏的 bug**：`shimmering_particles/shaders/particle.vert` 读它，语义和名字相反，定义时进「给几何着色器准备输入」的分支，`gl_Position` 不做 MVP，粒子画面必错 | 删除。Phase 4 之前必须改 | 探针未定义，`final_check3.py` 读到分支，全语料只有这一处 | 探针已确认；画面错误是读代码推断，粒子未实现没有实测 |
| `REVERSEDEPTH` | `ctx+0x118` 位 0x1000（壁纸进程恒置）时写 1 | 不定义 | 0 张，只有阴影、遮挡、体积光读，语料里改动全部不可达 | **保持不定义**：我们的深度不是反向的，定义了反而错。做阴影时再定 | 探针，语料差分 157 处全部不可达 | 已确认 |
| `ADDITIVE` | 材质 `blending` 为 `additive`（枚举 2）时写 1 | 不写 | 0 张，只有 `generic4` / `chroma4` / `foliage4` / `fur4` 的雾分支读 | 不改；做雾时补 | 探针 `additive` 块，`FUN_140154480`，语料 0 处 | 已确认 |
| `BACKBUFFER_MS` | MSAA 开启时写 1 | 不定义 | 0 张，只影响 `texSample2DBackBuffer` 的展开 | 不改，渲染器没有 MSAA | `FUN_1401a5c40`，`msaa=none` 下探针未定义 | 静态 |
| `FOG_DIST` / `FOG_HEIGHT` / `FOG_COMPUTED` | `ctx+0x118 & 0x1800000` 且宏表 `FOG` 非 0 时写前两个；passthrough 的 JSON 恒写 `FOG_COMPUTED=1` | 都不写 | 0 张：117 张的 `general` 没有任何 fog 键 | 不改；做雾时补 | `FUN_1401a5c40`、`FUN_1401ebbc0`，`scan_misc.py` | 静态 |
| `LIGHTS_POINT/SPOT/TUBE/DIRECTIONAL` | 最终 `LIGHTING` 非 0 时写，取 `lightconfig` | 同，经 `litDefines` | 无差异 | 不改 | lighting-REPORT，`lt-*` 对比 | 已确认 |
| `LIGHTS_SPOT_SHADOW_COOKIE` 等 5 个阴影计数、`LIGHTS_SHADOW_MAPPING(_QUALITY)`、`LIGHTS_COOKIE` | `LIGHTING` 非 0 时写计数（含 0），有阴影 / cookie 时写后几个 | 不写，要阴影或 cookie 时报 `lightconfig:*` | 0 张，`lightconfig` 在 117 张里没有出现 | 不改 | `FUN_1401a5c40` | 静态 |
| `HLSL` | 恒为 1 | 同 | 无差异 | 不改 | 探针 | 已确认 |
| `HLSL_SM30` / `GLSL` / `PLATFORM_ANDROID` | 不定义 | 不定义 | 无差异。23 张的自带着色器读 `HLSL_SM30` | 不改 | 探针 | 已确认 |
| 材质与 `[COMBO]` 的 COMBO | 名字转大写，值为 0 也写 `#define X 0`，所以 `#ifdef` 成立、`#if` 不成立 | 同 | 无差异 | 不改 | 探针 `KBZERO` / `KBDEF0` / `KBLOWER`，`FUN_14016c400` | 已确认 |
| 采样器 `combo` | 绑了纹理才 `#define X 1`，没绑不定义 | 同 | 无差异 | 不改 | 探针 `KBSAMP` / `KBSAMPU`，`FUN_14016c800` | 已确认 |
| `BLENDMODE` | passthrough 的 JSON 写，0 与 31 写 0 | 同 | 无差异 | 不改 | `FUN_1401ebbc0`、`FUN_140206ae0`，p2-REPORT | 已确认 |
| `LIGHTING`、`REFLECTION`、`PRELIGHTING`、`SKINNING`、`SKINNING_ALPHA`、`MORPHING`、`SPRITESHEET` | 图层路径按对象状态写进材质 JSON | 能力表 `ENGINE_COMBOS` 报，`LIGHTING` 已实现 | 被能力表挡住 | 不改 | `FUN_140206ae0`、`FUN_140209540` | 静态 |
| `BONECOUNT`、`MORPHING_MODIFIERS`、`MORPHING_NORMALS`、`PRELIGHTINGDUALVERTEX`、`BLENDROWCOUNT`、`CLIPPINGUVS`、`CLIPPINGTARGET` | 同上，跟随上一行的状态，或来自 `.mdl` | 不写，也不在 `ENGINE_COMBOS` | 随上一行或模型能力被挡；`CLIPPING*` 只有 `3286859278` 出现相关键，该场景本身不能渲染 | 做相应能力时补 | `FUN_140206ae0`、`FUN_140209540`、`FUN_140224c70` | 静态 |
| 粒子：`THICKFORMAT`、`SPRITESHEETBLEND(NPOT)`、`TRAIL*` | 粒子路径写 | 未实现 | 粒子报不支持 | Phase 4 | `FUN_1401d2340` | 静态 |
| 文字：`OUTLINE_ENABLED`、`BLUR_ENABLED`、`DROP_SHADOW_ENABLED` | 文字路径写 | 未实现 | `object:text` 报不支持（56 张） | 做文字时 | `FUN_1401b3b60` | 静态 |
| 灯与阴影投射：`COOKIE`、`SHADOW`、`QUALITY`、`POINTLIGHT`；`WRITEALPHA` | 灯对象与另一条路径写 | 未实现 | 被 `object:castvolumetrics` 等挡住 | 做相应能力时 | `FUN_140196ce0`、`FUN_1401d3ae0` | 静态 |
| `DISPLAYHDR`、`LINEAR`、`BLOOM`、`UPSAMPLE` | 工具材质 JSON 里的 COMBO，不是引擎注入 | 用 WPE 原件 | 无差异 | 不改 | p2-REPORT A3 | 已确认 |

**穷举方法**：宏表写入都经 `FUN_14015a440` / `FUN_14015af00` / `FUN_14015b140`，枚举它们的全部调用者（8 + 1 + 1 个，`HDR` 这类名字是立即数拼的，搜字符串搜不到），再加源码前缀 `FUN_1400d5070`、`FUN_140162ac0`、预处理器种子 `FUN_14016b0e0`、采样器 `FUN_14016c800`，以及把 COMBO 写进材质 JSON 的图层路径。

## 1. `HDR` 在哪里定义、取什么值

| 结论 | 置信度 | 证据 |
|---|---|---|
| 只有一个写入点：`FUN_1401a5c40` 里 `ctx+0x118 & 0x2000` 时写 `HDR=1` | 已确认 | 反编译；`HDR` 名字是立即数 |
| 关闭时**不定义**：`#ifdef HDR` 不成立，`#if HDR == 0` 走不到 | 已确认 | 探针 `def:HDR` 与 `ndef:HDR` |
| 开启时值为 1 | 已确认 | 探针 `HDR==1` 成立 |
| 位由 `postprocessing` 是 `ultra` / `displayhdr`、JSON 的 `general.bloom`、`general.hdr` 共同决定 | 已确认 | G3、K3，下表 |

| 工程 | `bloom` | `hdr` | 属性 | `HDR` |
|---|---|---|---|---|
| `hdr-on` | true | true | | 定义 |
| `hdr-off` | true | false | | 未定义 |
| `hdr-prop-false` | true | `{user, value: true}` | 属性 false | **定义** |
| `hdr-prop-true` | true | `{user, value: false}` | 属性 true | **未定义** |
| `bloom-off` | false | true | | 未定义 |
| `bloom-prop-false` | `{user, value: true}` | true | 属性 false | **定义**，且泛光关着 |

- **看不看属性**：只看 JSON 的 `value`，不看属性当前值。
- **是否跑泛光无关**：`bloom-prop-false` 泛光关着，`HDR` 仍然定义。
- **质量档位**：`disabled` 与非 `ultra` 的开启档不置 0x2000，所以不定义（静态，G2；这次没有改 `config.json`，只测了 `ultra`）。
- **displayhdr**：置 0x6000，含 0x2000，`HDR` 同样为 1。摘掉 0x4000（输出不是 HDR 显示器）不影响 `HDR`（静态，没有实测）。

我们 `postprocess.hdr` 的判定和这张表只差一处：`hdr` 读属性当前值，这是已定 12，有意不跟 WPE。宏跟 `postprocess.hdr` 走即可，这样宏和场景目标格式保持一致。

## 2. 作用于哪些 pass

| pass | `HDR` 定义 | 依据 |
|---|---|---|
| 图层基础材质（`normal` / `translucent` / `additive` / `alphatocoverage`） | 是 | 探针 |
| effect 绘制 pass | 是 | 探针 |
| effect 写 fbo 的 pass | 是 | 探针 `effectfbo` |
| 顶点阶段 | 是 | 探针 `v:HDR`，全部区块 |
| passthrough（`colorBlendMode`） | 是 | `pass-hdr`：过亮输入下 26–29 的读数与 effect 逐项相同，与未定义时的读数不同 |
| 泛光链、合成上屏 | 是（静态），但没有读取者 | 都走 `FUN_1401a5c40`。`hdr_*`、`combine_*`、`passthroughsrgb` 不读 `HDR`，语料差分也没有改动 |

**没有例外**。只有一个写入点，所有材质都经过它。

`pass-hdr` 的对照（brightness 2，WPE）：

| BLENDMODE | passthrough | effect | 未定义时（我们） |
|---|---|---|---|
| 26 | `[102,189,255]` | `[102,189,255]` | `[102,255,255]` |
| 27 | `[238,238,119]` | `[238,238,119]` | `[255,255,255]` |
| 28 | `[119,187,238]` | `[119,187,238]` | `[255,255,255]` |
| 29 | `[255,255,25]` | `[255,255,25]` | `[0,255,255]` |
| 1（对照） | `[51,153,102]` | `[51,153,102]` | `[51,153,102]` |

## 3. 运行中的变化与缓存

| 结论 | 置信度 | 证据 |
|---|---|---|
| 运行中改 `hdr` / `bloom` 绑定的属性，`HDR` 不变，不重编译 | 实测 | `rt.py`：`p_hdr` 改 3 次、`p_bloom` 改 2 次，`if:HDR` 格始终开，blob 目录没有新文件 |
| 档位变化时 0x2000 不当场变，下一次加载才重算；位不同则重建渲染器 | 静态 | G2，`FUN_14010efb0` 只改 0x40，`FUN_140113be0` |
| 内存缓存键：着色器名 + 一个整数 + 排序后**值非 0** 的宏 + 着色器源码前缀，SHA-1 | 静态 | `FUN_14016c990` |
| 磁盘 blob：`<工程>/shaders/blobsSM40/<sha1>.dxs` | 实测 | 文件名 40 位十六进制 |
| `HDR` 改变每一个着色器的键，包括不读它的 | 实测 | `hdr-on` 11 个、`hdr-off` 9 个 blob，交集 0 |

值为 0 的宏不进键，这意味着 WPE 里 `#define X 0` 和没有 `X` 共用一份缓存。这是 WPE 自身的特性，`#ifdef` 分支上可能串味，我们没有这个问题，也不需要模仿。

## 4. 引擎宏的完整结论

见上面的总表。三个值得单独说的：

**`SHADERVERSION` 是 69。** 反编译读到 `local_208 = 0x3936`、长度 2，小端解码为 `"69"`，探针 `==69` 成立、`>=69` 成立、`>=70` 不成立，顶点阶段相同。这回答了 lighting-REPORT 留下的问题。预处理器里它是种子宏，`#ifdef SHADERVERSION` 成立。

**`TEX<n>FORMAT` 的条件。** `fmt-hdr` / `fmt-ldr` 的读数（HDR 与 LDR 相同）：

| 槽位 | 绑定 | `formatcombo` | 结果 |
|---|---|---|---|
| 0 | `cookie/flashlight1`（RGBA） | 有 | `TEX0FORMAT=0` |
| 0 | `particle/water/splash_1`（DXT5） | 有 | `=4` |
| 1 | `gradient/*`（R8） | 有 | `=9` |
| 2 | `particle/*`（RG88） | 有 | `=8` |
| 3 | 任意 | **没有** | **未定义** |
| 0（effect） | `previous` | 有 | **未定义** |
| 1（effect） | `_rt_FullFrameBuffer` | 有 | `=0`，HDR 下也是 0 |
| 2（effect） | `bind` 的 fbo | 有 | **未定义** |

这些值和我们传的 `.tex` 枚举一致，差别只在「该不该定义」。

**`HLSL_GS40_DISABLED` 在 WPE 里从不定义，定义它是错的。** 翻译器现在定义它，README 写的意图是「粒子走顶点着色器展开四角」，实际效果相反。全语料只有 `shimmering_particles/shaders/particle.vert` 读它（`dustmote` 材质用），这个旧着色器的分支和名字是反的：

```glsl
	// Prepare geometry shader input
	// or compute final vertex position
#if HLSL_GS40_DISABLED
	v_Rotation = in_ParticleRotation;
	gl_Position = vec4(a_Position, in_ParticleSize);
#else
	// …
	gl_Position = mul(vec4(position, 1.0), g_ModelViewProjectionMatrix);
```

工程没有 `.geom`，WPE 不定义这个宏，走 `#else`，也就是顶点着色器自己算最终位置。我们定义后走第一支，顶点不经过 MVP，后面也没有几何着色器。内置的 `genericparticle` 用的是 `GS_ENABLED`，不受影响。今天粒子不编译，所以 0 张受影响，但要在 Phase 4 之前删掉。

## 5. 影响范围

### 读取 `HDR` 的地方

| 位置 | 分支 | 不传时差多少 | 语料情况 |
|---|---|---|---|
| `common_blending.h` `RGBToHSL`（`#ifdef`） | `saturate` 输入 | 输入在 [0, 1] 内没有差别；过亮时差到 255（第 2 节） | 只有 `BLENDMODE` 26–29 或直接调用才可达 |
| `common_pbr.h` / `common_pbr_2.h` `CombineLighting` | overbright 公式 | 只在 `LIGHTING` 下；光照路径已经经 `litDefines` 传了 | 已正确 |
| `ccsimple.frag` | LUT 保留过亮量 | 没有测 | 引擎 `wec_*` 颜色校正才用，117 张没有 `wec_*`；我们翻译 `LUT=1` 本身失败（见「未查清」） |
| `genericimage2/3/4.frag` | emissive 过亮 | 只在 `EMISSIVE_MAP` 下 | 语料没有走到 |
| `generic2/3/4`、`chroma4`、`foliage4`、`fur4` | `albedo.rgb *= g_Brightness` | 过亮倍数丢失 | 模型材质，未实现，4 张 HDR 场景的工程材质里都没有 |

工坊：`scan_misc.py` 扫 117 张的工程与 `scene.pkg`，**没有自带着色器直接读 `HDR`**。`assets/effects/fluidsimulation` 里的 `HDR` 只是注释。工坊 effect 通过 `common_blending.h` 间接受影响。

### 语料差分

用真实编译管线跑 117 张（`exhaustive`、`ultra`），每次翻译分别加候选宏再翻一遍，比较 WGSL，再按调用图判断改动的函数是否可达。naga 会把没调用的函数也输出，所以只比文本会高估：`HDR` 共 393 处改动，只有 11 处可达。

阳性对照通过：`genericimage4` 在 `BLENDMODE=26` 时 `RGBToHSL` 可达，`BLENDMODE=1` 时不可达，`LIGHTING=1` 时 `CombineLighting` 可达。

| 候选 | 可达改动的场景 | 其中能渲染 |
|---|---|---|
| `HDR` | 8 张（但 WPE 真定义 `HDR` 的只有 `2833017810`） | 0 |
| `SHADERVERSION`、`SCENE_ORTHO`、`HLSL_SM40`、`ADDITIVE`、`BACKBUFFER_MS` | 0 | 0 |
| `REVERSEDEPTH` | 0（157 处全部不可达） | 0 |
| `TEXFORMAT_formatcombo_only` | **1：`eagleflag`** | **1** |
| `TEXFORMAT_none`（连 `previous` / `bind` 也去掉的上界） | 同上，所以运行时槽位在语料里没有差异 | 1 |
| `ALPHATOCOVERAGE`、`FOG_*` | 候选是无条件加的，不代表真实走到：`blending` 只有 2 张是这个值，fog 0 张 | 0 |

**HDR 场景**（`hdrFlag` 为真有 7 张，其中 3 张 JSON 的 `bloom` 为 false，不是 HDR）：

| 场景 | 能渲染 | 走到受影响代码 |
|---|---|---|
| `razer_bedroom` | **是** | 否 |
| `shimmering_particles` | 否（2 项） | 否 |
| `3286859278` | 否（46 项） | 否 |
| `2833017810` | 否（30 项） | 是：`effects/tint` 的 27、28，`gradient_color` 的 26 |

`2833017810` 的受影响图层几乎都隐藏，唯一可见的是 `wc_1024_full_green`（`tint` BLENDMODE 28、`brightness` 1、`colorBlendMode` 11）。`brightness` 为 1 时输入不过亮，`saturate` 不起作用，所以这张解锁后也可能没有差异（推断，不能渲染所以没有实测）。

其余 7 张（`2932157836`、`3451555874`、`3524852519`、`3823859141`、`3823864170`、`3829467967`、`3832004152`）不是 HDR 场景，WPE 不定义 `HDR`，不传是对的。

### 对比读数

**`HDR`**，`hsl-hdr`：HDR 场景，下层颜色 `0.9 0.5 0.2`、`brightness` 2，`tint` 混合。

| | 现状 | 加 `HDR=1` |
|---|---|---|
| 全图最大差 | 255 | **1** |
| 全图均差 | 31.47 | 0.067 |
| 差 > 8 的像素 | 40% | 0 |

`brightness` 1 的一行现状也只差 1，`hsl-ldr` 全图差 0，说明差异只来自过亮输入。「加 `HDR=1`」是在测试工程的着色器顶部写 `#define HDR 1` 模拟的，WPE 读数不变，翻译结果等同宿主传宏。

**`TEX<n>FORMAT`**，`eagleflag`：`flag.frag` 的 `g_Texture1` 没有注释，纹理是 DXT5。WPE 没有 `TEX1FORMAT`，走 `normal.xy = normal.wy*2-1`；我们走 `normal.yx = normal.yw*2 - vec2(0.965, 1)`，`y` 大 0.035。

| 测量 | 现状 | 修正后 |
|---|---|---|
| 测试工程 `nrm`（直接输出法线），G 通道平均差 | +4.43（最大 6，与 0.035 × 0.5 × 255 = 4.46 吻合） | 0 |
| 带 `formatcombo` 的对照 | 0 | 0 |
| 真实场景，与 WPE 比（相位扫描对齐到 t = 4.9，周期 5 s）均差 | **1.83** | **0.376** |
| 真实场景，与 WPE 比，差 > 8 的像素 | **6.22%** | **1.65%** |
| 真实场景，我们自己前后对比（t = 1 / 3.3 / 7.7）最大差 | 61–64，均差 1.5–1.6 | |

这个位移不到一个纹理像素，但布料高频纹理放大了它。修正后最大差仍有 84，是其它来源，和最大差不受修正影响一致，没有继续查。

## 6. 改法

### 总体设计

把「只给光照路径」的引擎宏改成整场全局：`HDR`、`SCENE_ORTHO` 进 `defines`，`SHADERVERSION`、`HLSL_SM40` 进翻译器平台宏，`litDefines` 只留 `LIGHTS_*`。`TEX<n>FORMAT` 的裁决放在翻译器，因为只有它读得到采样器注释；宿主只负责不把运行时才绑定的槽位说成有格式。

**不需要动缓存键。** `ShaderCompiler` 每次 `compileScene` 新建一个（`bundle.ts:410`），`defines` 整场一份。`hdr` 改值已登记 `postprocess-hdr` 重编译，设置变化走整场重载，`bloom` 运行中切换不改 `HDR`，和 K 节一致。

### 现状锚点

**a. 宿主传宏**（`compile/lights.ts:52`）
```ts
export function litDefines(counts: LightCounts, hdr: boolean, ortho: boolean): Record<string, string> {
  const defines: Record<string, string> = { LIGHTS_POINT: String(counts.point), /* … */ };
  defines.SHADERVERSION = "62";   // 现状：写死，且只在 LIGHTING 非 0 时生效
  if (hdr) defines.HDR = "1";
  if (ortho) defines.SCENE_ORTHO = "1";
  return defines;
}
```

**b. 翻译器**（`src-tauri/wpesl2wgsl/src/lib.rs:34`、`:256`）
```rust
const PLATFORM_DEFINES: &[(&str, &str)] = &[("HLSL", "1"), ("HLSL_GS40_DISABLED", "1")];
// …
for texture in &request.textures {
    if let Some(format) = texture.format {      // 现状：不看 formatcombo
        defines.insert(format!("TEX{}FORMAT", texture.slot), format.to_string());
    }
}
```

**c. 运行时槽位**（`compile/bundle.ts:621`）
```ts
const planned: ShaderTextureSlot[] = binds
  ? binds.map((bind) => ({ slot: bind.index, format: FBO_FORMATS[fbos.get(bind.name)?.format ?? "rgba8888"].tex }))
  : [{ slot: 0, format: FBO_FORMATS.rgba8888.tex }];
```

### 点 1 — 引擎宏全局化（`compile/lights.ts`、`compile/shader.ts`、`compile/bundle.ts`）

- **新增**
  - `engineDefines(hdr, ortho)`。
    > 关闭时不写键。**不能写 `HDR: "0"`**，`common_blending.h` 用 `#ifdef`。
- **修改**
  - `litDefines` 只留 `LIGHTS_*`。
  - `ShaderCompiler` 构造函数加 `defines`，`translate` 传给 `translateWithIncludes`。
  - `bundle.ts:410` 传 `engineDefines(postprocess.hdr, !!general.orthogonalprojection)`。
```ts
export function engineDefines(hdr: boolean, ortho: boolean): Record<string, string> {
  const defines: Record<string, string> = {};
  if (hdr) defines.HDR = "1";            // 新增：全局。关闭时必须未定义
  if (ortho) defines.SCENE_ORTHO = "1";  // 从 litDefines 移过来
  return defines;
}

export function litDefines(counts: LightCounts): Record<string, string> {
  return {
    LIGHTS_POINT: String(counts.point),
    LIGHTS_SPOT: String(counts.spot),
    LIGHTS_TUBE: String(counts.tube),
    LIGHTS_DIRECTIONAL: String(counts.directional),
  };  // 修改：删掉 SHADERVERSION / HDR / SCENE_ORTHO
}
```
```ts
const shader = new ShaderCompiler(
  fs,
  translator,
  unsupported,
  litDefines(counts),
  engineDefines(postprocess.hdr, !!general.orthogonalprojection), // 新增
);
```

### 点 2 — 平台宏（`src-tauri/wpesl2wgsl/src/lib.rs`）

- **修改** `PLATFORM_DEFINES`：加 `HLSL_SM40`、`SHADERVERSION`，删 `HLSL_GS40_DISABLED`。
  > `GS_ENABLED` 与 `REVERSEDEPTH` 继续不定义，写进注释说明是有意的。
  > 删 `HLSL_GS40_DISABLED` 后 `particle.vert` 走 `#else`，也就是顶点着色器自己展开，和 `GS_ENABLED` 未定义的意图一致。
```rust
/// 照 WPE：`FUN_1400d5070` 的源码前缀与 `FUN_14016b0e0` 的预处理器种子。
/// `GS_ENABLED`、`REVERSEDEPTH` WPE 恒定义，这里有意不定义：WebGPU 没有几何着色器，深度也不是反向的。
const PLATFORM_DEFINES: &[(&str, &str)] =
    &[("HLSL", "1"), ("HLSL_SM40", "1"), ("SHADERVERSION", "69")];
```

### 点 3 — `TEX<n>FORMAT`（`lib.rs`、`compile/bundle.ts`）

- **修改**
  - 翻译器只给声明了 `formatcombo` 的槽位定义。
  - `bundle.ts:621` 的 `planned` 与 `:767` 的 passthrough 不传 `format`。
    > WPE 里 `previous` 与 `bind` 不定义。`_rt_FullFrameBuffer` 保持传 0。材质里按名字写的 effect fbo 没有测过，先保持现状。
```rust
for texture in &request.textures {
    let declared = annotations.samplers.iter().any(|(slot, meta)| {
        *slot == texture.slot && meta.get("formatcombo").and_then(Value::as_bool) == Some(true)
    });
    if !declared {
        continue; // 新增：WPE 只给 formatcombo 槽位定义
    }
    if let Some(format) = texture.format {
        defines.insert(format!("TEX{}FORMAT", texture.slot), format.to_string());
    }
}
```
```ts
const planned: ShaderTextureSlot[] = binds ? binds.map((bind) => ({ slot: bind.index })) : [{ slot: 0 }]; // 修改
```

### 点 4 — 对基线和测试的影响

- **画面**：能渲染的 10 张里只有 `eagleflag` 变，往 WPE 靠近。`razer_bedroom` 与其余 8 张的 `HDR` 改动都在不可达函数里，像素应当逐字节相同（WGSL 文本会变）。这是由差分推出的，没有在改完的代码上跑。
- **测试要改**：`lights.test.ts:34` 的宏断言；`lib.rs:572`、`:640` 用 `format` 的翻译器单测要在采样器注释里加 `formatcombo`。
- **新增回归**：`engineDefines` 关闭时不含 `HDR` 键；过亮输入的 `hsl-hdr` 工程（读数见第 5 节）；未声明 `formatcombo` 的 `nrm` 工程。
- **文档**：`src-tauri/wpesl2wgsl/README.md` 的平台宏与 `textures` 两节、`cocs/wpe/WPE_SCENE.md`「光照」节、lighting-REPORT 的「顺带发现」。
- **Phase 4**：粒子的 `TEX0FORMAT` 要经 `defines` 单独写，并进 `ShaderCompiler` 的缓存键，否则点 3 之后 `genericparticle` 读不到格式。`HLSL_GS40_DISABLED` 要在这之前删掉，否则 `shimmering_particles` 的 `particle` 着色器走错分支。

## 过程中排除的假象

- **第一版可达分析是错的**，一度得出「`HDR` 0 处可达」。脚本里的 `\b` 被写成了退格符，可达集合只剩 `main`。是 `ALPHATOCOVERAGE` 改了 `main_1` 却被判不可达才看出来。修正后加了阳性对照，现在的数字都来自修正版。
- **纯文本比较 WGSL 会高估**：`HDR` 393 处改动里 382 处在没被调用的函数里，naga 会输出它们。
- **`persp-off` 全黑**不是宏的结果，是相机没对准，图层没画出来。改成相机在 z = 1000 的 `persp` 后标记格正常。
- **`HLSL_GS40_DISABLED` 我一度写成「没有读取者」**，只搜了 assets，收尾全语料扫描时才发现 `shimmering_particles` 在读，结论从「多余」改成「潜伏 bug」。
- **我原来估的 `eagleflag` 影响是亚像素、看不出来**，实测约 4% 的像素差大于 8。布料纹理频率高，位移不到一个纹理像素也有差。

## 未查清

| 项 | 现状 |
|---|---|
| `disabled` 与普通开启档、`displayhdr` 下的 `HDR` | 只测了 `ultra`，按要求没有改 `config.json`，其余档位是静态结论 |
| 泛光链与合成 pass 内的 `HDR` | 静态。这些着色器不读它，没有办法直接探测，也没有影响 |
| 差分的覆盖面 | 翻译失败的程序不参与比较（37 张有 `shader:*` 失败，含 `3286859278` 的 `fluidsimulation_advection`）；粒子、文字、`.mdl` 不走这条管线，70 / 56 / 18 张。内置粒子着色器不直接读 `HDR`，`RGBToHSL` 是否可达没有逐个看 |
| `2833017810` 解锁后是否有差异 | 不能渲染，只有静态判断 |
| 材质里按名字写的 effect fbo 的 `TEX<n>FORMAT` | 没有测，语料里 `TEXFORMAT_none` 与 `formatcombo_only` 结果相同，没有实际样本 |
| `FOG_*` 的标志位在壁纸路径上由谁置 | G2 没找到，这次也没找；117 张没有 fog 键 |
| `FUN_1401d3ae0` 的第二个宏 | 名字只解出开头 `OPACITYAS`，长度 13，assets 里只有 `OPACITYMASK`，对不上。属于未实现的路径 |
| `eagleflag` 修正后剩余最大差 84 | 没有查，均差已到 0.376 |
| `ccsimple` 的 `LUT=1` | 我们翻译失败：`The type of [15] doesn't match the type stored in [16]`，推断是 `texSample3D` 的 vec4 赋给 vec3 |
| `particle/swirl_0` | 我们报 `render:texture-missing:2`，所以 RG88 的 `nrm` 对比没有做成。WPE 侧读数已有，原因没查 |
| 修改后的实际验证 | 本次不改产品代码，「修正后」都是用测试工程模拟的 |

## 落地记录（2026-11-07）

第 6 节的三点已落地，宿主入口 `index-BGGGLREP.js`，脚本和结果在 `ignore/hdr-macro/fix/`。这一节的读数都来自真实改动，不是模拟。

| 验证 | 结果 |
|---|---|
| 翻译器 | 单测 35 通过，语料 158/167，带灯门槛通过 |
| 宿主 | vitest 668 通过，tsc、Prettier 通过 |
| 语料不支持项 | 原有 117 张没有新增或减少的键；`ultra` 比 `disabled` 没有多出翻译失败 |
| 基线 6 张 × 3 档 | 18 项里 15 项逐字节相同，变的只有 `eagleflag`（12885）三档，和第 6 节预测一致 |
| `eagleflag` 和 WPE 比（相位对齐到 t = 4.9） | 均差 0.481、差 > 8 的像素 1.655%、最大差 88。改前是 1.83、6.22% |
| `hsl-hdr` 和 WPE 比 | 最大差 1、均差 0.0667、差 > 8 的像素 0。改前是 255、31.47、40% |
| `hsl-ldr` 和 WPE 比 | 最大差 0，LDR 场景没有被 `HDR` 影响 |

**没验证：**
- `nrm` 工程渲染不了：它的 `rg-*` 单元格用 `particle/swirl_0`（RG88），`tex:format:8` 没有 mip，报 `render:texture-missing:2`。这是已知限制，归 P4b，和宏无关。法线修复由 `eagleflag` 的真实对比验证。
- `eagleflag` 剩余最大差 88 的来源没查。
- `disabled`、开启档、`displayhdr` 下的 `HDR` 仍是静态结论。

第 344 行的「约 4%」和结论表的 6.22% 对不上，这里以结论表为准。
