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
| `preprocess` | `#if` 没有闭合、`#if` 里宏展开过深、未知预处理指令（`file` / `line` 指向原文） |
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
   - `#if / #ifdef / #ifndef / #elif / #else / #endif` 照 WPE 自己的预处理器（`wallpaper64.exe` 的 `FUN_14016b0e0` / `FUN_140167e10`，
     `.claude/plans/wpe-import/3-scene/phase7/rea-p7-shader.md` §2.3 与「P7b 补查」第 1、2 条），不照 C 预处理器：
     - 先做宏替换，未定义的标识符按 0（大量 COMBO 不写声明，直接 `#if MULTI`）；支持 `defined X` / `defined(X)`；函数宏在 `#if` 里按 0。
     - 32 位有符号整数，优先级同 C，**没有三元运算符**；数字是十进制或 `0x` 十六进制，小数部分与 `u` / `f` / `l` 后缀丢掉。
     - **只解析一个表达式，后面的尾随字符忽略**：`#elif AUDIOSAMPLES == 32;` 的分号、多余的右括号、单个 `=` 之后都不看；缺右括号、缺操作数、除以 0 都不报错（缺的按 0，除以 0 得 0）。
     - **栈空时的 `#else` / `#elif` / `#endif` 忽略**、不出行，后面的代码保持活跃。没闭合的 `#if` 仍报错（WPE 不报错，语料里没有）。
     - p7-sem 的 `kbsemi`（尾随分号）与 `kbtrunc`（多余的 `#endif`）在 WPE 里实测编过（`.claude/plans/wpe-import/3-scene/phase7/p7-REPORT.md`「P7b 规则的实测」）。
   - `#define` / `#undef` 行保留，交给 naga 自带的预处理器展开正文。**同名、内容不同的重定义**照 WPE / fxc 后者覆盖前者：输出里先补一行 `#undef <名>`
     再输出新定义，`#if` 也用新值（naga 对记号不同的重定义报 `DefineRedefined`）；内容相同（按记号比，只差空白）的照旧不动。
     请求的宏（COMBO 等）同样经 naga 的 `Options::defines` 进它的宏表，源码改它们的值也补 `#undef`。p7-sem 的 `kbredef` 实测后者生效。
   - 全局声明的数组长度如果写成宏（`g_Bones[BONECOUNT]`），按当前宏表算成数字。
   - `#require` 按 WPE 语义现场展开（`library.rs`）：`LightingV1` 在 `LIGHTING` 非 0 时按 `LIGHTS_*` 生成灯光 uniform 与 `PerformLighting_V1`，
     否则什么都不插；逐灯计算在公开头文件 `common_pbr_2.h`，这里只负责遍历。未知的库、阴影与 cookie 报 `phase: "require"`。
   - `#version` / `#extension` / `#pragma` 去掉。
   - 带几何段时，几何段在顶点段之后预处理，顶点段展开过的头文件只求宏、不出行（见下节第 1 条）。
