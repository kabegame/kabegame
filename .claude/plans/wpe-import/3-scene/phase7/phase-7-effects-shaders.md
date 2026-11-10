# P7 — effect 与着色器补全（总计划）

> 上级：[PLAN.md](../PLAN.md)「P7 — effect 与着色器补全」。前置：无（改的是 Rust 翻译器 `src-tauri/wpesl2wgsl`，不碰场景渲染器的共享文件，可以和 P4–P6 并行，2026-11-11 用户）。
> 本文件只定目标、分节和验收；各节动工前另写子计划，步骤 0 先读码再实测。
> 统计基于 HEAD `47486b72` 的语料扫描（`ignore/p6/out/corpus-new.json`，165 个工程，能渲染 35 张）。
> P7 的分类与解锁数：`ignore/p7/ana_p7.py`（P4–P6 的键沿用 `ignore/p6/ana_phases.py`）。退回的 48 个着色器源码：`ignore/p7/extract_shaders.py` → `ignore/p7/src/`，键与场景的对应在 `ignore/p7/out/shaders.json`。
> 读码依据：[RESEARCH.md](../RESEARCH.md)「shader 方言是什么」与「shader 编译」两节，[p3-script-REPORT](../phase3/p3-script-REPORT.md) 里 `D3DCompile` 的调用点，[翻译器 README](../../../../../src-tauri/wpesl2wgsl/README.md)。

## 总体设计思路

WPE 在 Windows 上不直接编译作者写的着色器。它先用内嵌的宏头（`#define vec2 float2`、`#define texSample2D(s,u) s.Sample(…)` 等）加模板，把方言转成 HLSL，再交给 `d3dcompiler_47.dll` 的 `D3DCompile`（`vs_5_0` / `ps_5_0`）。所以作者写下的代码，最终按 HLSL 的规则编译：
- 宽向量赋给窄向量时取前几个分量；
- 标量可以铺满成向量；
- 不同宽度的向量混算时截到较窄的一边；
- `float` 可以直接当 `if` 条件；
- 片元着色器可以改写自己的输入。

我们的翻译器把方言改写成 Vulkan GLSL 450，再交给 naga。GLSL 不允许上面这些写法。作者只在 WPE 里测过，所以 WPE 能编过、我们拒绝的着色器，几乎全是这类差异。

165 张语料里，65 张因为 P7 的键退回，涉及 48 个着色器（多为工坊 effect）。步骤 0 实测（[p7-REPORT](p7-REPORT.md)）：能在抓帧里认出来的 41 个在 WPE 里都正常编译，35 张代表场景没有一次编译失败回退。按根因分成两类，做法不同（2026-11-11 步骤 0 后改定）：
- **规则类**（34 张用到）：不需要类型信息，预处理或改写阶段就能处理，都照 WPE 自己的文本处理：
  - 栈空时多余的 `#endif` 忽略，`#if` 表达式后的尾随字符（`#elif AUDIOSAMPLES == 32;`），同名宏重定义；
  - varying 名后面带分量（`varying vec4 v_Size.xy;`），WPE 当成 `vec4 v_Size`；
  - `main` 之前引用 `float` 数组 uniform 时是打包形态 `vec4[n/4]`（WPE 只替换 `main` 之后的名字）。
- **类型类**（48 张用到）：要知道表达式的类型才能补转换。比如 `vec3 * vec4`、`mix(vec4, vec3, float)`，以及把 `vec4` 当坐标传给 `texSample2D`（naga 报 `Unknown function 'texture'`，`texture` 是我们改写出来的调用）。这类改写规则做不到。
  - 两个阶段的 varying 宽度不同也在这里：WPE 的片元直接用顶点那份声明（实测片元声明 `vec2` 也能读 `.zw`），所以改写阶段把片元的声明换成顶点的类型，正文里的截断交给 HLSL 模式。
  - 片元改写 varying：HLSL 里输入可写，HLSL 模式下 naga 里一行。原计划在改写阶段造私有副本，不再需要。

