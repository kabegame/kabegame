# Changelog

本项目的所有显著变更都会记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

**Changelog entries:** Write release notes in **English** (new sections and bullets from [3.4.5] onward).

## [4.1.0]

### Added

- **Provider DSL migration:** Most gallery, virtual-disk, MCP, wallpaper-rotation, organize, album, task, surf, plugin, media-type, date, search, wallpaper-order, raw-image, and image-metadata provider paths now run through declarative PathQL provider DSL files instead of hand-written programmatic provider/router code. The public path surface stays path-first (`fetch(path)`, `count(path)`, list children, and provider-backed helper APIs), while the implementation is now data-driven and easier to extend.
- **Plugin-owned provider trees:** Installed crawler plugins can ship provider DSL files in their package and expose nested provider subtrees through their plugin entry provider. Gallery's "by plugin" tree and the virtual-disk plugin folders now share the same plugin-owned provider contract, so plugin-specific browse paths can come from plugin metadata instead of app-specific UI logic.
- **Raw image provider channel:** Added an explicit `/images` provider tree for automation and MCP use, including paged raw image rows and `/images/id_{id}/metadata` metadata lookup paths.
- **Album detail tabs:** AlbumDetail now switches between an image grid tab and a sub-albums tab instead of rendering child albums as an expandable block above the image grid.
- **In-app background image:** Added a frontend-local app background that mirrors the current wallpaper image across all platforms. The feature is enabled by default and includes local settings for enable/disable, opacity, and blur, exposed in Settings and Quick Settings.

### Changed

- **Provider path semantics:** Pagination, plain limit, ordering, count, child listing, and metadata lookup semantics are now represented consistently in provider paths. Page-list folders are exposed across equivalent gallery and virtual-disk branches rather than only under `all`.
- **MCP/provider automation:** MCP-facing provider reads now have clearer path semantics and can use the DSL-backed provider tree directly for gallery browsing, raw image enumeration, image metadata, and album-order workflows.
- **Gallery / AlbumDetail sticky scrolling:** Gallery and AlbumDetail now use the `ImageGrid` scroll context for their page header, browse toolbar, and big paginator, so sticky headers and paginators pin inside the same scroll container as the image grid. Horizontal layouts keep the inner horizontal scroll container to preserve item sizing.
- **ImageGrid scroll controls:** The floating scroll controls are simplified to explicit edge shortcuts: show top/bottom arrows whenever the vertical container is not at that edge, and show left/right arrows for horizontal scroll containers. Programmatic edge scrolling now cancels in-flight smooth-wheel animation before jumping.
- **ImageGrid / preview shortcuts:** Backspace now hides the selected grid images or current preview image through the existing `addToHidden` action, while Delete keeps the permanent-delete flow and confirmation dialog. Help shortcut docs and i18n copy now describe the split behavior.
- **Web wallpaper action:** In web mode, the image action is labeled "Set as background" and stores `currentWallpaperImageId` in localStorage instead of showing the desktop-only wallpaper guard. Multi-select falls back to setting the first selected image as the in-app background.
- **Background-aware cards:** Settings cards and Plugin Browser plugin cards become transparent only while the in-app background setting is enabled, using UnoCSS utility classes so the normal theme remains unchanged when the feature is off.

### Fixed

- **Gallery desktop filter tree:** Changing the Gallery search query no longer collapses the whole provider filter popover into a single global "Loading" row. The tree keeps its root rows visible and lazy-loads only the expanded branch.
- **Gallery / AlbumDetail big paginator input:** Hovering or focusing the paginator page input no longer adds a physical border that changes the paginator height and causes layout jitter.
- **Crawler output album picker:** Hidden albums are now filtered out of CrawlerDialog's output-album picker, matching other album move/picker flows.
- **Album image count:** AlbumDetail totals are loaded through the provider count path instead of deriving the total from the current page size, so the tab label and big paginator use the full matching image count.
- **ImageGrid whole-container virtual scroll:** Grid-mode virtual scrolling now accounts for the offset of `before-grid` content such as headers, toolbars, and paginators, preventing short pages and blank space when the whole `ImageGrid` container is the scroll element.
- **ImageGrid horizontal mode:** Horizontal grid mode keeps correct item sizing with `scrollWholeContainer`, supports virtual scrolling by calculating visible column groups from `scrollLeft`, and rebinds scroll listeners when the active scroll element changes between vertical and horizontal layouts.
- **ImageGrid preview sync:** Preview navigation that wraps from the last image to the first image, or from the first image to the last image, now scrolls the virtualized grid to the target even when that item is not currently mounted in the DOM.
- **Tray**: Click tray now show the window always.

### Removed

- **Programmatic provider duplication:** Removed the old programmatic provider/router layer for migrated paths; the canonical implementation now lives in the DSL provider tree.

## [4.0.1]

### Added

