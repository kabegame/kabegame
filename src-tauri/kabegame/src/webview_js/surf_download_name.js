// 畅游下载命名：由 surf.rs 以 concat! 拼进各内容页脚本的 IIFE 闭包，不挂 window。

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
