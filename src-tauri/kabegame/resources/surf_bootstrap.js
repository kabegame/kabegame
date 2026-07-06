(function () {
  "use strict";

  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args || {});

  function reportErr(error) {
    window.__kabegame_toast?.(String(error && error.message ? error.message : error), "failed");
  }

  // 用于计算下载url所用的名称
  function nameFromUrl(url) {
    try {
      const u = new URL(String(url || ""), location.href);
      if (/^(data|blob):$/i.test(u.protocol)) return "";
      const segment = u.pathname.split("/").filter(Boolean).pop() || "";
      return decodeURIComponent(segment).trim();
    } catch (_) {
      return "";
    }
  }

  // 将title和url名称拼接，用来计算最终所用的名称
  function downloadName(url) {
    const title = String(document.title || "").trim();
    const segment = nameFromUrl(url) || nameFromUrl(location.href);
    if (title && segment) return title + " / " + segment;
    return title || segment || "";
  }

  // 下载选项用 name: downloadName()
  function downloadOptions(url, opts) {
    const out = opts && typeof opts === "object" ? { ...opts } : {};
    if (!out.name) {
      out.name = downloadName(url) || undefined;
    }
    if (!out.url) out.url = location.href;
    return out;
  }

  function triggerDownload(url, opts) {
    const options = downloadOptions(url, opts);
    if (/^(data|blob):/i.test(String(url || ""))) {
      return window.__kb_media_download__(url, options).catch(reportErr);
    }
    console.log('surf download', url, opts);
    return invoke("surf_download_image", {
      url: String(url),
      name: options.name ?? undefined,
      sourceUrl: options.url ?? undefined,
      source_url: options.url ?? undefined,
    }).catch(reportErr);
  }

  window.__kabegame_surf_triggerDownload = triggerDownload;
})();
