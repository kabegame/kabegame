# Phase 0 — Spike & 构建落地(逐点实施方案)

> **完成情况(2026-06-29 核对)**:点 1–4 已落地(`Cargo.toml` deno_core 依赖、`v8.rs` 骨架 + 测试、`mod.rs` 注册),
> 与本文一致。核对中发现并修复一个**构建阻断**(见下「点 5」):op2 宏的 `reentrancy_check` 在本仓
> dev profile 下找不到符号(E0425)。修复后 `v8.rs` 单独编译通过(`cargo check`)。
> 仅剩**与 V8 无关**的既有 WIP 编译错误(`emitter.rs`/`crawler/downloader/queue.rs` 的 emitter 方法 arity
> 不匹配,来自 HEAD "ref: setting backend unification" 重构未收尾),导致整库 `cargo check` 暂不能整体过、
> v8 测试用例尚未实跑。该 WIP 不在本计划范围内。

> 对应总 plan [`v8-runtime-master-plan.md`](./v8-runtime-master-plan.md) 的 **Phase 0**。
> 目标:验证 `deno_core`(rusty_v8 0.405)在桌面三平台可接入、可构建,并跑通最小契约 ——
> **一个 async op + `export async function crawl(...)` + event-loop 驱动 Promise 到完成并取回返回值**。
> 本期产物全部落在 `kabegame-core`,**留下 Rust `#[cfg(test)]` 测试模块**作为退出标准的可执行证据。
>
> 平台门控:仅桌面(`cfg(not(any(target_os = "android", target_os = "ios")))`);
> Android 保留 Rhai 后端(决策 D2)。

---

## 边界与非目标(本期不做)

- **不**实现真正的 host op 层(`to / query / download_image / plugin_data ...`)—— 那是 Phase 1。
- **不**接 `OpState` 装配(`DownloadQueue` / task_id / cancellation)—— Phase 1。
- **不**做 prelude 正式版、snapshot、ModuleLoader 解析 SDK/node_modules —— Phase 2(本期入口模块**无 import**,自包含)。
- **不**接调度层 `script_type` 分发 —— Phase 4。
- 本期唯一的 op `op_kabegame_echo` 是**占位探针**:只为证明 `await __kabegame_echo(x)` 能真正驱动 event loop、异步 op 能回到 JS。Phase 1 起删除。

---

## 现状锚点

**a. `kabegame-core` 依赖清单**(`src-tauri/kabegame-core/Cargo.toml:43`)

```toml
# 桌面端使用 native-tls，移动端使用 rustls
[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
reqwest = { version = "0.11", features = [ "blocking", "gzip", "json", "stream", "native-tls" ] }
# 桌面端删除原始文件时移入系统回收站（可恢复）；Android/iOS 不支持，单独处理。
trash = "5"
# 进程内 FFmpeg：视频预览压缩 + 维度读取（Android 走 Kotlin provider，无需）。
rsmpeg = { workspace = true }
# 现状:桌面 target 块到此为止,没有 deno_core
```

**b. plugin 模块声明**(`src-tauri/kabegame-core/src/plugin/mod.rs:1`)

```rust
pub mod metadata_migration;
pub mod rhai;
// 现状:只有 rhai / metadata_migration 两个子模块,没有 v8 后端
```

**c. dev-dependencies**(`src-tauri/kabegame-core/Cargo.toml:112`)

```toml
[dev-dependencies]
tempfile = "3"
# 现状:没有 tokio 的测试宏入口(tokio 在主 deps,features = ["full"] 已含 macros/rt)
```

> 说明:`tokio` 已在主 `[dependencies]` 以 `features = ["full"]` 引入(`Cargo.toml:35` + workspace),
> `#[tokio::test]` 与 current-thread runtime 可直接用,无需新增 dev-dep。

**d. deno_core 0.405 关键 API(来自 `~/code/deno/libs/core`,已核对)**

