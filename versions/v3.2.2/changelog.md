# v3.2.2 changelog

## Added

- linux plasma plugin for plasma video wallpaper

## Fixed

- linux install fail because of ffmpeg name conflict
- some plugin name i18n object bug
- local import fail bug
- linux video wallpaper cause kabegame crash bug
- **Thumbnail MIME for video:** Server was sending `Content-Type: video/mp4` when serving video thumbnails (GIF/JPG), so the browser could not render them in `<img>`. Thumbnail endpoint now infers MIME from the thumbnail file path. On Linux, video thumbnail load failure no longer falls back to the original MP4 URL in the image loader.
- Linux wayland use X11 GDK_BACKEND
- Random wallpaper rotation could get stuck alternating between only two images (e.g. after task export); fixed by replacing time-based modulo with splitmix64 mixing so index selection is uniform on Windows (100ns clock resolution).
