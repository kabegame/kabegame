# WebView 插件参考

权威来源：bootstrap `src-tauri/kabegame/src/webview_js/bootstrap.js`（`Kabegame` 对象定义及注释）、
`docs/PLUGIN_FORMAT.md`、`cocs/crawler/CRAWLER_JS_FLOW.md`。完整范例：`plugins/xhs-webview/crawl.js`。

## 和 V8 的根本区别：每次导航都重跑整份脚本

WebView 插件是一份**不经打包**的 `crawl.js`（`"main": "crawl.js"`, `"kbBackend": "webview"`），
被注入到任务专属的浏览器窗口里。**每次页面加载都会从头执行一遍**，所以：

- 没有 `crawl(common, custom)` 函数；脚本顶层直接 `await main()`。
- 配置值从 `Kabegame.vars` 读（任务创建时烘焙，静态）。
- 跨导航的状态只能存在宿主：`await Kabegame.updateState({...})` 写、`await Kabegame.state()` 读（任务级）；
  `updatePageState` / `pageState()` 是单页级。JS 变量在导航后全部丢失。
- 用 `Kabegame.to(url, { pageLabel: "list" })` 导航并给新页打标签；新页里用
  `await Kabegame.pageLabel()` 分派阶段（初始页的标签是 `"initial"`）。
- 结束必须 `await Kabegame.exit()`（会等待未完成的下载）；出错用 `Kabegame.error(msg)`。
  忘了 exit，任务会一直挂着。
- `Kabegame` 是闭包局部常量，不挂在 `window` 上。

`package.json` 其余字段同 V8（见 v8.md），去掉 `scripts.build` 和 rspack 相关依赖。只支持桌面。

## 常用 API

| API | 用途 |
|---|---|
| `Kabegame.vars` | kbConfig 合并值 |
| `await Kabegame.pageLabel()` / `state()` / `updateState(patch)` | 阶段分派与跨页状态 |
| `await Kabegame.to(url, { pageLabel })` / `back(n)` | 导航（当前 JS 上下文随之销毁） |
| `await Kabegame.waitForDom()` / `waitForSelector(css, { timeout })` | 等渲染；SPA 一律 `waitForSelector` |
| `Kabegame.$(css)` / `$$(css)` | 当前真实 DOM |
| 页面里的 `fetch` | 浏览器原生 fetch：同源自动带登录 Cookie，跨域受 CORS 限制 |
| `await Kabegame.downloadImage(url, opts)` | 同 V8；也接受 VFS 虚拟路径 |
| `Kabegame.fetchToFile(url, vfsPath, init)` | 用页面上下文把资源落到任务 VFS（适合需要页面 Cookie 的媒体） |
| `Kabegame.onNativeDownload(cb)` | 页面自己触发的原生下载；**每页顶层重新注册** |
| `Kabegame.requestShowWebview()` | 把爬虫窗口显示出来（需要用户手动登录或过验证时） |
| `await Kabegame.log(msg)` / `warn(msg)` / `addProgress(pct)` / `sleep(ms)` | 日志、进度、等待 |
| `Kabegame.fs`（异步子集，`getRoot()` 返回 Promise）/ `archive` / `ffmpeg` | 见 bootstrap |

## 骨架

```js
const log = (m) => Kabegame.log(`[my-site] ${m}`);

async function handleInitial() {
  const keyword = String(Kabegame.vars?.keyword ?? "").trim();
  if (!keyword) { await Kabegame.warn("请填写关键词"); return Kabegame.exit(); }
  await Kabegame.updateState({ maxItems: Number(Kabegame.vars?.max_items ?? 20) });
  await Kabegame.to(`https://site.example/search?q=${encodeURIComponent(keyword)}`, { pageLabel: "list" });
}

async function handleList() {
  const { maxItems } = await Kabegame.state();
  await Kabegame.waitForSelector(".result-item", { timeout: 20000 });     // ← 第 2 步实测
  const items = Kabegame.$$(".result-item a[href]").slice(0, maxItems).map((a) => a.href);
  await log(`列表 ${items.length} 条`);
  for (const [i, url] of items.entries()) {
    try {
      // 同源详情页直接 fetch，省掉一次导航（导航会重跑脚本、丢失循环状态）
      const html = await (await fetch(url)).text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const img = doc.querySelector("img.original")?.getAttribute("src"); // ← 第 2 步实测
      if (img) await Kabegame.downloadImage(new URL(img, url).href, { url });
    } catch (e) {
      await Kabegame.warn(`失败 ${url}: ${e?.message ?? e}`);
    }
    Kabegame.addProgress(100 / items.length);
  }
  await Kabegame.exit();
}

async function main() {
  try {
    const label = await Kabegame.pageLabel();
    await log(`▶ 页面加载 · 阶段=${label} · ${location.href}`);   // 排障时判断卡在哪个阶段
    if (label === "initial") return await handleInitial();
    if (label === "list") return await handleList();
    await Kabegame.exit();
  } catch (e) {
    await Kabegame.warn(`插件运行失败：${e?.message ?? e}`);
    await Kabegame.exit();
  }
}

await main();
```

## 调试真实页面

任务运行中可以用 `kabegame-chromium` 连到 `crawler-<taskId>` 窗口：`targets` 列出窗口，
`eval '<js>' --url crawler` 执行脚本，`shot <png> --url crawler` 截图。选择器先在这里对真实 DOM
验证，再写进 `crawl.js`。注意：playwright 连接会劫持页面触发的下载，测试 `onNativeDownload`
时参考 kabegame-chromium SKILL.md 的 Gotchas。