4. **几何着色器展开**（`geometry.rs`，只在带几何段时）：顶点段与几何段拼成一段顶点着色器，再交给下一步，见「几何着色器展开」。
5. **改写成 Vulkan GLSL 450**（`rewrite.rs`）：
   - **声明**：
     - 普通 uniform 并入 uniform 块，标量 / 二三分量向量的数组补成 `kb_u_<名字>`，再由 `kb_load_<名字>()` 还原、宏指回原名。这样下标访问和整个数组传参都照常可用。
     - 声明名后带分量（`varying vec4 v_Size.xy;`）照 WPE 当成不带分量的同名声明：WPE 的声明正则 `(\w+)\s+<类型>\s+(\w+)(\[…\])?` 在 `.` 处停下，
       `uniform` / `varying` 都只取名字；`attribute` 按整词找属性名，同样只认名字（rea「P7b 补查」第 3 条，p7-sem 的 `kbswz` 实测）。分量后还有别的内容的照旧报错。
       两阶段同名、取值来源不同的拆成两格，一侧改名为 `kb_vs_` / `kb_fs_<名字>`，见「两阶段同名 uniform」。
     - 采样器拆成纹理 + `kb_sampler_<名字>`；`attribute` / `varying` 加 `layout(location)`。
     - 只在片元阶段声明的 varying，也给顶点阶段补一个输出。顶点阶段不写入时值为零，对应 D3D 下的未定义值；不补的话，WebGPU 建管线会失败。
     - 两阶段都声明、类型不同的 varying（不论哪边宽），片元按顶点的类型声明，见「HLSL 隐式转换」。
     - 全局 `const` 的初始值引用运行期值时改成私有全局、在 `main` 开头赋值，见「HLSL 隐式转换」。
     - `gl_*` 名的全局声明（几何着色器遗留的 `varying uint gl_ViewportIndex`、fur4 的 `in uint gl_InstanceID`）忽略。
   - **`main` 之前的打包数组**（`src/pack.rs`）：WPE 把 `float` / `vec2` / `int` / `uint` 数组 uniform 在常量缓冲里声明成 `float4` / `int4` / `uint4`、长度 `ceil(n/4)`，
     只有 `main` 签名之后的文本换成拆包后的 `float[n]`；`main` 之前（全局辅助函数、文件顶部的 `#define`）看到的是打包形态（rea「accessArray 的适用条件」、「P7b 补查」第 4 条）。
     - `main` 签名照 WPE 的正则 `\bvoid\s+main\s*\(\s*\)\s*\{` 认第一处；认不出（`main(void)`）的不做。
     - 签名之前对 `float` / `int` / `uint` 数组的下标访问 `X[e]` 改成 `kb_pack_X(e)`，返回第 `e` 行（`vec4` / `ivec4` / `uvec4`，第 k 行是原数组 4k…4k+3 号元素，不足补 0）。
       `X[i/4][i%4]` 是第 i 个元素，`X[i]` 是整行。`main` 里照旧是 `kb_load_X()`。
     - **越界**照 D3D11 实测（p7-sem 的 `kbpack`）：读同一常量缓冲里按本阶段声明顺序排在后面（或前面）的成员，出了整个常量缓冲是 0。
       所以按 HLSL cbuffer 默认打包规则复刻本阶段的 `g_bufStatic` / `g_bufDynamic`（成员不跨 16 字节，数组与矩阵从寄存器边界开始、元素步长 16；
       矩阵 column_major，寄存器 j 的分量 c 是 GLSL 的 `M[c][j]`；类型不同的分量按位重解释），生成一串常量下标的分支。
       分流按名字：内置名表（`pack.rs` 的 `ENGINE_UNIFORMS`，`wallpaper64.exe` 2.8.42，140 项）之外的、以及 `g_TexelSizeHalf` `g_TexelSize` `g_Screen`
       `g_TextureReductionScale` `g_HDRParams` 进 static，`g_Texture0`–`9`、`g_Bones`、`g_L*` 灯光不在这两个缓冲里，其余进 dynamic。
       WPE 声明正则不认的类型（`mat2`、`ivec2`、`bool`……）不进布局。
     - 只有签名之前下标访问了这类数组的着色器才生成 `kb_pack_*`，其余输出逐字节不变；几何展开拼成的顶点段不做（绳着色器没有这类数组）。
     - `vec2` 数组 WPE 也只给 `4·ceil(n/4)` 个分量（装不下），语料没有实例，不做；签名之前不带下标地用到（整体传参、`#define SPEC X`）的照旧是还原后的数组。
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
   - GLSL 450 前端负责解析和隐式类型转换：打开了嵌入 naga 的 HLSL 模式（`Options::hlsl_implicit`），GLSL 会报错的地方按 fxc 的隐式规则转换，见「HLSL 隐式转换」；
   - 按 WebGPU 基线（`Capabilities::empty()`）校验后输出 WGSL；
   - uniform 块的偏移与步长取自 naga 的 std140 布局。

   naga 30.0.1 的源码嵌在 `naga/`（路径依赖），删掉了用不到的前后端，只开 `glsl-in` + `wgsl-out`；`wgsl-in` 只在 `[dev-dependencies]` 里开，给测试回读输出。
   上游版本、删掉的模块与每处改动见 [naga/KABEGAME.md](naga/KABEGAME.md)。
   嵌入的 naga 带了行为补丁（KABEGAME.md「行为补丁」）：B1 在 GLSL 前端裁掉 `return` / `break` 等之后的死代码前，把其中用户函数调用的结果换成同类型零值，
   否则死代码里的 `kb_min` / `kb_max` 调用会让校验报 `Expression not visited by the appropriate statement`（`fluidsimulation_advection`）；
   B2 让声明列表的数组后缀只属于所在的声明符；B3–B10 是 HLSL 模式。

