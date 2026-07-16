# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Instructions loading (Claude Code memory model)

Per the [Claude Code memory documentation](https://code.claude.com/docs/en/memory), `CLAUDE.md` is project-level persistent context loaded each session. It is guidance, not a separate enforcement layer—keep it accurate, specific, and under ~200 lines when possible; split or use `@path` imports and optional `.claude/rules/` for larger or path-scoped instructions as that doc describes.

## Recommand to read: Cursor rules.

This repository’s **Cursor** constraints live in **`.cursor/rules/`** (`.mdc` files). They are the canonical, always-applied (or path-scoped) rules for work done in Cursor.

**Before making substantive code or config changes:** read the `.mdc` files in `.cursor/rules/` that apply to the areas you edit (or the whole set if scope is unclear). Treat them as mandatory alongside `.claude/rules/` if present.

**When conventions change:** update `.cursor/rules/` and this `CLAUDE.md` together so they do not contradict each other—mirror critical requirements here or in imports, and keep Cursor rules as the source of truth for editor-enforced behavior.

This is a index for code base. Keep in mind to sync these docs when do some changes.
@cocs/README.md 

## What This Project Is

Kabegame is a cross-platform anime wallpaper crawler and manager built with **Tauri 2** (Rust backend) and **Vue 3** (TypeScript frontend). It supports Windows, macOS, Linux, and Android — **not iOS**. Crawler plugins are written in **JavaScript/TypeScript** and run on an embedded V8 (deno_core) backend (or the WebView backend); the legacy Rhai backend has been removed.

## Commands

All top-level commands go through `scripts/run.ts` (a Tapable-based build system) and are run with `deno task` (Deno 2.9.0; after cloning, run `deno install && deno task prepare` first).

### Development
```bash
deno task dev -c kabegame                  # Start dev server (Vite + Tauri, port 1420)
deno task dev -c kabegame --mode local     # Dev with all plugins bundled locally
deno task dev -c kabegame --mode android   # Android dev
deno task dev -c kabegame --data prod      # Dev against system data dirs (not repo-local .kabegame/debug/)
deno task dev:frontend            # Frontend only (no Tauri, port 1420)
```

桌面三平台（含 macOS）的 `deno task dev -c kabegame` 统一走 `tauri dev`；`kabegame-cef-helper` bin 在 dev 下由 ComponentPlugin `beforeBuild` 在主程序编译前先行构建（`tauri dev` 走 `cargo run`，无法同调用多编一个 bin）；build 下由 tauri.conf.json 顶层 `bins`（fork patch 0009，见 cocs/tauri/TAURI_CLI_FORK.md）驱动 `tauri build` 随主编译一并产出——cargo 收到逐个 `--bin` 而非 `--bins` 全量（cef-example 不进 release），Windows 的 helper 由 NSIS 原生装到安装根（不再 stage 进 resources/bin）。CEF framework 为构建期直链（`third/cef-rs` fork），经 `target/Frameworks` 符号链接（cef-dll-sys 自动创建，指向 `CEF_PATH`）由 dyld 解析；helper 是 exe 旁的扁平 `kabegame-cef-helper`，三平台一致。

### Build
```bash
deno task b                            # Build everything (kabegame + kabegame-cli)
deno task b -c kabegame                    # Build main app only
deno task b -c kabegame --skip cargo       # Vue build only
deno task b -c kabegame --skip vue         # Cargo build only
deno task b --release                  # Copy artifacts to release/
deno task b -c kabegame --mode android     # Build Android APK/AAB (mode-plugin injects --target aarch64 unless
                                       # --target/-t is passed; gen/android RustPlugin.kt only has arm64 flavors)
```

`deno task b` on the cargo-only `kabegame-cli` component builds **debug** by default; pass `--release` for a release build. The main app's desktop/android build always goes through `tauri build`, which is release regardless of `--release`.

### CEF example

`cef-example` and `kabegame-cef-helper` are binary targets of the `kabegame` package. They validate the CEF windowed backend outside Tauri and are not build-system components:

```bash
CEF_PATH=... cargo build -p kabegame --features standard --bin kabegame-cef-helper
CEF_PATH=... cargo run -p kabegame --features standard --bin cef-example
```

On macOS both binaries are flat cargo artifacts in `target/<profile>`; the CEF framework resolves through the `target/Frameworks` symlink created by cef-dll-sys. See `src-tauri/tauri-runtime-cef/README.md`.

### Type Checking
```bash
deno task check -c kabegame                # Check Vue types + Cargo
deno task check -c kabegame --skip cargo   # Vue types only
deno task check -c kabegame --mode android --skip vue  # cargo check for Android via fork's `cargo tauri
                                     # android check` (NDK toolchain from cargo-mobile2, same as build).
                                     # Needs env NDK + deno task build:ffmpeg --target android + bin/android/ v8.
```

### Data directory modes (`--data`)
- `dev` (default for `deno task dev`): repo-local `.kabegame/debug/data`, `.kabegame/debug/cache`, and `.kabegame/debug/tmp` dirs — isolated from installed app
- `prod` (default for all other commands): system user data dirs (`%LOCALAPPDATA%\Kabegame` on Windows, `~/.local/share/Kabegame` on Linux/macOS)
- Use `--data prod` during dev to test against real installed data; use `--data dev` in a release build for CI/testing isolation
- Controlled via `kabegame_data` Rust cfg injected by `src-tauri/{kabegame-core,kabegame}/build.rs`

### Other
```bash
deno task set-version            # Bump version across workspace
deno task patch cef              # Apply third-patches/cef series atomically to third/cef
deno task patch cef -r           # Reverse the CEF series in reverse order
deno task patch --all --check    # Dry-run every available third-patches/* series
deno task patch tauri --from 9   # Series grew (new patch ≥9): reverse applied prefix (1..8),
                                 # then re-apply the full series (post-merge hook runs this
                                 # automatically when a pull adds third-patches/*/*.patch)
deno task build:ffmpeg           # Build x264 (third/x264) + FFmpeg libav* libs from source (native)
                                 # x264 is built-in (no system libx264 needed); Linux build uses
                                 # --disable-asm + -DNATIVE_ALIGN=16 to avoid CEF/PartitionAlloc crash
                                 # Required before standard/CLI cargo build
deno task build:ffmpeg --target android  # Cross-compile aarch64 FFmpeg via env NDK (NDK_HOME etc.)
                                 # Output gitignored under third/FFmpeg-build/android/ (reproduced by
                                 # command, not committed). Required before android cargo build/check.
deno task build:deno             # Build the deno CLI from third/deno sources (pin v2.9.0, with the
                                 # third-patches/deno series applied) into target/release/deno.
                                 # Managed like the tauri-cli fork: DenoCliPlugin refreshes it
                                 # incrementally before dev/build; CI uses the official binary and
                                 # sets KABEGAME_SKIP_DENO_CLI=1 to skip. Defaults to a thin-LTO
                                 # profile (KB_DENO_OFFICIAL=1 switches to the official fat-LTO
                                 # profile; linking needs 8-16GB RAM).
                                 # The self-built CLI also honors DENO_NODE_MODULES_SUFFIX (patch
                                 # 0004): when set (VM=-22, docker=-web), every node_modules path
                                 # component is redirected to node_modules<suffix> at the real-IO
                                 # boundary (in-process bind mount for per-glibc native isolation).
                                 # The suffixed tree must be created by `deno install` run WITH the
                                 # suffix set; DENO_DIR is exempt. See third-patches/deno/README.md.
```

### Verification workflow
**Do not run `cargo build` / `tauri build` / `deno task b` to verify changes** — run `deno task check -c <component>` instead (narrow it with `--skip vue` / `--skip cargo`). Editor lint diagnostics are equally valid for small edits. Only build when the user explicitly asks. Gotcha: `check` fails with `os error 32` while an app instance is running (`cef-dll-sys`'s build script copies the CEF runtime into `target/`) — kill `kabegame.exe` first. Rule: `.cursor/rules/verify-by-lint.mdc`.

**Debugging is the exception — run the thing.** Lint cannot prove runtime behavior. When diagnosing a bug: measure the object's actual state before explaining the symptom; trace the real call chain and verify actual values at every hop (especially Rust↔CEF, frontend↔Tauri, main↔subprocess); prefer zero-cost experiments (existing binary + env var / Chromium `--disable-features=<Name>` / existing `[DEBUG-*]` logs) over editing code; write the falsification criterion *before* running the experiment; quote source verbatim without inlining your own annotations. The higher the cost of a conclusion (patch a vendored lib, rebuild Chromium, large refactor), the stronger the empirical evidence it demands. Rule: `.cursor/rules/debug-empirically.mdc`.

### Plan & change-description format
When writing a plan or describing code changes, organize by explicit **points** (明确的点). Under each point, group items under **新增 / 修改 / 删除** (Add / Modify / Delete), each with an optional indented note. Keep 现状 separate from the change:
- **现状** sections show real, excerpted code blocks (not just `file:line`), annotated with comments describing **what the code is today** (not what will change).
- **实施方案** points carry the target code blocks, annotated to mark exactly what is added/modified/deleted.

````md
### 现状锚点
**a. `Foo`**(`foo.rs:64`)
```rust
struct Foo {
    bar: u32,   // 现状:只有 bar,没有进度字段
}
```

### 点 1 — 给 `Foo` 加字段(`foo.rs`)
- **修改**
  - `Foo` 增加 `received: u64`。
    > 说明:供 writer 上报进度。
```rust
struct Foo {
    bar: u32,
    received: u64,   // 新增
}
```
````

## Architecture

### Monorepo Layout
- `apps/kabegame/` — Vue 3 frontend (Vite, Element Plus, Pinia, UnoCSS)
- `packages/` — Shared frontend packages (`core`, `i18n`, `image-type`)
- `src-tauri/kabegame-core/` — `kabegame-core`: shared Rust library (crawler engine, plugin system, storage)
- `src-tauri/kabegame/` — Tauri GUI app (desktop + Android)
- `src-tauri/kabegame-cli/` — Headless CLI
- `src-tauri-plugins/` — Custom Tauri plugins (picker, pathes, share, compress, wallpaper, task-notification)
- `src-crawler-plugins/` — JS/TS crawler plugins (V8 backend) packaged as `.kgpg` archives
- `third-patches/` — Numbered patch series for keeping `third/` submodules clean and close to upstream

### Build Modes
| Mode | Features |
|------|----------|
| Standard (default) | Virtual disk, store plugins, **video ingestion** (rsmpeg/FFmpeg) |
| Local (`--mode local`, dev) | All plugins bundled locally |

### Key Architecture Rules
**Path logic belongs in `tauri-plugin-pathes`** — Any path/directory calculation must live in `src-tauri-plugins/tauri-plugin-pathes/`. Other modules call into it via `AppPaths`; never hardcode or recompute paths elsewhere.

**Third-party patch series** — Kabegame changes to vendored `third/` repositories belong in matching `third-patches/<dir>/NNNN-*.patch` files, applied manually with `deno task patch <dir>`. The manager preflights the full ordered series in a disposable Git worktree before changing the real submodule and rolls back a partial commit-stage failure. Reverse mode applies patches in reverse order. **The series is append-only**: never modify or delete a committed patch file — add a new numbered patch on top (rule: `.cursor/rules/third-patches-append-only.mdc`; only exception is a full re-vendor). After pulling newly added patches onto an already-patched submodule, resync with `deno task patch <dir> --from <N>` (reverses the applied prefix `< N`, then re-applies the whole series); the `.husky/post-merge` hook runs this automatically. `third/cef` directly pins official `chromiumembedded/cef` commit `0d0eeb611`; apply `third-patches/cef/0001-flat-subprocess-path.patch` before preparing a custom CEF/Chromium build. Re-vendor by reversing the series, bumping the upstream pin, then regenerating patches. See `third-patches/cef/README.md`.

**Script repository paths** — `scripts/utils.ts` is the single source for both `ROOT` and `THIRD_DIR`; standalone scripts and build plugins import `THIRD_DIR` from there, not from `build-system.ts` and not by recomputing `path.join(ROOT, "third")`.

**Single source of truth for file types:**
- Image extensions/MIME: use `kabegame_core::image_type::*` (e.g. `is_image_by_path`, `supported_image_extensions`). Never hardcode `["jpg","png",...]` in Rust. Frontend uses the `get_supported_image_types` Tauri command.
- `supported_video_extensions()` always returns the built-in video list. Frontend `isVideoMediaType` checks `type.startsWith("video/")` for gallery display.

**Video ingestion uses rsmpeg/FFmpeg on desktop AND Android (only iOS excluded):**
- Desktop builds (standard/CLI on Windows/macOS/Linux) link rsmpeg/FFmpeg for preview compression and video dimensions (native static libs from `deno task build:ffmpeg`).
- **Android also links rsmpeg/FFmpeg** — aarch64 static libs cross-compiled by `deno task build:ffmpeg --target android` (env NDK; output gitignored under `third/FFmpeg-build/android/`, reproduced by command, not committed). `rsmpeg`/`rusty_ffmpeg` are gated `cfg(not(target_os = "ios"))`.
- Preview format differs by platform: **desktop** = H.264 MP4 (grid uses `<video>`, hover-autoplays); **Android** = 10fps animated **GIF** (`run_ffmpeg_gif`: `fps,scale,palettegen,paletteuse`), because Android grids have no hover so a static `<video>` frame is useless — the frontend shows it in `<img>` (`ImageContent.vue` `mode==='gif'`). The Android FFmpeg build enables the gif encoder/muxer + palettegen/paletteuse/fps filters. The old Kotlin `tauri-plugin-compress` GIF path is removed.
- Android reads `content://` videos via `ContentIoProvider.open_fd(uri)` (PickerPlugin `openFileDescriptor().detachFd()`), then FFmpeg opens `/proc/self/fd/N`. Never treat a `content://` URI as a plain path or spill it to disk first. Video **dimensions** still come from `ContentIoProvider.get_video_dimensions` (`MediaMetadataRetriever`), not FFmpeg.
- `mode-plugin.ts` injects the Android FFmpeg env (`FFMPEG_PKG_CONFIG_PATH`, `FFMPEG_LINK_MODE=static`, `BINDGEN_EXTRA_CLANG_ARGS` with NDK sysroot+target, `PKG_CONFIG_ALLOW_CROSS=1`, NDK cross linker/CC). `deno task check -c kabegame --mode android` is supported (runs `cargo check --target aarch64-linux-android`). See `cocs/downloader-tasks/VIDEO_INGEST.md`.
- Linux CEF/Chromium is built with common MP4 codec support. Desktop video compatibility copies are H.264/AAC MP4 on Windows/macOS/Linux, and video preview thumbnails are H.264 MP4. Do not add Linux-only WebM regeneration logic for organize/postprocess; WebM muxing is retained only for stream-copy MSE captures whose original streams are VP9/Opus WebM.
- Gallery playback of stored videos is always supported (uses the HTML `<video>` element, no FFmpeg needed).

**Android modals** — Every overlay (dialog, drawer, ActionSheet, preview) must call `useModalBack(visibleRef)` from `@kabegame/core/composables/useModalBack` so the Android back button closes layers in stack order. The composable is a no-op on desktop; use it everywhere regardless of platform.

### Styling
New styles should use **UnoCSS utility classes** (configured in `uno.config.pub.ts` and `apps/kabegame/uno.config.ts`, using `presetWind3` — Tailwind-compatible syntax). Only write `<style>` blocks for complex animations or third-party overrides. Extract repeated class combinations into shortcuts in `uno.config.*.ts`.

### Platform-Specific Notes
- **Windows/macOS/Linux**: Virtual disk (Dokan / macFUSE / FUSE) for wallpaper mounting
- **Windows/macOS/Linux standard**: Uses the CEF runtime backend. All three platforms link CEF at build time and spawn subprocesses via a flat `kabegame-cef-helper` next to the exe (macOS dev runs the bare executable; release bundles embed the framework via `macOS.frameworks` and the helper via `macOS.files`).
- **Android**: Simplified UI; picker/share/compress plugins; `useModalBack` is required
- **Android identity split**: identifier (applicationId) is per-mode — dev `app.kabegame.dev` / prod `app.kabegame` (side-by-side installs) — while the Java package / source tree stays fixed at `app.kabegame` (`namespace`). Enabled by the forked `cargo-tauri` (upstream tauri monorepo at `third/tauri`, patched by `third-patches/tauri` — run `deno task patch tauri` first; honors `TAURI_ANDROID_PACKAGE`; built from `crates/tauri-cli` + PATH-injected by `TauriCliPlugin`). Never re-derive Kotlin package names from the identifier. See `cocs/tauri/TAURI_CLI_FORK.md`.
- **iOS**: Not supported — do not add iOS adaptations

### Crawler Plugin Development
Plugins are JS/TS scripts (V8 backend, self-contained ES module `export async function crawl`) packaged as `.kgpg` ZIP archives. See `docs/PLUGIN_FORMAT.md` and `cocs/crawler/V8_RUNTIME.md`. Build with:
```bash
deno task --cwd src-crawler-plugins package         # Package all plugins
deno task --cwd src-crawler-plugins generate-index  # Regenerate plugin store index
```
