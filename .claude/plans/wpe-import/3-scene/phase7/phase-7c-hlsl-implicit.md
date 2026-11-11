# P7c — HLSL 隐式转换（子计划）

> 上级：[P7 总计划](phase-7-effects-shaders.md)「P7c」。依据：[naga-p7-frontend](naga-p7-frontend.md) 第 1、2 节（现状、落点、原型与实测）、[p7-REPORT](p7-REPORT.md)「fxc 的隐式规则」与「P7b 规则的实测」、[rea-p7-shader](rea-p7-shader.md) §2.x（片元用顶点的 varying 列表、输入可写）。
> 比较基准：请求夹具 `ignore/p7/requests-p7b`（779 个请求，P7b 的 wasm 录）、逐字节基线 `ignore/p7/baseline/p7b-e2345b19`（3572 个文件）。

## 总体设计思路

P7c 让翻译器接受 HLSL 的隐式类型转换，也就是 WPE 交给 fxc 之后作者的代码能编过的那些写法。P7 剩下的失败几乎都在这里。做法是在嵌入的 naga 的 GLSL 前端加一个 **HLSL 模式**，再在改写阶段补一处接口规则：
- **HLSL 模式（naga 前端）：**
  - `Options` 加一个开关，默认关闭，翻译器打开；
  - 两个共用助手：值转到目标类型的 `hlsl_coerce`、条件转布尔的 `hlsl_condition`；
  - 在赋值、初始化、返回、二元运算、各类条件、实参、下标这些落点调用它们。

  规则全部按 fxc 实测：截断取前几个分量、标量铺满、不同宽度混算截到窄的、`if (float)` 是 `!= 0`、`float → int` 向零截断、浮点下标向零截断成无符号、内置函数实参宽度不一时截到最窄。fxc 报错的写法（`if (float2)`、对标量取下标）在 HLSL 模式下照样报错。
- **重载的第二遍：** 实参类型对不上时，只有 GLSL 规则选不出任何重载才走第二遍，按 HLSL 代价（截断、铺满、降级）选。这样现在能选出唯一重载的调用一定不变，逐字节基线有保证，也不会把原来能过的调用变成二义。
- **片元的 varying 按顶点的类型：** WPE 只有一份 `VS_OUTPUT`，片元自己的 varying 声明作废（实测片元声明 `vec2` 也能读 `.zw`）。改写阶段在两段类型不同时，把片元的声明换成顶点的类型，正文里的截断交给 HLSL 模式。片元写 varying 在 HLSL 模式下放开（输入在 IR 里本来就是 Private 全局，一行）。

HLSL 模式的每条规则只在 GLSL 本来会报错的地方生效，所以对现在已经通过的着色器，开关打开后输出逐字节不变。原型对 WPE 安装目录 167 对验证过这一点：开关关闭时与上游相同，打开时原来通过的 158 对相同。P7c 的每一步都要在两份语料上重新证明。

P7c 是 P7 解锁的主体：
- 只做 P7 时，能渲染 38 → 40（`3822495444`、`3831518461`）；
- P4–P6 先做完时，另有 9 张只差 P7c（P7b 收尾的扫描，见下文「解锁」）。

## 现状锚点

**a. 前端只做分量类型的提升**（`naga/src/front/glsl/context.rs` 的 `implicit_conversion` / `binary_implicit_conversion`，`functions.rs` 的 `conversion`）：int < uint < float 的标量提升，不改宽度、不改矩阵尺寸；`return` 完全不转（上游留着 TODO）。类型不符的 IR 照样产出，由校验器报错。

**b. 选项只有阶段与宏**（`naga/src/front/glsl/mod.rs:52`）
```rust
pub struct Options {
    pub stage: ShaderStage,
    pub defines: FastHashMap<String, String>,   // 现状：没有 HLSL 开关
}
```
翻译器侧（`src/naga_stage.rs:42`）：
```rust
    let mut options = naga::front::glsl::Options::from(naga_stage); // 现状：只填 defines
```

**c. 输入不可写**（`naga/src/front/glsl/variables.rs:480`）
```rust
                    mutable: !input, // 现状：片元写 varying 报 `Variable cannot be used in LHS position`
```

**d. 两阶段 varying 类型必须相同**（`src/rewrite.rs:298`）
```rust
                Storage::Varying => match varyings.iter().find(|v| v.name == decl.name) {
                    Some(existing) if existing.ty != decl.ty || existing.array != decl.array => {
                        return Err(fail(format!("varying {} 在两个阶段的类型不同", decl.name))); // 现状：直接拒绝
                    }
```

