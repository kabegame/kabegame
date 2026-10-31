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

- `01-tauri-cli-android-package-decouple.patch` — `TAURI_ANDROID_PACKAGE` env decouples the
  Android Java package (source dir / generated Kotlin package / JNI) from `identifier`
  (applicationId). Touches `mobile/mod.rs` (`ensure_init` java-folder), `mobile/android/mod.rs`
  (`android_package`/`get_config`), and `mobile/android/{dev,run}.rs` (fully-qualified
  `{android_package}.MainActivity` for auto-launch).
- `02-tauri-cli-no-webkit-deps.patch` — `TAURI_NO_WEBKIT_DEPS` skips the deb/rpm
  `libwebkit2gtk` dependency injection (kabegame bundles CEF) and dedups `depends_deb`/`depends_rpm`.
- `03-tauri-cli-icns-inset.patch` — macOS `.icns` gets dock inset padding
  (`resize_exact_inset` + `MACOS_ICON_CONTENT_SCALE`); `.ico`/png/android stay full-frame.
- `04-tauri-cli-android-check-subcommand.patch` — adds `tauri android check`
  (`mobile/android/check.rs` + dispatch) for a fast `cargo check --target aarch64-linux-android`
  reusing cargo-mobile2's NDK toolchain; no APK/AAB, no frontend.
- `05-tauri-cli-android-dev-localhost.patch` — a physical device no longer forces the LAN IP;
  a localhost devUrl is kept so `adb reverse` tunnels HTTP + HMR WebSocket over USB loopback.
- `08-tauri-cli-bundle-only-default-run.patch` — when `get_binaries` collects more than one
  binary and `default-run` is declared, only the `default-run` (main) binary is auto-bundled
  into install dirs (`/usr/bin`, .app, NSIS). Auxiliary `[[bin]]`/`src/bin/` targets
  (`kabegame-cef-helper`, `cef-example`) must be shipped explicitly via bundle `files`
  (deb files / `macOS.files`). Without `default-run` (or with a single bin) upstream
  behavior is unchanged. The filter is applied after Tauri 2.12's complete upstream list,
  which preserves `src/bin` when a pathless `[[bin]]` exists and does not re-add bins disabled
  by `required-features`. The two new upstream fixtures omit `default-run`; the fork adds
  `get_binaries_only_keeps_default_run_for_multiple_bins` as its dedicated regression test.
- `09-tauri-config-bins-compile-list.patch` — adds a top-level `bins: string[]` config
  (field on tauri-utils `Config`, embedded as `None` at runtime; the struct is
  `deny_unknown_fields`, so configs using `bins` require this patch to parse). Also updates
  the CLI-embedded `crates/tauri-cli/config.schema.json` (and the identical
  `tauri-schema-generator/schemas/` copy) — the CLI validates `tauri.conf.json` against that
  JSON schema before deserializing, so without the schema hunk it rejects `bins` with
  "Additional properties are not allowed". Desktop
  `tauri build` no longer passes `--bins` to cargo: it passes one `--bin <name>` per
  configured entry; with no `bins` config it falls
  back to the `get_binaries()` bundle list (i.e. only the default-run binary after 08),
  and to upstream `--bins` if that list is empty. On Windows the configured auxiliary bins
  are additionally added to the bundle as non-main binaries, so NSIS installs them next to
  the main exe and deletes them on uninstall (no resources staging / installer-hook moves).
  Mobile is untouched (`--lib`); `tauri dev` (cargo run) does not use this path. Known
  limitation: existing `--bin` values in `build.runner.args` are not deduplicated; kabegame
  does not configure a runner, so this does not affect its builds. The patch also adds
  `bins: None` to the `Config` literal of `crates/tauri/src/test/mod.rs` (`mock_context`);
  without it `cargo test -p tauri` does not compile.

`tauri-utils` (library, consumed via `[patch.crates-io]`):

