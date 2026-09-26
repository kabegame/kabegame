// 网页收集 V8 后端：Rust 静态取页 + DOMParser 解析 + 同一份 discoverMedia。
// 由 `crate::plugin::webpage::v8_collect_module()` 前置 page_discover.js 与 webpage_collect.js，
// 组成自包含 ES 模块；不执行页面 JavaScript，快照只有 HTML（无 CSS）。
//
// common = { imageExtensions, videoExtensions, freeze, userHeaderNames }（Rust 下发）
// custom = { url, backend, injectSurfCookie, injectCefUserAgent }（任务 userConfig）

function webpageV8Log(level, message) {
  if (level === "warn") console.warn(message);
  else console.info(message);
}

function webpageHeaderValue(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === name) return String(value);
  }
  return "";
}

/** 在 <head> 起始处补 charset 与 base，使回看时相对地址按原页解析。 */
function webpageWithBase(html, baseUrl) {
  const inject = `<meta charset="utf-8"><base href="${webpageEscapeAttr(baseUrl)}">`;
  const match = /<head(\s[^>]*)?>/i.exec(html);
  if (match) {
    const at = match.index + match[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  return `<head>${inject}</head>` + html;
}

/** 注入身份：用户在任务 Header 里显式写过的同名头优先，不覆盖。 */
function webpageInjectIdentity(ctx, common, custom) {
  const explicit = new Set((common.userHeaderNames || []).map((name) => String(name).toLowerCase()));
  if (custom.injectCefUserAgent !== false && !explicit.has("user-agent")) {
    const ua = Kabegame.cefUserAgent();
    if (ua) {
      Kabegame.setHeader("User-Agent", ua);
      webpageLog(ctx, "info", "taskLogWebpageUaInjected", {});
    } else {
      webpageLog(ctx, "warn", "taskLogWebpageUaUnavailable", {});
    }
  }
  if (custom.injectSurfCookie !== false && !explicit.has("cookie")) {
    // op 自身会记录「已注入 / 畅游无该站 Cookie」，缺失只 warn 不失败
    Kabegame.requireCookie(new URL(ctx.sourceUrl).hostname);
  }
}

async function webpageV8Discover(ctx) {
  const entryKind = webpageKindByExt(ctx, ctx.sourceUrl);
  if (entryKind) {
    return {
      candidates: [{ url: ctx.sourceUrl, kind: entryKind }],
      documentUrl: ctx.sourceUrl,
      pageHtml: webpageMediaHtml(ctx.sourceUrl, entryKind),
      backend: "v8",
    };
  }

  const documentUrl = await Kabegame.to(ctx.sourceUrl);
  const contentType = webpageHeaderValue(await Kabegame.currentHeaders(), "content-type").toLowerCase();
  if (contentType.startsWith("image/") || contentType.startsWith("video/")) {
    const kind = contentType.startsWith("video/") ? "video" : "image";
    return {
      candidates: [{ url: documentUrl, kind }],
      documentUrl,
      pageHtml: webpageMediaHtml(documentUrl, kind),
      backend: "v8",
    };
  }

  const html = await Kabegame.currentHtml();
  const doc = await Kabegame.currentDocument();
  if (!doc) throw new Error("Failed to parse page HTML");
  let baseUrl = documentUrl;
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      baseUrl = new URL(baseHref, documentUrl).href;
    } catch (_) {}
  }
  const { candidates } = discoverMedia({
    document: doc,
    documentUrl,
    baseUrl,
    imageExtensions: ctx.imageExtensions,
    videoExtensions: ctx.videoExtensions,
  });
  return {
    candidates,
    documentUrl,
    title: (doc.querySelector("title")?.textContent || "").trim(),
    pageHtml: webpageWithBase(html, baseUrl),
    backend: "v8",
  };
}

export async function crawl(common, custom) {
  const ctx = {
    sourceUrl: String(custom.url || ""),
    imageExtensions: common.imageExtensions || [],
    videoExtensions: common.videoExtensions || [],
    freeze: common.freeze === true,
    log: webpageV8Log,
  };
  webpageInjectIdentity(ctx, common, custom);
  const discovery = await webpageV8Discover(ctx);
  await webpageCollect(ctx, discovery);
}
