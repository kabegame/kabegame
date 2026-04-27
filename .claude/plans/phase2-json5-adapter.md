# Phase 2 详细计划 — json5 适配器（pathql-rs feature）

## Context

承接 [Phase 1](./phase1-dsl-ast-loader.md) 的成果：`pathql-rs` crate 已有完整 AST + 抽象 `Loader` trait + `ProviderRegistry`，并能用 `serde_json` 反序列化手工预处理的 strict-JSON fixture。

Phase 2 的目标是给 `pathql-rs` 加上 **json5 适配器**——也就是为 `Loader` trait 提供一个具体实现 `Json5Loader`，用 `json5` crate 反序列化真 `.json5`（含注释、trailing comma、单引号等 json5 语法）。仅此而已。

**Phase 2 不做的事**：
- ❌ **不做**目录扫描 / 文件发现（`discover_dir` / `walkdir` 之类）
- ❌ **不引入** `walkdir` 依赖
- ❌ **不在** pathql-rs 内做任何文件系统遍历

理由：pathql-rs 是格式 / IO 双解耦的 DSL 引擎；实际加载策略由消费者（`kabegame-core`）决定。
**消费者侧（Phase 6）会用 `include_dir!()` 宏在编译期把 `src-tauri/core/src/providers/` 嵌入二进制，
运行期遍历 embedded entries 把每份字节喂给 `Json5Loader::load(Source::Bytes)` 再 `Registry::register`**——这是
最终的加载流水线；pathql-rs 只暴露其中两个原语。

约束：
- `kabegame-core` 仍**不**引用 `pathql-rs`（隔离推迟到 Phase 6）
- json5 反序列化逻辑**仅**在 `feature = "json5"` 下编译；默认 feature 关闭，使用方按需启用
- `Json5Loader` 自身是 unit struct，零状态

---

## 锁定的设计选择

1. **json5 crate 选择**：用社区 `json5 = "0.4"`（serde 兼容；通过 `json5::from_str::<T>(&str)` 反序列化）。注意 v0.4 是当前主流版本。
2. **错误映射策略**：`json5::Error::Message { msg, location: Option<Location> }` → `LoadError::Syntax { path, line, col, msg }`。json5 v0.4 错误粒度有限（只有 `Message` 一个 variant），所有错误统一走 `Syntax`；缺字段 / 类型错也都被 json5 包成消息字符串。
3. **`Json5Loader` 处理 `Source` 三态**：
   - `Source::Str(s)` → 直接 `json5::from_str(s)`（核心路径，include_dir 配 `as_str()` 用）
   - `Source::Bytes(b)` → utf-8 校验 → 同 `Source::Str`（include_dir 配 `contents()` 用）
   - `Source::Path(p)` → `fs::read_to_string(p)` → 同 `Source::Str`（便于 dev 测试 / 命令行工具用；不是核心路径但保留）
4. **不引入新依赖到 workspace**：仅 `pathql-rs` 自身依赖 `json5`，且是 `optional = true` 仅在 `json5` feature 下生效。
5. **测试用法**：单测构造 `Source::Str(...)` 字符串字面量；集成测试用 `Source::Path` 直接读 `core/src/providers/**/*.json5` 验证整套流水线，但 **不**做目录递归——而是测试代码硬编码文件路径列表逐个加载。

---

## 测试节奏

**每完成一个子任务就立即跑一次 `cargo test -p pathql-rs --features json5`**——不要积攒。
每个子任务自带「测试要点」与「Test」节点。

---

## 子任务拆解

### S1. 启用 json5 feature 与依赖

修改 `src-tauri/pathql-rs/Cargo.toml`：

```toml
[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
json5 = { version = "0.4", optional = true }

[features]
default = []
json5 = ["dep:json5"]

[dev-dependencies]
serde_json = { workspace = true }
```

如根 [`Cargo.toml`](../../Cargo.toml) 还没 `json5`，加进 `[workspace.dependencies]`：

```toml
json5 = "0.4"
```

然后在 pathql-rs 改用 `json5 = { workspace = true, optional = true }`。

**测试要点**：无；本步只确认 feature 开关编译。

