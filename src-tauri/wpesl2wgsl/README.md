# wpesl2wgsl

把 Wallpaper Engine 着色器语言（WPESL，WPE 的 `shaders/*.vert|frag` 及其 `#include` 头文件）翻成 WGSL，
供场景壁纸（`x-wpe/scene`）的前端 WebGPU 渲染器使用。编成 wasm 在前端运行，**不链进应用**，应用的 Rust 代码也不依赖它。

调用方传一个材质 pass 的顶点 / 片元源码**原文**（绳粒子另带几何着色器，见「几何着色器展开」），以及头文件、COMBO 取值和绑定的纹理。预处理、改写、翻译、反射全在 crate 内部完成。

## 构建与接入

```bash
rustup target add wasm32-unknown-unknown   # 每台机器一次
deno task build:wpesl2wgsl                 # → bin/wasm/wpesl2wgsl/wpesl2wgsl.wasm（git 忽略，约 1.4 MB）
```

- 脚本是 `scripts/build-wpesl2wgsl.ts`，执行 `cargo build -p wpesl2wgsl --lib --target wasm32-unknown-unknown --profile wpesl2wgsl`。
  根 `Cargo.toml` 的 `[profile.wpesl2wgsl]` 按体积优化（`opt-level = "z"`、`lto`、`panic = "abort"`），不影响其它 crate。
  缺 wasm 目标时脚本报错，并给出 `rustup target add` 命令。
- kabegame 的 dev / start / build / check / test 不带 `--skip vue` 时，`scripts/plugins/wpesl2wgsl-plugin.ts` 在 `prepareEnv` 阶段把产物拷进场景宿主
  `apps/wpe-scene/src/wpesl2wgsl/wpesl2wgsl.wasm`（git 忽略，内容相同不重写）。找不到产物只告警，宿主照常构建。
- 胶水 `apps/wpe-scene/src/wpesl2wgsl/index.ts` 提供以下接口：
  - `loadWpesl2wgsl()`：wasm 没拷进来时返回 null，调用方应把场景标成不支持；
  - `Wpesl2wgsl.translate(request)`；
  - `translateWithIncludes(translator, request, readInclude)`：缺头文件就读出来重试。

  wasm 由 `import.meta.glob` 引用，文件缺失时构建不会失败。
- 路径常量 `WPESL2WGSL_WASM`、`WPESL2WGSL_FE_WASM` 在 `scripts/paths.ts`。

## 接口

### C ABI（不用 wasm-bindgen / wasm-pack）

| 导出 | 说明 |
|---|---|
| `wpesl_alloc(len) -> ptr` | 在 wasm 内存里分配字节，供 JS 写入请求 |
| `wpesl_free(ptr, len)` | 释放请求缓冲区，或结果缓冲区（`len` 取整个缓冲区长度 `4 + n`） |
| `wpesl_translate(ptr, len) -> ptr` | 输入 UTF-8 JSON 请求；返回的缓冲区 = 4 字节小端 `u32` 长度 + JSON 结果 |

- wasm 没有任何导入，用 `WebAssembly.instantiate(module, {})` 即可。
- panic 会让实例 trap：胶水丢弃实例、下次调用前重建，本次返回 `{ ok: false, phase: "trap" }`。
- Rust 侧同名的 `translate(&TranslateRequest) -> TranslateResult` 供原生测试用。

### 请求

```ts
interface TranslateRequest {
  vertex: string;                                  // .vert 原文
  fragment: string;                                // .frag 原文
  geometry?: string;                               // .geom 原文：给了就做几何着色器展开（定义 GS_ENABLED），见「几何着色器展开」
  includes?: Record<string, string>;               // `#include` 里写的名字（相对 shaders/ 根，如 "common.h"、"base/model_vertex_v1.h"）→ 源码
  combos?: Record<string, number | boolean>;       // 材质 pass 与 effect pass 的 combos，名字不分大小写
  textures?: { slot: number; format?: number }[];  // 已绑定的 g_Texture<slot> 及其 .tex 格式枚举
  defines?: Record<string, string>;                // 额外的宏，最后应用（可覆盖平台宏与 COMBO）
  litDefines?: Record<string, string>;             // 只在最终 LIGHTING 非 0 时生效的宏（LIGHTS_* 等，见下）
  debug?: boolean;                                 // 成功时也带上生成的 GLSL 450
}
```

- **头文件按需提供**：结果为 `phase: "include"` 时，读出 `missing` 里的文件、放进 `includes` 后再调一次。只有处于有效分支的 `#include` 才要求提供。
  头文件的查找顺序（项目 `shaders/` → WPE `assets/shaders/`，effect 自己的 `shaders/` 优先）由调用方决定。
