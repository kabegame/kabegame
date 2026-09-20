# v3.3.0 changelog

## Added

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

## Fixed

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

## Changed

- **Surf:** Clicking a record card opens the detail dialog instead of starting a session; a dedicated “Start surfing” button on each card starts the session (disabled while a session is active).
- **Surf:** “View recent images” replaced with a “View downloaded images” button on record cards.
- **Surf:** Removed top-bar “View Cookie” and “End session” buttons; cookies are accessed in the record detail dialog; session is ended by closing the surf window.
- **Gallery (desktop):** Filter and sort moved from the page header to the row below the title (above the big paginator), matching album detail; on Android they stay in the header overflow menu with bottom pickers.
- Builtin plugin removed, must download from remote.
- Github release remote source cannot be deleted.

## Optimized

- Task drawer and “copy error” details now only list plugin run options that apply to the current configuration (same `when` rules as the run form), not hidden/irrelevant fields.
- HTTP downloads (crawler images and plugin store `.kgpg`) now resume in memory when the stream fails: retry requests use `Range` from bytes already received; if the server ignores Range (non-206), the client falls back to a full re-download to avoid corrupt concatenation.
- Crawler Rhai: `to()` and `fetch_json()` emit task-log `info` lines (request start, success with resolved URL / stack depth / JSON type) for easier script debugging.
- **Plugin browser (store):** `.kgpg` download streams into memory then writes once (no partial cache files); `get_store_plugins` merges active download progress; progress callbacks are throttled to 1s; up to two retries after a failed attempt. `preview_store_install` emits `plugin-store-download-progress` for the UI.
- **Plugin browser (store):** install button shows download progress as a left-to-right fill with percentage; when the installed version equals the store version, the control is a disabled “Installed” state (no reinstall), and plugin detail opens from the local install (no remote query) so docs load offline.
- **Plugin detail page:** When you install from the store on the source detail / doc page, the install button shows the same live download progress (fill + percentage) as on the plugin store grid. The summary at the top now includes a **Version** row so you can see the package version at a glance.
- **Plugin browser （Android）** Store and installed lists use a two-column square card layout
- **Plugin doc:** Images in plugin Markdown docs open in a full-screen preview on tap or click: Android uses PhotoSwipe (no looping); desktop uses the Element Plus image viewer (no infinite wrap). Natural size is resolved after load so PhotoSwipe gets correct dimensions.
