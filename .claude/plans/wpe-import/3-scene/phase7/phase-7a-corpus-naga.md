# P7a — 语料、基线与嵌入 naga（子计划）

> 上级：[P7 总计划](phase-7-effects-shaders.md)「P7a」。依据：[p7-REPORT](p7-REPORT.md)、[naga-p7-frontend](naga-p7-frontend.md)（第 4 节裁剪清单、第 3 节死代码补丁、第 5 节许可证）。
> P7 步骤 0 已经做完读码与实测，P7a 不另做步骤 0。只动 `src-tauri/wpesl2wgsl/**`、kbp-tools 与文档，不碰 `apps/wpe-scene/**`。

## 总体设计思路

P7a 给后面三节搭回归网，并把 naga 换成我们自己的副本，本身不让任何场景多渲染一张。

回归网分两层：
- **请求夹具：** 语料编译扫描时，把每一次真正发给翻译器的请求原样录下来。请求带着全部输入：源码、头文件、COMBO、纹理格式、宏、`litDefines`。Rust 语料测试逐个重放，就覆盖了全部场景实际用到的组合。这比现在「默认 COMBO、只绑槽 0」的基线全得多，也是总计划风险 6「基线漏组合」的对策。夹具只放在 `ignore/` 下，测试没有夹具时跳过，工坊内容不进仓库。
- **逐字节基线：** 改动前把全部成功翻译的 GLSL / WGSL 导出一份，存为基线目录。语料测试读到基线目录时逐份比较，报「相同 / 变了 / 新通过 / 新失败」。之后每一步都要说清哪些输出变了、为什么变。

嵌入 naga 是纯搬家：naga 30.0.1 的 crate 源码放进 `src-tauri/wpesl2wgsl/naga/`，作为翻译器的路径依赖。
- 上游文件保持原样的模块路径，以后能和上游逐文件比；
- 删掉用不到的后端与前端，只留 GLSL 前端、WGSL 后端、WGSL 前端（只给测试回读）和它们依赖的 IR、校验、`proc`；
- 顺手修掉上游「只开 `glsl-in` 编不过」的 cfg 遗漏。

嵌入前后，全部语料输出必须逐字节相同。

最后一步才是第一个行为补丁：死代码里残留的 `CallResult`。它让 WPE 自带的 `fluidsimulation_advection` 翻译失败。补丁只改这一个着色器的结果，基线上其余输出不变。

Tint 基线夹在中间：拿改动前的全部输出，在 dev app 里用浏览器的 WGSL 编译器过一遍。以后 P7b、P7c 新通过的着色器，再跟这份基线比。

## 现状锚点

**a. 语料测试只有默认 COMBO 与几个门槛**（`src-tauri/wpesl2wgsl/tests/corpus.rs:1`）
```rust
//! 1. 门槛：P1 样本（eagleflag / deep_space / beach）用到的着色器对按其材质的 COMBO 与纹理必须翻译通过；
//! 2. 基线：`assets/shaders`、`assets/effects`、`projects/defaultprojects` 下全部着色器对在默认 COMBO
//!    （只绑定 g_Texture0）下的通过率，按失败阶段与首条错误汇总，完整报告写到 `CARGO_TARGET_TMPDIR`。
// 现状：工坊 scene.pkg 里的着色器不在里面；场景实际用的 COMBO / 纹理格式 / 宏没有覆盖
```

**b. 成功的输出可以导出，但没有比较**（`tests/corpus.rs:38`）
```rust
/// `WPESL2WGSL_DUMP_DIR` 设了时，每次成功的翻译把生成的 GLSL / WGSL 写到这个目录（供人工审阅、前后逐字节比较）。
fn dump_dir() -> Option<PathBuf> {
    std::env::var_os("WPESL2WGSL_DUMP_DIR").map(PathBuf::from) // 现状：前后比较靠人工 diff 目录
}
```

**c. 语料扫描的翻译器直接交给编译管线**（`.claude/skills/kbp-tools/ts/corpus.test.ts:297`）
```ts
  const { Wpesl2wgsl } = await import(`${SRC}/wpesl2wgsl/index`);
  const translator = await Wpesl2wgsl.fromBytes(readFileSync(WASM)); // 现状：请求不留痕
  // …
      const bundle = await compileScene({ projectDir: dir, sceneAssets: [ASSETS], reader: nodeReader, translator, /* … */ });
```
前端按 `missing` 补头文件重试（`apps/wpe-scene/src/wpesl2wgsl/index.ts:186` `translateWithIncludes`），所以同一次编译会有「缺头文件」的中间请求，只有最后一次是完整的。