- **`litDefines`**：WPE 只在最终 `LIGHTING` 非 0 时写 `LIGHTS_*`，而 COMBO 的最终值（可能来自着色器注解的默认值）要到这里才算得出，所以由翻译器裁决。
- **`textures` 有两个作用**：一是采样器注释里写了 `"combo": "NORMALMAP"` 的槽位绑定了纹理时，该 COMBO 置 1；二是给声明了 `formatcombo` 的槽位定义 `TEX<slot>FORMAT = format`，和 WPE 一样；没声明的不定义，在 `#if` 里按 0。
  格式枚举与 WPE 一致：0 RGBA8888、1 RGB888、2 RGB565、4 DXT5、6 DXT3、7 DXT1、8 RG88、9 R8、10 RG1616F、11 R16F、12 BC7。

### 结果

成功时 `ok: true`：

| 字段 | 内容 |
|---|---|
| `vertex` / `fragment` | `{ wgsl, entryPoint, glsl? }` |
| `uniforms` | uniform 块成员：`{ name, type, declared, offset, size, array?, stride?, meta?, stage?, original? }`（`stage` / `original` 见「两阶段同名 uniform」） |
| `uniformBlockSize` | uniform 块总字节数（没有普通 uniform 时缺省） |
| `textures` | `{ slot, name, kind: "2d" \| "2d-comparison" \| "3d" \| "cube", binding, samplerBinding, meta? }` |
| `attributes` / `varyings` | `{ name, location, type, array? }` |
| `combos` | 最终生效的 COMBO：`{ name, value, source: "default" \| "texture" \| "request" }` |
| `geometry` | 只在请求带 `geometry` 时有：`{ maxVertices }`，见「几何着色器展开」 |

失败时 `ok: false`，带出错阶段 `phase` 和出错的 `stage`（`"vertex"` / `"fragment"`，几何段的预处理与展开错误是 `"geometry"`），失败那一侧的 `vertex.glsl` / `fragment.glsl` 也会给出（诊断行号指向它；带几何段时 `vertex.glsl` 是拼好的那一段），另有 `errors: [{ message, file?, line?, column? }]`：

| `phase` | 含义 |
|---|---|
| `request` | 请求 JSON 无法解析，或 COMBO 值不是整数 / 布尔 |
| `include` | 缺头文件，见 `missing`；只有几何段缺时 `stage` 为 `"geometry"` |
| `require` | `#require` 展开不了，见 `requires`：未知的库名，或要阴影 / cookie 的 `LightingV1/shadow` |
| `preprocess` | 条件编译不配对、`#if` 表达式错误、未知预处理指令（`file` / `line` 指向原文） |
| `rewrite` | 不支持的全局声明、两阶段同名的引擎 uniform（都没有 `material`）类型不同、纹理函数参数不是已声明的纹理；几何着色器展开不支持的写法（`IN[1]`、`OUT.RestartStrip()` 等） |
| `parse` / `validate` / `write` | naga 阶段的错误（行号指向生成的 GLSL） |
| `trap` | wasm 实例 trap（仅前端胶水产生） |

### 绑定布局（渲染器据此建 bind group layout）

- 全部资源在 group 0；两阶段声明同一份。
- binding 0：uniform 块 `KbUniforms`（std140），**顶点与片元共用一块缓冲**。成员是两阶段普通 uniform 的并集，按首次出现的顺序排列；
  两阶段同名而材质键（或类型）不同的 uniform 各占一格，见「两阶段同名 uniform」。
- 纹理 `g_Texture<n>`：纹理在 binding `1 + 2n`，采样器在 binding `2 + 2n`。`2d-comparison` 的采样器是比较采样器。
- 顶点属性按声明顺序分配 location：矩阵占列数个，数组再乘长度。渲染器按 `attributes` 的 name → location 建顶点缓冲布局。
- varying 的 location 在两阶段间统一分配。整数类型的 varying 带 `flat`。

### uniform 打包

- 每个成员写在 `offset` 处。`declared` 是 WPESL 里写的类型（`float`、`vec3`、`mat4`……），`type` 是块里实际的 WGSL 类型。
- **标量与二三分量向量的数组**在块里补成四分量向量数组，比如 `float g_AudioSpectrum16Left[16]` 的 `type` 为 `array<vec4<f32>, 16>`。
  第 i 个元素在 `offset + i * stride`（stride 16），只用前几个分量。这与 std140 的内存布局完全相同。
  原因是 WGSL `array<f32, N>` 的步长固定为 4，而 uniform 地址空间要求步长是 16 的倍数，原样写出的 WGSL 不合法。
