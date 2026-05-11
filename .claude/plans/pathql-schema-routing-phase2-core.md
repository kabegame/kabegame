# Phase 2 — kabegame-core: register `images://` schema, restructure root, migrate internal callers

## Context

Phase 2 of the [pathql schema routing refactor](../../../../../Users/cmtheit/.claude/plans/pathql-from-schema-from-schema-from-ima-parsed-matsumoto.md).

Phase 1 landed: `ContribQuery.from` is gone, `register_schema` API exists, slash paths error with `MissingScheme`. As intended, kabegame-core no longer compiles — `init.rs:85` still calls `runtime.set_root(...)`, and four DSL files still contain `"from":"images"` which now fails `#[serde(deny_unknown_fields)]` at load time.

Phase 2 closes that break: register one `images://` schema, restructure the root, strip `from` everywhere, migrate every internal slash-path call site.

**Restructure decision (confirmed by user).** `images_root_provider` becomes the schema root but is reduced to a **pure router** — its current `fields`/`order` contributions move into a new **`image_basic_provider`** which the root delegates to for pagination/id segments. Gallery and VD remain as siblings (now under `images_root_provider`'s `list`), so their query semantics are preserved bit-for-bit. The old `root_provider.json` is deleted.

**Phase 2 starts broken (post-Phase-1) and ends green.** Within Phase 2, the build can only become green at the moment all co-dependent changes land together — there is no incremental green between Phase 1 and the end of Phase 2. We still sub-divide the work for reviewability, but treat the phase as one atomic commit.

---

## Reference points from current source

- `dsl_loader.rs` has special-case ordering for `root_provider.json` — [dsl_loader.rs:28, 65-75](../../src-tauri/kabegame-core/src/providers/dsl_loader.rs#L28-L75).
- `init.rs:85` calls `runtime.set_root("kabegame", "root_provider")`.
- Current DSL files with `"from":"images"`:
  - [dsl/root_provider.json](../../src-tauri/kabegame-core/src/providers/dsl/root_provider.json) (entire file deleted by Phase 2)
  - [dsl/images/images_root_provider.json5](../../src-tauri/kabegame-core/src/providers/dsl/images/images_root_provider.json5) (rewritten)
  - [dsl/gallery/gallery_route.json5](../../src-tauri/kabegame-core/src/providers/dsl/gallery/gallery_route.json5) (drop `from` only)
  - [dsl/vd/vd_root_router.json5](../../src-tauri/kabegame-core/src/providers/dsl/vd/vd_root_router.json5) (drop `from` only)
- `schema.json5` has the ContribQuery `from` property at the lines around 168 (under the contrib branch). To delete.
- Internal slash-path call sites in kabegame-core (14 total — confirmed by grep):
  - `providers/query.rs:225, 242, 250, 256, 262, 287, 296, 342, 371`
  - `storage/organize.rs:222`
  - `storage/albums.rs:527`
  - `storage/gallery.rs:97, 113`
  - `virtual_driver/semantics.rs:159`

---

## Restructure target (the only delicate part)

### New `image_basic_provider.json5` (lifted out of today's `images_root_provider`)

Location: `src-tauri/kabegame-core/src/providers/dsl/images/image_basic_provider.json5`

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "image_basic_provider",
    "query": {
        "fields": ["images.*"],
        "order": [{ "sql": "images.id", "order": "asc" }]
    },
    "list": {
        "x100x": { "provider": "gallery_paginate_router", "properties": { "page_size": 100 } },
        "x500x": { "provider": "gallery_paginate_router", "properties": { "page_size": 500 } },
        "x1000x": { "provider": "gallery_paginate_router", "properties": { "page_size": 1000 } }
    },
    "resolve": {
        "x([1-9][0-9]*)x": {
            "provider": "gallery_paginate_router",
            "properties": { "page_size": "${capture[1]}" }
        },
        "id_([^/]+)": {
            "provider": "images_id_provider",
            "properties": { "image_id": "${capture[1]}" }
        }
    }
}
```

This is **exactly today's `images_root_provider.json5` with `"from":"images"` removed**. No other behavioral change.

### New `images_root_provider.json5` (the schema root)

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "images_root_provider",
    "query": {},
    "list": {
        "gallery": { "provider": "gallery_route" },
        "vd": { "provider": "vd_root_router" }
    },
    "resolve": {
        "x([1-9][0-9]*)x": { "delegate": { "provider": "image_basic_provider" } },
        "id_([^/]+)": { "delegate": { "provider": "image_basic_provider" } }
    }
}
```

**Why this shape.** The schema root must contribute nothing (empty `query`) so that the `images://gallery/...` and `images://vd/...` paths inherit only `from: images` (seeded by the schema). Pagination/id paths route through the resolve `delegate` per RULES.md §5.4, which forwards the segment to `image_basic_provider` while accumulating its `fields`/`order` contributions. End result: each top-level branch (`gallery`, `vd`, `<paginate-or-id>`) reaches its previous-Phase-1 behavior exactly.

**Why resolve, not static list, for x100x.** Static list entries cannot use `delegate` (RULES.md §4.1 — "list 静态项不允许 ByDelegate"). We could enumerate `x100x`/`x500x`/`x1000x` redundantly in `list` for `runtime.list()` discoverability, but currently no caller enumerates them at this level (frontend uses fixed page-size choices). Skipping the redundant list keeps the file minimal; revisit if a test reveals a UI regression.

**Path topology preservation.** Today:

| Path (old)             | Chain (old)                                                        |
|------------------------|--------------------------------------------------------------------|
| `/gallery/all`         | root_provider → gallery_route → gallery_all_router                  |
| `/vd/i18n-en_US/...`   | root_provider → vd_root_router → ...                                |
| `/images/x100x/1`      | root_provider → images_root_provider → gallery_paginate_router → page |
| `/images/id_X/metadata`| root_provider → images_root_provider → images_id_provider → metadata |

After Phase 2:

| Path (new)                  | Chain (new)                                                                                  |
|-----------------------------|----------------------------------------------------------------------------------------------|
| `images://gallery/all`      | (schema seeds from=images) → images_root_provider (empty) → gallery_route → gallery_all_router |
| `images://vd/i18n-en_US/...`| (schema seeds from=images) → images_root_provider (empty) → vd_root_router → ...              |
| `images://x100x/1`          | (schema seeds from=images) → images_root_provider → **delegate** image_basic_provider → gallery_paginate_router → page |
| `images://id_X/metadata`    | (schema seeds from=images) → images_root_provider → **delegate** image_basic_provider → images_id_provider → metadata |

Note the path **no longer carries `/images/` as a literal segment** for pagination/id (it was redundant; `images://` already names the schema). `images://x100x/1` replaces `/images/x100x/1`. All 14 internal callers in this phase, plus the Phase-3 callers, must use the new form.

---

## Step sequence

### Step 2.1 — Add `image_basic_provider.json5`

**Edit.** Create `src-tauri/kabegame-core/src/providers/dsl/images/image_basic_provider.json5` with the content shown above. No other changes.

**Test.** None at this step — the new file isn't loaded until step 2.4 changes `dsl_loader.rs` and step 2.6 switches the runtime root. Compilation is still broken from Phase 1.

**Why first.** Adding the file before deletions means we can review the new file in isolation. The recursive `include_dir!` embedding picks it up automatically once we hit step 2.4.

---

### Step 2.2 — Rewrite `images_root_provider.json5`

**Edit.** Replace the entire body with the schema-root shape shown above. The file shrinks from 36 lines to ~16.

**Test.** None at this step (file load happens at step 2.4+).

---

### Step 2.3 — Strip `from` from `gallery_route.json5` and `vd_root_router.json5`

**Edits.**
- `dsl/gallery/gallery_route.json5` — delete line 6 (`"from": "images",`).
- `dsl/vd/vd_root_router.json5` — delete line 9 (`"from": "images",`).

Nothing else in these two files changes. Their `fields` / `join` / `order` / `list` / `resolve` are preserved.

**Test.** None at this step. (Loading would fail at every existing `from` location with deny_unknown_fields, but loader isn't invoked yet.)

---

### Step 2.4 — Delete `root_provider.json`, update `dsl_loader.rs`

**Edits.**
- `rm src-tauri/kabegame-core/src/providers/dsl/root_provider.json`.
- In `dsl_loader.rs`:
  - Delete `pub const ROOT_PROVIDER: &str = "root_provider.json";` (line 28).
  - Rewrite `embedded_dsl_files()` (lines 64-76) to:
    ```rust
    fn embedded_dsl_files() -> Vec<&'static File<'static>> {
        let mut files = Vec::new();
        collect_embedded_dsl_files(&DSL_DIR, &mut files);
        files
    }
    ```
    No more "register root first" reordering. Provider registration is order-independent by design (pathql-rs allows forward references; cross-ref check runs at validate time).

**Test.** None at this step — runtime still calls `set_root` (broken).

---

### Step 2.5 — Update `schema.json5` to remove the `from` property

**Edit.** In `src-tauri/kabegame-core/src/providers/dsl/schema.json5`, locate the ContribQuery branch (search for the `"from"` property near the lines around 168 — its description contains "cascading-replace"). Delete the `"from": { ... }` block entirely. The `additionalProperties: false` clause on the ContribQuery shape will then reject `"from":` at JSON-schema-validation time too (belt-and-suspenders alongside pathql-rs's serde `deny_unknown_fields`).

**Test.** None new at this step.

**Note.** schema.json5 is purely an editor / IDE aid — pathql-rs doesn't read it at runtime. The serde rejection in Phase 1 is the load-time enforcement.

---

### Step 2.6 — Switch `init.rs` to `register_schema`

**Edit.** In `src-tauri/kabegame-core/src/providers/init.rs:85`, replace:
```rust
runtime
    .set_root("kabegame", "root_provider")
    .unwrap_or_else(|e| panic!("set root provider failed: {}", e));
```
with:
```rust
runtime
    .register_schema("images", "images", "kabegame", "images_root_provider")
    .unwrap_or_else(|e| panic!("register `images` schema failed: {}", e));
```

**This is the step that takes kabegame-core's lib crate from broken → compiling**, provided steps 2.1–2.4 are in. The full workspace check (`cargo check -p kabegame-core`) should pass after this edit if everything before it is correct.

**Test.** None added inline here — full coverage lands in step 2.8 once paths can resolve.

---

### Step 2.7 — Migrate the 14 internal slash-path call sites

All path literals shift to `images://...`. Where the old path had a literal `/images` prefix, that prefix is **dropped** (it's now the schema name, not a path segment).

| File | Line | Old | New |
|---|---|---|---|
| `providers/query.rs` | 225 | `format!("/images/x{}x/{}", page_size, page)` | `format!("images://x{}x/{}", page_size, page)` |
| `providers/query.rs` | 242 | `format!("/images/id_{}/metadata", encoded)` | `format!("images://id_{}/metadata", encoded)` |
| `providers/query.rs` | 250 | `count_at("/gallery/all")` | `count_at("images://gallery/all")` |
| `providers/query.rs` | 256 | `.list("/gallery/plugin")` | `.list("images://gallery/plugin")` |
| `providers/query.rs` | 262 | `format!("/gallery/plugin/{}", ...)` | `format!("images://gallery/plugin/{}", ...)` |
| `providers/query.rs` | 287 | `.list("/gallery/date")` | `.list("images://gallery/date")` |
| `providers/query.rs` | 296 | `format!("/gallery/date/{}", year.name)` | `format!("images://gallery/date/{}", year.name)` |
| `providers/query.rs` | 342 | `format!("/gallery/album/{}", encoded)` | `format!("images://gallery/album/{}", encoded)` |
| `providers/query.rs` | 371 | `format!("/gallery/album/{}/order/x3x/1", child_encoded)` | `format!("images://gallery/album/{}/order/x3x/1", child_encoded)` |
| `storage/organize.rs` | 222 | `count_at("/images")` | `count_at("images://")` |
| `storage/albums.rs` | 527 | `"/gallery/album/{}/order"` | `"images://gallery/album/{}/order"` |
| `storage/gallery.rs` | 97 | `gallery_media_type_counts_at("/gallery")` | `gallery_media_type_counts_at("images://gallery")` |
| `storage/gallery.rs` | 113 | `format!("/gallery/album/{}", ...)` | `format!("images://gallery/album/{}", ...)` |
| `virtual_driver/semantics.rs` | 159 | `format!("/vd/{}", Self::locale_route_segment())` | `format!("images://vd/{}", Self::locale_route_segment())` |

**Test.** None inline; covered in step 2.8.

**Sanity grep after this step.**
- `rg '"/gallery|"/vd|"/images' src-tauri/kabegame-core/src` → 0 hits.
- `rg '"from"\s*:' src-tauri/kabegame-core/src/providers/dsl/` → 0 hits.

---

### Step 2.8 — Regression tests

These land as a single `tests/` integration test file or as additions to existing test modules — choose the location closest to the code being tested.

**Required tests** (each must compile and pass):

1. **Schema registration smoke** — in `init.rs` test module or a new `tests/schema_registration.rs`:
   - After `provider_runtime()` is initialised, assert `registered_schemes()` returns `["images"]`.
   - Assert `runtime.list("images://gallery").is_ok()`.
   - Assert `runtime.list("/gallery").is_err()` with `EngineError::MissingScheme`.

2. **Path topology preservation** — for each migrated call site that exercises a distinct provider chain:
   - `count_at("images://gallery/all")` returns the same count as a direct `SELECT COUNT(*) FROM images WHERE <gallery_route's accumulated WHERE>`. Compare against a hand-rolled query on a seeded test DB.
   - `count_at("images://")` (no segments) returns total `SELECT COUNT(*) FROM images` count.
   - `raw_rows_at("images://x100x/1")` returns the first 100 rows ordered by `images.id ASC` (image_basic_provider's order).
   - `raw_rows_at("images://id_<X>/metadata")` returns the metadata row for image X.
   - `runtime.list("images://gallery/plugin")` enumerates plugin children (matches what today's `/gallery/plugin` returns — pin the list contents).
   - `runtime.list("images://gallery/date")` enumerates date years.

3. **Delegate path** — assert that `images://x100x/1` produces SQL with `FROM images`, `images.*` in SELECT, and `ORDER BY images.id ASC` — proving image_basic_provider's contributions reach the final query via the resolve delegate.

4. **VD path** — `runtime.list("images://vd/i18n-en_US")` enumerates the en_US tree's top-level children. Pin the list.

5. **DSL load rejection** — fixture test (or unit in `dsl_loader.rs`): manually invoke `register_provider_dsl` with a JSON5 string containing `"from":"images"` and assert the call returns an `Err`. This pins both the serde and schema.json5 rejections.

**Verification gate.**
- `bun check -c kabegame --skip vue` — Cargo workspace check green.
- `cargo test -p kabegame-core` green.
- `cargo test -p pathql-rs` still green (no regression from Phase 1).
- All sanity greps from step 2.7 return zero hits.

---

## End-of-Phase-2 verification

Run, in order:

1. `cargo check -p kabegame-core` — clean.
2. `cargo test -p pathql-rs --features json5,validate` — green (regression check).
3. `cargo test -p kabegame-core` — green, including all step-2.8 additions.
4. `rg '"/gallery|"/vd|"/images|set_root|root_provider\.json|ROOT_PROVIDER' src-tauri/kabegame-core` → only matches inside `.claude/plans/*.md` or comment text; no live code references.
5. `rg '"from"\s*:' src-tauri/kabegame-core/src/providers/dsl/` → 0 hits.

**Known intentional break at end of Phase 2**: `bun check -c kabegame` (full workspace incl. `kabegame` GUI / CLI crates and Vue frontend) still fails — `src-tauri/kabegame/src/wallpaper/rotator.rs`, Tauri commands, and Vue/Pinia stores still send slash paths to `browse_gallery_provider` / `count_gallery_provider`. Phase 3 fixes those.

---

## Out of scope (Phase 2)

- Any change in `src-tauri/kabegame/`, `src-tauri/kabegame-cli/`, `apps/kabegame/`, `packages/` — Phase 3.
- Documentation updates (RULES.md, VD_INTEGRATION.md, PROVIDER_IMAGEQUERY_COMPOSABLE.md) — Phase 3.
- Renaming `images_root_provider` to something more descriptive (cosmetic; orthogonal).
- Removing `image_basic_provider`'s now-redundant `list` entries (x100x/x500x/x1000x) in favor of resolve-only — defer until UI need is confirmed.
- Plugin-side schema registration — deferred indefinitely.

---

## After Phase 2

Write `pathql-schema-routing-phase3-app.md` in `.claude/plans/` before touching the GUI crate or frontend. Phase 3 will cover:
- Path literals in `src-tauri/kabegame/src/wallpaper/rotator.rs` and other Tauri commands.
- Path strings constructed in Vue / Pinia stores under `apps/kabegame/src/`.
- VD path callers' `images://vd/...` migration outside `virtual_driver/semantics.rs`.
- Docs: RULES.md §2, §3, §3.1, §10, §13.4 + new §14; VD_INTEGRATION.md sample paths; PROVIDER_IMAGEQUERY_COMPOSABLE.md.
- Final acceptance: `bun check -c kabegame` clean, `bun dev -c kabegame` smoke green across gallery + VD navigation.
