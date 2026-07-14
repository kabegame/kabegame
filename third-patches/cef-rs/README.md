# cef-rs patches

## Upstream

- Repository: <https://github.com/tauri-apps/cef-rs.git>
- Vendor base: `ed6cd5b` (`get latest (#418)`, reachable from branch `149-wrapper-path`)

## Patches

- `0001-direct-link-cef-framework-macos.patch` — direct-links the CEF framework on macOS (adds `sys/src/direct_link_loader_stubs.rs`, wires it in `sys/src/lib.rs`, and reworks the `sys/build.rs` link search so the flat framework layout resolves without the loader shim).
- `0002-recreate-env-gate.patch` — restores the `CEF_PATH`/env-driven gate in `sys/build.rs` for locating the prebuilt CEF distribution.

Apply this series manually before building against `third/cef-rs`:

```bash
bun run patch cef-rs
```

Use `bun run patch`, not `bun patch`: Bun 1.3 provides its own unrelated
dependency-patching subcommand under the latter name.

## Re-vendor

1. Run `bun run patch cef-rs -r` to restore the clean vendor tree.
2. Update `third/cef-rs` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
