# FreeType patches

`third/freetype` is the pristine upstream FreeType repository. It is compiled (together with
HarfBuzz and the C glue in `src-tauri/wpefont/`) into `wpefont.wasm`, the font engine of the
scene-wallpaper renderer; it is never linked into the app. See
[src-tauri/wpefont/README.md](../../src-tauri/wpefont/README.md) and
[cocs/wpe/WPE_SCENE.md](../../cocs/wpe/WPE_SCENE.md) ("字体引擎 wpefont").

## Upstream

- Repository: <https://github.com/freetype/freetype.git> (GitHub mirror of
  <https://gitlab.freedesktop.org/freetype/freetype.git>; shallow submodule)
- Vendor base: `0a0221a1347e2f1e07c395263540026e9a0aa7c7` — tag `VER-2-14-3` (FreeType 2.14.3)

The `src/` and `include/` trees at this commit are byte-identical to the official
`freetype-2.14.3.tar.xz` release that the P6b 1a probe compiled. The nested `subprojects/dlg`
submodule is only used with `FT_DEBUG_LOGGING` and is not needed by the build.

## Why this version

Wallpaper Engine rasterizes text with the FreeType 2.14 series. The P6b 1a probe compared the
glyph atlases of WPE RenderDoc captures (about 700 000 pixels over the `p6b-*` test projects)
against wasm builds of several releases:

| FreeType | pixels different from WPE |
|---|---|
| 2.13.2, 2.13.3 | 37 (three `opensticks` glyphs, "M" one pixel wider) |
| 2.14.0 – 2.14.3 | 1 (an atlas-packing side effect, not rasterization) |
| 2.15.0 | 251 more (Microsoft YaHei / Malgun Gothic) |

2.14.3 is the newest release of the matching series. Since 2.14, `ftgrays.c` uses the DDA
curve flattening whenever a 64-bit integer type exists, so wasm32 rasterizes exactly like the
x64 build WPE ships; 2.13.x needed a local patch for that, 2.14 does not.

## Patches

None. `deno task patch --all` reports "nothing to do" for this directory. Build options live in
the build script (`scripts/build-wpefont.ts`) and the module table
(`src-tauri/wpefont/ftmodule.h`), not in patches.

## Re-vendor

1. Move `third/freetype` to the new tag and update the gitlink.
2. Update the expected version in `scripts/build-wpefont.ts` and this README.
3. `deno task build:wpefont`, then rerun the glyph baselines
   (`apps/wpe-scene/src/wpefont/index.test.ts` with `KABEGAME_WPE_ROOT` set). Any difference in
   bitmaps or advances must be checked against WPE captures before the bump is accepted.
