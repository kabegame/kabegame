# 场景壁纸：编译管线与着色器翻译

> [场景壁纸文档](../WPE_SCENE.md) 的一章：着色器翻译器、`scene.pkg`、编译管线、编译会话与对象片段（活的场景图）、能力表、场景后处理档位。总体形态、各阶段状态与全部章节的索引在总览里。

## 着色器翻译器 `wpesl2wgsl`

完整契约（请求 / 结果、绑定布局、uniform 打包、内部流程、已知不支持、测试）见
[src-tauri/wpesl2wgsl/README.md](../../../src-tauri/wpesl2wgsl/README.md)。要点：

| 项 | 内容 |
|---|---|
| 位置 | `src-tauri/wpesl2wgsl/`，workspace 成员；编成 wasm，不链进应用。naga 30.0.1 的源码嵌在 `naga/`（P7a）：裁掉了用不到的前后端，GLSL 前端的行为补丁也改在这里，清单见 `naga/KABEGAME.md` |
| 构建 | `deno task build:wpesl2wgsl` → `bin/wasm/wpesl2wgsl/wpesl2wgsl.wasm`（git 忽略，约 1.4 MB），需要 rustup 目标 `wasm32-unknown-unknown` |
| 进前端 | 场景宿主的 vite build 与 vitest 开始前（`apps/wpe-scene/wasmDeps.ts`）先跑一次 `build:wpesl2wgsl`（cargo 增量，最新时约 0.5 s），再拷到 `apps/wpe-scene/src/wpesl2wgsl/`；构建失败只告警、沿用旧产物，没有产物时场景退回预览图 |
| 前端接口 | `apps/wpe-scene/src/wpesl2wgsl/index.ts`：`loadWpesl2wgsl()`、`translateWithIncludes(translator, request, readInclude)` |
| 输入 | 一个材质 pass 的 `.vert` / `.frag` 原文、按需提供的头文件、COMBO、绑定的纹理槽位与格式 |
| 输出 | 两段 WGSL；uniform 块（group 0 / binding 0，两阶段共用，std140 偏移）；纹理绑定（槽位 n → 纹理 `1 + 2n`、采样器 `2 + 2n`）；attribute / varying 的 location；最终 COMBO |
| 本机语料 | 2026-11-13（P7d）：WPE 安装目录 167 对通过 161 对；全部场景实际发出的 853 个请求全部通过，语料里没有因着色器翻译退回的场景，输出 WGSL 回读与 Tint 都是 0 失败。**请求夹具**（P7a）：语料扫描录下编译管线真实发出的全部请求（`kbp corpus scan --extra requests:<目录>`），语料测试重放并和旧导出**逐字节**比较，改翻译器时据此判断哪些输出变了（README「测试」） |
| 规则来源 | WPE 先把方言转成 HLSL 再交给 fxc，所以翻译器照 WPE 的文本处理（P7b：`#if` 只解析一个表达式、多余的 `#endif` 忽略、宏后者覆盖前者、声明名带分量只取名字、`main` 之前的 `float` 数组是打包形态）与 fxc 的隐式转换（P7c：naga GLSL 前端的 HLSL 模式，截断、铺满、混算截到窄的、非布尔条件 `!= 0`、片元 varying 按顶点的类型）。P7f 起照 WPE 两阶段共享的一份 `VS_OUTPUT`：片元不声明也读得到顶点的 varying，片元读 `gl_Position` 得到像素坐标（`SV_POSITION`，换成 `gl_FragCoord`、w 取倒数；写它照报），工坊 effect「Silk」靠这两条。只在 GLSL 本来会报错的地方生效，原来能翻译的输出逐字节不变。规则表与 fxc 依据见 README「HLSL 隐式转换」与 `naga/KABEGAME.md`。另有一条 fxc 化简改了结果的：上界是字面量 0 的 `smoothstep`，fxc 把 `0.0 - lo` 化成 `-lo`，下界为 +0 时结果与 IEEE 相反（示波器没有声音时整张提亮），翻译器换成照 fxc 算的 `kb_smoothstep0`（P7e 收尾，README 同节）。作者直接写的 HLSL 类型名（`float2`、`float3x3`、`int2` 等）由宏头按 WPE 宏头的反方向换回 GLSL（2026-11-18，3348595482 的 `contrast_based_sharpness`），循环 / 分支前的 fxc 语句属性（`[loop]`、`[unroll(n)]`、`[branch]` 等）换成空白（2026-11-20，3784410673 的 `audio_yuan`） |
| 没被读的 uniform | P7d：WPE 只认反射里被使用的 uniform（没被使用的不进常量缓冲、不分配材质常量槽位）。翻译器反射给入口可达代码没读的格标 `unused`（naga `compact` 之后看块成员的 `AccessIndex`），宿主据此算槽位、取两阶段同键的合并类型、跳过能力检查；只改反射，WGSL 不变。和 fxc 的差别是结果没被用到的读（乘 0 等）我们仍算被读，偏保守（README「没被读的 uniform」）。P5c 起顶点属性同样标 `unused`（入口可达的代码没读到这个输入，跟着指针链找），宿主据此决定网格缺的属性报不报（README「没被读的属性」） |
| varying 的布局 | P7e：WebGPU 缺省只保证 16 个阶段间变量，打包与否只看 16、翻译结果不随显卡变；2026-11-18 起宿主开设备时按适配器申请 `maxInterStageShaderVariables`（本机 28），打包后仍超过 16 个的程序照样翻译、反射报 `interStageLocations`，`createProgram` 比设备上限、超了报 `render:program:<下标>:inter-stage:<个数>`（语料只有 3612971233 的示波器，18 个）。varying 数组照 WPE 生成 `VS_OUTPUT` 的公式声明长度：`vec3` / `vec4` 数组只剩 `ceil(n/4)` 个元素（WPE 的 bug，工坊示波器照它写），`n = 1` 退化成普通向量（写只写 `.x`、读成标量铺满）。换算后仍超过 16 个 location 时，把浮点 varying 装进 vec4（作者 `main` 改名 `kb_main`，生成的入口装箱 / 拆包），打包后超过 32 个才翻译失败、编译期退回；不超过的程序输出逐字节不变。WPE 编不过的写法（`.xyz` 取退化的标量、循环写越界、顶点裸 `return;`）不复刻。反射的 `varyings` 是实际接口（README「绑定布局」「varying 超过 16 个时打包」） |

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
- **条目名**：UTF-8、正斜杠（有中文和末尾空格）。没有该条目返回 null，由资源解析层继续查下一个来源。
- **查找不分 ASCII 大小写**（2026-11-20，照 WPE 2.8.42 `wallpaper64.exe`，`pkgKey`）：挂载 `FUN_140276700` 把每个条目名逐字节过 CRT `tolower` 后作 `unordered_map`（FNV-1a）的键，`try_emplace` 碰到已有的键返回旧节点、随后改写偏移与长度，所以**同键（含只差大小写的）取最后一条**；查找 `FUN_140275ef0` / `FUN_1402760e0` 把要找的路径同样逐字节 `tolower` 再 `memcmp`。exe 不调 `setlocale`，C 区域的 `tolower` 只改 A–Z，非 ASCII 字节原样比。之前照 linux-wallpaperengine 按原样精确匹配、同名取第一条：`3662790108`（哈勃）的场景写 `materials/models/HUBBLE/…`、包里是 `materials/models/hubble/…`，报了 9 个 `material:missing:*`（以前误记成工坊内容缺文件）。Rust 导入取入口 json（`wpe/project.rs` 的 `read_pkg_entry`）与 kbp-tools 的 `content` 同一规则。语料 366 个包里没有只差大小写的条目；完全同名的只有 `3643916956` 的一个字体，两份字节相同。
- **校验**：头部必须以 `PKGV` 开头；目录表截断、字符串或条目数异常、读到的条目长度不对都抛 `PkgFormatError`。长度过长通常意味着 `Range` 被忽略。
- **视频纹理**：`.tex` flags 含 Video（32）时唯一的 mip 是完整 MP4，判断要看 flags。`TEXB0004` 头里 LWE 叫 `isVideoMp4` 的那个字段其实是纹理变体的条件数（P11e，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「纹理变体（P11e）」），视频纹理里都是 0。
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
| `layers` | 按场景合成顺序的图层：`object`（scene.json 的 `objects` 下标，稳定键）、`parent`（父对象的 `objects` 下标，P4a）、变换、尺寸、颜色、可见性与 `visibleBound`（`visible` 绑了用户属性，运行时可变，**不可见也要建 GPU 资源**）、基础材质的 `passes`；`colorBlendMode`；启用的 `effects`（每个带 `source`、`fbos` 与按序的 `steps`：`draw` / `copy` / `swap`）；colorBlendMode ∉ {0, 31} 时的 `passthrough` pass；粒子对象的 `particle`（解析后的粒子系统与粒子材质的 pass，P4a，见 [PARTICLES.md](PARTICLES.md)「粒子（P4a）」）；图像模型标志 `solidLayer` / `instanced` / `noPadding` / `perspective` / `passthroughModel` / `copyBackground` / `fullscreen` / `fullscreenSize` 与组的 `group` / `subtree` / `groupUpload`（P5b，见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图像模型标志（P5b）」）；模型对象的 `model`（mdl 的网格、按 `skin` 选的材质 pass、绘制顺序、包围盒，P5c，见 [MODELS.md](MODELS.md)「静态网格（P5c）」） |
| `programs` | `wpesl2wgsl` 成功结果，保留 WGSL、uniform 布局、纹理绑定与顶点属性 |
| `textures` | 格式枚举、图像尺寸与纹理尺寸、采样 flags、mip 字节；视频只带 MP4 区间；FreeImage 形态只带 `encoded`（PNG / JPG 的磁盘区间，`mips` 由主线程解码后填）。`unsupported` 非空时，编译器可能只读头部，`mips` 因此可能为空 |
| `bindings` | 属性绑定表（P3a）：编译期每处解析 `{user}` 的地方登记一条「属性名（可带 condition）→ 目标」，按登记顺序；同一属性可以有多条。宿主按它把属性增量分成就地写与重编译（见 [HOST.md](HOST.md)「场景宿主」的「属性与快速路径」） |
| `unsupported` | 去重排序的未实现能力键；非空时渲染器不得使用这份 bundle，须显示作者预览图 |