类型类的做法是 **把 naga 的源码嵌进翻译器，给它的 GLSL 前端加一个「HLSL 隐式转换」模式**（2026-11-11 用户定）。naga 的 GLSL 前端在降到 IR 时已经算出每个表达式的类型，现在只做 int → float 这一种隐式转换。在同一处按 HLSL 的规则补上截断、铺满、混算截短、条件转布尔，改动集中在前端的转换函数里。
- naga 在本仓库只有翻译器一个使用方（`Cargo.lock` 里只有 `wpesl2wgsl` 依赖它），嵌进来不影响别的 crate。
- 嵌入时顺便删掉用不到的翻译模块：只留 GLSL 前端、WGSL 后端、WGSL 前端（语料测试回读），以及 IR、校验和它们依赖的处理模块。
- 嵌入本身不改行为，放在 P7a，用逐字节基线验证；HLSL 隐式转换在 P7c 做。

另外两条路都不选：
- 自己写一个带类型的 GLSL 前处理：等于重写一个前端。
- 照 WPE 生成 HLSL，再经 DXC 或 glslang 转 SPIR-V、转 WGSL：换掉整条已经稳定的管线，uniform 布局要从 std140 改成 cbuffer 规则，wasm 体积也大得多。

每类写法在 fxc 下的确切语义已由步骤 0 查清：WPE 的宏头与模板逐字取出（[rea-p7-shader](rea-p7-shader.md)），再用本机的 fxc 编译、反汇编（[p7-REPORT](p7-REPORT.md)「fxc 的隐式规则」）。naga 原型（[naga-p7-frontend](naga-p7-frontend.md)）约 +200 行，类型类的失败语料除标量取下标（已改归规则类）外全部通过，开关关闭时输出逐字节不变。

还有两项不是着色器：
- **`fluidsimulation`**：WPE 自带的流体 effect。effect JSON 里有按 COMBO 选的 pass / fbo（`conditions`）、经脚本触发的 `functions`、effect 级 `combos`，模拟 RT 要跨帧保留。语料只有 1 张，而且这张还挡着 P4–P6、P8、P11 的十几个键。所以排在最后，P7 做不做完不影响解锁数。
- **`editable`**：推断是编辑器键，按中性放开。

关键决策沿用 P4–P6：
- WPE 语义以读码加实测为准。
- 能力表是唯一事实来源，没实现的照报。
- 验收和 WPE 比，不和作者的预览图比。

P7 另加一条：**现在能翻译的着色器，输出逐字节不变**。翻译器的 wasm 被所有会话的 dev 共用；输出不变，P7 和 P4–P6 就不会互相干扰。

## 范围与覆盖

| 节 | 内容 | 用到 | 只做 P7 时累计能渲染 | P4–P6 先做完时累计 |
|---|---|---|---|---|
| P7a 语料、基线与嵌入 naga | 工坊着色器进翻译器语料测试；改动前后逐字节比；Tint 接受度；嵌入并裁剪 naga | — | 35 | 56 |
| P7b 规则类 | 预处理照 WPE、varying 名带分量、`main` 之前的打包数组、`editable` | 34 | 35 | 58 |
| P7c 类型类 | naga 加 HLSL 隐式转换、片元 varying 按顶点类型、输入可写 | 48 | 37 | 65 |
| P7d 流体 | `fluidsimulation` 的 effect 字段与着色器 | 1 | 37 | 65 |

口径：
- 「用到」是报这一节任一键的场景数，一张场景可以同时在几节里。
- 「累计」按表的顺序依次去掉各节的键，数 `unsupported` 为空的场景。P4–P6 先做完的口径同 PLAN.md「P6 之后的分节」（起点 56）。
- 语料扫描对每个着色器只报**第一个**错误。修掉第一个以后可能露出下一个，而且可能属于另一类。所以归类以第一个错误为准，「用到」是下限意义上的估计，见风险 1。

