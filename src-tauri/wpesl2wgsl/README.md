# wpesl2wgsl

把 Wallpaper Engine 着色器语言（WPESL，WPE 的 `shaders/*.vert|frag` 及其 `#include` 头文件）翻成 WGSL，
供场景壁纸（`x-wpe/scene`）的前端 WebGPU 渲染器使用。编成 wasm 在前端运行，**不链进应用**，应用的 Rust 代码也不依赖它。

调用方传一个材质 pass 的顶点 / 片元源码**原文**，以及头文件、COMBO 取值和绑定的纹理。预处理、改写、翻译、反射全在 crate 内部完成。

## 构建与接入

```bash
rustup target add wasm32-unknown-unknown   # 每台机器一次
deno task build:wpesl2wgsl                 # → bin/wasm/wpesl2wgsl/wpesl2wgsl.wasm（git 忽略，约 1.4 MB）
```

- 脚本是 `scripts/build-wpesl2wgsl.ts`，执行 `cargo build -p wpesl2wgsl --lib --target wasm32-unknown-unknown --profile wpesl2wgsl`。
  根 `Cargo.toml` 的 `[profile.wpesl2wgsl]` 按体积优化（`opt-level = "z"`、`lto`、`panic = "abort"`），不影响其它 crate。
  缺 wasm 目标时脚本报错，并给出 `rustup target add` 命令。
- kabegame 的 dev / start / build / check / test 不带 `--skip vue` 时，`scripts/plugins/wpesl2wgsl-plugin.ts` 在 `prepareEnv` 阶段把产物拷到
  `apps/kabegame/src/wpe-scene/wpesl2wgsl/wpesl2wgsl.wasm`（git 忽略，内容相同不重写）。找不到产物只告警，前端照常构建。
- 前端胶水 `apps/kabegame/src/wpe-scene/wpesl2wgsl/index.ts` 提供以下接口：
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
  includes?: Record<string, string>;               // `#include` 里写的名字（相对 shaders/ 根，如 "common.h"、"base/model_vertex_v1.h"）→ 源码
  combos?: Record<string, number | boolean>;       // 材质 pass 与 effect pass 的 combos，名字不分大小写
  textures?: { slot: number; format?: number }[];  // 已绑定的 g_Texture<slot> 及其 .tex 格式枚举
  defines?: Record<string, string>;                // 额外的宏，最后应用（可覆盖平台宏与 COMBO）
  debug?: boolean;                                 // 成功时也带上生成的 GLSL 450
}
```

- **头文件按需提供**：结果为 `phase: "include"` 时，读出 `missing` 里的文件、放进 `includes` 后再调一次。只有处于有效分支的 `#include` 才要求提供。
  头文件的查找顺序（项目 `shaders/` → WPE `assets/shaders/`，effect 自己的 `shaders/` 优先）由调用方决定。
- **`textures` 有两个作用**：一是采样器注释里写了 `"combo": "NORMALMAP"` 的槽位绑定了纹理时，该 COMBO 置 1；二是定义 `TEX<slot>FORMAT = format`。
  格式枚举与 WPE 一致：0 RGBA8888、1 RGB888、2 RGB565、4 DXT5、6 DXT3、7 DXT1、8 RG88、9 R8、10 RG1616F、11 R16F、12 BC7。

### 结果

成功时 `ok: true`：

| 字段 | 内容 |
|---|---|
| `vertex` / `fragment` | `{ wgsl, entryPoint, glsl? }` |
| `uniforms` | uniform 块成员：`{ name, type, declared, offset, size, array?, stride?, meta? }` |
| `uniformBlockSize` | uniform 块总字节数（没有普通 uniform 时缺省） |
| `textures` | `{ slot, name, kind: "2d" \| "2d-comparison" \| "3d" \| "cube", binding, samplerBinding, meta? }` |
| `attributes` / `varyings` | `{ name, location, type, array? }` |
| `combos` | 最终生效的 COMBO：`{ name, value, source: "default" \| "texture" \| "request" }` |

失败时 `ok: false`，带出错阶段 `phase` 和出错的 `stage`，失败那一侧的 `vertex.glsl` / `fragment.glsl` 也会给出（诊断行号指向它），另有 `errors: [{ message, file?, line?, column? }]`：

| `phase` | 含义 |
|---|---|
| `request` | 请求 JSON 无法解析，或 COMBO 值不是整数 / 布尔 |
| `include` | 缺头文件，见 `missing` |
| `require` | 用到 WPE 私有库指令 `#require`（如 `LightingV1`），见 `requires`；暂不支持 |
| `preprocess` | 条件编译不配对、`#if` 表达式错误、未知预处理指令（`file` / `line` 指向原文） |
| `rewrite` | 不支持的全局声明、两阶段类型冲突、纹理函数参数不是已声明的纹理 |
| `parse` / `validate` / `write` | naga 阶段的错误（行号指向生成的 GLSL） |
| `trap` | wasm 实例 trap（仅前端胶水产生） |

### 绑定布局（渲染器据此建 bind group layout）

- 全部资源在 group 0；两阶段声明同一份。
- binding 0：uniform 块 `KbUniforms`（std140），**顶点与片元共用一块缓冲**。成员是两阶段普通 uniform 的并集，按首次出现的顺序排列。
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

## 内部流程

源码在 `src/`：`lib.rs`（请求 / 结果、编排、C ABI）、`preprocess.rs`、`rewrite.rs`、`naga_stage.rs`。

