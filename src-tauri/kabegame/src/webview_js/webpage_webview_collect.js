// 网页收集 WebView 后端入口。由 startup.rs::webpage_webview_crawl_js 与 page_discover.js（core builtin
// 载荷）、page_snapshot.js、webpage_collect.js（core 两后端公共编排）拼接后，填进 bootstrap.js 的
// crawl_js 槽位：运行在 bootstrap 的 async 闭包内，Kabegame 在作用域中，不挂 window 全局。
//
// Kabegame.vars = 任务 userConfig ∪ 宿主参数 { url, freeze, imageExtensions, videoExtensions, ... }。
// 身份只来自浏览器会话（Cookie / Referer），不读任务 httpHeaders（Rust 侧已要求为空）。

  const WEBPAGE_SCROLL_MAX_STEPS = 30;
  const WEBPAGE_SCROLL_MAX_MS = 20_000;
  const WEBPAGE_SCROLL_STABLE_ROUNDS = 3;
  const WEBPAGE_SCROLL_INTERVAL_MS = 600;

  function webpageSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function webpageDomReady() {
    if (document.readyState !== "loading") return Promise.resolve();
    return new Promise((resolve) =>
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }),
    );
  }

  // 增量滚动触发懒加载 / 瀑布流：文档高度连续 3 轮不变即停，最多 30 次或 20 秒，防止无限流永不结束。
  async function webpageAutoScroll() {
    const started = Date.now();
    let lastHeight = -1;
    let stableRounds = 0;
    for (let step = 0; step < WEBPAGE_SCROLL_MAX_STEPS; step += 1) {
      if (Date.now() - started >= WEBPAGE_SCROLL_MAX_MS) break;
      const scroller = document.scrollingElement || document.documentElement;
      const height = scroller ? scroller.scrollHeight : 0;
      if (height === lastHeight) {
        stableRounds += 1;
        if (stableRounds >= WEBPAGE_SCROLL_STABLE_ROUNDS) break;
      } else {
        stableRounds = 0;
        lastHeight = height;
      }
      window.scrollTo(0, height);
      await webpageSleep(WEBPAGE_SCROLL_INTERVAL_MS);
    }
    window.scrollTo(0, 0);
  }

  const webpageVars = Kabegame.vars || {};
  const webpageCtx = {
    sourceUrl: String(webpageVars.url || ""),
    imageExtensions: webpageVars.imageExtensions || [],
    videoExtensions: webpageVars.videoExtensions || [],
    freeze: webpageVars.freeze === true,
    log: (level, message) => Kabegame.log(message, level),
  };

  // bootstrap 每次整页导航都会重跑：页面跳转（重定向、挑战页通过）发生在收集前则在新页重新开始；
  // 已进入下载阶段后再导航，不重复收集。
  const webpageState = (await Kabegame.state()) || {};
  if (!webpageState.webpageStarted) {
    await webpageDomReady();
    await webpageAutoScroll();
    const discovery = discoverMedia({
      imageExtensions: webpageCtx.imageExtensions,
      videoExtensions: webpageCtx.videoExtensions,
    });
    let pageHtml = null;
    if (webpageCtx.freeze) {
      try {
        pageHtml = await snapshotPage();
      } catch (error) {
        webpageLog(webpageCtx, "warn", "taskLogWebpageSnapshotSkipped", {
          error: webpageErrorMessage(error),
        });
      }
    }
    await Kabegame.updateState({ webpageStarted: true });
    await webpageCollect(webpageCtx, {
      candidates: discovery.candidates,
      documentUrl: discovery.documentUrl,
      title: document.title || "",
      pageHtml,
      backend: "webview",
    });
  }
  await Kabegame.exit();
