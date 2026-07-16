// Kabegame WebView 爬虫运行环境模板。
//
// 本文件不是直接注入的脚本，而是由 Rust（create_crawler_window）在建窗时做
// 模板替换后，作为该任务窗口的 initialization_script 注入。两个占位符各只出现一次
// （见下方 Object.freeze(...) 的 vars 位与 async 执行块内的 crawl 位），分别替换为：
// 该任务 merged_config 的 JSON 字面量、插件 crawl.js 全文。切勿在别处（含本注释）
// 再写出这两个占位符字面量——Rust 用 str::replace 全量替换，重复会插错位置。
// 替换后是一段一次性闭包（IIFE），每次页面加载在 document-start 自执行：
//   1. 顶层帧才运行（iframe 直接返回，避免在子帧里重复跑爬虫脚本）；
//   2. 捕获 __TAURI_INTERNALS__ 到闭包内并从 window 删除，避免站点探测；
//   3. 在闭包内构造 Kabegame（不挂到 window，站点无法枚举）；
//   4. 直接执行插件 crawl.js（不再 crawl_get_context / crawl_page_ready /
//      crawl_run_script 三次乒乓，也不需要 window.__crawl_ctx__ 全局）。
//
// 与 V8 后端（Kabegame.*）功能相似的接口尽量同名；差异（真实 document、按页
// 重跑的生命周期、pageState/state 需按调用经 invoke 取）是 WebView 后端固有的。
// 扩展 api 要同步维护 permissions/crawler.toml。
(function () {
  // 仅在顶层帧运行：initialization_script 会注入到每个帧，爬虫脚本只应在主帧执行。
  if (window.top !== window.self) return;

  const _tauri = window.__TAURI_INTERNALS__;
  if (!_tauri) return;
  const invoke = (cmd, args) => _tauri.invoke(cmd, args || {});
  // 从 window 上摘掉 Tauri 内部对象，站点脚本无法据此判断处于爬虫环境。
  // media_capture.js / media_download.js 在本脚本之前注入并已各自捕获引用，不受影响。
  try {
    delete window.__TAURI_INTERNALS__;
  } catch (_) {}

  // Kabegame 是闭包局部常量，crawl.js 被模板进同一闭包内即可直接引用；
  // 不挂到 window，避免站点通过全局检测。
  const Kabegame = Object.freeze({
    // 该任务的 merged_config（静态，建窗时烘焙）。
    vars: Object.freeze(__KB_VARS_JSON__),
    // 每页动态状态：按需经 invoke 单独获取（不做一次性上下文拉取）。
    pageLabel() {
      return invoke("crawl_get_page_label");
    },
    pageState() {
      return invoke("crawl_get_page_state");
    },
    state() {
      return invoke("crawl_get_state");
    },
    log(message, level) {
      return invoke("crawl_task_log", {
        message: String(message ?? ""),
        level: level ?? undefined,
      });
    },
    // 与 V8 后端 Kabegame.warn 同名对齐。
    warn(message) {
      return invoke("crawl_task_log", {
        message: String(message ?? ""),
        level: "warn",
      });
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    addProgress(percentage) {
      return invoke("crawl_add_progress", { percentage });
    },
    // 统一下载 API：走 Rust download_worker。opts 为 plain object，可选键：
    // cookie、headers、name（展示名）、metadata（任意 JSON）、url（source url）。
    // metadata 版本（plugin_version）由应用自动盖章，插件不可传入。
    async downloadImage(url, opts) {
      const rawUrl = String(url ?? "");
      if (/^data:/i.test(rawUrl) || /^blob:/i.test(rawUrl)) {
        return window.__kb_media_download__(rawUrl, opts);
      }
      const o = typeof opts === "object" && opts !== null ? opts : {};
      return invoke("crawl_download_image", {
        url: rawUrl,
        cookie: !!o.cookie,
        headers: o.headers ?? undefined,
        name: o.name ?? undefined,
        metadata: o.metadata ?? undefined,
        source_url: o.url ?? undefined,
        sourceUrl: o.url ?? undefined,
      });
    },
    // 导航到新页面；payload 可为字符串 url，opts 合并 pageLabel/pageState。
    // 导航后当前页 JS 上下文销毁、新页重跑本模板（按页重跑生命周期）。
    async to(payload, opts) {
      if (typeof payload === "string") {
        payload = { url: payload, ...(opts || {}) };
      }
      return invoke("crawl_to", { payload });
    },
    async back(count) {
      return invoke("crawl_back", { count: count ?? 1 });
    },
    // 更新当前页 page_state（Rust 侧 Object.assign 浅合并），返回合并后的 page_state；
    // 无本地缓存，需要最新值就用返回值或再次 Kabegame.pageState()。
    async updatePageState(patch) {
      const p = JSON.parse(JSON.stringify(patch ?? {}));
      return invoke("crawl_update_page_state", { patch: p });
    },
    // 更新整个任务 state（浅合并），返回合并后的 state。
    async updateState(patch) {
      const p = JSON.parse(JSON.stringify(patch ?? {}));
      return invoke("crawl_update_state", { patch: p });
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
    },
  });

  // 直接执行插件 crawl.js（模板进本闭包，Kabegame 在作用域内）；
  // 异常统一上报 Kabegame.error，任务转为失败/取消。
  (async function () {
    try {
/*__KB_CRAWL_JS__*/
    } catch (e) {
      let detail;
      if (e && typeof e === "object") {
        const msg = e.message || "";
        const stack = e.stack || "";
        detail = msg ? (msg + (stack ? "\n" + stack : "")) : (stack || String(e));
      } else {
        detail = String(e);
      }
      try {
        await Kabegame.error(detail);
      } catch (_) {
        console.error("[crawler-bootstrap] script error:", detail);
      }
    }
  })();
})();