- `07-tauri-utils-skip-empty-glob-resources.patch` — empty glob resource patterns (e.g.
  `resources/**/*` when the `resources/` directory does not exist) are silently skipped
  instead of failing the build with `GlobPathNotFound`. Allows builds where optional resource
  directories are absent.

`tauri-runtime` (library, consumed via `[patch.crates-io]`):

- `06-tauri-runtime-optional-webkit.patch` — makes `webkit2gtk` optional behind a new
  `webkit` feature and gates the Linux/BSD `webkit2gtk::WebView` fields in `webview.rs` behind
  it, so the Linux CEF build does not link `webkit2gtk`. `tauri-runtime-wry` explicitly enables
  `tauri-runtime/webkit` on Linux/BSD, keeping the upstream wry runtime buildable in the
  monorepo while custom runtimes can leave WebKit disabled.

`tauri` (library, consumed via `[patch.crates-io]`):

- `10-tauri-mobile-unregistered-response-channel.patch` — on mobile every `Channel` is put into
  the global `CHANNELS` table (`plugin/mobile.rs`) so native plugins can push to it by id, and
  that table is never pruned. `Channel::from_callback_fn` builds a one-shot channel for the
  response of **every** IPC call, so each invoke leaked one entry plus the `Webview` it
  captures (measured on Android: +101 entries for 100 invokes). The patch adds a private
  `Channel::new_unregistered` and uses it for these response channels only; channels created by
  `channel_on` / `Channel::new` (the ones native plugins look up) are still registered.
  Re-check on bump: `ipc/channel.rs` `new_with_id` / `from_callback_fn`.
