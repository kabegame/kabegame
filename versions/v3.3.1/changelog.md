# v3.3.1 changelog

## Added

- **Plugins / collect form:** `config.json` 变量类型 **`date`**：桌面与安卓收集对话框使用 Element Plus 日期选择器，值为 `YYYY-MM-DD` 字符串；应用语言与 Element Plus 组件语言通过根级 `el-config-provider` 对齐。见 `docs/README_PLUGIN_DEV.md`、`docs/RHAI_API.md`。
- **Crawler Rhai:** `re_replace_all(pattern, replacement, text)` — global regex replace using Rust `regex` (invalid pattern returns the original string); see `docs/RHAI_API.md` and `docs/CRAWLER_BACKENDS.md`.

## Fixed

- **Crawler Rhai:** Reqwest enables **gzip** decompression for plugin HTTP fetches so `to()` / `fetch_json()` store decoded HTML/CSS bodies instead of raw compressed bytes (fixes empty `query` / `get_attr` on gzip-only responses).

## Changed

- **Plugins:** Crawler plugins that rely on gzip-correct `to()` parsing or `re_replace_all` (e.g. wallpapers-craft) require **Kabegame 3.3.1+**.
- **Plugins:** Min version restriction for plugin.