**d. naga 来自 crates.io**（`src-tauri/wpesl2wgsl/Cargo.toml`）
```toml
# wgsl-in 本身不用：naga 30.0.1 的 glsl-in 依赖 `front::interpolator`，而该模块只在
# spv-in / wgsl-in 下编译，只开 glsl-in 会编译失败；wgsl-in 依赖最少，用它补上。
naga = { version = "30", default-features = false, features = ["glsl-in", "wgsl-in", "wgsl-out"] }
```
上游 `src/front/mod.rs:5`：
```rust
#[cfg(any(feature = "spv-in", feature = "wgsl-in"))] // 现状：漏了 glsl-in
pub(crate) mod interpolator;
```

**e. 工作区成员**（根 `Cargo.toml`）：`src-tauri/wpesl2wgsl` 是成员；`Cargo.lock` 里依赖 `naga` 的只有它。wasm 由 `deno task build:wpesl2wgsl` 编到 `bin/wasm/wpesl2wgsl/`（现在 1 606 373 字节），kabegame 命令不带 `--skip vue` 时拷进前端。

## 步骤

### 步骤 1 — 请求夹具与逐字节基线

- **新增** kbp corpus 插件 `requests:<目录>`（`ts/corpus.test.ts`）：
  - 编译前给翻译器包一层，记录每次 `translate` 的请求；只留 `phase` 不是 `include` 的那次（头文件补齐后的最终请求）。
  - 按规范化 JSON 的 SHA-1 去重，写 `<目录>/<sha1>.json`：`{ name, scenes[], result: { ok, phase, firstError }, request }`。`scenes` 是用到它的全部场景。
  - `name` 是着色器名（`effects/…`、`workshop/<id>/effects/…`）：按源码内容在该场景的散文件、`scene.pkg`、WPE `assets/` 的 `shaders/` 下反查，查不到写 `?`。
  - 行字段只加一个计数 `requests`，不改 `unsupported`。
  > 说明：记录的是产品编译管线真实发出的请求，以后语料变了（P5、P6 合入新着色器）重扫一次即可。
- **修改** `tests/corpus.rs`，加第 3 部分「请求夹具」：
  - 环境变量 `WPESL2WGSL_REQUESTS` 指向夹具目录时，逐个反序列化成 `TranslateRequest` 重放；没设就跳过。
  - 报告按着色器名汇总，每条失败列出翻译器返回的**全部**错误（现在前端只截第一条前 100 字）。
  - 成功的照旧经 naga `wgsl-in` 回读校验，按 `<name>-<sha1 前 8 位>` 写进 `WPESL2WGSL_DUMP_DIR`。
  - 门槛：重放结果的 `ok` 必须与夹具里记录的一致（同一份 wasm 与原生应当相同）；不一致就失败。
- **修改** `tests/corpus.rs`，加基线比较：环境变量 `WPESL2WGSL_BASELINE_DIR` 指向一份旧的导出目录时，本次导出逐文件比较，报告「相同 / 变了 / 新通过 / 新失败 / 缺了」的计数与清单。
  - 「变了」「新失败」「缺了」非空时测试失败；
  - `WPESL2WGSL_BASELINE_ALLOW` 列出这一步预期会变的键（逗号分隔），这些不算失败，但仍列在报告里。
- **README**（`src-tauri/wpesl2wgsl/README.md`「测试」）：写清三个环境变量和建基线、比较的命令。

**验收：**
- 夹具里失败的着色器名集合，等于语料扫描（`ignore/p6/out/corpus-new.json` 同一份 HEAD 重扫）里 `shader:*` 的 48 个名字。
- 同一份 HEAD 连跑两次：夹具逐字节相同，第二次对第一次的基线比较全部「相同」。
- 现有两部分照旧：167 对通过 158 对、几何门槛 27/27。
- 基线导出到 `ignore/p7/baseline/head-<提交前 8 位>/`，提交号写进实施记录。