**Test**：
- `cargo check -p pathql-rs` —— 默认 feature 关，通过
- `cargo check -p pathql-rs --features json5` —— feature 开，但还没用到 json5 模块，预期通过（dep 引入未使用是 warning 不是 error）

---

### S2. adapters 模块脚手架

新建 `src-tauri/pathql-rs/src/adapters/mod.rs`：

```rust
//! 格式适配器集合。每个子模块由 feature 开关控制。

#[cfg(feature = "json5")]
pub mod json5;

#[cfg(feature = "json5")]
pub use json5::Json5Loader;
```

新建**占位** `src-tauri/pathql-rs/src/adapters/json5.rs`：

```rust
//! json5 格式 Loader 适配器（实现见 S3）。

#[derive(Debug, Clone, Copy, Default)]
pub struct Json5Loader;
```

更新 `src-tauri/pathql-rs/src/lib.rs`：

```rust
pub mod ast;
pub mod loader;
pub mod registry;
pub mod adapters;  // 新增

pub use ast::*;
pub use loader::{Loader, LoadError, Source};
pub use registry::{ProviderRegistry, RegistryError};

#[cfg(feature = "json5")]
pub use adapters::Json5Loader;
```

**测试要点**：模块结构能编译。

**Test**：
- `cargo check -p pathql-rs --features json5` —— 通过
- `cargo test -p pathql-rs --features json5` —— Phase 1 单测全绿（feature 开关不影响 ast 模块）

---

### S3. Json5Loader 实现

完善 `src-tauri/pathql-rs/src/adapters/json5.rs`：

```rust
use std::fs;
use std::path::PathBuf;

use crate::ast::ProviderDef;
use crate::loader::{LoadError, Loader, Source};

/// json5 格式 Loader 适配器；零状态。
#[derive(Debug, Clone, Copy, Default)]
pub struct Json5Loader;

impl Loader for Json5Loader {
    fn load(&self, source: Source<'_>) -> Result<ProviderDef, LoadError> {
        let (text, path) = match source {
            Source::Path(p) => {
                let text = fs::read_to_string(p).map_err(|e| LoadError::Io {
                    path: p.to_path_buf(),
                    source: e,
                })?;
                (text, Some(p.to_path_buf()))
            }
            Source::Str(s) => (s.to_string(), None),
            Source::Bytes(b) => {
                let text = std::str::from_utf8(b)
                    .map_err(|e| LoadError::Type {
                        path: None,
                        msg: format!("invalid utf-8: {}", e),
                    })?
                    .to_string();
                (text, None)
            }
        };

        ::json5::from_str::<ProviderDef>(&text).map_err(|e| map_json5_error(e, path))
    }
}

fn map_json5_error(e: ::json5::Error, path: Option<PathBuf>) -> LoadError {
    match e {
        ::json5::Error::Message { msg, location } => LoadError::Syntax {
            path,
            line: location.as_ref().map(|l| l.line as u32),
            col: location.as_ref().map(|l| l.column as u32),
            msg,
        },
    }
}
```

**注意**：`json5` crate 名字与本模块同名 → 调用时用 `::json5::` 绝对路径避免歧义；或者在 mod 里 rename 模块。

**测试要点**（`adapters/json5.rs` 内 `#[cfg(test)]`）：

构造 `Source::Str` 字符串字面量为输入：

| 测试名 | 输入 | 期望 |
|---|---|---|
| `loads_minimal` | `{"name":"foo"}` | `ProviderDef { name: "foo", .. }` |
| `loads_with_comments` | `// 注释\n{"name":"foo"}` | 同上（注释被丢弃） |
| `loads_with_trailing_comma` | `{"name":"foo","namespace":"k",}` | 解析成功 |
| `loads_with_single_quotes` | `{'name':'foo'}` | 解析成功（json5 单引号合法） |
| `loads_realistic_router` | 多行 .json5 含 query/list/resolve | 各字段命中 |
| `syntax_error_unclosed_brace` | `{` | `LoadError::Syntax { line: Some(_), .. }` |
| `syntax_error_invalid_token` | `{xxx}` | `LoadError::Syntax` |
| `missing_required_field` | `{}` | `LoadError::Syntax`（json5 把 serde missing field 包成 Message） |
| `bytes_utf8_ok` | `Source::Bytes(b"{\"name\":\"foo\"}")` | 成功 |
| `bytes_invalid_utf8` | `Source::Bytes(&[0xff, 0xfe, 0xfd])` | `LoadError::Type` |
| `path_not_found` | `Source::Path(Path::new("/no/such/file.json5"))` | `LoadError::Io { source: ENOENT, .. }` |
| `path_loads_real_file` | `Source::Path` 指向临时文件 | 成功；error 信息含 path |
| `trait_object_works` | `Box<dyn Loader>` 装箱后调 `load` | 正常工作 |