pass（`ScenePass`）里：`key` 是本 pass 的稳定键（scene.json 坐标：基础材质 `objects/<i>/passes/<k>`、effect `objects/<i>/effects/<j>/passes/<k>`、passthrough `objects/<i>/passthrough`、泛光 `bloom/<pass>`），绑定表与就地刷新都按它找回 draw；`textures` 是槽位 → bundle 纹理；`runtime` 是运行时提供的槽位（`_rt_FullFrameBuffer` 快照或本 effect 的 fbo 名，来自材质 `textures` 或着色器注解 `default`）；`framebuffer` 是「需要帧缓冲」（`needsFramebuffer`，见 [RENDERER.md](RENDERER.md)「图层渲染图」）。着色器声明了、材质没给的槽位按注解 `default` 绑定（同 LWE 先取着色器默认值），如 tint 的遮罩 `util/white`；effect 实例的 `passes` 按顺序对应 effect.json 的绘制 pass，覆盖 `combos` / `constantshadervalues` / `textures`（`null` 保留材质值）。

- **快速退回**：缺省时一旦 `unsupported` 非空就不再编译后面的图层与 effect（这时清单只是部分），退回的场景更早显示预览图——工坊场景完整编译要翻译几十个 effect 着色器、上百次读取，快速路径只需 2–4 次。`exhaustive: true` 列全（语料统计用），`force: true`（dev 强制渲染，D4）也照常编译并解码 mip。
- **后处理档位**：`postprocess` 是设置值（缺省 `follow`），跟随时读 WPE 的 `config.json`，见下「场景后处理档位」。

### 编译会话与对象片段（活的场景图 L1）

运行中建层、改对象不再整场重编译。这是横切重构「活的场景图」（`.claude/plans/wpe-import/3-scene/phase-live-scene.md`），L1 是编译这一侧。

- **会话**：`openCompileSession(input)` 就是原来 `compileScene` 的闭包作用域，开场解析、着色器编译器、纹理 / 程序表、名字表、各种缓存都在里面。
  - 对象循环体是 `compileOne(index)`，收尾是 `finalize()`（只能调一次）。
  - `compileScene` = 开会话 → 逐个 `compileObject` → `finalize`。整场编译的产物和拆之前逐字节相同（全语料摘要）。
- **片段**：`finalize` 之后，`compileFragment(request)` 编一个运行中新建的对象。
  - 按整场的顺序收集：脚本（带绑定）→ 灯 → 关键帧 → 能力检查 → `compileOne` → 收尾里和这个对象有关的部分。
  - 然后按调用前后各表的长度切出片段 `ObjectFragment` 与只增的场景级增量 `FragmentDelta`（程序、纹理、用户纹理来源、`user-texture` 绑定、资源路径）。
  - 会话的表继续增长；整场 bundle 交出去之后，调用方不能再拿会话里同一批数组当快照用。
  - 已有下标（单对象重编译）在 L6 再做，现在抛错。片段编失败时不回滚会话的表，由宿主整场重载、换新会话。
- **片段和位置无关**：组归属、子树、挂点、灯的遗留槽位取决于运行中的父链与别的对象，不进片段。片段里一律是：
  - `group: null`、`subtree: []`；
  - 没有 `attachment`；
  - 灯 `legacySlot: -1`；
  - effect 的 `unsupported` 里没有 `GROUP_CHILD_FRAMEBUFFER`。

  这些由运行时现算（L3）。
- **不支持项**：会话的 `unsupported` 是能记录写入的 `RecordingSet`，因为 `ShaderCompiler`、`EffectIssues` 等直接持有它，换不掉。
  - 编片段期间每次 `add` 另记一份，得到这个对象带来的键；编完把调用前没有的键从会话删掉。
  - 编片段期间 `settled()` 恒为假，片段编全。
- **场景级不变量**：新对象会翻转的记进 `sceneFlips`，宿主据此整场重载。目前有：
  - `effect-access`：用了 `getEffect` 而场景没有；
  - `reflection:planar`：模型读反射图而场景没有平面反射；
  - `mip-framebuffer`；
  - `lights` / `legacy-lights`：第一次出现光照 / 遗留灯程序；
  - `volumetrics`：会画的体积光灯，运行中增删留到以后。