```text
extension!(name, ops = [...])                                   // 声明扩展 + 注册 ops
#[op2(async)] #[serde] async fn op_x(#[serde] v: Json) -> Json  // async op,serde 出入参
JsRuntime::new(RuntimeOptions { extensions, module_loader, .. })
rt.load_main_es_module_from_code(&specifier, code).await -> ModuleId   // 自包含、无需 loader
rt.mod_evaluate(id) / rt.run_event_loop(Default::default()).await
rt.get_module_namespace(id) -> v8::Global<v8::Object>
rt.call_with_args(&func, &[arg]) + rt.with_event_loop_promise(call, opts).await
deno_core::scope! { ... } / deno_core::serde_v8::{to_v8, from_v8}
deno_core::resolve_url(..)   deno_core::anyhow (re-export)
```

---

## 点 1 — 引入 `deno_core` 依赖(桌面门控)(`Cargo.toml`)

- **修改**
  - 在桌面 target 块 `cfg(not(any(target_os = "android", target_os = "ios")))` 末尾追加 `deno_core`。
    > 说明:与 reqwest/trash/rsmpeg 同门控;**绝不**进 Android/iOS 块(rusty_v8 交叉编译/体积代价大,D2)。
    > 版本对齐 `~/code/deno` 当前 `deno_core = "0.405.0"`,便于直接对照其 `libs/core` 源。

```toml
[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]
reqwest = { version = "0.11", features = [ "blocking", "gzip", "json", "stream", "native-tls" ] }
trash = "5"
rsmpeg = { workspace = true }
# Phase 0（V8_RUNTIME）：嵌入式 V8 (deno_core/rusty_v8) 插件运行时 —— 仅桌面接入。
# Android 保留 Rhai 后端；二进制增量 ~30–40MB（rusty_v8 预编译产物）。
# 打包/strip/动态库流程参照 cocs/build/PLATFORM_SHARED_LIBS.md。
deno_core = "0.405"   # 新增
```

> 关注点(总 plan 风险项):rusty_v8 会拉预编译 `librusty_v8` 静态库(下载 ~30–40MB),
> 首次 `cargo check` 会触发下载;CI 三平台需保证可访问其 release 资源。serde_v8 / anyhow 由 deno_core 传递,无需单列。

---

## 点 2 — 新增最小运行时 `v8.rs`(`src-tauri/kabegame-core/src/plugin/v8.rs`,**新建**)

- **新增**
  - 占位 async op `op_kabegame_echo`:`#[op2(async)]`,serde 出入参,原样异步回显。
    > 说明:唯一目的——证明 `await` 一个异步 op 能驱动 event loop 并把值送回 JS。Phase 1 删除。
  - `extension!(kabegame_v8, ops = [op_kabegame_echo])`:本期唯一扩展。
  - `JsPluginRuntime`:薄封装 `JsRuntime`;`new()` 装配扩展 + 注入极简 prelude
    (`globalThis.__kabegame_echo = (x) => Deno.core.ops.op_kabegame_echo(x)`),
    `run_crawl(entry_code, args)` 负责加载自包含模块 → 取 `export crawl` → 调用 → 驱动 Promise → 反序列化返回。
    > 说明:prelude 仅为 Phase 0 探针服务,**非** Phase 2 正式 prelude;入口模块无 import,故 `module_loader` 留空。
  - `#[cfg(test)]` 测试模块(见点 4)。