- `meta` 是声明行尾的 JSON（`material` 名、`default`、`range`、`type: "color"` 等），渲染器据此把材质常量、用户属性映射到 uniform。引擎内建的 `g_*` 没有 `meta`。
- 只在某些 COMBO 下声明的 uniform 不会出现在结果里；不同 COMBO 组合要分别翻译。

### 两阶段同名 uniform

WPE 在 D3D11 下每个阶段有自己的常量缓冲，但材质常量**按材质键只有一份存储**（`.claude/plans/wpe-import/3-scene/vector-constant-REPORT.md` 2.1，实测见第 6 节）：
- 键不同，是两份存储。`3829603837` 的 `foliagesway`：RenderDoc 里顶点 `g_Speed` 是材质键 `speed` 的值，片元 `g_Speed` 是 `speeduv` 的缺省值 5。
- 键相同、缺省不同，也只有一份。合并表里片元覆盖顶点，缺省只插一份，两个阶段都读片元的缺省（`p4b-vec` 的 `stage-def`：顶点 0.2、片元 0.8，两阶段都读到 0.8）。

我们两阶段共用一块缓冲，所以按**取值来源**决定合并还是拆分（`rewrite::merge_uniforms`）：

- **取值来源**：注解里有字符串 `material` 是材质常量，来源就是这个键（缺省值、`label`、`range` 等都不比）；
  没有注解，或注解里没有字符串 `material`，是引擎按名字写入的值。宿主同样只认字符串 `material`。
- **合并**：类型相同、来源相同，合成一格。材质常量的注解取片元的（与 WPE 合并表一致），片元没有时取顶点的；引擎值的注解取顶点的，宿主不读。
- **拆分**：来源不同，或同一个键而类型不同，拆成两格，各带自己的 `declared` / `type` / `meta`，各占块里的一格。其中一侧在**自己的源码里**整体改名为
  `kb_vs_<名字>` / `kb_fs_<名字>`，撞上已有标识符时加 `_2`、`_3`……，与保留字改 `kb_<名字>` 同一惯例。改名覆盖本阶段正文的每一处，包括 `#define` 行和同名局部变量 / 参数。
  - 一侧是引擎值、另一侧是材质常量：**材质常量那一侧改名**。引擎值保留原名，渲染器照旧按名字写入，宿主也照旧按名字把它认成引擎 uniform。
    所以改了名的一格总带 `meta.material`。
  - 两侧都是材质常量：先声明的顶点阶段保留原名，片元阶段改名。
  - 两侧都是引擎值而类型不同：报 `phase: "rewrite"`。引擎值按名字写入，拆开后改了名的那一格没人写。
- **同键不同类型**（工坊 `frame_builder` 的 `u_refResolution`：顶点 vec2、片元 float）：WGSL 里一格只能有一种类型，只能拆。
  WPE 只有一份按片元类型（float）写的存储，各阶段按自己的类型从同一个槽拷分量，顶点多拷的那个分量是下一个材质常量的存储（报告 2.2）。
  宿主按两半的 `stage` 复刻：setter 的类型与缺省值取片元那一半；顶点那一半分量数不超过片元的照常取前几个，超过的报 `constant:mixed-type:<材质键>`。
- **反射**：拆开的两格都带 `stage`（`"vertex"` / `"fragment"`，这一格只给哪个阶段用），改名的一格另带 `original`（着色器里写的原名）。合并的没有这两个字段。
- **按用户决定不复刻的两条**（2026-11-08，报告第 5 / 6 节）：同一阶段两个 uniform 用同一个键时 WPE 只上传后声明的那个，我们两个都照常填；
  WPE 按声明行（含注释）的子串定类型（注释里写了 `vec3` 就按 vec3 写、溢到后面的变量），我们按真实的声明类型。

本机语料（2026-11-08，WPE assets、defaultprojects 与 144 个工坊项目自带的着色器，扫描脚本 `ignore/p4/b1/workshop_stage_uniforms.py`）：
- 同时可达的冲突：`effects/foliagesway`，`g_Speed` 键不同（拆）、`g_Phase` 同键不同缺省（合并，取片元的 0.5），assets 与 33 个工坊项目各带一份；
  `effects/perspective` effect 预览项目自带的旧版，`g_Top/Bottom/Left/Right` 同键缺省 0 / 1（合并，取片元的 1）；
  工坊 `frame_builder_by_gariam` 的 `u_refResolution`，同键不同类型，它另有 naga 校验错误、到不了宿主。
- 被条件编译分开、不会同时出现的：assets 的 `effects/clouds` 的 `g_CloudSpeeds`（`PERSPECTIVE` 两支）；工坊 `auto_sway` 的 `g_Inertia` / `g_SigmentCount`（`AA_VERSION` 两支）。
- 「一侧有注解、一侧没有」的 0 处。

## 内部流程