**e. 夹具里剩下的失败**（`ignore/p7/fails_p7c.py`，P7b 之后，按着色器的首个错误）：
- varying 宽度不同 8 个；
- 片元写 varying 7 个（含 `Simple_Audio_Bars` 的 `3082978660` 版，13 张场景）；
- 不同宽度混算 9 个；
- 宽赋窄 / 类型不符 8 个，初始化不符 1 个，返回不符 1 个；
- 实参截断（`mix` / `rotateVec2` / `texture` 等）8 个；
- 非布尔条件 2 个；
- 浮点下标 2 个（`video` 的 `kb_pack_*` 下标、`simple_gradient_audio_bar` 的局部数组）；
- 来源待查 1 个（`color_grading__extension`：`InvalidAccess { indexed: true }`，源码里有 `LINEAR ? … : …`）。

（步骤 0 改正：「不同宽度混算」9 个里真正混算宽度的只有 4 个，`gaussian` 与两个 `Simple_Audio_Bars` 是 `bool` 参与算术、`procedural_noise` 是 naga 自身的声明列表缺陷；`color_grading__extension` 是把标量赋给 swizzle，见「实施记录 / 步骤 0」。）

## 步骤

### 步骤 0 — 调研

- **原型跑新夹具：** naga 原型（`naga-p7-frontend` 的 `patch_hlsl.py`）打在嵌入的 naga 副本上（scratchpad，不改仓库），重放 `requests-p7b` 的全部失败请求，列出原型之后还剩的错误。重点：
  - `color_grading__extension` 的 `InvalidAccess`；
  - 标量分量访问（`f.x`、`f.xxx`）在语料里有没有；
  - 浮点下标两处；
  - 修好第一个错误后露出的下一个。
- **fxc 补测**（本机 `d3dcompiler_47.dll`）：原型之后剩下的写法逐个写最小 HLSL 编译、反汇编；另测：
  - 重载同代价时 fxc 怎么选（二义报错还是取某个）；
  - 向量 `?:` 是逐分量选择；
  - 标量分量访问；
  - 复合赋值 `f += v4`。
- **WPE 抓帧**：`p7-sem` 再加几层确定性图层，每层把一类规则的结果画成常量颜色：
  - 宽赋窄、标量铺满、不同宽度混算；
  - 非布尔条件、`float → int`、浮点下标；
  - `mix(vec4, vec3, float)`、`texSample2D` 用 `vec4` 坐标；
  - 用户函数的实参截断、`return` 截断。

  抓 WPE 的帧作真值，留给步骤 4 和 Kabegame 的渲染比。
- **产出：** p7-REPORT 追加「P7c 规则的实测」；本子计划步骤 0 实施记录；规则表定稿（哪些做、哪些照报）。

### 步骤 1 — HLSL 模式的骨架

- **修改**（嵌入的 naga）：`Options.hlsl_implicit`（默认 `false`）→ `Frontend.hlsl` → `Context.hlsl` / `return_ty`；加 `hlsl_coerce`、`hlsl_condition` 两个助手，开关关闭时直接返回。调用点只把 `let x` 改成 `let mut x` 并调用助手。
- **修改**（翻译器）：`naga_stage.rs` 打开开关。
  ```rust
      let mut options = naga::front::glsl::Options::from(naga_stage);
      options.hlsl_implicit = true; // 新增：作者的代码按 HLSL 的隐式转换编译（WPE 交给 fxc），见 naga/KABEGAME.md
  ```
- **验收：** 开关打开、助手还是空的：两份语料逐字节相同；naga 单测全过。`KABEGAME.md` 记一条行为补丁（选项与助手）。

### 步骤 2 — 逐条加规则

每组规则一个小步，每步：
- 正反两例单测（naga `parser_tests.rs` 一侧，翻译器一侧放一例端到端）；
- 跑基线：原来通过的逐字节不变，新通过的列进 ALLOW；
- 新通过的 WGSL 回读通过，最后统一跑 Tint。

