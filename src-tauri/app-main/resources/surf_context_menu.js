(function () {
  "use strict";

  function getMediaInfo(target) {
    if (target.tagName === "VIDEO" && target.currentSrc) {
      return { url: target.currentSrc, kind: "video" };
    }
    if (target.tagName === "VIDEO" && target.src) {
      return { url: target.src, kind: "video" };
    }
    if (target.tagName === "SOURCE" && target.src) {
      const parentTag = target.parentElement && target.parentElement.tagName;
      return { url: target.src, kind: parentTag === "VIDEO" ? "video" : "image" };
    }
    if (target.tagName === "IMG" && target.src) return target.src;
    const bg = target.style && target.style.backgroundImage;
    if (bg) {
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) return m[1];
    }
    const parent =
      target.closest && target.closest('[style*="background-image"]');
    if (parent) {
      const m2 = parent.style.backgroundImage.match(
        /url\(["']?([^"')]+)["']?\)/,
      );
      if (m2) return m2[1];
    }
    return null;
  }

  function toAbsolute(url) {
    if (url.startsWith("data:") || url.startsWith("blob:")) return url;
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  function triggerDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  let menu = null;

  function hide() {
    if (menu) {
      menu.style.display = "none";
    }
  }

  function show(x, y, mediaUrl, mediaKind) {
    if (!menu) {
      menu = document.createElement("div");
      menu.style.cssText =
        "position:fixed;z-index:2147483647;min-width:120px;padding:4px 0;" +
        "background:#fff;border:1px solid #d0d0d0;border-radius:6px;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.18);font:13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;" +
        "color:#222;user-select:none;display:none";
      document.body.appendChild(menu);
    }

    const isDark = matchMedia("(prefers-color-scheme:dark)").matches;
    menu.style.background = isDark ? "#2a2a2a" : "#fff";
    menu.style.border = isDark
      ? "1px solid #444"
      : "1px solid #d0d0d0";
    menu.style.color = isDark ? "#eee" : "#222";
    menu.innerHTML = "";

    const item = document.createElement("div");
    item.textContent = mediaKind === "video" ? "下载视频" : "下载图片";
    item.style.cssText =
      "padding:8px 16px;cursor:pointer;border-radius:3px;margin:2px 4px;white-space:nowrap";
    const hoverBg = isDark ? "#3a3a3a" : "#f0f0f0";
    item.onmouseenter = () => (item.style.background = hoverBg);
    item.onmouseleave = () => (item.style.background = "transparent");
    item.onclick = (e) => {
      e.stopPropagation();
      hide();
      triggerDownload(mediaUrl);
    };
    menu.appendChild(item);

    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.style.display = "block";

    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = x - r.width + "px";
    if (r.bottom > innerHeight) menu.style.top = y - r.height + "px";
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      const media = getMediaInfo(e.target);
      if (!media) return;
      const url = typeof media === "string" ? media : media.url;
      const kind = typeof media === "string" ? "image" : media.kind || "image";
      e.preventDefault();
      e.stopPropagation();
      show(e.clientX, e.clientY, toAbsolute(url), kind);
    },
    true,
  );

  document.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });

  // 拦截用于下载的 window.open(url, "_blank")，改为当前页 <a download>.click()，
  // 以便 WebView 用当前页会话发起请求并触发 Tauri on_download，避免无反应或 403。
  function isDownloadUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      if (path.includes("/download") || path.includes("/download/")) return true;
      if (path.includes("workdrive-public/download")) return true;
      if (u.searchParams.has("download") || u.searchParams.get("response-content-disposition") === "attachment") return true;
      return false;
    } catch {
      return false;
    }
  }

  const originalOpen = window.open;
  window.open = function (url, name, specs) {
    if (url == null || typeof url !== "string") return originalOpen.call(window, url, name, specs);
    try {
      const absolute = new URL(url, location.href).href;
      if (isDownloadUrl(absolute)) {
        triggerDownload(absolute);
        return null;
      }
    } catch (_) {}
    return originalOpen.call(window, url, name, specs);
  };
})();
