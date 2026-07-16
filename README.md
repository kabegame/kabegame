# Kabegame — Anime Crawler Client

> *Translated by AI. [中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)*

A Tauri-based anime crawler client! Crawl, organize, and set/rotate wallpapers—let your waifus (or husbandos) keep you company every day~ Plugin-extensible, so you can easily grab images from all kinds of anime wallpaper sites.

> 🌐 **Demo Page**: [https://kabegame.com/](https://kabegame.com/)

<div align="center">
  <img src="docs/images/icon.png" alt="Kabegame" width="256"/>
</div>

![visitor badge](https://visitor-badge.laobi.icu/badge?page_id=kabegame.readme.en)

## Screenshots

<table>
  <tr>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-windows-gallery.png" alt="Kabegame Windows screenshot 1" width="300"/><br/>
      <small>Windows</small>
    </td>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-windows-preview.png" alt="Kabegame Windows screenshot 2" width="300"/><br/>
      <small>Windows</small>
    </td>
    <td align="center" rowspan="2" style="vertical-align: top; text-align: right; width: 200px;">
      <img src="docs/images/main-screenshot-android-gallery.jpg" alt="Kabegame Android screenshot" width="200"><br/>
      <small>Android</small>
    </td>
  </tr>
  <tr>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot3-macos.png" alt="Kabegame macOS screenshot" width="300"/><br/>
      <small>macOS</small>
    </td>
    <td align="center" style="width: 300px;">
      <img src="docs/images/main-screenshot-linux.png" alt="Kabegame Linux screenshot" width="300"/><br/>
      <small>Linux</small>
    </td>
  </tr>
</table>

## Crawler Screenshots

|  |  |
| --- | --- |
| <div align="center"><img src="docs/images/crawler/pixiv.png" alt="Pixiv crawler" width="380"/><br/><small><a href="https://pixiv.net">Pixiv</a> (artist: <a href="https://www.pixiv.net/users/16365055">somna</a>)</small></div> | <div align="center"><img src="docs/images/crawler/anihonet.png" alt="anihonet crawler" width="380"/><br/><small><a href="https://anihonetwallpaper.com">anihonet</a> (yearly ranking)</small></div> |
| <div align="center"><img src="docs/images/crawler/anime-pictures.png" alt="anime-pictures crawler" width="380"/><br/><small><a href="https://anime-pictures.net">anime-pictures</a> (keyword: Honkai: Star Rail)</small></div> | <div align="center"><img src="docs/images/crawler/konachan.png" alt="konachan crawler" width="380"/><br/><small><a href="https://konachan.net">konachan</a> wallpapers</small></div> |
| <div align="center"><img src="docs/images/crawler/2dwallpaper.png" alt="2dwallpaper crawler" width="380"/><br/><small><a href="https://2dwallpapers.com">2dwallpaper</a> (Games → Genshin → Most viewed)</small></div> | <div align="center"><img src="docs/images/crawler/ziworld.png" alt="ziworld crawler" width="380"/><br/><small><a href="https://t.ziworld.top">ziworld</a> wallpapers</small></div> |

<p align="center"><sub>Supports many sites; plugins are extensible. Contributions welcome!</sub></p>

[→ Crawler plugins repo](https://github.com/kabegame/crawler-plugins/tree/main)

## Name Origin 🐢

**Kabegame** is the romanization of the Japanese word 壁亀 (かべがめ), which sounds similar to 壁紙 (かべがみ, wallpaper). Like a quiet turtle resting on your desktop, it quietly guards your anime wallpaper collection—no fuss, just comfort. So you get a little comfort every day. Yay~ ✨

> My philosophy: Embrace open source, build software by and for weebs.

## Features

- 🔌 **Crawler client**: Use `.kgpg` plugins to crawl wallpapers from various sites; built-in plugin store for browse/install/manage; task progress with stop/delete; CLI to package/import plugins and import/query local data.
- 🎨 **Wallpaper setter (image/video)**: Collect, manage, and rotate anime wallpapers; auto-switch desktop wallpaper from albums (random or sequential)
- 🖼️ **Image manager (image/video)**: Gallery browsing, album organization, virtual disk (drive letter on Windows, virtual folder on macOS/Linux), drag-and-drop import for local images/videos/folders/archives or kgpg plugins

(Video support: mp4, mov, wmv, webm, mkv — desktop builds use FFmpeg/rsmpeg; Android uses platform media APIs and does not compile FFmpeg)

## Installation

**Pick the package for your OS.**

**[View the latest GitHub Releases](https://github.com/kabegame/kabegame/releases/latest)**

| OS | Download |
|----|----------|
| Windows | [setup.exe](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_x64-setup.exe) |
| macOS | [dmg](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_aarch64.dmg) |
| Linux | [deb](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame-standard_4.4.0_amd64.deb) |

- **Android preview** : [apk](https://github.com/kabegame/kabegame/releases/download/v4.4.0/Kabegame_4.4.0_android-preview.apk) on the same releases page.
- **CLI**: Not bundled with the app — distributed separately. Download `kabegame-cli` for your platform from the same releases page and put it on your PATH (`kabegame-cli --help`).

## Installation

### Windows

1. **Download**: Get the `setup.exe`.
2. **Run installer**: Double-click and follow the wizard.
3. That's it!

> **Tip**: The installer supports auto-update; run it again to upgrade.

### macOS

> **Minimum**: macOS **11 (Big Sur)** or later.

1. **Download DMG**: Get the `.dmg`.
2. **Install**:
   - Open the `.dmg`.
   - Drag `Kabegame.app` to Applications.
> [!IMPORTANT]
> ## Fix: "Kabegame.app" is damaged and can't be opened
> After installing to Applications, you need to bypass Gatekeeper (this is an open-source app and the author can't afford Apple's developer fee).
>
> `xattr -d com.apple.quarantine /Applications/Kabegame.app`
3. **Virtual disk / FUSE**:
   - Requires macFUSE: `brew install macfuse`
   - First mount will prompt for permission.
### Linux (Debian-based, e.g. Ubuntu)

> **Minimum**: **Ubuntu 22.04** / Debian 12 or later (glibc ≥ 2.35).

**Install**:
  ```bash
  sudo apt install ./Kabegame-standard_<version>_<arch>.deb
  ```
  - Or `sudo dpkg -i Kabegame-standard_<version>_<arch>.deb`; if dependencies fail: `sudo apt-get install -f`

## Main Features

### 🖼️ Gallery & Image Management

The gallery is the heart of Kabegame—all collected wallpapers show up here. Pagination, quick preview, multi-select, deduplication, and more. Drag in local files to import. Double-click for in-app preview with zoom, pan, and navigation, or open with your system viewer.

<div align="center">
  <img src="docs/images/main-screenshot-macos-gallery1.png" alt="macOS gallery 1" width="400"/>
  <img src="docs/images/main-screenshot-macos-gallery2.png" alt="macOS gallery 2" width="400"/>
</div>

### 📸 Albums

Organize wallpapers into custom albums. Add favorites, drag to reorder. Albums power wallpaper rotation and virtual disk layout. Each album has its own cover and description.

<div align="center">
  <img src="docs/images/album.png" alt="Album list" width="400"/>
  <img src="docs/images/album-detail.png" alt="Album detail" width="400"/>
</div>

### 🔌 Plugin System

Kabegame’s strength is its plugin-based crawler (local file import is a crawler plugin too). `.kgpg` plugins let you pull images from anime wallpaper sites. Plugins are written in Rhai. Built-in plugin store ([plugin repo](./src-crawler-plugins)) for one-click install, or import third-party plugins, or write your own. Each plugin has configurable parameters and optional HTTP headers. You get it.

<div align="center">
  <img src="docs/images/plugins.png" alt="Plugins" width="400"/>
  <img src="docs/images/plugin-detail.png" alt="Plugin detail" width="400"/>
</div>

### 🎨 Wallpaper & Rotation

Set desktop wallpaper with one click (right-click image → set as wallpaper). Native mode for performance, window mode for extra features. Enable rotation to auto-switch from an album (random or sequential), with configurable interval.

<div align="center"><small>Set image wallpaper</small></div>

![Set wallpaper](./docs/images/set-wallpaper.gif)

<div align="center"><small>Set video wallpaper (Windows, macOS)</small></div>

![Set video wallpaper](./docs/images/set-v-wallpaper.gif)

### 📋 Crawler Task Management

All crawl tasks in one place. Live progress, status, image count. View details, stop running tasks, delete finished ones. Task detail view shows collected images in a grid—preview, select, add to album, or delete.

| ![Start task](docs/images/start-crawl.png)<br/><sub>Start task</sub> | ![Crawling](docs/images/crawling.png)<br/><sub>Crawling</sub> |
|:-----------------------------------------------------------:|:----------------------------------------------------------:|
| ![Task log](docs/images/task-log.png)<br/><sub>Task log</sub>    | ![Task images](docs/images/task-images.png)<br/><sub>Task images</sub>  |

### 💾 Virtual Disk

On Windows, macOS, and Linux, Kabegame can mount albums as a virtual disk (or virtual folder). Browse albums and images in your file manager like normal folders. Supports layouts by plugin, time, task, or album.

<div align="center">
  <img src="docs/images/setting-VD.png" alt="Virtual disk settings" width="400"/>
  <img src="docs/images/VD-view.png" alt="VD view" width="400" />
  <img src="docs/images/VD-view-mac.png" alt="VD macOS view" width="400" />
</div>

### ⌨️ CLI

Self-contained CLI for creating, packaging, and importing plugins, importing one local image/video at a time, and querying PathQL data. It does not require a running Kabegame process. Distributed separately from the app — download it from the releases page.

### More

Built-in help page to get to know Kabegame better.
![help](./docs/images/help.png)

More features and improvements are planned. Stay tuned.

## Notes

- Respect target sites’ robots.txt and terms of use when crawling.
- Wallpapers are stored in `Pictures/Kabegame` by default, or in the app data `images` folder (configurable in-app).
- All data lives in app data; cache in cache dir. Uninstalling with “delete data” removes app data but not images.
- Wallpaper rotation requires the app to run in the background (tray icon). Closing the app stops rotation.

## Uninstall

### Windows
**Option 1**: Settings → Apps → Installed apps → search Kabegame → ⋮ → Uninstall  
**Option 2**: Right-click shortcut → Open file location → run `uninstall.exe`

### Linux (Debian-based)
```sh
sudo dpkg -r kabegame
```

---

## Tech Stack

- **Frontend**: Vue 3 + TypeScript + Element Plus + UnoCSS
- **Backend**: Rust (Tauri) + Kotlin (Jetpack)
- **State**: Pinia
- **Router**: Vue Router
- **Build**: Vite 5
- **Plugin scripts**: Rhai

## Development

### Prerequisites

- Deno 2.9.0 (recommended: build the in-tree deno with `bash scripts/build-deno.sh`, which outputs `target/release/deno` — prepend `target/release` to your PATH; alternatively, install 2.9.0 via the official install script as a transitional option)
- Rust 1.70+ (Rust 2021 Edition)
- [Tauri CLI](https://tauri.app/v2/guides/getting-started/prerequisites)

### Install dependencies

```bash
deno install
```

FFmpeg is a **Git submodule** in `third/FFmpeg` (for desktop video preview/compression). For `deno task build:ffmpeg`:

- **After clone**: `git submodule update --init --recursive`, or `git clone --recurse-submodules <repo-url>`
- **First-time submodule add** (one-time, large): `git submodule add https://github.com/FFmpeg/FFmpeg.git third/FFmpeg`

### Git hooks: auto-tag on push (optional)

Husky runs before `git push`, reads `src-crawler-plugins/package.json` version, and tries to create tag `v{version}`. If the tag exists or creation fails, it **skips without blocking push**.

- Enable: `deno install` does **not** run `prepare` automatically — after cloning, run `deno task prepare` manually (once in the repo root and once in `src-crawler-plugins`)
- Reinstall: `deno task prepare`

### Dev / build commands

Cargo workspace with three apps:
- **kabegame**: Tauri GUI (frontend on port 1420)
- **kabegame-cli**: Headless CLI

Both share `kabegame-core`.

```bash
# Dev (watch, hot reload)
deno task dev -c kabegame              # Main app (port 1420)
deno task dev -c kabegame --mode local  # Local mode (no store, all plugins bundled)

# Run (no watch)
deno task start -c kabegame-cli             # CLI

# Build
deno task b                    # All (kabegame + kabegame-cli)
deno task b -c kabegame            # Main app
deno task b -c kabegame-cli             # CLI

# Check (no build output)
deno task check -c kabegame                # Vue + cargo
deno task check -c kabegame --skip cargo   # Vue only

# Build FFmpeg libav* libraries (required for desktop standard/CLI; not needed for Android)
deno task build:ffmpeg             # Needs libx264 (macOS: brew install x264, Ubuntu: libx264-dev)
```

- `-c, --component`: `kabegame` | `kabegame-cli`
- `deno task check` requires `-c`
- `--mode`: `standard` (default, store + virtual disk + CLI) | `android` (Android target)
- `--data`: `dev` (default for `deno task dev` — uses repo-local `.kabegame/debug/data`, `.kabegame/debug/cache`, and `.kabegame/debug/tmp` dirs) | `prod` (default for all other commands — uses system data dirs). Use `--data prod` during `deno task dev` to test against your installed Kabegame data.
- `--skip`: `vue` | `cargo`
- Kabegame app `deno task dev -c kabegame` packages the crawler plugins to dev data so packed `.kgpg` files land in `.kabegame/debug/data/plugins-directory` for local testing; release builds do not bundle store plugins (users install from the GitHub store).

### Android development

#### Prerequisites

See [Android migration guide](docs/TAURI_ANDROID_MIGRATION.md). Main requirements:

> **Wallpaper**: See [Android wallpaper implementation](docs/ANDROID_WALLPAPER_IMPLEMENTATION.md).

- Android Studio
- `JAVA_HOME` (Android Studio JBR)
- `ANDROID_HOME` (SDK)
- `NDK_HOME` (**required**, or build fails)
- Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

**Minimum Android 8.0 (API 26+)**.

#### Run on device/emulator

Use **`deno task dev -c kabegame --mode android`** (omit `--mode android` and it runs desktop). With multiple devices:

```bash
adb devices

# Specify device (replace <device-id> with first column from adb devices)
deno task dev -c kabegame --mode android -- <device-id>
```

#### DevTools

Tauri doesn’t support `open_devtools()` on Android. Use **Chrome DevTools**:

**Option 1: Chrome DevTools**

1. Connect device, enable USB debugging.
2. In Chrome: `chrome://inspect/#devices`
3. Enable "Discover USB devices"
4. Find Kabegame, click "inspect"

**Option 2: ADB**

```bash
adb devices
adb forward tcp:9222 localabstract:chrome_devtools_remote
# Then chrome://inspect/#devices
```

- App must run in Debug (dev mode does this).
- If device not visible: check USB debugging, ADB drivers, try `adb kill-server && adb start-server`.

## Project structure

```
.
├── apps/                  # Frontend
│   └── kabegame/             # Main app (Vue 3 + TS, port 1420)
├── packages/
│   └── core/             # Shared frontend
├── src-tauri/            # Rust (Cargo workspace)
│   ├── kabegame-core/             # kabegame-core
│   ├── kabegame/         # Tauri GUI
│   ├── kabegame-cli/          # CLI
│   └── icons/
├── src-crawler-plugins/  # Plugins
├── scripts/
├── docs/
├── static/
├── deno.json
├── package.json
└── Cargo.toml
```

## Plugin development

- [Plugin dev guide](docs/README_PLUGIN_DEV.md)
- [Plugin format](docs/PLUGIN_FORMAT.md)
- [Rhai API](docs/RHAI_API.md)
- [Crawler WebView design](docs/CRAWLER_WEBVIEW_DESIGN.md) (planned)
- **Heybox (`xhh`) plugin** ([`src-crawler-plugins/plugins/xhh/`](src-crawler-plugins/plugins/xhh/)): Web API signing and list endpoints are documented in [`items-api.md`](src-crawler-plugins/plugins/xhh/items-api.md). The **`GET /bbs/app/link/tree`** endpoint returns the comment tree for a post; set query **`link_id`** to the post’s **`linkid`** from list APIs (e.g. `feeds` → `result.links[].linkid`, search → `result.items[].info.linkid`). Anonymous requests with a valid signature may still get **`status: "show_captcha"`** (empty `result`); behavior depends on Heybox server policy.

## License

GPL v3. See [LICENSE](./LICENSE).

## Acknowledgments

Built on these open-source projects:

### Core
- [**Tauri**](https://github.com/tauri-apps/tauri) - Cross-platform desktop framework
- [**Vue**](https://github.com/vuejs/core) - Progressive JS framework
- [**Vite**](https://github.com/vitejs/vite) - Build tool
- [**TypeScript**](https://github.com/microsoft/TypeScript) - Typed JS

### UI & tools
- [**Element Plus**](https://github.com/element-plus/element-plus) - Vue 3 component library
- [**Pinia**](https://github.com/vuejs/pinia) - State management
- [**Vue Router**](https://github.com/vuejs/router) - Routing
- [**Axios**](https://github.com/axios/axios) - HTTP client
- [**UnoCSS**](https://github.com/unocss/unocss) - Atomic CSS
- [**panzoom**](https://github.com/timmywil/panzoom) - Pan/zoom
- [**PhotoSwipe**](https://github.com/dimsemenov/PhotoSwipe) - Image viewer (Vue rewrite in this project)

### Backend
- [**Rhai**](https://github.com/rhaiscript/rhai) - Script engine for plugins
- [**Serde**](https://github.com/serde-rs/serde) - Serialization
- [**Tokio**](https://github.com/tokio-rs/tokio) - Async runtime
- [**Reqwest**](https://github.com/seanmonstar/reqwest) - HTTP client
- [**Scraper**](https://github.com/causal-agent/scraper) - HTML parsing
- [**Rusqlite**](https://github.com/rusqlite/rusqlite) - SQLite
- [**Image**](https://github.com/image-rs/image) - Image processing
- [**FFmpeg**](https://ffmpeg.org/) / [**rsmpeg**](https://github.com/larksuite/rsmpeg) - Desktop video ingestion (in-process via rsmpeg)
- [**Prisma**](https://github.com/prisma/prisma) - DB schema docs

### Build
- [**Deno**](https://github.com/denoland/deno) - Runtime & package manager
- [**Tapable**](https://github.com/webpack/tapable) - Hooks
- [**Handlebars**](https://github.com/handlebars-lang/handlebars.js) - Templates

### References
- [**Lively**](https://github.com/rocksdanister/lively) - Desktop mount
- [**Clash Verge**](https://github.com/clash-verge-rev/clash-verge-rev) - Tray, config, Linux workarounds
- [**Pake**](https://github.com/tw93/pake) - Web-to-app
- [**LiveWallpaperMacOS**](https://github.com/thusvill/LiveWallpaperMacOS.git) - macOS wallpaper
- [**PixivCrawler**](https://github.com/CWHer/PixivCrawler) - Pixiv crawler (Rhai port)

### Vendored & patched (`third/`)

These upstream projects are vendored as Git submodules under `third/` and maintained with numbered patch series in `third-patches/`.

- [**CEF (Chromium Embedded Framework)**](https://github.com/chromiumembedded/cef) - Chromium browser engine embedded as the desktop WebView backend (branch 7827)
- [**cef-rs**](https://github.com/tauri-apps/cef-rs) - Rust bindings for CEF (tauri-apps fork, patched for flat subprocess path)
- [**deno**](https://github.com/denoland/deno) - V8-based JS runtime; `deno_core` crate drives the crawler plugin V8 backend and the self-built Deno CLI
- [**rusty_v8**](https://github.com/denoland/rusty_v8) - Rust bindings for V8; self-built for Android aarch64
- [**FFmpeg**](https://github.com/FFmpeg/FFmpeg) - Multimedia framework for desktop video ingestion (preview compression, dimension detection)
- [**x264**](https://code.videolan.org/videolan/x264) - H.264 encoder; statically linked by the FFmpeg build
- [**rsmpeg**](https://github.com/larksuite/rsmpeg) - Safe Rust wrapper for FFmpeg libav\*
- [**rusty_ffmpeg**](https://github.com/CCExtractor/rusty_ffmpeg) - FFmpeg bindgen helper used by rsmpeg
- [**tauri**](https://github.com/tauri-apps/tauri) - Cross-platform desktop framework; forked for `TAURI_ANDROID_PACKAGE`, top-level `bins` config, and other Kabegame-specific patches

If these help you, consider giving them a ⭐—it means a lot to open source!
