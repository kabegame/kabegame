// 页面快照：把当前 DOM 序列化为「HTML + 内联 CSS」的静态文档；不挂 window。
// 由 surf.rs 拼进畅游内容页 IIFE；网页收集 WebView 任务把它拼进爬虫窗口的 crawl_js（startup.rs）。
//
// 只保存 HTML 与 CSS：图片等子资源仍引用远程绝对地址（回看时由 <base> 解析）。
// 样式必须内联——回看的 srcdoc 继承应用 CSP（style-src 'self' 'unsafe-inline'），跨域 <link> 会被拦。

  const SNAPSHOT_STRIP_SELECTOR = [
    "script",
    "noscript",
    "iframe",
    "frame",
    "object",
    "embed",
    "style",
    "template",
    'link[rel~="stylesheet"]',
    'link[rel~="preload"]',
    'link[rel~="modulepreload"]',
    'link[rel~="prefetch"]',
    'link[rel~="import"]',
    'meta[http-equiv="refresh" i]',
    'meta[http-equiv="content-security-policy" i]',
    "base",
    ".__kabegame_surf_toast__", // Kabegame 自己注入的提示
  ].join(",");

  function snapshotAbsolutizeCssUrls(cssText, baseHref) {
    const resolve = (raw) => {
      const value = raw.trim();
      if (!value || /^(data|blob|about|#)/i.test(value)) return value;
      try {
        return new URL(value, baseHref).href;
      } catch (_) {
        return value;
      }
    };
    return cssText
      .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_, quote, url) => `url(${quote}${resolve(url)}${quote})`)
      .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, quote, url) => `@import ${quote}${resolve(url)}${quote}`);
  }

  async function snapshotSheetText(sheet) {
    const baseHref = sheet.href || document.baseURI;
    let text = null;
    try {
      // CSSOM 优先：能拿到 CSS-in-JS 经 insertRule 注入、<style> 文本里没有的规则
      text = Array.from(sheet.cssRules || [], (rule) => rule.cssText).join("\n");
    } catch (_) {
      // 跨域样式表不可读 cssRules，退回按 href 拉取（CDN 常带 ACAO:*）
      if (sheet.href) {
        try {
          const response = await fetch(sheet.href, { credentials: "omit" });
          if (response.ok) text = await response.text();
        } catch (_) {}
      }
    }
    if (text == null) return null;
    const media = sheet.media && sheet.media.mediaText;
    const css = snapshotAbsolutizeCssUrls(text, baseHref);
    return media && media !== "all" ? `@media ${media} {\n${css}\n}` : css;
  }

  async function snapshotPage() {
    const root = document.documentElement.cloneNode(true);

    // 懒加载图片回填为实际加载地址：按文档顺序一一对应 live DOM
    const liveImages = document.querySelectorAll("img");
    const clonedImages = root.querySelectorAll("img");
    clonedImages.forEach((img, index) => {
      const live = liveImages[index];
      if (live && live.currentSrc && !/^blob:/i.test(live.currentSrc)) {
        img.setAttribute("src", live.currentSrc);
        img.removeAttribute("srcset");
        img.removeAttribute("loading");
      }
    });

    root.querySelectorAll(SNAPSHOT_STRIP_SELECTOR).forEach((el) => el.remove());
    for (const el of root.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) {
          el.removeAttribute(attr.name);
        } else if (
          (name === "href" || name === "src" || name === "action" || name === "formaction") &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }

    const sheets = [...Array.from(document.styleSheets), ...(document.adoptedStyleSheets || [])];
    const cssParts = [];
    for (const sheet of sheets) {
      const text = await snapshotSheetText(sheet);
      if (text) cssParts.push(text);
    }

    let head = root.querySelector("head");
    if (!head) {
      head = document.createElement("head");
      root.insertBefore(head, root.firstChild);
    }
    const style = document.createElement("style");
    // CSS 文本里的 "</style" 会提前闭合标签，转义为 CSS 等价的 "<\/style"
    style.textContent = cssParts.join("\n").replace(/<\/(style)/gi, "<\\/$1");
    head.appendChild(style);

    const base = document.createElement("base");
    base.setAttribute("href", document.baseURI);
    head.insertBefore(base, head.firstChild);
    const charset = document.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    head.insertBefore(charset, head.firstChild);

    return "<!DOCTYPE html>\n" + root.outerHTML;
  }