1. **注释元数据**：不看条件分支，扫描两段源码与可达的头文件，收集 `// [COMBO] {"combo","default",…}` 声明和带注释的 `uniform sampler* g_Texture<n>; // {…}`。
2. **宏表**，后者覆盖前者：
   1. 平台宏；
   2. COMBO：声明默认 < 纹理推导 < 请求；
   3. `TEX<n>FORMAT`；
   4. 请求里的 `defines`。

   平台宏照 WPE 在 Windows 上的 HLSL 路径：
   - `HLSL=1`：`#ifdef HLSL` 块是 D3D 坐标约定下的 Y 翻转，WebGPU 的纹理 / 帧缓冲坐标与 D3D 相同；
   - `HLSL_GS40_DISABLED=1`，`GS_ENABLED` 保持未定义：WebGPU 没有几何着色器，粒子走「顶点着色器自己展开四角」的分支；
   - `HLSL_SM30`、`GLSL`、`PLATFORM_ANDROID`、`SHADERVERSION` 不定义，需要时由调用方通过 `defines` 传。

   COMBO 名按大写处理：材质里写 `version: 2`，源码里是 `VERSION`。
3. **预处理**（`preprocess.rs`）：
   - 剥离块注释，保留行号；处理行续接；`#include` 原地展开。
   - `#if / #ifdef / #ifndef / #elif / #else / #endif` 按 C 优先级求整数表达式，支持 `defined`。未定义的标识符按 0 处理：大量 COMBO 不写声明，直接 `#if MULTI`。
   - `#define` / `#undef` 行保留，交给 naga 自带的预处理器展开正文；函数宏不参与 `#if`。
   - 全局声明的数组长度如果写成宏（`g_Bones[BONECOUNT]`），按当前宏表算成数字。
   - `#require` 收集后整体报错；`#version` / `#extension` / `#pragma` 去掉。
4. **改写成 Vulkan GLSL 450**（`rewrite.rs`）：
   - **声明**：
     - 普通 uniform 并入 uniform 块，标量 / 二三分量向量的数组补成 `kb_u_<名字>`，再由 `kb_load_<名字>()` 还原、宏指回原名。这样下标访问和整个数组传参都照常可用。
     - 采样器拆成纹理 + `kb_sampler_<名字>`；`attribute` / `varying` 加 `layout(location)`。
     - 只在片元阶段声明的 varying，也给顶点阶段补一个输出。顶点阶段不写入时值为零，对应 D3D 下的未定义值；不补的话，WebGPU 建管线会失败。
     - `gl_*` 名的全局声明（几何着色器遗留的 `varying uint gl_ViewportIndex`）忽略。
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
5. **naga 30**（`naga_stage.rs`）：
   - GLSL 450 前端负责解析和隐式的 int → float 转换；
   - 按 WebGPU 基线（`Capabilities::empty()`）校验后输出 WGSL；
   - uniform 块的偏移与步长取自 naga 的 std140 布局。

   naga 30.0.1 的 `glsl-in` 依赖只在 `spv-in` / `wgsl-in` 下编译的模块，只开 `glsl-in` 编不过，所以 `Cargo.toml` 多开了 `wgsl-in`，语料测试也用它回读输出。

## 已知不支持

| 现象 | 原因 |
|---|---|
| `phase: "require"`，`LightingV1` | WPE 私有光照库指令，3D 光照阶段再做 |
| `Unknown variable: gl_ViewportIndex` | 阴影投射走的几何着色器路径 |
| `Unknown function 'rotateVec2'` 这类 | HLSL 允许 vec4 → vec2 隐式截断，GLSL 不允许；没有类型信息无法改写 |
| `varying … 在两个阶段的类型不同` | 同上（片元阶段读更少分量） |
| `Array size must be greater than zero` | `BONECOUNT` 等引擎宏未定义（骨骼蒙皮），可经 `defines` 传入 |
| `不支持的采样器类型 sampler2DBackBuffer` | 体积光专用采样器类型 |

另外，glsl-in 只认 Vulkan 语义的 GLSL 450，这正是改写这一步存在的原因；naga 的 `glsl-in` / `wgsl-out` 在其支持表里是二档（维护但测试较少）。
如果以后遇到 naga 接不住的写法，备选方案是 glslang → SPIR-V → Tint（Babylon.js 的路线）。

## 测试

```bash
# 单测（预处理、改写、naga 阶段、端到端、C ABI）
CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --lib

# 本机 WPE 语料：只读访问 WPE 安装目录，未设置环境变量时跳过
KABEGAME_WPE_ROOT="D:\Applications\Steam\steamapps\common\wallpaper_engine" \
CARGO_TARGET_DIR=target-check cargo test -p wpesl2wgsl --test corpus -- --nocapture

# 前端胶水（需要先把 wasm 拷进前端：任意不带 --skip vue 的 kabegame 命令）
deno task test -c kabegame --skip cargo
```

语料测试（`tests/corpus.rs`）分两部分：
- **门槛**：P1 样本用到的着色器对，按材质实际的 COMBO 与纹理必须翻译通过。包括 `assets/shaders/flag`（TINT=1）、`genericimage`，以及 deep_space / beach 的 `flowimage`、`swayimage`。
- **基线**：`assets/shaders`、`assets/effects`、`projects/defaultprojects` 下全部着色器对，在默认 COMBO（只绑定 g_Texture0）下的通过率；并把每份输出 WGSL 交给 naga `wgsl-in` 重新解析、校验。
  完整报告写到 `CARGO_TARGET_TMPDIR/wpesl2wgsl-corpus.txt`。

2026-11-01 结果：167 对通过 153 对（91.6%），WGSL 回读失败 0。失败的 14 对见「已知不支持」。

浏览器自己的 WGSL 编译器（Tint）是否接受这些输出，要在 dev app 里实测：用 `createShaderModule` + `getCompilationInfo` 跑一遍语料。见 `versions/latest/regression.md` 的场景壁纸 P1-0 节。