解锁明细：
- **只做 P7：** P7c 解锁 `3822495444`、`3831518461`。
- **P4–P6 先做完：**
  - P7b 解锁 `3498150384`、`3815289650`；
  - P7c 解锁 `2981249186`、`3451555874`、`3502090109`、`3822495444`、`3824424509`、`3831518461`、`3832004152`。

只差 P7 的 9 张里，7 张卡在类型类。P7c 是解锁的主体。（步骤 0 后重算：varying 宽度、片元写 varying 移到 P7c，标量取下标、宏重定义移到 P7b。）

根因明细（每个着色器按第一个错误归类）：

| 类 | 场景 | 着色器 | 例子 |
|---|---|---|---|
| 多余的 `#endif` | 29 | 7 | `Simple_Audio_Bars`（6 个版本，21 张）的顶点着色器多一个 `#endif` |
| `#if` 里的分号 | 1 | 1 | `simple_gradient_audio_bar`：`#elif AUDIOSAMPLES == 32;` |
| varying 两阶段宽度不同 | 20 | 9 | `color_grading`：顶点 `vec4 v_TexCoord`、片元 `vec2`；WPE 自带的 `effects/glitter_prepare` 也是 |
| varying 名带分量 | 1 | 3 | `frame_builder`：`varying vec4 v_Size.xy;` |
| 片元改写 varying | 6 | 2 | `geometric_transform`：`v_TexCoord.y += …`（naga 报 `Variable cannot be used in LHS position`） |
| 类型不匹配 | 22 | 15 | `Simple_Audio_Bars` 旧版、`gaussian`、`lens_flare_sun`、`pixelate`：不同宽度混算、宽赋窄 |
| 实参截断 | 5 | 4 | `hue_shift`：`mix(albedo, newAlbedo, mask)` 赋给 `.rgb`；`shimmer`（含 WPE 自带）：`rotateVec2(v_TexCoord, …)`，`v_TexCoord` 是 `vec4` |
| 纹理坐标截断 | 5 | 3 | `fxaa`、`clipping_mask`、`chromatic_aberration`：`texSample2D(g_Texture0, v_TexCoord)`，`v_TexCoord` 是 `vec4` |
| 非布尔条件 | 2 | 1 | `frame_builder_by_gariam` |
| 标量取下标 | 2 | 1 | `video`：`main` 之前的辅助函数里写 `g_AudioSpectrum64Left[barID / 4][barID % 4]`，WPE 那里是打包的 `float4[16]`（规则类） |
| 流体 | 1 | 1 | `effects/fluidsimulation_advection`（naga：`Expression not visited by the appropriate statement`）与 effect JSON 的 4 个键 |
| 宏重定义 | 1 | 1 | 工坊 `audio`（`3577764342`）：同名宏定义两次，naga 报 `DefineRedefined`（规则类）。几个宏的值被换成了 `bc1` 开头的长串，但这张场景用不到它们，WPE 照常编过 |

「纹理坐标截断」也可以在改写阶段用重载包装处理（见 P7c）。

**P7 不做，继续报不支持：**
- effect pass 上的 `usertextures`（`blendgradient` 11 张、`blend` 5、`clipping_mask` 3、`xray` 1）：用户自选纹理，P11。
- `#require LightingV1` 的阴影与 cookie、`gl_ViewportIndex`、`sampler2DBackBuffer`：P13。
- 骨骼的 `BONECOUNT`：P12。

## 现状锚点

行号按 HEAD `14bdbf99`。

**a. 翻译失败就报 `shader:<名>:<阶段>:<第一条错误>`**（`apps/wpe-scene/src/compile/shader.ts:205`）
```ts
    if (!result.ok) {
      const detail =
        result.requires?.[0] ?? result.missing?.[0] ?? result.errors?.[0]?.message?.replace(/\s+/g, " ").slice(0, 100);
      issues.push(`shader:${shader}:${result.phase ?? "unknown"}${detail ? `:${detail}` : ""}`); // 现状：只带第一条错误
```

