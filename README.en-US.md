# Kabegame — Anime Crawler Client

> *Translated by AI. [中文](README.md) | English | [日本語](README.ja.md) | [한국어](README.ko.md)*

A Tauri-based anime crawler client! Crawl, organize, and set/rotate wallpapers—let your waifus (or husbandos) keep you company every day~ Plugin-extensible, so you can easily grab resources from all kinds of anime sites.

📖 **Full documentation**: [https://kabegame.com](https://kabegame.com/)

🌐 **Live demo**: [https://demo.kabegame.com](https://demo.kabegame.com/)

A few [technical innovations](#you-might-be-interested) worth a paper.

> I understood: anime needs storytelling, so I added plugin metadata, which lets you read the post comments from when the images were crawled.

> I got it: anime needs novelty, so I added random sorting and automatic scheduled crawling, so you can have beautiful images that change every day.
> - Why wallpapers? You may never have noticed, but most people spend most of their time looking at wallpapers. In psychology, a wallpaper directly affects a person's mood, just as a messy or tidy room does. A good-looking wallpaper lifts your spirits and may even help you live longer.
> - Why rotation? Because of aesthetic fatigue: look at something good long enough and it becomes part of the environment; people automatically filter out the noise in their environment and subjectively stop perceiving it as beautiful. Rotation keeps you looking forward to new wallpapers and keeps your desktop fresh, so you stay in a good mood.

> I realized anime can't be separated from edgy, spicy content, so I
>  - actively introduced R18 plugins, plus MCP (which lets AI help you gather a set of a character's spicy images into one album).
>  - also built image metadata loading and advanced combined search, just so you can quickly find the character you like, or quickly filter out images that carry an AI prompt.
>  - also built folder albums, so that the images you generate are automatically imported into Kabegame.

> AI image generation is the key that opens the door from 3D reality to 2D anime. With it, even if you can't draw, you can create your own 2D world instead of being confined to others' creations. You may never have thought about it: the characters you love were actually created by someone else—maybe a white-collar worker at a big company, maybe a balding programmer. AI image generation, for the first time, grants everyone the ability to create their own 2D world, making our own anime possible and letting every one of us take part, instead of being just a spectator.

<div align="center" style="line-height: 3em">
  <b>Striving only to make software that belongs to the world of anime.</b>
</div>

<div align="center">
  <img src="docs/images/icon.png" alt="Kabegame" width="256"/>
</div>

<p align="center">
  <a href="https://github.com/kabegame/kabegame/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/kabegame/kabegame?style=flat-square&sort=semver&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/releases">
    <img alt="Total downloads" src="https://img.shields.io/github/downloads/kabegame/kabegame/total?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/stargazers">
    <img alt="GitHub Stars" src="https://img.shields.io/github/stars/kabegame/kabegame?style=flat-square&logo=github" height="20"/>
  </a>
  <a href="https://github.com/kabegame/kabegame/blob/main/LICENSE">
    <img alt="License" src="https://img.shields.io/github/license/kabegame/kabegame?style=flat-square" height="20"/>
  </a>
  <a href="https://kabegame.com">
    <img alt="Project docs" src="https://img.shields.io/badge/docs-kabegame.com-2f80ed?style=flat-square" height="20"/>
  </a>
  <br/>
  <a href="https://kabegame.com/guide/installation/">
    <img alt="Supported platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-5c6bc0?style=flat-square" height="20"/>
  </a>
  <a href="https://v2.tauri.app/">
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" height="20"/>
  </a>
  <a href="https://vuejs.org/">
    <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42B883?style=flat-square&logo=vuedotjs&logoColor=white" height="20"/>
  </a>
</p>

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
      <img src="docs/images/gallery/gallery-detail2.jpg" alt="Kabegame detailed metadata" width="100%"/><br/>
      <small>Detailed metadata</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/gallery/gallery-filters2.jpg" alt="Kabegame gallery filtering" width="100%"/><br/>
      <small>Flexible filtering</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/album/album-main2.jpg" alt="Kabegame album organization" width="100%"/><br/>
      <small>Album organization</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/album/album-folder2.jpg" alt="Kabegame folder sync" width="100%"/><br/>
      <small>Folder sync</small>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/source/source-main.jpg" alt="Kabegame source plugin list" width="100%"/><br/>
      <small>Source plugin list</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/source/source-doc2.jpg" alt="Kabegame source plugin documentation" width="100%"/><br/>
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
      <img src="docs/images/crawler/task-images2.jpg" alt="Kabegame task images" width="100%"/><br/>
      <small>Task images</small>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/crawler/task-log2.jpg" alt="Kabegame task logs" width="100%"/><br/>
      <small>Task logs (quick troubleshooting)</small>
    </td>
  </tr>
</table>

## Key Features

- 🔌 **Crawler client**: Crawl wallpapers from various sites via `.kgpg` plugins, with a built-in plugin store to browse/install/manage them; since 4.3.0, all plugins current at release time are bundled with the app. Plugins are written in JS/TS and run on the V8 (deno_core) or WebView backend.
- 🎨 **Wallpaper setter (images/videos)**: Collect, manage, and rotate anime wallpapers, automatically switching your desktop wallpaper from a chosen album.
- 🖼️ **Image manager**: Gallery browsing, automatic tag classification, album organization, virtual disk, drag-and-drop import, and folder-to-album sync.
- 🧩 **MCP organizing**: Open an MCP server and let external AI agents help organize your wallpapers under fine-grained permissions.

Supports Windows, macOS, Linux, and Android (v4.3.0 and earlier; newer versions are still being adapted).

## You Might Be Interested
Maybe anime wallpapers and crawlers aren't your thing, but a few of the technical innovations in this app might catch your eye
- A Tauri-based Webview crawler [WebviewHandler](./src-tauri/kabegame-core/src/crawler/webview.rs)
- An in-house Tauri runtime [tauri-runtime-cef](./src-tauri/tauri-runtime-cef/)
  It's heavily tailored for Kabegame, so it isn't published as a crate—you can have AI port it into your own project.
- An in-house path-folding query engine [PathQL](./src-tauri/pathql-rs/)
  In short: I built a parser called the Provider DSL along with a URL-path-based query syntax. Most of the app's image queries have already been turned into [Provider DSL JSON5\YAML format](./src-tauri/kabegame-core/src/providers/dsl/), and these DSL files decide how the PathQL engine folds queries. For example, to exclude images whose metadata contains adult keywords in the gallery and show only yande.re images with a landscape aspect ratio from 4:3 to 16:9 in random order, the query looks like:
    ```url
    images://gallery/hide/~not/~any/search/metadata/pussy/~or/search/native-metadata/pussy/~end/~end/~not/~any/search/metadata/penis/~or/search/native-metadata/penis/~end/~end/~not/~any/search/metadata/sex/~or/search/native-metadata/sex/~end/~end/~not/~any/search/metadata/r18/~or/search/native-metadata/r18/~end/~end/plugin/yandere/_kb_fc/aspect/4x3-16x9/_kb_fc/sort/random-7041412897802809
    ```
  This path means: query only non-hidden yande.re images; neither the business metadata nor the image's native metadata may contain any of the keywords `pussy`, `penis`, `sex`, or `r18`; and the aspect ratio must be greater than 4:3 and no more than 16:9; finally, sort the results randomly with a fixed seed.
  If you're interested in this query engine, feel free to file an issue and I'll flesh out the docs.
  In theory it could be published as a crate, but there are probably still some edge-case bugs I haven't ferreted out, so you could also have AI copy it into your project (mind you, GPL-3.0).

## Download & Install

Head to **[GitHub Releases](https://github.com/kabegame/kabegame/releases/latest)** to download the main app for your platform (`kabegame-cli` is a separate, optional tool that is not installed with the main app):

| Platform | Download | Install steps |
| --- | --- | --- |
| Windows x64 | `Kabegame-standard_<version>_x64-setup.exe` | Double-click the installer and follow the wizard. To use the album virtual disk, when you first enable the "Album Drive" in the app settings, allow the app to install the bundled Dokan 2.x driver when prompted; enable it once more after the driver is installed. |
| macOS (Apple silicon) | `Kabegame-standard_<version>_aarch64.dmg` | Open the DMG and drag `Kabegame.app` into "Applications". The installer is unsigned; if the first launch says the app is "damaged" or the developer cannot be verified, run the `xattr` command below in Terminal and open it again. Requires macOS 11 or later. |
| Linux amd64 | `Kabegame-standard_<version>_amd64.deb` | Run the `apt install` command below in your download directory; it also installs `fuse3`, which the album virtual disk needs. |
| Android (v4.3.0 and earlier only) | `Kabegame_<version>_android-preview.apk` | Allow your browser or file manager to "install unknown apps" in system settings, then tap the APK and install it following the prompts. Requires Android 8.0 or later; the new Android client is still being adapted. |

Removing the quarantine flag on first launch on macOS:

```bash
xattr -d com.apple.quarantine /Applications/Kabegame.app
```

To use the album virtual disk on macOS, also install macFUSE; after installation, approve the extension as the system prompts, and reboot if necessary:

```bash
brew install --cask macfuse
```

Linux installation (first `cd` into the directory containing the installer in Terminal):

```bash
sudo apt install ./Kabegame-standard_*_amd64.deb
```

After installation, just launch Kabegame. Images are saved by default in `Pictures/Kabegame` under your user Pictures directory, and uninstalling the app will not delete them.

## Documentation

The full documentation lives at **[kabegame.com](https://kabegame.com/)** (it may be somewhat out of sync after 4.4.0):

- [User Guide](https://kabegame.com/guide/installation/) — installation, gallery, albums, wallpapers, virtual disk, MCP, and more.
- [Plugin Development](https://kabegame.com/dev/overview/) — writing V8 / WebView crawler plugins, the `.kgpg` format, packaging and publishing.
- [Contributing](https://kabegame.com/dev-contrib/building/) — building from source, Android development, architecture and tech stack, credits and bundled dependencies. (Add me on QQ: 2905432378)
- [CLI Tool](https://kabegame.com/reference/cli/) and [API Reference](https://kabegame.com/reference/kabegame-api/).

Crawler plugin repository: **[kabegame/crawler-plugins](https://github.com/kabegame/crawler-plugins)** (looking for more plugins!)

## License

The source code is licensed under [GPL v3](./LICENSE). (Open source is the ultimate answer.)

## Origin of the Name 🐢

**Kabegame** is the romanization of the Japanese「壁亀」(かべがめ), which sounds close to「壁紙」(かべがみ, "wallpaper")~ Like a quiet little turtle perched on your desktop, silently guarding your anime wallpaper collection. Embrace open source and build software by and for anime fans.