- **ImageGrid — horizontal scroll direction:** New frontend-local setting `galleryLayoutDirection` (`"vertical" | "horizontal"`, default `"vertical"`) toggles the scroll axis in both Grid and Gallery modes; wide images get more screen area when scanning sideways. In horizontal mode the outer `.image-grid-container` becomes `flex-direction: column; overflow: hidden` and the scroll axis moves into a new inner `.image-grid-scroll` wrapper (`overflow-x: auto; overflow-y: hidden`), so the `before-grid` (filter toolbar) and `footer` (paginator) slots stay pinned. Grid mode horizontal uses `grid-template-rows: repeat(N, 1fr); grid-auto-flow: column; grid-auto-columns: auto` so each item's `aspect-ratio` drives its intrinsic width. Gallery mode horizontal flips the masonry into N flex rows stacked vertically, with `galleryBuckets` swapping its weighting from `1 / ratio` (vertical) to `ratio` (horizontal) so the narrowest row wins. `gridColumnsCount` (backed by existing `galleryGridColumns` + `uiStore.imageGridColumns`) is reused as "row count" in horizontal mode — Android stays fixed at 2; desktop adjusts via the existing settings / Ctrl+Wheel / quick drawer. Settings and QuickSettingsDrawer labels swap dynamically between `galleryColumns`/`quickColumns` and new `galleryRows`/`quickRows` i18n keys based on direction. `ImageItem` gains a `horizontal` prop: when true the item and its wrapper use `height: 100%; width: auto` and the aspect-ratio is also mirrored onto the `.image-item` root (via `rootStyle`) so Flex can compute the item's intrinsic width from its resolved height — `flex-shrink: 0` prevents the flex row in a `width: max-content` parent from compressing items down to 0. Scroll-dependent logic (`scrollEl` ref, scroll event listeners, `updateVirtualRange`, `measureItemHeight`, `scrollToIndex`, drag-scroll, page-change `scrollTo`, keep-alive `savedScrollPos` restore) now targets the inner `.image-grid-scroll` element and branches on `scrollLeft`/`left` vs `scrollTop`/`top`. Vertical wheel input is translated to horizontal scroll when direction is horizontal (`translateVerticalWheelToHorizontal` on `.image-grid-scroll`, with `deltaMode` line/page normalization and `Ctrl+Wheel` / `Meta+Wheel` passthrough preserved for column-count adjustment). Virtual scroll auto-disables when direction is horizontal (row-height assumption no longer holds), in addition to the existing disable when mode is gallery. New i18n keys `galleryLayoutDirection` / `galleryLayoutDirectionDesc` / `galleryLayoutDirectionVertical` / `galleryLayoutDirectionHorizontal` / `galleryRows` / `galleryRowsDesc` / `quickRows` / `quickRowsDesc` in en / zh / zhtw / ja / ko.
- **ImageGrid — vertical masonry "Gallery" layout:** New frontend-local setting `galleryLayoutMode` (`"grid" | "gallery"`, default `"grid"`) toggles between the existing CSS-Grid layout and a new N-column vertical masonry. In gallery mode, items are distributed into `uiStore.imageGridColumns` flex columns (fixed 2 on compact / Android, user-adjustable on desktop via the existing `galleryGridColumns` setting / Ctrl+Wheel / quick-settings) using a height-balanced algorithm (each image placed in the currently-shortest column, column height ∝ `1 / aspectRatio`), so columns finish at near-equal heights with no vertical gaps below shorter items. `ImageItem` gains an `fillBox` prop applied in gallery mode: wrapper `aspect-ratio` matches the image's natural ratio so `object-fit: cover` fills without letterbox, Android's `thumbnail-android` background is overridden to transparent (no card-color flash during load), and all rounded corners (`.image-item` `16px`, `.image-wrapper` / `.thumbnail` `14px`) are zeroed so tiles butt flush. Virtual scrolling auto-disables in gallery mode via a new `virtualScrollActive` computed — all virtual-scroll math (`updateVirtualRange`, `measureItemHeight`, `renderedItems`, `virtualPaddingTop/Bottom`, `scheduleVirtualUpdate`, `scheduleVirtualRangeUpdate`, `gridStyle` padding) is gated on it so masonry never emits row-based padding. The toggle is exposed in both `Settings → App Settings` (radio) and the `QuickSettingsDrawer` display group (available on all platforms including Android); new i18n keys `galleryLayoutMode` / `galleryLayoutModeDesc` / `galleryLayoutModeGrid` / `galleryLayoutModeGallery` added to en / zh / zhtw / ja / ko.
- **Gallery / AlbumDetail / TaskDetail — display-name search:** A search input sits at the right end of each page's filter toolbar (desktop only; hidden in compact / Android layouts). Backend reuses the existing `SearchDisplayNameProvider` + `GallerySearchShell` chain; paths are serialized as `search/display-name/<encodeURIComponent(q)>/…` as the outermost prefix so the rest of the gallery tree (`all` / `album/<id>` / `task/<id>` / `plugin/<id>` / `date/…`) flows through unchanged via `GalleryRootProvider` delegation. Desktop commits with a 300 ms debounce on input; web commits only on Enter / blur to avoid round-tripping over the network on every keystroke. Search is URL-only state (no localStorage persistence) and resets `page` to 1. New `SearchInput.vue` component, new `gallery.searchPlaceholder` i18n key in all five locales.
- **Provider path — `total` on Entry mode:** The no-suffix path syntax (`<path>` — `ProviderPathQuery::Entry`) now returns `{ name, meta, note, total }`. `total` is the `SELECT COUNT(*)` over that node's composed `ImageQuery`, so callers that only need "how many images match this path" no longer pay for `list_children` / `list_images`. Added `ProviderRuntime::count(path)` for direct Rust access and documented the contract on `Provider::get_meta` (providers don't build count SQL themselves — the runtime does).
- **Provider path — per-child `total` + dedicated list command:** `ChildEntry` gains a `total: Option<usize>` field; `ProviderRuntime::list_children_with_totals(path)` fills it by composing `child.apply_query(parent_composed)` and running COUNT for each child (respects any parent-chain filters such as hide / search / JOIN). `GalleryBrowseEntry::Dir` surfaces `total` when set (otherwise skipped from serialization). New `list_provider_children(path)` Tauri command + Web RPC method returns only Dir entries with `{ name, meta, total }` — no images mixed in, no `list_images` overhead. Gallery filter dropdowns ("by plugin" / "by media type" / "by date") now pull both the option list AND per-option counts from this single RPC, so the counts reflect the current hide + search context end-to-end. Date filter recursively walks `date/` → `date/<y>/` → `date/<y>/<m>/` and prunes zero-count branches before descending.
- **Provider path — centralized URL-decode:** `browse_gallery_provider` and `list_provider_children` call a new `decode_provider_path_segments` helper before dispatching — each `/`-delimited segment is UTF-8 percent-decoded so frontend can freely `encodeURIComponent` dynamic segments (search queries, future ids with special chars). `SearchDisplayNameProvider` / `ImageQuery::display_name_search` already parameterize with `?` and `escape_like`, so no provider-level sanitization changed.
- **Route stores — `contextPath` + `computePath`:** `pathRoute.ts` now exposes `computePath(overrides)` (what path would `navigate(overrides)` produce, without mutating state or routing) and a new `contextPath` computed driven by an optional `buildContext(state)` config hook. `contextPath` returns `[hide/]<context-prefix>` for the current state — callers that want to list children under a filter root (e.g., `plugin/`, `date/`) just do `${galleryRouteStore.contextPath}plugin/` and the hide + search segments are applied uniformly. New `utils/path.ts` with `asEntryPath` / `asListPath` / `asListWithMetaPath` centralizes the three provider-path syntax variants so no caller hand-writes `${p}/` or `${p.replace(/\/$/, '')}` anymore. Gallery store declares `buildContext: state => buildGalleryContextPrefix(state.search)`.

### Fixed

- **Drag-scroll silently no-op in horizontal layout:** `enableDragScroll` (`packages/core/src/utils/dragScroll.ts`) only wrote `container.scrollTop` during pointermove, so the "grab and pull" gesture did nothing in the new horizontal gallery layout. The handler now writes both `scrollLeft` and `scrollTop` from a single `(startScrollLeft - dx, startScrollTop - dy)` formula — unscrollable axes are naturally ignored by the browser so no axis detection is needed. Drag threshold switched to `Math.hypot(dx, dy)` so it triggers on any-direction motion; velocity is tracked per axis (`velocityX` / `velocityY`) and the overspeed hint dispatches on the velocity magnitude; release inertia decays on both axes with a shared `friction` tick. Pointer listeners moved to capture phase with `passive: false` on pointermove, matching the older `apps/main/src/utils/dragScroll.ts` convention — child components (ImageItem) can no longer swallow pointerdown before drag-scroll sees it.
- **Gallery filter dropdown counts ignored hide + search context:** "按插件 / 按媒体类型 / 按日期" option counts were fetched via the legacy aggregate SQL commands (`get_gallery_plugin_groups` / `get_gallery_media_type_counts` / `get_gallery_time_filter_data`), which ran over the whole `images` table regardless of active hide state or search query. When hide was on, the dropdown showed totals that included hidden images; when a search query was active, it showed totals that ignored the search. Counts now come from `list_provider_children` under `galleryRouteStore.contextPath`, so hide and search both flow through via the composed query. Plugin options with zero matches under the current context drop off the dropdown; date months/days with zero counts are pruned before descending.
- **Gallery total count path:** `loadTotalImagesCount` now issues the no-suffix Entry-mode request via `asEntryPath(galleryRouteStore.currentPath)` — a single COUNT against the composed query instead of a trailing-slash List query that also triggered `list_children` + `list_images`. COUNT SQL already ignores `LIMIT`/`OFFSET`, so the page segment in `currentPath` is harmless.
- **Android / add-to-album dialog:** The album picker popup (Vant `van-popup` inside `AndroidPickerSelect`) could be rendered below the surrounding `el-dialog` because Vant's default `z-index` (`2000`) matched Element Plus's initial popup counter. `AndroidPickerSelect` now pulls a fresh value from Element Plus's shared counter via `useZIndex().nextZIndex()` every time the picker opens and binds it to the popup, so the picker always stacks above any dialog/drawer that spawned it.
- **Setting Change Crush:** When set some settings application crush issue.(From the refactory of 4.0.0);

### Changed

