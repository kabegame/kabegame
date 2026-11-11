# HarfBuzz patches

`third/harfbuzz` is the pristine upstream HarfBuzz repository. Its amalgamated
`src/harfbuzz.cc` (with `hb-ft`) is compiled together with FreeType and the C glue in
`src-tauri/wpefont/` into `wpefont.wasm`, the font engine of the scene-wallpaper renderer; it is
never linked into the app. See [src-tauri/wpefont/README.md](../../src-tauri/wpefont/README.md)
and [cocs/wpe/WPE_SCENE.md](../../cocs/wpe/WPE_SCENE.md) ("字体引擎 wpefont").

## Upstream

- Repository: <https://github.com/harfbuzz/harfbuzz.git> (shallow submodule)
- Vendor base: `35f656a1a2bab548ea7f54a6dd3fba2b09680d14` — tag `15.0.0`

The `src/` tree at this commit is byte-identical to the official `harfbuzz-15.0.0.tar.xz`
release that the P6b 1a probe compiled (`hb-version.h` and the Ragel outputs are checked in
upstream, so no generator runs).

## Why this version

15.0.0 is the version of the offline reference (`uharfbuzz`) that the P6b step 0 measurements
against WPE were taken with; the 1a wasm build matches that reference field for field (glyph id,
cluster, advances, offsets) on all 557 glyphs of the `p6b-*` objects. FreeType's autohinter is
built **without** `FT_CONFIG_OPTION_USE_HARFBUZZ`: the probe showed identical output either way,
so FreeType does not depend on HarfBuzz.

## Patches

None. `deno task patch --all` reports "nothing to do" for this directory. The build compiles
HarfBuzz without exceptions, RTTI or threads (`-fno-exceptions -fno-rtti -DHB_NO_MT`); see
`scripts/build-wpefont.ts`.

## Re-vendor

1. Move `third/harfbuzz` to the new tag and update the gitlink.
2. Update the expected version in `scripts/build-wpefont.ts` and this README.
3. `deno task build:wpefont`, then rerun the glyph baselines
   (`apps/wpe-scene/src/wpefont/index.test.ts` with `KABEGAME_WPE_ROOT` set).