行列号验证：构造一个第 3 行第 5 列出错的输入，断言 `Syntax { line: Some(3), col: Some(5), .. }`（实际数值需先 spike json5 v0.4 行列号是 1-based 还是 0-based；测试里写 `>= 1` 兼容两种）。

**Test**：`cargo test -p pathql-rs --features json5 adapters::json5`。

---

### S4. 集成测试：加载 9 个真 provider 文件 → Registry

新建 `src-tauri/pathql-rs/tests/load_real_providers.rs`：

```rust
//! 端到端：用 Json5Loader 把真实 src-tauri/core/src/providers/**/*.json{,5}
//! 一份一份喂给 Loader, 再 register 到 ProviderRegistry。
//!
//! 这模拟 Phase 6 中 kabegame-core 用 include_dir 嵌入 + 运行期注册的
//! 完整流程, 但用 std::fs::read_to_string + 硬编码文件列表驱动
//! (pathql-rs 自身不做目录扫描)。

#![cfg(feature = "json5")]

use std::path::PathBuf;

use pathql_rs::{
    Json5Loader, Loader, Namespace, ProviderName, ProviderRegistry, Source,
};

/// 硬编码当前所有 provider 文件的相对路径（相对 core/src/providers/）。
/// 新增 provider 时同步此列表。
const PROVIDER_FILES: &[&str] = &[
    "root_provider.json",
    "gallery/gallery_route.json5",
    "gallery/gallery_all_router.json5",
    "gallery/gallery_paginate_router.json5",
    "gallery/gallery_page_router.json5",
    "shared/page_size_provider.json5",
    "shared/query_page_provider.json5",
    "vd/vd_root_router.json5",
    "vd/vd_zh_CN_root_router.json5",
];

fn providers_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("core")
        .join("src")
        .join("providers")
}

fn build_registry() -> ProviderRegistry {
    let loader = Json5Loader;
    let dir = providers_dir();
    let mut registry = ProviderRegistry::new();

    for rel in PROVIDER_FILES {
        let path = dir.join(rel);
        let def = loader
            .load(Source::Path(&path))
            .unwrap_or_else(|e| panic!("load {}: {}", rel, e));
        registry
            .register(def)
            .unwrap_or_else(|e| panic!("register {}: {}", rel, e));
    }
    registry
}

#[test]
fn loads_all_existing_providers() {
    let r = build_registry();
    assert_eq!(r.len(), PROVIDER_FILES.len());
}

#[test]
fn root_provider_routes_to_gallery_and_vd() {
    let r = build_registry();
    let root_ns = Namespace("kabegame".into());
    let root = r
        .resolve(&root_ns, &ProviderName("root_provider".into()))
        .expect("root_provider");
    let list = root.list.as_ref().expect("root list");
    let names: Vec<&str> = list.entries.iter().map(|(k, _)| k.as_str()).collect();
    assert!(names.contains(&"gallery"));
    assert!(names.contains(&"vd"));
}

#[test]
fn gallery_route_resolves_in_namespace_chain() {
    let r = build_registry();
    let root_ns = Namespace("kabegame".into());
    let g = r
        .resolve(&root_ns, &ProviderName("gallery_route".into()))
        .expect("gallery_route should be resolvable");
    assert_eq!(g.name.0, "gallery_route");
}

#[test]
fn loads_with_bytes_source() {
    // 模拟 include_dir 路径：用 read 拿到 bytes, 然后 Source::Bytes
    let dir = providers_dir();
    let raw = std::fs::read(dir.join("root_provider.json")).unwrap();
    let def = Json5Loader.load(Source::Bytes(&raw)).expect("bytes load");
    assert_eq!(def.name.0, "root_provider");
}
```