- **ImageGrid — smooth wheel scrolling:** Wheel input on `.image-grid-scroll` is now lerped via `requestAnimationFrame` toward an accumulated target `(scrollLeft, scrollTop)` instead of being applied directly — discrete wheel ticks are flattened into continuous motion. Works in both vertical and horizontal layouts: horizontal mode maps `deltaY` onto `scrollLeft` while still honoring trackpad `deltaX`. Handles all three `deltaMode` variants (pixel / line / page), clamps the target to the scroll range, and resets the target from the live scroll position at the start of each new gesture so it never fights programmatic scrolls (`scrollTo({ behavior: 'smooth' })` on page change, `onActivated` keep-alive position restore). Early-exits on `Ctrl/Meta+Wheel` so the column-count shortcut still works, and on wheel events whose target is inside a dialog / drawer / Element Plus popper / PhotoSwipe / preview (or when `isPreviewOpen === true`) so the grid can't be pan-hijacked while a modal is active. Pointer-down on the scroll container cancels the in-flight wheel animation so drag-scroll / programmatic scroll takes over cleanly without frame-stealing. Replaces the old `translateVerticalWheelToHorizontal` listener (which only remapped wheel in horizontal mode and otherwise left scroll to the browser default).
- **TaskDetail — global hide toggle:** TaskDetail now participates in the shared "hide hidden images" routing (same `hide/` URL prefix used by Gallery / AlbumDetail). `taskDetailRoute` no longer sets `ignoreHide: () => true`, and `TaskDetailPageHeader` exposes `HeaderFeatureId.ToggleShowHidden` in its fold (desktop + Android) with the label following `taskRouteStore.hide` (`header.showHidden` / `header.hideHidden`). `TaskDetail.initTask` tolerates the optional `hide/` prefix when validating the `?path=` query.
- **ImageItem — hidden image indicator:** When `image.isHidden` is true, the image item applies a new `image-item-hidden` modifier. Instead of fading the image element itself, a semi-transparent pseudo-element overlay (`rgba(20, 20, 24, 0.55)`, `z-index: 9` inside an `isolation: isolate` wrapper) is drawn above every image-layer variant — desktop two-layer original (`z-index: 2`), Android/Linux video GIF, `<video>` element, and the single-image fallback — so the overlay works uniformly regardless of which rendering branch is active. The `isolation: isolate` on the wrapper keeps the mask contained, so the `video-play-badge` / `missing-file-badge` siblings remain visible above it.
- **TaskDetail — reactive hide/unhide:** TaskDetail now subscribes to `album-images-change` for the HIDDEN album (via `useAlbumImagesChangeRefresh`, 500ms trailing throttle) and reloads the current page. Previously only `images-change` was listened to, so hiding/unhiding an image didn't refresh `image.isHidden` until a manual refresh — the new opacity indicator now updates reactively, matching Gallery/AlbumDetail/SurfImages behavior.
- **TaskDetail — global hide sync on re-activation:** `onActivated` now reloads the current page when returning to a task that was kept alive. The existing `currentPath` watcher early-returns while TaskDetail is not the active route, so a `hide` toggle performed on Gallery/AlbumDetail wouldn't take effect until the next navigation inside TaskDetail. Reloading on activation ensures the hidden-image filter is always in sync with the shared global state.
- **ImageGrid — tighter spacing:** Grid gap is reduced to ~1/3 of the previous value (desktop: `max(2, round((16 − (n−1)) / 3))`; compact: `max(1, round((6 − (n−1)) / 3))`, where `n` is `imageGridColumns`). All dependent calculations (virtual-scroll row height, column-width inference, Android-column grid) pick it up automatically.
- **ImageGrid — desktop column cap raised from 4 to 6:** `clampDesktopColumns` in `useUiStore` now clamps to `[1, 6]`, `adjustImageGridColumn` (Ctrl+wheel / Ctrl±) lets the column count climb to 6, and the "fixed columns" `el-input-number` in `GalleryGridColumnsSetting.vue` exposes the same range. Default stays at 4; the gap formula already scales against `n`, so 5- and 6-column layouts naturally tighten without extra tuning.
- **Delete / Hide — semantics split:** `RemoveImagesConfirmDialog` in Gallery / TaskDetail / SurfImages no longer offers the "also delete source files" checkbox; delete now unconditionally removes the DB row **and** the local file via `batch_delete_images`, with a revised confirmation message pointing users at "Hide" when they want to keep the file. `useImageOperations.handleBatchDeleteImages` drops its `deleteFiles` parameter (always true) and gains a companion `handleBatchHideImages` that adds the selection to `HIDDEN_ALBUM_ID` via `albumStore.addImagesToAlbum`. Swipe-up gesture in Gallery / TaskDetail now routes to the hide path instead of the old `batch_remove_images` soft-remove, so the gesture no longer creates a third "remove from list but keep file" semantic that conflicted with the new delete contract. AlbumDetail is intentionally left unchanged — its dialog keeps the checkbox because "remove from album" vs "permanent delete" are genuinely distinct album-scoped actions. i18n: `gallery.removeFromGalleryMessage{Single,Multi}`, `tasks.removeDialogMessage{Single,Multi}`, `surf.removeMessage{Single,Multi}` reworded across en / zh / zhtw / ja / ko to emphasize permanent deletion and suggest Hide as the file-preserving alternative; unused keys `gallery.deleteSourceFilesCheckboxLabel` / `DangerText` / `SafeText` removed.

## [4.0.0]

### Breaking Changes

- **MCP URI schemes (hard switch)** — The single `kabegame://` scheme has been split into six dedicated schemes: `provider://`, `album://`, `task://`, `surf://`, `image://`, `plugin://`. There is **no backward-compatible alias**; any cached `kabegame://…` URI in MCP clients must be updated.
  - `provider://<path>` supports `?without=children` or `?without=images` (at most one) on List / ListWithMeta modes to trim Dir / Image entries for narrower context windows.
  - `album://` / `task://` / `surf://` without id now return the **full list** of entities; `{scheme}://{id}` returns a single entity.
  - `plugin://` and `plugin://{id}` return **trimmed** Plugin JSON — `docResources`, `iconPngBase64`, and `descriptionTemplate` are stripped. Fetch them on demand via `plugin://{id}/icon`, `plugin://{id}/description_template`, `plugin://{id}/doc`, and `plugin://{id}/doc_resource/{key}`.
  - MCP `instructions` rewritten to document the new schemes, `ProviderMeta` shapes, `ImageInfo` fields (note: serde key is `type`, not `mediaType`), and the "do not batch-fetch plugin meta" warning.
- **Database migration overhaul** — The legacy inline migration code (hundreds of lines of `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` / `perform_complex_migrations` etc.) has been removed. The database schema is now defined in a single authoritative `migrations/init.rs`.
  - **Upgrade path**: Only users on **v3.5.x** (database `user_version = 7`) are supported for a seamless upgrade. Users on older versions will see an error on launch and must either upgrade to v3.5.x first, or delete their user data directory and re-import local images.
  - **Linux (deb)**: Running `apt purge kabegame` now also removes user data directories (`~/.local/share/com.kabegame`, `~/.config/com.kabegame`, `~/.cache/com.kabegame`). Use `apt remove` to uninstall without deleting data.
- Future database migrations should be added as versioned files under `src-tauri/core/src/storage/migrations/` following the pattern described in `migrations/mod.rs`.

### Added

- **Android:** - request for battery use when start crawl task or start wallpaper rotation.
- **MCP:** Now you can orginaze your images with outer AI. create albums、add images to an album、summerize your albums、write auto configs、even write a plugin for you.

### Optimized

