# v3.4.0 changelog

## Added

- **RunConfig**: Auto run schedule feature. Plugin recommand config for on click import.
- **RunConfig / schedule:** `weekly` mode: choose weekday and time of day (`schedule_spec`: `{ "mode": "weekly", "weekday", "hour", "minute" }`, `weekday` 0 = Monday … 6 = Sunday).
- **Plugins:** Settings → Plugin defaults: per-plugin crawl defaults (vars, HTTP headers, output dir) in `plugins-directory/default-configs/<pluginId>.json`, preferred when picking a source in crawl/auto-config UIs with per-field fallback, auto-created on import or first open.
- **Task:** Crawl task progress bars when `progress > 0` (task drawer, task panel, inline summary rows): default styling while running, explicit red for failed and neutral gray for canceled; progress is kept on failure/cancel so the bar reflects how far a run got.

## Optimized

- **Plugins:** Installed plugin icons and multilingual `doc.md` docs are fetched in parallel with recommended presets after `loadPlugins` and cached in `usePluginStore` (`get_plugin_icon` / `get_plugin_doc_by_id`); pages and drawers no longer request icons redundantly.
- **TaskDrawer**: optimize the performance of switching visiablity.
- **Crawler store:** Load tasks and run configs once inside `defineStore`, expose `runConfigsReady` / `tasksReady`, drop redundant view-level loads, and patch run configs locally after writes instead of full-table reloads.
- **Plugin store:** `loadPlugins` applies `get_plugins` results in a `.then` handler with an empty default list; narrowed call sites to the plugin browser (manual refresh / store install) plus post-install paths, removing gallery and related prefetch.
