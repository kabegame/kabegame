# Phase 3a — build-green cutover: backend-wrapped `browse_gallery_provider`, surgical frontend tweaks, MCP TODO markers

## Context

Phase 3a of the [pathql schema routing refactor](../../../../../Users/cmtheit/.claude/plans/pathql-from-schema-from-schema-from-ima-parsed-matsumoto.md). Replaces the previously-drafted single-Phase-3 plan, which has been split into:

- **Phase 3a (this file)** — minimum-viable cutover to make `bun check -c kabegame` green and the app actually runnable. No new pathql schemas beyond `images://`. MCP bespoke handlers kept as-is with `TODO(phase3b)` markers.
- **Phase 3b (future plan)** — unify MCP resource URIs (`image://`, `album://`, `task://`, `surf://`, `plugin://`) under `register_schema`, replacing bespoke handlers with DSL/programmatic providers.

**User-confirmed strategy for 3a (key constraint).** No new frontend wrapper module. No mass rewrite of frontend gallery code. Instead:
- Backend chokepoint (`normalize_for_runtime`) defaults all schemeless paths to `images://`.
- `browse_gallery_provider` keeps its `gallery/` auto-prefix; combined with the chokepoint default, all gallery browse calls auto-promote to `images://gallery/...`.
- Two frontend files with `query_provider` calls get path-string edits in place: `App.vue:370` and `stores/albums.ts:230-232`.

## Current breakage (verified)

- `cargo check -p kabegame-core` succeeds (Phase 2 done).
- `cargo check -p kabegame --features standard` is **not** green yet; the cause is downstream of the call paths below — every `runtime.list/fetch/count` invocation that goes through a slash path now hits `MissingScheme`. The runtime never sees those paths until the app runs, but `normalize_for_runtime` itself still produces broken output, so any test or smoke that exercises a `browse_gallery_provider` call will fail.

## Touch list (exhaustive grep, deduplicated)

### Rust app + core helpers
- `src-tauri/kabegame-core/src/providers/query.rs:104-114` — `normalize_for_runtime` (chokepoint).
- `src-tauri/kabegame/src/commands/image.rs:35-42, 53-66, 92-98` — `browse_gallery_provider`, `list_provider_children`, `query_provider` (desktop Tauri).
- `src-tauri/kabegame/src/commands_core/image.rs:46-58, 60-92, 94-105` — same three functions for web JSON-RPC.
- `src-tauri/kabegame/src/wallpaper/rotator.rs:71-79, 132-133` — 6 `/gallery/hide/...` literals.
- `src-tauri/kabegame/src/mcp_server.rs:194-215, 564-697` — `normalize_mcp_provider_path`, `provider_path_for_runtime`, and the `provider://` branch of `read_resource`.

### Frontend (TypeScript / Vue)
- `apps/kabegame/src/App.vue:370` — `` `/images/id_${imageId}/` `` literal passed to `query_provider`.
- `apps/kabegame/src/stores/albums.ts:230-232` — `path: "albums/all/"` passed to `query_provider`.

### Docs
- `cocs/provider-dsl/RULES.md` — §2 path folding example, §3 table (already done in Phase 2, double-check), §13.4 root → schema registry, add §14 schema registration contract.
- `cocs/provider-dsl/VD_INTEGRATION.md` — sample paths use `/vd/...`, migrate to `images://vd/...`.
- `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md` — sample paths use `/gallery/...` / `/images/...`, migrate.

### Intentionally **NOT** touched in 3a
- `apps/kabegame/src/utils/galleryPath.ts` and its ~20 consumers — paths it produces are schemeless (`all/x100x/1`, `album/{id}/...`); these flow into `browse_gallery_provider` which already prepends `gallery/`, so the chokepoint promotion to `images://gallery/...` handles them transparently.
- All `apps/kabegame/src` Vue Router paths (`/gallery` redirects, `router.push({ path: "/gallery" })`) — those are browser routes, not pathql paths. Left alone.
- `src-tauri/kabegame/src/mcp_server.rs` bespoke handlers for `image://`, `album://`, `task://`, `surf://`, `plugin://` — Phase 3b.
- `apps/kabegame/src/help/tips/**` and `apps/kabegame/public/help-images/**` static asset references (`/help-images/...`) — unrelated to pathql.

## Step sequence

### Step 3a.1 — Backend chokepoint: `normalize_for_runtime` defaults to `images://`

**Edit.** `src-tauri/kabegame-core/src/providers/query.rs:104-114`. Current:

```rust
fn normalize_for_runtime(path: &str) -> String {
    if path.is_empty() {
        "/".to_string()
    } else if path.contains("://") {
        path.to_string()
    } else if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{}", path)
    }
}
```