- **从整场 bundle 取片段**（`compile/fragment.ts`）：`fragmentOf(bundle, i)` 按「属于对象 i」过滤各表，`rekeyFragment(片段, { object, id, parent })` 改键，即克隆。
  - 字符串里的 `objects/<i>` 前缀（后面是 `/` 或到尾）换成新下标；
  - 数字 `object` 等于旧下标的换掉；
  - `id`、`parent` 取新值。字段清单在文件头。
  - `fragmentBlocker` 拦下四种取不了的：
    - `missing`；
    - `depended`：克隆不被依赖，计划不同；
    - `hdr-layer-composites`：`TEX<n>FORMAT` 随下标变；
    - `group-upload`：模板带子层。
- **判据**（`ignore/live/l1/fragments.test.ts`）：全语料每个对象比较两种片段，要求逐字段相同（`unsupported` 不比）。
  - 一种是在新下标上 `compileFragment` 真编；
  - 一种是 `rekeyFragment(fragmentOf(…))`。

  2026-11-16 的结果：233 张场景、6392 个对象，0 不同；跳过 56 个（`depended` 38、`group-upload` 15、`hdr-layer-composites` 3）。
- **规整配置有损**：`configs[i]`（`getInitialLayerConfig` 的规整文本）的非整数只留 8 位有效数字。按它编出的片段，和从原文编出的模板片段在少数常量的末几位上不同；WPE 的 `createLayer(getInitialLayerConfig(x))` 同样拿到的是舍入后的值。对照测试按原文编；L5 的片段缓存要处理这一点（见总计划 L5）。
- **常驻 Worker（L2）**：会话活在 Worker 里，一个 Worker 一个场景。逻辑在 `compile/workerHandler.ts`（Node 里可测），`worker.ts` 只做转接。
  - **协议**（`compile/protocol.ts`）：`open` → `opened`（整场 bundle 与 `SessionStats`）；`fragment` → `fragment-done`（增量）或 `fragment-error`；`close`。读文件与进度两种消息不变。
  - **串行**：片段请求排成一条队列串行处理，因为 `compileFragment` 改会话共享的表、开关记录器。编失败、增量里有已分离的缓冲、发回时意外抛错，都把会话标坏，之后的请求一律回 `broken`，宿主据此整场重载。
  - **清缓存**：整场编完与每个片段编完、发回之前，会话 `trimCaches` 清掉解析过的 mdl 与 `SceneFs` 的文件内容、pkg 窗口、路径解析缓存，常驻的只剩着色器翻译缓存等真正省时间的部分。
    - 原因：全库冒烟里少数场景常驻 80–290 MB，是大 mdl 的原始文件字节；解析结果不再指向它们，靠下一条的遗忘释放不到。
    - 代价：编片段要用的文件每次经主线程重读，全库冒烟里片段平均约 9 ms、最慢约 0.5 s。片段只编运行中第一次出现的配置，而且是异步的。
  - **转移之后遗忘**：`opened` 转移纹理 mip 与 mdl 文件缓冲。之后会话 `forgetBuffers` 删掉 `mdls` 与 `SceneFs` 缓存里引用这批缓冲的条目，再要就重读；有了上一条，这一条只是保险。片段回传只转移新增纹理的 mip，其余复制；Worker 发片段前查一遍已分离的缓冲（`findDetached`）兜底。
  - **客户端**（`compile/client.ts`）：`openSceneSession` 返回 bundle 与 `CompileSessionClient`（`compileFragment` / `close` / `stats` / `broken`）；增量里的 FreeImage 新纹理在交回前于主线程解码。`compileSceneInWorker` = 开会话、取 bundle、马上关，dev 探针等一次性编译照旧用它。
  - **宿主的留与关**（`host.ts` `sessionUseful`）：场景有脚本，或有对象级重编译绑定（`layer-structure`）时留着会话，否则编完就关。换场景时关旧的，退回、销毁时关。「开始渲染」日志末尾带会话统计。
  - **冒烟**：dev 探针 `sessionSmoke(imageIds)` 经真 Worker 比较片段与改键（同 L1 的对照）、查已分离缓冲、比较整场摘要与 `compileSceneInWorker`。
- **登记表与状态的逐对象增删（L3a）**：宿主手里那份 bundle 由 `compile/registry.ts` 的 `SceneRegistry` 增删。它改的就是 bundle 自己的数组，现读 `bundle.layers` 等的消费者自动接上。状态一侧是 `SceneState.addObject` / `dropObject` / `replaceObject`，`fromBundle` 就是场景级构造加逐个对象装表。本步还没接进宿主（L3b、L4、L5 接）。
  - **加**：
    - 图层追加到表尾；
    - 绑定、脚本、关键帧、声音、灯插在按所属对象排序的位置（新对象就是表尾），关键帧联动的 `parent` 换成表内下标；
    - 灯的遗留槽现分配：空出的最小槽，满了取 0；
    - 有粒子的图层领下一个粒子序号，删掉的序号不回收；
    - 场景级只增表走 `applyDelta`，`from` 不等于当前长度就抛错。
  - **删**：状态先 `flushDestroy`，再 `dropObject` 清掉这个对象的全部表。清哪些键按装表时记下的 `owned`，不靠键的写法。登记表 `removeObject` 摘掉条目，`configs` 保留。
  - **换**：
    - 图层留在原位置，其余条目插回原位置（脚本与关键帧的执行顺序不变），灯沿用原槽、粒子沿用原序号；
    - 状态保留 `order` 位置、运行中的父、子表、冻结与待删标记；
    - 运行中的写入回到新切片的初值，由宿主重放这个对象的脚本写入（L3b）。
  - **组与挂点**：`restructure(state, bones)` 按状态里运行中的父与子表，重写 `bundle.children`、组归属、子树与挂点。
    - 组内关着且读快照的 effect 加 / 去 `GROUP_CHILD_FRAMEBUFFER`，并同步状态的 effect 开关（`syncEffectSupport`，只改 `unsupported`、不动运行中写的 `enabled`）；
    - 返回组内用法的不支持项，由调用方处理；
    - 和 `finalize` 共用 `applyAttachments` / `applyGroupRules`，整场产物不变。
  - **判据**（`ignore/live/l3/registry.test.ts`）：全语料上比三件事：
    - 「从空逐个加」等于「整场一次」；
    - 逐个替换后不变；
    - 随机逐个删，每步等于「只加剩下的」。

    2026-11-17 的结果：233 张场景、6448 个对象，0 不同。
- **宿主子系统的按对象增删（L3b）**：宿主加载时为 bundle 建一个 `SceneRegistry`，各子系统有了按对象的入口：
  - **关键帧** `SceneAnimations.add` / `removeObjects`：联动的主人记条目，不记下标；控制对象按 id 缓存。新条目建出那一帧不写，下一帧先推进再求值（同 WPE）。摘掉之后，已给出的控制对象作废：方法空操作，读值停在摘掉那一刻。
  - **puppet** `ScenePuppets.add` / `remove`：建好按 t = 0 算一次姿势。
  - **文本** `SceneTexts.layoutInCurrent` / `releaseLayout` / `retainLayout`：在当前加载的图集里排一层。加载时没有文本层的场景，按当前代数开一套新图集。
  - **脚本** `ScriptRuntime.replayWritesFor`：只重放目标在这些对象上的写入。
  - **宿主**：
    - `addCompiledObject(delta, mode)` 依次走：登记表 → 状态 → `restructure` → 关键帧 → puppet → 文本 → 脚本 → 声音 → 用户纹理 → 媒体 / 音频 → GPU（L4 前是空钩子）。L5 才接进 `createLayer`。
    - `removeObjectEverywhere(objects, { structural })` 是删除的反向。删除生效处现在接的是 `structural: false`：清子系统残留和状态的按对象的表（`dropObject`），不动登记表，也不重算组。登记表那一半等 L4 改掉还按整场 bundle 现读的组字段与 `newLayerId`。
  - **判据**（`ignore/live/l3b/subsystems.test.ts`）：全语料比两件事，2026-11-17 都是 0 差异：
    - 关键帧与 puppet，「逐个加」和「整场一次」各跑 120 帧，每帧写出的值逐位相同；
    - 删一半之后，等于「只加剩下的」。

    `scriptCorpus` 前后比 236/236 相同。
