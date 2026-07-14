# tauri patches

All kabegame changes to the **tauri monorepo** live here as one numbered series.
`third/tauri` is the pristine upstream `tauri-apps/tauri` submodule; the series patches
its three consumed sub-crates: `crates/tauri-runtime` and `crates/tauri-utils` (libraries,
pulled into the app via `[patch.crates-io]`) and `crates/tauri-cli` (the forked
`cargo-tauri` binary, built by `TauriCliPlugin`). One submodule, one series — no separate
`kabegame/tauri-cli` fork and no vendored `third/tauri-runtime` copy to keep in sync.

## Upstream

- Repository: <https://github.com/tauri-apps/tauri.git>
- Vendor base: `499df79b` — tag `tauri-v2.11.2` (`tauri` 2.11.2 / `tauri-runtime` 2.11.2 /
  `tauri-cli` 2.11.2 / `tauri-utils` 2.9.2). Chosen so `tauri-runtime` matches the `tauri`
  the app resolves — no library version churn.

## Patches

`tauri-cli` (fork of `cargo-tauri`, see [cocs/tauri/TAURI_CLI_FORK.md](../../cocs/tauri/TAURI_CLI_FORK.md)):

- `0001-tauri-cli-android-package-decouple.patch` — `TAURI_ANDROID_PACKAGE` env decouples the
  Android Java package (source dir / generated Kotlin package / JNI) from `identifier`
  (applicationId). Touches `mobile/mod.rs` (`ensure_init` java-folder), `mobile/android/mod.rs`
  (`android_package`/`get_config`), and `mobile/android/{dev,run}.rs` (fully-qualified
  `{android_package}.MainActivity` for auto-launch).
- `0002-tauri-cli-no-webkit-deps.patch` — `TAURI_NO_WEBKIT_DEPS` skips the deb/rpm
  `libwebkit2gtk` dependency injection (kabegame bundles CEF) and dedups `depends_deb`/`depends_rpm`.
- `0003-tauri-cli-icns-inset.patch` — macOS `.icns` gets dock inset padding
  (`resize_exact_inset` + `MACOS_ICON_CONTENT_SCALE`); `.ico`/png/android stay full-frame.
- `0004-tauri-cli-android-check-subcommand.patch` — adds `tauri android check`
  (`mobile/android/check.rs` + dispatch) for a fast `cargo check --target aarch64-linux-android`
  reusing cargo-mobile2's NDK toolchain; no APK/AAB, no frontend.
- `0005-tauri-cli-android-dev-localhost.patch` — a physical device no longer forces the LAN IP;
  a localhost devUrl is kept so `adb reverse` tunnels HTTP + HMR WebSocket over USB loopback.
- `0008-tauri-cli-bundle-only-default-run.patch` — when `get_binaries` collects more than one
  binary and `default-run` is declared, only the `default-run` (main) binary is auto-bundled
  into install dirs (`/usr/bin`, .app, NSIS). Auxiliary `[[bin]]`/`src/bin/` targets
  (`kabegame-cef-helper`, `cef-example`) must be shipped explicitly via bundle `files`
  (deb files / `macOS.files`). Without `default-run` (or with a single bin) upstream
  behavior is unchanged.

`tauri-utils` (library, consumed via `[patch.crates-io]`):

- `0007-tauri-utils-skip-empty-glob-resources.patch` — empty glob resource patterns (e.g.
  `resources/**/*` when the `resources/` directory does not exist) are silently skipped
  instead of failing the build with `GlobPathNotFound`. Allows builds where optional resource
  directories are absent.

`tauri-runtime` (library, consumed via `[patch.crates-io]`):

- `0006-tauri-runtime-optional-webkit.patch` — makes `webkit2gtk` optional behind a new
  `webkit` feature and gates the Linux/BSD `webkit2gtk::WebView` fields in `webview.rs` behind
  it, so the Linux CEF build does not link `webkit2gtk`.

Apply the whole series manually before building against `third/tauri`:

```bash
bun run patch tauri
```

Use `bun run patch`, not `bun patch`: Bun 1.3 provides its own unrelated
dependency-patching subcommand under the latter name.

## Consumption (root `Cargo.toml`)

The whole tauri stack is `[patch.crates-io]`-pointed at `third/tauri/crates/*`
(`tauri`, `tauri-runtime`, `tauri-runtime-wry`, `tauri-utils`, `tauri-macros`,
`tauri-codegen`, `tauri-build`) so the submodule is the single source of truth — a bump
is just a submodule bump + this series, with no registry version to keep in sync.
`tauri-plugin` is intentionally **not** patched (the tag's 2.6.2 leads crates.io's 2.5.3, so
cargo would flag the patch unused; it only depends on tauri/tauri-utils, so no type boundary),
and `Cargo.lock` pins `tauri-utils` to `2.9.2` (the monorepo version, satisfies every `^2.x`
requirement) so the path patch unifies the whole graph on one `tauri-utils`.

`tauri-cli` is built by `TauriCliPlugin` via `--manifest-path third/tauri/crates/tauri-cli`
(output in the monorepo workspace `third/tauri/target/release/cargo-tauri`); it is not part of
`[patch.crates-io]`.

## Re-vendor

1. `bun run patch tauri -r` to restore the clean submodule tree.
2. Bump `third/tauri` to the new upstream tag (pick one whose `tauri`/`tauri-runtime` match
   the version the app resolves).
3. Re-apply each patch with `git apply --check`, repairing context drift (see the drift-prone
   anchors listed in [cocs/tauri/TAURI_CLI_FORK.md](../../cocs/tauri/TAURI_CLI_FORK.md)).
4. Regenerate the numbered patch files against the new base and update this README.
5. Re-pin `tauri-utils` in `Cargo.lock` (`cargo update -p tauri-utils --precise <monorepo ver>`)
   if the tag's version differs from crates.io's latest.
