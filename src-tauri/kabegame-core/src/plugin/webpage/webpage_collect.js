// 网页收集编排的公共部分：V8 与 WebView 两个后端共用（均需前置 page_discover.js）。
// 两个运行时暴露同形的 Kabegame API（createImageMetadata / downloadImage / addProgress），
// 差异（取页方式、日志出口）由调用方经 ctx 传入：
//   ctx = { sourceUrl, imageExtensions, videoExtensions, freeze, log(level, message) }
// 日志内容为 `{"_i18n":{"k","p"}}`，前端按 tasks.<k> 翻译（与 Rust task_log_i18n 同格式）。

  const WEBPAGE_SNAPSHOT_KIND = "kabegame.surfPageSnapshot";
  const WEBPAGE_PAGE_PROGRESS = 10;
  const WEBPAGE_ITEMS_PROGRESS = 89.9;

  function webpageLog(ctx, level, key, params) {
    ctx.log(level, JSON.stringify({ _i18n: { k: key, p: params || {} } }));
  }

  function webpageErrorMessage(error) {
    return String((error && error.message) || error);
  }

  function webpageEscapeAttr(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** 入口 URL 按扩展名已能判定为媒体时返回 "image" / "video"，否则 null。 */
  function webpageKindByExt(ctx, url) {
    let ext = "";
    try {
      const segment = new URL(url).pathname.split("/").pop() || "";
      const dot = segment.lastIndexOf(".");
      ext = dot >= 0 ? segment.slice(dot + 1).toLowerCase() : "";
    } catch (_) {
      return null;
    }
    if (!ext) return null;
    if ((ctx.videoExtensions || []).includes(ext)) return "video";
    if ((ctx.imageExtensions || []).includes(ext)) return "image";
    return null;
  }

  /** 入口本身是媒体时的最小 H5，保证详情模板仍有稳定输入。 */
  function webpageMediaHtml(url, kind) {
    const src = webpageEscapeAttr(url);
    const body =
      kind === "video"
        ? `<video src="${src}" controls style="max-width:100%"></video>`
        : `<img src="${src}" style="max-width:100%">`;
    return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body style="margin:0">${body}</body></html>`;
  }

  /** 冻结页面：写一行共享 metadata。失败（超限等）只 warn，媒体照常无 metadata 下载。 */
  async function webpageCreateSnapshot(ctx, snapshot) {
    try {
      const id = await Kabegame.createImageMetadata({
        kind: WEBPAGE_SNAPSHOT_KIND,
        schemaVersion: 1,
        sourceUrl: ctx.sourceUrl,
        documentUrl: snapshot.documentUrl,
        title: snapshot.title || "",
        pageHtml: snapshot.pageHtml,
        capturedAt: Date.now(),
        backend: snapshot.backend,
      });
      return Number(id);
    } catch (error) {
      webpageLog(ctx, "warn", "taskLogWebpageSnapshotSkipped", { error: webpageErrorMessage(error) });
      return null;
    }
  }

  /** 页面阶段完成后：按开关冻结，再逐个提交下载；单项失败不中断，取消继续上抛。 */
  async function webpageCollect(ctx, discovery) {
    const candidates = discovery.candidates || [];
    await Kabegame.addProgress(WEBPAGE_PAGE_PROGRESS);

    let metadataId = null;
    if (ctx.freeze && discovery.pageHtml) {
      metadataId = await webpageCreateSnapshot(ctx, discovery);
    }

    const total = candidates.length;
    if (!total) {
      webpageLog(ctx, "info", "taskLogWebpageNone", {});
      return;
    }
    const images = candidates.filter((c) => c.kind === "image").length;
    webpageLog(ctx, "info", "taskLogWebpageFound", { total, images, videos: total - images });

    const step = WEBPAGE_ITEMS_PROGRESS / total;
    let queued = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const opts = { url: ctx.sourceUrl };
      if (metadataId != null) opts.metadata_id = metadataId;
      try {
        await Kabegame.downloadImage(candidate.url, opts);
        queued += 1;
      } catch (error) {
        const message = webpageErrorMessage(error);
        if (/Task canceled/i.test(message)) throw error;
        failed += 1;
        webpageLog(ctx, "warn", "taskLogWebpageEnqueueFailed", { url: candidate.url, error: message });
      }
      await Kabegame.addProgress(step);
    }
    webpageLog(ctx, "info", "taskLogWebpageSummary", { total, queued, failed });
  }
