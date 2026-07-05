(function () {
  if (window.__kb_media_download__) return;

  const _tauri = window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => _tauri.invoke(cmd, args || {});
  const UPLOAD_CHUNK = 2 * 1024 * 1024;

  function toBase64(bytes) {
    let binary = "";
    const step = 64 * 1024;
    for (let offset = 0; offset < bytes.length; offset += step) {
      const chunk = bytes.subarray(offset, offset + step);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function uploadCommon(opts) {
    const o = typeof opts === "object" && opts !== null ? opts : {};
    return {
      name: o.name ?? undefined,
      metadata: o.metadata ?? undefined,
      metadata_version: o.metadata_version ?? undefined,
      metadataVersion: o.metadata_version ?? undefined,
      page_url: o.url ?? undefined,
    };
  }

  function toast(message, type) {
    try {
      window.__kabegame_toast?.(message, type);
    } catch (_) {}
  }

  function progressMessage(written, total) {
    if (!Number.isFinite(total) || total <= 0) return "下载中";
    const percent = Math.max(0, Math.min(100, Math.floor((written / total) * 100)));
    return "下载中 " + percent + "%";
  }

  async function uploadBlob(blob, sourceUrl, opts) {
    const id = await invoke("crawl_media_begin", {
      sourceUrl,
      streams: [{ mime: blob.type || "", totalBytes: blob.size }],
      ...uploadCommon(opts),
    });
    toast("开始下载", "start");
    try {
      let written = 0;
      for (let offset = 0; offset < blob.size; offset += UPLOAD_CHUNK) {
        const buf = await blob.slice(offset, offset + UPLOAD_CHUNK).arrayBuffer();
        const chunk = new Uint8Array(buf);
        await invoke("crawl_media_chunk", {
          id,
          stream: 0,
          data: toBase64(chunk),
        });
        written += chunk.byteLength;
        toast(progressMessage(written, blob.size), "start");
      }
      await invoke("crawl_media_end", { id, success: true });
      toast("下载完成", "success");
    } catch (e) {
      await invoke("crawl_media_end", {
        id,
        success: false,
        error: String(e),
      }).catch(() => {});
      toast("下载失败", "failed");
      throw e;
    }
  }

  function bufferParts(buffer) {
    const parts = [];
    if (buffer.init) parts.push(buffer.init);
    for (const fragment of buffer.fragments || []) parts.push(fragment);
    return parts;
  }

  function bufferTotal(buffer) {
    return bufferParts(buffer).reduce((sum, part) => sum + part.byteLength, 0);
  }

  async function uploadStreams(buffers, sourceUrl, opts) {
    const totalBytes = buffers.reduce((sum, buffer) => sum + bufferTotal(buffer), 0);
    const id = await invoke("crawl_media_begin", {
      sourceUrl,
      streams: buffers.map((buffer) => ({
        mime: buffer.mime || "",
        totalBytes: bufferTotal(buffer),
      })),
      ...uploadCommon(opts),
    });
    toast("开始下载", "start");
    try {
      let written = 0;
      for (let stream = 0; stream < buffers.length; stream++) {
        for (const part of bufferParts(buffers[stream])) {
          const bytes = new Uint8Array(part);
          for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK) {
            const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK);
            await invoke("crawl_media_chunk", {
              id,
              stream,
              data: toBase64(chunk),
            });
            written += chunk.byteLength;
            toast(progressMessage(written, totalBytes), "start");
          }
        }
      }
      await invoke("crawl_media_end", { id, success: true });
      toast("下载完成", "success");
    } catch (e) {
      await invoke("crawl_media_end", {
        id,
        success: false,
        error: String(e),
      }).catch(() => {});
      toast("下载失败", "failed");
      throw e;
    }
  }

  function findVideoForUrl(url, opts) {
    if (opts && opts.element && opts.element.tagName === "VIDEO") return opts.element;
    const videos = Array.from(document.querySelectorAll("video"));
    return (
      videos.find((video) => video.currentSrc === url || video.src === url) || null
    );
  }

  function bufferedCovers(video, end) {
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= 0.5 && video.buffered.end(i) >= end) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // 当前 <video> 绑定的媒体来源标识（blob/src）。换集后会变，用于侦测视频被替换。
  function videoIdentity(video) {
    return video ? video.currentSrc || video.src || "" : "";
  }

  async function ensureFullyBuffered(video, opts) {
    if (!video) return;
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("无法全缓冲直播流");
    }
    const end = Math.max(0, duration - 0.3);
    if (bufferedCovers(video, end)) return;

    toast("正在加速获取全量视频内容", "start");
    const pinnedId = videoIdentity(video);
    const original = {
      muted: video.muted,
      playbackRate: video.playbackRate,
      currentTime: video.currentTime,
      paused: video.paused,
      loop: video.loop,
    };
    const stallTimeoutMs = opts?.stallTimeoutMs ?? 20000;
    let lastBufferedEnd = 0;
    let lastProgressAt = Date.now();
    try {
      video.muted = true;
      // 关键：loop=true 时到达结尾会回卷到起点、**不触发 ended 事件**（HTML 规范），
      // 从而阻止 B 站等站点在播放结束时自动跳下一集；播放仍会在回卷前缓冲到尾部。
      video.loop = true;
      video.playbackRate = opts?.rate ?? 16;
      video.currentTime = 0;
      await video.play().catch(() => {});
      while (!bufferedCovers(video, end)) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        // 视频被换集/替换/移出 DOM → 立即中断，不再空等到超时。
        if (videoIdentity(video) !== pinnedId || !video.isConnected) {
          throw new Error("视频已切换或被移除，下载中断");
        }
        let bufferedEnd = 0;
        for (let i = 0; i < video.buffered.length; i++) {
          bufferedEnd = Math.max(bufferedEnd, video.buffered.end(i));
        }
        if (bufferedEnd > lastBufferedEnd + 0.1) {
          lastBufferedEnd = bufferedEnd;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > stallTimeoutMs) {
          throw new Error("MSE 全缓冲停滞超时");
        }
      }
    } finally {
      // 仅当仍是同一视频时才恢复状态，避免把设置写到已换集的新视频上。
      if (videoIdentity(video) === pinnedId) {
        video.loop = original.loop;
        video.muted = original.muted;
        video.playbackRate = original.playbackRate;
        try {
          video.currentTime = original.currentTime;
        } catch (_) {}
        if (original.paused) video.pause();
      }
    }
  }

  async function mediaDownload(url, opts) {
    const rawUrl = String(url || "");
    if (/^data:/i.test(rawUrl)) {
      const blob = await (await fetch(rawUrl)).blob();
      return uploadBlob(blob, rawUrl, opts);
    }
    if (/^blob:/i.test(rawUrl)) {
      let entry = window.__kb_media__?.resolve(rawUrl);
      if (!entry) {
        const blob = await (await fetch(rawUrl)).blob();
        return uploadBlob(blob, rawUrl, opts);
      }
      if (entry.kind === "blob") {
        return uploadBlob(entry.blob, rawUrl, opts);
      }
      if (entry.drm || window.__kb_media__?.hasDrm?.()) {
        throw new Error("DRM/EME 保护内容无法下载");
      }
      if (entry.truncated) {
        throw new Error("MSE capture truncated (over cap)");
      }
      // 固定住发起下载时的目标视频；换集侦测与全缓冲都针对这一个元素/blob。
      const targetVideo = findVideoForUrl(rawUrl, opts);
      try {
        await ensureFullyBuffered(targetVideo, opts || {});
      } catch (e) {
        toast(String((e && e.message) || e) || "下载失败", "failed");
        throw e;
      }
      // 用原始 blob URL 重新取快照：即便页面已换集，捕获表仍保留原视频的分片。
      entry = window.__kb_media__?.resolve(rawUrl);
      if (!entry || entry.kind !== "mse") {
        throw new Error("MSE capture not found");
      }
      if (entry.drm || window.__kb_media__?.hasDrm?.()) {
        throw new Error("DRM/EME 保护内容无法下载");
      }
      if (entry.truncated) {
        throw new Error("MSE capture truncated (over cap)");
      }
      if (entry.buffers.some((buffer) => buffer.unordered)) {
        console.warn("[kabegame] MSE container order could not be verified");
      }
      const buffers = entry.buffers.filter((buffer) => bufferTotal(buffer) > 0);
      if (!buffers.length) {
        throw new Error("MSE capture has no media data");
      }
      return uploadStreams(buffers, rawUrl, opts);
    }
    const blob = await (await fetch(rawUrl)).blob();
    return uploadBlob(blob, rawUrl, opts);
  }

  Object.defineProperty(window, "__kb_media_download__", {
    value: mediaDownload,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
