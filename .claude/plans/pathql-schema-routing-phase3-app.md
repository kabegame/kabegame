# Phase 3 — app/frontend callers: migrate external PathQL paths to `images://`

## Context

Phase 1 moved pathql-rs to mandatory `scheme://` routing. Phase 2 registered the core `images://` schema, removed `from` from kabegame-core DSL, deleted `root_provider.json`, and migrated core-internal callers.

Phase 3 finishes the hard cutover outside `kabegame-core`: app crate callers, MCP/provider shims, Vue/Pinia path builders, and docs. Do not reintroduce a slash-path compatibility shim.

## Known Remaining Callers

Grep after Phase 2 shows live app/frontend path builders in:

- `src-tauri/kabegame/src/wallpaper/rotator.rs`
- `src-tauri/kabegame/src/mcp_server.rs`
- `apps/kabegame/src/App.vue`

The same grep also reports unrelated browser route paths such as `/gallery`, static asset paths such as `/images/...`, docs, and older plan files. Treat those as separate review items, not automatic PathQL migrations.

## Step Sequence

### Step 3.1 — Rust app crate callers

**Edits.**

- `src-tauri/kabegame/src/wallpaper/rotator.rs`
  - `/gallery/hide/...` provider paths become `images://gallery/hide/...`.
  - Update comments that describe provider paths.
- `src-tauri/kabegame/src/mcp_server.rs`
  - Update user-facing provider URI examples and any translation layer that maps `provider://gallery/...` or `provider://images/...` into runtime paths.
  - Preserve MCP public URI compatibility if the server intentionally exposes `provider://...`; only the internal runtime path should become `images://...`.

**Tests.**

- Add or update Rust tests around wallpaper path construction.
- Add MCP path-normalization tests that prove `provider://gallery/...` maps to `images://gallery/...` and `provider://images/x100x/1` maps to `images://x100x/1`.

**Verification.**

- `cargo check -p kabegame --features standard`
- Targeted Rust tests for the touched modules.

### Step 3.2 — Vue / Pinia runtime provider paths

**Edits.**

- `apps/kabegame/src/App.vue`
  - `/images/id_${imageId}/...` provider metadata path becomes `images://id_${imageId}/...` or goes through a shared helper.
- Search `apps/kabegame/src` for provider path strings and template-built PathQL routes. Keep Vue router paths like `/gallery` unchanged.
- Prefer a small helper for PathQL path construction if multiple frontend call sites remain.

**Tests.**

- If existing frontend tests cover the affected store/composable, update expected payloads.
- Otherwise add lightweight unit coverage for the helper or document manual smoke steps in the PR.

**Verification.**

- `bun check -c kabegame`
- Manual gallery metadata/preview smoke in `bun dev -c kabegame`.

### Step 3.3 — Documentation

**Edits.**

- `cocs/provider-dsl/RULES.md`
  - Replace global root / slash-path examples with schema registration and `images://` examples.
  - Document that `from` is no longer accepted in `ContribQuery`.
- `cocs/provider-dsl/VD_INTEGRATION.md`
  - Replace `/vd/...` runtime examples with `images://vd/...`.
- `cocs/gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md`
  - Replace `/gallery/...` and `/images/...` PathQL examples with `images://gallery/...` and `images://...`.
- Leave browser route docs (`/gallery`) and static image asset paths alone.

**Tests.**

- Documentation-only step; use grep acceptance.

**Verification.**

- `rg '"/gallery|"/vd|"/x100x|"/x500x|"/x1000x|"/id_' apps src-tauri packages`
  - Expected remaining hits must be reviewed and classified as browser routes/static assets/non-PathQL.
- `rg '"from":' src-tauri/kabegame-core/src/providers/dsl/` returns zero hits.

## End-of-Phase Verification

Run, in order:

1. `cargo test -p pathql-rs --features json5,validate`
2. `cargo test -p kabegame-core`
3. `cargo check -p kabegame --features standard`
4. `bun check -c kabegame`
5. Manual `bun dev -c kabegame` smoke:
   - gallery pagination/date/plugin/album navigation
   - image metadata modal or preview fetch
   - wallpaper rotation source path generation
   - VD tree navigation on a platform where VD is enabled

## Out of Scope

- Reintroducing slash-path fallback.
- Plugin-side schema registration.
- Reworking browser route names (`/gallery`) or static asset paths (`/images/...`).
