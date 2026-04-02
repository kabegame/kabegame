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
      return {
        url: target.src,
        kind: parentTag === "VIDEO" ? "video" : "image",
      };
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
    menu.style.border = isDark ? "1px solid #444" : "1px solid #d0d0d0";
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

  // 拦截 window.open，处理以下情况：
  // 1. 下载 URL → 直接触发下载（避免 403 / 无反应）
  // 2. _blank 新窗口 → 在当前窗口内处理（媒体文件下载，其余在当前 tab 导航），
  //    彻底阻止原生 window.open 到达 WebView2，避免触发 NewWindowRequested COM 事件死锁。
  function isDownloadUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      if (path.includes("/download") || path.includes("/download/"))
        return true;
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

  // 判断 URL 是否是常见媒体/压缩文件（直接下载比导航更合适）
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
      // 非字符串 url（如 about:blank 或 undefined）：仅非 _blank 才放行
      if (name === "_blank" || name === "_new") return null;
      return originalOpen.call(window, url, name, specs);
    }
    try {
      const absolute = new URL(url, location.href).href;

      // 明确的下载 URL → 直接下载
      if (isDownloadUrl(absolute)) {
        triggerDownload(absolute);
        return null;
      }

      // _blank 新标签页请求：
      // 在 WebView2 (Windows) 中，原生 window.open 会触发 NewWindowRequested COM 事件。
      // Tauri/WRY 未为 surf 窗口注册该事件处理器，导致 COM UI 线程与 JS 线程死锁，整窗口卡死。
      // 因此对所有 _blank 请求改为在当前窗口内处理，彻底绕过原生 window.open。
      if (!name || name === "_blank" || name === "_new") {
        if (isMediaOrArchiveUrl(absolute)) {
          triggerDownload(absolute);
        } else {
          location.href = absolute;
        }
        return null;
      }
    } catch (_) {}

    // 其余情况（非 _blank，非下载 URL）放行
    return originalOpen.call(window, url, name, specs);
  };
})();
