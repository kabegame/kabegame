import { ref, type Ref } from "vue";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { readFile } from "../fs/readFile";
import type { ImageInfo, ImageUrlMap } from "../types/image";
import { IS_ANDROID } from "../env";

type Entry = {
  thumbnail?: string; // blob:
  original?: string; // asset:
};

const DEFAULT_CAPACITY = 10000;
const DEFAULT_MAX_IN_FLIGHT = 12;

function normalizePath(p: string): string {
  return (p || "")
    .trimStart()
    .replace(/^\\\\\?\\/, "")
    .trim();
}

function looksLikeWindowsPath(p: string) {
  return /^[a-zA-Z]:\\/.test(p) || /^[a-zA-Z]:\//.test(p);
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
 * 全局图片 URL 缓存（LRU，capacity=10000）：
 * - thumbnail：默认是 Blob URL（需要 readFile -> Blob -> createObjectURL）；在 Linux 上改为 asset URL（与 original 一致）
 * - original：始终是 asset URL（convertFileSrc，同步）
 *
 * 注意：
 * - LRU 淘汰必须 revokeObjectURL，否则会泄漏（仅对 blob: 生效）
 * - 这里的 key 是 imageId（符合 imageSrcMap 语义），不做“按路径共享”
 */
class ImageUrlMapLruCache {
  private capacity: number;
  private maxInFlight: number;

  // LRU：Map 的插入顺序即 LRU 顺序；get 时触碰移动到队尾
  private lru = new Map<string, Entry>();

  // 对外暴露给 Vue 的响应式 map（ImageGrid 依赖它）
  public readonly imageUrlMap: Ref<ImageUrlMap> = ref<ImageUrlMap>({});

  // 缩略图生成中的去重
  private inFlightThumb = new Map<string, Promise<string>>();
  private inFlightThumbCancel = new Map<string, () => void>();
  private active = 0;
  private queue: Array<{
    imageId: string;
    run: () => void;
    cancel: () => void;
  }> = [];

  constructor(
    capacity = DEFAULT_CAPACITY,
    maxInFlight = DEFAULT_MAX_IN_FLIGHT
  ) {
    this.capacity = Math.max(1, capacity | 0);
    this.maxInFlight = Math.max(1, maxInFlight | 0);
  }

  public getCapacity() {
    return this.capacity;
  }

  public getSize() {
    return this.lru.size;
  }

  public has(imageId: string) {
    return this.lru.has(imageId);
  }

  /** 命中则返回 entry（并触碰为最近使用） */
  public get(imageId: string): Entry | undefined {
    const e = this.lru.get(imageId);
    if (!e) return undefined;
    this.touch(imageId, e);
    return e;
  }

  /** 仅查看，不触碰 */
  public peek(imageId: string): Entry | undefined {
    return this.lru.get(imageId);
  }

  public removeByIds(imageIds: string[]) {
    if (!imageIds || imageIds.length === 0) return;
    for (const id of imageIds) {
      const e = this.lru.get(id);
      this.lru.delete(id);
      if (e?.thumbnail?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(e.thumbnail);
        } catch {
          // ignore
        }
      }
      if (e?.original?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(e.original);
        } catch {
          // ignore
        }
      }
      // 响应式 map 同步删除
      delete (this.imageUrlMap.value as any)[id];
    }
  }

  private touch(imageId: string, e: Entry) {
    this.lru.delete(imageId);
    this.lru.set(imageId, e);
  }

  private evictIfNeeded() {
    while (this.lru.size > this.capacity) {
      const oldestKey = this.lru.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const e = this.lru.get(oldestKey);
      this.lru.delete(oldestKey);
      if (e?.thumbnail?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(e.thumbnail);
        } catch {
          // ignore
        }
      }
      if (e?.original?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(e.original);
        } catch {
          // ignore
        }
      }
      delete (this.imageUrlMap.value as any)[oldestKey];
    }
  }

  private enqueue(task: { imageId: string; run: () => void; cancel: () => void }) {
    if (this.active < this.maxInFlight) {
      this.active += 1;
      task.run();
      return;
    }
    this.queue.push(task);
  }

  private doneOne() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      this.active += 1;
      next.run();
    }
  }

  private toAssetUrl(localPath: string | undefined | null): string {
    const raw = (localPath || "").trim();
    if (!raw) return "";
    if (!isTauri()) return "";
    const normalized = normalizePath(raw);
    if (!normalized) return "";
    try {
      const u = convertFileSrc(normalized);
      if (!u || looksLikeWindowsPath(u)) return "";
      return u;
    } catch {
      return "";
    }
  }

  /** original：asset url（同步）或 content:// 时走 blob url（异步）。返回写入后的 url（可能为空字符串）。 */
  public ensureOriginalAssetUrl(imageId: string, localPath: string | undefined | null) {
    const raw = (localPath || "").trim();
    if (!raw) return "";
    if (!isTauri()) return "";
    if (IS_ANDROID && raw.startsWith("content://")) {
      void this.ensureOriginalBlobUrl(imageId, raw);
      return "";
    }
    const url = this.toAssetUrl(localPath);
    if (!url) return "";
    const prev = this.lru.get(imageId) || {};
    const next: Entry = { ...prev, original: url };
    this.touch(imageId, next);
    this.lru.set(imageId, next);
    this.imageUrlMap.value[imageId] = { ...(this.imageUrlMap.value[imageId] || {}), original: url };
    this.evictIfNeeded();
    return url;
  }

  /** original：content:// 时通过 readFile → Blob → createObjectURL 生成 blob url。 */
  public async ensureOriginalBlobUrl(
    imageId: string,
    contentUri: string | undefined | null
  ): Promise<string> {
    const raw = (contentUri || "").trim();
    if (!imageId || !raw || !raw.startsWith("content://")) return "";

    const hit = this.lru.get(imageId)?.original;
    if (hit && hit.startsWith("blob:")) {
      const e = this.lru.get(imageId);
      if (e) this.touch(imageId, e);
      return hit;
    }

    try {
      const fileData = await readFile(raw);
      if (!fileData || fileData.length === 0) return "";
      const mime = guessMimeType(raw);
      const blob = new Blob([fileData], { type: mime });
      if (!blob.size) return "";
      const url = URL.createObjectURL(blob);
      const prev = this.lru.get(imageId) || {};
      if (prev.original?.startsWith("blob:") && prev.original !== url) {
        try {
          URL.revokeObjectURL(prev.original);
        } catch {
          /* ignore */
        }
      }
      const next: Entry = { ...prev, original: url };
      this.lru.set(imageId, next);
      this.touch(imageId, next);
      this.imageUrlMap.value[imageId] = {
        ...(this.imageUrlMap.value[imageId] || {}),
        original: url,
      };
      this.evictIfNeeded();
      return url;
    } catch {
      return "";
    }
  }

  /**
   * thumbnail：始终 blob url（异步）。
   * - localPath 传入 thumbnailPath 或 localPath（由调用方决定优先级）
   */
  public ensureThumbnailBlobUrl(imageId: string, localPath: string | undefined | null): Promise<string> {
    const normalized = normalizePath(localPath || "");
    if (!imageId || !normalized) return Promise.resolve("");

    const hit = this.lru.get(imageId)?.thumbnail;
    if (hit && hit.startsWith("blob:")) {
      // touch
      const e = this.lru.get(imageId);
      if (e) this.touch(imageId, e);
      return Promise.resolve(hit);
    }

    const inflight = this.inFlightThumb.get(imageId);
    if (inflight) return inflight;

    let cancelled = false;
    let settled = false;
    let resolveOuter: (url: string) => void = () => {};
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      resolveOuter(url);
    };

    const cancel = () => {
      cancelled = true;
      finish("");
      this.inFlightThumb.delete(imageId);
      this.inFlightThumbCancel.delete(imageId);
    };
    this.inFlightThumbCancel.set(imageId, cancel);

    const p = new Promise<string>((resolve) => {
      resolveOuter = resolve;
      this.enqueue({
        imageId,
        cancel,
        run: () => {
          void (async () => {
            try {
              if (cancelled) return;

              const again = this.lru.get(imageId)?.thumbnail;
              if (again && again.startsWith("blob:")) {
                const e = this.lru.get(imageId);
                if (e) this.touch(imageId, e);
                finish(again);
                return;
              }

              const fileData = await readFile(normalized);
              if (cancelled) return;
              if (!fileData || fileData.length === 0) {
                finish("");
                return;
              }
              const mime = guessMimeType(normalized);
              const blob = new Blob([fileData], { type: mime });
              if (cancelled) return;
              if (!blob.size) {
                finish("");
                return;
              }
              const url = URL.createObjectURL(blob);
              if (cancelled) {
                try {
                  URL.revokeObjectURL(url);
                } catch {
                  // ignore
                }
                return;
              }

              // 替换时要 revoke 旧 blob url（避免泄漏）
              const prev = this.lru.get(imageId) || {};
              if (
                prev.thumbnail &&
                prev.thumbnail.startsWith("blob:") &&
                prev.thumbnail !== url
              ) {
                try {
                  URL.revokeObjectURL(prev.thumbnail);
                } catch {
                  // ignore
                }
              }
              const next: Entry = { ...prev, thumbnail: url };
              this.lru.set(imageId, next);
              this.touch(imageId, next);

              // 同步响应式 map（只更新该 id，避免全量拷贝）
              this.imageUrlMap.value[imageId] = {
                ...(this.imageUrlMap.value[imageId] || {}),
                thumbnail: url,
              };
              this.evictIfNeeded();
              finish(url);
            } catch {
              finish("");
            } finally {
              this.inFlightThumb.delete(imageId);
              this.inFlightThumbCancel.delete(imageId);
              this.doneOne();
            }
          })();
        },
      });
    });

    this.inFlightThumb.set(imageId, p);
    return p;
  }

  /**
   * 换大页/换列表时：终止所有缩略图 URL 生成任务。
   * - 队列中的任务会被取消并立刻 resolve ""
   * - 进行中的任务会被标记取消（readFile 无法强制中断，但不会再写入 imageUrlMap）
   */
  public cancelAllThumbnailLoads() {
    const queued = this.queue;
    this.queue = [];
    for (const t of queued) {
      try {
        t.cancel();
      } catch {
        // ignore
      }
    }
    for (const cancel of this.inFlightThumbCancel.values()) {
      try {
        cancel();
      } catch {
        // ignore
      }
    }
  }

  /** 小工具：按 ImageInfo 统一补齐（只做“缺什么补什么”）。 */
  public async ensureForImage(image: ImageInfo, needOriginal: boolean) {
    if (!image?.id) return;
    const current = this.imageUrlMap.value[image.id] || {};

    if (!current.thumbnail) {
      const thumbPath = (image.thumbnailPath || image.localPath || "").trim();
      if (thumbPath) {
        await this.ensureThumbnailBlobUrl(image.id, thumbPath);
      }
    }

    if (needOriginal && !current.original) {
      if (IS_ANDROID && (image.localPath || "").startsWith("content://")) {
        await this.ensureOriginalBlobUrl(image.id, image.localPath);
      } else {
        this.ensureOriginalAssetUrl(image.id, image.localPath);
      }
    }
  }
}

const singleton = new ImageUrlMapLruCache(DEFAULT_CAPACITY, DEFAULT_MAX_IN_FLIGHT);

export function useImageUrlMapCache() {
  return singleton;
}