**b. 预处理遇到多余的 `#endif` 直接失败**（`src-tauri/wpesl2wgsl/src/preprocess.rs:150`）
```rust
                    "endif" => {
                        if stack.pop().is_none() {
                            return Err(fail("#endif 没有对应的 #if".into())); // 现状：WPE 怎么处理未知
                        }
                    }
```

**c. 两个阶段的 varying 类型必须相同**（`src-tauri/wpesl2wgsl/src/rewrite.rs:294`）
```rust
                Storage::Varying => match varyings.iter().find(|v| v.name == decl.name) {
                    Some(existing) if existing.ty != decl.ty || existing.array != decl.array => {
                        return Err(fail(format!("varying {} 在两个阶段的类型不同", decl.name))); // 现状：宽度不同也拒绝
                    }
```

**d. 隐式转换只在几何段做，而且只按语句开头的写法**（README「几何着色器展开」第 6 条）：局部声明的初始值与 `PS_INPUT` 字段的整体赋值包一层 `kb_gs_as_<类型>(…)`，按实参类型重载。顶点、片元段不做。README「已知不支持」把 `rotateVec2`、varying 宽度不同列为「没有类型信息无法改写」。

**e. naga 从 crates.io 来，只有翻译器用**（`src-tauri/wpesl2wgsl/Cargo.toml`）
```toml
naga = { version = "30", default-features = false, features = ["glsl-in", "wgsl-in", "wgsl-out"] } # 现状：30.0.1，无补丁
```

**f. effect JSON 的字段白名单**（`apps/wpe-scene/src/compile/features.ts:554`–`:567`）
```ts
  for (const [key, value] of Object.entries(effect))
    if (!SUPPORTED_EFFECT.has(key) && active(value)) unsupported.add(`effect:${label}:${key}`); // 现状：combos、functions、editable 报这里
  // …
      if (!SUPPORTED_FBO.has(key) && active(value)) unsupported.add(`effect:${label}:fbo:${key}`); // fbo 的 conditions
  // …
      if (!SUPPORTED_EFFECT_PASS.has(key) && active(value)) unsupported.add(`effect:${label}:pass:${key}`); // pass 的 conditions
```

**g. 语料测试只看 WPE 安装目录**（README「测试」）：`assets/shaders`、`assets/effects`、`projects/defaultprojects`，默认 COMBO，2026-11-07 为 167 对通过 158 对。工坊 `scene.pkg` 里的着色器不在里面（原 W1 前置）。

## 与 PLAN.md 的差异

1. **varying 宽度不同：** PLAN 和 README 都把它算作要类型信息，这一点步骤 0 证实了：WPE 的片元用顶点那份声明，正文的截断要类型信息，归 P7c。
2. **类型类的做法定为改 naga 的 GLSL 前端：** PLAN 写「要么扩展翻译器，要么在 naga 的 IR 上处理」。用户 2026-11-11 定：naga 源码嵌进翻译器，顺便删掉用不到的翻译模块。
3. **WPE 自己也编不过的情况：** 总计划原以为至少 1 个着色器源码坏了、WPE 也编不过。步骤 0 实测这张照常编过，语料里没有 WPE 回退的着色器，所以不复刻回退；以后遇到再按「日志 + 暗红」复刻。
4. **加「现在能翻译的输出逐字节不变」的约束：** 翻译器 wasm 被各会话共用，这是 P7 能和 P4–P6 并行的前提。

## 步骤 0 — 调研（整节一次）

**读码**（交给代理，REA 看 `wallpaper64.exe`）：
- **宏头与模板**：方言转 HLSL 的宏头逐字取出，模板怎么生成 `cbuffer`、`VS_INPUT` / `VS_OUTPUT` / `PS_INPUT`、`main`；作者源码进 HLSL 之前 WPE 自己做哪些文本处理（COMBO 的 `#define` 插在哪、`#include` 谁展开、注释与 `#if` 是否先处理）。
- **编译参数**：`D3DCompile` 的 flags（优化级别、`ENABLE_BACKWARDS_COMPATIBILITY`、`WARNINGS_ARE_ERRORS` 等）。
- **失败处理**：编译失败后是用 `dx11fallback`、跳过这个 pass，还是整个图层不画；日志写什么。