**测试要点**：
- 9 个文件全部加载并注册无错
- root_provider 含 gallery / vd 两条路由
- 命名空间链查找命中 `kabegame.gallery_route`
- `Source::Bytes` 路径独立验证（这是核心 include_dir 路径）

**Test**：`cargo test -p pathql-rs --features json5 --test load_real_providers`。

---

### S5. 移除 Phase 1 手工 fixture

Phase 1 的 `tests/fixtures/*.json` 手工预处理文件已被 S4 真文件替代。

操作：
- 删除 `src-tauri/pathql-rs/tests/fixtures/` 目录及内容（如存在）
- 删除 `src-tauri/pathql-rs/tests/fixtures.rs` integration test 文件（如存在）
- 保留 ast 模块内嵌的 inline `#[cfg(test)]` 字符串字面量测试 —— 它们仍验证 AST 解析的小单元

**测试要点**：
- `cargo test -p pathql-rs --features json5` 全绿
- `cargo test -p pathql-rs`（不开 json5）—— Phase 1 ast/loader/registry 单测仍全绿；json5 / load_real_providers 测试因 `#![cfg(feature = "json5")]` 不参与编译

**Test**：两次跑（开 / 关 feature）都全绿。

---

### S6. 文档收尾

更新 `src-tauri/pathql-rs/Cargo.toml` 的 `description`：

```toml
description = "Path-folding query DSL — AST + Loader 抽象（含 json5 适配器 feature）"
```

新建（或扩充）`src-tauri/pathql-rs/README.md`，3 段：
- 简介：抽象 AST + Loader trait + Registry
- feature 开关列表（`json5`）
- 用法示例（5 行 Rust：`Json5Loader::default().load(Source::Bytes(...))` → `registry.register(...)`）

**测试要点**：无；纯文档。

**Test**：最后再跑一次 `cargo test -p pathql-rs --features json5` 收尾。

---

## 完成标准

- [ ] `cargo test -p pathql-rs` 全绿（不开 json5；Phase 1 单测约 30-40 条）
- [ ] `cargo test -p pathql-rs --features json5` 全绿（Phase 1 + Phase 2 总约 45-55 条）
- [ ] `tests/load_real_providers.rs` 加载所有现有 9 个 provider 文件并 register 成功
- [ ] `kabegame-core` 仍未引用 `pathql-rs`
- [ ] `Json5Loader` 全部错误路径有覆盖：syntax / io / utf-8 / missing field
- [ ] `cargo build -p pathql-rs --features json5` warning 清零

## 风险点

1. **json5 v0.4 的错误粒度**：当前只有 `Error::Message`。`map_json5_error` 一律走 `LoadError::Syntax`。如未来 json5 升级提供更细粒度的错误（如 `MissingField`），再细分映射。
2. **行列号偏移**：json5 crate 的 `Location { line, column }` 起算可能是 1-based 或 0-based；S3 测试里写 `>= 1` 兼容两种。spike 一次确认实际行为后再写硬编码值。
3. **PROVIDER_FILES 列表维护**：S4 硬编码文件清单，新增 provider 时容易忘记同步。可在 S4 写一个辅助测试用 `std::fs::read_dir` 比对实际目录文件数量与 `PROVIDER_FILES.len()`，发现新增文件就报错（**这只是个 sanity check，不是 discover**）。但用户明确反对扫描——若加，限制在测试代码内、目录与文件数核验、不构造 Registry。**建议跳过**：维护成本可接受，新增文件时手动加列表即可。
4. **`json5` 模块名歧义**：本 crate `adapters::json5` 与外部 crate `json5` 同名；用 `::json5::` 绝对路径调用避免歧义。
5. **Source::Path 是否保留**：用户未明确反对；保留作为开发 / CLI 工具便利，include_dir 走 Source::Bytes 不冲突。如果后续要进一步去 IO 化，可在 Phase 3 之后把 Path 处理改为可选 trait 方法。

## 完成 Phase 2 后的下一步

Phase 3 加载期校验：在 `pathql-rs` 内加 `validate` 模块，把 RULES.md §10 全部检查项落地，依赖 `sqlparser` + `regex-automata` 等新增 deps（也走 feature gate 与具体校验项关联）。
