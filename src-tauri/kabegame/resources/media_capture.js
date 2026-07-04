(function () {
  if (window.__kb_media__) return;

  const registry = new Map();
  const msData = new WeakMap();
  const sbRec = new WeakMap();
  const CAP = 768 * 1024 * 1024;
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

  function copyAppendArg(data) {
    const view = bytesFromAppendArg(data);
    if (!view) return null;
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }

  function concatChunks(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  function readU32(bytes, offset) {
    return (
      ((bytes[offset] || 0) * 0x1000000) +
      ((bytes[offset + 1] || 0) << 16) +
      ((bytes[offset + 2] || 0) << 8) +
      (bytes[offset + 3] || 0)
    ) >>> 0;
  }

  function readU64AsString(bytes, offset) {
    const hi = readU32(bytes, offset);
    const lo = readU32(bytes, offset + 4);
    if (typeof BigInt === "function") {
      return ((BigInt(hi) << 32n) | BigInt(lo)).toString();
    }
    return String(hi * 0x100000000 + lo);
  }

  function boxType(bytes, offset) {
    return String.fromCharCode(
      bytes[offset + 4] || 0,
      bytes[offset + 5] || 0,
      bytes[offset + 6] || 0,
      bytes[offset + 7] || 0,
    );
  }

  function nextBox(bytes, offset, end) {
    if (offset + 8 > end) return null;
    let size = readU32(bytes, offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      const hi = readU32(bytes, offset + 8);
      const lo = readU32(bytes, offset + 12);
      if (hi > 0x1fffff) return null;
      size = hi * 0x100000000 + lo;
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return null;
    return {
      start: offset,
      end: offset + size,
      header,
      type: boxType(bytes, offset),
    };
  }

  function findTfdt(bytes, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      const box = nextBox(bytes, offset, end);
      if (!box) return null;
      if (box.type === "tfdt") {
        const version = bytes[box.start + box.header] || 0;
        const valueOffset = box.start + box.header + 4;
        if (version === 1 && valueOffset + 8 <= box.end) {
          return readU64AsString(bytes, valueOffset);
        }
        if (valueOffset + 4 <= box.end) {
          return String(readU32(bytes, valueOffset));
        }
      }
      if (box.type === "moof" || box.type === "traf") {
        const nested = findTfdt(bytes, box.start + box.header, box.end);
        if (nested != null) return nested;
      }
      offset = box.end;
    }
    return null;
  }

  function sortFmp4(chunks) {
    const bytes = concatChunks(chunks);
    const initParts = [];
    const fragments = [];
    let offset = 0;
    while (offset + 8 <= bytes.byteLength) {
      const box = nextBox(bytes, offset, bytes.byteLength);
      if (!box) return null;
      if (box.type === "moof") {
        const mdat = nextBox(bytes, box.end, bytes.byteLength);
        if (!mdat || mdat.type !== "mdat") return null;
        const key = findTfdt(bytes, box.start + box.header, box.end);
        if (key == null) return null;
        fragments.push({
          key,
          bytes: bytes.slice(box.start, mdat.end).buffer,
        });
        offset = mdat.end;
      } else {
        if (fragments.length === 0) {
          initParts.push(bytes.slice(box.start, box.end).buffer);
        }
        offset = box.end;
      }
    }
    if (fragments.length === 0) return null;
    const unique = new Map();
    for (const fragment of fragments) {
      if (!unique.has(fragment.key)) unique.set(fragment.key, fragment.bytes);
    }
    const sorted = Array.from(unique.entries()).sort((a, b) => {
      if (typeof BigInt === "function") {
        const av = BigInt(a[0]);
        const bv = BigInt(b[0]);
        return av < bv ? -1 : av > bv ? 1 : 0;
      }
      return Number(a[0]) - Number(b[0]);
    });
    return {
      init: initParts.length ? concatChunks(initParts).buffer : null,
      fragments: sorted.map((entry) => entry[1]),
      unordered: false,
    };
  }

  function tsSyncOffset(bytes) {
    for (const offset of [0, 1, 2, 3, 4]) {
      if (
        bytes[offset] === 0x47 &&
        bytes[offset + 188] === 0x47 &&
        bytes[offset + 376] === 0x47
      ) {
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

  function tsChunkPts(chunk) {
    const bytes = new Uint8Array(chunk);
    const sync = tsSyncOffset(bytes);
    if (sync < 0) return null;
    for (let offset = sync; offset + 188 <= bytes.byteLength; offset += 188) {
      if (bytes[offset] !== 0x47) return null;
      const payloadStart = (bytes[offset + 1] & 0x40) !== 0;
      if (!payloadStart) continue;
      const adaptation = (bytes[offset + 3] >> 4) & 0x03;
      if (adaptation === 0 || adaptation === 2) continue;
      let payload = offset + 4;
      if (adaptation === 3) {
        payload += 1 + (bytes[payload] || 0);
      }
      if (payload + 14 > offset + 188) continue;
      if (bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) {
        continue;
      }
      const flags = bytes[payload + 7] || 0;
      const headerLen = bytes[payload + 8] || 0;
      if ((flags & 0x80) === 0 || payload + 9 + headerLen > offset + 188) continue;
      const pts = readPts33(bytes, payload + 9);
      if (pts != null) return String(pts);
    }
    return null;
  }

  function sortTs(chunks) {
    if (!chunks.length) return null;
    const fragments = [];
    for (const chunk of chunks) {
      const key = tsChunkPts(chunk);
      if (key == null) return null;
      fragments.push({ key, bytes: chunk });
    }
    const unique = new Map();
    for (const fragment of fragments) {
      if (!unique.has(fragment.key)) unique.set(fragment.key, fragment.bytes);
    }
    return {
      init: null,
      fragments: Array.from(unique.entries())
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map((entry) => entry[1]),
      unordered: false,
    };
  }

  function looksLikeTs(chunks) {
    const bytes = new Uint8Array(chunks[0] || new ArrayBuffer(0));
    return tsSyncOffset(bytes) >= 0;
  }

  function normalizeBuffer(buffer) {
    if (!buffer.chunks.length) {
      return { init: null, fragments: [], unordered: false };
    }
    const fmp4 = sortFmp4(buffer.chunks);
    if (fmp4) return fmp4;
    const ts = sortTs(buffer.chunks);
    if (ts) return ts;
    return {
      init: null,
      fragments: buffer.chunks.slice(),
      unordered: !looksLikeTs(buffer.chunks),
    };
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
          const rec = { mime: String(mime || ""), chunks: [], bytes: 0 };
          owner.buffers.push(rec);
          sbRec.set(sourceBuffer, { owner, rec });
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
          const mapped = sbRec.get(this);
          if (!mapped || mapped.owner.truncated) return result;
          const copy = copyAppendArg(data);
          if (!copy) return result;
          const len = copy.byteLength;
          if (mapped.owner.bytes + len > CAP) {
            mapped.owner.truncated = true;
            mapped.rec.chunks.length = 0;
            return result;
          }
          mapped.owner.bytes += len;
          mapped.rec.bytes += len;
          mapped.rec.chunks.push(copy);
        } catch (_) {}
        return result;
      };
    }
  } catch (_) {}

  Object.defineProperty(window, "__kb_media__", {
    value: Object.freeze({
      hasDrm() {
        return drmDetected;
      },
      resolve(url) {
        const entry = registry.get(String(url || ""));
        if (!entry) return null;
        if (entry.kind === "blob") {
          return { kind: "blob", blob: entry.blob };
        }
        const data = msData.get(entry.ms);
        if (!data) {
          return { kind: "mse", buffers: [], truncated: false, drm: drmDetected };
        }
        return {
          kind: "mse",
          truncated: data.truncated,
          drm: drmDetected,
          buffers: data.buffers.map((buffer) => {
            const normalized = normalizeBuffer(buffer);
            return {
              mime: buffer.mime,
              bytes: buffer.bytes,
              init: normalized.init,
              fragments: normalized.fragments,
              drm: drmDetected,
              unordered: normalized.unordered,
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
