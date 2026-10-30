# tauri patches

All kabegame changes to the **tauri monorepo** live here as one numbered series.
`third/tauri` is the pristine upstream `tauri-apps/tauri` submodule; the series patches
its consumed sub-crates: `crates/tauri`, `crates/tauri-runtime`, `crates/tauri-runtime-wry` and
`crates/tauri-utils` (libraries, pulled into the app via `[patch.crates-io]`) plus
`crates/tauri-cli` (the forked
`cargo-tauri` binary, built by `TauriCliPlugin`). One submodule, one series — no separate
`kabegame/tauri-cli` fork and no vendored `third/tauri-runtime` copy to keep in sync.

## Upstream

- Repository: <https://github.com/tauri-apps/tauri.git>
- Vendor base: `59b63ab5` — tag `tauri-v2.12.4` (`tauri` 2.12.4 /
  `tauri-runtime` 2.12.2 / `tauri-runtime-wry` 2.12.2 / `tauri-utils` 2.10.2 /
  `tauri-macros`, `tauri-codegen`, `tauri-build` 2.7.3 / `tauri-cli` 2.12.3).

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
  behavior is unchanged. The filter is applied after Tauri 2.12's complete upstream list,
  which preserves `src/bin` when a pathless `[[bin]]` exists and does not re-add bins disabled
  by `required-features`. The two new upstream fixtures omit `default-run`; the fork adds
  `get_binaries_only_keeps_default_run_for_multiple_bins` as its dedicated regression test.
- `0009-tauri-config-bins-compile-list.patch` — adds a top-level `bins: string[]` config
  (field on tauri-utils `Config`, embedded as `None` at runtime; the struct is
  `deny_unknown_fields`, so configs using `bins` require this patch to parse). Also updates
  the CLI-embedded `crates/tauri-cli/config.schema.json` (and the identical
  `tauri-schema-generator/schemas/` copy) — the CLI validates `tauri.conf.json` against that
  JSON schema before deserializing, so without the schema hunk it rejects `bins` with
  "Additional properties are not allowed". Desktop
  `tauri build` no longer passes `--bins` to cargo: it passes one `--bin <name>` per
  configured entry; with no `bins` config it falls
  back to the `get_binaries()` bundle list (i.e. only the default-run binary after 0008),
  and to upstream `--bins` if that list is empty. On Windows the configured auxiliary bins
  are additionally added to the bundle as non-main binaries, so NSIS installs them next to
  the main exe and deletes them on uninstall (no resources staging / installer-hook moves).
  Mobile is untouched (`--lib`); `tauri dev` (cargo run) does not use this path. Known
  limitation: existing `--bin` values in `build.runner.args` are not deduplicated; kabegame
  does not configure a runner, so this does not affect its builds.

`tauri-utils` (library, consumed via `[patch.crates-io]`):

- `0007-tauri-utils-skip-empty-glob-resources.patch` — empty glob resource patterns (e.g.
  `resources/**/*` when the `resources/` directory does not exist) are silently skipped
  instead of failing the build with `GlobPathNotFound`. Allows builds where optional resource
  directories are absent.

`tauri-runtime` (library, consumed via `[patch.crates-io]`):

- `0006-tauri-runtime-optional-webkit.patch` — makes `webkit2gtk` optional behind a new
  `webkit` feature and gates the Linux/BSD `webkit2gtk::WebView` fields in `webview.rs` behind
  it, so the Linux CEF build does not link `webkit2gtk`. `tauri-runtime-wry` explicitly enables
  `tauri-runtime/webkit` on Linux/BSD, keeping the upstream wry runtime buildable in the
  monorepo while custom runtimes can leave WebKit disabled.

`tauri` (library, consumed via `[patch.crates-io]`):

- `0010-tauri-mobile-unregistered-response-channel.patch` — on mobile every `Channel` is put into
  the global `CHANNELS` table (`plugin/mobile.rs`) so native plugins can push to it by id, and
  that table is never pruned. `Channel::from_callback_fn` builds a one-shot channel for the
  response of **every** IPC call, so each invoke leaked one entry plus the `Webview` it
  captures (measured on Android: +101 entries for 100 invokes). The patch adds a private
  `Channel::new_unregistered` and uses it for these response channels only; channels created by
  `channel_on` / `Channel::new` (the ones native plugins look up) are still registered.
  Re-check on bump: `ipc/channel.rs` `new_with_id` / `from_callback_fn`.
