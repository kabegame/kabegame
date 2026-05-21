# Phase 3b — MCP schema unification: MCP reads route through `images://`, plural table schemas, and `plugin://`; `provider://` dropped

## Context

Phase 3a (build-green cutover) left the MCP server functionally broken-but-unified-internally: every `provider://` call goes through pathql via the new `images://` chokepoint, and the bespoke MCP read handlers are marked `TODO(phase3b)` while still talking directly to `Storage::global()` / `PluginManager::global()`.

Phase 3b finishes the unification: MCP agents read through pathql schemas directly. `image://` is unnecessary because image and metadata reads already work through `images://id_{id}` and `images://id_{id}/metadata`. DB-backed resources use plural table schemas instead of singular MCP-only schemas:

- `albums://all` lists albums; `albums://id_{id}` reads one album.
- `tasks://all` lists tasks; `tasks://id_{id}` reads one task.
- `surf_records://all` lists surf records; `surf_records://id_{id}` reads one surf record.

The bespoke handlers in `mcp_server.rs` shrink to a thin codec that calls `runtime.fetch/list(&request.uri)` and projects the resulting `serde_json::Value` rows into the existing domain structs.

**User-confirmed design points:**

1. **Plugin bridge**: programmatic provider, registered via a new `ProviderRuntime::register_programmatic_provider` API that forwards to the existing `ProviderRegistry::register_provider<F>`. Plugins are not in the DB, so DSL with a SQL-function bridge would force synthetic `FROM (SELECT 1)` gymnastics; the programmatic path is cleaner.
2. **`provider://` scheme**: dropped entirely in 3b. MCP agents migrate to `images://` directly.
3. **No singular DB resource schemas**: do not add `image://`, `album://`, `task://`, or `surf://`. Image reads use the existing `images://` tree. Other DB tables use plural table schemas with `all` for collection reads and `id_{id}` for single-row reads.
4. **camelCase contract**: deserialize pathql rows into the existing Rust structs (`Album`, `TaskInfo`, `SurfRecord`, `ImageInfo`), then re-serialize. To make this work, structs are migrated to split-direction `#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]` and existing field-level `#[serde(rename = "fooBar")]` attrs become `#[serde(rename(serialize = "fooBar"))]`.

---

## Reference points