| 小步 | 规则 | 落点（naga-p7-frontend §2.2） |
|---|---|---|
| 2a | 赋值、初始化、`return` 的截断与铺满，向量 → 标量取 `.x`，`float → int` 向零截断 | `context.rs` Assign、`declarations.rs` 初始化、`parser/functions.rs` return |
| 2b | 不同宽度向量混算截到窄的 | `context.rs` Binary |
| 2c | 非布尔条件 `!= 0`：`if` / `while` / `do` / `for` / `?:` / `!` / `&&` / `||` | 各条件落点 |
| 2d | 实参的第二遍：用户函数只有一个重载能经隐式转换匹配时才选它，多个报二义（fxc X3067）；内置函数与我们自己的 `kb_pow` / `kb_min` / `kb_max` 等包装按内置规则，按代价取截到最窄的那个；带 `depth` 形参的候选跳过 | `functions.rs` `function_call` |
| 2e | 浮点下标转 `u32`（照 fxc 的 `ftou`）；`bool` 参与算术（`+`、`*`、复合赋值）为 0 / 1 | `context.rs` Access、Binary、`hlsl_kind` |
| 2f | 标量分量访问 `f.x` / `f.xx`（fxc 合法；语料会执行到的代码里没有，`p7-sem` 的 `kbconv4` 用到，约 15 行） | `variables.rs` swizzle |
| 2g | naga 的声明列表缺陷：`float color[4], f;` 把 `f` 也当成数组（与 HLSL 无关，上游缺陷），单独一个行为补丁 | `parser/declarations.rs` |
| 2h | 全局 `const` 的初始值不是常量（引用 uniform）：WPE 写成 `static const`，fxc 每次调用现算（实测 `c4.hlsl`）。改写阶段改成私有全局，在 `main` 开头按声明顺序赋值 | `src/rewrite.rs` |
| — | 不做，照旧报错：矩阵截断、`out` 实参截断、向量比较的 bvec 语义、`%` 的向量铺满、向量当 `?:` 条件（fxc 逐分量，语料没有） | — |

`KABEGAME.md` 的「行为补丁」一节逐条写：落点、规则、fxc 依据。

### 步骤 3 — 片元的 varying

- **修改** `src/rewrite.rs`：两阶段 varying 类型不同时，不论哪边更宽，片元的声明都换成顶点的类型（WPE 只有一份 `VS_OUTPUT`，片元自己的声明作废）。片元更宽、又读了顶点没有的分量时，naga 照常报错，和 fxc 一致。`glitter_prepare`（只做 P7 的解锁 `3822495444`）就是片元更宽。只在类型不同时改，保证逐字节不变。
- **修改** 嵌入的 naga：HLSL 模式下输入可写。
  ```rust
                      mutable: !input || self.hlsl, // 修改：HLSL 的 PS 输入是可写的局部副本（rea-p7-shader §2.x）
  ```
- **验收：** varying 宽度不同的 8 个、片元写 varying 的 7 个通过（或露出下一个错误）；`p7-sem` 的 `kbwidth` 在 Kabegame 里画出 `(0.25, 0.75, 0.5)`。

### 步骤 4 — 收尾与对照

- **重录夹具、重扫语料：** 同 P7b 收尾的做法：wasm 放进产品源码快照（`ignore/`），不碰 `bin/wasm` 与前端。重算解锁，导出新基线。
- **Tint：** 全部新基线 WGSL 0 error。
- **重建 wasm**（`deno task build:wpesl2wgsl`）：经你同意后做。只影响各会话下次重启 dev；除预期的着色器外输出逐字节不变。重建前看一次别的会话的状态。
- **和 WPE 比：**
  - 在 Kabegame 里渲染 `p7-sem` 的全部图层（P7b 的四层与 P7c 新加的），和步骤 0 的 WPE 抓帧逐像素比；
  - 解锁的两张（`3822495444`、`3831518461`）和 WPE 同一时刻的画面比；
  - 原本能渲染的场景画面不变（画面哈希）。
- **文档：**
  - 翻译器 README：「已知不支持」删掉隐式截断那几行，新增「HLSL 隐式转换」一节；
  - `cocs/wpe/WPE_SCENE.md` 摘要；
  - 回归 P7c 节；
  - 总计划实施记录。

## 解锁

