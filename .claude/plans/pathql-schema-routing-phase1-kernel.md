# Phase 1 — pathql-rs kernel: schema routing + remove `from` from ContribQuery

## Context

Phase 1 of the broader [pathql schema routing refactor](../../../../../Users/cmtheit/.claude/plans/pathql-from-schema-from-schema-from-ima-parsed-matsumoto.md). Goal: change the pathql crate so that

1. The FROM table is supplied by a host-registered **schema** keyed off the `scheme://` prefix of the path, instead of by `ContribQuery.from` cascading-replace.
2. `ContribQuery.from` is **removed entirely**. `ProviderQuery.from` stays as the rendered-SQL field but is now seeded only by the schema layer.
3. Plain slash paths (no `scheme://`) error out — hard cutover.

Phase 1 is strictly scoped to `src-tauri/pathql-rs/**`. The DSL schema file (`schema.json5`) and all consumers (`kabegame-core`, `kabegame`, frontend) are out of scope for this phase and land in Phase 2 / Phase 3.

**End state of Phase 1**: pathql-rs builds and `cargo test -p pathql-rs` is fully green. Downstream `kabegame-core` **will not build** at the end of Phase 1 (it still calls `set_root` and still has `"from":` in DSL files). That is the only intentional cross-phase break; Phase 2 closes it immediately.

---

## Reference points from current source