源码在 `src/`：`lib.rs`（请求 / 结果、编排、C ABI）、`preprocess.rs`、`library.rs`（`#require`）、`geometry.rs`（几何着色器展开）、`rewrite.rs`、`naga_stage.rs`。

1. **注释元数据**：不看条件分支，扫描两段源码与可达的头文件，收集 `// [COMBO] {"combo","default",…}` 声明和带注释的 `uniform sampler* g_Texture<n>; // {…}`。
2. **宏表**，后者覆盖前者：
   1. 平台宏；
   2. COMBO：声明默认 < 纹理推导 < 请求；
   3. `TEX<n>FORMAT`；
   4. 请求里的 `defines`。

   平台宏照 WPE 在 Windows 上的 HLSL 路径：
   - `HLSL=1`：`#ifdef HLSL` 块是 D3D 坐标约定下的 Y 翻转，WebGPU 的纹理 / 帧缓冲坐标与 D3D 相同；
   - `HLSL_SM40=1`、`SHADERVERSION=69`：WPE 恒定义；
   - `GS_ENABLED` WPE 恒定义，这里只在请求带 `geometry` 时定义（三段都定义，排在平台宏之后、COMBO 之前）：不带几何段时粒子走「顶点着色器自己展开四角」的分支
     （`genericparticle` 的非 GS 分支与 GS 路径几何相同）；带几何段时走 GS 分支，由「几何着色器展开」拼成一个顶点着色器；
   - `REVERSEDEPTH` WPE 恒定义，这里不定义：深度不是反向的；
   - `HLSL_GS40_DISABLED` 不能定义：WPE 没有这个宏，`particle.vert` 定义后走给几何着色器准备输入的分支；
   - `HLSL_SM30`、`GLSL`、`PLATFORM_ANDROID` 不定义。`HDR`、`SCENE_ORTHO` 由宿主按场景经 `defines` 传，关闭时不写键。

   COMBO 名按大写处理：材质里写 `version: 2`，源码里是 `VERSION`。
3. **预处理**（`preprocess.rs`）：
   - 剥离块注释，保留行号；处理行续接；`#include` 原地展开。
   - `#if / #ifdef / #ifndef / #elif / #else / #endif` 按 C 优先级求整数表达式，支持 `defined`。未定义的标识符按 0 处理：大量 COMBO 不写声明，直接 `#if MULTI`。
   - `#define` / `#undef` 行保留，交给 naga 自带的预处理器展开正文；函数宏不参与 `#if`。
   - 全局声明的数组长度如果写成宏（`g_Bones[BONECOUNT]`），按当前宏表算成数字。
   - `#require` 按 WPE 语义现场展开（`library.rs`）：`LightingV1` 在 `LIGHTING` 非 0 时按 `LIGHTS_*` 生成灯光 uniform 与 `PerformLighting_V1`，
     否则什么都不插；逐灯计算在公开头文件 `common_pbr_2.h`，这里只负责遍历。未知的库、阴影与 cookie 报 `phase: "require"`。
   - `#version` / `#extension` / `#pragma` 去掉。
   - 带几何段时，几何段在顶点段之后预处理，顶点段展开过的头文件只求宏、不出行（见下节第 1 条）。
4. **几何着色器展开**（`geometry.rs`，只在带几何段时）：顶点段与几何段拼成一段顶点着色器，再交给下一步，见「几何着色器展开」。
5. **改写成 Vulkan GLSL 450**（`rewrite.rs`）：
   - **声明**：
     - 普通 uniform 并入 uniform 块，标量 / 二三分量向量的数组补成 `kb_u_<名字>`，再由 `kb_load_<名字>()` 还原、宏指回原名。这样下标访问和整个数组传参都照常可用。
       两阶段同名、取值来源不同的拆成两格，一侧改名为 `kb_vs_` / `kb_fs_<名字>`，见「两阶段同名 uniform」。
     - 采样器拆成纹理 + `kb_sampler_<名字>`；`attribute` / `varying` 加 `layout(location)`。
     - 只在片元阶段声明的 varying，也给顶点阶段补一个输出。顶点阶段不写入时值为零，对应 D3D 下的未定义值；不补的话，WebGPU 建管线会失败。
     - `gl_*` 名的全局声明（几何着色器遗留的 `varying uint gl_ViewportIndex`、fur4 的 `in uint gl_InstanceID`）忽略。
   - **纹理函数**：
     - `texSample2D(t, uv)` 改成 `texture(sampler2D(t, kb_sampler_t), uv)`；
     - `texSample2DLod` 改成 `textureLod`；
     - `texSample2DCompare(t, uv, ref)` 改成 `texture(sampler2DShadow(…), vec3(uv, ref))`；
     - `texSample3D`、`texSample2DBackBuffer` 改成 `texture`；
     - `texLoad2D(t, uv, res)` 改成 `texelFetch(…, ivec2(uv * res), 0)`。

     参数里嵌套的调用一并改写，第一个参数必须是已声明的纹理。
   - **内建**：`gl_FragColor` → `kb_FragColor`（`layout(location = 0) out vec4`），`gl_VertexID / gl_InstanceID` → `gl_VertexIndex / gl_InstanceIndex`。
     与 GLSL 450 保留字冲突的标识符改名为 `kb_<名字>`：`sample`、`input`、`output`、`texture`、`smooth`、`flat`、`common`、`buffer` 等，完整列表见 `RESERVED_RENAMES`。精度限定符去掉。
   - **HLSL 风格内建**由宏头补上（`MACRO_HEADER`）：`mul(a, b) → ((b) * (a))`（行向量左乘）、`frac`、`lerp`、`atan2`、`saturate`、`ddx / ddy`、`rsqrt`、`fmod`、`log10`、`clip`、`CAST*`。
     正文用到 `pow` / `max` / `min` 时，补一组「标量扩展」重载：HLSL 允许 `pow(v3, 2.4)`、`max(0, v3)`，GLSL 没有这些重载。