```rust
//! Phase 0 spike：嵌入式 V8 (deno_core) 插件运行时**最小骨架**。
//!
//! 仅验证 deno_core 在桌面可接入/可构建，并跑通最小契约：
//!   一个 async op + `export async function crawl(...)` + event-loop 驱动 Promise 到完成。
//! 真正的 host op 层 / OpState 装配 / 正式 prelude / snapshot / 调度集成见后续 Phase。
//!
//! 平台门控：仅桌面（非 Android/iOS），Android 保留 Rhai 后端（决策 D2）。

use deno_core::{
    anyhow::{anyhow, Result},
    extension, op2, resolve_url, serde_v8, v8, JsRuntime, PollEventLoopOptions, RuntimeOptions,
};
use serde_json::Value as JsonValue;

/// Phase 0 占位 op：把入参 JSON 原样**异步**回显。
///
/// 唯一作用：让测试里的 `await __kabegame_echo(x)` 真正经过 event loop 再返回，
/// 证明 async op 通道（Rust↔JS 异步边界）成立。Phase 1 起删除，换成真实 `op_kabegame_*`。
#[op2(async)]
#[serde]
async fn op_kabegame_echo(#[serde] input: JsonValue) -> JsonValue {
    input
}

extension!(
    kabegame_v8,
    ops = [op_kabegame_echo],
    docs = "Phase 0 spike extension：仅含一个占位 echo op。",
);

/// 入口模块 specifier（本期为内存代码，无磁盘文件、无 import）。
const ENTRY_SPECIFIER: &str = "file:///crawl.v8.js";

/// 极简 prelude：把裸 op 挂到 `globalThis.__kabegame_*`。
///
/// 注意：这是 Phase 0 探针级 prelude，仅暴露 echo。Phase 2 才有正式的全量
/// `globalThis.__kabegame_* = Deno.core.ops.op_kabegame_*` 映射。
const PRELUDE: &str = r#"
globalThis.__kabegame_echo = (x) => Deno.core.ops.op_kabegame_echo(x);
"#;

/// 嵌入式 V8 插件运行时（Phase 0 最小骨架）。
///
/// 每个实例持有一个独立 `JsRuntime`（≈ 一个 V8 isolate）。Phase 7 再谈 per-task
/// 超时 / heap limit / 沙箱加固；本期只关注「能接入、能构建、能跑完一次 crawl」。
pub struct JsPluginRuntime {
    runtime: JsRuntime,
}

impl JsPluginRuntime {
    /// 装配扩展并注入 Phase 0 prelude。
    pub fn new() -> Result<Self> {
        let mut runtime = JsRuntime::new(RuntimeOptions {
            // 入口自包含（无 import），无需 ModuleLoader。
            module_loader: None,
            extensions: vec![kabegame_v8::init()],
            ..Default::default()
        });
        // prelude 同步执行，必须先于模块加载，使模块内可引用 globalThis.__kabegame_*。
        runtime.execute_script("kabegame:prelude", PRELUDE)?;
        Ok(Self { runtime })
    }

    /// 加载自包含入口模块 `crawl.v8.js`，取 `export async function crawl`，
    /// 以 `args` 调用，驱动 event loop 直到其 Promise 完成，返回反序列化后的结果。
    pub async fn run_crawl(&mut self, entry_code: String, args: JsonValue) -> Result<JsonValue> {
        // 1) 加载并求值入口模块。
        let specifier = resolve_url(ENTRY_SPECIFIER)?;
        let mod_id = self
            .runtime
            .load_main_es_module_from_code(&specifier, entry_code)
            .await?;
        let eval = self.runtime.mod_evaluate(mod_id);
        self.runtime
            .run_event_loop(Default::default())
            .await?;
        eval.await?;

        // 2) 从模块 namespace 取出 `crawl` 函数（v8::Global）。
        let namespace = self.runtime.get_module_namespace(mod_id)?;
        let crawl_fn: v8::Global<v8::Function> = {
            deno_core::scope!(scope, &mut self.runtime);
            let ns = v8::Local::new(scope, namespace);
            let key = v8::String::new(scope, "crawl")
                .ok_or_else(|| anyhow!("alloc 'crawl' key failed"))?;
            let value = ns
                .get(scope, key.into())
                .ok_or_else(|| anyhow!("module has no `crawl` export"))?;
            let func = v8::Local::<v8::Function>::try_from(value)
                .map_err(|_| anyhow!("`crawl` export is not a function"))?;
            v8::Global::new(scope, func)
        };

        // 3) 把 args 转成 v8 值。
        let arg: v8::Global<v8::Value> = {
            deno_core::scope!(scope, &mut self.runtime);
            let local = serde_v8::to_v8(scope, args)?;
            v8::Global::new(scope, local)
        };

        // 4) 调用 crawl(args)，驱动 event loop 直到返回的 Promise settle。
        let call = self.runtime.call_with_args(&crawl_fn, &[arg]);
        let result = self
            .runtime
            .with_event_loop_promise(call, PollEventLoopOptions::default())
            .await?;

        // 5) 反序列化返回值为 serde_json::Value。
        let value: JsonValue = {
            deno_core::scope!(scope, &mut self.runtime);
            let local = v8::Local::new(scope, result);
            serde_v8::from_v8(scope, local)?
        };
        Ok(value)
    }
}
```