- Programmatic provider registry slot: [src-tauri/pathql-rs/src/registry.rs:67-86](../../src-tauri/pathql-rs/src/registry.rs#L67-L86) (`register_provider<F>`).
- DSL-only runtime wrapper today: [src-tauri/pathql-rs/src/provider/runtime.rs:171-179](../../src-tauri/pathql-rs/src/provider/runtime.rs#L171-L179) (`register_provider(ProviderDef)` — DSL only).
- MCP server: [src-tauri/kabegame/src/mcp_server.rs](../../src-tauri/kabegame/src/mcp_server.rs) — 1000+ lines, 6 scheme branches in `read_resource`.
- Existing host SQL functions: [src-tauri/kabegame-core/src/storage/dsl_funcs.rs](../../src-tauri/kabegame-core/src/storage/dsl_funcs.rs) — `get_plugin`, `crawled_at_seconds`, `vd_display_name`, `name_language_*`.
- Domain structs:
  - `ImageInfo` — [src-tauri/kabegame-core/src/storage/images.rs:12](../../src-tauri/kabegame-core/src/storage/images.rs#L12) (`rename_all = "camelCase"` + ~10 explicit `rename` attrs).
  - `Album` — [src-tauri/kabegame-core/src/storage/albums.rs:23-28](../../src-tauri/kabegame-core/src/storage/albums.rs#L23-L28) (`rename_all = "camelCase"`, fields: `id`, `name`, `created_at`, `parent_id`).
  - `TaskInfo` — [src-tauri/kabegame-core/src/storage/tasks.rs](../../src-tauri/kabegame-core/src/storage/tasks.rs) (`rename_all = "camelCase"` + many explicit renames).
  - `SurfRecord` — [src-tauri/kabegame-core/src/storage/surf_records.rs](../../src-tauri/kabegame-core/src/storage/surf_records.rs) (`rename_all = "camelCase"`).
- Phase 2's already-shipped image providers (reused directly through `images://`, with no `image://` schema):
  - `dsl/images/images_id_provider.json5` — `WHERE images.id = ${properties.image_id} LIMIT 1`.
  - `dsl/images/images_metadata_provider.json5` — joins to image_metadata and projects `data`.
- Existing plugin-provider infrastructure (loading plugin DSL from `.kgpg`): [.claude/plans/plugin-provider-phase1.md](plugin-provider-phase1.md), [.claude/plans/plugin-provider-phase2.md](plugin-provider-phase2.md). Phase 3b's programmatic-provider API does NOT depend on this; it's an independent kabegame-core programmatic provider for the host-managed PluginManager.

## DB schemas (from `storage/migrations/init.rs`)

- `images(id INTEGER PK, url, local_path, plugin_id, task_id, surf_record_id, crawled_at, metadata_id, thumbnail_path, hash, type, width, height, display_name, last_set_wallpaper_at, size, description)`
- `image_metadata(id INTEGER PK, data TEXT, content_hash TEXT UNIQUE)`
- `tasks(id TEXT PK, plugin_id, output_dir, user_config, http_headers, output_album_id, run_config_id, trigger_source, status, progress, deleted_count, dedup_count, success_count, failed_count, start_time, end_time, error)`
- `albums(id TEXT PK, name, created_at, parent_id)`
- `surf_records(id TEXT PK, host TEXT UNIQUE, root_url, icon BLOB, last_visit_at, download_count, deleted_count, created_at, name, cookie)`

---

## Step sequence

Phase 3b can be ordered to keep the build green at every step: add or extend the plural pathql schemas first, then land MCP cleanup last. The runtime stays valid throughout; only `mcp_server.rs` accumulates dead code that gets removed in step 3b.8.

### Step 3b.1 — Add `ProviderRuntime::register_programmatic_provider`

**Edit.** `src-tauri/pathql-rs/src/provider/runtime.rs`. Below the existing `register_provider(ProviderDef)` method (around line 171), add:

```rust
/// Register a programmatic provider via factory. The factory is invoked
/// each time pathql instantiates the provider at a given path with
/// concrete properties. Equivalent semantically to a DSL provider but
/// the implementation is Rust code (used when data isn't SQL-shaped —
/// e.g. PluginManager-backed `plugin://`).
pub fn register_programmatic_provider<F>(
    &self,
    namespace: &str,
    name: &str,
    properties: Vec<PropertyDecl>,
    factory: F,
) -> Result<(), EngineError>
where
    F: Fn(&HashMap<String, TemplateValue>, &ProviderContext)
            -> Result<Arc<dyn Provider>, EngineError>
        + Send
        + Sync
        + 'static,
{
    let mut registry = (*self.registry.load_full()).clone();
    let key = ProviderKey::new(namespace, name);
    registry.register_provider(
        Namespace(namespace.to_string()),
        SimpleName(name.to_string()),
        properties,
        factory,
    )?;
    self.registry.store(Arc::new(registry));
    self.invalidate_provider_cache(&key);
    Ok(())
}
```

(Signature is illustrative — the exact `factory` shape must match what `ProviderRegistry::register_provider<F>` already accepts.)

**Tests** (in `src-tauri/pathql-rs/src/provider/runtime.rs` test module):

- `programmatic_provider_registered_and_resolvable` — register a fake `test_prov` with a factory that returns a stub Provider that lists `["a", "b"]`; register a schema `test://` pointing to it; assert `runtime.list("test://").names == ["a","b"]`.
- `programmatic_provider_properties_passed_to_factory` — register a provider whose factory captures the properties; resolve a path that passes `{key: "value"}`; assert the factory received the map.
- `programmatic_and_dsl_coexist_in_registry` — register one DSL and one programmatic provider in the same namespace; assert both lookup paths work.

**Verification.** `cargo test -p pathql-rs --features json5,validate` green.

---

### Step 3b.2 — Migrate domain structs to split-direction serde

**Goal.** Make `Album`, `TaskInfo`, `SurfRecord`, `ImageInfo` accept snake_case JSON input (what pathql emits from `SELECT albums.created_at, …`) while keeping camelCase JSON output (the MCP / frontend contract).

**Per struct, two changes:**

1. Replace `#[serde(rename_all = "camelCase")]` with `#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]`.
2. Walk every explicit `#[serde(rename = "xxx")]` field and:
   - If `xxx` happens to be `rename_all = "camelCase"`'s output for that field, **delete the attribute** (now redundant).
   - Else convert to `#[serde(rename(serialize = "xxx"))]` so the camelCase shape is preserved on output without breaking snake_case input.

For `ImageInfo` specifically, the `#[serde(rename = "type")]` on the media-type field is special — the input from pathql is `type` (SQL column name) and the output target is `type` (per MCP spec at mcp_server.rs:117). The serde rename attribute can stay as-is for both directions since `type` is identical in both shapes.

**Tests** (one per struct, in the same file as the struct):

- `album_deserializes_from_snake_case` — `serde_json::from_value::<Album>(json!({"id":"a","name":"n","created_at":123,"parent_id":null}))` succeeds.
- `album_serializes_to_camel_case` — `serde_json::to_value(album).keys().collect()` contains `"createdAt"`, `"parentId"` (NOT `"created_at"`).
- Same pair for `TaskInfo`, `SurfRecord`, `ImageInfo`.
- Pin existing call sites: at least one `from_str::<Album>(camelCase_json_str)` to ensure camelCase-input back-compat is gone or intentional. If any caller relies on it, decide per-caller (migrate or add `#[serde(alias = "createdAt")]`).

**Caveat to verify.** If any test or production code deserializes one of these structs from camelCase JSON (e.g. round-tripping its own output), it will break. Grep call sites:

```bash
rg 'from_value::<(Album|TaskInfo|SurfRecord|ImageInfo)>|from_str::<(Album|TaskInfo|SurfRecord|ImageInfo)>' src-tauri apps
```

If any of those callers pass camelCase, **add alias attributes per field** (`#[serde(rename(serialize = "createdAt"), alias = "createdAt")]`) to keep them working. Confirmed sources to check: front-end → tauri command boundary should be serialization only, but worth grepping.

**Verification.** `cargo check -p kabegame-core` green; `cargo test -p kabegame-core` green; struct-level tests pass.

---

### Step 3b.3 — Use the existing `images://` schema for image MCP reads

**No new `image://` schema.** Image reads route through the already-registered `images://` schema:

- `images://id_{id}` — single image row via existing `images_id_provider`.
- `images://id_{id}/metadata` — metadata JSON via existing `images_metadata_provider`.
- `images://gallery/all`, `images://x100x/1`, etc. — gallery browse paths that already exist from Phase 2.

The MCP server should accept/document `images://...` directly and should not register or advertise `image://`.

**Tests** (`tests/mcp_schemas.rs` integration file):

- `images_single_lookup_returns_one_row` — seed an `images` row with `id=42`; `runtime.fetch("images://id_42")` returns a 1-element `Vec<JsonValue>` whose `id` is `"42"` (or `42` — verify the column type cast).
- `images_metadata_subpath` — seed `images` + `image_metadata` join; `runtime.fetch("images://id_42/metadata")` returns the metadata JSON row.
- `images_missing_id_returns_empty` — `runtime.fetch("images://id_nonexistent")` returns empty `Vec`.
- `images_row_deserializes_into_ImageInfo` — `serde_json::from_value::<ImageInfo>(row)` succeeds for a seeded row.

**Verification.** `cargo test -p kabegame-core --test mcp_schemas images_` green.

---

### Step 3b.4 — `albums://` plural table schema

**Update the existing album DSL.** `albums://` is already registered in `init.rs`; keep that schema and extend its root so table reads use the plural path contract:

- `albums://all` — all albums, ordered by `created_at DESC`.
- `albums://id_{id}` — one album by `albums.id`.

`dsl/albums/albums_root_provider.json5` should route both explicit collection and id reads:

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "albums_root_provider",
    "query": {},
    "list": {
        "all": { "provider": "albums_all_provider" }
    },
    "resolve": {
        "all": { "provider": "albums_all_provider" },
        "id_([^/]+)": {
            "provider": "albums_id_provider",
            "properties": { "album_id": "${capture[1]}" }
        }
    }
}
```

Add `dsl/albums/albums_id_provider.json5`:

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "albums_id_provider",
    "properties": {
        "album_id": { "type": "string", "default": "", "optional": false }
    },
    "query": {
        "fields": [
            { "sql": "albums.id", "as": "id" },
            { "sql": "albums.name", "as": "name" },
            { "sql": "albums.created_at", "as": "created_at" },
            { "sql": "albums.parent_id", "as": "parent_id" }
        ],
        "where": "albums.id = ${properties.album_id}",
        "limit": 1
    }
}
```

**Do not register `album://`.** `runtime.register_schema("albums", "albums", "kabegame", "albums_root_provider")` is the table schema.

**Tests:**

- `albums_all_lists_all_ordered_by_created_at_desc` — seed 3 albums with distinct `created_at`; `runtime.fetch("albums://all")` returns rows in descending order.
- `albums_by_id_returns_one` — `runtime.fetch("albums://id_A")` returns the album.
- `albums_row_deserializes_into_Album` — `from_value::<Album>(row)` succeeds for both the list and the single forms.

**Verification.** `cargo test -p kabegame-core --test mcp_schemas albums_` green.

---

### Step 3b.5 — `tasks://` plural table schema

**New DSL files** following the album pattern. The `tasks` table has a richer schema (17 columns) so the fields block enumerates explicitly OR uses `tasks.*` (preferred if pathql preserves the exact column names).

`dsl/tasks/tasks_root_provider.json5`:

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "tasks_root_provider",
    "query": {},
    "list": {
        "all": { "provider": "tasks_all_provider" }
    },
    "resolve": {
        "all": { "provider": "tasks_all_provider" },
        "id_([^/]+)": {
            "provider": "tasks_id_provider",
            "properties": { "task_id": "${capture[1]}" }
        }
    }
}
```

`dsl/tasks/tasks_all_provider.json5` and `dsl/tasks/tasks_id_provider.json5` should project the task table rows with snake_case keys matching `TaskInfo` deserialization. The id provider filters with:

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "tasks_id_provider",
    "properties": {
        "task_id": { "type": "string", "default": "", "optional": false }
    },
    "query": {
        "fields": ["tasks.*"],
        "where": "tasks.id = ${properties.task_id}",
        "limit": 1
    }
}
```

**Register.** `runtime.register_schema("tasks", "tasks", "kabegame", "tasks_root_provider")`.

**Do not register `task://`.** MCP reads use `tasks://all` and `tasks://id_{id}`.

**JSON-column note.** `tasks.user_config` and `tasks.http_headers` are JSON-encoded TEXT columns. Today `TaskInfo` deserializes them as `Option<HashMap<...>>` via custom serde or a from_row impl. After 3b.2, `from_value::<TaskInfo>(row)` must handle these — verify that the existing struct attrs accept a JSON-string-in-a-JSON-string from pathql (likely needs `#[serde(deserialize_with = "deserialize_json_string")]` on those fields). Add a fixture test that confirms round-trip.

**Tests:**

- `tasks_all_lists_all`, `tasks_by_id_returns_one`, `tasks_row_deserializes_into_TaskInfo`.
- `tasks_with_user_config_json_deserializes` — seed a task with non-null `user_config`; verify the deserialization unwraps the inner JSON correctly.

---

### Step 3b.6 — `surf_records://` plural table schema

**New DSL files** following the album pattern. Because this is the table schema, the primary single-row path is `surf_records://id_{id}`. Do not preserve the old `surf://{host}` shape as a separate schema; if host lookup is later required, add it as an explicit `surf_records://host_{host}` route in this same plural schema.

`dsl/surf_records/surf_records_root_provider.json5`:

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "surf_records_root_provider",
    "query": {},
    "list": {
        "all": { "provider": "surf_records_all_provider" }
    },
    "resolve": {
        "all": { "provider": "surf_records_all_provider" },
        "id_([^/]+)": {
            "provider": "surf_records_id_provider",
            "properties": { "surf_record_id": "${capture[1]}" }
        }
    }
}
```

`dsl/surf_records/surf_records_all_provider.json5` and `dsl/surf_records/surf_records_id_provider.json5` should project `surf_records.*` with `last_visit_at DESC` ordering for `all`. The id provider filters with:

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "surf_records_id_provider",
    "properties": {
        "surf_record_id": { "type": "string", "default": "", "optional": false }
    },
    "query": {
        "fields": ["surf_records.*"],
        "where": "surf_records.id = ${properties.surf_record_id}",
        "limit": 1
    }
}
```

**`icon` BLOB caveat.** `surf_records.icon` is a `BLOB` column. SQLite returns it as `Vec<u8>` which serde_json typically renders as a JSON array of bytes — ugly but functional. The existing MCP `surf://` response returned SurfRecord verbatim, so the expected table-schema behavior is "icon as byte array in JSON". Keep that. If the on-wire shape must change, do it in a follow-up; the icon field deserializes via `Option<Vec<u8>>` in SurfRecord.

Verify with a test: a surf record with a small icon round-trips through pathql → `from_value::<SurfRecord>` and emits an `icon` array on output.

**Register.** `runtime.register_schema("surf_records", "surf_records", "kabegame", "surf_records_root_provider")`.

**Do not register `surf://`.** MCP reads use `surf_records://all` and `surf_records://id_{id}`.

**Tests:**

- `surf_records_all_lists_all_ordered_by_last_visit`, `surf_records_by_id_returns_one`, `surf_records_with_icon_blob_roundtrips`.

---

### Step 3b.7 — `plugin://` schema (programmatic provider)

This is the biggest single step. Plugins live in `PluginManager::global()`, not the DB. The programmatic provider returns JSON rows for `runtime.fetch` that match the existing MCP wire shape — including base64-wrapped blobs for `/icon` and `/doc_resource/{key}`.

**New module.** `src-tauri/kabegame-core/src/providers/programmatic/plugin_resource.rs` (or extend an existing programmatic folder if Phase-2 already created one — verify with `ls src-tauri/kabegame-core/src/providers/programmatic/ 2>/dev/null`).

**Provider tree shape.**

- `plugin://` — root provider; `list_children` returns `PluginManager::global().get_all()` (one `ChildEntry` per plugin, `name = plugin.id`).
  - `runtime.fetch("plugin://")` returns `Vec<JsonValue>` where each value is the trimmed plugin JSON (matching today's `serialize_plugin_lite`).
- `plugin://{id}` — single plugin (trimmed) — same trimming as `serialize_plugin_lite`.
- `plugin://{id}/icon` — single-row, JSON shape `{ "iconPngBase64": "<base64>" }`.
- `plugin://{id}/description_template` — `{ "descriptionTemplate": "<ejs text>" }`.
- `plugin://{id}/doc` — `{ "doc": "<markdown>" }` (default locale).
- `plugin://{id}/doc_resource/{key}` — `{ "key": "...", "mime": "image/png", "dataBase64": "<base64>" }`.

**Provider trait impls** (one per node — `PluginRootProvider`, `PluginEntryProvider`, four leaf providers). Each implements the four ops from RULES.md §12.2 (`apply_query` / `list` / `resolve` / `get_note`). Concretely:

- `PluginRootProvider::list(_)` returns one `ChildEntry { name = plugin.id, provider = Some(Arc<PluginEntryProvider { plugin_id }>) }` per plugin.
- `PluginRootProvider::resolve(seg, _)` looks up `PluginManager.get(seg)` and returns the same entry or `None`.
- `PluginEntryProvider::list(_)` returns the four sub-resource ChildEntries (`icon`, `description_template`, `doc`, `doc_resource`). The `doc_resource` entry could be expanded dynamically (one ChildEntry per `doc_resources.keys()`) — defer unless needed by MCP `list_resources`.
- `PluginEntryProvider::resolve(seg, _)` routes to one of the leaf providers; the `doc_resource` segment then has its own provider that captures the next segment as `resource_key`.

**Properties** (per `register_programmatic_provider`):

- Root: no properties.
- Entry: `plugin_id`.
- Icon / description_template / doc: `plugin_id`.
- DocResource: `plugin_id`, `resource_key`.

**JSON output shape from `fetch`.** Programmatic providers express results via the same `Vec<serde_json::Value>` row contract as DSL — pathql doesn't know whether the data came from SQL. Each leaf's "row" is the single object shown above. MCP server uses `ResourceContents::blob` for `/icon` and `/doc_resource/*` after base64-decoding the wrapper string; uses `ResourceContents::text` for `/description_template` and `/doc`.

**Schema registration in `init.rs`.** Since the root is programmatic, the schema registration would look like:

```rust
runtime.register_programmatic_provider(
    "kabegame",
    "plugin_resource_root_provider",
    vec![], // no properties at root
    |_props, _ctx| Ok(Arc::new(PluginRootProvider {})),
)?;
runtime.register_schema(
    "plugin",
    "<unused — plugin provider doesn't query SQL>",
    "kabegame",
    "plugin_resource_root_provider",
)?;
```

**Schema `from` for a SQL-less provider.** `register_schema` requires a `from`. Since plugin provider never builds SQL, the `from` value is inert — but pathql will seed `ProviderQuery.from = Some("<value>")`. Pick a placeholder like `"(SELECT 1)"` or — better — make `register_schema` accept `Option<SqlExpr>` so programmatic schemas can declare no FROM. The latter is a small pathql-rs change; do it in this step if needed:

  ```rust
  pub fn register_schema(
      &self,
      scheme: &str,
      from: Option<impl Into<SqlExpr>>, // was: impl Into<SqlExpr>
      namespace: &str,
      provider_name: &str,
  ) -> Result<(), EngineError>
  ```

  Existing call sites pass `Some("images")`; the new plugin one passes `None`. SchemaRoot stores `from: Option<SqlExpr>`. Compose chokepoint seeds `composed.from = schema.from.clone()` (no-op when None — but then `BuildError::MissingFrom` would fire if any descendant tried to build SQL; the programmatic plugin tree never does, so it's safe). Add a test that `register_schema(_, None, ...)` works and `runtime.fetch` on its tree succeeds without `MissingFrom`.

**Tests** (`tests/mcp_schemas.rs`):

- `plugin_root_lists_all` — seed a fake `PluginManager` with two plugins; `runtime.list("plugin://")` returns the two `ChildEntry`s.
- `plugin_entry_returns_trimmed_json` — `runtime.fetch("plugin://pixiv")` returns one row matching the today's `serialize_plugin_lite` shape.
- `plugin_icon_returns_base64` — `runtime.fetch("plugin://pixiv/icon")` returns `{"iconPngBase64": "..."}`.
- `plugin_doc_returns_markdown` — `runtime.fetch("plugin://pixiv/doc")` returns the default-locale doc string.
- `plugin_doc_resource_returns_blob_wrapper` — `runtime.fetch("plugin://pixiv/doc_resource/readme.png")` returns `{"key":"readme.png","mime":"image/png","dataBase64":"..."}`.
- `plugin_unknown_id_resolves_to_none` — `runtime.resolve("plugin://ghost").provider` is `None`.

---

### Step 3b.8 — Rewrite `mcp_server.rs`: drop `provider://` and singular DB resource handlers

**Big edits in [src-tauri/kabegame/src/mcp_server.rs](../../src-tauri/kabegame/src/mcp_server.rs):**

1. **Delete** the entire `provider://` arm of `read_resource` (currently lines 552-704).
2. **Delete** the helper functions only used by that arm: `normalize_mcp_provider_path` (line 194), `provider_path_for_runtime` (line 209), `parse_mcp_without` (line 159), `McpWithout` enum (line 152), the import of `parse_provider_path` / `execute_provider_query` / `ProviderPathQuery` from `kabegame_core::providers`.
3. **Delete** `PROVIDER_URI_PREFIX` constant (line 24).
4. **Delete or stop advertising singular DB schemes**: `image://`, `album://`, `task://`, and `surf://`. They should be unknown schemes after this phase. Use `images://`, `albums://`, `tasks://`, and `surf_records://` instead.
5. **For each supported pathql-backed read scheme** (`images`, `albums`, `tasks`, `surf_records`, `plugin`), replace bespoke storage calls with a uniform helper:

   ```rust
   async fn fetch_resource_rows(uri: &str) -> Result<Vec<serde_json::Value>, McpError> {
       let rt = provider_runtime();
       tokio::task::spawn_blocking({
           let uri = uri.to_string();
           move || rt.fetch(&uri)
       })
       .await
       .map_err(|e| McpError::internal_error(e.to_string(), None))?
       .map_err(|e| McpError::internal_error(format!("pathql: {e}"), None))
   }
   ```

   Then each scheme arm calls `fetch_resource_rows(&request.uri).await` and wraps JSON in `ResourceContents::text(...).with_mime_type("application/json")`, with these path-shape rules:

   - **`images`**: `images://id_{id}` returns a single unwrapped image object; `images://id_{id}/metadata` returns the metadata row/object; browse paths like `images://gallery/all` return arrays.
   - **`albums` / `tasks` / `surf_records`**: `...://all` returns an array; `...://id_{id}` returns a single unwrapped object when exactly one row is returned.
   - **`plugin`** sub-paths (`/icon`, `/doc_resource/{key}`):
     - Fetch the JSON row.
     - Peel the wrapper: extract `iconPngBase64` / `dataBase64` and return `ResourceContents::blob(decoded_or_raw_base64, uri).with_mime_type(mime)`. The MCP `ResourceContents::blob` takes the base64 string directly per rmcp's API — verify by reading rmcp source — but logically, we hand it raw base64 OR raw bytes depending on the helper. Match the existing behavior at mcp_server.rs:472 (`ResourceContents::blob(data.clone(), request.uri).with_mime_type(mime)` where `data` is `Vec<u8>` — or actually a base64 string; verify).
     - `/description_template` and `/doc` return `ResourceContents::text(text, uri).with_mime_type("text/plain" | "text/markdown")`.

6. **Update `list_resources`** (line 261-309): remove `provider://` entries and singular `image://` / `album://` / `task://` / `surf://` entries. Advertise examples for `images://id_{id}`, `images://gallery/all`, `albums://all`, `tasks://all`, `surf_records://all`, and `plugin://`.
7. **Update `list_resource_templates`** (line 713-787): remove `provider://{+path}` and singular DB templates. Add:
   - `images://id_{id}`
   - `images://id_{id}/metadata`
   - `albums://id_{id}`
   - `tasks://id_{id}`
   - `surf_records://id_{id}`
   - Existing `plugin://{id}` / plugin sub-resource templates.
8. **Rewrite `MCP_INSTRUCTIONS`** (line 31-136):
   - Drop section "1) provider:// — PathQL provider path access" entirely.
   - Remove the "PathQL segment semantics" subsection (it was `provider://`-specific).
   - State the supported read schemes exactly:
     - `images://id_{id}` for one image; `images://id_{id}/metadata` for metadata; `images://gallery/all`, `images://x100x/1`, etc. for gallery browse.
     - `albums://all` to list albums; `albums://id_{id}` to read one.
     - `tasks://all` to list tasks; `tasks://id_{id}` to read one.
     - `surf_records://all` to list surf records; `surf_records://id_{id}` to read one.
     - `plugin://`, `plugin://{id}`, and plugin sub-resources.
   - Explicitly say not to use `provider://`, `image://`, `album://`, `task://`, or `surf://`.
   - Update all examples scattered through the doc to the plural table paths.

**Tests:**

- Reuse `tests/mcp_schemas.rs` from steps 3b.3-3b.7 but also add MCP-level integration:
  - `mcp_images_read_resource_returns_image_info_camelcase` — call `KabegameMcpServer::read_resource` with `images://id_42` and assert JSON has `createdAt` / `pluginId` keys.
  - `mcp_albums_all_returns_array` — `albums://all` returns `[ {...}, {...} ]`.
  - `mcp_albums_by_id_returns_object` — `albums://id_A` returns `{...}`.
  - `mcp_tasks_by_id_returns_object` — `tasks://id_T` returns `{...}`.
  - `mcp_surf_records_by_id_returns_object` — `surf_records://id_S` returns `{...}`.
  - `mcp_plugin_icon_returns_blob` — `plugin://pixiv/icon` returns `ResourceContents::blob` with mime `image/png`.
  - `mcp_provider_scheme_is_unknown` — `provider://gallery/all/` returns `unknown_scheme`. Pin the removal.
  - `mcp_singular_db_schemes_are_unknown` — `image://42`, `album://A`, `task://T`, and `surf://host` return `unknown_scheme`.

---

### Step 3b.9 — End-to-end verification

1. `cargo test -p pathql-rs --features json5,validate` — green.
2. `cargo test -p kabegame-core` — green, including `tests/mcp_schemas.rs`.
3. `cargo test -p kabegame --features standard` — green, including MCP integration tests.
4. `bun check -c kabegame` — clean (Phase 3a kept this green; nothing here should regress it).
5. Manual MCP smoke (via an MCP client / Inspector tool against `127.0.0.1:7490`):
   - `images://id_<existing-id>` — returns ImageInfo with camelCase keys.
   - `images://id_<existing-id>/metadata` — returns metadata JSON.
   - `images://gallery/all` — returns the gallery collection via the existing images tree.
   - `albums://all` — returns array of all albums; `albums://id_<id>` returns one.
   - `tasks://all` — returns array of all tasks; `tasks://id_<id>` returns one.
   - `surf_records://all` — returns array of all surf records; `surf_records://id_<id>` returns one.
   - `plugin://` — trimmed array; `plugin://<id>` — trimmed single; `/icon` returns base64 PNG; `/doc_resource/<key>` returns blob.
   - `provider://gallery/all/` — returns `unknown_scheme` error (drop confirmed).
   - `image://<existing-id>`, `album://<id>`, `task://<id>`, `surf://<host>` — return `unknown_scheme` error (singular DB schemas dropped).
6. Greps:
   - `rg 'normalize_mcp_provider_path|provider_path_for_runtime|parse_mcp_without|PROVIDER_URI_PREFIX' src-tauri/kabegame/src` → 0 hits.
   - `rg 'TODO\(phase3b\)' src-tauri/kabegame/src` → 0 hits.

---

## Open questions to resolve during execution (not blocking the plan)

1. **`tasks.user_config` / `http_headers` JSON columns.** Today's `TaskInfo::user_config` is `Option<HashMap<String, serde_json::Value>>` but the column is a JSON-encoded text. Verify whether the existing struct uses `deserialize_with` to unwrap the inner JSON or expects the row to already be an object. If the latter, pathql's row will have a JSON string in those positions — needs a custom `deserialize_with` to parse the inner JSON. Address in step 3b.5 once we see the actual struct attrs.

2. **`surf_records.icon` BLOB.** Whether the existing MCP output renders this as a base64 string or a byte array. If callers depend on a specific shape, the deserialization may need a custom impl. Address in step 3b.6.

3. **`plugin://` resolve order for sub-paths.** The resolve regex `([^/]+)` would catch `icon` / `description_template` etc. before sub-path routing if we structure it naively. Concretely, `plugin://pixiv/icon` resolves as: scheme=plugin, segments=["pixiv","icon"]. The plugin root provider resolves "pixiv" → PluginEntryProvider; then PluginEntryProvider.resolve("icon") → IconLeafProvider. This works because each layer handles its own segment. Verify in step 3b.7 with the `plugin_icon_returns_base64` test.

4. **MCP cache + invalidation.** Phase 1's LRU cache keys include the scheme. When a plugin gets unregistered / installed, the new `plugin://` schema needs cache invalidation — pathql already has `invalidate_provider_cache` per ProviderKey. Verify the cache key for programmatic providers ties to the right key. Likely a follow-up test in step 3b.7.

5. **Optional host lookup for surf records.** The plural table contract uses `surf_records://id_{id}`. If agents still need the old host-based lookup, add `surf_records://host_{host}` inside the same `surf_records://` schema instead of resurrecting `surf://`.

---

## Out of scope (Phase 3b)

- Plugin-package-provided MCP schemas (`.kgpg` files registering their own schemes) — would need a security model.
- Read-only filters / capability ACLs per schema — natural future extension.
- Singular DB-resource aliases (`image://`, `album://`, `task://`, `surf://`) — Phase 3b intentionally drops them in favor of `images://` and plural table schemas.
- Migrating the existing four MCP write tools (`set_album_images_order`, `create_album`, `add_images_to_album`, `rename_image`) — those stay as `call_tool`; they're orthogonal to the resource scheme question.