**实测：**
- **哪些在 WPE 里编得过：** 48 个着色器逐个看 WPE 日志与 `blobsSM40` 缓存。工坊场景只读，不能删缓存；需要时用 kbp gen 造只含该 effect 的测试工程。重点是多余的 `#endif` 和 `bc1…` 那张。
- **fxc 的确切语义：** 用取出的宏头把这 48 个着色器在本机转成 HLSL，交给本机 `d3dcompiler_47.dll` 编译、`D3DDisassemble` 反汇编，确认每类写法的结果：
  - 截断取哪几个分量；
  - 混算时截到哪边、警告还是错误；
  - `float` 条件是 `!= 0`；
  - 标量取下标的结果；
  - `float` → `int` 是截断还是取整；
  - 内置函数实参宽度不一时，按谁对齐。

  这一步不用跑 WPE，和抓帧互不干扰。
- **naga：** 读 naga 30.0.1 `front/glsl` 的隐式转换与重载解析，估改动范围，列出要碰的函数；列出嵌入时能删的模块、feature 与依赖。
- **Tint：** 现在能翻译的全部语料输出在 dev app 里 `createShaderModule` + `getCompilationInfo` 一遍（P1-0 的方法），作为 P7 改动前的基线。

**产出：** `rea-p7-shader.md`（读码）、`p7-REPORT.md`（实测，每类写法一节）、子计划的步骤 0 实施记录。

## P7a — 语料与基线

子计划见 [phase-7a-corpus-naga.md](phase-7a-corpus-naga.md)：请求夹具与逐字节基线 → Tint 基线 → 嵌入 naga（不改行为）→ 死代码 `CallResult` 补丁。

- **工坊语料：** 从全部场景的编译过程导出「着色器 × 实际 COMBO × 绑定的纹理」（含 pkg 里的工坊着色器与它们 include 的头文件），存成语料夹具。翻译器的语料测试读夹具，和现在的 WPE 安装目录语料一起跑。夹具在 `ignore/` 下按需生成，测试没有夹具时跳过（同 `KABEGAME_WPE_ROOT` 的约定），不把工坊内容拷进仓库。
- **逐字节基线：** 改动前用 `WPESL2WGSL_DUMP_DIR` 导出全部成功翻译的 GLSL / WGSL，之后每步对比：已经通过的输出不变，除非这一步本来就要改它，并逐项说明。
- **完整错误：** 语料测试的报告列出每个着色器的全部错误，而不只是第一条，作为后面各步的进度表。
- **嵌入 naga**（基线建好之后做）：
  - naga 30.0.1 的源码放进翻译器目录（`src-tauri/wpesl2wgsl/naga/`），作为翻译器的路径依赖。上游代码保持原样的模块路径，方便以后和上游逐文件比；我们的改动另记在同目录的说明里（上游版本、删掉了哪些模块、每处补丁的理由）。保留上游的许可证文件。
  - 删掉用不到的模块：SPIR-V / MSL / HLSL / GLSL / dot 后端、SPIR-V 前端，以及只为它们存在的 feature 与依赖。留下 GLSL 前端、WGSL 后端、WGSL 前端（语料测试回读）、IR、校验、`proc` 等。
  - 上游「只开 `glsl-in` 编不过、要多开 `wgsl-in`」的问题顺手修掉（`front/mod.rs` 里 `interpolator` 的 cfg 漏了 `glsl-in`，一行），WGSL 前端改成只在测试里用。
  - 第一个行为补丁：前端裁掉 `return` 之后的死代码前，把 `Call` / `Atomic` 的结果表达式改成同类型的 `ZeroValue`（naga-p7-frontend 第 3 节，约 +43 行）。它修好 `fluidsimulation_advection`，原型实测其余输出不变；单独一个提交，过逐字节基线。
  - `naga-types` 等 naga 自己拆出去的小 crate 跟着嵌入还是继续从 crates.io 取，看它们的体积和改动需要，子计划里定。
  - 这一步不改任何行为。

