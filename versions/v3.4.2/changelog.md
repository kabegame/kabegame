# v3.4.2 changelog

## Added

- **Rhai crawler:** `warn(message)` writes a warn-level line to the task log (same channel as HTTP retry notices).
- **Plugin config:** Per-option `when` on `options` / `checkbox` entries (same semantics as field-level `when`); crawler/default-config/auto-config forms reset invalid option values when filters change.

## Changed

- **Pixiv plugin:** Ranking crawl uses separate mode/content/age fields, single `ranking_date`, JSON `next` pagination, Rhai `warn()` for shortfall, and R18 requires account UID + Cookie.
- **Pixiv plugin:** Ranking `content_mode` shows whenever `source` is ranking; each `ranking_mode` option uses `when` on `content_mode` (illust/manga vs ugoira vs all-only modes).
- **Pixiv plugin:** Multi-page illusts use download names `title(1)`, `title(2)`, …; single-page keeps plain `title` (fallback: illust id when detail missing).
- **IPC / gallery:** `images-change` (`DaemonEvent::ImagesChange`) now includes optional `albumIds`, `taskIds`, and `surfRecordIds` so album/task/surf views and the Plasma wallpaper plugin can refresh selectively.

## Fixed

- **Album/Task:** Not update image list when delete image source.

## Optimized

- **Pixiv plugin:** Store only EJS-needed fields in `images.metadata` (`crawl.rhai` + one-time DB trim for existing rows) to speed gallery/album lists when metadata was huge.
- Remove some unnecessary call of refresh cache.
- Self update for shop source list when expires 24h.
- reuse connection pool, download be more fast!
- not query metadata for common query.

## Removed

- remove android scheduled config cause it is hard to implement.
