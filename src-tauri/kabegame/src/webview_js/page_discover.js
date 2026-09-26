// 页面媒体发现：只扫描调用时的当前 document，返回候选 URL；不下载、不依赖任务、不挂 window。
// 由 surf.rs 以 concat! 拼进内容页 IIFE；未来 webpage WebView runner 以同样方式复用（见 PRD 4.5）。
//
// 来源参考 yt-dlp GenericIE（HTML5 media → og/twitter meta → JSON-LD → JW Player / video.js 脚本配置），
// 但与 yt-dlp「命中即返回」不同，这里取并集：目标是整页所有媒体，而非单个视频。

  const DISCOVER_MIN_IMAGE_EDGE = 64;
  const DISCOVER_LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"];
  const DISCOVER_LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];
  const DISCOVER_MANIFEST_EXTS = ["m3u8", "mpd", "f4m", "ism", "smil"];

  function discoverMedia(options) {
    const imageExts = new Set((options && options.imageExtensions) || []);
    const videoExts = new Set((options && options.videoExtensions) || []);
    const documentUrl = location.href;
    const seen = new Set();
    const candidates = [];

    function extOf(url) {
      try {
        const segment = new URL(url).pathname.split("/").pop() || "";
        const dot = segment.lastIndexOf(".");
        return dot >= 0 ? segment.slice(dot + 1).toLowerCase() : "";
      } catch (_) {
        return "";
      }
    }

    function kindByExt(url) {
      const ext = extOf(url);
      if (videoExts.has(ext)) return "video";
      if (imageExts.has(ext)) return "image";
      return null;
    }

    function normalize(raw, base) {
      if (typeof raw !== "string") return null;
      let value = raw.trim();
      if (!value) return null;
      // 脚本字符串里常见的转义：\/ 与 /
      value = value.replace(/\\\//g, "/").replace(/\\u002[fF]/g, "/");
      try {
        const url = new URL(value, base || document.baseURI);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        url.hash = "";
        return url.href;
      } catch (_) {
        return null;
      }
    }

    // kind 已知（来自 <img>/<video> 等标签）时不要求扩展名；否则按扩展名判定，未知扩展名丢弃。
    function add(raw, kind, base) {
      const url = normalize(raw, base);
      if (!url || seen.has(url)) return;
      if (DISCOVER_MANIFEST_EXTS.includes(extOf(url))) return; // 下载器不支持流清单
      const resolvedKind = kind || kindByExt(url);
      if (!resolvedKind) return;
      seen.add(url);
      candidates.push({ url, kind: resolvedKind });
    }

    // srcset 取描述符最大的一项（w 优先按宽度，x 按倍率）
    function largestFromSrcset(srcset) {
      if (typeof srcset !== "string" || !srcset.trim()) return null;
      let best = null;
      let bestScore = -1;
      for (const part of srcset.split(/,\s+/)) {
        const [candidate, descriptor] = part.trim().split(/\s+/);
        if (!candidate) continue;
        let score = 1;
        const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(descriptor || "");
        if (m) score = parseFloat(m[1]) * (m[2].toLowerCase() === "w" ? 1 : 10000);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      return best;
    }

    // 0) 文档本身就是媒体（直接打开的图片/视频）
    const contentType = String(document.contentType || "").toLowerCase();
    if (contentType.startsWith("image/") || contentType.startsWith("video/")) {
      add(documentUrl, contentType.startsWith("video/") ? "video" : "image");
      return { candidates, documentUrl };
    }

    // 1) HTML5 media（yt-dlp _parse_html5_media_entries）
    for (const video of document.querySelectorAll("video")) {
      if (!/^blob:/i.test(video.currentSrc || "")) add(video.currentSrc || video.getAttribute("src"), "video");
      for (const source of video.querySelectorAll("source[src]")) add(source.getAttribute("src"), "video");
      add(video.getAttribute("poster"), "image");
    }

    // 2) 图片：真实加载地址、srcset 最大项、懒加载属性
    for (const img of document.querySelectorAll("img")) {
      const loaded = img.complete && img.naturalWidth > 0;
      const tiny =
        loaded &&
        (img.naturalWidth < DISCOVER_MIN_IMAGE_EDGE || img.naturalHeight < DISCOVER_MIN_IMAGE_EDGE);
      // 已加载的小图（图标、头像、追踪像素）跳过当前地址；懒加载属性照收——占位图常是 1x1
      if (!tiny) {
        const srcsetBest = largestFromSrcset(img.getAttribute("srcset"));
        add(srcsetBest || img.currentSrc || img.getAttribute("src"), "image");
      }
      for (const attr of DISCOVER_LAZY_SRCSET_ATTRS) add(largestFromSrcset(img.getAttribute(attr)), "image");
      for (const attr of DISCOVER_LAZY_ATTRS) add(img.getAttribute(attr), "image");
    }
    for (const source of document.querySelectorAll("picture source[srcset]")) {
      add(largestFromSrcset(source.getAttribute("srcset")), "image");
    }

    // 3) meta：Twitter card 与 Open Graph（og:video 仅在 og:video:type 为视频时采纳，同 yt-dlp）
    const meta = (name) =>
      Array.from(
        document.querySelectorAll(`meta[property="${name}"], meta[name="${name}"]`),
        (el) => el.getAttribute("content"),
      );
    for (const name of ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]) {
      for (const v of meta(name)) add(v, "image");
    }
    for (const v of meta("twitter:player:stream")) add(v, null);
    if (meta("og:video:type").some((t) => /^video\//i.test(t || ""))) {
      for (const name of ["og:video", "og:video:url", "og:video:secure_url"]) {
        for (const v of meta(name)) add(v, "video");
      }
    }

    // 4) JSON-LD：ImageObject / VideoObject 的 contentUrl，以及 image 字段
    function walkLd(node, depth) {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) {
        for (const item of node) walkLd(item, depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      const type = String(node["@type"] || "");
      if (typeof node.contentUrl === "string") {
        add(node.contentUrl, /video/i.test(type) ? "video" : /image/i.test(type) ? "image" : null);
      }
      const image = node.image;
      if (typeof image === "string") add(image, "image");
      else if (image && typeof image === "object") walkLd(Array.isArray(image) ? image : [image], depth + 1);
      if (typeof node.url === "string" && /ImageObject/i.test(type)) add(node.url, "image");
      for (const key of ["@graph", "associatedMedia", "video", "hasPart"]) walkLd(node[key], depth + 1);
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        walkLd(JSON.parse(script.textContent || "null"), 0);
      } catch (_) {}
    }

    // 5) 直链：a[href] 仅当扩展名已能确认是受支持媒体
    for (const a of document.querySelectorAll("a[href]")) add(a.getAttribute("href"), null);

    // 6) 播放器脚本配置（yt-dlp 的 JW Player / loader / video.js 形态），只收扩展名命中的 http(s) 直链
    const scriptPattern = /["']?(?:file|src|video_url|videoUrl|contentUrl)["']?\s*[:=]\s*["'](https?:[^"'\s]+)["']/g;
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent || "";
      if (!text || text.length > 2 * 1024 * 1024) continue;
      for (const match of text.matchAll(scriptPattern)) add(match[1], null);
    }

    return { candidates, documentUrl };
  }