- **Provider architecture (full refactor):**
  - New `Provider` trait with **internalized merge strategy**: each provider implements `apply_query(current: ImageQuery) -> ImageQuery` and owns its own join / where / order contribution; the runtime only threads the composed query down the chain without inspecting it.
  - `list_children(&self, composed) -> Vec<ChildEntry>` returns only structural children; image enumeration is a separate `list_images(&self, composed)` call so the runtime never conflates the two.
  - `ResolvedNode { provider, composed }` replaces ad-hoc pair passing; LRU caching on resolved nodes in `ProviderRuntime` makes repeated navigation / listing cheap.
  - **`SortProvider`** cleanly flips `ASC ↔ DESC` at `desc` boundaries via `current.to_desc()`, instead of being open-coded in each parent.
  - New **`shared/`** providers consolidate previously duplicated logic: `plugin`, `task`, `surf`, `media_type`, `album`, and the date chain (`years` / `year` / `month` / `day`) with `prepend_order_by` so time sorts are placed before the stable `id ASC` tiebreaker.
  - **Terminal pagination** is now the single `QueryPageProvider` (offset/limit lives only here); `page = None` = root (last page + lists `1..=N` child pages), `page = Some(n)` = leaf.
  - VD routing shells (root / all / by_plugin / by_task / by_surf / by_type / by_time / albums / sub_album_gate) and Gallery routing shells (8 files) are rewritten against the new trait; `GalleryDateScopedLeafProvider` is gone.
  - Consumer layer (`virtual_driver::semantics`, gallery `query`/`browse`, commands) migrated to the new trait; `browse_from_provider` performs **zero** secondary DB lookups — storage assembles `ImageInfo` in a single SQL with favorite/thumbnail/size joined.

### Removed

- **VD:** some useless folder. Just keep simple
- **Legacy `Provider` trait** (pre-refactor) and all compatibility shims; the legacy `QueryPageProviderV2` was promoted to the canonical `QueryPageProvider`.
- **`Storage::get_image_entries_by_query`** — superseded by `get_images_info_range_by_query`, which returns fully-populated `ImageInfo` so callers no longer need per-row follow-up queries.

## [3.5.0]

### Added

- **Surf:** **`resources/surf_bootstrap.js`** — injected first (before toast / context menu / navbar); centralizes **`window.open`** and **`target="_blank"`** link handling for external sites; exposes **`window.__kabegame_surf_triggerDownload`** for the context menu.
- **Rhai API:** **`current_headers()`** — returns a map of the last successful HTTP response headers for the current page-stack entry (lowercase keys; duplicate header names joined with `, `), aligned with **`current_html()`**
- **Rhai API:** **`md5(text)`** — UTF-8 MD5 as lowercase hex (e.g. Bilibili WBI `w_rid`). **`PageStackEntry`** now stores **`headers`** from **`to()`** GET responses. See **`docs/RHAI_API.md`** and **`docs/CRAWLER_BACKENDS.md`**.
- **Run configs / Tauri:** Commands **`run_missed_configs`** and **`dismiss_missed_configs`** (missed-runs dialog: execute now vs skip and reschedule via the scheduler).
- **Database / images:** Migration **v004** — `images.size` (**INTEGER**, bytes on disk); new DBs get the column from schema init. **`ImageInfo.size`** (optional); **`add_image`** fills **`size`** from the filesystem when absent (Android **`content://`** omitted at insert, filled by startup backfill).
- **Startup:** **`fill_missing_sizes`** (async) backfills rows with **`size IS NULL`**: desktop uses **`fs::metadata`**; Android **`content://`** uses **`ContentIoProvider::get_content_size`**, implemented by Picker **`getContentSize`** (Kotlin: **`OpenableColumns.SIZE`**, then **`AssetFileDescriptor`** length).
- **Gallery / image detail:** Human-readable **file size** when **`size`** is set; i18n **`gallery.imageDetailSize`** (en, zh, zhtw, ja, ko).
- **Tasks / IPC:** Unified **`tasks-change`** Tauri event replacing separate `task-status`, `task-progress`, `task-error`, and `task-image-counts` streams; payload discriminant `type`: `TaskAdded` (full task JSON), `TaskDeleted` (`taskId`), `TaskChanged` (`taskId` + `diff` with camelCase fields such as `status`, `progress`, `startTime`, `endTime`, `error`, counts).
- **Database:** Migration **v005** — `images.task_id` references `tasks(id)` **ON DELETE SET NULL** (table rebuild); new databases get the FK in the initial `images` DDL.
- **Task commands:** `add_task` / `start_task` (stub insert) emit `TaskAdded`; `delete_task` emits `TaskDeleted` plus `images-change` for rows whose `task_id` was cleared; `clear_finished_tasks` emits one `TaskDeleted` per removed task and a batched `images-change` when needed.
- **Gallery / image detail:** When an image has `taskId`, a **small list icon** on the **same row as Source** opens the task detail route (`open-task` bubbled through `ImageDetailContent` → dialogs / `ImageGrid`); `title` / `aria-label` use `gallery.imageDetailOpenTask` (five locales).
- **Organize gallery:** Option **Remove unrecognized media** — removes DB rows whose file still exists on disk but fails `is_media_by_path`.
- **Organize gallery:** When total image count is greater than 4000, the dialog shows a range slider (step 1000, minimum span 1000) to limit processing to an `id` ASC slice in this run; added `get_organize_total_count` for the UI to fetch the total.
- **Organize (header) — progress panel & run sync:** While organizing, the gallery header shows a **spinning folder** icon; **tooltip** shows progress text; **click** opens a **popover** (manual trigger) with **`el-progress`**, this run’s **options** and **range**, a note that **new downloads are not included** during the run, **Cancel** (requests cancel) / **Confirm** to close, and **`useModalBack`** on Android. **Range slices** use i18n **`organizingProgressRange`** (`current/end`) and matching **percentage**; a **full-library** run uses **`organizingProgress`** (`processed/total`). **`organize-progress`** events carry **`processedGlobal`**, **`libraryTotal`**, optional **`rangeStart`** / **`rangeEnd`** (exclusive end, aligned with the dialog); progress is emitted **once per batch** after **scan + deletes + that batch’s thumbnail regeneration** so the bar does not read 100% while thumbnails are still generating. **`get_organize_run_state`** returns a snapshot (`running`, counters, option flags, range bounds) so the UI can **restore the in-progress state after a WebView reload**; the backend keeps it in sync with each progress emission.
- **BiliBili Plugin** new plugin for bilibili columns.
- **Wallpaper rotation / nested albums:** Setting **`wallpaperRotationIncludeSubalbums`** (default **true**) — when rotating from a **specific album**, optionally include **descendant albums**; images merged in **BFS album order** with **deduplication by image ID**. Applies to **`WallpaperRotator`**, **`get_album_images_for_wallpaper_rotation`** (album pick validation), **Wallpaper Engine album export**, and Android **`WallpaperRotationWorker`**; Tauri + **IPC/CLI** getters/setters; settings UI when a concrete album is selected; i18n (en, zh, zhtw, ja, ko). See **`docs/nested-albums/07-wallpaper-and-consumers.md`**.

### Fixed