6. **naga**（`naga_stage.rs`）：
   - GLSL 450 前端负责解析和隐式的 int → float 转换；
   - 按 WebGPU 基线（`Capabilities::empty()`）校验后输出 WGSL；
   - uniform 块的偏移与步长取自 naga 的 std140 布局。

   naga 30.0.1 的源码嵌在 `naga/`（路径依赖），删掉了用不到的前后端，只开 `glsl-in` + `wgsl-out`；`wgsl-in` 只在 `[dev-dependencies]` 里开，给测试回读输出。
   上游版本、删掉的模块与每处改动见 [naga/KABEGAME.md](naga/KABEGAME.md)。

## 几何着色器展开

WebGPU 没有几何着色器。WPE 画绳（`rope` / `ropetrail`）用 `genericropeparticle.vert` 的 `GS_ENABLED` 分支加 `genericropeparticle.geom`：
几何着色器输入一个点（绳的一段），输出 `4 + 2·TRAILSUBDIVISION` 个顶点的三角形带。`.vert` 的非 GS 分支和 GS 路径的几何不同
（没有细分、不看 `ORIENTATION`、有一处运算优先级错误），所以要复刻 GS 路径，用的仍是用户 WPE 安装里的原件。

请求带 `geometry`（`.geom` 原文）时，翻译器把两段拼成一个顶点着色器（`src/geometry.rs`），结果多一个 `geometry: { maxVertices }`：
- 每次几何着色器调用是一个**实例**：渲染器把 `attributes` 全部按实例步进，每个实例画 `maxVertices` 个顶点，拓扑三角形带。
  实例之间本来就断开，与 GS 每次调用输出一条带等价。
- `vertex_index` 是第几个输出顶点。每个输出顶点都把顶点段和几何着色器的函数体照跑一遍，**第 `vertex_index` 次 `OUT.Append` 的顶点就是输出**。
  代价是每个输出顶点重跑一遍 GS 函数体（`TRAILSUBDIVISION` 钳到 32，一段最多 68 个顶点）。
- 预处理之后、改写之前做；之后的改写、naga、反射与普通顶点着色器相同，`uniforms` / `textures` / `varyings` 照旧。

规则：
1. **宏与头文件**：宏表加 `GS_ENABLED=1`，三段都定义（WPE 恒定义）。几何段用同一张宏表预处理，**顶点段已经展开过的头文件在几何段只求宏、不出行**：
   `common_particles.h` 没有头文件保护，两段都 include 它，原样再展开一次会重复定义函数与 uniform；头文件里的 `#define` 仍进几何段的宏表、驱动它的 `#if`。
   几何段缺头文件照样报 `phase: "include"`，只有几何段缺时 `stage` 为 `"geometry"`。
2. **输出顶点数**：`[maxvertexcount(<表达式>)]` 按几何段的最终宏表求值，作为 `maxVertices`。缺这一行、有多行、或不在 `1..=1024` 时报错。
   `TRAILSUBDIVISION` 决定它，所以要进渲染器的缓存键。
3. **顶点段**：`varying T x;` 改成私有全局 `T kb_gsin_x;`，正文（含头文件与 `#define` 行）里的 `x` 都改成 `kb_gsin_x`（成员访问 `.x` 不动）；
   `gl_Position` 改成 `kb_gsin_gl_Position`（`vec4`）；`main` 改成 `kb_vs_main`。