P7b 收尾的扫描（`ignore/p7/ana_p7c.py`，`corpus-p7b.json`）：
- **只做 P7：** `3822495444`（`glitter_prepare`，varying 宽度）、`3831518461`（`shimmer`，`rotateVec2` 实参截断）。
- **P4–P6 先做完时另有：** `2981249186`、`3451555874`、`3498150384`、`3502090109`、`3815289650`、`3824424509`、`3832004152`。
- **不算解锁的：** `3817779853` 也只差 `shader:*`，但它的 `audioline` 现在提前失败，音频 uniform 键因此没报出来；修好后 `uniform:g_Audio*` 会回来，仍要 P11。
- 修好一个错误可能露出下一个，以上是上限，步骤 4 重算。

## 并行与实施方式

- 只改 `src-tauri/wpesl2wgsl/**`（含嵌入的 naga），不碰 `apps/**`。翻译器 wasm 共用，步骤 4 之前不重建。
- 步骤 1–3 交给代理，按小步分别报告基线结果；我独立验收：查越界、自己跑基线、Tint、和 WPE 比。步骤 0 的 fxc 与 WPE 抓帧我自己做，原型重放交给代理。

## 决定

**已定：**
1. 隐式转换改在 naga 的 GLSL 前端（P7 总计划，2026-11-11 用户）。
2. 片元写 varying 交给 naga 的 HLSL 模式（一行），不在改写阶段造私有副本（P7 步骤 0 实测后总计划已改）。
3. **重载同代价：** 照 fxc 的实测，fxc 报二义就报错；步骤 0 测完定稿（2026-11-12 用户）。
4. **语料里没出现的规则**（矩阵截断、`out` 实参截断、向量比较的 bvec 语义、`%` 的向量铺满）：不做，照旧报错；以后遇到样本再补（2026-11-12 用户）。
5. **重建 wasm 的时机：** 步骤 4 验收通过、提交之后，经用户同意再重建，一并带上 P7a、P7b 的改动（2026-11-12 用户）。

## 风险

1. **修好一个、露出下一个：** 首个错误之后可能还有别的写法，甚至超出步骤 0 的规则表。按步骤 2f 的原则：fxc 能编、语料出现就做，否则照报。
2. **第二遍选错重载：** 代价函数是近似 HLSL 的规则。用户函数的重载在语料里很少，代价相同时照 fxc；Kabegame 渲染和 WPE 比是最后的检查。
3. **截断语义的细节：** 赋值截断、混算截断已实测；`out` 实参、矩阵等没实测的不做。
4. **naga 的维护：** HLSL 模式约 300–350 行，加单测约 150 行，集中在 GLSL 前端。`KABEGAME.md` 逐条记录，升级 naga 时重放。

## 实施记录

### 步骤 0 — 调研（2026-11-12）

- **原型重放**（代理，scratchpad 副本，`ignore/p7/out/p7c-step0-proto.md`）：naga 原型加「varying 顶点更宽时片元按顶点类型」打在嵌入的 naga 副本上，重放 `requests-p7b`：
  - 失败从 90 个请求 / 45 个着色器降到 13 / 8；原来通过的 3572 个文件逐字节不变；WPE 安装目录 158 → 160；
  - 剩下四类：
    - `bool` 参与算术（4 个着色器、9 个请求，如 `x += a - b < 0.0`、`d *= (d < l) * 6.0`）；
    - 片元的 varying 比顶点宽（`glitter_prepare`、`topographic`）；
    - 全局 `const` 的初始值引用 uniform（`radial_blur`）；
    - naga 自身的声明列表缺陷（`float color[4], f;`，`procedural_noise`）；
  - 再补前两类和声明列表（proto2）：779 个请求通过 778 个，逐字节仍不变，WPE 安装目录 161 / 167；`radial_blur` 的全局 `const` 临时改成 `#define` 后也通过。
  - `color_grading__extension` 是把标量赋给 swizzle（`albedo.rgb = greyscale(albedo.rgb)`，`greyscale` 返回 `float`），原型的赋值铺满已解决；子计划原以为与 `LINEAR ? …` 有关，不是。
  - 标量分量访问：语料里会执行到的代码没有（只有 `genericropeparticle.vert` 不编译的分支）。
  - 两处浮点下标原型之后都通过；正式实现按 fxc 的 `ftou` 转 `u32`。
  - 第二遍重载的全部 20 次调用里，作者的用户函数都只有一个可行候选；我们的 `kb_pow` / `kb_min` / `kb_max` 必须按内置规则选（`water_caustics` 的 `pow(float, vec3)` 有 6 个可行候选）。
