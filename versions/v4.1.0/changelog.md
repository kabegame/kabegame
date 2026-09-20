# v4.1.0 changelog

## Added

- **Provider DSL migration:** Most gallery, virtual-disk, MCP, wallpaper-rotation, organize, album, task, surf, plugin, media-type, date, search, wallpaper-order, raw-image, and image-metadata provider paths now run through declarative PathQL provider DSL files instead of hand-written programmatic provider/router code. The public path surface stays path-first (`fetch(path)`, `count(path)`, list children, and provider-backed helper APIs), while the implementation is now data-driven and easier to extend.
- **Plugin-owned provider trees:** Installed crawler plugins can ship provider DSL files in their package and expose nested provider subtrees through their plugin entry provider. Gallery's "by plugin" tree and the virtual-disk plugin folders now share the same plugin-owned provider contract, so plugin-specific browse paths can come from plugin metadata instead of app-specific UI logic.
- **Raw image provider channel:** Added an explicit `/images` provider tree for automation and MCP use, including paged raw image rows and `/images/id_{id}/metadata` metadata lookup paths.
- **Album detail tabs:** AlbumDetail now switches between an image grid tab and a sub-albums tab instead of rendering child albums as an expandable block above the image grid.
- **In-app background image:** Added a frontend-local app background that mirrors the current wallpaper image across all platforms. The feature is enabled by default and includes local settings for enable/disable, opacity, and blur, exposed in Settings and Quick Settings.

## Changed

- **Kabegame workspace naming:** Renamed the remaining `app-main`, `app-cli`, `core`, and `apps/main` workspace directories to `kabegame`, `kabegame-cli`, `kabegame-core`, and `apps/kabegame`. Build component flags, `KABEGAME_COMPONENT` values, Nx targets, npm scripts, frontend package metadata, Tauri config paths, and release/build documentation now use the same `kabegame` / `kabegame-cli` naming as the Rust crate names. The desktop and Android product identifiers remain unchanged, so installed app data is not migrated.
- **Provider path semantics:** Pagination, plain limit, ordering, count, child listing, and metadata lookup semantics are now represented consistently in provider paths. Page-list folders are exposed across equivalent gallery and virtual-disk branches rather than only under `all`.
- **MCP/provider automation:** MCP-facing provider reads now have clearer path semantics and can use the DSL-backed provider tree directly for gallery browsing, raw image enumeration, image metadata, and album-order workflows.
- **Gallery / AlbumDetail sticky scrolling:** Gallery and AlbumDetail now use the `ImageGrid` scroll context for their page header, browse toolbar, and big paginator, so sticky headers and paginators pin inside the same scroll container as the image grid. Horizontal layouts keep the inner horizontal scroll container to preserve item sizing.
- **ImageGrid scroll controls:** The floating scroll controls are simplified to explicit edge shortcuts: show top/bottom arrows whenever the vertical container is not at that edge, and show left/right arrows for horizontal scroll containers. Programmatic edge scrolling now cancels in-flight smooth-wheel animation before jumping.
- **ImageGrid / preview shortcuts:** Backspace now hides the selected grid images or current preview image through the existing `addToHidden` action, while Delete keeps the permanent-delete flow and confirmation dialog. Help shortcut docs and i18n copy now describe the split behavior.
- **Web wallpaper action:** In web mode, the image action is labeled "Set as background" and stores `currentWallpaperImageId` in localStorage instead of showing the desktop-only wallpaper guard. Multi-select falls back to setting the first selected image as the in-app background.
- **Background-aware cards:** Settings cards and Plugin Browser plugin cards become transparent only while the in-app background setting is enabled, using UnoCSS utility classes so the normal theme remains unchanged when the feature is off.

## Fixed

- **Gallery desktop filter tree:** Changing the Gallery search query no longer collapses the whole provider filter popover into a single global "Loading" row. The tree keeps its root rows visible and lazy-loads only the expanded branch.
- **Gallery / AlbumDetail big paginator input:** Hovering or focusing the paginator page input no longer adds a physical border that changes the paginator height and causes layout jitter.
- **Crawler output album picker:** Hidden albums are now filtered out of CrawlerDialog's output-album picker, matching other album move/picker flows.
- **Album image count:** AlbumDetail totals are loaded through the provider count path instead of deriving the total from the current page size, so the tab label and big paginator use the full matching image count.
- **ImageGrid whole-container virtual scroll:** Grid-mode virtual scrolling now accounts for the offset of `before-grid` content such as headers, toolbars, and paginators, preventing short pages and blank space when the whole `ImageGrid` container is the scroll element.
- **ImageGrid horizontal mode:** Horizontal grid mode keeps correct item sizing with `scrollWholeContainer`, supports virtual scrolling by calculating visible column groups from `scrollLeft`, and rebinds scroll listeners when the active scroll element changes between vertical and horizontal layouts.
- **ImageGrid preview sync:** Preview navigation that wraps from the last image to the first image, or from the first image to the last image, now scrolls the virtualized grid to the target even when that item is not currently mounted in the DOM.
- **Tray**: Click tray now show the window always.

## Removed

- **Programmatic provider duplication:** Removed the old programmatic provider/router layer for migrated paths; the canonical implementation now lives in the DSL provider tree.