New:

```rust
fn normalize_for_runtime(path: &str) -> String {
    if path.contains("://") {
        return path.to_string();
    }
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        "images://".to_string()
    } else {
        format!("images://{}", trimmed)
    }
}
```

This single change makes every existing schemeless slash path auto-promote to `images://...`. Schemeful paths pass through unchanged so the explicit `images://` (and future `albums://`, etc.) literals from Phase 2 internal callers still work.

**Tests added in the same step** (a new `tests/normalize_for_runtime.rs` integration test under `kabegame-core`, or extend an existing test module in `query.rs`):

- `empty_path_becomes_images_root` — `""` → `"images://"`.
- `slash_only_becomes_images_root` — `"/"` → `"images://"`.
- `schemeless_relative_path_gets_images_prefix` — `"gallery/all"` → `"images://gallery/all"`.
- `schemeless_absolute_path_gets_images_prefix` — `"/gallery/all"` → `"images://gallery/all"`.
- `schemeful_path_passes_through` — `"images://x100x/1"` → unchanged; `"vd://locale"` → unchanged.

**Verification gate.** `cargo test -p kabegame-core` green.

---

### Step 3a.2 — `browse_gallery_provider` / `list_provider_children` / `query_provider`: drop the leading-slash juggling

Behaviorally these now rely on step 3a.1's chokepoint. The local "if starts with '/' use as-is else format!('/{}', ...)" branches inside `list_provider_children` become dead — drop them.

**Edits.**

- `src-tauri/kabegame/src/commands/image.rs:53-66` — in `list_provider_children`, delete the `let path = if full.starts_with('/') ...` block. Use `full` directly when calling `rt.list(&full)`. `normalize_for_runtime` is not used here because the function calls the runtime directly via `rt.list(&path)`; we either (a) make this code call through `execute_provider_query_typed` (less surgery, more consistent), or (b) duplicate the chokepoint logic — prefer (a) by routing through a new tiny helper:

  Add to `src-tauri/kabegame-core/src/providers/query.rs` (export):
  ```rust
  pub fn runtime_path(raw: &str) -> String { normalize_for_runtime(raw) }
  ```
  Then `list_provider_children` calls `rt.list(&runtime_path(&full))` and `rt.count(&runtime_path(&child_path))`.

- `src-tauri/kabegame/src/commands_core/image.rs:60-92` — same change to its `list_provider_children`.

- `browse_gallery_provider` and `query_provider` already route through `execute_provider_query` / `execute_provider_query_typed`, both of which internally call `normalize_for_runtime`. No change needed.

**Tests.** None new at this step; covered by step 3a.1 unit tests plus step 3a.7 integration.

**Verification gate.** `cargo check -p kabegame --features standard` green.

---

### Step 3a.3 — Frontend: two surgical `query_provider` path edits

**Edits.**

- `apps/kabegame/src/App.vue:370` — change
  ```ts
  const path = `/images/id_${imageId}/`;
  ```
  to
  ```ts
  const path = `images://id_${imageId}/`;
  ```
  The literal `/images/` segment goes away — `images://` is now the scheme name, and `id_<X>` is resolved by `image_basic_provider` under the `images://` root (per Phase 2's restructure).

- `apps/kabegame/src/stores/albums.ts:231` — change
  ```ts
  path: "albums/all/",
  ```
  to
  ```ts
  path: "images://gallery/albums/all/",
  ```
  Reasoning: `albums` is a `resolve` entry on `gallery_route` (see `gallery_route.json5:142-147`), so the segment lives under `gallery/`. `query_provider` is generic and does NOT auto-prepend `gallery/` (only `browse_gallery_provider` does), so we spell it out explicitly. Could also be written as `gallery/albums/all/` and let step-3a.1's chokepoint promote it — but explicit scheme is clearer and self-documenting.

**Tests.** Frontend has no Rust-style unit harness for these store/component lookups. Coverage falls to step 3a.7 manual smoke.

**Verification gate.** `bun check -c kabegame` (Vue type check) green.

---

### Step 3a.4 — `rotator.rs`: 6 path migrations

**Edits.** `src-tauri/kabegame/src/wallpaper/rotator.rs`:

