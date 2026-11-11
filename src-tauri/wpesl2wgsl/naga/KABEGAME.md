# 嵌入的 naga（Kabegame 副本）

本目录是 [naga](https://github.com/gfx-rs/wgpu/tree/trunk/naga) 30.0.1 的 crate 源码，作为着色器翻译器 `wpesl2wgsl` 的路径依赖。
翻译器只用 GLSL 前端与 WGSL 后端（测试回读另用 WGSL 前端），所以删掉了其余前后端；以后对前端的行为补丁也改在这里。

## 上游

| 项 | 值 |
|---|---|
| crate | `naga` 30.0.1（crates.io） |
| 校验和（`Cargo.lock`） | `a616d2fb8c89516ac2723a581f69d6c18576046bed761bd6b305e5618e6ae130` |
| 上游提交（`.cargo_vcs_info.json`） | `40f4a34ebaf56f9a046231f54125ad046239d3f3`，`path_in_vcs = "naga"` |
| 许可证 | `MIT OR Apache-2.0`，`LICENSE.MIT`、`LICENSE.APACHE` 原样保留 |
| `naga-types` | 不嵌入，仍从 crates.io 取，钉 `=30.0.1` |

除下面「改动」列出的文件外，`src/` 下保留的文件与上游逐字节相同（LF）。改过的文件顶部有一行 `// Kabegame 修改，见 KABEGAME.md`（`Cargo.toml` 是 `#` 注释）；
我们新加的文件只有 `src/front/glsl/hlsl_tests.rs`（HLSL 模式的单测），顶部是 `// Kabegame 新增，见 KABEGAME.md`。

## 删掉的内容

**模块**（只为这些前后端存在，保留的代码不引用它们）：

| 路径 | 用途 |
|---|---|
| `src/back/spv/` | SPIR-V 后端 |
| `src/back/hlsl/` | HLSL 后端 |
| `src/back/msl/` | MSL 后端 |
| `src/back/glsl/` | GLSL 后端 |
| `src/back/dot/` | dot 后端 |
| `src/back/pipeline_constants.rs` | 只在 `hlsl_out` / `msl_out` / `spv_out` / `glsl_out` 下编译 |
| `src/back/continue_forward.rs` | 只在 `hlsl_out` / `glsl_out` 下编译 |
| `src/front/spv/` | SPIR-V 前端 |
| `src/front/atomic_upgrade.rs` | 只给 `spv-in` |

`proc`、`valid`、`common`、`keywords`、`compact`、`ir`、`arena` 等整块保留；`src` 里的内联单测（含 `front/glsl/parser_tests.rs`）保留。

**feature**：`spv-in`、`spv-out`、`msl-out`、`msl-out-if-target-apple`、`hlsl-out`、`hlsl-out-if-target-windows`、`glsl-out`、`dot-out`、`fs`。
保留 `glsl-in`、`wgsl-in`、`wgsl-out`、`stderr`、`termcolor`，以及 `serialize` / `deserialize` / `arbitrary`（源码里大量 `cfg_attr` 引用它们，删了声明会出 `unexpected_cfgs`；不开就不编译 serde / arbitrary）。

**依赖**：`petgraph`、`spirv`（只给 `spv-in` / `spv-out`）。
**dev 依赖**：`bytemuck`、`env_logger`、`hashbrown`（serde 版）、`itertools`、`ron`、`rspirv`、`spirv`、`serde`、`walkdir`，以及上游工作区里的 `hlsl-snapshots`、`naga-test`（只给上游 `tests/` 的快照测试）；只留 `src` 内联单测用的 `diff`、`strum`。

**包里的其它文件**：上游 `tests/`、`benches/`、示例本来就不在 crates.io 包里；`CHANGELOG.md`、`README.md`（介绍已删的前后端）、`Cargo.toml.orig`（用工作区继承，不能直接用）、`Cargo.lock`、`.cargo/config.toml`（上游 xtask 别名）、`.gitignore`、`.gitattributes`、`.cargo_vcs_info.json` 不带。

## 改动

改动分两类：「只删减、不改行为的改动」只删被删模块的声明与 cfg 分支（第 1 条修好上游的编译错误），不改任何保留代码的行为；
「行为补丁」改变前端或校验的结果，每条都写明最小复现，并有单测。两类都用翻译器的逐字节基线验证（见「升级」）。

### 只删减、不改行为的改动

翻译器的逐字节基线验证过，嵌入前后全部输出相同。

| # | 文件 | 位置 | 改动 | 理由 |
|---|---|---|---|---|
| 1 | `src/front/mod.rs` | `interpolator` 模块声明 | cfg 由 `any(feature = "spv-in", feature = "wgsl-in")` 改为 `any(feature = "glsl-in", feature = "wgsl-in")` | 上游漏了 `glsl-in`：GLSL 前端（`front/glsl/variables.rs` 的 `apply_default_interpolation`）用它，只开 `glsl-in` 编不过 |
| 2 | `src/front/mod.rs` | 模块声明 | 删 `atomic_upgrade`、`spv` 两个 `#[cfg(feature = "spv-in")]` 声明 | 模块已删 |
| 3 | `src/back/mod.rs` | 模块声明 | 删 `dot` / `glsl` / `hlsl` / `msl` / `spv` / `pipeline_constants` / `continue_forward` 的声明，只留 `wgsl` | 模块已删 |
| 4 | `src/back/mod.rs` | 文件头与 `Baked` 的 `cfg_attr(not(any(…)), allow(dead_code))` | 条件里只留 `wgsl_out` | 其余别名已删 |
| 5 | `src/back/mod.rs` | `RayQueryPoint` | `cfg_attr(not(any(hlsl_out, spv_out)), allow(dead_code, …))` 改为无条件 `allow(dead_code, …)` | 两个别名都已删，条件恒真 |
| 6 | `src/back/mod.rs` | `get_entry_points` | 整个函数删掉 | 只在 `any(hlsl_out, msl_out)` 下编译 |
| 7 | `src/error.rs` | `impl Display for ShaderError<front::spv::Error>` | 删掉 | 只在 `spv-in` 下编译 |
| 8 | `src/error.rs` | `emit_to_writer` 的 `expect(dead_code)` 条件 | `not(any(feature = "spv-in", feature = "glsl-in"))` 改为 `not(feature = "glsl-in")` | `spv-in` 已删 |
| 9 | `src/lib.rs` | 文件头文档示例的两行 `cfg_attr(… feature = "glsl-out" …, doc = …)` | 改为固定的 `#![doc = "```ignore"]` | 示例用 GLSL 后端，已删；文档文字未改 |
| 10 | `src/proc/index.rs` | `BoundsCheck` | `cfg_attr(not(feature = "msl-out"), allow(dead_code))` 改为无条件 `allow(dead_code)` | `msl-out` 已删，条件恒真 |
| 11 | `src/proc/mod.rs` | `get_const_val` 的 `cfg_attr(not(any(…)), allow(dead_code))` | 条件去掉 `feature = "spv-in"`、`glsl_out`、`hlsl_out`、`msl_out` | 已删 |
| 12 | `build.rs` | `cfg_aliases!` | 删 `dot_out`、`glsl_out`、`hlsl_out`、`msl_out`、`spv_out` 别名；`std` 去掉 `feature = "fs"` | feature 已删 |
| 13 | `Cargo.toml` | 整个文件 | 以 crates.io 规范化后的 `Cargo.toml` 为底本：加 `publish = false`，删 `exclude`、`readme`，删上面列出的 feature 与依赖，`naga-types` 由 `30.0.0` 改钉 `=30.0.1`；不声明 `[workspace]` | 嵌入与裁剪 |

文档注释里指向已删模块的链接（如 `proc/index.rs` 的 `crate::back::pipeline_constants::process_overrides`、`proc/namer.rs` 的 `crate::back::msl`）没改，只影响 rustdoc。

### 行为补丁

代码里的补丁处都有 `Kabegame 补丁` 注释。升级时先查上游是否已修，修了就去掉这一条，但保留单测。

| # | 文件 | 位置 | 改动 | 理由 | 最小复现 |
|---|---|---|---|---|---|
| B1 | `src/front/glsl/context.rs`、`src/front/glsl/parser/functions.rs`（单测在 `src/front/glsl/parser_tests.rs` 的 `dead_code_call_result`） | 新增 `Context::cull_dead`；`parser/functions.rs` 里三处 `ctx.body.cull(idx..)`（`switch` 分支、`do-while` 体、复合语句）改成调用它 | 裁掉终结语句（`return` / `break` / `continue` / `discard`）之后的死代码之前，先把被裁语句里（递归进 `Block` / `If` / `Loop` / `Switch`）`Call` / `Atomic` 的结果表达式原地改成同类型的 `ZeroValue`，再裁剪 | 上游只裁语句，`CallResult` / `AtomicResult` 表达式留在 arena 里；校验器要求每个这类表达式被对应语句访问，于是报 `Expression not visited by the appropriate statement`（`UnvisitedExpression`）。翻译器把 `min` / `max` 宏成用户函数 `kb_min` / `kb_max`，WPE 自带的 `effects/fluidsimulation_advection`（`RENDERING` 为 1、2）死代码里就有这种调用。被裁的表达式没有活语句引用，后端不输出，所以只改变本来校验失败的模块；翻译器的逐字节基线只多了 advection 的新通过 | `float f(float a) { return a * 2.0; }` `float g(float x) { return x; return f(x); }`（`#version 450` 片元，`main` 调 `g`）；把 `f(x)` 换成内置的 `min(x, 1.0)` 上游也通过 |
| B2 | `src/front/glsl/parser/declarations.rs`（单测 `parser_tests.rs` 的 `declarator_list_array_suffix`） | `parse_init_declarator_list`：循环前记下 `base_ty`，每个声明符开始时 `ty = base_ty` | 数组后缀只属于它所在的声明符 | 上游跨声明符复用 `ty`，`parse_array_specifier` 把前一个声明符的 `[4]` 留在 `ty` 上，后面的声明符也成了数组（GLSL、HLSL 里都不是）。和 HLSL 模式无关，开关关闭时也生效；工坊 `procedural_noise` 的 `perlin` 由此失败。只改变本来声明错类型的模块，基线逐字节不变 | `float color[4], f; f = 0.5;`：上游里 `f` 是 `float[4]`，存标量时校验失败 |

#### HLSL 隐式转换模式（B3–B10）

WPE 在 Windows 上把着色器交给 fxc 编译，作者的代码按 HLSL 的隐式转换写（宽向量赋给窄的、`if (float)`、`mix(vec4, vec3, float)` 等）。
翻译器打开 `Options::hlsl_implicit`，前端在 GLSL 本来会报错的地方改按 fxc 的规则转换。规则全部来自 fxc 实测（WPE 自带的 `d3dcompiler_47.dll`，
flags `0x8800`，`.claude/plans/wpe-import/3-scene/phase7/p7-REPORT.md`「fxc 的隐式规则」「P7c 规则的实测」）与 WPE 抓帧（`p7-sem` 的 `kbconv1–4`）。

不变式：**每条规则只在 GLSL 下必然报错的地方生效**。开关关闭时 IR 与上游相同；开关打开时，GLSL 本来就接受的代码 IR 也不变（类型相同就什么也不加、
重载只在第一遍选不出时才走第二遍、swizzle 存储的例外见 B4）。翻译器的逐字节基线（WPE 安装目录与 779 个请求夹具）验证过：原来通过的 3572 个文件全部相同。

单测都在 `src/front/glsl/hlsl_tests.rs`：每条规则一个正例（开关打开能编过、WGSL 里是预期写法，开关关闭时报错）和反例（fxc 也报错或不在规则内的写法照旧报错），
另有「GLSL 本来合法的写法开关开、关输出逐字节相同」的用例。

| # | 落点 | 规则 | fxc 依据 | 单测 |
|---|---|---|---|---|
| B3 | `mod.rs`：`Options::hlsl_implicit`（默认 `false`，`From<ShaderStage>` 给 `false`）、`Options::hlsl_intrinsics`、`Frontend::hlsl` / `hlsl_intrinsics`；`context.rs`：`Context::hlsl` / `return_ty`（`parser/declarations.rs` 函数定义处填）、助手 `hlsl_kind` / `hlsl_coerce` / `hlsl_condition` / `hlsl_binary` | 骨架。`hlsl_coerce` 把值转到目标类型、`hlsl_condition` 把条件转成布尔，开关关闭时直接返回；调用点只把 `let x` 改成 `let mut x` 再调用助手 | — | 各条共用 |
| B4 | `context.rs` 的 `HirExprKind::Assign`（含复合赋值、swizzle 赋值）、`parser/declarations.rs` 的 `parse_initializer`、`parser/functions.rs` 的 `return` | `hlsl_coerce`：宽向量给窄的取前几个分量；标量给向量铺满；向量给标量取 `.x`；分量类型不同用 `hlsl_kind`（数值之间 `As`，`float → int` 向零截断，布尔转数值 0 / 1）。窄向量给宽的、矩阵不动（照旧报错）。`return` 上游完全不转（留着 TODO），HLSL 模式按 `return_ty` 转。例外：swizzle 目标（`v.xy = v4`）由 `lower_store` 逐分量取值，同分量类型、不更窄的向量在 GLSL 下本来合法、结果就是截断，不转 | `float2 a = tc` → `v1.xy`（X3206）；`float4 s = u_c` 铺满；`float f = v4` 取 `.x`；`int i = 2.7` 是 `round_z`；`float acc; acc += float4` 截成 `.x` 再加；`kbconv1` 实测 `(0.298, 0.498, 0.600)` | `assign_init_return` |
| B5 | `context.rs` 的 `hlsl_binary`（`HirExprKind::Binary`，GLSL 的分量类型提升之后） | 不同宽度的向量做 `+ - * / %`、位运算、移位：宽的一边截到窄的。比较运算不动（HLSL 的向量比较得 bvec，GLSL 前端把 `==` 包成 `all()`，语义不同） | `float3 m = u_a * u_b`（float4 × float3）→ 逐分量三维，X3206；`kbconv2` | `mixed_width_binary` |
| B6 | `hlsl_condition`：`parser/functions.rs` 的 `if` / `while` / `do` / `for`，`context.rs` 的 `?:`、`!`（`Unary`）、`&&` / `\|\|`（`Binary`） | 非布尔的标量条件按 `x != 0`。向量条件不动、照旧报错 | `if (float)` 是 `ne r0.x, l(0), cb0[1].w`；`!float` 是 `== 0`；`float && float` 两边各自 `!= 0`；`if (float2)` 报 X3019；向量当 `?:` 条件是逐分量选择（语料没有，不做） | `scalar_conditions` |
| B7 | `functions.rs` 的 `function_call`、`hlsl_pick_overload`、`hlsl_cost` | GLSL 规则一个重载也选不出时才走第二遍（能选出的调用一定不变）。实参代价：分量类型提升 1、降级 4；每截掉一个分量 8；标量铺满 2；窄到宽、布尔与数值之间、矩阵、纹理不同都不能转；`out` / `inout` 要求类型相同；带 `depth` 形参的候选跳过（第一遍对它们调了 `sampled_to_depth`，会改全局纹理类型）。用户函数只有一个重载能匹配才选，多个报二义；内置函数（重载里有 `internal` 的）与 `Options::hlsl_intrinsics` 列出的用户函数取总代价最小的（同代价取先声明的），即维度取最窄的向量实参、标量铺满。选出后实参经 `hlsl_coerce` 转到形参类型 | 用户函数 `g(float2)` / `g(float3)` 传 float4、`h(float2)` / `h(float)` 传 float4 都报 X3067；`lerp(float4, float3, float)` 截到三维；`kbconv3` / `kbconv4` 实测 | `overload_second_pass` |
| B8 | `context.rs` 的 `HirExprKind::Access`；`hlsl_binary` | 浮点下标转 `u32`（WGSL `u32(f)` 向零截断、负数饱和到 0）。`bool` 参与 `+ - * / %`（复合赋值经这一步）时按 0 / 1 转成另一边的分量类型；两边都是 bool 的不动 | 浮点下标是 `ftou r0.x, -cb0[1].w`（负数也走 `ftou`）；`bool` 参与算术是 `bfi`；对标量取下标报 X3121（不做） | `float_index_and_bool_arithmetic` |
| B9 | `variables.rs` 的 `field_selection` | 标量的分量访问：`x` 或 `r` 重复 1–4 次；一个分量是标量自己（左值时仍是指针），多个铺满成向量；别的分量名、左值重复分量照旧报错 | `f.xxxx`、`f.x` 合法（`c1–c3.hlsl`）；语料会执行到的代码里没有，`p7-sem` 的 `kbconv4` 用 `f.xx` | `scalar_swizzle` |
| B10 | `variables.rs` 的 `add_global_var`（`in` / `out` 分支） | `mutable: !input \|\| self.hlsl`：输入可写。输入在 IR 里本来就是 Private 全局、由入口包装函数拷进来，写它没有障碍；uniform 仍不可写 | HLSL 的 PS 输入是可改写的参数（rea-p7-shader §2.x）；WPE 片元改写 varying 实测编过（`kbwidth`） | `writable_inputs` |

不做、照旧报错（语料里没有，以后遇到样本再补）：矩阵截断与铺满、`out` 实参截断、向量比较的 bvec 语义、`%` 与比较运算的向量 ⊕ 标量铺满、向量当 `?:` 的条件、
两边都是 bool 的算术、标量取下标（fxc 也报错）。翻译器自己的 `kb_gs_as_*`（几何段的截断包装）、`kb_min` / `kb_max` / `kb_pow` 在 HLSL 模式下已多余，
但去掉会改变已通过着色器的输出，留着。

## 构建与测试

- 翻译器依赖：`naga = { path = "naga", default-features = false, features = ["glsl-in", "wgsl-out"] }`；`[dev-dependencies]` 再开 `wgsl-in`，供测试回读。根 `Cargo.toml` 是 resolver 2，dev 依赖的 feature 不进 wasm。
- 本目录在仓库工作区里，作为路径依赖自动成为**工作区成员**：
  - 根 `Cargo.toml` 的 `[profile.dev.package."*"]` 覆盖不到它，所以另有 `[profile.dev.package.naga]`（opt-level 2），否则语料测试会慢很多；
  - 它的可选依赖（`serde`、`arbitrary`、`termcolor`）与 dev 依赖（`diff`、`strum` 0.28）也会进 `Cargo.lock`，但不开 feature 时不编译。
- 跑单测（136 个：保留下来的上游单测 127 个，加行为补丁的 9 个：B1、B2 各一个，HLSL 模式 7 个）：

  ```bash
  CARGO_TARGET_DIR=target-check cargo test -p naga --lib --features glsl-in,wgsl-in,wgsl-out,stderr
  ```

  要带 `wgsl-in`（`valid/immediates.rs` 的单测用 WGSL 前端）和 `stderr`：内联单测用 `std::println`，而 `build.rs` 的 `std` 别名
  写的 `cfg(test)` 在构建脚本里看不到，只能靠 `stderr` 打开 `std`。不带这两个 feature 时编不过，上游源码同样如此，与删掉的后端无关。

## 升级（重新嵌入）

1. 改翻译器 `Cargo.toml` 之前，先按 `src-tauri/wpesl2wgsl/README.md`「测试」建一份逐字节基线（`WPESL2WGSL_DUMP_DIR`，WPE 安装目录与请求夹具两部分）。
2. 从 cargo registry 取新版本源码（`%USERPROFILE%\.cargo\registry\src\index.crates.io-*\naga-<版本>\`，先临时把依赖改成 crates.io 的新版本让 cargo 下载），核对 `Cargo.lock` 的校验和。
3. 清空本目录，拷入 `src/`、`build.rs`、`LICENSE.MIT`、`LICENSE.APACHE`、规范化的 `Cargo.toml`，按字节拷贝、保持 LF。
4. 删「删掉的内容」里的模块；新版本若多了只给已删前后端用的模块，一并删掉并补进清单。
5. 按「改动」逐条重放：
   - 先查上游是否已修第 1 条（`interpolator` 的 cfg），修了就去掉这一条；
   - 「行为补丁」逐条重放（上游已修的去掉），各自的单测必须过；
   - 其余各条靠编译器找：删掉 feature 后，`cargo check -p naga --features glsl-in,wgsl-in,wgsl-out` 的 `unexpected_cfgs` 警告与找不到模块的错误会点出每一处；
   - 改过的文件顶部补上修改声明，更新本文件的上游版本、校验和与改动表。
6. 同步 `naga-types` 的版本钉（`=<版本>`）。
7. 验收：
   - 对第 1 步的基线逐字节比较（`WPESL2WGSL_BASELINE_DIR`）；升级可能本来就改变输出，变了的要逐个说明原因；
   - `cargo test -p wpesl2wgsl --lib`、上面的 naga 单测全过；
   - `cargo clippy -p wpesl2wgsl` 翻译器自身不新增警告；
   - wasm 体积前后对比（`--profile wpesl2wgsl`）。
