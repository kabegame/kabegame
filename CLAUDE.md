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

Kabegame is a cross-platform anime wallpaper crawler and manager built with **Tauri 2** (Rust backend) and **Vue 3** (TypeScript frontend). It supports Windows, macOS, Linux, and Android — **not iOS**. Crawler plugins are written in the **Rhai** scripting language.

## Commands

All top-level commands go through `scripts/run.ts` (a Tapable-based build system) and are run with `bun`.

### Development
```bash
bun dev -c kabegame                  # Start dev server (Vite + Tauri, port 1420)
bun dev -c kabegame --mode local     # Dev with all plugins bundled locally
bun dev -c kabegame --mode android   # Android dev
bun dev -c kabegame --data prod      # Dev against system data dirs (not repo-local .kabegame/debug/)
bun dev:frontend            # Frontend only (no Tauri, port 1420)
```

macOS 的 `bun dev -c kabegame` 会显式 cargo build，生成 `gen/Kabegame.app`（CEF framework 使用 `cef-dev` 符号链接），自行启动 Vite 后运行 app 内可执行文件。前端 HMR 保留，但 Rust 文件修改不会自动重启，需重新执行命令。

### Build
```bash
bun b                            # Build everything (kabegame + kabegame-cli)
bun b -c kabegame                    # Build main app only
bun b -c kabegame --skip cargo       # Vue build only
bun b -c kabegame --skip vue         # Cargo build only
bun b --release                  # Copy artifacts to release/
bun b -c kabegame --mode android     # Build Android APK/AAB
```

`bun b` on cargo-only components (`kabegame-cli`, `cef-example`, `cef-helper`) builds **debug** by default; pass `--release` for a release build. The main app's desktop/android build always goes through `tauri build`, which is release regardless of `--release`.

### CEF example (`cef-example` / `cef-helper`)

Standalone crates (not part of `bun b`'s default "everything") for validating the CEF windowed backend outside of Tauri, on Linux/Windows/macOS:

```bash
bun b -c cef-helper               # subprocess entry — build first, cef-example only checks it exists
bun b -c cef-example              # Linux/Windows: cargo build; macOS: also generates gen/CEFExample.app
bun start -c cef-example          # Linux/Windows: cargo run; macOS: runs gen/CEFExample.app (build first)
```

macOS requires the app bundle (`gen/CEFExample.app`, produced by `bun b -c cef-example`) — a bare `cargo run -p cef-example` will not work there. See `src-tauri/tauri-runtime-cef/README.md`.

### Type Checking
```bash
bun check -c kabegame                # Check Vue types + Cargo
bun check -c kabegame --skip cargo   # Vue types only
```

### Data directory modes (`--data`)
- `dev` (default for `bun dev`): repo-local `.kabegame/debug/data`, `.kabegame/debug/cache`, and `.kabegame/debug/tmp` dirs — isolated from installed app
- `prod` (default for all other commands): system user data dirs (`%LOCALAPPDATA%\Kabegame` on Windows, `~/.local/share/Kabegame` on Linux/macOS)
- Use `--data prod` during dev to test against real installed data; use `--data dev` in a release build for CI/testing isolation
- Controlled via `kabegame_data` Rust cfg injected by `src-tauri/{kabegame-core,kabegame}/build.rs`

### Other
```bash
bun run set-version              # Bump version across workspace
bun run build:ffmpeg             # Build x264 (third/x264) + FFmpeg libav* libs from source
                                 # x264 is built-in (no system libx264 needed); Linux build uses
                                 # --disable-asm + -DNATIVE_ALIGN=16 to avoid CEF/PartitionAlloc crash
                                 # Required before standard/CLI cargo build
```

### Verification workflow
**Do not run `cargo build` or full builds to verify changes.** Rely on lint diagnostics (`bun check`) instead. Only run build commands when the user explicitly requests a build.

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
- `src-crawler-plugins/` — Rhai-based crawler plugins packaged as `.kgpg` archives

### Build Modes
| Mode | Features |
|------|----------|
| Standard (default) | Virtual disk, store plugins, **video ingestion** (rsmpeg/FFmpeg) |
| Local (`--mode local`, dev) | All plugins bundled locally |

### Key Architecture Rules
**Path logic belongs in `tauri-plugin-pathes`** — Any path/directory calculation must live in `src-tauri-plugins/tauri-plugin-pathes/`. Other modules call into it via `AppPaths`; never hardcode or recompute paths elsewhere.

**Single source of truth for file types:**
- Image extensions/MIME: use `kabegame_core::image_type::*` (e.g. `is_image_by_path`, `supported_image_extensions`). Never hardcode `["jpg","png",...]` in Rust. Frontend uses the `get_supported_image_types` Tauri command.
- `supported_video_extensions()` always returns the built-in video list. Frontend `isVideoMediaType` checks `type.startsWith("video/")` for gallery display.

**Video ingestion is platform-gated, not Cargo-feature-gated:**
- Desktop builds (standard/CLI on Windows/macOS/Linux) link rsmpeg/FFmpeg for preview compression and video dimensions.
- Android must not compile FFmpeg/rsmpeg; it uses `AndroidVideoCompressProvider` backed by `tauri-plugin-compress`/Kotlin and content URI media APIs.
- rsmpeg usage in `compress.rs` and `media_dimensions.rs` is guarded with `#[cfg(not(target_os = "android"))]`; Android alternatives are guarded with `#[cfg(target_os = "android")]`.
- Linux CEF/Chromium is built with common MP4 codec support. Desktop video compatibility copies are H.264/AAC MP4 on Windows/macOS/Linux, and video preview thumbnails are H.264 MP4. Do not add Linux-only WebM regeneration logic for organize/postprocess; WebM muxing is retained only for stream-copy MSE captures whose original streams are VP9/Opus WebM.
- Gallery playback of stored videos is always supported (uses the HTML `<video>` element, no FFmpeg needed).

**Android modals** — Every overlay (dialog, drawer, ActionSheet, preview) must call `useModalBack(visibleRef)` from `@kabegame/core/composables/useModalBack` so the Android back button closes layers in stack order. The composable is a no-op on desktop; use it everywhere regardless of platform.

### Styling
New styles should use **UnoCSS utility classes** (configured in `uno.config.pub.ts` and `apps/kabegame/uno.config.ts`, using `presetWind3` — Tailwind-compatible syntax). Only write `<style>` blocks for complex animations or third-party overrides. Extract repeated class combinations into shortcuts in `uno.config.*.ts`.

### Platform-Specific Notes
- **Windows/macOS/Linux**: Virtual disk (Dokan / macFUSE / FUSE) for wallpaper mounting
- **Windows/macOS/Linux standard**: Uses the CEF runtime backend. macOS browser processes must run inside `gen/Kabegame.app` in dev; release bundles embed the framework and independent helper apps.
- **Android**: Simplified UI; picker/share/compress plugins; `useModalBack` is required
- **iOS**: Not supported — do not add iOS adaptations

### Crawler Plugin Development
Plugins are Rhai scripts packaged as `.kgpg` ZIP archives. See `docs/README_PLUGIN_DEV.md`, `docs/PLUGIN_FORMAT.md`, and `docs/RHAI_API.md`. Build with:
```bash
cd src-crawler-plugins && bun package        # Package all plugins
bun generate-index                           # Regenerate plugin store index
```