> 核对要点(对照 `~/code/deno/libs/core/examples/op2.rs` + `jsruntime.rs`):
> - `load_main_es_module_from_code(&ModuleSpecifier, code)`(`jsruntime.rs:3186`)→ `mod_evaluate`(`:3164`)→ `run_event_loop`(`:2311`)。
> - `get_module_namespace`(`:2166`)需在模块求值后调用。
> - `call_with_args`(`:2076`)返回 Future,需配 `with_event_loop_promise`(`:2322`)才会推进。
> - `scope!` 是 `#[macro_export]`(`jsruntime.rs:701`),以 `deno_core::scope!` 使用;`serde_v8` / `anyhow` / `v8` 均由 deno_core re-export。

---

## 点 3 — 注册 `v8` 子模块(桌面门控)(`src-tauri/kabegame-core/src/plugin/mod.rs`)

- **修改**
  - 在 `pub mod rhai;` 后追加桌面门控的 `pub mod v8;`。
    > 说明:与 Cargo 依赖门控一致,避免 Android 编译触达 deno_core。

```rust
pub mod metadata_migration;
pub mod rhai;
// Phase 0：嵌入式 V8 后端，仅桌面（Android 保留 Rhai）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod v8;   // 新增
```

---

## 点 4 — Rust 测试模块(留在 `v8.rs`，退出标准的可执行证据)

- **新增**
  - `#[cfg(test)] mod tests`,含两条用例,覆盖 Phase 0 退出标准。
    > 说明:V8 isolate 非 `Send`,用 `#[tokio::test]`(默认 current-thread runtime)在单线程上驱动 event loop。
    > tokio 已在主 deps(`features = ["full"]`),无需新增 dev-dependency。

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 退出标准①:能加载自包含模块、取 `export async function crawl`、
    /// `await` 一个异步 op、并把返回值送回 Rust。
    #[tokio::test]
    async fn run_crawl_awaits_async_op_and_returns_value() {
        let entry = r#"
            export async function crawl(input) {
                // 经过真实异步 op 往返一圈，证明 event loop 被驱动。
                const echoed = await __kabegame_echo({ seen: input.n });
                return { doubled: input.n * 2, echoed };
            }
        "#
        .to_string();

        let mut rt = JsPluginRuntime::new().expect("runtime init");
        let out = rt
            .run_crawl(entry, json!({ "n": 21 }))
            .await
            .expect("crawl should resolve");

        assert_eq!(out["doubled"], 42);
        assert_eq!(out["echoed"]["seen"], 21);
    }

    /// 退出标准②:缺少 `crawl` 导出时给出明确错误（而非 panic / 静默）。
    #[tokio::test]
    async fn run_crawl_errors_when_export_missing() {
        let entry = "export const notCrawl = 1;".to_string();
        let mut rt = JsPluginRuntime::new().expect("runtime init");
        let err = rt
            .run_crawl(entry, json!({}))
            .await
            .expect_err("missing crawl export must error");
        assert!(err.to_string().contains("crawl"));
    }
}
```

---

## 点 5 — 修复 op2 宏在本仓 dev profile 下的 `reentrancy_check` 链接(`根 Cargo.toml`)

> 核对 Phase 0 时实测发现:`#[op2]` 的 async op 在本仓 `cargo check` 报
> `E0425: cannot find function reentrancy_check in module deno_core::_ops`(`v8.rs:20`)。

### 现状锚点(`根 Cargo.toml:83`)

