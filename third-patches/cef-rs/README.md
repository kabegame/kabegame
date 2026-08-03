# cef-rs patches

## Upstream

- Repository: <https://github.com/tauri-apps/cef-rs.git>
- Vendor base: `ed6cd5b` (`get latest (#418)`, reachable from branch `149-wrapper-path`)

## Patches

- `0001-direct-link-cef-framework-macos.patch` — direct-links the CEF framework on macOS (adds `sys/src/direct_link_loader_stubs.rs`, wires it in `sys/src/lib.rs`, and reworks the `sys/build.rs` link search so the flat framework layout resolves without the loader shim).
- `0002-recreate-env-gate.patch` — restores the `CEF_PATH`/env-driven gate in `sys/build.rs` for locating the prebuilt CEF distribution.
- `0003-drag-handler-bindings-macos.patch` — regenerated macOS bindings carrying the three `CefDragHandler` callbacks (`on_drag_over` / `on_drag_leave` / `on_drop`) added by `third-patches/cef/0002-drag-drop-client-events.patch`. Touches `{cef,sys}/src/bindings/{aarch64,x86_64}_apple_darwin.rs` only.

  These bindings **must** live in the patch series rather than being reproduced by a command: `sys/src/bindings/*.rs` are checked-in sources that `[patch.crates-io] cef = { path = "third/cef-rs/cef" }` compiles directly, so without this patch the safe wrapper has no such callbacks and `tauri-runtime-cef` fails to build. (Contrast with `third-patches/cef`, whose generated capi/`libcef_dll` glue is produced at build time by `version_manager.py` and therefore stays out of its series.)

  **Linux and Windows bindings are not regenerated yet.** `cargo run -p update-bindings -- --bindgen --target <triple>` needs each platform's sysroot plus a CEF built with the `third-patches/cef` series applied, so it has to run natively on those hosts. Until then `tauri-runtime-cef` only builds on macOS. Append the result as a new numbered patch — do not edit this one (see `.cursor/rules/third-patches-append-only.mdc`).

Apply this series manually before building against `third/cef-rs`:

```bash
deno task patch cef-rs
```

## Re-vendor

1. Run `deno task patch cef-rs -r` to restore the clean vendor tree.
2. Update `third/cef-rs` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