- **Gallery / image removal (desktop):** Deleting images from the gallery (with or without deleting source files) now also removes the associated `thumbnail_path` file; Android remains unchanged and does not delete thumbnails during these operations.
- **Virtual drive (`vd/{locale}/…`):** Restored pre-refactor folder naming: **album** directories use **album display names** (not raw IDs); **plugin** / **task** use **`{manifest display name} - {id}`** when the manifest name exists; **`tree`** maps to **`vd.subAlbums`** (e.g. 子画册); under that folder, **child albums are listed by name** with **`get_child`** resolving by name; **desc** (倒序) respects **locale** in date scopes and album sub-branches; **wallpaper order** root again lists **ascending** images via `CommonProvider` (not only the descending child). **Album** sub-branches (**仅图片/仅视频**, **按画册顺序**, **按壁纸顺序**, nested **倒序**) no longer force **SimplePage** on the desc child: VD uses **Greedy** so images and range folders list correctly; **`read_dir`** skips DB entries whose files are missing on disk instead of failing **`ls`**.
- **Gallery / `query.path`:** Paginating with a time filter (e.g. `date/2026/1`) no longer strips the year as if it were a page number; paths are built consistently via `parseGalleryPath` / `buildGalleryPath` and Pinia route state.
- **HTTP file server (original files):** `handle_file_query` sets `Content-Type` from the database `images.type` field (`ImageInfo.media_type`) when present, otherwise falls back to path-based inference; thumbnail requests still infer MIME from the thumbnail path (may differ from the original format).
- **Scheduler / missed runs:** On startup, configs whose `planned_at` is far in the past are no longer treated as due and auto-run; they stay for the missed-runs dialog. The loop only fires configs in a ±5s due window, treats far-future `planned_at` for sleep, ignores stale past times, and fills `planned_at` from `compute_next_planned_at` when it is unset.
- **Plugins:** `resolve_plugin_for_task_request` (installed `plugin_id` path) calls `ensure_installed_cache_initialized()` before the cache lookup so scheduled tasks do not fail with “plugin not found” if the scheduler runs before the UI calls `get_plugins`.
- **RunConfig / `schedule_spec` (interval):** JSON uses the **`intervalSecs`** field name consistently with serde (`ScheduleSpec::Interval`); switching schedule mode to interval no longer fails deserialization.
- **Gallery / album detail:** `useImagesChangeRefresh` no longer skips `images-change` with **`reason: add`** when the current page is full (`length >= pageSize`). That optimization broke **time-desc** views: new images should appear at the top and displace the oldest item on the first page; the last page still looked correct because it was often shorter than `pageSize`. **Fixed** in **`Gallery.vue`** and **`AlbumDetail.vue`**.
- **Surf (desktop WebView):** New-window requests (`window.open` / `<a target="_blank">`) are handled in the **same** surf window via **`on_new_window`** (navigate + deny) instead of relying on a second window or problematic page-level Tauri IPC on HTTPS origins.
- **Surf session cookies:** **`surf_get_cookies`** and **`save_surf_session_cookies`** merge **`cookies_for_url(root)`** with the full jar from **`cookies()`**, keeping entries whose cookie **domain** matches the surf record **host** (RFC6265-style domain matching), so login cookies align with what DevTools shows rather than a narrow `cookies_for_url` slice alone.
- **Tasks / local import completion:** Fixed a frontend `tasks-change` merge guard that incorrectly dropped non-progress diffs when `progress` was unchanged (notably at `100%`), which could leave local-import tasks (single folder/archive/image) stuck visually at 100% without transitioning to `completed`.

### Changed

- **Image format detection:** Replaced the hand-rolled `@kabegame/image-type` runtime probe with a custom **Modernizr** build (webp + avif only) bundled at `packages/core/src/vendor/modernizr.js` via `scripts/build-modernizr.mjs`. Results now live in a shared Pinia store **`useImageSupportStore`** (`@kabegame/core/stores/imageSupport`): `detect()` runs once after `app.mount`, reports formats to the backend via `set_supported_image_formats`, exposes reactive `webp` / `avif` / `formats` / `ready`, and provides `ensure()` / `redetect()`. Keeps a single delayed retry when the first pass returns all-false (early WebView decoder race). **HEIC detection dropped** — Web platforms lack a reliable detect path and only very recent Safari supports it.
- **Surf (host as public key):** Surf records are addressed by **`host`** (trimmed, lowercased) instead of UUID everywhere user-facing: Tauri commands **`surf_get_record`**, **`surf_get_record_images`**, **`surf_update_root_url`**, **`surf_update_name`**, **`surf_delete_record`** take **`host`** (internal DB **`id`** unchanged). **`surf_get_session_status`** and **`surf-session-changed`** expose **`surfHost`** instead of **`surfRecordId`**; the surf Pinia store drops **`activeRecordId`** and uses **`activeHost`** only. **Frontend** route **`/surf/:host/images`**; gallery **`query.path`** / virtual drive **`surf/<host>/…`**; **`MainSurfGroupProvider`** lists child folders by **host**. **`surf-records-change`** events still use internal **`surfRecordId`** for add/change/delete. Old bookmarks or stored paths using **`surf/<uuid>/…`** are invalid.
- **Surf provider parity:** **`MainSurfRecordProvider`** now delegates to **`CommonProvider`** (same pattern as **All**), so both default ascending and `desc` branches resolve/list consistently with page children; this fixes cases where `surf/<host>/1` could fail with “path not found”.
- **Surf session reopen:** Reopening an existing surf session now only brings the surf window to front and focuses it; it no longer calls `navigate(...)` and no longer refreshes the current page content.
- **Surf:** WebView **`initialization_script`** order is **`surf_bootstrap`** → **`surf_toast`** → **`surf_context_menu`** → **`surf_navbar`**; **`surf_context_menu.js`** only handles the custom context menu (download uses **`__kabegame_surf_triggerDownload`** when available).
- **Gallery / routing:** Introduced `createPathRouteStore` and stores `galleryRoute`, `albumDetailRoute`, `taskDetailRoute`, `surfImagesRoute` for `query.path` parsing, navigation, and (gallery) localStorage persistence; removed `useProviderPathRoute` and `useGalleryPathState`.
- **UI:** `GalleryToolbar` takes `root` / `sort` and syncs with `update:root` / `update:sort`; `GalleryFilterControl`, `GallerySortControl`, and `AlbumDetailBrowseToolbar` align with those stores.
- **Organize / IPC:** `start_organize` and the CLI daemon `OrganizeStart` add `remove_unrecognized`, `range_start`, and `range_end`; IPC uses serde defaults for backward compatibility with older clients.
- **Tasks / frontend:** Crawler Pinia store listens only to **`tasks-change`**; `delete_task` relies on `TaskDeleted` to update the list; `TaskChanged` merges diffs (with progress throttling for progress-only updates) and dispatches `task-error-display` on non-canceled **failed** status.
- **Tasks / backend:** Crawler scheduler and WebView crawl exit/error paths emit **`TaskChanged`** diffs; `emit_task_progress` and `emit_task_image_counts` are implemented via **`TaskChanged`**; `emit_task_status_from_storage` unchanged in name but emits **`TaskChanged`**.
- **Virtual drive (Windows):** Event listener subscribes to **`TasksChange`**; **`TaskAdded`** / **`TaskDeleted`** trigger `bump_tasks()`; **`emit_task_deleted`** replaces the old Generic **`tasks-changed`** payload from the FUSE/Windows virtual driver hooks.
- **Plasma wallpaper plugin:** Subscribes to **`tasks-change`** (replaces **`task-status`**) to refresh tasks and gallery.
- **Task detail page:** Replaces **`task-progress`** / **`task-status`** listeners with **`tasks-change`** (payload `type` **`TaskChanged`**) to stop the run-time clock on terminal status.
- **Scheduler / missed runs:** `recalc_all_planned_at` is read-only (counts missed runs for the dialog only; it no longer advances `planned_at` in the database). **`resolve_missed_runs`** is replaced by **`run_missed_configs`** (sets `planned_at` to now; scheduler runs tasks) and **`dismiss_missed_configs`** (clears `planned_at`; scheduler recomputes the next time). **`get_missed_runs`** no longer calls **`reload_config`** after reading.
- **Frontend (auto run):** Missed-runs **Run now** / **Dismiss** use the new commands; schedule editor and recommended-preset import send **`schedulePlannedAt: undefined`** so the backend scheduler owns the next **`planned_at`** after **`reload_config`**.
- **RunConfig / `ScheduleSpec` (Rust):** Enum container uses **`tag = "mode"`** only (dropped misleading **`rename_all`** on the enum); interval variant field is explicitly **`intervalSecs`** in JSON via serde **`rename`**.

### Removed