### 步骤 2 — Tint 基线

- **新增** `ignore/p7/tint.py`：把步骤 1 导出的全部 WGSL 列成清单，生成一段在应用页里跑的脚本，经 kabegame-dev MCP 的 `eval` 执行。
  - 页面经 vite 的 `/@fs/` 路径取 WGSL（`ignore/` 在工作区里，vite 允许）；
  - 每份前面加上产品渲染器同样的前言（`render/programs.ts` 里的 `diagnostic(off, derivative_uniformity)`），逐份 `device.createShaderModule` + `getCompilationInfo()`；
  - 结果写 `ignore/p7/out/tint-<基线名>.json`：每份的 error / warning 原文。
  > 说明：只用应用页里已有的 WebGPU 设备，不建窗口、不碰场景宿主；分批执行，避免一次 `eval` 太久。
- **验收：** 结果文件里 error 为 0（同 regression D5 的口径）。有 error 就先报告，不往下做；warning 原样记下。

### 步骤 3 — 嵌入 naga（不改行为）

- **新增** `src-tauri/wpesl2wgsl/naga/`：naga 30.0.1 的 crate 源码（取自 cargo registry，`Cargo.lock` 的校验和 `a616d2fb…`）。
  - 保留上游的 `LICENSE.MIT`、`LICENSE.APACHE`。
  - 新增同目录的 `KABEGAME.md`：上游版本与校验和、删掉的模块 / feature / 依赖清单、每处改动（文件、位置、理由），以及升级时怎么重新嵌入。
  - 改过的上游文件顶部加一行注释，说明「Kabegame 修改，见 KABEGAME.md」（MIT / Apache-2.0 的修改声明）。
- **删除**（照 naga-p7-frontend 第 4 节）：SPIR-V / MSL / HLSL / GLSL / dot 后端、SPIR-V 前端，以及只为它们存在的模块、feature 与依赖；`proc`、`valid`、`common`、`keywords`、`compact` 整块保留。上游自带的集成测试与基准不带进来，`src` 里的单测保留。
- **修改**：
  - `naga/src/front/mod.rs` 的 `interpolator` cfg 加上 `glsl-in`（一行）；
  - `naga/Cargo.toml`：包名仍是 `naga`、`publish = false`、不声明 `[workspace]`；
  - 翻译器的 `Cargo.toml`：`naga = { path = "naga", default-features = false, features = ["glsl-in", "wgsl-out"] }`，`wgsl-in` 挪到 `[dev-dependencies]`（只有语料测试回读用）；
  - `naga-types` 继续从 crates.io 取，钉 `=30.0.1`。
  ```toml
  [dependencies]
  # 修改：naga 源码嵌在本目录（naga/KABEGAME.md），只开 GLSL 前端与 WGSL 后端
  naga = { path = "naga", default-features = false, features = ["glsl-in", "wgsl-out"] }

  [dev-dependencies]
  # 新增：语料测试把输出的 WGSL 再解析一遍
  naga = { path = "naga", default-features = false, features = ["glsl-in", "wgsl-out", "wgsl-in"] }
  ```
- **README**：「内部流程」第 6 条与「测试」改成嵌入的 naga，链接 `naga/KABEGAME.md`；删掉「只开 `glsl-in` 编不过」那段说明。

**验收：**
- 对步骤 1 的基线逐字节相同，WPE 安装目录与请求夹具两部分都是；
- 翻译器单测、naga 保留下来的单测全过；`cargo clippy -p wpesl2wgsl` 不新增警告（嵌入的 naga 目录按上游原样，警告不算）；
- `deno task build:wpesl2wgsl` 能编出 wasm，体积前后对比写进实施记录；
- `Cargo.lock` 的变化只有 naga 从 registry 换成路径、以及被删掉的依赖。

### 步骤 4 — 死代码里的 `CallResult`（第一个行为补丁）

- **修改** `naga/src/front/glsl/`（naga-p7-frontend 第 3 节，约 +43 行）：前端裁掉 `return` 之后的死代码前，把 `Call` / `Atomic` 的结果表达式改成同类型的 `ZeroValue`。`KABEGAME.md` 记一条。
  > 说明：最小复现 `float g(float x) { return x; return f(x); }`。我们把 `min` 宏成用户函数 `kb_min`，`fluidsimulation_advection` 的死代码里就有这种调用。