- `EngineError::RootNotInitialized` / `RootAlreadyInitialized` — [provider/mod.rs:271-273](../../src-tauri/pathql-rs/src/provider/mod.rs#L271-L273)
- `RootNode` struct, `root: OnceLock<RootNode>` field — [provider/runtime.rs:54-57, 62](../../src-tauri/pathql-rs/src/provider/runtime.rs#L54-L62)
- `set_root()` — [provider/runtime.rs:98-113](../../src-tauri/pathql-rs/src/provider/runtime.rs#L98-L113)
- `resolve()` — [provider/runtime.rs:197-334](../../src-tauri/pathql-rs/src/provider/runtime.rs#L197-L334)
- `get_root()` — [provider/runtime.rs:336-342](../../src-tauri/pathql-rs/src/provider/runtime.rs#L336-L342)
- `find_longest_cached_prefix()` cold-start — [provider/runtime.rs:349-384](../../src-tauri/pathql-rs/src/provider/runtime.rs#L349-L384)
- `normalize_path()` — [provider/runtime.rs:559-569](../../src-tauri/pathql-rs/src/provider/runtime.rs#L559-L569)
- `build_path_key()` — [provider/runtime.rs:580-587](../../src-tauri/pathql-rs/src/provider/runtime.rs#L580-L587)
- `ContribQuery` (struct with `from`) — [ast/query.rs:10-33](../../src-tauri/pathql-rs/src/ast/query.rs#L10-L33). Already has `#[serde(deny_unknown_fields)]` (line 11), so deleting the `from` field automatically rejects `"from":` in JSON.
- `fold_from()` + call site — [compose/fold.rs:19, 40-44](../../src-tauri/pathql-rs/src/compose/fold.rs#L40-L44)
- `from` tests in fold.rs — `from_first_time`, `from_cascading_replace`, `from_none_keeps_existing` — [compose/fold.rs:180-210](../../src-tauri/pathql-rs/src/compose/fold.rs#L180-L210)
- `from` tests in ast/query.rs — `contrib_from_and_limit` (lines 84-94) and `c.from` assertion in `contrib_limit_zero` (line 78)
- `ProviderQuery.from` (kept) — [compose/query.rs:29](../../src-tauri/pathql-rs/src/compose/query.rs#L29)
- `BuildError::MissingFrom` (already exists, no change) — [compose/build.rs:18, 50](../../src-tauri/pathql-rs/src/compose/build.rs#L18). pathql-rs **already** errors when `ProviderQuery.from` is `None` at SQL build; there is no implicit default. This means the schema-seed path must always set `ProviderQuery.from` — and any path that doesn't go through a schema produces `MissingFrom` naturally. Good.
- Runtime tests using `RootNotInitialized` / `RootAlreadyInitialized` — [provider/runtime.rs:762, 779](../../src-tauri/pathql-rs/src/provider/runtime.rs#L762-L779)
- `q_with_from()` helper in build.rs builds a **`ProviderQuery`** directly (not ContribQuery) — [compose/build.rs:274-278](../../src-tauri/pathql-rs/src/compose/build.rs#L274-L278). These tests are **unaffected** by Phase 1; `ProviderQuery.from` stays.

---

## Step ordering

The phase is sequenced so that **`cargo test -p pathql-rs` is green at the end of every step.** Steps that would individually break tests are merged with their test rewrites.

### Step 1.1 — Add `SchemaRoot` + `register_schema` API (additive, no breaking changes)

**Edits.**

- `provider/runtime.rs`:
  - Define new struct (next to `RootNode`):
    ```rust
    #[derive(Clone)]
    pub struct SchemaRoot {
        pub from: SqlExpr,
        pub(crate) provider: Arc<dyn Provider>,
        pub(crate) provider_keys: Vec<ProviderKey>,
    }
    ```
  - Add new field on `ProviderRuntime`: `schemas: Mutex<HashMap<String, SchemaRoot>>` (initialised empty in both `new` / `with_registry`). Use `Mutex` (matches the existing `cache` field's choice) — registration is rare and contention is irrelevant.
  - Add public method:
    ```rust
    pub fn register_schema(
        &self,
        scheme: &str,
        from: impl Into<SqlExpr>,
        namespace: &str,
        provider_name: &str,
    ) -> Result<(), EngineError>;
    ```
    Behaviour: validate `scheme` shape (`[a-z][a-z0-9_]*`); instantiate provider via `registry.instantiate_result(...)` (same call shape as `set_root`); insert into the schemas map. Re-registering the same scheme returns `EngineError::SchemaAlreadyRegistered(String)`. Unknown provider name returns the existing `ProviderNotRegistered`.
  - Add `pub fn registered_schemes(&self) -> Vec<String>`.
- `provider/mod.rs` (`EngineError` at line 253):
  - Add variants:
    ```rust
    #[error("schema `{0}` is not registered")]
    SchemaNotFound(String),
    #[error("schema `{0}` is already registered")]
    SchemaAlreadyRegistered(String),
    #[error("path is missing `scheme://` prefix: {0}")]
    MissingScheme(String),
    #[error("scheme `{0}` is not a valid identifier (must match [a-z][a-z0-9_]*)")]
    InvalidScheme(String),
    ```
  - **Keep** `RootNotInitialized` and `RootAlreadyInitialized` for now; they're removed in Step 1.3.
- `lib.rs`: re-export `SchemaRoot`.

**Tests added in the same step (new module `mod schema_registry_tests` in `provider/runtime.rs`).**

- `register_schema_basic` — register `images`, assert `registered_schemes() == ["images"]`.
- `register_schema_returns_already_registered_on_duplicate`.
- `register_schema_returns_provider_not_registered_for_unknown_provider`.
- `register_schema_returns_invalid_scheme_for_bad_identifier` (try `"Images"`, `"1images"`, `"im-ages"`, `""`).
- All four tests build a `ProviderRuntime` with a tiny fixture provider via existing test helpers (the `set_root` tests at lines 750–800 demonstrate the pattern).

**Verification gate.** `cargo test -p pathql-rs --features json5,validate` green. Old `set_root` tests untouched, still passing.

---

### Step 1.2 — `resolve(path)` parses `scheme://`, routes to schema when present (additive — `set_root` still works)

**Edits.**

- `provider/runtime.rs`:
  - New private helper:
    ```rust
    fn parse_scheme<'a>(path: &'a str) -> Option<(&'a str, &'a str)>
    ```
    Returns `Some((scheme, rest))` when the path contains `://` before the first `/`. Validates the scheme matches `[a-z][a-z0-9_]*`; non-matching → `None` (treated as schemeless and falls through to `set_root` path, which Step 1.3 removes).
  - Modify `resolve(path)`:
    - First, try `parse_scheme(path)`.
    - If `Some((scheme, rest))`:
      1. Look up `SchemaRoot` in `self.schemas`; missing → `Err(EngineError::SchemaNotFound(scheme.into()))`.
      2. Normalize `rest` into segments (existing `normalize_path` logic).
      3. Cache key prefix becomes `<scheme>://`; modify `build_path_key` (or wrap it) so segments build `<scheme>://seg1/seg2`. Cache map keys remain `String`; the scheme is just part of the key.
      4. Cold-start replaces `get_root()`: instantiate from the `SchemaRoot`, then **seed `ProviderQuery::new()` with `from = Some(schema.from.clone())` BEFORE the root's `apply_query` call**.
    - If `None`: fall back to the existing `set_root`-based path unchanged.
  - `find_longest_cached_prefix` signature gets an additional `scheme: Option<&SchemaRoot>` argument; when `Some`, cold-start seeds `ProviderQuery.from = Some(schema.from)` before `root.apply_query`. When `None`, behaviour unchanged.

**Tests added in the same step.**

- `resolve_with_scheme_basic` — register `images` schema; `runtime.list("images://x100x")` returns the expected children (uses a fixture provider tree mirroring images_root: list `x100x`, etc).
- `resolve_with_scheme_seeds_from_in_built_sql` — register schema with `from = "images"`; resolve a path whose root provider has no `from` contribution; build SQL via `runtime.fetch` and assert SQL contains `FROM images`. **This is the load-bearing semantic test for the schema-driven FROM design.**
- `resolve_with_unknown_scheme_errors` — `runtime.list("ghost://x")` → `SchemaNotFound`.
- `resolve_cache_keys_isolated_per_scheme` — register two schemas pointing at the same root with different `from` (`images` vs `albums_test`); resolve `<a>://x` then `<b>://x`; assert the cache contains both entries with distinct keys; assert each resolution's `composed.from` matches its schema.
- `resolve_without_scheme_still_works_via_set_root` — keep one test exercising the old slash path with `set_root` to prove backward compat during this step.

**Verification gate.** `cargo test -p pathql-rs --features json5,validate` green. All existing tests still pass (because schemeless paths still use `get_root`).

---

### Step 1.3 — Delete `set_root` / `RootNode` / `get_root`; make scheme mandatory

**Edits.**

- `provider/runtime.rs`:
  - Delete `pub fn set_root(...)` (lines 98-113).
  - Delete `fn get_root(...)` (lines 336-342).
  - Delete `RootNode` struct (lines 54-57).
  - Delete `root: OnceLock<RootNode>` field (line 62) and its init in `new` / `with_registry` (line 91).
  - In `resolve(path)`: when `parse_scheme` returns `None`, immediately `Err(EngineError::MissingScheme(path.to_string()))`. Delete the schemeless fallback branch added in 1.2.
  - In `find_longest_cached_prefix`: cold-start always takes a `&SchemaRoot`. No `Option`. Remove the schemeless branch.
- `provider/mod.rs`:
  - Delete `RootNotInitialized` and `RootAlreadyInitialized` variants.

**Tests updated in the same step (rewriting, not deleting, the assertions).**

- Rewrite the two tests at runtime.rs:762 and 779 (`RootNotInitialized`, `RootAlreadyInitialized`):
  - `RootNotInitialized` → renamed `missing_scheme_errors`; asserts `runtime.list("/foo")` returns `EngineError::MissingScheme`.
  - `RootAlreadyInitialized` → renamed `schema_already_registered_errors`; asserts double `register_schema("images", ...)` returns `EngineError::SchemaAlreadyRegistered`.
- Walk every other runtime test that uses `set_root(...)` and convert to `register_schema("test", "images", ns, name)` + path strings prefixed with `test://`. Estimated ~20 tests (search `set_root` in the file).
- Delete `resolve_without_scheme_still_works_via_set_root` from Step 1.2 (no longer applicable).

**Verification gate.** `cargo test -p pathql-rs --features json5,validate` green. `rg 'set_root|RootNotInitialized|RootAlreadyInitialized|RootNode' src-tauri/pathql-rs/src/` returns zero hits.

---

### Step 1.4 — Delete `ContribQuery.from` and `fold_from`

**Edits.**

- `ast/query.rs`:
  - Delete `pub from: Option<SqlExpr>,` (line 16). `#[serde(deny_unknown_fields)]` on the struct (already present on line 11) immediately makes `"from":` a load error — exactly what we want.
  - Delete tests `contrib_from_and_limit` (lines 84-94) and the `c.from` line in `contrib_limit_zero` (line 78).
- `compose/fold.rs`:
  - Delete `fold_from()` (lines 40-44).
  - Delete `fold_from(state, &q.from);` call in `fold_contrib` (line 19).
  - Delete the three `===== from =====` tests: `from_first_time`, `from_cascading_replace`, `from_none_keeps_existing` (lines 180-210).
- No edits to `compose/query.rs` — `ProviderQuery.from` stays.

**Tests added in the same step.**

- In `ast/query.rs` test module: `contrib_rejects_from_field` — `serde_json::from_str::<Query>(r#"{"from":"images"}"#)` must return `Err`. This pins the DSL-rejection invariant.
- In `compose/fold.rs` test module: replace the deleted `from_cascading_replace` with `child_contrib_cannot_change_from` — fold two contribs that previously would have set `from`; assert nothing in `state.from` changes (since neither contrib touches it). Confirms there is no longer a code path from ContribQuery to `state.from`.
- In `provider/runtime.rs` test module: `schema_from_survives_through_full_fold` — register schema with `from = "images"`, resolve a multi-segment path through fixture providers that each contribute `join` / `where` / `order` but NOT `from`; assert final `composed.from == Some("images")`. This is the integration counterpart to the unit test from Step 1.2.

**Verification gate.** `cargo test -p pathql-rs --features json5,validate` green. `rg 'q\.from|ContribQuery.*from|fold_from|\.from\s*=\s*Some' src-tauri/pathql-rs/src/` — every remaining hit must be on `ProviderQuery.from` (internal rendering field), not `ContribQuery.from`.

---

### Step 1.5 — Public surface cleanup + doc comments

**Edits.**

- `lib.rs`: confirm re-exports — `SchemaRoot` exported; `RootNode` removed if it was exported.
- Top-of-file doc on `provider/runtime.rs`: replace any reference to "set_root" / "global root" with the schema-registry model. One paragraph.
- Inline doc on `ProviderRuntime::resolve` and `ProviderRuntime::register_schema` — state the contract: scheme parsing, `from` seeding, error variants.
- `provider/mod.rs`: rustdoc on the new `EngineError` variants (already inline from Step 1.1; double-check wording).

**No production code change**. No new tests required; existing tests cover behaviour.

**Verification gate.** `cargo doc -p pathql-rs --no-deps` builds without warnings. `cargo test -p pathql-rs --features json5,validate` still green.

---

## End-of-phase verification

Run, in order, and require each green:

1. `cargo test -p pathql-rs --no-default-features` — confirms core compose-only feature set is intact.
2. `cargo test -p pathql-rs --features json5,validate` — full default set.
3. `cargo doc -p pathql-rs --no-deps` — no warnings.
4. `rg 'set_root|RootNotInitialized|RootAlreadyInitialized|RootNode|fold_from' src-tauri/pathql-rs/src/` returns zero hits.
5. `rg '"from"\s*:' src-tauri/pathql-rs/` — only matches inside test JSON that asserts rejection (Step 1.4 negative test).

**Known intentional break at end of Phase 1**: `bun check -c kabegame --skip vue` (full workspace check) will fail with errors in `kabegame-core/src/providers/init.rs:85` (`runtime.set_root` no longer exists) and in DSL parse errors for every `*.json5` still containing `"from":`. **Do not fix in Phase 1.** That is Phase 2's first step.

---

## Out of scope (Phase 1)

- `schema.json5` grammar (Phase 2 — though the runtime serde rejection from Step 1.4 already makes "from" a load error before schema.json5 sees it, so the schema update is strictly cosmetic; we still want to do it for editor IDE feedback).
- Any change in `kabegame-core` or `kabegame` — including `init.rs`, DSL `.json/.json5` files, internal `runtime.list("/...")` call sites, frontend path strings, VD paths, docs (RULES.md, VD_INTEGRATION.md).
- Removing `ProviderQuery.from` — it stays.
- Plugin-side schema registration — deferred indefinitely.

---

## After Phase 1

Write `pathql-schema-routing-phase2-core.md` in `.claude/plans/` before touching kabegame-core. It will cover: schema.json5 grammar, removal of `"from":` from 4 DSL files, deletion of `root_provider.json`, restructuring `images_root_provider.json5` to absorb `gallery`/`vd`, `init.rs` schema registration, `dsl_loader.rs` cleanup, and updating the two internal `.list("/gallery/...")` call sites in `providers/query.rs`. Same per-step test discipline.