- `0011-tauri-webview-clear-js-listeners.patch` — JS event listeners (`plugin:event|listen`) are
  tracked per webview label and only dropped when the webview is destroyed, so navigating a
  long-lived webview to another document keeps the old document's listeners and every later
  matching event is still `eval`-ed into the new document. The patch makes
  `Listeners::remove_webview_js_listeners` `pub(crate)` and adds public
  `Webview::clear_js_listeners()` / `WebviewWindow::clear_js_listeners()` (Rust-side `listen`
  handlers are untouched). Kabegame calls it after the wallpaper window navigates between the
  app page and a WPE web wallpaper's `file://` entry (`wallpaper/window.rs` `show_web` /
  `show_app`). Re-check on bump: `event/listener.rs` `remove_webview_js_listeners`.
- `0012-tauri-ipc-origin-referrer-policy.patch` — the custom-protocol IPC `fetch` in
  `scripts/ipc-protocol.js` gets `referrerPolicy: 'origin'`. The `ipc` handler rejects a request
  whose `Origin` header does not parse as a URL (`parse_invoke_request`, HTTP 500 "Origin header
  is not a valid URL"). Chromium-based webviews send `Origin: null` under `no-referrer`; platforms
  using the `http://ipc.localhost` workaround also do so for an https-to-http downgrade under
  the default `strict-origin-when-cross-origin` policy. The 500 resolves the `fetch`, so the script
  never falls back to `postMessage` and every invoke from such a page fails. With `origin` the
  document's origin is always sent (verified in CEF: default / `no-referrer` → 500, `origin` /
  `unsafe-url` → 200). Opaque origins (`file:`, sandboxed frames) still send `null`; the CEF
  runtime rewrites `file:` frames itself. The CEF runtime's `cef-ipc` postMessage shim
  (`tauri-runtime-cef/src/ipc.rs`) sets the same policy. Re-check on bump:
  `scripts/ipc-protocol.js` `fetch(...convertFileSrc(cmd, 'ipc'), {...})`.
- `0013-tauri-windows-native-custom-protocol.patch` — Windows uses native
  `tauri://localhost` and `ipc://localhost` with Kabegame's CEF runtime. The four Rust
  URL branches (`protocol::origin`, `window_origin`, isolation `frame-src`, and
  `is_local_url`) keep the HTTP localhost workaround only on Android; `core.js`
  `convertFileSrc` does the same. `use_https_scheme` has no effect on Windows.
  A Tauri tree with this patch cannot use the Windows wry/WebView2 runtime.
  Re-check these five anchors when updating Tauri.

Apply the whole series manually before building against `third/tauri`:

```bash
deno task patch tauri
```

The patch manager uses a **reset model**, so the series is *not* append-only: patches may be
edited, deleted or renumbered freely ([`third-patches/AGENTS.md`](../AGENTS.md)). Applying
resets the submodule to its clean pinned baseline and replays the whole series in filename
order; `-r` just resets. Re-running is therefore idempotent — after a pull that changes any
patch, plain `deno task patch tauri` resyncs (the `.husky/post-merge` hook does this
automatically).

The `.husky/post-merge` hook detects newly added `third-patches/*/*.patch` after a pull and
runs this automatically.

## Consumption (root `Cargo.toml`)

The whole tauri stack is `[patch.crates-io]`-pointed at `third/tauri/crates/*`
(`tauri`, `tauri-runtime`, `tauri-runtime-wry`, `tauri-utils`, `tauri-macros`,
`tauri-codegen`, `tauri-build`) so the submodule is the single source of truth — a bump
is just a submodule bump + this series, with no registry version to keep in sync.
`tauri-plugin` is intentionally **not** patched (the tag's 2.7.2 leads crates.io's 2.5.3, so
cargo would flag the patch unused; it only depends on tauri/tauri-utils, so no type boundary),
and `Cargo.lock` pins `tauri-utils` to `2.10.2` (the monorepo version, satisfies every `^2.x`
requirement) so the path patch unifies the whole graph on one `tauri-utils`.

`tauri-cli` is built by `TauriCliPlugin` via `--manifest-path third/tauri/crates/tauri-cli`
(output in the monorepo workspace `third/tauri/target/release/cargo-tauri`); it is not part of
`[patch.crates-io]`.

## Re-vendor

1. `deno task patch tauri -r` to restore the clean submodule tree.
2. Bump `third/tauri` to the new upstream tag (pick one whose `tauri`/`tauri-runtime` match
   the version the app resolves).
3. Re-apply each patch with `git apply --check`, repairing context drift (see the drift-prone
   anchors listed in [cocs/tauri/TAURI_CLI_FORK.md](../../cocs/tauri/TAURI_CLI_FORK.md)).
4. Regenerate the numbered patch files against the new base and update this README.
5. Re-pin `tauri-utils` in `Cargo.lock` (`cargo update -p tauri-utils --precise <monorepo ver>`)
   if the tag's version differs from crates.io's latest.