- **新增** 单测：最小复现翻译通过；同一函数没有死代码时输出不变。
- **README**：「已知不支持」里没有这一条，不用删；「内部流程」第 6 条补一句嵌入的 naga 带了哪些行为补丁。

**验收：**
- 对步骤 3 的基线：只有 `effects/fluidsimulation_advection` 相关的键从失败变成通过（用 `WPESL2WGSL_BASELINE_ALLOW` 列出），其余逐字节相同；新通过的 WGSL 回读通过，并补跑一次 Tint（步骤 2 的脚本）。
- 语料扫描：`shader:effects/fluidsimulation_advection:*` 这个键消失。`3286859278` 仍被别的键挡着，能渲染数不变。

## 收尾

- **文档：**
  - `src-tauri/wpesl2wgsl/README.md`（测试、内部流程）；
  - `cocs/wpe/WPE_SCENE.md` 翻译器摘要加一句「naga 源码嵌在翻译器里」；
  - 总计划实施记录。
- **回归：** `versions/latest/regression.md` 的场景壁纸节加几条：请求夹具重放、逐字节基线、Tint 基线、嵌入前后不变。changelog 不写（用户看不到变化）。
- **并行约束：** 只改 `src-tauri/wpesl2wgsl/**` 与 kbp-tools。翻译器 wasm 被各会话共用：步骤 3、4 提交前必须过逐字节基线；重建 wasm 前看一次别的会话的状态。
- **实施方式：** 步骤 1、3、4 交给代理实现，我独立验收：查越界、跑测试、自己跑基线比较。步骤 2 我自己跑，要用 dev app。

## 决定

**已定：**
1. naga 源码嵌进翻译器，裁掉用不到的模块（2026-11-11 用户）。
2. 步骤 0 不另做（P7 步骤 0 已覆盖）。
3. **夹具的去重粒度：** 按完整请求的 SHA-1 去重，同一着色器在不同 COMBO 下的请求都保留（2026-11-11 用户）。
4. **`naga-types`：** 继续从 crates.io 取、钉 `=30.0.1`（2026-11-11 用户）。
5. **naga 的单测：** 保留 `src` 里的单测（含 `parser_tests.rs`），上游 `tests/` 的快照测试不带进来（2026-11-11 用户）。

## 风险

1. **夹具的名字反查不到：** 同一份源码在多处出现时取第一个；查不到写 `?`，不影响重放，只影响报告可读性。
2. **wasm 与原生结果不同：** 夹具记录的 `ok` 来自 wasm，测试跑原生。一旦不一致，说明翻译器有平台相关的行为，要先查清再往下。
3. **裁剪删多了：** 某个保留模块间接用到被删的东西时编不过，按编译错误补回来；逐字节基线保证行为不变。
4. **Tint 基线跑不完：** 上千份模块在应用页里逐个编译可能要几分钟，分批 `eval`；如果 dev 没在跑，步骤 2 推迟，不挡步骤 3、4。

## 实施记录

### 步骤 1 — 请求夹具与逐字节基线（2026-11-11，`3d4e4f84`）

- 代理实现，我独立重跑验收。
- **夹具：** 777 个请求（2074 次调用去重），215 个着色器（含别名 255），12.6 MB，在 `ignore/p7/requests`。开插件扫描的 `unsupported` 与不开时完全相同；两次扫描的夹具逐字节相同。
- **重放：** 通过 661、失败 116，`ok` 与夹具记录全部一致（前端 wasm 与源码同步），WGSL 回读失败 0。原有两部分不变：158/167、几何 27/27。
- **基线：** `ignore/p7/baseline/head-74b65d27`，3460 个文件（WPE 安装目录 816 + 夹具 2644）。重跑全部「相同」；改过的副本上验证了「变了」「新失败」会失败、ALLOW 内的不算。
- **偏离：**
  - 名字不按源码内容反查（工坊包常把同一个 effect 拷到别的目录，反查会取错），改成运行时包住产品的 `ShaderCompiler.translate` 取产品自己的名字；同一请求可能有几个名字，夹具多了 `names`。
  - 夹具里失败的名字 50 个，扫描的 `shader:*` 48 个：多出的 `workshop/2724617030/effects/Simple_Audio_Bars`、`workshop/3168465326/effects/color_grading__extension` 的 `visible` 绑了用户属性、当前值下关着，产品对关着的 effect 不报（`bundle.ts:1084`）。它们同样是 P7 要修的对象。
  - 多改了 kbp-tools 的 `py/corpus.py`（插件白名单）；语料测试里环境变量的相对路径改按仓库根解析。
