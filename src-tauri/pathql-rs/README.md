# pathql-rs

Path-folding query DSL — `serde`-driven AST + format-agnostic `Loader` trait + namespace-aware `ProviderRegistry`.

This crate is the standalone engine for the provider DSL described in [`cocs/provider-dsl/RULES.md`](../../cocs/provider-dsl/RULES.md). It deliberately stays decoupled from `kabegame-core`: no IO defaults, no directory scanning, no format coupling. The host wires up its own loading strategy (e.g. `include_dir!` at compile time → `Source::Bytes` at runtime) and feeds parsed `ProviderDef`s into the registry.

## Features

| feature | what it enables |
|---|---|
| _(default)_ | AST types, `Loader` trait, `ProviderRegistry`, `LoadError`, `Source`, `template::parse` (`${...}` parser, no external deps) |
| `json5` | `adapters::Json5Loader` — `serde` deserialization of `.json5` (comments, trailing comma, single quotes, unquoted keys) into `ProviderDef` |
| `validate` | `validate(registry, &cfg)` semantic checks (RULES §10): name/namespace patterns, `${ref:X}` resolution, dynamic-binding scoping, path expressions, SQL via `sqlparser` SQLite dialect (DDL/multi-stmt/whitelist), regex compile + intersection (regex-automata DFA product BFS), capture index bounds, optional cross-provider reference checks, recursive meta validation |
| `compose` | `ProviderQuery` structured IR + `fold_contrib(state, &q)` cumulative semantics (RULES §3): cascading-replace `from`, additive `fields`/`joins`/`wheres`/`offset_terms`, last-wins `limit`, `OrderState` (per-field upsert + global `last-wins`), `${ref:X}` → `_aN` literal allocation via `AliasTable`, alias collision detection with `in_need` shared-upstream rules. Templates inside SQL strings are preserved verbatim — substitution / SQL rendering is a Phase 5 concern. |

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

`Source` has three forms — `Path(&Path)` (convenience for dev/CLI), `Bytes(&[u8])` (the include_dir path), and `Str(&str)` (the testing/literal path).
