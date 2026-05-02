(function () {
  "use strict";

  // 畅游外站页最早注入：统一处理新窗口/新标签行为，避免依赖 context_menu 加载顺序。
  // 1) window.open _blank → 当前窗口或下载
  // 2) <a target="_blank"> → 同上（不经过 window.open）

  function triggerDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function isDownloadUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      if (path.includes("/download") || path.includes("/download/")) return true;
      if (path.includes("workdrive-public/download")) return true;
      if (
        u.searchParams.has("download") ||
        u.searchParams.get("response-content-disposition") === "attachment"
      )
        return true;
      return false;
    } catch {
      return false;
    }
  }

  function isMediaOrArchiveUrl(url) {
    try {
      const path = new URL(url).pathname.toLowerCase().split("?")[0];
      return /\.(jpe?g|png|gif|webp|bmp|avif|tiff?|svg|mp4|mov|webm|mkv|avi|zip|rar|7z|tar|gz)$/.test(
        path,
      );
    } catch {
      return false;
    }
  }

  const originalOpen = window.open;
  window.open = function (url, name, specs) {
    if (url == null || typeof url !== "string") {
      if (name === "_blank" || name === "_new") return null;
      return originalOpen.call(window, url, name, specs);
    }
    try {
      const absolute = new URL(url, location.href).href;

      if (isDownloadUrl(absolute)) {
        triggerDownload(absolute);
        return null;
      }

      if (!name || name === "_blank" || name === "_new") {
        if (isMediaOrArchiveUrl(absolute)) {
          triggerDownload(absolute);
        } else {
          location.href = absolute;
        }
        return null;
      }
    } catch (_) {}

    return originalOpen.call(window, url, name, specs);
  };

  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented) return;
      const a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      const t = (a.getAttribute("target") || "").toLowerCase();
      if (t !== "_blank" && t !== "_new") return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      try {
        const absolute = new URL(href, location.href).href;
        if (!/^https?:\/\//i.test(absolute)) return;
        e.preventDefault();
        e.stopPropagation();
        if (isDownloadUrl(absolute)) {
          triggerDownload(absolute);
          return;
        }
        if (isMediaOrArchiveUrl(absolute)) {
          triggerDownload(absolute);
          return;
        }
        location.href = absolute;
      } catch (_) {}
    },
    true,
  );

  window.__kabegame_surf_triggerDownload = triggerDownload;
})();