4. **几何段**：
   - `in T x;` 删掉，但顶点段必须有同名、同类型的 varying（`gl_Position` 除外）。`.geom` 里 `#if THICKFORMAT || TRAILSCROLLALPHA` 两支的 `v_EndPoint`
     是 `vec4` / `vec3`，与 `.vert` 三支的取法一致，所以各组合下都对得上。
   - `out T x;` 改成 `varying T x;`：这才是真正的顶点输出，与片元按名字配对；`out vec4 gl_Position;` 删掉。
   - `IN[0].x` 改成 `kb_gsin_x`；下标不是 0 报错（只支持点输入）。
   - `PS_INPUT` 是生成的 `struct PS_INPUT { <每个 out 字段>; vec4 kb_Position; }`，`.gl_Position` 字段访问改成 `.kb_Position`（字段名不能以 `gl_` 开头）。
   - `OUT.Append(e);` 改成 `kb_gs_append(e);`；`OUT.RestartStrip()` 与 `OUT` 的其它成员报错（只支持单条带）；正文直接写 `gl_Position` 报错。
   - `main` 改成 `kb_gs_main`；`normalize(` 改成 `kb_gs_normalize(`（第 7 条）。
5. **for 循环变量**：for 头里声明的变量，如果循环体顶层又声明了同名变量（`.geom` 的 `for (int s…) { float s = smoothstep(…); … }`），
   for 头里的那个改名为 `kb_<名>`（撞名再加 `_2`……），循环体里遮蔽声明之前对它的引用一起改。GLSL 450 的循环体不开新作用域，这是重复声明；HLSL 允许遮蔽。
6. **HLSL 隐式截断**：HLSL 允许把更宽的向量赋给较窄的（取前几个分量）、把标量铺满成向量，GLSL 不允许。几何段里浮点标量 / 向量（`float`、`vec2`–`vec4`）
   局部声明的初始值，以及 `PS_INPUT` 变量字段的整体赋值，右边包一层 `kb_gs_as_<类型>(…)`，按实参类型重载（同类型原样返回）。
   `.geom` 的 `vec3 eyeModel = mul(vec4(…), g_ModelMatrixInverse)`（`ORIENTATION 0`）与 `LIGHTING` 下的 `v.v_WorldPos = mul(vec4(…), g_ModelMatrix)` 靠它通过。
   只看语句开头的写法，不碰 `const`、for 头、多个声明符、普通变量的再赋值和分量赋值；顶点 / 片元段不做（见「已知不支持」）。
7. **零向量 `normalize` 时整个图元不画**：`kb_gs_normalize` 有 `float` / `vec2` / `vec3` / `vec4` 四个重载，`dot(v, v) == 0.0`（`float` 是 `v * v`，
   naga 不接受标量的 `dot`）时置 `kb_gs_degenerate`、原样返回，否则返回 `v * inversesqrt(dot(v, v))`。
   - 依据：WPE 下 `normalize(0)` 得 NaN，D3D 丢弃含 NaN 顶点的三角形。绳的两种 GS 里右向量一旦是 NaN，带上每个三角形都含 NaN 顶点，
     等价于整个图元不画；P4d 步骤 0 实测的 NaN 顶点数和这个预测逐帧相同。
   - 不靠检测 NaN：WGSL 允许实现假定没有 NaN，`x != x` 可能被优化掉。
   - 只改几何段自己的调用；顶点段与头文件里的 `normalize`（如 `ComputeScreenRefractionTangents`）不动：它们的 NaN 只进折射切线这类非位置属性，D3D 不丢三角形。
8. **拼接顺序**：私有全局（`kb_gsin_*`、`kb_gs_target`、`kb_gs_count`、`kb_gs_hit`、`kb_gs_degenerate`）→ `struct PS_INPUT` 与 `PS_INPUT kb_gs_selected`
   → `kb_gs_append`、`kb_gs_normalize`、用到的 `kb_gs_as_*` → 顶点段 → 几何段（`out` 改成的 varying 在原位置）→ 新的 `main`：

```glsl
void main() {
    kb_vs_main();
    kb_gs_target = int(gl_VertexIndex);   // naga 里 gl_VertexIndex 是 uint
    kb_gs_count = 0;
    kb_gs_hit = false;
    kb_gs_degenerate = false;
    kb_gs_main();                         // 每次 kb_gs_append：kb_gs_count == kb_gs_target 时记下，kb_gs_count++
    if (kb_gs_hit && !kb_gs_degenerate) {
        gl_Position = kb_gs_selected.kb_Position;
        v_TexCoord = kb_gs_selected.v_TexCoord;   // 每个 out 字段原样赋给同名 varying
        v_Color = kb_gs_selected.v_Color;
    } else {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // 落在裁剪体外
    }
}
```