- `11-tauri-webview-clear-js-listeners.patch` — JS event listeners (`plugin:event|listen`) are
  tracked per webview label and only dropped when the webview is destroyed, so navigating a
  long-lived webview to another document keeps the old document's listeners and every later
  matching event is still `eval`-ed into the new document. The patch makes
  `Listeners::remove_webview_js_listeners` `pub(crate)` and adds public
  `Webview::clear_js_listeners()` / `WebviewWindow::clear_js_listeners()` (Rust-side `listen`
  handlers are untouched). Kabegame calls it after the wallpaper window's ping watchdog reloads
  the page (`wallpaper/window.rs`); since 18 web wallpapers are iframes and the wallpaper window no
  longer navigates (a subframe's listeners go with `SubframeDestroyed`). It drops the listeners of
  every frame of the webview. Re-check on bump: `event/listener.rs` `remove_webview_js_listeners`.
- `12-tauri-ipc-origin-referrer-policy.patch` — the custom-protocol IPC `fetch` in
  `scripts/ipc-protocol.js` gets `referrerPolicy: 'origin'`. The `ipc` handler rejects a request
  whose `Origin` header does not parse as a URL (`parse_invoke_request`, HTTP 500 "Origin header
  is not a valid URL"). Chromium-based webviews send `Origin: null` under `no-referrer`; platforms
  using the `http://ipc.localhost` workaround also do so for an https-to-http downgrade under
  the default `strict-origin-when-cross-origin` policy. The 500 resolves the `fetch`, so the script
  never falls back to `postMessage` and every invoke from such a page fails. With `origin` the
  document's origin is always sent (verified in CEF: default / `no-referrer` → 500, `origin` /
  `unsafe-url` → 200). Opaque origins (`file:`, sandboxed frames) still send `null`; the CEF
  runtime rewrites `file:` frames itself. The CEF runtime's `cef-ipc` postMessage shim
  (`tauri-runtime-kbcef/src/ipc.rs`) sets the same policy. Re-check on bump:
  `scripts/ipc-protocol.js` `fetch(...convertFileSrc(cmd, 'ipc'), {...})`.
- `13-tauri-windows-native-custom-protocol.patch` — Windows uses native
  `tauri://localhost` and `ipc://localhost` with Kabegame's CEF runtime. The four Rust
  URL branches (`protocol::origin`, `window_origin`, isolation `frame-src`, and
  `is_local_url`) keep the HTTP localhost workaround only on Android; `core.js`
  `convertFileSrc` does the same. `use_https_scheme` has no effect on Windows.
  A Tauri tree with this patch cannot use the Windows wry/WebView2 runtime.
  Re-check these five anchors when updating Tauri.

14–17 make both directions of the event system and the ACL depend only on what the backend
knows about the caller (webview label, origin, frame), never on parameters sent from JS. Design
and app usage: [cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md](../../cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md).

- `14-tauri-event-receiver-identity.patch` — JS event delivery is decided by who the receiving
  webview is. Upstream stores the `target` each JS `listen` sends (default `Any`) and
  `emit_js_filter` matches the `emit_to` filter against it, letting every `Any` listener bypass
  `emit_to` (two surf navbars received each other's URL). Now `js_event_listeners` keeps only
  `HashSet<EventId>` per webview label and event; `emit_js_filter` keeps the webviews whose
  `receiver_identities` (`Webview{label}`, `Window{window label}`, plus `WebviewWindow{label}`
  when both labels are equal) satisfy the filter, computed before locking the JS listeners
  (`window_label()` locks the webview's window while the caller holds the webviews lock, the
  same order as `Window::webviews()`). The `listen` command no longer takes `target` (the JS API
  still sends it; extra keys are ignored) and `listen_js_script` no longer writes it.
  `unlisten_js(webview_label, ..)` only touches the caller's own listeners (ids are a guessable
  global counter). `Window::has_js_listener` (close-request interception) counts any JS listener
  in any webview of the window (`Listeners::has_js_listener_in`). Rust-side handlers keep
  `match_any_or_filter` unchanged. Effects: `emit_to(App)` no longer reaches JS; a webview also
  receives `Window{its window}` events. Tests: `event::listener` (cross-webview unlisten,
  identities), `manager::test::js_emit_to_uses_receiver_identity`,
  `manager::window::tests`. Re-check on bump: `event/listener.rs` `emit_js_filter` /
  `listen_js` / `unlisten_js`, `event/plugin.rs` `listen`, `manager/window.rs` `has_js_listener`,
  `manager/mod.rs` `emit_to` `filter_target`, `event/mod.rs` `listen_js_script`.
- `15-tauri-event-listen-scope.patch` — `listen` takes `CommandScope<ListenScope>`
  (`tauri::ListenScope { event }`, exported at the crate root; trailing `*` = prefix match) and
  rejects event names the scope does not match with
  ``event `<name>` is not allowed to be listened by ACL``. Capabilities restrict it with
  `{ "identifier": "core:event:allow-listen", "allow": [{ "event": "…" }], "deny": [...] }`;
  core permissions have no scope schema, so tauri-build accepts any JSON there. Usual
  `CommandScope` semantics: deny first, and once any applicable grant carries an allow scope the
  name must match one; grants without a scope do not restrict. Tests: `event::plugin::tests`
  (end-to-end through `on_message` with a mock ACL). Re-check on bump: `event/plugin.rs` `listen`.
- `16-tauri-acl-frame.patch` — adds the frame as an ACL dimension. `tauri_runtime::webview::IpcFrame`
  (`Main` default / `Sub` / `Unknown`, re-exported as `tauri::webview::IpcFrame`) is put by the runtime
  into the `http::Request` extensions (pages cannot forge extensions, unlike headers); `InvokeRequest`
  gets `frame`, read in `ipc/protocol.rs` (`parse_invoke_request` and `handle_ipc_message`,
  `request_frame`), missing = `Main`. `tauri_utils::acl::capability::CapabilityFrames`
  (`main` default / `sub` / `any`) is a new `Capability.frames` field (omitted when `main`),
  copied into `ResolvedCommand.frames` (`ResolvedCommand::new` and both `ToTokens` impls gain it);
  `RuntimeAuthority::resolve_access(.., frame)` requires `frames_match`, denies ignore the frame.
  `resolve_command_scope` passes `Main`; the debug rejection message names the caller's frame and
  prints `frames: sub|any` for non-main grants. Other `Capability` literals updated:
  `ipc/capability_builder.rs` (new `.frames()`), `tauri-cli` `acl/capability/new.rs` and
  `migrate/migrations/v1/config.rs`. Upstream's checked-in schemas are not regenerated (apps get
  the field in their build-time `gen/schemas`). Tests: `tauri-utils` `acl::capability` /
  `acl::resolved`, `ipc::authority` (frames table, filtering, deny on every frame),
  `ipc::protocol`, `event::plugin` (subframe rejected). Re-check on bump: `Capability` /
  `ResolvedCommand` fields and `ToTokens`, `resolve_access`, `InvokeRequest`, every
  `InvokeRequest { .. }` / `Capability { .. }` literal.
