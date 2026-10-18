(function () {
  if (window.__kb_media_download__) return;

  const _tauri = window.__TAURI_INTERNALS__;
  const invoke = (cmd, args) => _tauri.invoke(cmd, args || {});
  // 桌面走 Raw IPC，8 MiB 一块最省往返。安卓只有 postMessage IPC，整块要编码进一条字符串消息，
  // 故降到 1 MiB，并改发 base64（见 ipcBytes）。
  const IS_ANDROID = /Android/i.test(navigator.userAgent || "");
  const WRITE_CHUNK = IS_ANDROID ? 1024 * 1024 : 8 * 1024 * 1024;

  // 安卓上直接传 Uint8Array 会被 JSON.stringify 成数字数组（约 3.6 倍体积），1 MiB 一块往返
  // 实测 1 s 以上；base64 只有 1.33 倍。Rust 侧 raw_body_bytes 认 `{ base64 }`。
  function ipcBytes(chunk) {
    if (!IS_ANDROID) return chunk;
    let binary = "";
    for (let i = 0; i < chunk.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, chunk.subarray(i, i + 0x8000));
    }
    return { base64: btoa(binary) };
  }
  // 文案见 kabegame-i18n `webview.*`，由 webview_i18n.js 预先拉取
  const t = (key, params) => (window.__kb_i18n__ ? window.__kb_i18n__.t(key, params) : key);

  function toast(message, type) {
    try {
      window.__kabegame_toast?.(message, type);
    } catch (_) {}
  }

  function progressMessage(written, total) {
    if (!Number.isFinite(total) || total <= 0) return t("progress.downloading");
    const percent = Math.max(0, Math.min(100, Math.floor((written / total) * 100)));
    return t("progress.downloadingPercent", { percent });
  }

  function streamExtension(mime) {
    const base = String(mime || "").split(";")[0].trim().toLowerCase();
    if (base.includes("webm")) return "webm";
    if (base.includes("mp4")) return "mp4";
    let subtype = base.split("/")[1]?.split("+")[0]?.replace(/^x-/, "") || "";
    if (subtype === "jpeg") subtype = "jpg";
    if (subtype === "quicktime") subtype = "mov";
    if (subtype === "matroska") subtype = "mkv";
    if (subtype === "mp2t") subtype = "ts";
    return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : "bin";
  }

  async function writeRaw(rid, bytes, onWrite) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + WRITE_CHUNK));
      // 桌面上 Uint8Array 作为 invoke 参数即 raw body(Tauri InvokeBody::Raw)。
      const count = await _tauri.invoke("crawl_fs_fwrite", ipcBytes(chunk), {
        headers: { rid: String(rid) },
      });
      if (!Number.isInteger(count) || count <= 0 || count > chunk.byteLength) {
        throw new Error(`crawl_fs_fwrite 返回无效写入字节数：${count}`);
      }
      offset += count;
      onWrite(count);
    }
  }

  async function createAndWrite(path, writer) {
    const rid = await invoke("crawl_fs_create", { path });
    try {
      await writer(rid);
    } finally {
      await invoke("crawl_fs_close", { rid });
    }
  }

  async function writeBlob(path, blob, onWrite) {
    await createAndWrite(path, async (rid) => {
      for (let offset = 0; offset < blob.size; offset += WRITE_CHUNK) {
        const buffer = await blob.slice(offset, offset + WRITE_CHUNK).arrayBuffer();
        await writeRaw(rid, new Uint8Array(buffer), onWrite);
      }
    });
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

  // MSE 分片常只有几 KB（实测 YouTube Shorts 平均不到 2 KB），逐片 invoke 时耗时全在往返上；
  // 先攒到 WRITE_CHUNK 再写。
  async function writeBuffer(path, buffer, onWrite) {
    await createAndWrite(path, async (rid) => {
      const pending = [];
      let pendingBytes = 0;
      const flush = async () => {
        if (!pendingBytes) return;
        const merged = new Uint8Array(pendingBytes);
        let offset = 0;
        for (const part of pending) {
          merged.set(part, offset);
          offset += part.byteLength;
        }
        pending.length = 0;
        pendingBytes = 0;
        await writeRaw(rid, merged, onWrite);
      };
      for (const part of bufferParts(buffer)) {
        const bytes = new Uint8Array(part);
        if (pendingBytes + bytes.byteLength > WRITE_CHUNK) await flush();
        if (bytes.byteLength >= WRITE_CHUNK) {
          await writeRaw(rid, bytes, onWrite);
          continue;
        }
        pending.push(bytes);
        pendingBytes += bytes.byteLength;
      }
      await flush();
    });
  }

  function sessionName() {
    return `media-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // panel 存在时（MSE 下载）进度与终态都显示在捕获面板上，不再另弹 toast
  async function saveAndSubmit(streams, sourceUrl, opts, panel) {
    const report = (message) => (panel ? panel.phase(message) : toast(message, "start"));
    let sessionDir = null;
    try {
      const root = await invoke("crawl_fs_get_root");
      sessionDir = `${root}/tmp/${sessionName()}`;
      await invoke("crawl_fs_mkdir", {
        path: sessionDir,
        options: { recursive: true },
      });

      report(t("progress.writing"));
      const totalBytes = streams.reduce((sum, stream) => sum + stream.totalBytes, 0);
      let written = 0;
      const onWrite = (count) => {
        written += count;
        report(progressMessage(written, totalBytes));
      };
      const paths = [];
      for (let index = 0; index < streams.length; index++) {
        const stream = streams[index];
        const path = `${sessionDir}/stream-${index}.${streamExtension(stream.mime)}`;
        paths.push(path);
        if (stream.blob) {
          await writeBlob(path, stream.blob, onWrite);
        } else {
          await writeBuffer(path, stream.buffer, onWrite);
        }
      }

      let outputPath = paths[0];
      if (paths.length > 1) {
        // 只有全部是 WebM 流才封 WebM（WebM 只收 VP8/VP9/AV1 + Opus/Vorbis）；混合时
        // 例如 YouTube 的 H.264 视频 + Opus 音频，封 WebM 会在写头时 EINVAL，MP4 则都装得下。
        const outputExt = streams.every((stream) =>
          String(stream.mime || "").toLowerCase().includes("webm")
        )
          ? "webm"
          : "mp4";
        outputPath = `${sessionDir}/output.${outputExt}`;
        report(t("progress.muxing"));
        await invoke("crawl_ffmpeg_mux", { inputs: paths, output: outputPath });
      }

      report(t("progress.importing"));
      await window.__kb_media_submit__(outputPath, sourceUrl, opts);
      if (!panel) toast(t("toast.completed"), "success");
    } catch (e) {
      if (!panel) toast(t("toast.failed"), "failed");
      throw e;
    } finally {
      if (sessionDir) {
        await invoke("crawl_fs_remove", {
          path: sessionDir,
          options: { recursive: true },
        }).catch((error) => {
          console.warn("[kabegame] failed to clean media session:", error);
        });
      }
    }
  }

  function saveBlob(blob, sourceUrl, opts) {
    return saveAndSubmit(
      [{ mime: blob.type || "", totalBytes: blob.size, blob }],
      sourceUrl,
      opts,
    );
  }

  function saveStreams(buffers, sourceUrl, opts, panel) {
    return saveAndSubmit(
      buffers.map((buffer) => ({
        mime: buffer.mime || "",
        totalBytes: bufferTotal(buffer),
        buffer,
      })),
      sourceUrl,
      opts,
      panel,
    );
  }

  function findVideoForUrl(url, opts) {
    if (opts && opts.element && opts.element.tagName === "VIDEO") return opts.element;
    const videos = Array.from(document.querySelectorAll("video"));
    return (
      videos.find((video) => video.currentSrc === url || video.src === url) || null
    );
  }

  // ---------- 捕获进度面板 ----------
  // 页面右下角的浮层（shadow DOM 隔离页面样式）：每个 SourceBuffer 一组，每档清晰度一条覆盖条，
  // 目标清晰度高亮，竖线是当前播放位置；底部是当前阶段。

  const PANEL_STYLE = `
    :host { all: initial; }
    .card { --bg:#fff; --fg:#1f2328; --muted:#6b7280; --track:#e5e7eb; --target:#2563eb; --other:#9ca3af;
      --ok:#16a34a; --err:#dc2626; --head:#111827; box-sizing:border-box; width:360px; max-width:calc(100vw - 32px);
      padding:10px 12px; border-radius:10px; background:var(--bg); color:var(--fg);
      box-shadow:0 10px 30px rgba(0,0,0,.22); font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    @media (prefers-color-scheme: dark) {
      .card { --bg:#1f2329; --fg:#e5e7eb; --muted:#9ca3af; --track:#374151; --target:#60a5fa; --other:#6b7280;
        --head:#f9fafb; }
    }
    .head { display:flex; justify-content:space-between; gap:8px; font-weight:600; color:var(--head); margin-bottom:6px; }
    .group { margin-top:6px; }
    .glabel { color:var(--muted); margin-bottom:2px; }
    .row { display:grid; grid-template-columns:110px 1fr 38px; align-items:center; gap:6px; margin:2px 0; }
    .row .name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--muted); }
    .row.target .name { color:var(--fg); font-weight:600; }
    .row .pct { text-align:right; font-variant-numeric:tabular-nums; color:var(--muted); }
    .row.target .pct { color:var(--fg); }
    .bar { position:relative; height:8px; border-radius:4px; background:var(--track); overflow:hidden; }
    .seg { position:absolute; top:0; bottom:0; background:var(--other); }
    .row.target .seg { background:var(--target); }
    .head-mark { position:absolute; top:-2px; bottom:-2px; width:2px; background:var(--fg); opacity:.75; }
    .phase { margin-top:8px; color:var(--muted); }
    .phase.ok { color:var(--ok); } .phase.err { color:var(--err); }
  `;

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function renditionLabel(rendition) {
    if (rendition.id === "raw") return t("panel.rawStream");
    if (!rendition.decodable) return t("panel.missingInit");
    const kbps = rendition.kbps >= 1000 ? `${(rendition.kbps / 1000).toFixed(1)}M` : `${rendition.kbps}k`;
    const size = rendition.width && rendition.height ? `${rendition.width}×${rendition.height}` : rendition.codec || "?";
    return rendition.kbps ? `${size} · ${kbps}` : size;
  }

  function bufferLabel(buffer) {
    const major = String(buffer.mime || "").split("/")[0];
    return major === "video" ? t("panel.video") : major === "audio" ? t("panel.audio") : buffer.mime || t("panel.stream");
  }

  // 只用 DOM API 构建：YouTube 等站点启用 Trusted Types，innerHTML 字符串赋值会抛错
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function percentOf(value, duration) {
    return Math.max(0, Math.min(100, (value / duration) * 100));
  }

  function createProgressPanel() {
    let host = null;
    let parts = null;
    let removeTimer = null;
    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement("div");
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = PANEL_STYLE;
      const card = el("div", "card");
      const head = el("div", "head");
      parts = {
        title: el("span", "title"),
        total: el("span", "total"),
        groups: el("div", "groups"),
        phase: el("div", "phase"),
      };
      head.append(parts.title, parts.total);
      card.append(head, parts.groups, parts.phase);
      root.append(style, card);
      (document.body || document.documentElement).appendChild(host);
    }
    function renditionRow(rendition, isTarget, duration, currentTime) {
      const row = el("div", "row" + (isTarget ? " target" : ""));
      const bar = el("div", "bar");
      for (const [start, end] of rendition.ranges) {
        const seg = el("div", "seg");
        const left = percentOf(start, duration);
        seg.style.left = `${left}%`;
        seg.style.width = `${Math.max(0.4, Math.min(100 - left, ((end - start) / duration) * 100))}%`;
        bar.append(seg);
      }
      const mark = el("div", "head-mark");
      mark.style.left = `${percentOf(currentTime, duration)}%`;
      bar.append(mark);
      const seconds = coveredSeconds(rendition.ranges, duration);
      row.append(
        el("span", "name", `${isTarget ? "◆ " : ""}${renditionLabel(rendition)}`),
        bar,
        el("span", "pct", `${Math.floor((seconds / duration) * 100)}%`),
      );
      return { row, seconds };
    }
    const panel = {
      phase(text, state) {
        ensure();
        parts.phase.textContent = text;
        parts.phase.className = "phase" + (state ? " " + state : "");
      },
      coverage(cov, targets, duration, currentTime) {
        ensure();
        parts.title.textContent = t("panel.title", { duration: formatTime(duration) });
        let targetSeconds = 0;
        const groups = cov.buffers.map((buffer, index) => {
          const group = el("div", "group");
          const stats = buffer.stats || {};
          const notes = [
            stats.aborts ? t("panel.aborts", { count: stats.aborts }) : "",
            stats.resyncs ? t("panel.resyncs", { count: stats.resyncs }) : "",
            stats.droppedBytes ? t("panel.dropped", { size: (stats.droppedBytes / 1048576).toFixed(1) }) : "",
          ].filter(Boolean);
          group.append(el("div", "glabel", [bufferLabel(buffer), ...notes].join(" · ")));
          if (!buffer.renditions.length) group.append(el("div", "glabel", t("panel.noData")));
          for (const rendition of buffer.renditions) {
            const isTarget = targets.get(index) === rendition.id;
            const { row, seconds } = renditionRow(rendition, isTarget, duration, currentTime);
            if (isTarget) targetSeconds += seconds;
            group.append(row);
          }
          return group;
        });
        parts.groups.replaceChildren(...groups);
        const total = cov.buffers.length ? targetSeconds / (cov.buffers.length * duration) : 0;
        parts.total.textContent = `${Math.floor(Math.min(1, total) * 100)}%`;
      },
      // 终态停留几秒后移除
      finish(text, state) {
        panel.phase(text, state);
        clearTimeout(removeTimer);
        removeTimer = setTimeout(() => host && host.remove(), state === "err" ? 8000 : 3000);
      },
    };
    return panel;
  }

  // ---------- 捕获补拉 ----------

  // 区间端点与 0 / 时长之间允许的空隙（秒）：首帧时间戳偏移、音视频时长差
  const COVER_TOLERANCE = 0.75;

  function coveredSeconds(ranges, duration) {
    let total = 0;
    for (const [start, end] of ranges) {
      total += Math.max(0, Math.min(end, duration) - Math.max(start, 0));
    }
    return total;
  }

  // 第一个未覆盖的时间点；全覆盖返回 null
  function firstGap(ranges, duration) {
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (end <= cursor) continue;
      if (start > cursor + COVER_TOLERANCE) return cursor;
      cursor = Math.max(cursor, end);
      if (cursor >= duration - COVER_TOLERANCE) return null;
    }
    return cursor >= duration - COVER_TOLERANCE ? null : cursor;
  }

  // 缺口之后下一个已覆盖区间的起点（没有则到结尾），用作兜底移除的区间终点
  function gapEnd(ranges, gap, duration) {
    for (const [start] of ranges) if (start > gap + COVER_TOLERANCE) return Math.min(start, duration);
    return duration;
  }

  // 播放器缓冲区是否已有 t 处的数据（正在下载或已下载）
  function playerHas(video, t) {
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t + 0.05 && video.buffered.end(i) >= t + 0.25) return true;
      }
    } catch (_) {}
    return false;
  }

  function area(rendition) {
    return (rendition.width || 0) * (rendition.height || 0);
  }

  // 首选：可解码的最高清晰度（同分辨率取码率高的）
  function bestRendition(renditions) {
    return renditions
      .filter((r) => r.decodable)
      .sort((a, b) => area(b) - area(a) || b.kbps - a.kbps)[0] || null;
  }

  // 退路：覆盖最完整的可解码清晰度（同覆盖取清晰度高的）
  function mostCoveredRendition(renditions, duration) {
    return renditions
      .filter((r) => r.decodable)
      .sort((a, b) => coveredSeconds(b.ranges, duration) - coveredSeconds(a.ranges, duration) || area(b) - area(a))[0] ||
      null;
  }

  function waitForDuration(video, timeoutMs) {
    const ready = () => Number.isFinite(video.duration) && video.duration > 0;
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", check);
        video.removeEventListener("durationchange", check);
        if (ready()) resolve();
        else reject(new Error(video.duration === Infinity ? t("error.liveStream") : t("error.durationTimeout")));
      };
      const check = () => {
        if (ready()) done();
      };
      const timer = setTimeout(done, timeoutMs);
      video.addEventListener("loadedmetadata", check);
      video.addEventListener("durationchange", check);
    });
  }

  // 当前 <video> 绑定的媒体来源标识（blob/src）。换集后会变，用于侦测视频被替换。
  function videoIdentity(video) {
    return video ? video.currentSrc || video.src || "" : "";
  }

  // 驱动播放器把每路流的目标清晰度补齐：静音、正常倍速，把 currentTime 跳到目标清晰度的第一个
  // 缺口，让播放器从那里继续拉分片。正常倍速是为了不让自适应码率因缓冲耗尽而降档；完整性只看
  // 捕获层的覆盖区间，播放器回收已播部分不影响。返回每路流选中的清晰度 id。
  async function ensureCaptured(video, url, panel, opts) {
    panel.phase(t("panel.waitingMetadata"));
    await waitForDuration(video, opts.metadataTimeoutMs ?? 10000);
    const duration = video.duration;
    const pinnedId = videoIdentity(video);
    const stallMs = opts.stallTimeoutMs ?? 20000;
    const switchMs = opts.renditionSwitchMs ?? 8000;
    const targets = new Map();
    const targetProgress = new Map();
    const original = {
      muted: video.muted,
      playbackRate: video.playbackRate,
      currentTime: video.currentTime,
      paused: video.paused,
      loop: video.loop,
    };
    let lastTotal = -1;
    let lastProgressAt = Date.now();
    // 「播放器缓冲区里有、捕获里没有」的缺口：开始时刻与已做的移除重拉次数
    let held = null;
    const maxEvictions = opts.maxEvictions ?? 3;
    const heldMs = opts.heldTimeoutMs ?? 6000;
    try {
      video.muted = true;
      video.playbackRate = 1;
      // loop=true 时到达结尾会回卷、不触发 ended（HTML 规范），阻止 B 站等站点结束时自动跳下一集
      video.loop = true;
      for (;;) {
        if (videoIdentity(video) !== pinnedId || !video.isConnected) {
          throw new Error(t("error.videoChanged"));
        }
        const cov = window.__kb_media__?.coverage(url);
        if (!cov) throw new Error(t("error.captureMissing"));
        if (cov.drm) throw new Error(t("error.drm"));
        if (cov.truncated) throw new Error(t("error.captureLimit"));
        const now = Date.now();
        let gap = null;
        let gapIndex = -1;
        let gapUntil = duration;
        let total = 0;
        let switched = null;
        cov.buffers.forEach((buffer, index) => {
          let target = buffer.renditions.find((r) => r.id === targets.get(index));
          if (!target) {
            target = bestRendition(buffer.renditions);
            if (!target) {
              gap = 0;
              return;
            }
            targets.set(index, target.id);
            targetProgress.set(index, { at: now, seconds: coveredSeconds(target.ranges, duration) });
          }
          const seconds = coveredSeconds(target.ranges, duration);
          const bufferGap = firstGap(target.ranges, duration);
          const progress = targetProgress.get(index);
          if (seconds > progress.seconds + 0.05) {
            progress.seconds = seconds;
            progress.at = now;
          } else if (bufferGap != null && now - progress.at > switchMs) {
            // 播放器在缺口处一直给别的清晰度：改用覆盖最完整的那一档
            const fallback = mostCoveredRendition(buffer.renditions, duration);
            if (fallback && fallback.id !== target.id) {
              target = fallback;
              targets.set(index, target.id);
              targetProgress.set(index, { at: now, seconds: coveredSeconds(target.ranges, duration) });
              switched = t("panel.switched", { stream: bufferLabel(buffer), rendition: renditionLabel(target) });
            }
          }
          total += coveredSeconds(target.ranges, duration);
          const targetGap = firstGap(target.ranges, duration);
          if (targetGap != null && (gap == null || targetGap < gap)) {
            gap = targetGap;
            gapIndex = index;
            gapUntil = gapEnd(target.ranges, targetGap, duration);
          }
        });
        panel.coverage(cov, targets, duration, video.currentTime);
        if (gap == null && cov.buffers.length) return targets;
        if (total > lastTotal + 0.05) {
          lastTotal = total;
          lastProgressAt = now;
        } else if (now - lastProgressAt > stallMs) {
          throw new Error(
            held && held.evictions >= maxEvictions
              ? t("error.gapLost", { time: formatTime(gap ?? 0), count: held.evictions })
              : t("error.stalled", { time: formatTime(gap ?? 0) }),
          );
        }
        let phase = switched || t("panel.fetchingGap", { time: formatTime(gap ?? 0) });
        const current = video.currentTime;
        if (gap != null && playerHas(video, gap)) {
          // 播放器已有缺口处的数据（多半正在边下边追加这一片）：不要跳转打断它。跳转会让播放器
          // 中止当前分片重新下载，反复跳转时这一片永远下不完。等它追加完整即可。
          if (!held || Math.abs(held.gap - gap) > COVER_TOLERANCE) held = { gap, since: now, evictions: 0 };
          if (!switched) phase = t("panel.waitingGap", { time: formatTime(gap) });
          if (now - held.since > heldMs && held.evictions < maxEvictions) {
            // 等了很久仍没进捕获：这段数据在捕获里丢了（例如解析重同步时丢弃）。从播放器缓冲区
            // 移除这一段，再跳过去让它重新下载。
            if (window.__kb_media__?.evict(url, gapIndex, gap, gapUntil)) {
              held.evictions += 1;
              held.since = now;
              phase = t("panel.refetchingGap", { time: formatTime(gap), count: held.evictions });
              try {
                video.currentTime = gap;
              } catch (_) {}
            }
          }
        } else if (gap != null && !(current >= gap - 0.5 && current <= gap + 4)) {
          // 播放器没有缺口处的数据，且播放位置不在缺口附近：跳过去让它从这里开始下载
          held = null;
          try {
            video.currentTime = gap;
          } catch (_) {}
        }
        panel.phase(phase);
        if (video.paused) await video.play().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 250));
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

  // 没有可驱动的 <video>（插件直接传 blob URL）时，按现有捕获选清晰度：完整的最高档，否则覆盖最多的一档
  function pickRenditions(url, duration) {
    const cov = window.__kb_media__?.coverage(url);
    const targets = new Map();
    if (!cov) return targets;
    cov.buffers.forEach((buffer, index) => {
      const complete = Number.isFinite(duration)
        ? buffer.renditions.filter((r) => r.decodable && firstGap(r.ranges, duration) == null)
        : [];
      const pick = bestRendition(complete) || mostCoveredRendition(buffer.renditions, duration || Infinity);
      if (pick) targets.set(index, pick.id);
    });
    return targets;
  }

  async function mediaDownload(url, opts) {
    await window.__kb_i18n__?.ready;
    const rawUrl = String(url || "");
    if (/^data:/i.test(rawUrl)) {
      const blob = await (await fetch(rawUrl)).blob();
      return saveBlob(blob, rawUrl, opts);
    }
    if (/^blob:/i.test(rawUrl)) {
      let entry = window.__kb_media__?.resolve(rawUrl);
      if (!entry) {
        // 兜底：捕获表未命中时试着直接读 blob URL。MediaSource 的 object URL
        // 不可 fetch（必然 ERR_FILE_NOT_FOUND），失败时给出可诊断的错误,
        // 而不是把一条裸 net 错误抛给用户。
        let blob;
        try {
          blob = await (await fetch(rawUrl)).blob();
        } catch (_) {
          throw new Error(t("error.notCaptured"));
        }
        return saveBlob(blob, rawUrl, opts);
      }
      if (entry.kind === "blob") {
        return saveBlob(entry.blob, rawUrl, opts);
      }
      if (entry.drm || window.__kb_media__?.hasDrm?.()) {
        throw new Error(t("error.drm"));
      }
      // 固定住发起下载时的目标视频；换集侦测与补拉都针对这一个元素/blob。
      const targetVideo = findVideoForUrl(rawUrl, opts);
      const panel = createProgressPanel();
      try {
        const targets = targetVideo
          ? await ensureCaptured(targetVideo, rawUrl, panel, opts || {})
          : pickRenditions(rawUrl, NaN);
        // 用原始 blob URL 取字节：即便页面已换集，捕获表仍保留原视频的分片。
        entry = window.__kb_media__?.resolve(rawUrl, Object.fromEntries(targets));
        if (!entry || entry.kind !== "mse") throw new Error(t("error.captureMissing"));
        if (entry.drm || window.__kb_media__?.hasDrm?.()) throw new Error(t("error.drm"));
        if (entry.truncated) throw new Error(t("error.captureLimit"));
        if (entry.buffers.some((buffer) => buffer.unordered)) {
          console.warn("[kabegame] MSE container order could not be verified");
        }
        const buffers = entry.buffers.filter((buffer) => bufferTotal(buffer) > 0);
        if (!buffers.length) throw new Error(t("error.captureEmpty"));
        await saveStreams(buffers, rawUrl, opts, panel);
        panel.finish(t("toast.completed"), "ok");
      } catch (e) {
        panel.finish(t("panel.failed", { error: String((e && e.message) || e) }), "err");
        throw e;
      }
      return;
    }
    const blob = await (await fetch(rawUrl)).blob();
    return saveBlob(blob, rawUrl, opts);
  }

  Object.defineProperty(window, "__kb_media_download__", {
    value: mediaDownload,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