- **GPU 按对象装卸（L4）**：`GpuScene` 从「整场一次建」改成「场景级准备 + 逐对象装卸」，整场加载走同一条路，产物不变（全库画面哈希对基线）。
  - **三个入口**：`prepareObject(layer, state)` 异步备好一个对象（计划、新纹理、变形纹理、fbo 引用、被依赖层的独占 RT、程序与管线含反射副本、变体管线、投射管线），不碰正在画的东西，失败只收回自己建的；`installObject(prepared, state)` 在帧边界同步装上（运行时、合成 RT、draw、粒子树预热、投射者、挂点），中途出错回滚并抛 `SceneRenderError`；`removeObject(object)` 是 `releaseRemoved` 的单对象版（内部 `teardown`），另外还 fbo 引用、摘粒子序号、挂点、投射者。`prepareObjectSync` 给克隆命中缓存用：程序都就绪时不经 await，缺的管线同步 `createRenderPipeline` 当帧生效（同 WPE），A2C 管线或程序缺时返回 null。
  - **场景级资源可增长**：纹理表 `ensureTextures` 按区间追加（备对象时另补这一层要用、之前没传的纹理）；fbo 池是带引用计数的字段，归零释放，`targets` 用空位表复用下标；粒子索引缓冲容量不够时重建、编码时现取；变形纹理按对象、裁切遮罩第一次用到才建；挂点戳按需建；阴影投射者按对象建、投射管线按键缓存。深度附件、场景目标、反射 RT、阴影图集、泛光、体积光仍是加载时一次。
  - **派生量**：粒子序号（定随机种子）由 `build` 的 `particleOrdinal` 回调给，宿主传登记表的 `particleOrdinal`，缺省按 `bundle.layers` 顺序数；反射名单按 `structureVersion` 从活的 `bundle.reflection.list` 刷新；`layerByObject` 随装卸维护（卸掉的对象仍是别的图层的组时保留，直到整场重载）。
  - **整场加载**：`populate` = 场景级准备 → 全部对象并行备好（同步段按图层顺序先跑完，fbo 的建立顺序与 `targets` 下标同以前）→ 被依赖层的独占 RT 全部进表 → 按顺序装上（共用一份世界矩阵缓存）。变体管线与投射者仍在 `build` 的错误作用域之外另跑（现有测试钉住了「坏 WGSL 只落在图层自己的作用域」），但走的是和单对象同一组函数。
  - **删除路径**：`onDestroyed` 接 `structural: true`，不改组归属的删除接着 `restructure`；改组归属的只摘登记表条目、不 `restructure`（子层的 op 还按旧的组），照旧整场重载，L7 去掉。`ScriptApi.newLayerId` 加单调下界 `nextLayerId`，摘掉最大 id 的层后这个 id 不再发（WPE 的 id 不回收）。
  - **判据**：全库画面哈希（`ignore/live/l4/hash-base-*` 两遍基线，排除两遍之间不同的）与改后逐张相同；假设备单测「整场 build = 空场景逐个装」比到 draw 的 pass 键、管线键、顶点 / uniform 字节、op 序列、fbo 池键与引用、投射者、粒子序号、编码轨迹、粒子列的字节；建删 100 次计数回基线。
- **运行中建层走片段（L5）**：脚本 `createLayer` 不再整场重编译。宿主与 dev 探针共用 `script/createLayerChange.ts` 的 `LiveObjects`（两条路）+ `fragmentCache.ts`（片段缓存）+ `changes.ts`（变更队列），各自只实现「接进场景」的那一侧。
  - **命中缓存**（键是规整配置 `normalizeConfig`，去 `id`）：`rekeyFragment` 改成新下标、配置里的 id、壳的父 → `addCompiledObject(replace)`（登记表加、状态的壳换成编好的、`restructure`、绑定按当前属性全集重写、子系统、脚本条目换成定型的）→ `prepareObjectSync` + `installObject`，都在 `createLayer` 返回之前完成，之后 `addScripts` 跑 `init` 读到的是编好的 `size`；渲染器这一帧的第二次 `sync` / `encode` 带上它，**当帧画出**（同 WPE）。文本层要等 `layoutInCurrent` 排版，GPU 一律异步、至少晚一帧（已知差异）。
  - **没命中**：照 P6d3b 建壳、`init` 照常跑，`create` 进队列、会话异步编；片段到达时场景级增量先进登记表、GPU 上预热一次（程序与管线进缓存）；下一帧 `beforeFrame` 开头 `drain`：状态替换、重放这个对象建出以来的脚本写入、按现在的状态同步再备一次再装；片段进缓存。到达前对象已删：只进缓存（建删循环下一轮命中）。
  - **缓存按会话归属**：片段里的程序 / 纹理下标是会话坐标，换场景 / 整场重载时整个丢掉。从整场 bundle 预置：只收 `fragmentBlocker` 为 null、且原文经规整**无损**（每个非整数有限数 8 位有效数字取回仍是自己；另排除带 `objects/<i>/` 脚本覆盖的、已删的）的对象；无损与否由会话算（`exactConfigs`）、经 `opened` 消息带回，不进 bundle。数组配置、没有 `id` 的配置不进缓存；带「按属性整场重编译」绑定的片段在属性变化时作废（`dropBoundTo`）。
  - **首次加载 `init` 里建的层**不再二次编译：加载时在 `init` 之前就建好登记表与 `LiveObjects` 并预置缓存，`init` 里建的层命中就当场接进还没换上的 bundle，没命中的等片段到齐接上，再建 GPU 场景。整场重载进行中建的对象：新场景换上时先建壳、再走两条路（能命中新会话预置的缓存）。
  - **异常**：编片段失败、片段带 `sceneFlips`、装 GPU 出错 → 整场重载（结构里照记）。**运行中出现的不支持项**（已定 4）：这个对象不装 GPU（不画），其余照常，`SceneReporter.unsupported(keys)` 上报、`stats.created.unsupported` 计数，场景不退回。
  - **提示链**：宿主 `report.unsupported`（同实例同键只报一次）→ `wpe_scene_report` 的 `WpeSceneReport::Unsupported`（记 warn，`emit_to("main", "wpe-scene-unsupported", { image, surface, keys })`，`surface` 按调用方是否壁纸窗口定 `desktop` / `preview`）→ 主窗口 `useSceneUnsupportedNotice`（同一张图同一个键本次运行只提示一次）→ `kameMessage.warning`，文案分桌面 / 预览（`gallery.wpeSceneUnsupported*`，五种语言）。加载时的不支持项照旧整场退回预览图，不走这里。
  - **结构去重**：`recordDestroyed` 对同一规整配置的已删新建对象只留一条，建删循环的结构长度按配置种类封顶。
  - **探针**：`renderFrame` 改用会话；`prewarmFragments` 先空跑一遍收集建出的配置、编好进缓存，再正式回放，第一轮就走同步路径（和 WPE 逐帧比用；`render_scene` / `host_render` / REST `render` / `renderFrames.ts --prewarm-fragments` 都转发，要和 `scripts` 一起给）；不开时片段到达的时机和产品一致，结果里计入 `pending`。
  - **判据**：编译摘要、登记表与子系统对照不变；`scriptCorpus` 里 `recompile` 的 `createLayer/*` 全部消失、其余不变；全库画面哈希与 L4 基线相同；`p6d3b-bars` / `p6d3b-clone` 的脚本日志与 WPE 逐行不变。