- `17-tauri-acl-exempt-webview.patch` — `Builder::acl_exempt_webview(label)` (stored on the
  builder, applied to `context.runtime_authority_mut()` in `build`) →
  `RuntimeAuthority::exempt_webview` / `is_exempt(webview, origin, frame)`: exact label, local origin
  **and** main frame. `on_message` still resolves the ACL (granted command scopes still reach
  commands) but does not reject an exempt request, explicit denies included; it sets the
  crate-private `InvokeMessage.acl_exempt`, read by the crate-only command argument
  `ipc::AclExempt`, so `listen` skips the `ListenScope` check. Navigating the webview to remote or
  `file:` content, or calling from a subframe, falls back to the capabilities. Tests:
  `ipc::authority::tests::exemption_needs_label_local_origin_and_main_frame`,
  `event::plugin::tests::exempt_*`. Re-check on bump: `webview/mod.rs` `on_message` rejection
  condition, `app.rs` `Builder::build`, `ipc/mod.rs` `InvokeMessage`.

The CEF runtime side (`src-tauri/tauri-runtime-kbcef`, not a patch) inserts `IpcFrame` on every
custom-protocol request (`protocol::attach_request_frame`; no CEF frame → `Unknown`) and carries
it through the rebuilt `cef-ipc` fallback request (`ipc::post_message_request`).

18–19 make the frame the unit of IPC: subframes get Tauri's bridge, and everything Tauri sends
back to a page (listener registrations, events, channel messages, postMessage responses) goes to
the frame that made the call. Design and app usage: the "子 frame IPC" section of
[cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md](../../cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md).

