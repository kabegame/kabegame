# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. (Or you are any other agent, follow this rule file too);

## Instructions loading (Claude Code memory model)

Per the [Claude Code memory documentation](https://code.claude.com/docs/en/memory), `CLAUDE.md` is project-level persistent context loaded each session. It is guidance, not a separate enforcement layer—keep it accurate, specific, and under ~200 lines when possible; split or use `@path` imports and optional `.claude/rules/` for larger or path-scoped instructions as that doc describes.

## Recommand to read: Cursor rules.

This repository’s **Cursor** constraints live in **`.cursor/rules/`** (`.mdc` files). They are the canonical, always-applied (or path-scoped) rules for work done in Cursor.

**Before making substantive code or config changes:** read the `.mdc` files in `.cursor/rules/` that apply to the areas you edit (or the whole set if scope is unclear). Treat them as mandatory alongside `.claude/rules/` if present.

**When conventions change:** update `.cursor/rules/` and this `CLAUDE.md` together so they do not contradict each other—mirror critical requirements here or in imports, and keep Cursor rules as the source of truth for editor-enforced behavior.

MUST read index for code base first. Keep in mind to sync these docs when do some changes:
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
deno task dev -c kabegame --data prod      # Dev against system data dirs (not repo-local data/)
deno task dev:frontend            # Frontend only (no Tauri, port 1420)
```

### Build
```bash
deno task b                            # Build everything (kabegame + kabegame-cli)
deno task b -c kabegame                    # Build main app only
deno task b -c kabegame --skip cargo       # Vue build only
deno task b -c kabegame --skip vue         # Cargo build only
deno task b --release                  # Copy artifacts to release/
deno task b -c kabegame --mode android     # Build Android APK/AAB
```

### Type Checking
**用 `check-kabegame` skill**（`.claude/skills/check-kabegame/`），不要手敲 `deno task check`。
它包装那条命令，落盘日志并从几百行 warning 里摘出真正的 error：

```bash
.claude/skills/check-kabegame/driver.sh              # vue-tsc + cargo check
.claude/skills/check-kabegame/driver.sh --skip cargo # 只查前端类型（秒级）
.claude/skills/check-kabegame/driver.sh --skip vue   # 只查 Rust
```

用法与 gotchas（退出码 2/101、warning 噪音、app 占用 target/、android 前置）见
`.claude/skills/check-kabegame/SKILL.md`。

### Data directory modes (`--data`)
- `dev` (default for `deno task dev`): repo-local `data/` and `cache/` dirs — isolated from installed app
- `prod` (default for all other commands): system user data dirs (`%LOCALAPPDATA%\Kabegame` on Windows, `~/.local/share/Kabegame` on Linux/macOS)
- Use `--data prod` during dev to test against real installed data; use `--data dev` in a release build for CI/testing isolation
- Controlled via `kabegame_data` Rust cfg injected by `src-tauri/{kabegame-core,kabegame}/build.rs`

### Verification workflow
**Do not run `cargo build` or full builds to verify changes.** Invoke the **`check-kabegame` skill** (`.claude/skills/check-kabegame/driver.sh`) instead; editor lint diagnostics are equally valid for small edits. Only run build commands when the user explicitly requests a build.

## Architecture

### Monorepo Layout
- `apps/kabegame/` — Vue 3 frontend (Vite, Element Plus, Pinia, UnoCSS)
- `packages/` — Shared frontend packages (`core`, `i18n`, `image-type`)
- `src-tauri/kabegame-core/` — `kabegame-core`: shared Rust library (crawler engine, plugin system, storage)
- `src-tauri/kabegame/` — Tauri GUI app (desktop + Android)
- `src-tauri/kabegame-cli/` — Headless CLI
- `src-tauri-plugins/` — Custom Tauri plugins (picker, pathes, share, compress, wallpaper, task-notification)
- `src-crawler-plugins/` — JS/TS crawler plugins (V8 backend) packaged as `.kgpg` archives

### Build Modes
| Mode | Features |
|------|----------|
| Standard (default) | Virtual disk, CLI, store plugins, **video ingestion** (rsmpeg/FFmpeg) |
| Light (`--mode light`) | Store only, no virtual disk/CLI, **video ingestion** (rsmpeg/FFmpeg) |
| Local (`--mode local`, dev) | All plugins bundled locally |

### Key Architecture Rules
**Path logic belongs in `tauri-plugin-pathes`** — Any path/directory calculation must live in `src-tauri-plugins/tauri-plugin-pathes/`. Other modules call into it via `AppPaths`; never hardcode or recompute paths elsewhere.

**Single source of truth for file types:**
- Image extensions/MIME: use `kabegame_core::image_type::*` (e.g. `is_image_by_path`, `supported_image_extensions`). Never hardcode `["jpg","png",...]` in Rust. Frontend uses the `get_supported_image_types` Tauri command.
- `supported_video_extensions()` always returns the built-in video list. Frontend `isVideoMediaType` checks `type.startsWith("video/")` for gallery display.

**Video ingestion is platform-gated, not Cargo-feature-gated:**
- Desktop builds (standard/light/CLI on Windows/macOS/Linux) link rsmpeg/FFmpeg for preview compression and video dimensions.
- Android must not compile FFmpeg/rsmpeg; it uses `AndroidVideoCompressProvider` backed by `tauri-plugin-compress`/Kotlin and content URI media APIs.
- rsmpeg usage in `compress.rs` and `media_dimensions.rs` is guarded with `#[cfg(not(target_os = "android"))]`; Android alternatives are guarded with `#[cfg(target_os = "android")]`.
- Linux CEF/Chromium is built with common MP4 codec support. Desktop video compatibility copies are H.264/AAC MP4 on Windows/macOS/Linux, and video preview thumbnails are H.264 MP4. Do not add Linux-only WebM regeneration logic for organize/postprocess; WebM muxing is retained only for stream-copy MSE captures whose original streams are VP9/Opus WebM.
- Gallery playback of stored videos is always supported (uses the HTML `<video>` element, no FFmpeg needed).

**Android modals** — Every overlay (dialog, drawer, ActionSheet, preview) must call `useModal(visibleRef)` from `@kabegame/core/composables/useModal` so the Android back button closes layers in stack order. The composable is a no-op on desktop; use it everywhere regardless of platform.

### Styling
New styles should use **UnoCSS utility classes** (configured in `uno.config.pub.ts` and `apps/kabegame/uno.config.ts`, using `presetWind3` — Tailwind-compatible syntax). Only write `<style>` blocks for complex animations or third-party overrides. Extract repeated class combinations into shortcuts in `uno.config.*.ts`. New styles are preferred to write unocss.

### Platform-Specific Notes
- **Windows/macOS/Linux**: Virtual disk (Dokan / macFUSE / FUSE) for wallpaper mounting
- **Android**: Simplified UI; picker/share/compress plugins; `useModalBack` is required
- **iOS**: Not supported — do not add iOS adaptations

### Crawler Plugin Development
Plugins are JS/TS scripts (V8 backend, self-contained ES module `export async function crawl`) packaged as `.kgpg` ZIP archives. See `docs/PLUGIN_FORMAT.md` and `cocs/crawler/V8_RUNTIME.md`. Build with:
```bash
deno task --cwd src-crawler-plugins package         # Package all plugins
deno task --cwd src-crawler-plugins generate-index  # Regenerate plugin store index
```

### Others
- Windows find str MUST use `pwsh` instead of `powershell`;

语言规范
所有与用户的交流均使用简体中文。
任务计划、进度说明、问题分析、调试结论和最终回答均使用中文。
工具调用前后的说明使用中文。
代码标识符、终端命令、文件路径、API 名称和原始错误信息保持原语言。
代码注释默认使用中文，除非当前项目已有明确的英文注释规范。
不要因为代码库、日志或文档是英文而切换成英文回答。