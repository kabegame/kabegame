// Surf 内容页 URL 上报:SPA 导航(pushState/replaceState/popstate/hashchange)
// 不触发 page load,Rust 侧 on_page_load 感知不到,导航栏地址会停在旧值。
// 这里在 URL 变化时上报 surf_report_url,由后端转发给导航栏。
(function () {
  if (window.__kb_url_report__) return;
  window.__kb_url_report__ = true;

  var lastReported = "";

  function report() {
    var href = "";
    try {
      href = String(location.href || "");
    } catch (_) {
      return;
    }
    if (!/^https?:/i.test(href)) return;
    if (href === lastReported) return;
    lastReported = href;
    try {
      var tauri = window.__TAURI_INTERNALS__;
      if (!tauri || typeof tauri.invoke !== "function") return;
      tauri.invoke("surf_report_url", { url: href }).catch(function () {});
    } catch (_) {}
  }

  function wrapHistory(name) {
    try {
      var orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function () {
        var result = orig.apply(this, arguments);
        report();
        return result;
      };
    } catch (_) {}
  }

  wrapHistory("pushState");
  wrapHistory("replaceState");
  window.addEventListener("popstate", function () {
    report();
  });
  window.addEventListener("hashchange", function () {
    report();
  });
  document.addEventListener("DOMContentLoaded", function () {
    report();
  });
  report();
})();
