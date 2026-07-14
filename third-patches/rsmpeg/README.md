# rsmpeg patches

## Upstream

- Repository: <https://github.com/larksuite/rsmpeg.git>
- Vendor base: `b21fcfd` (`Bump version to 0.18.0+ffmpeg.8.0 (#247)`, branch `master`)

## Patches

- `0001-rusty-ffmpeg-0-17-and-ffmpeg8-1-feature.patch` — bumps the `rusty_ffmpeg` dependency to `0.17.0` so it resolves through the root `[patch.crates-io]` override to `third/rusty_ffmpeg`, and adds the `ffmpeg8_1` feature (`["ffmpeg8", "rusty_ffmpeg/ffmpeg8_1"]`) matching the FFmpeg n8.1.x submodule.
- `0002-remove-avdevice.patch` — removes the `avdevice` module (`src/avdevice/` + the `pub mod avdevice;` re-export); the project's FFmpeg build disables libavdevice.

The crate is consumed as a `[patch.crates-io]` path override in the root
`Cargo.toml` (not a workspace member). Apply this series manually before any
cargo build that resolves `rsmpeg`:

```bash
bun run patch rsmpeg
```

Use `bun run patch`, not `bun patch`: Bun 1.3 provides its own unrelated
dependency-patching subcommand under the latter name.

## Re-vendor

1. Run `bun run patch rsmpeg -r` to restore the clean vendor tree.
2. Update `third/rsmpeg` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