**验收：**
- 语料测试包含工坊着色器，报告的失败数和语料扫描的 48 个对得上；基线导出可复现。
- 嵌入 naga 前后，全部语料输出逐字节不变，单测全过；wasm 体积前后对比写进实施记录。

## P7b — 规则类

子计划见 [phase-7b-rules.md](phase-7b-rules.md)：步骤 0 调研 → 预处理三条 → 声明名带分量 → `main` 之前的打包数组 → 几何展开的指针别名 → `editable`。

**实现**（`preprocess.rs`、`rewrite.rs`，照 WPE 自己的文本处理，rea-p7-shader 2.x）：
- **预处理：**
  - 栈空时多余的 `#endif` 忽略（WPE 的预处理器就是这样，fxc 看不到它）。
  - `#if` 表达式后的尾随字符（`#elif AUDIOSAMPLES == 32;`）：照 WPE 求值器 `FUN_140167e10` 的规则，子计划步骤 0 查清（WPE 实测能编过）。
  - 同名宏可以重定义：现在交给 naga 的预处理器会报 `DefineRedefined`。在我们的预处理里展开宏，或在嵌入的 naga 里改成后者覆盖前者，子计划定。
- **varying 名带分量：** `varying vec4 v_Size.xy;` 当成 `vec4 v_Size`（WPE 的正则只取到名字）。
- **`main` 之前的打包数组：** `float` / `vec2` / `int` / `uint` 数组 uniform，WPE 在 cbuffer 里声明成 `float4[ceil(n/4)]` 等，`main` 之前的文本看到的是这个打包形态，`main` 里才拆成 `float[n]`。`main` 之前引用这类数组时照这个规则改名（`video` 的 `[i / 4][i % 4]`）。uniform 的内存布局要不要随之改成 WPE 的打包，子计划定；没有在 `main` 之前引用的不改，保证逐字节不变。
- **`editable`：** 能力表放开，依据写进注释。
- **几何段展开的指针别名（P7a 步骤 2 的 Tint 基线发现）：** `rope` / `ropetrail` 带 `REFRACT` 时，`ComputeScreenRefractionTangents` 收到同一个 `PS_INPUT` 变量两个字段的指针，Tint 报 `invalid aliased pointer argument`（naga 不查）。语料里还没有场景用到这个组合。改成先写进两个临时变量、调用后再拷回字段；只动带 `REFRACT` 的几何展开，其余输出逐字节不变。

**验收：**
- 语料测试中这几类着色器通过、回读通过，其余输出逐字节不变。
- 每类一个确定性工程，和 WPE 抓帧逐像素比（步骤 0 的 `p7-sem` 已有多余 `#endif` 与宏重定义两项）。
- P4–P6 先做完时解锁 `3498150384`、`3815289650`；只做 P7 时这一节单独解锁不了场景。

## P7c — 类型类

**实现：**
- **HLSL 隐式转换模式：** 在 P7a 嵌入的 naga 里，GLSL 前端加一个选项，默认关闭，翻译器打开。照步骤 0 的 fxc 结论补上：
  - 赋值、初始化、返回、实参的向量 / 矩阵截断；
  - 标量铺满；
  - 不同宽度混算截到窄的一边；
  - `if` / `while` / `?:` 的非布尔条件；
  - `float` → `int` 向零截断，浮点下标同样；
  - 内置函数实参宽度不一时全部截到最窄的一边；
  - 片元的输入可写（`mutable: !input || self.hlsl`）。
  
  规则全部按 [p7-REPORT](p7-REPORT.md)「fxc 的隐式规则」；fxc 报错的写法（`if (float2)`、对标量取下标）在 HLSL 模式下照样报错。默认关闭保证 naga 自带的 GLSL 前端测试照旧通过。