- **Tauri / run configs:** Command **`resolve_missed_runs`** (superseded by **`run_missed_configs`** and **`dismiss_missed_configs`**).
- **IPC / events:** **`DaemonEventKind`** and **`DaemonEvent`** entries **`TaskStatus`**, **`TaskProgress`**, **`TaskError`**, **`TaskImageCounts`**; Tauri event names **`task-status`**, **`task-progress`**, **`task-error`**, **`task-image-counts`**. Downstream clients must use **`tasks-change`** only.
- **`GlobalEmitter`:** **`emit_task_status`** and **`emit_task_error`** (superseded by **`emit_task_changed`** and related helpers).
- **i18n:** **`gallery.imageDetailTaskLabel`** (source row uses **`imageDetailOpenTask`** for tooltip and accessibility only).

## [3.4.4]

### Added

- **Plugin:** 米游社 Plugin. Also support for boolean when condition.
- **Rhai API:** when resolve for bool type.

## [3.4.3]

### Added

- **Plugin:** heybox plugin. can crawl by searching keyword and single post url.
- **Rhai API:** create_image_metadata function.

### Fixed

- **Windows SURF:** Freeze on windows when downlaod a image.
- some i18n issue

## [3.4.2]

### Added

- **Rhai crawler:** `warn(message)` writes a warn-level line to the task log (same channel as HTTP retry notices).
- **Plugin config:** Per-option `when` on `options` / `checkbox` entries (same semantics as field-level `when`); crawler/default-config/auto-config forms reset invalid option values when filters change.

### Changed

- **Pixiv plugin:** Ranking crawl uses separate mode/content/age fields, single `ranking_date`, JSON `next` pagination, Rhai `warn()` for shortfall, and R18 requires account UID + Cookie.
- **Pixiv plugin:** Ranking `content_mode` shows whenever `source` is ranking; each `ranking_mode` option uses `when` on `content_mode` (illust/manga vs ugoira vs all-only modes).
- **Pixiv plugin:** Multi-page illusts use download names `title(1)`, `title(2)`, …; single-page keeps plain `title` (fallback: illust id when detail missing).
- **IPC / gallery:** `images-change` (`DaemonEvent::ImagesChange`) now includes optional `albumIds`, `taskIds`, and `surfRecordIds` so album/task/surf views and the Plasma wallpaper plugin can refresh selectively.

### Fixed

- **Album/Task:** Not update image list when delete image source.

### Optimized

- **Pixiv plugin:** Store only EJS-needed fields in `images.metadata` (`crawl.rhai` + one-time DB trim for existing rows) to speed gallery/album lists when metadata was huge.
- Remove some unnecessary call of refresh cache.
- Self update for shop source list when expires 24h.
- reuse connection pool, download be more fast!
- not query metadata for common query.

### Removed

- remove android scheduled config cause it is hard to implement.

## [3.4.1]

### Added

- **RunConfig:** Title bar actions for "Start collection" and "Quick settings"; quick drawer: importing a recommended preset enables schedule by default and common download-related settings.
- **Image:** downloaded image now can display a custom name and html description for detailed and comprehensive information. Even js are enabled for fetch comments of an image, just like on the website.

### Fixed

- **Dedup**: silent dedup for hash dedup bug.

## [3.4.0]

### Added

- **RunConfig**: Auto run schedule feature. Plugin recommand config for on click import.
- **RunConfig / schedule:** `weekly` mode: choose weekday and time of day (`schedule_spec`: `{ "mode": "weekly", "weekday", "hour", "minute" }`, `weekday` 0 = Monday … 6 = Sunday).
- **Plugins:** Settings → Plugin defaults: per-plugin crawl defaults (vars, HTTP headers, output dir) in `plugins-directory/default-configs/<pluginId>.json`, preferred when picking a source in crawl/auto-config UIs with per-field fallback, auto-created on import or first open.
- **Task:** Crawl task progress bars when `progress > 0` (task drawer, task panel, inline summary rows): default styling while running, explicit red for failed and neutral gray for canceled; progress is kept on failure/cancel so the bar reflects how far a run got.

### Optimized

- **Plugins:** Installed plugin icons and multilingual `doc.md` docs are fetched in parallel with recommended presets after `loadPlugins` and cached in `usePluginStore` (`get_plugin_icon` / `get_plugin_doc_by_id`); pages and drawers no longer request icons redundantly.
- **TaskDrawer**: optimize the performance of switching visiablity.
- **Crawler store:** Load tasks and run configs once inside `defineStore`, expose `runConfigsReady` / `tasksReady`, drop redundant view-level loads, and patch run configs locally after writes instead of full-table reloads.
- **Plugin store:** `loadPlugins` applies `get_plugins` results in a `.then` handler with an empty default list; narrowed call sites to the plugin browser (manual refresh / store install) plus post-install paths, removing gallery and related prefetch.

## [3.3.1]

### Added

- **Plugins / collect form:** `config.json` 变量类型 **`date`**：桌面与安卓收集对话框使用 Element Plus 日期选择器，值为 `YYYY-MM-DD` 字符串；应用语言与 Element Plus 组件语言通过根级 `el-config-provider` 对齐。见 `docs/README_PLUGIN_DEV.md`、`docs/RHAI_API.md`。
- **Crawler Rhai:** `re_replace_all(pattern, replacement, text)` — global regex replace using Rust `regex` (invalid pattern returns the original string); see `docs/RHAI_API.md` and `docs/CRAWLER_BACKENDS.md`.

### Fixed

- **Crawler Rhai:** Reqwest enables **gzip** decompression for plugin HTTP fetches so `to()` / `fetch_json()` store decoded HTML/CSS bodies instead of raw compressed bytes (fixes empty `query` / `get_attr` on gzip-only responses).

### Changed

- **Plugins:** Crawler plugins that rely on gzip-correct `to()` parsing or `re_replace_all` (e.g. wallpapers-craft) require **Kabegame 3.3.1+**.
- **Plugins:** Min version restriction for plugin.

## [3.3.0]

### Added

- **Failed images page:** Bulk retry, cancel waiting retries, and delete all for the current plugin filter; header actions refresh and task drawer; per-item download phase labels and cancel while queued; retries run asynchronously with optional abort on capacity wait.
- **Task:** Dedup count per task: when an image is skipped as duplicate (URL or hash match), the task’s dedup count increments and a dedicated event updates the UI in real time; shown in the task detail subtitle and in the task drawer (count badge and expanded params).
- **Task:** Task drawer shows success, failed, and deleted counts under each task name (with icons); counts are loaded alongside the task list without extra requests.
- **Task:** Retry download for failed images: on the task detail page, when viewing the failed list, each failed item has a retry button to re-attempt the download; supports deleting failed records and copying error details (plugin, time, URL, error message).
- **Surf:** Record detail dialog: click a record card to open it; edit name, entry path (with full-URL preview), view/copy saved cookie, or delete the record; structure aligned with image detail dialog.
- **Surf:** Right-click context menu on records: view downloaded images, open detail dialog, or delete record.
- **Surf:** Cookie saved to database automatically when each page finishes loading in the surf window; available in the detail dialog without an active session.
- **Gallery / Album / Task / Surf:** Configurable **images per page** (100, 500, or 1000), saved in app settings; change it from the gallery toolbar, album browse bar (desktop) or header overflow (Android), task/surf tool row above the paginator, or **Settings → App**; switching value reloads the current list from page 1.
- **Gallery:** More filter options (e.g. by time range, by source plugin, and wallpaper history), with plugin labels shown in your language where applicable.
- **Gallery / virtual disk:** Sort and browse images by **last time they were set as wallpaper** (ascending or descending); virtual disk includes a matching root folder and reverse-order subfolder where applicable.
- **Gallery:** Lists using this sort refresh when the current wallpaper changes (including rotation), so order stays consistent without manual reload.

### Fixed

