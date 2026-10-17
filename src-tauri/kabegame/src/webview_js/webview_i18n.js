// 注入网页（畅游 / WebView 爬虫窗口）脚本的文案：页面加载时经 `get_webview_i18n` 取当前应用语言的
// `webview.*` 文案表，`t(key, params)` 按 `{name}` 替换占位符。须排在其它注入脚本之前。
(function () {
  if (window.__kb_i18n__) return;

  let messages = null;
  const ready = Promise.resolve()
    .then(() => window.__TAURI_INTERNALS__.invoke("get_webview_i18n", {}))
    .then((table) => {
      messages = table || {};
    })
    .catch((error) => {
      messages = {};
      console.warn("[kabegame] failed to load webview i18n:", error);
    });

  // 文案表未到（或缺 key）时退回 key 本身，避免抛错打断下载流程
  function t(key, params) {
    let text = messages && typeof messages[key] === "string" ? messages[key] : key;
    if (params) {
      for (const name of Object.keys(params)) {
        text = text.split(`{${name}}`).join(String(params[name]));
      }
    }
    return text;
  }

  Object.defineProperty(window, "__kb_i18n__", {
    value: Object.freeze({ t, ready }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
