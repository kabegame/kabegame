# v4.1.1 changelog

Main updates for release manga: (only explore those related code changes)
1. More filter for gallery.
2. Video with & height fill back and video will not be played automatically.
3. background image more stable url
4. PathQL delegate more strong.

## Added
- **Provider DSL runtime globals**: PathQL string templates now support `${global:prefix|selector}` for host-owned display maps, enabling locale-specific VD date labels while keeping shared date providers on canonical year/month/day ids.
- **Provider DSL plugin scan source**: Added a shared `plugins_provider` DSL provider so Gallery and Virtual Disk plugin browse trees reuse one plugin enumeration source instead of duplicating plugin scan SQL.
- **Image Size**: Image Size ordering. And can see image dimension.
- **Image format Provider**: Image format filtering for vd and gallery. 
- **Image dimension Provider**: Image dimension filtering for vd and gallery.
- **Image by name Provider**: Image name filter and ranking providers for vd and gallery.

## Changed
- **Provider DSL loading**: Built-in DSL providers are now loaded by recursively scanning `src/providers/dsl` with an explicit non-provider exclusion list, keeping `schema.json5` and retired compatibility shims out of runtime registration.
- **PathQL validation and docs**: Strict cross-reference validation now treats templated provider names as runtime-dynamic registrations, and the final PathQL/provider DSL specs document delegate scope, recursive loading, dynamic provider refs, and runtime-global display maps.
- **Plugin browse DSL**: Gallery and locale-specific VD plugin folders now delegate to the shared `plugins_provider`, while each branch owns only its visible path label and target plugin router.

## Optimized
- **Video Playing**: For performance consideration, image item will not play video automaticly, users should manually play one of them.
- **Setting**: Settings fetch all at first once. Then updated by events.
- **Web**: More sensiable event for web umami analysis.
- **Filter**: Shrink too many refresh provider path calls to one when filter child node expands;

## Fixed
- **Background image**: Background image used the image.url fields which is not stable. Now use fileToUrl(image.localPath)
- web do not need front image type detection.
- web is super state fix.
- **Crawler metadata storage**: Raw crawler metadata is now normalized into `image_metadata` at Rhai/WebView ingress and the legacy `images.metadata` column is removed by migration. Failed-image retries keep the original `display_name` and `metadata_id`, and orphaned metadata rows are garbage-collected when images or failed-task records are deleted.
- **UI & data**: Video witdh and height fill back.
- **Web**: web download should not navigate to image url page.
- **UI**: Task detail now use the same layout as gallery uses. 
- **UI**: Task detail pagination logic now load from the provider path.
- **PathQL**: Provider delegated cannot access fields contrib bug.
- **Provider DSL routing**: Restored canonical pagination routing through `query_page_provider`, fixed desc-router provider naming, removed the unused date-range route, and kept dynamic plugin entry providers from being reported as missing built-in providers.
- **Rotator**: random rotation shows no images to rotate.
- **DSLProvider**: Reverse list wrong behavior causing bug. 