- **片元 varying 按顶点类型：** 改写阶段把片元里 varying 的声明换成顶点阶段的类型（WPE 只有一份 `VS_OUTPUT`，片元自己的声明作废）。只在两边类型不同时改，保证逐字节不变。片元声明了、顶点没有的 varying 在 WPE 里编不过，语料里没有，照旧补零输出。
- **能在改写阶段做的先在改写阶段做：** `texSample2D` 的坐标可以包一层按实参类型重载的 `kb_uv2(…)`（同几何段的 `kb_gs_as_*`）。naga 补丁越小越好维护；`mix` 这类内置函数的实参截断要类型信息，留在 naga 里。
- **README：** 删掉「已知不支持」里这几行，加一节「HLSL 隐式转换」写规则与依据。

**验收：**
- 语料测试中类型类的着色器通过，其余输出逐字节不变；naga 补丁带单测，每条规则正反两例。
- 解锁的场景和 WPE 同一时刻的画面比（只做 P7 时 `3822495444`、`3831518461`；P4–P6 先做完时 7 张）。
- 截断、铺满、混算各一个确定性工程，和 WPE 抓帧逐像素比。

## P7d — 流体

**步骤 0（本节单独做）：**
- `conditions` 怎么按 COMBO 选 pass 与 fbo；
- `functions` 的 `clear` 动作和脚本 `executeMaterialFunction` 的调用约定；
- effect 级 `combos` 的来源；
- 模拟 RT 跨帧保留的规则；
- 光标怎么进模拟（`g_PointerPosition` 已经有，P4c；还是要 P6c 的光标回调）。

**实现：** effect 图支持按条件选 pass / fbo、跨帧保留的 RT、材质函数。`fluidsimulation_advection` 的 naga 错误已查清（naga 前端裁掉 `return` 之后的死代码时留下了 `CallResult`，被我们把 `min` 宏成 `kb_min` 触发），修法在 P7a 嵌入 naga 时作为第一个补丁。

**验收：** WPE 自带的 fluidsimulation 预览工程，固定光标轨迹下和 WPE 逐帧比。语料里唯一用它的 `3286859278` 还要 P4–P6、P8、P11，P7 内解锁不了。

## 和 P4–P6 的交界

- **翻译器 wasm 共用：** P7 改的是 `src-tauri/wpesl2wgsl`，别的会话不改它。但 dev 会把新 wasm 拷进前端，各会话都会用上。所以每步提交前必须过逐字节基线；重建 wasm 前先看一次另两边的状态。
- **共享 TS 文件：** P7b 的 `editable` 和 P7d 的 effect 字段要改 `compile/features.ts`，P7d 还要改 `render/graph.ts`。这两处和 P4–P6 错开动工，同 P6 的约定。
- **P5、P6 的新着色器：** P5 的 mdl 着色器、P6 的文本走图像层，可能带来新的翻译失败。P7a 的语料夹具按扫描时的能力表导出，P5、P6 合入后再导一次。

## 决定

**已定（2026-11-11 用户）：**
1. P7 现在开始，和 P4–P6 并行。
2. **类型类：** 改 naga 的 GLSL 前端，加 HLSL 隐式转换模式。不自写带类型的前处理，也不改走 HLSL → SPIR-V。
3. **naga 的来源：** 源码直接嵌进翻译器（`src-tauri/wpesl2wgsl/naga/`），顺便删掉用不到的翻译模块。不走 `third/` 子模块加补丁序列：naga 只有翻译器用，嵌进来才能裁剪，升级时手工重新嵌入、按说明重放改动。
4. **WPE 也编不过的着色器：** 照 WPE 的失败处理复刻，不照报。步骤 0 查清了回退（片元暗红 `(0.5, 0, 0, 1)`，顶点只变换位置），但语料里没有这种着色器，所以 P7 暂不实现。
5. **顺序：** 步骤 0 → P7a → P7b → P7c → P7d。P7a 是后面所有步骤的回归网，嵌入 naga 也在这里；P7d 解锁不了任何场景，放最后。
6. **验收：** 每类写法一个确定性工程（kbp gen 生成，effect 用工坊原件或照它写的最小着色器），和 WPE 抓帧逐像素比；再加解锁场景的整帧比。工坊场景只读打开、不改。

