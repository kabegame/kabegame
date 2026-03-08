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
      add_progress(percentage) {
        return invoke("crawl_add_progress", { percentage });
      },
      // 统一下载 API：走 Rust download_worker，可选附加 cookie/header。
      download_image(url, opts) {
        const o = typeof opts === "object" && opts !== null ? opts : {};
        return invoke("crawl_download_image", {
          url,
          cookie: !!o.cookie,
          headers: o.headers ?? undefined,
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
      exit() {
        return invoke("crawl_exit");
      },
      error(message) {
        return invoke("crawl_error", { message: String(message ?? "") });
      },
    };
  }

  function bindApiToContext(ctx, api) {
    const desc = { writable: false, configurable: false, enumerable: true };
    for (const key of Object.keys(api)) {
      Object.defineProperty(ctx, key, { ...desc, value: api[key] });
    }
  }

  async function start() {
    let ctx;
    try {
      ctx = await invoke("crawl_get_context");
    } catch (_) {
      return;
    }
    if (!ctx || !ctx.crawlJs) return;
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
