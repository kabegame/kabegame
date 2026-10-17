(function () {
  if (window.__kb_media__) return;

  // 捕获表：blob URL → Blob / MediaSource。MSE 的每个 SourceBuffer 在 appendBuffer 时就地解析：
  // fMP4 按 init（清晰度）分组、分片按 tfdt 去重并累计覆盖区间；其它容器（TS / WebM）保留原始
  // 追加序列，覆盖区间取 SourceBuffer.buffered 的历史并集。下载端据此判断「抓齐了没有」，
  // 不依赖会被播放器回收的 video.buffered。
  const registry = new Map();
  const msData = new WeakMap();
  const sbRec = new WeakMap();
  const CAP = 768 * 1024 * 1024;
  // 合并覆盖区间时容忍的缝隙（秒）：分片首尾的时间戳舍入
  const MERGE_EPS = 0.05;
  let drmDetected = false;

  function mediaSourceCtor() {
    return typeof window.MediaSource === "function" ? window.MediaSource : null;
  }

  function ensureMediaSourceRecord(ms) {
    let rec = msData.get(ms);
    if (!rec) {
      rec = { buffers: [], bytes: 0, truncated: false };
      msData.set(ms, rec);
    }
    return rec;
  }

  function bytesFromAppendArg(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  function concatBytes(a, b) {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
  }

  // ---------- 时间区间 ----------

  function addRange(ranges, start, end) {
    if (!(end > start)) return;
    ranges.push([start, end]);
    ranges.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1] + MERGE_EPS) {
        last[1] = Math.max(last[1], range[1]);
      } else {
        merged.push([range[0], range[1]]);
      }
    }
    ranges.length = 0;
    for (const range of merged) ranges.push(range);
  }

  // ---------- ISO BMFF ----------

  function readU32(bytes, offset) {
    return (
      ((bytes[offset] || 0) * 0x1000000) +
      ((bytes[offset + 1] || 0) << 16) +
      ((bytes[offset + 2] || 0) << 8) +
      (bytes[offset + 3] || 0)
    ) >>> 0;
  }

  function readU64(bytes, offset) {
    return readU32(bytes, offset) * 0x100000000 + readU32(bytes, offset + 4);
  }

  function boxType(bytes, offset) {
    return String.fromCharCode(
      bytes[offset + 4] || 0,
      bytes[offset + 5] || 0,
      bytes[offset + 6] || 0,
      bytes[offset + 7] || 0,
    );
  }

  // 返回 null 表示数据不足以读出完整的盒子；返回 false 表示数据不是合法的盒子序列。
  function nextBox(bytes, offset, end) {
    if (offset + 8 > end) return null;
    let size = readU32(bytes, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const hi = readU32(bytes, offset + 8);
      if (hi > 0x1fffff) return false;
      size = hi * 0x100000000 + readU32(bytes, offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header) return false;
    if (offset + size > end) return null;
    return { start: offset, end: offset + size, header, type: boxType(bytes, offset) };
  }

  function children(bytes, start, end) {
    const out = [];
    let offset = start;
    while (offset + 8 <= end) {
      const box = nextBox(bytes, offset, end);
      if (!box) break;
      out.push(box);
      offset = box.end;
    }
    return out;
  }

  function child(bytes, box, type, skip = 0) {
    return children(bytes, box.start + box.header + skip, box.end).find((b) => b.type === type) || null;
  }

  const FMP4_TOP_LEVEL = new Set([
    "ftyp", "styp", "moov", "moof", "mdat", "sidx", "emsg", "prft", "free", "skip", "uuid", "mfra",
  ]);

  function looksLikeFmp4(bytes) {
    return bytes.byteLength >= 8 && FMP4_TOP_LEVEL.has(boxType(bytes, 0));
  }

  // 只有这些盒子会出现在「一段新数据的开头」；moof 内部的子盒子（traf 等）不在其中，
  // 不会把分片中途断开的续块误判为新段。
  const SEGMENT_START = new Set(["ftyp", "styp", "moov", "moof", "sidx", "emsg", "prft"]);

  function startsSegment(bytes, offset) {
    if (offset + 8 > bytes.byteLength || !SEGMENT_START.has(boxType(bytes, offset))) return false;
    const size = readU32(bytes, offset);
    return size === 1 || (size >= 8 && size <= 0x40000000);
  }

  // 对 stsd（解码配置）取 FNV-1a 指纹：同一清晰度重复追加的 init 归回同一组，
  // 不同编码配置（SPS/PPS 不同）即使分辨率相同也分开，避免用错 init 解码。
  function fnv1a(bytes, start, end) {
    let hash = 0x811c9dc5;
    for (let i = start; i < end; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function parseInit(bytes, moov) {
    const info = { width: 0, height: 0, timescale: 0, codec: "", defaultDuration: 0, fingerprint: "" };
    const traks = children(bytes, moov.start + moov.header, moov.end).filter((b) => b.type === "trak");
    // 混流时优先取视频轨，其次第一条轨
    let picked = null;
    for (const trak of traks) {
      const mdia = child(bytes, trak, "mdia");
      const hdlr = mdia && child(bytes, mdia, "hdlr");
      const handler = hdlr ? boxType(bytes, hdlr.start + hdlr.header + 4) : "";
      if (!picked || handler === "vide") picked = { trak, mdia };
      if (handler === "vide") break;
    }
    if (picked) {
      const tkhd = child(bytes, picked.trak, "tkhd");
      if (tkhd) {
        info.width = Math.round(readU32(bytes, tkhd.end - 8) / 65536);
        info.height = Math.round(readU32(bytes, tkhd.end - 4) / 65536);
      }
      const mdhd = picked.mdia && child(bytes, picked.mdia, "mdhd");
      if (mdhd) {
        const version = bytes[mdhd.start + mdhd.header];
        info.timescale = readU32(bytes, mdhd.start + mdhd.header + (version === 1 ? 20 : 12));
      }
      const minf = picked.mdia && child(bytes, picked.mdia, "minf");
      const stbl = minf && child(bytes, minf, "stbl");
      const stsd = stbl && child(bytes, stbl, "stsd");
      if (stsd) {
        const entry = stsd.start + stsd.header + 8;
        if (entry + 8 <= stsd.end) info.codec = boxType(bytes, entry);
        info.fingerprint = fnv1a(bytes, stsd.start, stsd.end);
      }
    }
    const mvex = child(bytes, moov, "mvex");
    const trex = mvex && child(bytes, mvex, "trex");
    if (trex) info.defaultDuration = readU32(bytes, trex.start + trex.header + 12);
    if (!info.fingerprint) info.fingerprint = fnv1a(bytes, moov.start, moov.end);
    return info;
  }

  // 读 moof 第一条 traf 的 tfdt 与全部 trun 样本时长（媒体时间刻度）
  function parseMoof(bytes, moof, rendition) {
    const traf = child(bytes, moof, "traf");
    if (!traf) return null;
    let tfdt = null;
    let duration = 0;
    let defaultDuration = rendition ? rendition.defaultDuration : 0;
    for (const box of children(bytes, traf.start + traf.header, traf.end)) {
      const body = box.start + box.header;
      if (box.type === "tfhd") {
        const flags = readU32(bytes, body) & 0xffffff;
        let p = body + 8;
        if (flags & 0x1) p += 8;
        if (flags & 0x2) p += 4;
        if (flags & 0x8) defaultDuration = readU32(bytes, p);
      } else if (box.type === "tfdt") {
        tfdt = bytes[body] === 1 ? readU64(bytes, body + 4) : readU32(bytes, body + 4);
      } else if (box.type === "trun") {
        const flags = readU32(bytes, body) & 0xffffff;
        const count = readU32(bytes, body + 4);
        let p = body + 8;
        if (flags & 0x1) p += 4;
        if (flags & 0x4) p += 4;
        const perSample =
          (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
        for (let i = 0; i < count; i++) {
          duration += flags & 0x100 ? readU32(bytes, p) : defaultDuration;
          p += perSample;
        }
      }
    }
    return tfdt == null ? null : { tfdt, duration };
  }

  function getRendition(rec, initBytes, info) {
    const id = `${info.codec || "?"}:${info.width}x${info.height}:${info.fingerprint}`;
    let rendition = rec.renditions.find((r) => r.id === id);
    if (!rendition) {
      rendition = {
        id,
        width: info.width,
        height: info.height,
        codec: info.codec,
        timescale: info.timescale,
        defaultDuration: info.defaultDuration,
        init: initBytes.slice().buffer,
        frags: new Map(),
        ranges: [],
        bytes: initBytes.byteLength,
      };
      rec.renditions.push(rendition);
      return { rendition, added: initBytes.byteLength };
    }
    return { rendition, added: 0 };
  }

  // 从 offset 起解析完整盒子；返回 { added, offset, failed }，offset 为第一个未消费字节
  function parseBoxes(rec, bytes, offset, timestampOffset) {
    let added = 0;
    while (offset < bytes.byteLength) {
      const box = nextBox(bytes, offset, bytes.byteLength);
      if (box === false) return { added, offset, failed: true };
      if (!box) break;
      if (box.type === "ftyp") {
        rec.ftyp = bytes.slice(box.start, box.end);
        offset = box.end;
      } else if (box.type === "moov") {
        const moov = bytes.subarray(box.start, box.end);
        const initBytes = rec.ftyp ? concatBytes(rec.ftyp, moov) : moov;
        const info = parseInit(bytes, box);
        const result = getRendition(rec, initBytes, info);
        rec.current = result.rendition;
        added += result.added;
        rec.ftyp = null;
        offset = box.end;
      } else if (box.type === "moof") {
        const mdat = nextBox(bytes, box.end, bytes.byteLength);
        if (mdat === false) return { added, offset, failed: true };
        if (!mdat) break; // mdat 还没到齐，留待下一次 append
        if (mdat.type !== "mdat") {
          offset = box.end;
          continue;
        }
        let rendition = rec.current;
        if (!rendition) {
          // 没见到 init 的分片（init 在 hook 之前追加）：单独成组，无法独立解码
          rendition = getRendition(rec, new Uint8Array(0), {
            codec: "?", width: 0, height: 0, timescale: 0, defaultDuration: 0, fingerprint: "noinit",
          }).rendition;
          rec.current = rendition;
        }
        const timing = parseMoof(bytes, box, rendition);
        if (timing && !rendition.frags.has(timing.tfdt)) {
          const fragment = bytes.slice(box.start, mdat.end).buffer;
          if (rendition.timescale > 0) {
            addRange(
              rendition.ranges,
              timing.tfdt / rendition.timescale + timestampOffset,
              (timing.tfdt + timing.duration) / rendition.timescale + timestampOffset,
            );
          }
          rendition.frags.set(timing.tfdt, fragment);
          rendition.bytes += fragment.byteLength;
          added += fragment.byteLength;
        }
        offset = mdat.end;
      } else {
        offset = box.end;
      }
    }
    return { added, offset, failed: false };
  }

  // 下一个可能是新段开头的位置（找不到返回 -1）
  function findSegmentStart(bytes, from) {
    for (let i = from; i + 8 <= bytes.byteLength; i++) {
      // 盒子类型的首字节都是小写字母，先粗筛再精确判断
      const c = bytes[i + 4];
      if (c >= 0x61 && c <= 0x7a && startsSegment(bytes, i)) return i;
    }
    return -1;
  }

  // 残留的半截盒子是否已失效：新数据以新段开头，而残留不是「完整 moof + 正等 mdat」
  function pendingIsStale(pending, view) {
    if (!startsSegment(view, 0)) return false;
    const box = nextBox(pending, 0, pending.byteLength);
    if (!box) return true; // 半截盒子后面却来了新段：上一段被中止了
    return !(box.type === "moof" && box.end === pending.byteLength && boxType(view, 0) === "mdat");
  }

  function dropPending(rec) {
    if (rec.pending) rec.stats.droppedBytes += rec.pending.byteLength;
    rec.pending = null;
    rec.ftyp = null;
  }

  // 解析一次 append 的 fMP4 数据；返回新增的去重后字节数。数据不是盒子序列且此前从未解析成功时
  // 返回 -1（交给 raw 路径）；已经解析成功过的流只做重同步、丢弃坏段，不整体降级。
  function ingestFmp4(rec, view, timestampOffset) {
    if (rec.pending && pendingIsStale(rec.pending, view)) {
      rec.stats.resyncs += 1;
      dropPending(rec);
    }
    let bytes = rec.pending ? concatBytes(rec.pending, view) : view;
    rec.pending = null;
    let added = 0;
    let offset = 0;
    for (;;) {
      const result = parseBoxes(rec, bytes, offset, timestampOffset);
      added += result.added;
      offset = result.offset;
      if (!result.failed) break;
      if (!rec.renditions.length && added === 0) return -1;
      const next = findSegmentStart(bytes, offset + 1);
      rec.stats.resyncs += 1;
      rec.stats.droppedBytes += (next < 0 ? bytes.byteLength : next) - offset;
      rec.ftyp = null;
      if (next < 0) return added;
      offset = next;
    }
    if (offset < bytes.byteLength) rec.pending = bytes.slice(offset);
    return added;
  }

  // ---------- MPEG-TS（无 init，按首个 PES PTS 排序） ----------

  function tsSyncOffset(bytes) {
    for (const offset of [0, 1, 2, 3, 4]) {
      if (bytes[offset] === 0x47 && bytes[offset + 188] === 0x47 && bytes[offset + 376] === 0x47) {
        return offset;
      }
    }
    return -1;
  }

  function readPts33(bytes, offset) {
    if (offset + 5 > bytes.byteLength) return null;
    return (
      ((bytes[offset] & 0x0e) * 0x20000000) +
      (bytes[offset + 1] << 22) +
      ((bytes[offset + 2] & 0xfe) << 14) +
      (bytes[offset + 3] << 7) +
      ((bytes[offset + 4] & 0xfe) >> 1)
    );
  }

  function tsChunkPts(bytes) {
    const sync = tsSyncOffset(bytes);
    if (sync < 0) return null;
    for (let offset = sync; offset + 188 <= bytes.byteLength; offset += 188) {
      if (bytes[offset] !== 0x47) return null;
      if ((bytes[offset + 1] & 0x40) === 0) continue;
      const adaptation = (bytes[offset + 3] >> 4) & 0x03;
      if (adaptation === 0 || adaptation === 2) continue;
      let payload = offset + 4;
      if (adaptation === 3) payload += 1 + (bytes[payload] || 0);
      if (payload + 14 > offset + 188) continue;
      if (bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) continue;
      const flags = bytes[payload + 7] || 0;
      const headerLen = bytes[payload + 8] || 0;
      if ((flags & 0x80) === 0 || payload + 9 + headerLen > offset + 188) continue;
      const pts = readPts33(bytes, payload + 9);
      if (pts != null) return pts;
    }
    return null;
  }

  function rawFragments(rec) {
    if (rec.kind === "ts") {
      const unique = new Map();
      let sortable = true;
      for (const chunk of rec.raw) {
        const pts = tsChunkPts(new Uint8Array(chunk));
        if (pts == null) {
          sortable = false;
          break;
        }
        if (!unique.has(pts)) unique.set(pts, chunk);
      }
      if (sortable) {
        return {
          fragments: Array.from(unique.entries()).sort((a, b) => a[0] - b[0]).map((entry) => entry[1]),
          unordered: false,
        };
      }
    }
    return { fragments: rec.raw.slice(), unordered: rec.kind !== "ts" };
  }

  // ---------- 追加入口 ----------

  function recordAppend(sourceBuffer, data) {
    const mapped = sbRec.get(sourceBuffer);
    if (!mapped || mapped.owner.truncated) return;
    const view = bytesFromAppendArg(data);
    if (!view || view.byteLength === 0) return;
    const { owner, rec } = mapped;
    rec.stats.appends += 1;
    if (!rec.kind) {
      rec.kind = looksLikeFmp4(view) ? "fmp4" : tsSyncOffset(view) >= 0 ? "ts" : "raw";
    }
    let added = 0;
    if (rec.kind === "fmp4") {
      let timestampOffset = 0;
      try {
        timestampOffset = Number(sourceBuffer.timestampOffset) || 0;
      } catch (_) {}
      added = ingestFmp4(rec, view, timestampOffset);
      if (added < 0) {
        // 不是可解析的盒子序列：此后按原始追加序列保存
        rec.kind = "raw";
        rec.pending = null;
        added = 0;
      }
    }
    if (rec.kind !== "fmp4") {
      const copy = view.slice().buffer;
      rec.raw.push(copy);
      added = copy.byteLength;
    }
    rec.bytes += added;
    owner.bytes += added;
    if (owner.bytes > CAP) {
      owner.truncated = true;
      for (const buffer of owner.buffers) {
        buffer.renditions.length = 0;
        buffer.raw.length = 0;
        buffer.pending = null;
      }
    }
  }

  function recordBuffered(sourceBuffer) {
    const mapped = sbRec.get(sourceBuffer);
    if (!mapped) return;
    try {
      const buffered = sourceBuffer.buffered;
      for (let i = 0; i < buffered.length; i++) {
        addRange(mapped.rec.observed, buffered.start(i), buffered.end(i));
      }
    } catch (_) {}
  }

  try {
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = originalCreateObjectURL.call(this, obj);
      try {
        const MediaSource = mediaSourceCtor();
        if (typeof Blob !== "undefined" && obj instanceof Blob) {
          registry.set(url, { kind: "blob", blob: obj });
        } else if (MediaSource && obj instanceof MediaSource) {
          ensureMediaSourceRecord(obj);
          registry.set(url, { kind: "mse", ms: obj });
        }
      } catch (_) {}
      return url;
    };
  } catch (_) {}

  try {
    const originalSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = function (keys) {
      if (keys) drmDetected = true;
      return originalSetMediaKeys.call(this, keys);
    };
    document.addEventListener(
      "encrypted",
      function () {
        drmDetected = true;
      },
      true,
    );
  } catch (_) {}

  try {
    const MediaSource = mediaSourceCtor();
    if (MediaSource && MediaSource.prototype) {
      const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const sourceBuffer = originalAddSourceBuffer.call(this, mime);
        try {
          const owner = ensureMediaSourceRecord(this);
          const rec = {
            mime: String(mime || ""),
            kind: null,
            bytes: 0,
            renditions: [],
            current: null,
            pending: null,
            ftyp: null,
            raw: [],
            observed: [],
            sourceBuffer,
            stats: { appends: 0, aborts: 0, resyncs: 0, droppedBytes: 0 },
          };
          owner.buffers.push(rec);
          sbRec.set(sourceBuffer, { owner, rec });
          sourceBuffer.addEventListener("updateend", () => recordBuffered(sourceBuffer));
        } catch (_) {}
        return sourceBuffer;
      };
    }
  } catch (_) {}

  try {
    if (typeof SourceBuffer !== "undefined" && SourceBuffer.prototype) {
      const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (data) {
        const result = originalAppendBuffer.call(this, data);
        try {
          recordAppend(this, data);
        } catch (_) {}
        return result;
      };
      // abort() 会让 SourceBuffer 丢弃正在解析的半截分片（MSE「重置解析状态」）。捕获层必须
      // 同步丢掉残留的 pending，否则会把下一段新数据拼到旧的半截盒子后面，吞掉后续分片。
      const originalAbort = SourceBuffer.prototype.abort;
      SourceBuffer.prototype.abort = function () {
        try {
          const mapped = sbRec.get(this);
          if (mapped) {
            mapped.rec.stats.aborts += 1;
            dropPending(mapped.rec);
          }
        } catch (_) {}
        return originalAbort.apply(this, arguments);
      };
    }
  } catch (_) {}

  function renditionSummary(rendition) {
    const seconds = rendition.ranges.reduce((sum, range) => sum + (range[1] - range[0]), 0);
    return {
      id: rendition.id,
      width: rendition.width,
      height: rendition.height,
      codec: rendition.codec,
      decodable: rendition.init.byteLength > 0,
      fragments: rendition.frags.size,
      bytes: rendition.bytes,
      kbps: seconds > 0 ? Math.round((rendition.bytes * 8) / seconds / 1000) : 0,
      ranges: rendition.ranges.map((range) => range.slice()),
    };
  }

  function bufferSummary(rec) {
    const stats = { ...rec.stats, pendingBytes: rec.pending ? rec.pending.byteLength : 0 };
    if (rec.kind === "fmp4") {
      return { mime: rec.mime, kind: rec.kind, stats, renditions: rec.renditions.map(renditionSummary) };
    }
    // 非 fMP4：没有清晰度信息，覆盖区间取 SourceBuffer.buffered 的历史并集
    return {
      mime: rec.mime,
      kind: rec.kind || "raw",
      stats,
      renditions: rec.raw.length
        ? [{
          id: "raw",
          width: 0,
          height: 0,
          codec: "",
          decodable: true,
          fragments: rec.raw.length,
          bytes: rec.bytes,
          kbps: 0,
          ranges: rec.observed.map((range) => range.slice()),
        }]
        : [],
    };
  }

  function mseEntry(url) {
    const entry = registry.get(String(url || ""));
    if (!entry || entry.kind !== "mse") return entry ? { entry } : null;
    return { entry, data: msData.get(entry.ms) || { buffers: [], truncated: false } };
  }

  Object.defineProperty(window, "__kb_media__", {
    value: Object.freeze({
      hasDrm() {
        return drmDetected;
      },
      // 轻量查询：各 SourceBuffer 的清晰度与覆盖区间（秒，呈现时间轴），不复制媒体字节
      coverage(url) {
        const found = mseEntry(url);
        if (!found || !found.data) return null;
        return {
          truncated: found.data.truncated,
          drm: drmDetected,
          buffers: found.data.buffers.map(bufferSummary),
        };
      },
      // 兜底：播放器缓冲区里有、捕获里却丢了的区间，从页面的 SourceBuffer 移除，
      // 迫使播放器在 seek 到这里时重新下载。SourceBuffer 正忙或已脱离时返回 false。
      evict(url, index, start, end) {
        const found = mseEntry(url);
        const rec = found && found.data && found.data.buffers[index];
        const sourceBuffer = rec && rec.sourceBuffer;
        if (!sourceBuffer || sourceBuffer.updating || !(end > start)) return false;
        try {
          sourceBuffer.remove(start, end);
          return true;
        } catch (_) {
          return false;
        }
      },
      // 取出媒体字节。selection[i] 为第 i 个 SourceBuffer 选用的清晰度 id
      resolve(url, selection) {
        const found = mseEntry(url);
        if (!found) return null;
        if (found.entry.kind === "blob") return { kind: "blob", blob: found.entry.blob };
        return {
          kind: "mse",
          truncated: found.data.truncated,
          drm: drmDetected,
          buffers: found.data.buffers.map((rec, index) => {
            if (rec.kind !== "fmp4") {
              const raw = rawFragments(rec);
              return { mime: rec.mime, rendition: "raw", init: null, fragments: raw.fragments, unordered: raw.unordered };
            }
            const wanted = selection && selection[index];
            const rendition = rec.renditions.find((r) => r.id === wanted) || null;
            if (!rendition) return { mime: rec.mime, rendition: null, init: null, fragments: [], unordered: false };
            return {
              mime: rec.mime,
              rendition: rendition.id,
              init: rendition.init.byteLength ? rendition.init : null,
              fragments: Array.from(rendition.frags.entries())
                .sort((a, b) => a[0] - b[0])
                .map((entry) => entry[1]),
              unordered: false,
            };
          }),
        };
      },
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