| Line | Old | New |
|---|---|---|
| 71 | `format!("/gallery/hide/album/{}/bigger_order/{}/l100l", id, o)` | `format!("images://gallery/hide/album/{}/bigger_order/{}/l100l", id, o)` |
| 74 | `format!("/gallery/hide/album/{}/bigger_order/0/l100l", id)` | `format!("images://gallery/hide/album/{}/bigger_order/0/l100l", id)` |
| 77 | `format!("/gallery/hide/bigger_crawler_time/{}/l100l", t)` | `format!("images://gallery/hide/bigger_crawler_time/{}/l100l", t)` |
| 79 | `"/gallery/hide/bigger_crawler_time/0/l100l".to_string()` | `"images://gallery/hide/bigger_crawler_time/0/l100l".to_string()` |
| 132 | `format!("/gallery/hide/album/{}/x100x", id)` | `format!("images://gallery/hide/album/{}/x100x", id)` |
| 133 | `"/gallery/hide/all/x100x".to_string()` | `"images://gallery/hide/all/x100x".to_string()` |

Rotator calls `provider_runtime().fetch/list` directly (not through the command wrapper), so the chokepoint doesn't reach it — explicit prefix required.

Update comments on those functions that say "provider path" or describe path syntax.

**Tests.**

- Add a unit test in the same file:
  - `gallery_source_paths_have_images_scheme` — for each `RotationSource` variant, assert the generated path starts with `images://gallery/hide/`.

**Verification gate.** `cargo test -p kabegame --features standard --lib wallpaper::rotator` green.

---

### Step 3a.5 — `mcp_server.rs`: minimum internal fix + TODO markers

**Edits.**

- `src-tauri/kabegame/src/mcp_server.rs:209-215` — replace `provider_path_for_runtime` body:
  ```rust
  fn provider_path_for_runtime(path: &str) -> String {
      // 3a: pathql-rs requires `<scheme>://` paths after Phase 1/2.
      // MCP's public `provider://` scheme wraps internal pathql traffic.
      // TODO(phase3b): once MCP unifies on first-class schemas
      // (image://, album://, task://, surf://, plugin://) we can drop
      // this translation and pass the resource URI directly.
      let trimmed = path.trim_start_matches('/');
      format!("images://{}", trimmed)
  }
  ```

- Above each bespoke handler in `read_resource` (lines 322 `"image"`, 362 `"album"`, 388 `"task"`, 412 `"surf"`, 438 `"plugin"`), add:
  ```rust
  // TODO(phase3b): replace with register_schema-backed pathql resolution.
  // See .claude/plans/pathql-schema-routing-phase3b-mcp.md (to be drafted).
  ```

- The `"provider"` branch (lines 552-704) is the one that actually wraps pathql. Audit it:
  - Line 564: `parse_provider_path(&path_part)` — fine.
  - Line 565: `normalize_mcp_provider_path` — still works; produces `gallery/...` / `images/...` / `vd/...` schemeless. Combined with the new `provider_path_for_runtime`, the final runtime path becomes `images://gallery/...` / `images://images/...` (uh — note the double "images" — see below) / `images://vd/...`.
  - **Caveat — "raw images path" semantics**: at line 79 of `MCP_INSTRUCTIONS` the doc advertises `provider://images/x100x/1` for raw image rows. Today that resolves through old `root_provider → images_root_provider → ...`. After Phase 2 + this step, `normalize_mcp_provider_path` keeps it as `images/x100x/1`, `provider_path_for_runtime` produces `images://images/x100x/1` — but `images_root_provider` (the new schema root) doesn't list `images` as a child. This call would 404.
  - **Fix**: special-case in `normalize_mcp_provider_path` — when the MCP path starts with `images/` or equals `images`, strip the leading `images/` (since `images://` already names the scheme). Update accordingly.
  - **Also update** `MCP_INSTRUCTIONS` doc text for the `provider://images/x100x/1` and `provider://images/id_{id}/metadata` examples so the rendered URI still works — they're public-facing; keep the public spelling, just make sure the internal translation strips the redundant segment.

- Tests:
  - `provider_path_for_runtime_strips_leading_slash` — `"/gallery/all"` → `"images://gallery/all"`.
  - `provider_path_for_runtime_appends_scheme_to_relative` — `"gallery/all"` → `"images://gallery/all"`.
  - `provider_path_for_runtime_idempotent_on_schemeful` — `"images://x"` → unchanged.
  - `normalize_mcp_provider_path_strips_redundant_images_root` — `"images/x100x/1"` → `"x100x/1"` (post-fix).

**Verification gate.** `cargo check -p kabegame --features standard` green. The MCP `provider://gallery/all/` flow round-trips correctly when run manually against the dev server.

---

### Step 3a.6 — Documentation

**Edits.**

