# Kabegame V8 Runtime

V8 crawler plugins run only on desktop. Android keeps the Rhai backend.

Plugin entry code must export `crawl(common, custom)`. Host capabilities are exposed through the single global `Kabegame` namespace:

- `Kabegame.to`, `Kabegame.back`
- `Kabegame.currentUrl`, `Kabegame.currentHtml`, `Kabegame.currentDocument`, `Kabegame.currentHeaders`
- `Kabegame.pluginData`, `Kabegame.setPluginData`
- `Kabegame.setHeader`, `Kabegame.delHeader`, `Kabegame.warn`, `Kabegame.addProgress`
- `Kabegame.downloadImage`, `Kabegame.createImageMetadata`

The runtime also installs Web platform globals from deno extensions: `URL`, `URLSearchParams`, text encoding, base64 helpers, timers, `crypto`, and `fetch` with `Request` / `Response` / `Headers`. `fetchJson` and `@kabegame/plugin-sdk/host` are intentionally removed; use standard `fetch`:

```ts
const data = await (await fetch(url)).json();
```

`fetch` merges task request headers set through `Kabegame.setHeader()`. It does not resolve relative URLs against the current page, so plugins should use `new URL(relative, await Kabegame.currentUrl())` when needed.
