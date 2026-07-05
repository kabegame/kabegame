# V8 爬虫运行时

V8 后端仅在桌面启用，Android 仍使用 Rhai。

V8 插件导出 `crawl(common, custom)`。宿主能力统一通过全局 `Kabegame.*` 暴露，不再暴露 `__kabegame_*`，也不再提供 `@kabegame/plugin-sdk/host` 模块。

## 全局能力

- Web 平台：`URL` / `URLSearchParams`、`TextEncoder` / `TextDecoder`、`atob` / `btoa`、timer、`crypto`、`fetch` / `Request` / `Response` / `Headers`、`DOMParser`。
- 宿主桥：`Kabegame.to`、`back`、`currentUrl`、`currentHtml`、`currentDocument`、`currentHeaders`、`pluginData`、`setPluginData`、`setHeader`、`delHeader`、`warn`、`addProgress`、`downloadImage`、`createImageMetadata`。

## 迁移点

- 删除 V8 专属 `fetchJson`；JSON 请求使用 `await (await fetch(url)).json()`。
- `fetch` 会合并当前任务经 `Kabegame.setHeader()` 设置的请求头。
- `fetch` 不按当前页自动解析相对 URL；需要 `new URL(relative, await Kabegame.currentUrl())`。
- SDK 仅保留纯工具模块（`regex` / `md5` / `url` / `misc` / `types`），不再导出 `host` / `dom`。