限制：
- 只支持点输入与每次调用一条带，见第 4 条。
- **画的顶点数必须等于实际 `Append` 次数**：多出来的顶点放在裁剪体外，会和前面的真实顶点连成三角形。`genericropeparticle` 每次调用都正好输出 `maxVertices` 个，渲染器按 `maxVertices` 画即可。
- 顶点段正文的 `#define` 对拼在后面的几何段同样生效（naga 一次预处理整个文件），而 WPE 是分开编译的；绳着色器两段的宏没有冲突。
- 跳过的头文件只有一份，放在顶点段：两段在条件编译下看到的头文件内容要相同（宏表相同、头文件之前没有各自的 `#define` 时成立）。

## 已知不支持

| 现象 | 原因 |
|---|---|
| `phase: "require"`，`LightingV1/shadow` | 阴影与 cookie 要 `_rt_shadowAtlas` / `_alias_lightCookie`，渲染器没有 |
| `Unknown variable: gl_ViewportIndex` | 阴影投射走的几何着色器路径 |
| `Unknown function 'rotateVec2'` 这类 | HLSL 允许 vec4 → vec2 隐式截断，GLSL 不允许；没有类型信息无法改写 |
| `varying … 在两个阶段的类型不同` | 同上（片元阶段读更少分量） |
| `Array size must be greater than zero` | `BONECOUNT` 等引擎宏未定义（骨骼蒙皮），可经 `defines` 传入 |
| `不支持的采样器类型 sampler2DBackBuffer` | 体积光专用采样器类型 |

另外，glsl-in 只认 Vulkan 语义的 GLSL 450，这正是改写这一步存在的原因；naga 的 `glsl-in` / `wgsl-out` 在其支持表里是二档（维护但测试较少）。
如果以后遇到 naga 接不住的写法，备选方案是 glslang → SPIR-V → Tint（Babylon.js 的路线）。

## 测试

```bash
# 单测（预处理、几何着色器展开、改写、naga 阶段、端到端、C ABI）
CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --lib

# 嵌入的 naga 保留下来的上游单测（feature 的原因见 naga/KABEGAME.md）
CARGO_TARGET_DIR=target-check cargo test -p naga --lib --features glsl-in,wgsl-in,wgsl-out,stderr

# 本机 WPE 语料：只读访问 WPE 安装目录，未设置环境变量时跳过
KABEGAME_WPE_ROOT="D:\Applications\Steam\steamapps\common\wallpaper_engine" \
CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --test corpus -- --nocapture

# 前端胶水（需要先把 wasm 拷进前端：任意不带 --skip vue 的 kabegame 命令）
deno task test -c kabegame --skip cargo
```

语料测试（`tests/corpus.rs`）前两部分读 WPE 安装目录（没设 `KABEGAME_WPE_ROOT` 时跳过）：
- **门槛**：P1 样本用到的着色器对，按材质实际的 COMBO 与纹理必须翻译通过。包括 `assets/shaders/flag`（TINT=1）、`genericimage`，以及 deep_space / beach 的 `flowimage`、`swayimage`。
- **基线**：`assets/shaders`、`assets/effects`、`projects/defaultprojects` 下全部着色器对，在默认 COMBO（只绑定 g_Texture0）下的通过率；并把每份输出 WGSL 交给嵌入的 naga 的 `wgsl-in` 重新解析、校验。
  完整报告写到 `CARGO_TARGET_TMPDIR/wpesl2wgsl-corpus.txt`。

另有两道门槛：
- `genericimage4` / `genericparticle` / `genericropeparticle` / `generic4` / `foliage4` / `chroma4` / `fur4` 开 `LIGHTING`、带四种灯（LDR 与 HDR 各一遍），走真实的 `common_pbr_2.h`，翻译并回读。
- 几何着色器展开（27 组）：`genericropeparticle` 带 `.geom`，翻译通过、两段 WGSL 回读通过、`maxVertices = 4 + 2·TRAILSUBDIVISION`、顶点 WGSL 用到 `vertex_index`。
  rope 是 `THICKFORMAT 1` × `TRAILSUBDIVISION` 0 / 3 / 4 / 16 / 32 × `ORIENTATION` 0 / 1 / 2；ropetrail 是 `TRAILRENDERER 1` × `TRAILSUBDIVISION` 0 / 1 / 2，
  各带或不带 `TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE`；rope 与 ropetrail 再各加一组 `REFRACT`、`FOG_DIST`、`LIGHTING`（一盏点光）。