- **单对象重编译（L6）**：要重编译才生效的对象级改动（脚本写文本层的 `font` 等非运行中字段、属性改 `size` / `colorBlendMode`、打开带不支持项或在冻结图层上的 effect）不再整场重载。按路径分级（`recompileObjectOf`：`objects/<i>/…` 对象级、`general/…` 场景级），对象级走 `LiveObjects.recompile`（和建层同一条队列，变更 `recompile-object`），场景级与接不上的（整场重载进行中新场景还没换上、对象已删、片段带 `sceneFlips` 的体积光灯）照旧整场。`overrideAndReload` 与 `applyChanges` 都这么分：属性那一批全是对象级时，被 `needsRecompile` 挡下的那几条不写、其余照常就地写，涉及的对象各交一次。
  - **会话**：`compileFragment` 带 `overrides`（这个对象累计的全部覆盖，路径相对对象：`font`、`effects/0/visible`）时按开会话时留的原文套覆盖重编：`scene.json` 里的对象第一次用到时重新解析场景原文、之后逐个深拷，运行中建的对象取配置原文（会话没见过的按请求带来的 `config` 登记）；先摘掉会话里这个对象的旧图层 / 声音 / 灯条目再走单对象管线，`configs[at]` 不动（`getInitialLayerConfig` 仍是加载原文），没写 `id` 的沿用旧图层的 id。空覆盖重编 = 整场片段（全语料 2572 个对象 0 不同，含 26 个带 `fragmentBlocker` 的）。
  - **合并**：同一对象在编期间再写只记最新一份，到达后丢掉这份、按最新再发，连写 N 次只编 1–2 次、最后一次胜出；在编期间属性又就地写了它的绑定也算一次（在编的片段按发请求那一刻的属性编）。
  - **替换**：片段到达进登记表、GPU 预热，下一帧开头 `addCompiledObject(replace)`：登记表与状态 `replaceObject`、`restructure`、绑定按当前属性重写（有被挡下的就记为过期、接完再编一次）、关键帧 `replaceObjects` 按 `id` 接回时钟（`carryTrack`：时钟参数相同才拷 `t` / `flags` / `rate`）、puppet 先摘再加、文本层的旧排版留在状态里直到新排版回来（旧运行时每帧还读它）、脚本条目刷新并重放这个对象的写入；再 `prepareObjectSync` + `installObject`，`installCore` 替换同一对象且粒子定义相同（`sameParticleDefinition`，按键排序的 JSON 比）时沿用旧粒子树，粒子不重来、只重建模板与 draw，不同才新建预热并接回脚本暂停 / 停止。替换之前旧对象照画；片段带不支持项时卸掉旧的 GPU 运行时（`removeGpu`）、上报（同 L5）；重编的片段不进缓存。
  - **`init` 里写的**（语料里 13608 / 15019 的 `font`）走 `loadingLive`：片段到齐接进还没换上的 bundle（等到队空），建 GPU 场景时就带编好的，不再整场编第二次；宿主为「绑属性的 effect 在文本层上或自己带不支持项」也留着会话（`sessionUseful`）。
  - **被依赖的图层**（L6b）：它的独占合成 RT（`layerTargets`）被引用方的 bind group 烤着，所以替换时 `installCore` 先比形状（尺寸、格式、采样器，`sameTargetShape`）：相同就沿用旧的那张（`teardown` 的 `keepTarget`，引用方不动），变了才换新的、旧的释放，再对引用它的 draw 调 `rebindDrawInputs`（重建 bind group、按新尺寸重写 `g_Texture<n>Resolution`，同 P11b 换图；反射副本的 bind group 跟着主 draw 换）。`teardown` 到重绑之间是同步的、不提交引用方的 draw。
  - **探针**：`probe.ts` 用宿主同一份 `LiveObjects`（结果 `liveCreate.recompiles`、`hostStats.recompiledObjects`）；`scriptCorpus` 没有编译会话、不给探针 `live`，对象级写入仍记进它的 `recompile`（探针做不了的写入），全库结果因此不变。
  - **判据**：会话对照（全语料前 20 个对象空覆盖 + 13608 / 15019 的 `font` 覆盖对「带同样 `scriptOverrides` 整场编」）0 不同；编译摘要、登记表、子系统对照与 `scriptCorpus` 全部不变；真机 `live-font` 一次「开始渲染」、字体换了、粒子不重来。和 WPE：`size` / `colorBlendMode` 运行中改我们照样生效（有意不同，L0 实测），`font` 我们晚几帧（已知差异）。
- **结构变化不重编（L7）**：换父进出组、换挂点、删组 / 删组里的对象不再整场重编译，当帧生效（同 WPE P6d3 步骤 0 的实测：进组当帧画进组的合成 RT、没有子层的组合层挂上子层当帧成组、删组当帧子层由顶层画）。P6d3a 记的「进组 / 删组晚一段」两条已知差异消失；`reparentNeedsRecompile` / `destroyNeedsRecompile` 删掉。
  - **编译期**：每个组合层（`passthroughModel`）都编 `groupUpload`（运行中变成组时上屏用），没有子层的推到全部对象之后编（整场在 `finalize` 泛光链之后、片段在 `compileOne` 之后），新程序排在程序表尾、不挪别的对象的程序下标；三个场景级条件（`camera:perspective:group`、`dependency:group`、`fog:group`）加载时仍按「有子层」报（P13h、P8 步骤 7 之后只剩 `fog:group`）。`fragmentBlocker` 不再有 `group-upload` 这条，组合层照常进片段缓存。编译摘要基线：`ignore/live/l0/bundlehash.test.ts` 带 `KBP_IGNORE_GROUP_UPLOAD=1` 时把没有子层的组合层的 `groupUpload` 记成 null、截掉表尾只被它们引用的程序，L7 前后的产物按这个口径 233/233 相同。
  - **登记表**：`restructure` 返回 `{ changed, issues }`，`changed` 比较重算前后每个图层的 `structureKey`（组、组的层数、`subtree`、挂点的父 + 骨骼、带 `GROUP_CHILD_FRAMEBUFFER` 的 effect 下标），顶层之间换父不算（渲染器读状态里的父）。换父与删除一律当场 `restructure`（`removeObjectEverywhere` 的 `restructure` 选项删掉）。
  - **宿主**（`applyRestructure`）：组内不支持组合（`issues` 加组自身的场景级条件（现在只剩 `fog:group`），`script/structure.ts` 的 `trackGroupIssues` / `groupSelfIssues`）新出现的那个对象卸 GPU 不画、`report.unsupported` 经看板娘提示一次，消失的（出组）同步装回来；其余变了的对象交给 `renderer.restructure`，这一帧全部脚本与删除生效之后 `flushRestructure` 当帧做掉，出错整场重载（`reloadAfterRestructure`）。`init` 期间重算的是这次加载的登记表（`loadingRegistry`），建场景时自然带上、组内问题并进 `bundle.unsupported`（整场退回，同以前）；运行中接进的对象（L5 / L6）自己的组内问题并进片段的不支持项走 L5 的「不装 + 上报」。`sessionUseful` 只为对象级路径的 `layer-structure` 绑定留会话。
  - **渲染器**（`GpuScene.restructure` / `flushRestructure`，`sync` 兜底）：`SceneLayer` 和登记表是同一份，`groupOf` / `groupDepth` / 顶层表读到的已是新值，这里补 draw 与资源：挂点表按 `layer.attachment` 更新；每个有运行时的受影响图层 `rebuildLayer(…, { syncPipelines })`，签名之外还比组归属 `LayerRuntime.placement`（组 + 层数：子层进出组时计划签名不变，管线、uniform、池化合成 RT 却变了），缺的管线用 `preparedOfSync` 当帧同步建（进出组只换管线状态，程序不变）、粒子层沿用粒子树；组的层数变了时池化合成 RT 换到对应层数的池重借；组归属变了之后按新归属同步重备可变 effect 的变体，备不好冻结这一层；在顶层而场景目标没有深度附件、计划又要测深度时抛 `render:restructure-depth`（深度附件是场景级不变量）；没有子层的组合层加载时计划是空的，它变成组要用的 compose / `groupUpload` / passthrough 程序在建场景与备对象时另外备好（`groupPrograms`，备不好不算失败）。删组：`flushRestructure` 先 `releaseRemoved` 再按顶层重建子层，`teardown` 不再为「还是别的图层的组」保留 `layerByObject`。一个对象重排失败先卸掉它、其余照做，最后抛错由宿主整场重载。
  - **探针**：`probe.ts` 的 `createProbeLive` 走同一套（`ProbeLiveHooks.restructure`），探针的 ScriptApi 补上 `structure` 与 `reparented` 钩子，结果带 `restructured`。`scriptCorpus` 的 `stateDigest` 在有空组合层的场景上变（95 张，和「有没有空组合层」逐张一致）：`SceneState.constants` 收了新编的 `groupUpload` 的 `g_Color4`，脚本行为、控制台摘要、`recompile` 都不变。
  - **判据**：编译摘要（忽略 `groupUpload` 口径，和 L0 原基线 233/233 相同）、登记表 / 子系统对照、会话与片段对照（blocked 只剩 `depended`）、全库画面哈希不变；真机 `live-regroup`（进组、空组合层成组、出组、删组四步）与 WPE 五个时刻的整帧只差粒子行与标记行、各块逐像素相同、脚本日志 11 行逐行相同，`p6d3-struct` 第 5、6 阶段与 WPE 0 差异（删组当帧子层由顶层画）。

