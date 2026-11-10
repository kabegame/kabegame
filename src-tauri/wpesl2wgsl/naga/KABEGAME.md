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

除下面「改动」列出的文件外，`src/` 下保留的文件与上游逐字节相同（LF）。改过的文件顶部有一行 `// Kabegame 修改，见 KABEGAME.md`（`Cargo.toml` 是 `#` 注释）。

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

所有改动都只是删掉被删模块的声明与 cfg 分支，不改任何保留代码的行为（翻译器的逐字节基线验证过，见「升级」）。唯一的例外是第 1 条，它修好了上游的编译错误。

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

## 构建与测试

- 翻译器依赖：`naga = { path = "naga", default-features = false, features = ["glsl-in", "wgsl-out"] }`；`[dev-dependencies]` 再开 `wgsl-in`，供测试回读。根 `Cargo.toml` 是 resolver 2，dev 依赖的 feature 不进 wasm。
- 本目录在仓库工作区里，作为路径依赖自动成为**工作区成员**：
  - 根 `Cargo.toml` 的 `[profile.dev.package."*"]` 覆盖不到它，所以另有 `[profile.dev.package.naga]`（opt-level 2），否则语料测试会慢很多；
  - 它的可选依赖（`serde`、`arbitrary`、`termcolor`）与 dev 依赖（`diff`、`strum` 0.28）也会进 `Cargo.lock`，但不开 feature 时不编译。
- 跑保留下来的上游单测（127 个）：

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
   - 其余各条靠编译器找：删掉 feature 后，`cargo check -p naga --features glsl-in,wgsl-in,wgsl-out` 的 `unexpected_cfgs` 警告与找不到模块的错误会点出每一处；
   - 改过的文件顶部补上修改声明，更新本文件的上游版本、校验和与改动表。
6. 同步 `naga-types` 的版本钉（`=<版本>`）。
7. 验收：
   - 对第 1 步的基线逐字节比较（`WPESL2WGSL_BASELINE_DIR`）；升级可能本来就改变输出，变了的要逐个说明原因；
   - `cargo test -p wpesl2wgsl --lib`、上面的 naga 单测全过；
   - `cargo clippy -p wpesl2wgsl` 翻译器自身不新增警告；
   - wasm 体积前后对比（`--profile wpesl2wgsl`）。