- **Windows:** Image downloads, plugin store, favicon fetching, and proxy requests now respect system proxy when set in Windows (Settings → Network → Proxy); reads registry when HTTP_PROXY/HTTPS_PROXY env vars are unset.
- **Task:** Migration cleans up orphaned failed images (those whose task no longer exists); deleting a task or clearing finished tasks now removes all related failed images.
- **Android image preview:** Pinch-to-zoom no longer accidentally toggles UI controls (close button, counter bar) visibility.
- **Gallery (Android):** In multi-select mode, fast taps that the browser treats as a double-click no longer open the image preview; selection toggling stays the only action.
- **Android image preview:** Swipe-up delete stays reliable after horizontal swipes; deleting the last image on a page keeps the full-screen carousel on the correct slide (no off-by-one preview or erroneous wrap to the first image).
- **ImageItem (video):** Stopped showing the Element Plus image-variant loading skeleton on top of video (`isVideo` excluded via `v-if`), which had appeared as a small centered picture placeholder while the video played underneath (e.g. gallery grid, album cards).
- Gallery: your last browse location (root, sort, page) persists across restarts, the sort menu matches what you see, and changing sort no longer resets the page.
- migrate crash for some version of kabegame
- Plugin browser store installs now reuse downloaded packages from cache instead of always re-downloading.
- **Plugin detail page (i18n):** Labels for plugin ID, name, version, description, crawl URL, empty-description text, copy, and link-open errors follow your selected app language instead of hard-coded Chinese.- **Plugin browser (official source name i18n):** The built-in official GitHub Releases source name is written to the database on startup and when the app language changes (same pattern as the favorite album name sync via `kabegame_i18n`). Storage emits `plugin-sources-changed` so the plugin browser reloads the source list.

### Changed

- **Surf:** Clicking a record card opens the detail dialog instead of starting a session; a dedicated “Start surfing” button on each card starts the session (disabled while a session is active).
- **Surf:** “View recent images” replaced with a “View downloaded images” button on record cards.
- **Surf:** Removed top-bar “View Cookie” and “End session” buttons; cookies are accessed in the record detail dialog; session is ended by closing the surf window.
- **Gallery (desktop):** Filter and sort moved from the page header to the row below the title (above the big paginator), matching album detail; on Android they stay in the header overflow menu with bottom pickers.
- Builtin plugin removed, must download from remote.
- Github release remote source cannot be deleted.

### Optimized

- Task drawer and “copy error” details now only list plugin run options that apply to the current configuration (same `when` rules as the run form), not hidden/irrelevant fields.
- HTTP downloads (crawler images and plugin store `.kgpg`) now resume in memory when the stream fails: retry requests use `Range` from bytes already received; if the server ignores Range (non-206), the client falls back to a full re-download to avoid corrupt concatenation.
- Crawler Rhai: `to()` and `fetch_json()` emit task-log `info` lines (request start, success with resolved URL / stack depth / JSON type) for easier script debugging.
- **Plugin browser (store):** `.kgpg` download streams into memory then writes once (no partial cache files); `get_store_plugins` merges active download progress; progress callbacks are throttled to 1s; up to two retries after a failed attempt. `preview_store_install` emits `plugin-store-download-progress` for the UI.
- **Plugin browser (store):** install button shows download progress as a left-to-right fill with percentage; when the installed version equals the store version, the control is a disabled “Installed” state (no reinstall), and plugin detail opens from the local install (no remote query) so docs load offline.
- **Plugin detail page:** When you install from the store on the source detail / doc page, the install button shows the same live download progress (fill + percentage) as on the plugin store grid. The summary at the top now includes a **Version** row so you can see the package version at a glance.
- **Plugin browser （Android）** Store and installed lists use a two-column square card layout
- **Plugin doc:** Images in plugin Markdown docs open in a full-screen preview on tap or click: Android uses PhotoSwipe (no looping); desktop uses the Element Plus image viewer (no infinite wrap). Natural size is resolved after load so PhotoSwipe gets correct dimensions.

## [3.2.2]

### Added

- linux plasma plugin for plasma video wallpaper

### Fixed

- linux install fail because of ffmpeg name conflict
- some plugin name i18n object bug
- local import fail bug
- linux video wallpaper cause kabegame crash bug
- **Thumbnail MIME for video:** Server was sending `Content-Type: video/mp4` when serving video thumbnails (GIF/JPG), so the browser could not render them in `<img>`. Thumbnail endpoint now infers MIME from the thumbnail file path. On Linux, video thumbnail load failure no longer falls back to the original MP4 URL in the image loader.
- Linux wayland use X11 GDK_BACKEND
- Random wallpaper rotation could get stuck alternating between only two images (e.g. after task export); fixed by replacing time-based modulo with splitmix64 mixing so index selection is uniform on Windows (100ns clock resolution).

## [3.2.1]

### Added

- i18n, including README document and application frontend.

### Fixed

- 任务日志弹窗：新日志到达时不再自动滚到底部，保持用户当前滚动位置。

### Optimized

- restore last path at gallery when bootstrap.
- restore last tab of setting page when bootstrap.
- kgpg document image load

## [3.2.0]

（这是一次更大的改动，带仍不增加大版本号）

### Added

- 添加畅游页面，用户可以通过内置浏览器直接下载任何网址图片到kabegame
- 支持视频壁纸（mp4、mov）
- MacOS窗口模式，支持更丰富的壁纸填充模式、过渡效果
- 添加画廊固定列数设置，比如你可以设置固定为2列
- 新增两个爬虫插件（包括对p站的支持）
- 添加下载等待间隔设置
- 添加图片溢出对齐设置

### Fixed

- 随着下载进行，所选项目被重置的问题
- 从其他页面回到画廊，顺序被重置为正序的问题
- 图片没有刷盘导致偶尔不能正常下载问题
- 与爬取配置相关的各种前期没有考虑的奇怪bug
- 手机预览图片上划手势的部分奇怪错误
- 手机安全区检测不准确导致导航键挡住tab
- 手机点击插件文档无法打开系统浏览器查看的bug

### Optimized

- 提高爬虫网络重试的健壮性

## [3.1.0]

（这是一次大改动，因此将版本升级）

### Added

- 添加webview插件，可以编写js插件啦！第一个例子是 anime-pictures 插件
- 添加任务日志查看功能

### Fixed

- 修复画册细节页面右键移除画册没有反应的bug
- 将后端F11监听改到前端，避免占用其他浏览器快捷键
- 本地导入例程百分比计算问题
- 任务取消仍然显示在运行的问题
- 修复启动时窗口闪烁以及静默启动时窗口闪烁问题
- 画廊页面刷新之后回到第一页的问题

### Optimized

- 插件详情页面用marked来渲染markdown，支持更全面
- 已安装的插件显示版本

## [3.0.5]

### Added

- 一键加入所有任务图片到画册功能
- 官方商店源可以删除

### Fixed

- 修复多次启动应用singleton检测bug
- 修复F11响应，应用处于焦点时才全屏
- 修复路径上带空格的图片无法正常打开所在文件夹
- 若干右键上下文菜单被预览框遮住的bug
- 增加本地图片文件的安全性，并为后来本地同步图片服务做准备
- 修复图片列表变化时预览图没有及时合理地更新的bug（删除、增加等）

### Changed

- 模式精简：将 Normal/Local/Light 三种模式改为 Standard/Light 两种模式
- 去掉「内置插件」概念：所有插件一视同仁，支持卸载和覆盖安装
- 两种模式都支持插件商店，Standard 模式额外支持虚拟磁盘和 CLI

### Removed

- 去掉任务失败时dump.json的生成

### Optimized

- 远程插件的缓存
- 安卓部分表单控件UI优化

## [3.0.4]

### Fixed

- 随着预览图切换，所选择的图片项也跟着切换
- 任务正确显示删除图片数量
- 当拖入可识别文件类型，应用会自动置顶
- 桌面宽高比计算问题
- 修复跳过不支持的图片
- 整理启动流程，优化启动速度
- MacOS 图标大小比周围大一圈的问题