### 能力表（`features.ts`）

能力键以 `类别:具体能力` 命名，例如 `camera:perspective:<用法>`、`tex:format:<n>`、`tex:video`、`uniform:g_LightsPosition`、`combo:PRELIGHTING`、`effect:<目录>:<字段>`、`particle:<类别>:<模块>`、`script:api:<分组>.<成员>`、`script:callback:<名>`、`value:animation`、`shader:flag:parse:…`、`render:bloom:<pass>`、`assets:missing`。原则是**只报真正改变画面的特性**，中性字段逐项写明依据后放行（依据多来自 WPE 2.8.42 的只读逆向，`.claude/plans/wpe-import/3-scene/p2-REPORT.md`；P4a 的在 `phase4/p4-particles-REPORT.md`）。脚本由 P3b 运行时执行，运行期的脚本错误只进脚本诊断、不加入 `unsupported`；但脚本里静态看得出的未实现 API 报 `script:api:*`、整张退回（2026-11-07 改定，见下）。其它渲染能力键照常决定是否退回预览图：

| 放行 | 依据 |
|---|---|
| general 的 `bloom` / `hdr` 与全部 `bloom*` 调节项 | 由后处理档位裁决，泛光 / HDR 已实现（P2b，见 [RENDERER.md](RENDERER.md)「泛光与 HDR」）；其中的脚本交给 P3b 运行时 |
| general 的 `cameraparallax*`、`camerashake*`、`zoom` | 视差、抖动、正交缩放已实现（P5a，见 [CAMERA.md](CAMERA.md)「相机：视差、抖动与缩放（P5a）」）；透视场景的三维抖动 P5d 实现（见 [CAMERA.md](CAMERA.md)「透视相机、相机对象与深度（P5d）」），正交场景里解析出的常量 `zoom` ≤ 0 照报 `general:zoom` |
| `camerafade`、`camerapreview`、`norecompile`；正交投影下的 `farz` / `fov` / `nearz`；`supportsvideo` | 加载淡入 / 编辑器选项 / 透视场景里每帧读（P5d） / 只决定 D3D 设备标志 |
| 模型 `autosize`、`nopadding`、`solidlayer`、`passthrough`、`projectlayer`、`fullscreen`、`instanced`；对象 `copybackground`、`instance`；图像层 `perspective: true` | 已实现（P5b），见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图像模型标志（P5b）」。还不支持的用法细分照报：组里的子孙读快照、fullscreen、透视报 `model:passthrough:children:*`，fullscreenlayer 带子层（全屏组）P5j 起支持，instanced 对象的 `instance` 报 `object:instance:*` / `model:instanced:*`、用户纹理报 `material:usertextures`；`perspective` 绑属性、挂脚本或别的真值，以及图像层（含组合层、组，P5h）、模型、文本层（P5g）之外的对象上为真，照报 `object:perspective`；脚本 `layer.perspective` 由 P5h 实现。`copybackground` 在普通图像模型上没有渲染效果，`instance` 在不是 instanced 的对象上不读 |
| 模型对象；它的 `skin`、`castshadow`、`reflected`、`disablepropagation`、`perspective: true` | 静态网格已实现（P5c），见 [MODELS.md](MODELS.md)「静态网格（P5c）」。`skin` 选材质，`castshadow` / `reflected` 的消费者（阴影、反射）另外照报，`disablepropagation` 中性；不支持的用法细分成 `mdl:*` / `model:*`，见那一节的「能力表」 |
| `solid`、`ledsource`、`locktransforms` | 渲染路径不读（推断与鼠标命中有关）/ Razer Chroma 灯效来源 / 编辑器锁定 |
| `brightness` | 只在 HDR 下乘进 `g_Color4` / `g_Color`（B10），LDR 下不生效 |
| `parallaxDepth`；`alignment` 为 `center`；`perspective` 为 false | 视差已实现（P5a），绘制时只用根对象的值 / 居中是恒等 / 不为真时中性 |
| 模型 `cropoffset`、对象 `config`；translucent / additive 或 `depthtest: disabled` 的 pass 上的 `depthwrite: enabled` | P5a 前置，实测中性：编辑器的裁剪偏移导入时已并进 `origin` / 只在托盘与播放列表读 / 这两种 pass 不写深度；其余 `depthwrite:*` 原先照报，P5d 步骤 1 起统一按深度附件实现、不再报。模型 JSON 的布尔键只认 `true`，见 [CAMERA.md](CAMERA.md)「相机：视差、抖动与缩放（P5a）」的「前置几条」 |
| `colorBlendMode` | 0 普通、31 上屏改 additive、其它走 passthrough，都已实现 |
| effect.json 的元数据键（`name`、`group`、`preview`、`dependencies`、`gizmos`…） | 编辑器显示用 |
| 对象 `parent`（灯除外）；没有内容的分组节点 | 层级已实现（P4a，实测），见 [RENDERER.md](RENDERER.md)「层级（P4a）」；不再报 `object:parent` / `object:empty` |
| general 的 `gravitydirection` / `gravitystrength` / `windenabled` / `winddirection` / `windstrength` | 实测中性：同一工程只改这 5 个键，两份轨迹对解析模型最大差 6.7e-5、1.9e-5，16 个系统的 y 都不漂移；场景重力若生效每帧会偏约 0.08 像素（`proj/p4a-wind`）。读码也没找到引擎读取点 |
| general 的 `perspectiveoverridefov` | 不是中性，解析成透视粒子的 fov（`SceneGeneral.perspectiveOverrideFov`，缺省 95°，钳到 [0.1°, 179.9°]），实测 `d` 逐位相符；绑属性时走重编译 |
| 材质 `alphawriting` | 读码：`default` 映射成 0，绘制时 0 什么都不做（`0x140157201`），等于没写；`enabled` / `disabled` 自 P8 步骤 5 起实现（见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图像层与材质补全（P8）」的写入状态），只有这三个以外的取值报 `material:alphawriting` |
| 材质 pass、effect 实例 pass、instanced `instance` 的 `usertextures`；pass 级 `keepaspect` | 属性来源已实现（P11b），其余按项照报 `usertextures:*`，见 [AUDIO_MEDIA.md](AUDIO_MEDIA.md)「用户纹理（P11b）」；pass 级 `keepaspect` WPE 不读（rea-p11b） |
| 粒子 `instanceoverride` 的 `alpha` / `size` / `count` / `speed` / `lifetime` / `rate` / `colorn` / `color` 与 `id`；`controlpoint0..7` / `controlpointangle0..7` 的静态值 | 已实现、就地生效（见 [PARTICLES.md](PARTICLES.md)「粒子（P4a）」，`colorn` 见 [PARTICLES.md](PARTICLES.md)「粒子（P4b）」）；控制点的静态值在建系统时生效（P4c，见 [PARTICLES.md](PARTICLES.md)「粒子（P4c）」的「控制点」），P4f 起绑属性、挂脚本、脚本 `instance` 对象写入也就地生效；`id` 是编辑器键。`brightness` 只在 HDR 且系统 `flags` 没有 bit3 时乘出生颜色（P4f），其余时候中性。这些键挂 `{script}` 也支持（P4f，`rate` 单独一条路，见 [PARTICLES_SCRIPT_MODULES.md](PARTICLES_SCRIPT_MODULES.md)「粒子（P4f）」） |
| `.tex` 头标志 alpha-priority（`0x80000`） | P4b 实测中性：同一张 RG88 纹理有无这个标志，图像层与粒子整帧逐像素相同；读码看全二进制只把它放进采样器缓存的哈希键 |