## HLSL 隐式转换

WPE 在 Windows 上把着色器交给 fxc 编译，作者照 HLSL 的隐式转换写：宽向量赋给窄的、`if (float)`、`mix(vec4, vec3, float)`、片元改写 varying 等。
GLSL 不接受这些写法。翻译器打开嵌入 naga 的 **HLSL 模式**（`naga_stage.rs` 的 `options.hlsl_implicit = true`），前端在 GLSL 本来会报错的地方改按 fxc 的规则转换；
另有两条规则在改写阶段做。规则都按实测定：本机 fxc（WPE 自带的 `d3dcompiler_47.dll`）编译、反汇编，WPE 抓帧（`p7-sem` 的 `kbconv1–4`、`kbwidth`），
见 `.claude/plans/wpe-import/3-scene/phase7/p7-REPORT.md`「fxc 的隐式规则」「P7c 规则的实测」。

**naga 前端**（落点与单测见 [naga/KABEGAME.md](naga/KABEGAME.md)「HLSL 隐式转换模式」）：

| 写法 | 规则 |
|---|---|
| 赋值、复合赋值、初始化、`return`、实参：宽向量给窄的 | 取前几个分量（fxc 警告 X3206）；窄给宽照旧报错 |
| 同上：标量给向量 / 向量给标量 | 铺满 / 取 `.x` |
| 同上：分量类型不同 | `float → int` 向零截断（WGSL `i32(f)`）；`bool` 转数值为 0 / 1 |
| 不同宽度的向量做算术、位运算 | 宽的一边截到窄的；比较运算不截（HLSL 得 bvec，语义不同，照旧报错） |
| `if` / `while` / `do` / `for` / `?:` 的条件、`!`、`&&` / `\|\|` 的操作数是非布尔标量 | `x != 0`；向量条件照旧报错（`if (float2)` fxc 报 X3019） |
| 浮点下标 | 转 `u32`（fxc 的 `ftou`，向零截断、负数为 0） |
| `bool` 参与 `+ - * / %` | 按 0 / 1 |
| 标量的分量访问 `f.x`、`f.xx` | 一个分量是它自己，多个铺满 |
| 片元写 varying | 输入可写 |
| 函数调用的实参类型对不上 | GLSL 规则选不出重载时才走第二遍，所以原来能选出的调用不变。用户函数只有一个重载能经隐式转换匹配才选它，多个报二义（fxc X3067）；内置函数，以及我们代替内置函数补的 `kb_pow` / `kb_min` / `kb_max`（`broadcast_helpers`）、`kb_gs_normalize`（`naga_stage::INTRINSIC_WRAPPERS`，经 `Options::hlsl_intrinsics` 传给前端），按代价取截掉分量最少的：维度取最窄的向量实参、标量铺满（`mix(vec4, vec3, float)` 取三维，`pow(float, vec3)` 取三维）；带 `depth` 形参的候选不参与 |