- `cocs/provider-dsl/RULES.md`:
  - §2 path folding pseudo-code — update to show scheme parsing as the first step (`scheme, rest = path.split('://')`; `composed.from = schema.from`).
  - §3 table — already reflects Phase 2 (no `from` row); verify and adjust wording.
  - §3.1 — keep the "from is fixed by the schema" sentence.
  - §13.4 (root) — rename to "13.4 Schema registry" and describe `register_schema(scheme, from, namespace, provider_name)`.
  - Add new §14 "Host schema registration contract" with the API signature and rationale.
- `cocs/provider-dsl/VD_INTEGRATION.md` — replace `/vd/...` examples with `images://vd/...` (the locale segments and i18n routing are unchanged; only the prefix moves).
- `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md` — replace `/gallery/...` and `/images/...` examples with `images://gallery/...` and `images://...`.

**Tests.** Documentation-only step.

**Verification gate.** Grep:
- `rg '\b/gallery/' cocs/` — no live path-example hits (only inside historical context).
- `rg '\b/vd/'      cocs/` — same.

---

### Step 3a.7 — End-to-end verification

1. `cargo test -p pathql-rs --features json5,validate` — green (regression).
2. `cargo test -p kabegame-core` — green, including step 3a.1's `normalize_for_runtime` cases.
3. `cargo test -p kabegame --features standard` — green, including step 3a.4's rotator test and step 3a.5's MCP path-translation tests.
4. `bun check -c kabegame` — clean (Vue + Cargo workspace).
5. `bun dev -c kabegame` smoke:
   - Open gallery; navigate page sizes (x100x/x500x/x1000x), pagination, plugin filter, date filter, album view.
   - Open an album, scroll, sort by various criteria — exercises `browse_gallery_provider` heavily.
   - Open the **Albums list** page — exercises step 3a.3's `albums.ts` edit.
   - Open an image preview — exercises step 3a.3's `App.vue` edit (`query_provider` for `images://id_<X>/`).
   - Trigger wallpaper rotation source change — exercises step 3a.4's rotator.
   - VD navigation on a platform where VD is enabled (skip if not).
6. MCP smoke (if dev environment supports it):
   - `provider://all/?without=children` → page-1 image rows.
   - `provider://album/<some-id>/` → album entries.
   - `provider://images/x100x/1` → raw image rows (validates step 3a.5's redundant-segment fix).
7. Greps:
   - `rg '"/gallery|"/vd' src-tauri/kabegame/src apps/kabegame/src/(stores|views|components|composables|api|utils)` — 0 hits in pathql contexts. Vue-router `/gallery` literals are expected and acceptable.
   - `rg '"/images/' apps/kabegame/src` — 0 pathql hits (`/help-images/...` static-asset references are fine).
   - `rg '"from":' src-tauri/kabegame-core/src/providers/dsl/` — 0 hits.

---

## Out of scope (Phase 3a)

- New MCP-backing schemas (`image://`, `album://`, `task://`, `surf://`, `plugin://`) — Phase 3b.
- Reworking `apps/kabegame/src/utils/galleryPath.ts` — no need, chokepoint handles it.
- A typed frontend pathql API module — deferred until 3b confirms the schema surface.
- Renaming `images_root_provider` / `image_basic_provider` to clearer names — cosmetic.
- Removing the `provider://` MCP scheme — 3b decision.

---

## After Phase 3a

Write `pathql-schema-routing-phase3b-mcp.md`. It will cover:

1. **Design**: per-scheme bridge strategy
   - `image://{id}` — pure DSL; new `image_resource_provider.json5` with `from: images` and `resolve: "([^/]+)" → image_lookup_provider`.
   - `album://{id}` — pure DSL; needs `albums` table whitelist check, plus the existing `get_album(id)` SQL function (RULES.md §11.1).
   - `task://{id}` — pure DSL with `get_task(id)` SQL function.
   - `surf://{host}` — pure DSL with `get_surf_record` (or new keyed-by-host bridge).
   - `plugin://{id}` — **programmatic provider** (plugins live in `PluginManager`, not DB) OR new `get_plugin` extensions for icon/doc/doc_resource. Sub-paths (`/icon`, `/doc`, `/doc_resource/{key}`) return blobs not JSON rows — requires either a new pathql output type or a thin codec layer in `read_resource`.
2. **Registration**: register the new schemas in `init.rs` alongside `images`.
3. **mcp_server.rs rewrite**: `read_resource` becomes a uniform `runtime.fetch(&request.uri)` + blob codec; bespoke handlers deleted; TODOs from 3a.5 resolved.
4. **`provider://` scheme decision**: deprecate vs. keep as alias for `images://`.
5. **MCP_INSTRUCTIONS rewrite**: advertise the unified schemas.
6. **Tests**: each new scheme has a round-trip integration test that exercises both `runtime.fetch` and the MCP `read_resource` path.
