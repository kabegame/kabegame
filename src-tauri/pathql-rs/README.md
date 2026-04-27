# pathql-rs

Path-folding query DSL — `serde`-driven AST + format-agnostic `Loader` trait + namespace-aware `ProviderRegistry`.

This crate is the standalone engine for the provider DSL described in [`cocs/provider-dsl/RULES.md`](../../cocs/provider-dsl/RULES.md). It deliberately stays decoupled from `kabegame-core`: no IO defaults, no directory scanning, no format coupling. The host wires up its own loading strategy (e.g. `include_dir!` at compile time → `Source::Bytes` at runtime) and feeds parsed `ProviderDef`s into the registry.

## Features

| feature | what it enables |
|---|---|
| _(default)_ | AST types, `Loader` trait, `ProviderRegistry`, `LoadError`, `Source` |
| `json5` | `adapters::Json5Loader` — `serde` deserialization of `.json5` (comments, trailing comma, single quotes, unquoted keys) into `ProviderDef` |

## Usage

```rust
use pathql_rs::{Json5Loader, Loader, ProviderRegistry, Source};

let loader = Json5Loader;
let mut registry = ProviderRegistry::new();

let bytes: &[u8] = include_bytes!("path/to/some.provider.json5");
let def = loader.load(Source::Bytes(bytes))?;
registry.register(def)?;
```

`Source` has three forms — `Path(&Path)` (convenience for dev/CLI), `Bytes(&[u8])` (the include_dir path), and `Str(&str)` (the testing/literal path).