- **着色器不按名字白名单**：翻译器把材质常量（带 `meta.material` 的 uniform）与 COMBO 都当普通输入。真正依赖引擎的三类逐项核对：没有 `meta.material` 的内置 uniform 必须在 `ENGINE_UNIFORMS`（与 `render/uniforms.ts` 写的值一一对应，单测核对）里，否则报 `uniform:<名字>`；翻译器标了 `unused`（没被读）的不报（P7d：WPE 的反射里没有它）；只在 effect pass 写的 `g_LayerModelMatrix`（`EFFECT_UNIFORMS`，图层世界矩阵，含父链、不含 size、不带视差）只在 effect pass 认，基础材质读到照报（WPE 在基础 pass 里读到的是别的图层的残留值，P7d）；值非 0 的引擎 COMBO（`ALPHATOCOVERAGE`、光照 / 反射 / 蒙皮 / 变形 / 预光照）报 `combo:<名字>`（`SPRITESHEET` P6e 起不算：它是材质 JSON 自己的 COMBO，帧由渲染器按帧表给，见 [IMAGE_LAYERS.md](IMAGE_LAYERS.md)「图像层帧表（P6e）」）；`_rt_*` 纹理只认 `_rt_FullFrameBuffer` 与本 effect 的 fbo，其它报 `texture:rendertarget:<名字>`。
- **effect** 不再整条报 `effect:<名字>`：逐项检查实例、effect.json、fbo 与命令（`copy` / `swap` 之外的命令、swap 操作数不是本 effect 的 fbo、绘制目标不是本 effect 的 fbo 都报），材质与着色器同基础材质。未启用的 effect（`visible` 为 false 或绑定结果为 false）整步跳过，不检查能力。
- **effect 的 `conditions`、实例 `combos`、`functions`**（P7d）：
  - `conditions`（fbo、pass、bind）照 WPE 的求值函数（`compile/conditions.ts`）在编译期求一次：只按 effect 实例**顶层** `combos`；不是数组恒真；全是「与」；缺的 COMBO 当 0；右值认数与 `{value, op}`（`ge/gt/le/lt`）。
  - 顶层 `combos` 只给条件用，不并进 pass 的 COMBO。
  - 被去掉的 fbo、pass、bind 不进 bundle；被去掉的绘制 pass 仍占实例覆盖与稳定键的位置；`target` 指向被去掉的 fbo 等于没写，bind 指向它等于 `previous`。
  - `functions` 只有脚本 `executeMaterialFunction` 调用（照报 `script:api:effect.executeMaterialFunction`），按中性放开。
  - bind 逐项查键（`name` / `index` / `conditions` 之外报 `effect:<名>:bind:<键>`）。
  - 依据：`.claude/plans/wpe-import/3-scene/phase7/rea-p7d-fluid.md` 与 `p7-REPORT.md`「P7d」；流体与 WPE 的结构、单步、长程对照通过。
- **COMBO 不能绑用户属性**（P3a）：材质 pass 与 effect 实例的 `combos` 里只要有对象值就报 `combo:user-binding`、整张退回。WPE 的 COMBO 只按整数读，写成 `{user, value}` 会让它断言中止整个进程（I3），对象也绝不交给翻译器。本机 26 张样本 0 处这么写。
- **条件可见**（P3a）：`{user: {name, condition}}` 不再报 `visible:condition`，图层 `visible` 的绑定就地切换（见 [HOST.md](HOST.md)「场景宿主」的「属性与快速路径」）。本机 shimmering_particles 的 5 个备选图层与工坊 3549863808 / 3637191856 因此少了一项。
- **脚本（P3b）**：`scene.json` 内的脚本先保留 JSON `value` 作编译期初值，再由运行时求值、调用回调并写回；不按导出名做静态放行，也不报 `value:script`。运行期的脚本错误只影响相应脚本或回调，不进 `unsupported`。
- **脚本 API**（2026-11-07 改定，`compile/scriptApi.ts`）：会执行的脚本里调用或访问了 WPE 有、我们没实现的 API，报 `script:api:<分组>.<成员>`、整张退回，例如 `script:api:thisScene.createLayer`、`script:api:layer.getParent`、`script:api:input.cursorWorldPosition`。改定前的约定是「不做静态扫描，调用时报错只禁用回调」，结果 3304642534 的音频条静默缺了一整组。导出了运行时还不调的回调（光标、媒体等）同样报 `script:callback:<名>`（P6 前置）。规则见 [SCRIPT.md](SCRIPT.md)「场景脚本（P3b）」的「脚本 API 检查」。
- **层级**（P4a）：`object:parent` 只剩灯带父对象时报（`lights.ts` 用本地 `origin`，挂在父链下的位置没和 WPE 比过）；父链成环报 `object:parent-cycle`。
- **粒子**（P4a）：不再整条报 `object:particle`，按模块表细分成 `particle:*`，键的形态见 [PARTICLES.md](PARTICLES.md)「粒子（P4a）」的「编译」。
- **关键帧值**（P4a 报出，P10a 实现）：`{animation: {…}, value}`，`animation` 是对象才算（puppet 的整数 id 不算）。`scene.json` 里的（`general`、图层字段、effect 实例常量、`instanceoverride`、声音音量）由 P10a 求值写入（见「关键帧动画（P10a）」），初值取 `value`；没有就地目标的照报 `value:animation:other`（灯对象 P13f2、相机对象 P5i 起按字段有就地目标，见 [CAMERA.md](CAMERA.md)「相机对象上的关键帧（P5i）」；P5i 之前相机对象上的报 `value:animation:camera`）。材质 JSON 自己的常量、模型 JSON、`effect.json`、粒子系统级键与模块字段、控制点和子系统条目里的关键帧不经 WPE 的属性框架，照报 `value:animation`（`isKeyframedValue` / `scanValue`；语料 0 处）。