不做、照旧报错（语料里没有，以后遇到样本再补）：矩阵截断与铺满、`out` 实参截断、向量比较的 bvec 语义、`%` 与比较运算的向量 ⊕ 标量铺满、向量当 `?:` 的条件、两边都是 `bool` 的算术、
标量取下标（fxc 也报错 X3121）。

**改写阶段**（`rewrite.rs`）：
- **片元的 varying 按顶点的类型声明**：WPE 两阶段只有一份 `VS_OUTPUT`，片元自己的 varying 声明作废（rea-p7-shader §2.6；`kbwidth` 实测片元声明 `vec2` 也能读顶点写的 `.zw`）。
  两阶段类型不同时不论哪边宽，片元都按顶点的类型声明，正文里的截断交给 HLSL 模式；片元读了顶点没有的分量时 naga 照常报错（`Invalid swizzle`），与 fxc 一致。
  反射里的 `varyings` 也是顶点的类型。只在片元自己声明、顶点没有的 varying 照旧按片元的类型（顶点补的输出是零）。
- **全局 `const` 现算**：WPE 给每个以 `const` 开头的行前面插 `static `，fxc 接受初始值不是常量的 `static const`，每次调用现算（`ignore/p7/fxc/c4.hlsl`）；
  naga 要求全局 `const` 的初始值是常量表达式（工坊 `radial_blur`：`const float strength = -u_strength * 0.1 / u_samples;`）。初始值引用本阶段的 uniform / attribute / varying、
  `gl_*` 内建、`kb_pack_*` 或已改写的这类 const 时，改成私有全局 `T 名;`，在 `main` 的 `{` 之后按声明顺序赋值（行数不变）。`main` 与它调用的辅助函数读到的都是这次调用的值。
  只认一个声明符的 `const T 名[数组]? = 初始值;`、写在 `main` 签名之前、认得出 `main`（`void main() {`）的；常量初始值的 const 与局部 const 不动。

每条规则只在 GLSL 本来会报错的地方生效：开关打开后，原来能翻译的着色器输出逐字节不变（P7c 对 `p7b-e2345b19` 基线验证，见「测试」）。

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
   只看语句开头的写法，不碰 `const`、for 头、多个声明符、普通变量的再赋值和分量赋值。这条早于 naga 的 HLSL 模式（见「HLSL 隐式转换」），
   现在已经多余，但去掉会改变绳着色器的输出，留着；顶点 / 片元段的隐式截断都交给 HLSL 模式。
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

9. **`out` 实参的指针别名**：几何段里同一个 `PS_INPUT` 变量的两个以上字段同时作为 `out` / `inout` 实参传给同一个函数时
   （`.geom` 带 `REFRACT` 的 `ComputeScreenRefractionTangents(…, v.v_ScreenCoord, v.v_ScreenTangents)`），改成先传临时变量、调用后拷回字段：
   `{ vec3 kb_gs_alias0; vec4 kb_gs_alias1; F(…, kb_gs_alias0, kb_gs_alias1); v.v_ScreenCoord = kb_gs_alias0; v.v_ScreenTangents = kb_gs_alias1; }`
   （`inout` 的临时变量从字段初始化）。naga 把 `out` 参数写成指针，Tint 按根变量判别名、拒绝 `invalid aliased pointer argument`（P7a 步骤 2 发现）。
   参数方向从顶点段与几何段的函数定义查；只改写成一条语句、实参正好是 `<变量>.<字段>` 的调用，在第 6 条之后做。

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
  例外：夹具是改动前录的，改动让某些请求从失败变成通过时，键在 `WPESL2WGSL_BASELINE_ALLOW` 里的只列出、标「允许」，不算失败；反方向（通过变失败）要列在单独的 `WPESL2WGSL_BASELINE_ALLOW_REGRESS` 里才不算失败。

环境变量（相对路径按仓库根解析，因为 cargo test 的工作目录是本 crate）：