第 3 部分是**请求夹具**（P7a）：语料扫描时录下编译管线真实发给翻译器的每个请求（源码、头文件、COMBO、纹理格式、宏、`litDefines` 全在里面），测试逐个重放，覆盖全部场景实际用到的组合。
- 夹具由 `kbp corpus scan --extra requests:<目录>`（`.claude/skills/kbp-tools/SKILL.md`）写成 `<目录>/<sha1>.json`：`{ name, names, scenes, result: { ok, phase, firstError }, request }`。
  - 只留头文件补齐后的最终请求，按规范化 JSON 的 SHA-1 去重；
  - `names` 是用到这个请求的全部着色器名（同产品 `shader:<名>:…`；工坊包常把同一个 effect 拷到别的目录），`name` 是其中第一个；
  - `result` 是前端 wasm 当时的结果。
- 夹具只放在 `ignore/` 下，工坊内容不进仓库；没设 `WPESL2WGSL_REQUESTS` 时跳过这部分。
- 报告按着色器名汇总，每条失败列出翻译器返回的全部错误，写到 `CARGO_TARGET_TMPDIR/wpesl2wgsl-requests.txt`。成功的照样回读校验，导出键是 `<名字>-<sha1 前 8 位>`。
- 门槛：重放的 `ok` 必须和夹具记录的一致（wasm 与原生应当相同）。不一致时先查 wasm 是不是比翻译器源码旧。

环境变量（相对路径按仓库根解析，因为 cargo test 的工作目录是本 crate）：

| 变量 | 作用 |
|---|---|
| `WPESL2WGSL_REQUESTS` | 请求夹具目录，设了才跑第 3 部分 |
| `WPESL2WGSL_DUMP_DIR` | 每次成功翻译生成的 GLSL / WGSL 写进这个目录（`<键>.vert.glsl`、`.vert.wgsl`、`.frag.glsl`、`.frag.wgsl`），供人工审阅和建基线。WPE 安装目录部分的键是 `gate__…` / `lit__…` / `geom__…` / `base__…`，请求夹具部分是 `<名字>-<sha1 前 8 位>`，非法字符换成 `_` |
| `WPESL2WGSL_BASELINE_DIR` | 一份旧的导出目录：本次导出（只算本次写过的文件，目录里残留的旧文件不算）逐文件和它比较，报「相同 / 变了 / 新通过 / 新失败（基线有、本次没有）」，清单写到 `CARGO_TARGET_TMPDIR/wpesl2wgsl-baseline.txt`；「变了」「新失败」非空时测试失败。没设 `WPESL2WGSL_DUMP_DIR` 时导出到 `CARGO_TARGET_TMPDIR/wpesl2wgsl-dump`（先清空） |
| `WPESL2WGSL_BASELINE_ALLOW` | 逗号分隔的键前缀（按导出文件名的规则规整，`effects/foo` 与 `effects_foo` 等价）：这些「变了」「新失败」不算失败，但仍列在报告里，标「允许」 |

```bash
# 录夹具（产品源码默认 apps/wpe-scene/src，用其中的 wasm）
python -X utf8 -I .claude/skills/kbp-tools/kbp.py corpus scan --extra requests:ignore/p7/requests --out ignore/p7/out/corpus.json

# 建基线：改动前导出一份
KABEGAME_WPE_ROOT="D:\Applications\Steam\steamapps\common\wallpaper_engine" \
WPESL2WGSL_REQUESTS=ignore/p7/requests WPESL2WGSL_DUMP_DIR=ignore/p7/baseline/head-<提交前 8 位> \
CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --test corpus -- --nocapture

# 与基线比较：改动后跑；预期会变的键用 WPESL2WGSL_BASELINE_ALLOW 列出
KABEGAME_WPE_ROOT="D:\Applications\Steam\steamapps\common\wallpaper_engine" \
WPESL2WGSL_REQUESTS=ignore/p7/requests WPESL2WGSL_BASELINE_DIR=ignore/p7/baseline/head-<提交前 8 位> \
WPESL2WGSL_BASELINE_ALLOW=effects/fluidsimulation_advection \
CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --test corpus -- --nocapture
```

2026-11-11（`74b65d27`）：777 个请求、215 个着色器（含别名 255），通过 661；失败的着色器 44 个（含别名 50），比语料扫描的 48 个多两个，都是当前属性下关着的 effect（失败不上报到场景）；`ok` 与夹具全部一致；基线导出 3460 个文件，重跑逐字节相同。

2026-11-07 结果：167 对通过 158 对（94.6%），WGSL 回读失败 0；2026-11-10 加几何着色器展开后不变，几何门槛 27/27。失败的 9 对见「已知不支持」；`fur4` 在基线里失败是因为基线只绑槽 0，缺 `TEX8FORMAT`，绑了毛发图就能过（上面的门槛绑了）。

浏览器自己的 WGSL 编译器（Tint）是否接受这些输出，要在 dev app 里实测：用 `createShaderModule` + `getCompilationInfo` 跑一遍语料。见 `versions/latest/regression.md` 的场景壁纸 P1-0 节。
