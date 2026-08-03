# CEF patches

## Upstream

- Repository: <https://github.com/chromiumembedded/cef.git>
- Vendor base: `0d0eeb61160536e447c79335c1ee963f57eb6d60` (branch `7827`)

## Patches

- `0001-flat-subprocess-path.patch` — honors an explicit browser subprocess path for every child process type, allowing Kabegame to use one flat helper executable on all desktop platforms.
- `0002-drag-drop-client-events.patch` — extends `CefDragHandler` with `OnDragOver` / `OnDragLeave` / `OnDrop` (all `added=experimental`) so a client can observe a full external drag sequence and consume the drop. Without this, CEF only exposes `OnDragEnter`, whose sole power is cancelling the whole drag — leaving no way to get a drop notification and suppress Chromium's default handling (navigating to the dropped file). Wiring:
  - `AlloyBrowserHostImpl` overrides `content::WebContentsDelegate::PreHandleDragUpdate` / `PreHandleDragExit` → `OnDragOver` / `OnDragLeave`. The update notification carries no operations mask, so the mask captured in `CanDragEnter` is remembered in `current_drag_operations_mask_`.
  - `ChromeWebContentsViewDelegateCef` overrides `OnPerformingDrop` → `OnDrop`; returning true runs the completion callback with `std::nullopt`, which aborts the drop before it reaches the renderer. This is the equivalent of wry's `performDragOperation` returning `YES` without calling `super`.

  Scope note: `OnDrop` rides on `WebContentsViewDelegate`, which is not created for windowless (OSR) browsers — see the comment in `CefBrowserPlatformDelegateAlloy::AttachHelpers`. Kabegame uses windowed CEF Views browsers, so this is not a limitation in practice, but an OSR embedder would still get `OnDragEnter`/`OnDragOver`/`OnDragLeave` and no `OnDrop`.

  The generated C API, `libcef_dll` cpptoc/ctocpp glue and API hashes are **not** part of this patch — they are produced by `tools/version_manager.py` during `cef_create_projects.sh`, which `scripts/build-chromium.sh` runs.

Apply this series manually before running CEF's `patcher.py`:

```bash
deno task patch cef
```

## Re-vendor

1. Run `deno task patch cef -r` to restore the clean vendor tree.
2. Update `third/cef` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
