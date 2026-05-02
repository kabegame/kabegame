(function () {
  const _tauri = window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => _tauri.invoke(cmd, args || {});

  function createApi(ctx) {
    return {
      vars: Object.freeze(ctx.vars || {}),
      currentContext() {
        return ctx;
      },
      log(message, level) {
        return invoke("crawl_task_log", {
          message: String(message ?? ""),
          level: level ?? undefined,
        });
      },
      sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      addProgress(percentage) {
        return invoke("crawl_add_progress", { percentage });
      },
      // 统一下载 API：走 Rust download_worker。opts 为 plain object，可选键：
      // cookie、headers、name（展示名）、metadata（任意 JSON，与 Rhai opts 一致）。
      downloadImage(url, opts) {
        const o = typeof opts === "object" && opts !== null ? opts : {};
        return invoke("crawl_download_image", {
          url,
          cookie: !!o.cookie,
          headers: o.headers ?? undefined,
          name: o.name ?? undefined,
          metadata: o.metadata ?? undefined,
        });
      },
      async to(payload, opts) {
        if (typeof payload === "string") {
          payload = { url: payload, ...(opts || {}) };
        }
        return invoke("crawl_to", { payload });
      },
      async back(count) {
        return invoke("crawl_back", { count: count ?? 1 });
      },
      // 更新页面状态：同步更新 Rust 内存与当前 ctx.pageState（Object.assign 式合并）
      // 必须传入plain object，不能传入复杂对象，否则会丢失信息。
      // 更新能够反应到state对象上
      async updatePageState(patch) {
        const p = JSON.parse(JSON.stringify(patch ?? {}));
        await invoke("crawl_update_page_state", { patch: p });
        Object.assign(ctx.pageState, p);
      },
      // 更新整个任务上下文状态：同步更新 Rust 内存与当前 ctx.state（Object.assign 式合并），ctx.state 获取
      async updateState(patch) {
        const p = JSON.parse(JSON.stringify(patch ?? {}));
        await invoke("crawl_update_state", { patch: p });
        if (!ctx.state) ctx.state = {};
        Object.assign(ctx.state, p);
      },
      $(selector) {
        return document.querySelector(selector);
      },
      $$(selector) {
        return Array.from(document.querySelectorAll(selector));
      },
      waitForDom() {
        if (document.readyState !== "loading") return Promise.resolve();
        return new Promise((r) =>
          document.addEventListener("DOMContentLoaded", r, { once: true })
        );
      },
      /**
       * 轮询查询 DOM，直到选择器匹配到元素后 resolve 返回该元素。
       * @param {string} selector - CSS 选择器
       * @param {{ timeout?: number, interval?: number }} [opts] - timeout: 超时 ms，超时后 reject；interval: 轮询间隔 ms，默认 200
       * @returns {Promise<Element>} 匹配到的元素
       */
      waitForSelector(selector, opts = {}) {
        const intervalMs = opts.interval ?? 200;
        const timeoutMs = opts.timeout;
        return new Promise((resolve, reject) => {
          const el = document.querySelector(selector);
          if (el) {
            resolve(el);
            return;
          }
          let elapsed = 0;
          const t = setInterval(() => {
            const node = document.querySelector(selector);
            if (node) {
              clearInterval(t);
              resolve(node);
              return;
            }
            elapsed += intervalMs;
            if (timeoutMs != null && elapsed >= timeoutMs) {
              clearInterval(t);
              reject(new Error(`waitForSelector("${selector}") 超时 ${timeoutMs}ms`));
            }
          }, intervalMs);
        });
      },
      exit() {
        return invoke("crawl_exit");
      },
      error(message) {
        return invoke("crawl_error", { message: String(message ?? "") });
      },
      // 请求显示爬虫 WebView 窗口（例如在挑战页让用户手动通过验证）
      requestShowWebview() {
        return invoke("show_crawler_window");
      },
      // 清空当前站点数据：localStorage、sessionStorage，以及该站点的 Cookie（由 Rust 按当前页 URL 清除）
      async clearData() {
        localStorage.clear();
        sessionStorage.clear();
        return invoke("crawl_clear_site_data", {
          url: window.location.href,
        });
      }
    };
  }

  function bindApiToContext(ctx, api) {
    const desc = { writable: false, configurable: false, enumerable: true };
    for (const key of Object.keys(api)) {
      Object.defineProperty(ctx, key, { ...desc, value: api[key] });
    }
  }

  async function start() {
    if (window.__crawl_starting__) return;
    window.__crawl_starting__ = true;
    let ctx;
    try {
      ctx = await invoke("crawl_get_context");
    } catch (_) {
      return;
    }
    if (!ctx || !ctx.crawlJs) return;
    if (!ctx.state) ctx.state = {};
    await invoke("crawl_page_ready");

    bindApiToContext(ctx, createApi(ctx));
    Object.defineProperty(window, "__crawl_ctx__", {
      value: ctx,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    await invoke("crawl_run_script");
  }

  delete window.__TAURI_INTERNALS__;
  start().catch((e) => {
    console.error("[crawler-bootstrap] failed:", e);
  });
})();
