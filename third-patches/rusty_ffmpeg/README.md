# rusty_ffmpeg patches

## Upstream

- Repository: <https://github.com/CCExtractor/rusty_ffmpeg.git>
- Vendor base: `3a0752a` (`0.17.0+ffmpeg.8.1`, branch `master`)

## Patches

- `0001-drop-avdevice.patch` — removes `avdevice` from the linked FFmpeg `LIBS`; the project's FFmpeg build disables libavdevice.
- `0002-static-x264-and-link-path-order.patch` — rewrites the pkg-config linking pass in `build.rs`: emits the FFmpeg libraries' own link paths first (so `third/FFmpeg-build` archives win over identically-named system archives) and forces x264 to link statically (the system `libx264.so` crashes under CEF's PartitionAlloc `memalign` replacement).
- `0003-ffmpeg-archive-rebuild-stamp.patch` — tracks each `libav*.pc`/`libav*.a` with `rerun-if-changed` and embeds an archive mtime stamp via `RUSTY_FFMPEG_ARCHIVE_STAMP`, so rebuilding FFmpeg externally recompiles rusty_ffmpeg instead of reusing an rlib with stale `.o` files.

The crate is consumed as a `[patch.crates-io]` path override in the root
`Cargo.toml` (not a workspace member); `rsmpeg`'s `rusty_ffmpeg = "0.17.0"`
dependency (patched in `third-patches/rsmpeg/`) resolves to it the same way.
Apply this series manually before any cargo build that resolves `rusty_ffmpeg`:

```bash
bun run patch rusty_ffmpeg
```

Use `bun run patch`, not `bun patch`: Bun 1.3 provides its own unrelated
dependency-patching subcommand under the latter name.

## Re-vendor

1. Run `bun run patch rusty_ffmpeg -r` to restore the clean vendor tree.
2. Update `third/rusty_ffmpeg` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
