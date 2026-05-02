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
bun dev -c kabegame --data prod      # Dev against system data dirs (not repo-local data/)
bun dev:frontend            # Frontend only (no Tauri, port 1420)
```

### Build
```bash
bun b                            # Build everything (kabegame + kabegame-cli)
bun b -c kabegame                    # Build main app only
bun b -c kabegame --skip cargo       # Vue build only
bun b -c kabegame --skip vue         # Cargo build only
bun b --release                  # Copy artifacts to release/
bun b -c kabegame --mode android     # Build Android APK/AAB
```

### Type Checking
```bash
bun check -c kabegame                # Check Vue types + Cargo
bun check -c kabegame --skip cargo   # Vue types only
```

### Data directory modes (`--data`)
- `dev` (default for `bun dev`): repo-local `data/` and `cache/` dirs — isolated from installed app
- `prod` (default for all other commands): system user data dirs (`%LOCALAPPDATA%\Kabegame` on Windows, `~/.local/share/Kabegame` on Linux/macOS)
- Use `--data prod` during dev to test against real installed data; use `--data dev` in a release build for CI/testing isolation
- Controlled via `kabegame_data` Rust cfg injected by `src-tauri/{kabegame-core,kabegame}/build.rs`

### Other
```bash
bun run set-version              # Bump version across workspace
bun run build:ffmpeg             # Build FFmpeg sidecar (requires libx264)
```

### Verification workflow
**Do not run `cargo build` or full builds to verify changes.** Rely on lint diagnostics (`vue-tsc`, `cargo check`) instead. Only run build commands when the user explicitly requests a build.

## Architecture

### Monorepo Layout
- `apps/kabegame/` — Vue 3 frontend (Vite, Element Plus, Pinia, UnoCSS)
- `packages/` — Shared frontend packages (`core`, `i18n`, `image-type`, `photoswipe-vue`)
- `src-tauri/kabegame-core/` — `kabegame-core`: shared Rust library (crawler engine, plugin system, storage)
- `src-tauri/kabegame/` — Tauri GUI app (desktop + Android)
- `src-tauri/kabegame-cli/` — Headless CLI
- `src-tauri-plugins/` — Custom Tauri plugins (picker, archiver, pathes, share, compress, wallpaper, task-notification)
- `src-crawler-plugins/` — Rhai-based crawler plugins packaged as `.kgpg` archives

### Build Modes
| Mode | Features |
|------|----------|
| Standard (default) | Virtual disk, CLI, store plugins |
| Light (`--mode light`) | Store only, no virtual disk/CLI |
| Local (`--mode local`, dev) | All plugins bundled locally |

### Key Architecture Rules
**Path logic belongs in `tauri-plugin-pathes`** — Any path/directory calculation must live in `src-tauri-plugins/tauri-plugin-pathes/`. Other modules call into it via `AppPaths`; never hardcode or recompute paths elsewhere.

**Single source of truth for file types:**
- Image extensions/MIME: use `kabegame_core::image_type::*` (e.g. `is_image_by_path`, `supported_image_extensions`). Never hardcode `["jpg","png",...]` in Rust. Frontend uses the `get_supported_image_types` Tauri command.
- Archive extensions: use `kabegame_core::archive::supported_types()` / `is_archive_by_path()`. Never hardcode `["zip","rar"]` in Rust. Frontend fetches via Tauri command.

**Android modals** — Every overlay (dialog, drawer, ActionSheet, preview) must call `useModalBack(visibleRef)` from `@kabegame/core/composables/useModalBack` so the Android back button closes layers in stack order. The composable is a no-op on desktop; use it everywhere regardless of platform.

### Styling
New styles should use **UnoCSS utility classes** (configured in `uno.config.pub.ts` and `apps/kabegame/uno.config.ts`, using `presetWind3` — Tailwind-compatible syntax). Only write `<style>` blocks for complex animations or third-party overrides. Extract repeated class combinations into shortcuts in `uno.config.*.ts`.

### Platform-Specific Notes
- **Windows/macOS/Linux**: Virtual disk (Dokan / macFUSE / FUSE) for wallpaper mounting
- **Android**: Simplified UI; picker/share/compress plugins; `useModalBack` is required
- **iOS**: Not supported — do not add iOS adaptations

### Crawler Plugin Development
Plugins are Rhai scripts packaged as `.kgpg` ZIP archives. See `docs/README_PLUGIN_DEV.md`, `docs/PLUGIN_FORMAT.md`, and `docs/RHAI_API.md`. Build with:
```bash
cd src-crawler-plugins && bun package        # Package all plugins
bun generate-index                           # Regenerate plugin store index
```
