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

  The generated C API, `libcef_dll` cpptoc/ctocpp glue and API hashes are **not** part of this patch — they are produced by `tools/version_manager.py` during `cef_create_projects.sh`, which `scripts/build-chromium.ts` runs.

- `0003-drag-source-filenames.patch` — lets a CEF client turn a renderer-initiated drag into a drag of real local files, on Linux and macOS. Chromium always clears renderer-supplied `DropData::filenames`, so the patch adds a `WebContentsViewDelegate::GetDragFilenames` hook before the platform drag payload is built. CEF exposes that hook through `CefDragHandler::OnStartDragging`, and adds `CefDragData::GetCustomData` so the client can inspect custom formats set by `DataTransfer.setData()` before adding authorized local paths.

  The two platforms need different amounts of Chromium-side work. On Linux the payload is pushed into an `OSExchangeDataProvider` up front, so `WebContentsViewAura::StartDragging` only has to swap in the filenames. macOS pulls instead: `WebContentsViewMac::StartDragging` forwards `DropData` over mojo to `WebDragSource`, an `NSPasteboardWriting` object that answers flavor requests lazily — and it had no filenames path at all, so the patch also teaches it to advertise and serve `NSPasteboardTypeFileURL`. `filenames` needs no mojo change: `IPC_STRUCT_TRAITS_MEMBER(filenames)` already carries it. macOS additionally has to clear `download_metadata` and `html`, which Linux ignores but `WebDragSource` would turn into a promised-file flavor and a `public.html` flavor.

  macOS also has to drop the renderer taint. Linux keeps it in a member of `OSExchangeDataProviderNonBacked` that never crosses a process boundary; macOS writes it onto the pasteboard as `org.chromium.renderer-initiated-drag`, where a receiving Chromium reads it back as `DropData::did_originate_from_renderer` and `FilterDropData()` then drops every filename. Left on, the file reaches native apps but is invisible to Chrome, to every Electron app and to the embedder's own webview. The patch therefore stops advertising that flavor once the delegate has vouched for local files — the paths are not renderer data, and every renderer-authored payload is cleared alongside them.

  The Chromium-side patch (`patch/patches/kabegame_drag_source_filenames.patch` plus its `patch.cfg` entry) and the CEF-side API changes are two halves of the same feature and must be added or removed together.

  The generated C API, `libcef_dll` cpptoc/ctocpp glue and API hashes are **not** part of this patch — they are produced by `tools/version_manager.py` during `cef_create_projects.sh`, which `scripts/build-chromium.ts` runs.

Apply this series manually before running CEF's `patcher.py`:

```bash
deno task patch cef
```

## Re-vendor

1. Run `deno task patch cef -r` to restore the clean vendor tree.
2. Update `third/cef` to the desired commit from the upstream repository.
3. Apply each patch with `git apply --check`, repairing context drift as needed.
4. Regenerate the numbered patch files against the new vendor base and update this README.