### Added

- 添加 MacOS M芯片应用打包（normal、loccal、light三模式）
- 添加安卓apk支持

### Changed

- 将cli从导入中移除，导入插件时直接启动main，大大减小light模式下linux的打包大小，并兼容macos的mime打开方法。
- 随着预览图的切换，当前选择项目也会跟着变化
- 重复启动应用会导致原来的应用窗口显示，而非
- 内置插件不复制到用户数据目录，而是保持在资源目录
- 下载流程整理，抽象协议下载器更好维护
- 性能优化，画廊有http浏览器原生流式加载，不再手动维护blob声明周期

### Removed

- 去掉cli打开插件显示预览
- 去掉light模式的linux的虚拟磁盘支持
- **去掉插件编辑器**，为之后的js插件做准备
- **去掉本地导入插件**，改用内置的本地导入例程

## [3.0.3]

### Added

- 添加linux plasma支持
- 添加linux fuse虚拟盘支持

### Fixed

- 整理了启动流程，重新整理了一下架构
- 修复默认输出目录包含插件目录的bug

## [3.0.2]

### Added

- F11全屏快捷键
- 新增 `bun check` 命令：按组件依次检查 `vue-tsc` 与 `cargo check`
  - `bun check` 必须指定 `-c, --component`
  - `--skip` 统一为 `vue|cargo` 且只能指定其中一个值
- plugin editor 支持全量的变量类型
- plugin editor 支持不手动输入json指定变量类型
- Rhai 脚本新增 HTTP Header 接口：`set_header` / `del_header`
- plugin-editor Rhai 编辑器补全/悬浮/签名提示新增 `set_header` / `del_header`
- plugin-editor 测试面板支持配置 HTTP Header
- ctrl + c 复制图片快捷键
- rar 解压缩导入支持

### Changed

- 将构建脚本从js升级到ts，类型更安全
- 将服务端ipc代码移到core
- 构建命令支持 `--skip vue|cargo`（只能一个值；main 支持 `--skip vue` 跳过前端构建）
- 将 release 放到了git中，原因：
  1. 方便用户从README直接下载
  2. 方便引用
  3. 不用调试github action
  4. 不用等待github action的缓慢运行
  5. 不用为了action ci而调整构建代码
  6. 不用维护action和script两处代码
  7. 克隆仓库的用户可以直接从 release 目录下运行安装脚本
     缺点是
  8. git 包增加约100mb，上传下载都变得耗时
  9. 每次发布都要更新 README.md，不过不复杂
     但是考虑到这是对C的终端应用，所以这些缺点可以接受。因为克隆仓库的人不多。
- 爬虫中的重定向会带上所有原始header

### Removed

- 经过考虑去掉 plasma 插件。原因：
  1. 几乎没有文档，只能借鉴社区里的若干项目
  2. 调试困难，每次都要重启 plasma shell
  3. 同步问题繁琐，插件和主应用之间的状态管理复杂
  4. 功能不强。插件提供的功能主应用几乎都能提供，而且插件还依赖主应用的运行
  5. 侵入性高。用户在运行plasma插件的同时不能用其他插件
  6. 用户不多。社区最火的插件全球安装量只有2w+，不值得投入太多精力开发
  7. 安装、卸载逻辑复杂，要在deb包里维护这些逻辑
  8. 无法发行在商店，或者发行复杂。因为商店不支持deb包发行，只支持tar.gz，导致不能安装.so。

### Fixed

- plugin editor 任务列表显示插件名称问题
- 画廊切换到其他tab导致画廊页面归一的问题
- kgpg拖拽导入将kgpg当作图片的bug
- 修复 light 和 local 关于内置插件的问题
- 修复 reqwest 30x 处理问题
- 当一次性导入过多压缩包导致死锁问题。解决方案是用一个专门的线程解压缩

## [3.0.1]

### Changed

- 经过各种考虑，去掉daemon，改成app-main内嵌服务，原因如下：
  1. daemon状态管理太复杂
  2. 与app-main的交互存在显著性能开销
  3. 未来做self-hosted不好迁移
  4. 用户无法轻易关闭的后台服务很令人反感。

## [3.0.0]

### Added

- linux plasma 支持（原生壁纸设置以及壁纸插件模式）
- linux plasma wallpaper plugin 子仓库

### Changed

- 架构迁移到一个daemon负责底层数据，其他前端与之通过ipc交互（windows 命令管道，unix 用 UDS）
- cli 不常驻，与daemon交互操作
- **plugin-editor 迁移到 IPC 架构**：插件编辑器现在通过 IPC 与 daemon 通信，而不是直接访问本地 State
  - 添加 `daemon_client.rs` 模块统一管理 IPC 客户端
  - 存储相关命令（任务、图片）迁移到 IPC
  - 设置相关命令迁移到 IPC
  - 启动时自动确保 daemon 已就绪
  - 本地仅保留运行临时任务所需的组件（TaskScheduler、DownloadQueue）
- **cli 的输出画册参数改为使用画册名称**：`--output-album-id` 改为 `--output-album`，因为画册名称已经固定。CLI 会自动将画册名称转换为 ID（不区分大小写）

## [2.1.1]

### Added

- cli 添加 vd 子命令，可以常驻后台服务虚拟磁盘

### Changed

- main 程序在无法挂载磁盘的时候会用cli提权，并通过管道通信

### Fixed

- 修复actions pnpm老是报错

## [2.0.3]

### Changed

- 改用mmap优化图片的读取性能
- 修复发布action问题
- 固定一个大页为1000大小，不使用分小页，简化应用，增加代码复用和可扩展性
- 商店图标拉取改为最大并发10个

### Fixed

- 修复快速滚动之后需要小步滚动才能加载的bug
- 修复task-detail缩略图加载缓慢问题，修复vue的transition-group对相同key复用退出动画迟延问题（直接给AlbumDetail和TaskDetail加虚拟滚动就可以了）
- 商店插件与本地插件icon当id相同时重叠的问题
- 更新README文档

## [2.0.0]

### Added

- zip文件导入支持。可以通过本地文件导入功能导入，以及手动拖入
- 支持导入文件夹zip文件时自动创建画册
- 插件编辑器，以单独的进程运行
- cli命令行，可用的命令为 kabegame-cli plugin run/pack
- 添加虚拟盘，可以通过文件资源管理器直接看画册的图片啦
- rhai脚本新增 download_archive

### Changed

- 将 ImageGrid 与 GalleryView 合并为一个组件
- 为 ImageGrid 添加虚拟滚动和按需加载等优化，轻松对应数万、甚至十万百万级别的滚动
- 使用worker而非创建线程，多任务不再卡顿
- 图片的主码从字符串变成数字
- 重构 imageSrcMap 为全局store

### Deprecated

- 壁纸的style字段和transition字段，该字段现在做成了按模式保存

### Removed

- 本地文件导入插件和本地文件夹导入插件

### Fixed

- 多选情况下单击不会退出多选，也可以双击打开预览图
- 当数据库过大的时候不全数据库扫描，避免打开黑屏问题
- 源文件不存在的image右上角出现红色小感叹号
- 窗口最小化的时候壁纸窗口弹到顶部

---

## [1.0.0] - YYYY-MM-DD

### Added

- 初始版本

---

## 变更记录指引（建议）

- **前端（Vue3/Vite/ElementPlus）**：`src/`
  - 例如：页面/组件改动、交互变更、状态管理、性能优化、样式主题等
- **后端（Tauri v2/Rust）**：`src-tauri/`
  - 例如：命令/事件、下载队列、壁纸管理器、存储/迁移等
- **插件系统（Rhai / crawler-plugins / .kgpg）**
  - 例如：Rhai API 变更、插件打包格式、插件商店安装/更新、兼容性说明等
