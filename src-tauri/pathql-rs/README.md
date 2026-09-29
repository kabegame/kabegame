# pathql-rs

Path-folding query DSL — `serde`-driven AST + format-agnostic `Loader` trait + namespace-aware `ProviderRegistry`.

This crate is the standalone engine for the provider DSL described in [`cocs/provider-dsl/RULES.md`](../../cocs/provider-dsl/RULES.md). It deliberately stays decoupled from `kabegame-core`: no IO defaults, no directory scanning, no format coupling. The host wires up its own loading strategy (e.g. `include_dir!` at compile time → `Source::Bytes` at runtime) and feeds parsed `ProviderDef`s into the registry.

## Features

| feature | what it enables |
|---|---|
| _(default)_ | AST types, `Loader` trait, `ProviderRegistry`, `LoadError`, `Source`, `template::parse` (`${...}` parser, no external deps) |
| `json5` | `loaders::Json5Loader` — `serde` deserialization of `.json5` (comments, trailing comma, single quotes, unquoted keys) into `ProviderDef` |
| `yaml` | `loaders::YamlLoader` — `serde` deserialization of `.yaml` / `.yml` into the same `ProviderDef` via `serde-saphyr` (pure Rust, YAML 1.2). Long SQL can be written across lines with block scalars (`|-` keeps newlines). |
| `validate` | `validate(registry, &cfg)` semantic checks (RULES §10): name/namespace patterns, `${ref:X}` resolution, dynamic-binding scoping, path expressions, SQL via `sqlparser` SQLite dialect (DDL/multi-stmt/whitelist), regex compile + intersection (regex-automata DFA product BFS), capture index bounds, optional cross-provider reference checks, recursive meta validation |
| `compose` | `ProviderQuery` structured IR + `fold_contrib(state, &q)` cumulative semantics (RULES §3) + `template::eval` evaluator + `compose::render` template-to-SQL renderer + `ProviderQuery::build_sql(&ctx, dialect)` → `(String, Vec<TemplateValue>)`. `${ref:X}` and `${composed}` are inlined; `${properties.X}` / `${capture[N]}` / `${data_var.col}` / `${child_var.field}` become `?` (Sqlite/Mysql) or `$N` (Postgres) bind placeholders. Dialect-agnostic — no DB driver. |

6d 起 pathql-rs 不附 driver 桥; 消费者自实现 [`SqlExecutor`](src/provider/mod.rs) trait + 类型转换 (例: `core/src/storage/template_bridge.rs` 接 rusqlite)。简单场景可用 [`ClosureExecutor`](src/provider/mod.rs) 闭包桥。

Module layout: input adapters live in [`loaders/`](src/loaders/) (Loader trait impls).

## Usage

```rust
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};

let loader = Json5Loader;
let mut registry = ProviderRegistry::new();

let bytes: &[u8] = include_bytes!("path/to/some.provider.json5");
let def = loader.load(Source::Bytes(bytes))?;
registry.register(def)?;

// After loading all providers (Phase 6 in kabegame):
#[cfg(feature = "validate")]
{
    use pathql_rs::validate::{validate, ValidateConfig};
    let cfg = ValidateConfig::with_default_reserved()
        .with_whitelist(["images", "albums", "tasks"].iter().map(|s| s.to_string()))
        .with_cross_refs(true);
    validate(&registry, &cfg).expect("provider DSL invariants");
}
```

Pick the loader by file extension with `LoaderType::from_path(path)` (`json` / `json5` → JSON5, `yaml` / `yml` → YAML), then `loader_type.load(source)`; `ProviderRuntime::register_provider_dsl(loader_type, source)` does the same for dynamic registration.

```yaml
# some.provider.yaml —— 与 json5 产出同一份 AST
namespace: kabegame
name: tasks_provider
list:
  "${out.id}":
    sql: |-
      SELECT t.id, t.status
      FROM tasks t
      ORDER BY COALESCE(t.start_time, 0) DESC
    data_var: out
```

`Source` has three forms — `Path(&Path)` (convenience for dev/CLI), `Bytes(&[u8])` (the include_dir path), and `Str(&str)` (the testing/literal path).