```toml
# dev/debug 构建下，把所有第三方依赖按 opt-level 2 编译……
[profile.dev.package."*"]
opt-level = 2
debug-assertions = false   # 现状:对所有依赖(含 deno_core)关掉 debug_assertions
overflow-checks = false
```

### 根因

- deno_ops 0.281.0 宏在**调用方**(kabegame-core)生成的代码是
  `#[cfg(debug_assertions)] let _g = deno_core::_ops::reentrancy_check(...)`(`dispatch_async.rs:197`)。
- deno_core 0.405.0 **仅在** `#[cfg(debug_assertions)]` 下 `pub use ... reentrancy_check`(`lib.rs:233`)。
- 两个 `cfg(debug_assertions)` 在**各自 crate 的编译上下文**求值:
  - kabegame-core(工作区成员,dev profile)→ `debug_assertions = on` → **发出调用**;
  - deno_core(被 `[profile.dev.package."*"]` 命中)→ `debug_assertions = off` → **不导出符号**。
  - → 调用一个未导出的符号 ⇒ E0425。release 下两侧同为 off,一致,无此问题。

### 实施方案

- **修改**
  - 给 deno_core 单独恢复 dev 的 `debug_assertions`,使调用点与导出点一致。
    > 说明:`package.<name>` 比 `package."*"` 更具体,覆盖之;只影响 deno_core 一个包。

```toml
[profile.dev.package."*"]
opt-level = 2
debug-assertions = false
overflow-checks = false

# deno_core 的 op2 宏在调用方按 `#[cfg(debug_assertions)]` 生成 `_ops::reentrancy_check`
# 调用，而 deno_core 仅在 debug_assertions 下导出该符号。上面的 `*` 覆盖会把 deno_core 的
# debug_assertions 关掉，导致工作区成员（debug_assertions=on）调用一个未导出的符号（E0425）。
# 给 deno_core 单独恢复 debug_assertions，使调用点与导出点一致。release 下两侧同为 off，无此问题。
[profile.dev.package.deno_core]   # 新增
debug-assertions = true
```

> 验证:加此覆盖后 `cargo check -p kabegame-core --lib` 中 `v8.rs` 的 E0425 消失(已实测)。

---

## 验证(遵循 CLAUDE.md:不跑全量 build)

- **lint / check**:`bun check -c kabegame --skip vue`(= `cargo check`)在三桌面平台通过。
  > rusty_v8 首次会下载预编译静态库;CI 需放行其 release 域名。
- **单测**:`cargo test -p kabegame-core --lib plugin::v8`(显式运行,验证退出标准;
  非 CLAUDE.md 所指「全量 build」)。两条用例均绿即满足 Phase 0 退出标准:
  - ① 最小骨架能 `await` 异步 op 并取回 `crawl` 返回值;
  - ② 契约错误路径有明确报错。
- **不**做:`cargo build` / 打包 / 三平台二进制体积实测 —— 体积/打包留到接入打包链时按
  `cocs/build/PLATFORM_SHARED_LIBS.md` 评估(总 plan 风险项,非 Phase 0 退出闸)。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 修改 | `src-tauri/kabegame-core/Cargo.toml` | 桌面 target 块新增 `deno_core = "0.405"` |
| 新增 | `src-tauri/kabegame-core/src/plugin/v8.rs` | `op_kabegame_echo` + `kabegame_v8` ext + `JsPluginRuntime` + 测试模块 |
| 修改 | `src-tauri/kabegame-core/src/plugin/mod.rs` | 桌面门控 `pub mod v8;` |
| 修改 | `根 Cargo.toml` | 新增 `[profile.dev.package.deno_core] debug-assertions = true`(点 5) |

---

## 衔接下一步(Phase 1 预告)

- 删除 `op_kabegame_echo`/探针 prelude,换成真实 `op_kabegame_*` 全量 op(对齐 `docs/RHAI_API.md`)。
- `RuntimeOptions` 装配 `OpState`(`DownloadQueue` / plugin_id / task_id / cancellation token / header map)。
- 入口从「内存代码」改为加载 `.kgpg` 内自包含 `crawl.v8.js`(Phase 2 契约),并接 snapshot。