- `18-tauri-frame-scoped-ipc.patch` — frame-scoped delivery. tauri-runtime:
  `webview::SubframeId(Arc<str>)` (opaque, runtime-defined, re-exported as `tauri::webview::SubframeId`)
  travels in the request extensions next to `IpcFrame`, subframe requests only;
  `WebviewDispatch::eval_script_in_subframe` (default: `Error::SubframeEvalUnsupported`, so wry is
  untouched); `window::WebviewEvent::SubframeDestroyed(SubframeId)` (also on tauri's public
  `WebviewEvent`, `app.rs` `From`). tauri: `InvokeRequest.subframe_id` (read in
  `ipc/protocol.rs` `request_subframe_id`, only kept for `IpcFrame::Sub`); crate-private
  `webview::FrameAddress { Main, Sub(SubframeId) }` with `FrameAddress::of_caller` (`Unknown` and a
  subframe without id → `None`) and `Webview::eval_in_frame` (main frame keeps `eval`, addressed
  through the webview because a runtime may renumber it on cross-origin navigation).
  `on_message` stores `InvokeMessage.caller_address` and `caller_origin` (the ACL origin, i.e. the
  request `Origin`). Command arguments: crate-only `ipc::CallerFrameAddress`, public
  `ipc::CallerOrigin(Url)`. `js_event_listeners` is keyed webview → frame → event;
  `listen` / `unlisten` take `CallerFrameAddress` (an unaddressable caller cannot listen; unlisten
  only touches the caller frame's table), `listen_js` evals the registration into the caller frame,
  `emit_js_filter` keeps the 14 receiver check and delivers per frame (`emit_js_to_frame`).
  `remove_subframe_js_listeners` runs on `SubframeDestroyed` (`manager/webview.rs`
  `on_webview_event`, which also drops that frame's queued channel data); `clear_js_listeners`
  still drops every frame of the webview. Close-request interception only counts main-frame
  listeners (`has_main_frame_js_listener_in`, renamed from `has_js_listener_in`). `Channel` as a
  command argument is created for the caller frame (`channel_on_frame`; no address → error);
  public `JavaScriptChannelId::channel_on` keeps meaning the main frame; `from_callback_fn` and
  the postMessage `responder_eval` take the address (unaddressable caller → response dropped; such
  requests only use the fetch path). `ChannelDataIpcQueue` entries remember their frame and
  `plugin:__TAURI_CHANNEL__|fetch` (the one command that skips the ACL) takes
  `CallerFrameAddress`: another frame guessing the sequential id gets "data not found".
  Mock runtime: `MockWebviewDispatcher` records every eval with its target frame
  (`evaluated_scripts`) and keeps webview event listeners (`emit_webview_event`). Tests:
  `event::listener::test::js_listeners_are_scoped_per_frame`,
  `event::plugin::tests::{listen_needs_an_addressable_frame, subframe_listeners_are_registered_and_delivered_in_their_frame, subframe_cannot_unlisten_another_frames_listener}`,
  `ipc::channel::tests::{queue_entries_are_scoped_to_the_owning_frame, purge_removes_only_the_destroyed_frame_entries, subframe_channel_is_delivered_and_fetched_by_its_frame_only}`,
  `ipc::protocol::tests::{subframe_id_is_only_kept_for_subframes, caller_address_follows_frame_and_id, post_message_responses_go_back_to_the_calling_frame, caller_origin_is_the_request_origin}`,
  `manager::window::tests`. Re-check on bump: every `InvokeRequest { .. }` literal,
  `webview/mod.rs` `on_message` / `listen_js` / `unlisten_js`, `event/listener.rs`
  `emit_js_filter`, `ipc/channel.rs` `channel_on` / `from_callback_fn` / `fetch` / `CommandArg`,
  `ipc/protocol.rs` `handle_ipc_message` responder, `manager/window.rs` `has_js_listener`, the
  exhaustive matches on `WebviewEvent`.
- `19-tauri-subframe-ipc-injection.patch` — the bridge for subframes. tauri-runtime:
  `WebviewAttributes.subframe_bridge_scripts: Vec<String>`. `manager/webview.rs`
  `prepare_pending_webview` builds Tauri's four bridge scripts (`isTauri` / internals, invoke
  script, metadata, `init.js`) once, keeps adding them as main-frame-only initialization scripts and
  hands the same strings to the runtime. A runtime that reports `IpcFrame` / `SubframeId` injects them
  into **every** subframe before its other scripts (the ACL is the only gate); a runtime that does not
  (wry) must ignore them, since its requests count as the main frame. Plugin scripts and the
  isolation pattern stay out. Test: `manager::webview::tests::subframe_bridge_scripts_are_the_main_frame_bridge`.
  Re-check on bump: the script list in `prepare_pending_webview`, `WebviewAttributes::new`.

The CEF runtime side of 18–19 (not a patch): `protocol::attach_request_frame` also inserts
`SubframeId(frame.identifier())` for subframes, `ipc::post_message_request` carries it and accepts
every request CEF attributes to a frame (the ACL decides), `WebviewMessage::EvalInSubframe` resolves
the frame with `frame_by_identifier`, a `FrameHandler` reports `on_frame_destroyed` for non-main
frames, and the renderer (`subprocess.rs`) evals `subframe_bridge_scripts` (key
`kabegame.subframe_bridge_scripts.v1` in `extra_info`) first in every subframe.

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
