# cef-rs patches

## Upstream

- Repository: <https://github.com/tauri-apps/cef-rs.git>
- Vendor base: `b84b7ca` (tag `cef-v156.6.0+156.0.30`, branch `dev`). Its bindings were generated from CEF `156.0.30+g6028375+chromium-156.0.8078.96`, the same commit `third/cef` is pinned to.
- The former base followed `149-wrapper-path` for `CEF_RS_LIBCEF_DLL_WRAPPER_PATH`; Kabegame never used that variable, so the M156 re-vendor moved to upstream `dev`.

## Patches

- `01-direct-link-cef-framework-macos.patch` — direct-links the CEF framework on macOS (adds `sys/src/direct_link_loader_stubs.rs`, wires it in `sys/src/lib.rs`, and replaces the macOS arm of `sys/build.rs`: no `libcef_dll_wrapper` build, link the framework, keep a `target/Frameworks` symlink for running the dev executable without an app bundle). Since 156 upstream builds the wrapper with an explicit `CEF_API_VERSION` (the last numbered version); that only affects the C++ wrapper, which macOS no longer links. The experimental struct members added by `third-patches/cef` are still filled in by libcef, because CEF gates unversioned classes at libcef compile time (`#if CEF_API_ADDED(CEF_EXPERIMENTAL)`), not by the runtime `cef_api_version()`.
- `02-recreate-env-gate.patch` — comments out the automatic CEF download in `sys/build.rs` (including the `NIX_CEF_BINARY` branch added upstream in 156), and lets only an explicitly configured CEF (`CEF_PATH` / `FLATPAK`) re-point an existing `target/Frameworks` symlink.
- `03-drag-handler-bindings-macos.patch` — regenerated macOS bindings carrying the three `CefDragHandler` callbacks (`on_drag_over` / `on_drag_leave` / `on_drop`) added by `third-patches/cef/02-drag-drop-client-events.patch`. Touches `{cef,sys}/src/bindings/{aarch64,x86_64}_apple_darwin.rs` only. (Under 149 this patch also bumped the `CEF_VERSION*` constants to our own build; the 156 base already carries the matching version, so that hunk is gone.)

  These bindings **must** live in the patch series rather than being reproduced by a command: `sys/src/bindings/*.rs` are checked-in sources that `[patch.crates-io] cef = { path = "third/cef-rs/cef" }` compiles directly, so without this patch the safe wrapper has no such callbacks and `tauri-runtime-kbcef` fails to build. (Contrast with `third-patches/cef`, whose generated capi/`libcef_dll` glue is produced at build time by `version_manager.py` and therefore stays out of its series.)

- `04-drag-handler-bindings-linux.patch` — the same three `CefDragHandler` callbacks for `{cef,sys}/src/bindings/x86_64_unknown_linux_gnu.rs`. **Not** regenerated via `update-bindings --bindgen`; hand-transcribed from `03`, which is exact because `_cef_drag_handler_t` is a table of `Option<extern "C" fn>` pointers and the safe wrappers are platform-independent Rust — so the x86_64 struct layout (fields at 56/64/72, size 80) and wrapper bodies are byte-for-byte identical to the darwin patch. Verified by a clean `cargo check` on x86_64 Linux against a CEF built with the `third-patches/cef` series.
- `05-drag-handler-bindings-windows.patch` — same change for `{cef,sys}/src/bindings/x86_64_pc_windows_msvc.rs`, hand-transcribed the same way. x86_64 MSVC shares the identical struct layout, so it is a byte-for-byte copy of the linux/darwin additions. Not yet compile-verified natively (no MSVC host here); build on Windows to confirm.
- `06-drag-source-bindings-linux.patch` — adds the Linux bindings for `CefDragHandler::OnStartDragging` and `CefDragData::GetCustomData`, including the safe wrapper methods. The generated C layout is authoritative: `_cef_drag_handler_t::on_start_dragging` is at offset 80 (size 88), and `_cef_drag_data_t::get_custom_data` is at offset 256 (size 264).
- `07-drag-source-bindings-windows.patch` — the same drag-source bindings and verified C layout for `x86_64_pc_windows_msvc`.
- `08-drag-source-bindings-macos.patch` — the same drag-source bindings and verified C layout for both `aarch64_apple_darwin` and `x86_64_apple_darwin`.

- `09-frame-mouse-injection-bindings.patch` — bindings for the three `CefFrame` methods added by `third-patches/cef/11-frame-mouse-injection.patch` (`convert_point_from_view`, `send_mouse_move_event_to_frame`, `send_mouse_click_event_to_frame`), for `x86_64_pc_windows_msvc`, `x86_64_unknown_linux_gnu`, `x86_64_apple_darwin` and `aarch64_apple_darwin` in one patch. Hand-written like 04–08: experimental methods are ordered last in the generated C struct, so `_cef_frame_t` grows from 248 to 272 bytes with the new fields at 248 / 256 / 264 on all four targets (8-byte pointers). `double&` out-params become `*mut f64` / `Option<&mut f64>`, `bool` becomes `c_int`, `uint32_t` becomes `u32`. `_cef_frame_t` is allocated DLL-side, so only the calling wrappers are needed; callers must check `base.size` before using the new fields, because an older libcef allocates the 248-byte struct. The Windows `sys` file is CRLF upstream and keeps its line endings. On the 156 base the `sys` files of all four targets were compiled standalone and every layout assertion for the three extended structs passes (`_cef_drag_handler_t` 88, `_cef_drag_data_t` 264, `_cef_frame_t` 272); the Windows file's only failures there come from the host's 8-byte `c_long` and also occur on the unpatched upstream file.

  **aarch64 / i686 / arm bindings are still not regenerated.** kabegame does not build those targets (desktop CEF is x86_64-only; Android has no CEF backend), so `tauri-runtime-kbcef` compiles on the three x86_64 desktop platforms. To add another target, prefer `cargo run -p update-bindings -- --bindgen --target <triple>` (needs that platform's sysroot plus a CEF built with the `third-patches/cef` series, so it must run natively) and append the result as a new numbered patch. The reset model ([`third-patches/AGENTS.md`](../AGENTS.md)) lets you renumber/rewrite freely; the former append-only rule is retired.

Apply this series manually before building against `third/cef-rs`:

```bash
deno task patch cef-rs
```

## Re-vendor

1. Run `deno task patch cef-rs -r` to restore the clean vendor tree.
2. Update `third/cef-rs` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