- **fxc 补测**与 **WPE 抓帧**：见 [p7-REPORT](p7-REPORT.md)「P7c 规则的实测」。用户函数重载多个可行时 fxc 报二义；`kbconv1–4` 四层的 WPE 结果都和预测一致。另测 `static const` 引用 uniform（`ignore/p7/fxc/c4.hlsl`）：fxc 接受，每次调用现算。
- **规则表定稿**：步骤 2 加了 2f（标量分量访问）、2g（声明列表缺陷）、2h（全局 `const` 现算），2d、2e 按实测细化；步骤 3 改成 varying 两个方向都按顶点类型。
- **我的失误：** 子计划把 `color_grading__extension` 的来源猜成 `LINEAR ? …`，并把 4 个 `bool` 算术、1 个 naga 缺陷误归进「不同宽度混算」，都是只看首条错误的消息没看源码。

### 步骤 1–3 — HLSL 模式与片元 varying（2026-11-12）

- 代理实现，我独立核对。改动在 `src-tauri/wpesl2wgsl/`：嵌入 naga 的 `front/glsl/` 下 `context.rs`、`functions.rs`、`mod.rs`、`variables.rs`、`parser/declarations.rs`、`parser/functions.rs`，新单测文件 `hlsl_tests.rs`；翻译器 `src/rewrite.rs`（2h、步骤 3）、`src/naga_stage.rs`（打开开关、传 `hlsl_intrinsics`）；`naga/KABEGAME.md` 记 B2–B10；README 删掉「已知不支持」里隐式截断的 4 行，新增「HLSL 隐式转换」一节。合计约 +890 / −24。
- 每小步都对 `p7b-e2345b19` 基线跑过，都是「变了 0、新失败 0」；夹具通过数 689 → 706（2a）→ 712（2b）→ 715（2c）→ 724（2d）→ 735（2e）→ 735（2f）→ 736（2g）→ 736（2h）→ 779（步骤 3）。逐步记录 `ignore/p7/out/p7c-steps.txt`。
- 我重跑：夹具 779 / 779；原来通过的 3572 个文件逐字节不变；WPE 安装目录 161 / 167（剩下 6 个是阴影 `gl_ViewportIndex` ×3、`fur4` 基线没绑槽 8、`puppettexturechannels` 数组长度 0、`volumetricsfront` 的 `sampler2DBackBuffer`，都与隐式转换无关）；几何 27 / 27；翻译器单测 71、naga 136 全过；新通过的 186 份 WGSL Tint 0 error。
- **偏离：**
  - 新增选项 `Options.hlsl_intrinsics`：翻译器把 `kb_pow` / `kb_max` / `kb_min` / `kb_gs_normalize` 传进去，第二遍按内置规则选，naga 里不写死函数名；
  - 内置函数同代价取先声明的，选截掉分量最少的重载；
  - `v.xy = v4` 这类 GLSL 本来合法的 swizzle 赋值不做转换，实参转换只用在第二遍选出的重载上（保证逐字节不变）；
  - 2b 也覆盖位运算和移位，比较运算不截；
  - 2g 不受开关控制（上游缺陷，B2）；
  - 实参的 `float → int` 跟形参走 `i32`，只有下标用 `u32`；
  - 2h 只认引用 uniform / attribute / varying / `gl_*` / `kb_pack_*` / 已改写的 const 的初始值，调用用户函数的照旧报错；
  - 步骤 3 只要顶点声明过这个 varying，任何类型差异都按顶点的类型。
- **语料重扫**（工作区翻译器编的 wasm 放进 HEAD 产品源码快照 `ignore/p7/snap-p7c`，夹具录到 `ignore/p7/requests-p7c`；对比同一快照配 P7 之前的 wasm，`ignore/p7/out/diff-before-p7c.txt`，语料现为 173 张）：
  - 能渲染 39 → 42（`3822495444`、`3831518461`、新下载的 `3837598414`）；语料里不再有 `shader:*` 键；
  - P4–P6 先做完的口径 56 → 62（`2981249186`、`3668499717`、`3822495444`、`3824424509`、`3831518461`、`3837598414`）。比计划少 3 张：`Simple_Audio_Bars`（`3021673417` 版）与 `video` 翻译通过后露出音频 uniform（P11）；
  - 新露出的产品侧键：`uniform:g_LayerModelMatrix`（4 张）、`constant:mixed-type`（3）、`constant:slots`（2）、`uniform:g_FrameTime`（1），以及音频 uniform。用户 2026-11-12 定：前四个并进 P7d。
