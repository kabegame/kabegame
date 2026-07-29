# Kabegame — Anime Crawler Client

> *Translated by AI. [中文](README.md) | English | [日本語](README.ja.md) | [한국어](README.ko.md)*

A Tauri-based anime crawler client! Crawl, organize, and set/rotate wallpapers—let your waifus (or husbandos) keep you company every day~ Plugin-extensible, so you can easily grab resources from all kinds of anime sites.

> 📖 **Full documentation**: [https://kabegame.com](https://kabegame.com/)

> 🌐 **Live demo**: [https://demo.kabegame.com](https://demo.kabegame.com/)

<div align="center">
  <img src="docs/images/icon.png" alt="Kabegame" width="256"/>
</div>

<table width="100%">
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-main.png" alt="Kabegame gallery" width="100%"/><br/>
      <small>Gallery</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-preview.png" alt="Kabegame image preview" width="100%"/><br/>
      <small>Preview</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-detail.jpg" alt="Kabegame detailed metadata" width="100%"/><br/>
      <small>Detailed metadata</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-filters.jpg" alt="Kabegame gallery filtering" width="100%"/><br/>
      <small>Flexible filtering</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/album/album-main.jpg" alt="Kabegame album organization" width="100%"/><br/>
      <small>Album organization</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/album/album-folder.jpg" alt="Kabegame folder sync" width="100%"/><br/>
      <small>Folder sync</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/source/source-main.jpg" alt="Kabegame source plugin list" width="100%"/><br/>
      <small>Source plugin list</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/source/source-doc.jpg" alt="Kabegame source plugin documentation" width="100%"/><br/>
      <small>Source plugin documentation</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/crawler/crawler-config.jpg" alt="Kabegame task parameter configuration" width="100%"/><br/>
      <small>Configure task parameters</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/crawler/crawler-start.jpg" alt="Kabegame task execution" width="100%"/><br/>
      <small>Start task</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/crawler/task-images.jpg" alt="Kabegame task images" width="100%"/><br/>
      <small>Task images</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/crawler/task-log.jpg" alt="Kabegame task logs" width="100%"/><br/>
      <small>Task logs (quick troubleshooting)</small>
    </td>
  </tr>
</table>

## Key Features

- 🔌 **Crawler client**: Crawl wallpapers from various sites via `.kgpg` plugins, with a built-in plugin store to browse/install/manage them; since 4.3.0, all plugins current at release time are bundled with the app. Plugins are written in JS/TS and run on the V8 (deno_core) or WebView backend.
- 🎨 **Wallpaper setter (images/videos)**: Collect, manage, and rotate anime wallpapers, automatically switching your desktop wallpaper from a chosen album.
- 🖼️ **Image manager**: Gallery browsing, album organization, virtual disk, drag-and-drop import, and folder-to-album sync.
- 🧩 **MCP organizing**: Open an MCP server and let external AI agents help organize your wallpapers under fine-grained permissions.

Supports Windows, macOS, Linux, and Android (iOS is not supported).

## You Might Be Interested
Maybe anime wallpapers and crawlers aren't your thing, but a few of the technical innovations in this app might catch your eye
- A Tauri-based Webview crawler [WebviewHandler](./src-tauri/kabegame-core/src/crawler/webview.rs)
- An in-house Tauri runtime [tauri-runtime-cef](./src-tauri/tauri-runtime-cef/)
  It's heavily tailored for Kabegame, so it isn't published as a crate—you can have AI port it into your own project.
- An in-house path-folding query engine [PathQL](./src-tauri/pathql-rs/)
  In short: I built a parser called the Provider DSL along with a URL-path-based query syntax. Most of the app's image queries have already been turned into [Provider DSL JSON5 format](./src-tauri/kabegame-core/src/providers/dsl/), and these JSON files decide how the PathQL engine folds queries. Say you want to query all videos from June 2026—the query looks like:
    ```url
    images://hide/media-type/video/filter_comb/date/2026y/06m/filter_comb/sort/by-id/1
    ```
  If you're interested in this query engine, feel free to file an issue and I'll flesh out the docs.
  In theory it could be published as a crate, but there are probably still some edge-case bugs I haven't ferreted out, so you could also have AI copy it into your project (mind you, GPL-3.0).

## Download & Install

Head to **[GitHub Releases](https://github.com/kabegame/kabegame/releases/latest)** to download the installer for your platform.

For per-platform install steps, virtual disk dependencies, and data directory details, see the docs: **[Installation & First Launch](https://kabegame.com/guide/installation/)**.

## Documentation

The full documentation lives at **[kabegame.com](https://kabegame.com/)**:

- [User Guide](https://kabegame.com/guide/installation/) — installation, gallery, albums, wallpapers, virtual disk, MCP, and more.
- [Plugin Development](https://kabegame.com/dev/overview/) — writing V8 / WebView crawler plugins, the `.kgpg` format, packaging and publishing.
- [Contributing](https://kabegame.com/dev-contrib/building/) — building from source, Android development, architecture and tech stack, credits and bundled dependencies.
- [CLI Tool](https://kabegame.com/reference/cli/) and [API Reference](https://kabegame.com/reference/kabegame-api/).

Crawler plugin repository: **[kabegame/crawler-plugins](https://github.com/kabegame/crawler-plugins)** (plugin contributions welcome!)

## License

The source code is licensed under [GPL v3](./LICENSE).

## Origin of the Name 🐢

**Kabegame** is the romanization of the Japanese「壁亀」(かべがめ), which sounds close to「壁紙」(かべがみ, "wallpaper")~ Like a quiet little turtle perched on your desktop, silently guarding your anime wallpaper collection. Embrace open source and build software by and for anime fans.
