import { readFile } from "@tauri-apps/plugin-fs";

type BlobCacheEntry = {
  url: string;
  blob: Blob;
  mime: string;
  bytes: number;
};

const DEFAULT_CAPACITY = 10000;
const DEFAULT_MAX_IN_FLIGHT = 12;

function normalizePath(p: string): string {
  return (p || "")
    .trimStart()
    .replace(/^\\\\\?\\/, "")
    .trim();
}

function guessMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "avif") return "image/avif";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}

/**
 * 浏览器内存 LRU：key -> Blob URL
 *
 * - Map 的插入顺序即 LRU 顺序：get 时会“触碰”并移动到队尾
 * - 淘汰时必须 revokeObjectURL，否则会泄漏
 */
class BlobUrlLruCache {
  private capacity: number;
  private maxInFlight: number;
  private map = new Map<string, BlobCacheEntry>();
  private inFlight = new Map<string, Promise<string>>();

  private active = 0;
  private queue: Array<() => void> = [];

  constructor(
    capacity = DEFAULT_CAPACITY,
    maxInFlight = DEFAULT_MAX_IN_FLIGHT
  ) {
    this.capacity = Math.max(1, capacity | 0);
    this.maxInFlight = Math.max(1, maxInFlight | 0);
  }

  public getSize() {
    return this.map.size;
  }

  public getCapacity() {
    return this.capacity;
  }

  public setCapacity(next: number) {
    this.capacity = Math.max(1, next | 0);
    this.evictIfNeeded();
  }

  /** 命中则返回 blob url；并触碰为“最近使用” */
  public get(key: string): string {
    const e = this.map.get(key);
    if (!e) return "";
    // touch: 维持 LRU
    this.map.delete(key);
    this.map.set(key, e);
    return e.url;
  }

  /** 仅检查是否命中（不触碰） */
  public peek(key: string): string {
    return this.map.get(key)?.url || "";
  }

  public has(key: string) {
    return this.map.has(key);
  }

  public clear() {
    for (const e of this.map.values()) {
      try {
        URL.revokeObjectURL(e.url);
      } catch {
        // ignore
      }
    }
    this.map.clear();
    this.inFlight.clear();
    this.queue = [];
    this.active = 0;
  }

  private evictIfNeeded() {
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const e = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (e) {
        try {
          URL.revokeObjectURL(e.url);
        } catch {
          // ignore
        }
      }
    }
  }

  private enqueue(task: () => void) {
    if (this.active < this.maxInFlight) {
      this.active += 1;
      task();
      return;
    }
    this.queue.push(task);
  }

  private doneOne() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      this.active += 1;
      next();
    }
  }

  /**
   * 确保 key 对应的 blob url 存在（LRU 内）。
   * - 已存在：直接返回（会触碰）
   * - 正在生成：复用同一个 promise
   * - 否则：readFile -> Blob -> objectURL -> set
   */
  public ensureThumbnailFromLocalPath(localPath: string): Promise<string> {
    const normalized = normalizePath(localPath);
    if (!normalized) return Promise.resolve("");
    const key = `thumb:${normalized}`;

    const hit = this.get(key);
    if (hit) return Promise.resolve(hit);

    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;

    const p = new Promise<string>((resolve) => {
      this.enqueue(async () => {
        try {
          const again = this.get(key);
          if (again) {
            resolve(again);
            return;
          }

          const fileData = await readFile(normalized);
          if (!fileData || fileData.length === 0) {
            resolve("");
            return;
          }
          const mime = guessMimeType(normalized);
          const blob = new Blob([fileData], { type: mime });
          if (!blob.size) {
            resolve("");
            return;
          }
          const url = URL.createObjectURL(blob);
          const entry: BlobCacheEntry = {
            url,
            blob,
            mime,
            bytes: blob.size,
          };
          this.map.set(key, entry);
          this.evictIfNeeded();
          resolve(url);
        } catch {
          resolve("");
        } finally {
          this.inFlight.delete(key);
          this.doneOne();
        }
      });
    });

    this.inFlight.set(key, p);
    return p;
  }
}

// 全局单例：跨页面/组件共享（LRU 的意义在于“复用近期浏览过的图”）
const singleton = new BlobUrlLruCache(DEFAULT_CAPACITY, DEFAULT_MAX_IN_FLIGHT);

export function useBlobUrlLruCache() {
  return singleton;
}
