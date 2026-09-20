# v4.2.0 changelog

## Added
- **Folder Album**: Can create an album that keep syncing to a folder (Open a switch setting to keep in sync)
- **Filter composiable**: Composiable filters, now can filter today's video.
- **Father Album**: Now can point a father album when create an album.
- **Kamechan mascot**: kamechan mascot
- **Quick filter**: click one specific image's property to filter those images quikly. 
- **Plugin metadata migrations**: Crawler plugins can ship `metadata_migrations/v{N}.rhai` scripts to migrate historical image metadata on install, update, and startup. Rhai `download_image` now accepts `metadata_version`, and `create_image_metadata` supports the `#{ version: N }` overload.
- **Video support**: mkv, webm

## Optimized
- **Providers**: more query use pathql providers
- **ElSelect Filterable**: AlbumSelectField and long plugin option field can filter by input string.
- **Android Thumbnail**: Android now use thumbnail in gallery for new pictures.
- **Organize gate**: organize now won't gate any tasks.

## Fixed
- **Organize image-file killer bug (data loss)**: A single Organize run could permanently delete thousands of original image files. Three causes, all fixed: (1) "delete source files" used a hard `remove_file`, bypassing the Trash; (2) when a library folder was reached through a **symlink** (e.g. `~/Pictures` → an external drive), deduplication treated the two path spellings of the same physical file as duplicates and deleted the **shared** file, taking down the surviving copy too; (3) Organize paginated with `OFFSET` while deleting rows mid-scan, so the window shifted and rows were skipped — making Organize non-idempotent ("every run still removes items") and never converging.
- **Organize pagination**: switched batch paging from `OFFSET` to an **`id > last_id` keyset cursor**, so deleting already-scanned rows can no longer shift the window. Organize now scans the whole library in one pass and is idempotent.
- **By Wallpaper Order**: by wallpaper order perpend the ordering to sql in dsl.

## Changed
- **Deletion now goes to the system Trash (non-configurable)**: Deleting original image/video files — whether via Organize's "delete source files" or the gallery delete action — now moves them to the OS Trash via the `trash` crate (recoverable) instead of permanently unlinking. If trashing fails, the file is kept on disk and only the database record is removed; there is no option to permanently delete. App-maintained thumbnails are still removed directly.
- **Never auto-delete files on symlink/network/virtual paths**: Source-file deletion now refuses any path that passes through a symlink, or lives on a network/virtual/unknown filesystem (allowlist of normal local filesystems); such files are only removed from the library and kept on disk. Organize and delete dialog texts explain this.
- **MCP resource schemes**: The public MCP read surface now uses `images://`, `albums://`, `tasks://`, `surf_records://`, and `plugin://`. The old `provider://`, `image://`, `album://`, `task://`, and `surf://` resource schemes are no longer supported.
- **MCP Bundle compatibility**: Updated the `kabegame-gallery-node` MCPB bridge to forward read tools to the new resource schemes while keeping the existing tool names for host-side compatibility.
- **Documentation**: Updated the public MCP guide, reference, and bundle guide to document the new `images://` and plural table resource paths.
- **Local import**: local import now will not use the download window.
- **Grid Image View**: Grid image now show full content centered in an 1:1 container.
- **Video play**: Can pause and change speed of video playing.
- **Image Thumbnail**: Now images that size smaller than 1MB's thumbnail will not generated, images that size bigger than 1MB will be generated a thumbnail that has a size about 500KB.
- **Image item preview**: Image item load origin images when mouse hover over 200ms. Video start playing after that time too.
- **Wheel zoom**: Zoom only triggered when ctrl + wheel, common wheel event will cause a viewport movement.
- **Image Preview**: Next image will try to switch to next page.  
- **FFmpeg binding**: FFmpeg now embeded or dynamic linked instead of a cli usage.

## Removed
- **Archive**: Archive unzip feature removed from application completely. Including Rhai API and local import unarchiving behavior.
- **WE export**: wallpaper engine exporting dropped.
- **Light mode video**: video support dropped on light mode.