- **我的失误：** 第一次提交把别的会话（P5a）对 kbp-tools `SKILL.md` 的改动一起带上了，推送前发现，撤回后只暂存自己的一行重新提交。

### 步骤 2 — Tint 基线（2026-11-11）

- 基线的 1730 份 WGSL 在 dev 主窗口里加产品前言逐份 `createShaderModule` + `getCompilationInfo`，约 12 s（`ignore/p7/tint.py`、`tint.js`，结果 `ignore/p7/out/tint-head-74b65d27.json`）。
- 请求夹具（真实场景）全部 0 error、0 warning。
- **2 个 error，都在几何门槛的合成组合上**：`geom__rope__refract`、`geom__ropetrail__refract` 的顶点段 `invalid aliased pointer argument`。几何段展开后 `ComputeScreenRefractionTangents` 收到同一个 `PS_INPUT` 变量两个字段的指针（`&v.v_ScreenCoord`、`&v.v_ScreenTangents`），Tint 按根变量判别名，naga 不判。P7 之前就有；语料里没有场景同时用绳子与折射，所以现在不影响能渲染数，有了就会整张退回。已登记到 P7b。

### 步骤 3 — 嵌入 naga（2026-11-11，`7811d87a`）

- 代理实现，我独立核对。naga 30.0.1 放进 `src-tauri/wpesl2wgsl/naga/`（109 个文件），`src` 11.9 万行 → 6.2 万行；删掉 SPIR-V / MSL / HLSL / GLSL / dot 后端与 SPIR-V 前端、对应 feature 和 `petgraph` / `spirv` 依赖。
- 8 个上游文件有改动，我逐个和 registry 原件对过：只有删 cfg 分支、删模块声明、加修改声明与 interpolator 那一行；其余 101 个文件逐字节相同。
- 验收：基线 3460 个全部相同；翻译器单测 55 个、naga 单测 127 个全过（naga 单测要带 `glsl-in,wgsl-in,wgsl-out,stderr`，上游原本如此）；wasm 1 606 373 → 1 600 789 字节。
- 根 `Cargo.toml` 加了 `[profile.dev.package.naga]`：嵌入的 naga 自动成为工作区成员，`*` 覆盖不到。我试过放进 `exclude`，仍是成员，已还原。`Cargo.lock` 因此多了 naga 自己单测用的 `diff`、`strum 0.28` 等，只在测试 naga 时编译。`deno task test` 只按 `-p` 测组件，不受 naga 单测的 feature 要求影响。

### 步骤 4 — 死代码里的 `CallResult`（2026-11-11）

- 代理实现，我独立核对。`Context::cull_dead`：GLSL 前端裁掉终结语句之后的死代码前，把其中 `Call` / `Atomic` 的结果表达式改成同类型的 `ZeroValue`，三处 `body.cull(idx..)` 改调它。naga 源码 +69/−3，`KABEGAME.md` 新开「行为补丁」一节。
- 单测：naga `dead_code_call_result`（6 种变体）、翻译器 `dead_code_after_return_is_dropped`（有无死代码两份 WGSL 逐字节相同）；临时关掉补丁时两个都失败。
- 验收：对 `head-74b65d27` 基线相同 3460、变了 0、新失败 0，新通过 8 个文件，全是 `effects/fluidsimulation_advection` 的两个请求（ALLOW `effects/fluidsimulation_advection-`）；夹具通过 661 → 663、失败的着色器 44 → 43；WPE 安装目录部分仍 158/167（默认 COMBO 下它本来就通过）；单测 56 / 128 全过；新通过的 4 份 WGSL 补跑 Tint 0 error。
- 偏离：语料测试原先把「夹具 ok 与重放不一致」一律算失败，ALLOW 管不到；扩成只放过「夹具失败、重放通过、键在 ALLOW 里」这一种。
