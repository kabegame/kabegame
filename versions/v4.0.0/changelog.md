# v4.0.0 changelog

## Breaking Changes

- **MCP URI schemes (hard switch)** — The single `kabegame://` scheme has been split into six dedicated schemes: `provider://`, `album://`, `task://`, `surf://`, `image://`, `plugin://`. There is **no backward-compatible alias**; any cached `kabegame://…` URI in MCP clients must be updated.
  - `provider://<path>` supports `?without=children` or `?without=images` (at most one) on List / ListWithMeta modes to trim Dir / Image entries for narrower context windows.
  - `album://` / `task://` / `surf://` without id now return the **full list** of entities; `{scheme}://{id}` returns a single entity.
  - `plugin://` and `plugin://{id}` return **trimmed** Plugin JSON — `docResources`, `iconPngBase64`, and `descriptionTemplate` are stripped. Fetch them on demand via `plugin://{id}/icon`, `plugin://{id}/description_template`, `plugin://{id}/doc`, and `plugin://{id}/doc_resource/{key}`.
  - MCP `instructions` rewritten to document the new schemes, `ProviderMeta` shapes, `ImageInfo` fields (note: serde key is `type`, not `mediaType`), and the "do not batch-fetch plugin meta" warning.
- **Database migration overhaul** — The legacy inline migration code (hundreds of lines of `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` / `perform_complex_migrations` etc.) has been removed. The database schema is now defined in a single authoritative `migrations/init.rs`.
  - **Upgrade path**: Only users on **v3.5.x** (database `user_version = 7`) are supported for a seamless upgrade. Users on older versions will see an error on launch and must either upgrade to v3.5.x first, or delete their user data directory and re-import local images.
  - **Linux (deb)**: Running `apt purge kabegame` now also removes user data directories (`~/.local/share/com.kabegame`, `~/.config/com.kabegame`, `~/.cache/com.kabegame`). Use `apt remove` to uninstall without deleting data.
- Future database migrations should be added as versioned files under `src-tauri/kabegame-core/src/storage/migrations/` following the pattern described in `migrations/mod.rs`.

## Added

- **Android:** - request for battery use when start crawl task or start wallpaper rotation.
- **MCP:** Now you can orginaze your images with outer AI. create albums、add images to an album、summerize your albums、write auto configs、even write a plugin for you.

## Optimized

- **Provider architecture (full refactor):**
  - New `Provider` trait with **internalized merge strategy**: each provider implements `apply_query(current: ImageQuery) -> ImageQuery` and owns its own join / where / order contribution; the runtime only threads the composed query down the chain without inspecting it.
  - `list_children(&self, composed) -> Vec<ChildEntry>` returns only structural children; image enumeration is a separate `list_images(&self, composed)` call so the runtime never conflates the two.
  - `ResolvedNode { provider, composed }` replaces ad-hoc pair passing; LRU caching on resolved nodes in `ProviderRuntime` makes repeated navigation / listing cheap.
  - **`SortProvider`** cleanly flips `ASC ↔ DESC` at `desc` boundaries via `current.to_desc()`, instead of being open-coded in each parent.
  - New **`shared/`** providers consolidate previously duplicated logic: `plugin`, `task`, `surf`, `media_type`, `album`, and the date chain (`years` / `year` / `month` / `day`) with `prepend_order_by` so time sorts are placed before the stable `id ASC` tiebreaker.
  - **Terminal pagination** is now the single `QueryPageProvider` (offset/limit lives only here); `page = None` = root (last page + lists `1..=N` child pages), `page = Some(n)` = leaf.
  - VD routing shells (root / all / by_plugin / by_task / by_surf / by_type / by_time / albums / sub_album_gate) and Gallery routing shells (8 files) are rewritten against the new trait; `GalleryDateScopedLeafProvider` is gone.
  - Consumer layer (`virtual_driver::semantics`, gallery `query`/`browse`, commands) migrated to the new trait; `browse_from_provider` performs **zero** secondary DB lookups — storage assembles `ImageInfo` in a single SQL with favorite/thumbnail/size joined.

## Removed

- **VD:** some useless folder. Just keep simple
- **Legacy `Provider` trait** (pre-refactor) and all compatibility shims; the legacy `QueryPageProviderV2` was promoted to the canonical `QueryPageProvider`.
- **`Storage::get_image_entries_by_query`** — superseded by `get_images_info_range_by_query`, which returns fully-populated `ImageInfo` so callers no longer need per-row follow-up queries.