**FreeImage 形态 `.tex`**（`freeimage` 为 13 PNG / 2 JPEG，mip 数据是整份图片文件）：Worker 不读这些字节，只记 `encoded` 区间。纹理尺寸取头里的**图像**尺寸（WPE 解码前把头里的纹理尺寸强制改成图像尺寸，所以 UV 为 1；razer_vortex 头写 4096×4096、图像 3840×2160，两组都是 3840×2160，见 `tex.ts` 的 `freeImageTextureSize`）。主线程 `decode.ts` 的 `TextureDecodeCache` 按区间读、`createImageBitmap`（`colorSpaceConversion: "none"`、`premultiplyAlpha: "none"`）解码，缓存键是文件路径与字节区间；`WpeSceneView` 每个目标一份，改属性重新编译时直接命中，换目标或卸载时关闭全部位图，每次解码后只留本 bundle 用到的项。其它 FreeImage 格式报 `tex:freeimage:<n>`，LZ4 包着的报 `tex:freeimage-lz4`。

### 场景后处理档位（`postprocess.ts`）

设置「场景后处理」`wpeScenePostprocess`（tauri 后端：core `SettingKey::WpeScenePostprocess`，命令 `get_wpe_scene_postprocess` / `set_wpe_scene_postprocess`，只接受 `follow` / `disabled` / `enabled` / `ultra`，非法值读回 `follow`；设置页壁纸分区，桌面平台）：

- **跟随 WPE**（默认）：只读 `<WPE 安装目录>/config.json`（由 `sceneAssets` 的上一级定位，与 assets、`ui_` 词条同一套 `wpe::discover::engine_dir`），取第一个 Steam 用户的 `general.user.postprocessing`。WPE 只认 `disabled` / `ultra` / `displayhdr`，其它非空值当「开启」，缺失或读不到当 `disabled`；`displayhdr` 按「超高」处理（我们输出到普通画布）。
- **场景实际状态**：泛光 = 档位不是关闭，且 `general.bloom` 的生效值不是 false（缺键即开；写成属性对象时取绑定属性的当前值，没有绑定取对象的 `value`）；HDR = 档位为超高，且 `general.bloom`、`general.hdr` 的生效值都是 true（规则同泛光，缺键不算）。G3 曾推断属性对象不算，工坊 3286859278（`bloom` 为 `{user: "postprocessing", value: true}`）的超高档抓帧证伪了这一点：WPE 照样走 HDR。
- **泛光参数**：`bloomstrength` / `bloomthreshold` / `bloomtint` / `bloomhdrstrength` / `bloomhdrthreshold` / `bloomhdrfeather` / `bloomhdrscatter` / `bloomhdriterations`，缺键依次取 2 / 0.65 / (1, 1, 1) / 2 / 1 / 0.1 / 1.619 / 8（WPE 场景构造函数），属性对象取生效值（`postprocess.ts` 的 `bloomParams`）。
- **设置来源**（后处理、反射、阴影、体积光四项一起）：宿主不读设置，由父页面 `WpeSceneView` 经 postMessage 下发
  `{ type: "kabegame:wpe-scene-settings", postprocess, reflection, shadows, volumetrics }`：宿主启动时的样式请求（`kabegame:wpe-scene-style-request`）
  一并回它，值变了再主动推（`sceneStyle.ts` 的 `listenSceneParent` → `SceneHost.setSceneSettings`）。桌面壁纸窗口传全局「壁纸设置」
  （`WallpaperWindow.vue` 读四个全局键并跟 `setting-change`），预览与应用背景传这张壁纸的「预览设置」（metadata 的 `previewSettings`，
  见 [WPE_IMPORT.md](../WPE_IMPORT.md)「壁纸设置与预览设置」）。不能跟随 WPE（不是 Windows，或读不到 `config.json`）时父页面已把 `follow`
  换成 Kabegame 默认值（`enabled` / `enabled` / `medium` / `medium`），宿主只在能跟随时才解析 `follow`；缺了的项（不带体积光的旧父页面）按跟随。
- **重新判定**：首次加载等父页面的第一条设置（在 iframe 里最多等 3 s，等不到按跟随并记 warn；不在 iframe 里不等）；之后每条和上一次
  加载用的值比，变了才整场重新加载，几项一起变只加载一次，探针 `stats().recompiled` 记 `{ reason: "settings", keys }`（键是
  `postprocess` / `reflection` / `shadows` / `volumetrics`）。dev 工具直接开的屏外宿主由 `scripts/kabegame-dev/scene.ts` 在主页面里替它回全局设置。
  WPE 自己的设置改了要等下一次加载才生效。

`compileSceneInWorker(input)` 在主线程建立 module Worker，先把 wasm 编译成可克隆的 `WebAssembly.Module`，再发 `start`。Worker 以带 `id` 的 `file` 消息请求 `range` / `whole`，主线程执行 fetch 并用 `file-result` 回传 transferable 字节；读取失败时回传错误的类型名与消息（`protocol.ts` 的 `encodeFileError` / `decodeFileError`），Worker 端还原成同类型，`SceneFs` 才能把 `TypeError: Failed to fetch` 认作「不存在、查下一个来源」。Worker 完成后以 `done` 回传 bundle 与所有 mip 的 ArrayBuffer；错误用 `error`。`AbortSignal` 取消时终止 Worker。Worker 不直接访问 `file:`。

测试：宿主在 `apps/wpe-scene`，运行 `deno task --cwd apps/wpe-scene test`、`deno task --cwd apps/wpe-scene typecheck`（整仓 `deno task test -c kabegame --skip cargo` 会连 `apps/kabegame` 一起跑）。设置 `KABEGAME_WPE_ROOT` 为 WPE 安装目录且有前端 wasm 时，语料测试会只读编译当前全部默认与工坊场景（后处理固定为关闭）：断言 eagleflag / deep_space / beach / razer_vortex / razer_bedroom 的 `unsupported` 为空、其它样本非空，且快速路径与 `exhaustive` 的结论一致；模拟 CEF `fetch(file:)` 统计运行时形态（快速路径）每张的请求次数、失败数与读取字节数，限制无单字节探测、请求不超过 150 次、读取量小于 64 MiB。`p2a.test.ts` 另核对 vortex / bedroom 的结构与三档后处理。`p3a.test.ts`（`compile/` 与 `render/` 各一份）核对绑定表生成、全语料「读过的属性都登记」、取值换算、就地 = 重编译的 uniform 字节、条件可见、可见性跳过与泛光级数、`planApply` 分类、加载期间增量。