| 变量 | 作用 |
|---|---|
| `WPESL2WGSL_REQUESTS` | 请求夹具目录，设了才跑第 3 部分 |
| `WPESL2WGSL_DUMP_DIR` | 每次成功翻译生成的 GLSL / WGSL 写进这个目录（`<键>.vert.glsl`、`.vert.wgsl`、`.frag.glsl`、`.frag.wgsl`），供人工审阅和建基线。WPE 安装目录部分的键是 `gate__…` / `lit__…` / `geom__…` / `base__…`，请求夹具部分是 `<名字>-<sha1 前 8 位>`，非法字符换成 `_` |
| `WPESL2WGSL_BASELINE_DIR` | 一份旧的导出目录：本次导出（只算本次写过的文件，目录里残留的旧文件不算）逐文件和它比较，报「相同 / 变了 / 新通过 / 新失败（基线有、本次没有）」，清单写到 `CARGO_TARGET_TMPDIR/wpesl2wgsl-baseline.txt`；「变了」「新失败」非空时测试失败。没设 `WPESL2WGSL_DUMP_DIR` 时导出到 `CARGO_TARGET_TMPDIR/wpesl2wgsl-dump`（先清空） |
| `WPESL2WGSL_BASELINE_ALLOW` | 逗号分隔的键前缀（按导出文件名的规则规整，`effects/foo` 与 `effects_foo` 等价）：这些「变了」「新失败」，以及请求夹具里「夹具失败、重放通过」的，不算失败，但仍列在报告里，标「允许」 |
| `WPESL2WGSL_BASELINE_ALLOW_REGRESS` | 同样格式：请求夹具里「夹具通过、重放失败」的预期退步。和上一个分开，退步必须刻意列出（P7b 起：照 WPE 改规则后，有的着色器要等后续步骤才能再通过） |

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

2026-11-11（P7a 步骤 4，行为补丁 B1）：对 `head-74b65d27` 基线相同 3460、变了 0、新失败 0，新通过只有 `effects/fluidsimulation_advection` 的两个请求（`3d4bb453`、`61464738`，各 4 个文件）；夹具部分通过 663、失败的着色器 43 个（含别名 49），这两个请求与夹具记录不一致（夹具失败、重放通过，在 ALLOW 里）；WPE 安装目录部分仍是 158/167（advection 在默认 COMBO 下本来就通过）。

2026-11-12（P7c 步骤 1–3，HLSL 模式 B2–B10 与改写阶段两条）：对 `p7b-e2345b19` 基线相同 3572、变了 0、新失败 0，新通过 372 个文件（导出 `ignore/p7/baseline/p7c-final`，
新通过的 WGSL 另拷在 `p7c-new`）；请求夹具 779 个全部通过（P7b 之后是 689），新通过的 90 个请求清单在 `ignore/p7/out/p7c-steps.txt`；WPE 安装目录 158 → 161/167
（`effects/shimmer`、`shaders/editorpaintbrush`、`effects/glitter_prepare`），剩下 6 对是 `gl_ViewportIndex` ×3、`fur4` 基线没绑槽 8、`puppettexturechannels` 数组长度 0、
`volumetricsfront` 的 `sampler2DBackBuffer`，都与 HLSL 隐式转换无关；几何门槛 27/27；WGSL 回读失败 0。

2026-11-07 结果：167 对通过 158 对（94.6%），WGSL 回读失败 0；2026-11-10 加几何着色器展开后不变，几何门槛 27/27。失败的 9 对见「已知不支持」；`fur4` 在基线里失败是因为基线只绑槽 0，缺 `TEX8FORMAT`，绑了毛发图就能过（上面的门槛绑了）。

浏览器自己的 WGSL 编译器（Tint）是否接受这些输出，要在 dev app 里实测：用 `createShaderModule` + `getCompilationInfo` 跑一遍语料。见 `versions/latest/regression.md` 的场景壁纸 P1-0 节。
