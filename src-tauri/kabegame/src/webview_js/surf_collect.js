// 畅游一键下载：内容页编排。由 surf.rs 以 concat! 与 surf_download_name.js / page_discover.js /
// page_snapshot.js 拼进同一个 IIFE，不挂任何 window 全局（页面脚本无从探测）。
//
// Rust 是运行状态的唯一权威：本脚本经 Tauri Channel 接收 start / cancel，不监听应用事件。
// 协议与 @tauri-apps/api 的 Channel 一致：参数传 "__CHANNEL__:<callbackId>"，
// Rust 端 eval runCallback(id, { message, index })，按 index 保序。

  const collectInternals = window.__TAURI_INTERNALS__;
  // 只在顶层文档登记：子 frame 若也 attach 会覆盖掉主页面的 Channel
  if (window.top !== window) return;
  if (!collectInternals || typeof collectInternals.transformCallback !== "function") return;

  const collectInvoke = (command, args) => collectInternals.invoke(command, args || {});
  const collectToast = (message, type) => {
    try {
      window.__kabegame_toast?.(message, type);
    } catch (_) {}
  };
  const collectFormat = (template, values) =>
    String(template || "").replace(/\{(\w+)\}/g, (whole, key) =>
      key in values ? String(values[key]) : whole,
    );

  let collectRun = null; // { runId, canceled }

  async function collectStart(message) {
    const run = { runId: message.runId, canceled: false };
    collectRun = run;
    const texts = message.texts || {};
    let found = 0;
    let queued = 0;
    let metadataId = null;
    try {
      collectToast(texts.detecting, "start");
      const { candidates, documentUrl } = discoverMedia({
        imageExtensions: message.imageExtensions,
        videoExtensions: message.videoExtensions,
      });
      found = candidates.length;
      if (found === 0) {
        collectToast(texts.none, "failed");
        return;
      }
      const videos = candidates.filter((c) => c.kind === "video").length;
      collectToast(
        collectFormat(texts.found, { count: found, images: found - videos, videos }),
        "start",
      );

      // 检查点 1：检测完毕、下载之前
      if (run.canceled) {
        collectToast(texts.canceled, "failed");
        return;
      }

      if (message.freeze) {
        try {
          const pageHtml = await snapshotPage();
          if (run.canceled) {
            collectToast(texts.canceled, "failed");
            return;
          }
          metadataId = await collectInvoke("surf_save_page_snapshot", {
            runId: run.runId,
            snapshot: {
              sourceUrl: location.href,
              documentUrl,
              title: String(document.title || ""),
              pageHtml,
            },
          });
        } catch (error) {
          if (run.canceled) {
            collectToast(texts.canceled, "failed");
            return;
          }
          collectToast(collectFormat(texts.snapshotFailed, { error: String(error) }), "failed");
        }
      }

      for (const candidate of candidates) {
        // 检查点 2：每项下载之前（含上一项入队完成、准备下一项时）
        if (run.canceled) {
          collectToast(texts.canceled, "failed");
          return;
        }
        try {
          await collectInvoke("surf_download_image", {
            url: candidate.url,
            name: downloadName(candidate.url) || undefined,
            sourceUrl: location.href,
            metadataId: metadataId ?? undefined,
            collectRunId: run.runId,
          });
          queued += 1;
        } catch (_) {
          // Rust 在 run 取消后拒绝入队：交由下一轮检查点统一提示
          if (run.canceled) {
            collectToast(texts.canceled, "failed");
            return;
          }
        }
      }
      collectToast(collectFormat(texts.done, { queued, total: found }), queued > 0 ? "success" : "failed");
    } catch (error) {
      collectToast(String((error && error.message) || error), "failed");
    } finally {
      if (collectRun === run) collectRun = null;
      collectInvoke("surf_collect_finished", {
        runId: run.runId,
        queued,
        metadataId: metadataId ?? undefined,
      }).catch(() => {});
    }
  }

  function collectDispatch(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "start") {
      if (collectRun) collectRun.canceled = true; // 理论上 Rust 不会重叠发 start；防御性终止旧 run
      void collectStart(message);
    } else if (message.type === "cancel") {
      if (collectRun && collectRun.runId === message.runId) collectRun.canceled = true;
    }
  }

  // Channel 接收：按 index 保序分发（与 @tauri-apps/api Channel 同语义）
  let collectNextIndex = 0;
  const collectPending = new Map();
  const collectChannelId = collectInternals.transformCallback((raw) => {
    if (!raw || typeof raw !== "object" || "end" in raw) return;
    collectPending.set(raw.index, raw.message);
    while (collectPending.has(collectNextIndex)) {
      const message = collectPending.get(collectNextIndex);
      collectPending.delete(collectNextIndex);
      collectNextIndex += 1;
      collectDispatch(message);
    }
  });

  collectInvoke("surf_collect_attach", { onEvent: "__CHANNEL__:" + collectChannelId }).catch((error) =>
    console.warn("[kabegame] surf collect attach failed", error),
  );