## 风险

1. **覆盖数是下限估计：** 每个着色器只看到第一个错误。修掉之后可能露出别的错误，可能是规则类、类型类，也可能是新的种类（比如 naga 的其它缺陷）。P7a 的完整错误报告出来后，各节的数字会重算。
2. **fxc 的语义比想象的多：** HLSL 的隐式转换还有矩阵截断、`half`、整数除法、`bool` 向量等边角。只做语料里出现的；没出现的在 naga 补丁里照样报错，不猜。
3. **嵌入的 naga 的维护：** 升级 naga 时要手工重新嵌入、重新裁剪、重放改动。改动集中在前端的转换函数，按选项开关，同目录的说明逐处记下，冲突面应当不大。上游修的 GLSL 前端缺陷我们拿不到，除非升级。
4. **WPE 编不过、我们能编过：** 步骤 0 只粗扫了两种写法（`main` 之前的函数读 varying、片元独有的 varying），没有命中；`mat2` / `ivec2` 的 uniform 声明、`main` 之后的函数、`main` 里提前 `return;` 等没扫。这些在 WPE 里会画成暗红，我们会照常画。
5. **Tint 与 naga 的差异：** naga 回读通过不等于 Tint 接受。P7a 的 Tint 基线是改动前的；新解锁的着色器每批在 dev app 里再跑一次。
6. **和其它会话共用 wasm：** 逐字节基线是唯一的保护。基线漏了某个组合（夹具没导出的 COMBO），别的会话可能看到画面变化。夹具要覆盖全部场景实际用到的组合。

## 实施记录

### 步骤 0 — 调研（2026-11-11）

读码两份：[rea-p7-shader](rea-p7-shader.md)（REA 读 `wallpaper64.exe` 2.8.42：宏头与模板、WPE 自己的预处理、语义分配、编译参数、失败回退、缓存、accessArray）与 [naga-p7-frontend](naga-p7-frontend.md)（naga 30.0.1 GLSL 前端、HLSL 模式原型、流体错误根因、裁剪清单、许可证）。实测见 [p7-REPORT](p7-REPORT.md)。

对后面各步的影响，已改进上文各节：
- **不用复刻回退：** 能认出来的 41 个失败着色器在 WPE 里都正常编译，35 张代表场景回退 0 次。阳性对照 `p7-sem` 证明扫描认得出回退。
- **分节调整：** varying 宽度不同、片元写 varying 从 P7b 移到 P7c（片元用顶点那份声明、输入可写）；标量取下标（`main` 之前的打包数组）、宏重定义从「类型类」「源码损坏」移到 P7b。解锁数随之重算，总数不变（只做 P7 35 → 37，P4–P6 先做完 56 → 65）。
- **P7a：** 嵌入 naga 时带上 interpolator 的 cfg 修正与死代码 `CallResult` 补丁（流体着色器的根因）。
- **Tint 基线** 没在步骤 0 做，移到 P7a 建基线时一起做（dev 在跑，用 kabegame-dev MCP）。
- **工具：** kbp-tools 新增 `kbp rdc shaders`（按绘制列着色器、材质常量名与是否回退）。WPE 的 `log.txt` 这一轮能读到编译错误（`<目标> shader <文件> error:`）。

我的失误：
- 总计划把 `audio` 归为「源码损坏、WPE 多半也编不过」，只看了宏的值，没看宏有没有被用到。
- 回退判据第一版两处写错（顶点判据把纯色图层认成回退、片元常量的格式写错），阳性对照之前的「0 次回退」不可信；修好后全部抓帧重扫，结论不变。
