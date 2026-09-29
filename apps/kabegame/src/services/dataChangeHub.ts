import { listen } from "@/api/rpc";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
const FAVORITE_ALBUM_ID = "favorite";
import { BoundedSet } from "@/utils/BoundedSet";
import { sendDebugEvent } from "@kabegame/core/debugIngest"; // DEBUG-PERF
const perf = (name: string, payload: unknown) => void sendDebugEvent(name, payload, { sessionId: "eventworker-perf" }); // DEBUG-PERF

export interface ChangeBatch {
  images: Set<string>;
  imageIds: Set<string>;
  taskIds: Set<string>;
  surfRecordIds: Set<string>;
  pluginIds: Set<string>;
  albumImages: Set<string>;
  albumIds: Set<string>;
  albumImageIds: Set<string>;
  favoriteOps: { imageIds: string[]; favorite: boolean }[];
  albumStructure: Set<string>;
  albumPaths: Set<string>;
  albumPathsWildcard: boolean;
  wildcard: { task: boolean; surf: boolean; plugin: boolean };
  maxSeq: number;
}

type Subscriber = {
  waitMs: number;
  filter?: (batch: ChangeBatch) => boolean;
  onBatch: (batch: ChangeBatch) => Promise<void> | void;
  timer: ReturnType<typeof setTimeout> | null;
  trailing: ChangeBatch | null;
  running: boolean;
  pending: ChangeBatch | null;
  active: boolean;
};

const subscribers = new Set<Subscriber>();

function setValues(target: Set<string>, values: Iterable<string>) {
  for (const value of values) target.add(value);
}

function mergeBatch(target: ChangeBatch | null, incoming: ChangeBatch): ChangeBatch {
  if (!target) {
    return {
      images: new Set(incoming.images),
      imageIds: new Set(incoming.imageIds),
      taskIds: new Set(incoming.taskIds),
      surfRecordIds: new Set(incoming.surfRecordIds),
      pluginIds: new Set(incoming.pluginIds),
      albumImages: new Set(incoming.albumImages),
      albumIds: new Set(incoming.albumIds),
      albumImageIds: new Set(incoming.albumImageIds),
      favoriteOps: incoming.favoriteOps.map((op) => ({ ...op, imageIds: [...op.imageIds] })),
      albumStructure: new Set(incoming.albumStructure),
      albumPaths: new Set(incoming.albumPaths),
      albumPathsWildcard: incoming.albumPathsWildcard,
      wildcard: { ...incoming.wildcard },
      maxSeq: incoming.maxSeq,
    };
  }
  setValues(target.images, incoming.images);
  setValues(target.imageIds, incoming.imageIds);
  setValues(target.taskIds, incoming.taskIds);
  setValues(target.surfRecordIds, incoming.surfRecordIds);
  setValues(target.pluginIds, incoming.pluginIds);
  setValues(target.albumImages, incoming.albumImages);
  setValues(target.albumIds, incoming.albumIds);
  setValues(target.albumImageIds, incoming.albumImageIds);
  target.favoriteOps.push(...incoming.favoriteOps);
  setValues(target.albumStructure, incoming.albumStructure);
  setValues(target.albumPaths, incoming.albumPaths);
  target.albumPathsWildcard ||= incoming.albumPathsWildcard;
  target.wildcard.task ||= incoming.wildcard.task;
  target.wildcard.surf ||= incoming.wildcard.surf;
  target.wildcard.plugin ||= incoming.wildcard.plugin;
  target.maxSeq = Math.max(target.maxSeq, incoming.maxSeq);
  return target;
}

async function drain(subscriber: Subscriber, batch: ChangeBatch) {
  if (!subscriber.active || subscriber.filter?.(batch) === false) return;
  if (subscriber.running) {
    subscriber.pending = mergeBatch(subscriber.pending, batch);
    return;
  }
  subscriber.running = true;
  try {
    await subscriber.onBatch(batch);
  } catch (error) {
    console.error("处理数据变更批次失败:", error);
  } finally {
    subscriber.running = false;
    const pending = subscriber.pending;
    subscriber.pending = null;
    if (pending && subscriber.active) void drain(subscriber, pending);
  }
}

function pushToSubscriber(subscriber: Subscriber, batch: ChangeBatch) {
  if (!subscriber.active) return;
  if (!subscriber.timer) {
    void drain(subscriber, mergeBatch(null, batch));
    subscriber.timer = setTimeout(() => {
      subscriber.timer = null;
      const trailing = subscriber.trailing;
      subscriber.trailing = null;
      if (trailing) void drain(subscriber, trailing);
    }, subscriber.waitMs);
    return;
  }
  subscriber.trailing = mergeBatch(subscriber.trailing, batch);
}

function emitBatch(batch: ChangeBatch) {
  for (const subscriber of subscribers) pushToSubscriber(subscriber, batch);
}

const deliveredSeqs = new BoundedSet<number>(4096);

/** 本地写命令的结果立即投递；随后到达的同 seq 后端事件会被丢弃。 */
export function publishLocal(batch: ChangeBatch) {
  if (batch.maxSeq > 0) deliveredSeqs.add(batch.maxSeq);
  for (const subscriber of subscribers) {
    if (subscriber.active) void drain(subscriber, mergeBatch(null, batch));
  }
}

type AlbumChangedPayload = {
  seq?: number;
  albumId?: string;
  changes?: Record<string, unknown>;
};

type AlbumAddedPayload = {
  id?: string;
  ancestorPath?: string;
};

type AlbumDeletedPayload = {
  albumId?: string;
  parentId?: string | null;
  ancestorPath?: string;
};

type ChangeSource = {
  event: string;
  toBatch: (payload: unknown) => ChangeBatch | null;
};

function emptyBatch(seq = 0): ChangeBatch {
  return {
    images: new Set(),
    imageIds: new Set(),
    taskIds: new Set(),
    surfRecordIds: new Set(),
    pluginIds: new Set(),
    albumImages: new Set(),
    albumIds: new Set(),
    albumImageIds: new Set(),
    favoriteOps: [],
    albumStructure: new Set(),
    albumPaths: new Set(),
    albumPathsWildcard: false,
    wildcard: { task: false, surf: false, plugin: false },
    maxSeq: seq,
  };
}

const sources: ChangeSource[] = [
  {
    event: "images-change",
    toBatch(raw): ChangeBatch {
      const payload = raw as ImagesChangePayload;
      const batch = emptyBatch(Number.isFinite(payload.seq) ? Number(payload.seq) : 0);
      batch.images = new Set(payload.reason ? [payload.reason] : []);
      batch.imageIds = new Set(payload.imageIds ?? []);
      batch.taskIds = new Set(payload.taskIds ?? []);
      batch.surfRecordIds = new Set(payload.surfRecordIds ?? []);
      batch.pluginIds = new Set(payload.pluginIds ?? []);
      batch.wildcard = {
        task: !Array.isArray(payload.taskIds),
        surf: !Array.isArray(payload.surfRecordIds),
        plugin: !Array.isArray(payload.pluginIds),
      };
      return batch;
    },
  },
  {
    event: "album-images-change",
    toBatch(raw): ChangeBatch {
      const payload = raw as AlbumImagesChangePayload;
      const batch = emptyBatch(Number.isFinite(payload.seq) ? Number(payload.seq) : 0);
      batch.albumImages = new Set(payload.reason ? [payload.reason] : []);
      batch.albumIds = new Set(payload.albumIds ?? []);
      batch.albumImageIds = new Set(payload.imageIds ?? []);
      if (payload.ancestorPath) batch.albumPaths.add(payload.ancestorPath);
      else batch.albumPathsWildcard = true;
      if ((payload.albumIds ?? []).includes(FAVORITE_ALBUM_ID)) {
        if (payload.reason === "add" || payload.reason === "add-hidden") {
          batch.favoriteOps.push({ imageIds: [...(payload.imageIds ?? [])], favorite: true });
        } else if (payload.reason === "delete" || payload.reason === "delete-hidden") {
          batch.favoriteOps.push({ imageIds: [...(payload.imageIds ?? [])], favorite: false });
        }
      }
      return batch;
    },
  },
  {
    event: "album-added",
    toBatch(raw): ChangeBatch {
      const payload = raw as AlbumAddedPayload;
      const batch = emptyBatch();
      if (payload.id) batch.albumIds.add(payload.id);
      batch.albumStructure.add("added");
      if (payload.ancestorPath) batch.albumPaths.add(payload.ancestorPath);
      else batch.albumPathsWildcard = true;
      return batch;
    },
  },
  {
    event: "album-deleted",
    toBatch(raw): ChangeBatch {
      const payload = raw as AlbumDeletedPayload;
      const batch = emptyBatch();
      if (payload.albumId) batch.albumIds.add(payload.albumId);
      batch.albumStructure.add("deleted");
      if (payload.ancestorPath) batch.albumPaths.add(payload.ancestorPath);
      else batch.albumPathsWildcard = true;
      return batch;
    },
  },
  {
    event: "album-changed",
    toBatch(raw): ChangeBatch | null {
      const payload = raw as AlbumChangedPayload;
      const structureFields = ["name", "parentId", "labelKey", "albumType"].filter((field) =>
        Object.prototype.hasOwnProperty.call(payload.changes ?? {}, field),
      );
      if (structureFields.length === 0) return null;
      const batch = emptyBatch(Number.isFinite(payload.seq) ? Number(payload.seq) : 0);
      batch.albumStructure = new Set(structureFields);
      if (payload.albumId) batch.albumIds.add(payload.albumId);
      const paths = [payload.changes?.ancestorPath, payload.changes?.oldAncestorPath].filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      );
      if (paths.length > 0) setValues(batch.albumPaths, paths);
      else batch.albumPathsWildcard = true;
      return batch;
    },
  },
];

let sourcesStarted = false;

function ensureSourcesStarted() {
  if (sourcesStarted) return;
  sourcesStarted = true;
  for (const source of sources) {
    void listen<unknown>(source.event, (event) => {
      const payload = (event?.payload ?? {}) as Record<string, unknown>;
      perf("hub_event", { event: source.event, seq: payload.seq, reason: payload.reason, nImageIds: Array.isArray(payload.imageIds) ? payload.imageIds.length : 0, subscribers: subscribers.size }); // DEBUG-PERF
      const batch = source.toBatch(payload);
      if (!batch) return;
      if (batch.maxSeq > 0 && deliveredSeqs.has(batch.maxSeq)) return;
      emitBatch(batch);
    }).catch((error) => {
      console.error(`监听 ${source.event} 失败:`, error);
    });
  }
}

/** 目录路径为 null 表示分区根；其它目录只关心其后代路径。 */
export function affectsAlbumDir(batch: ChangeBatch, dirAncestorPath: string | null): boolean {
  if (batch.albumPathsWildcard) return true;
  if (dirAncestorPath === null) {
    return batch.albumPaths.size > 0 || batch.albumIds.size > 0 || batch.albumStructure.size > 0;
  }
  for (const path of batch.albumPaths) {
    if (path !== dirAncestorPath && path.startsWith(dirAncestorPath)) return true;
  }
  return false;
}

/** 将单条画册成员变更转换为可即时发布的批次。 */
export function albumChangeBatch(payload: AlbumImagesChangePayload): ChangeBatch {
  const source = sources.find((item) => item.event === "album-images-change");
  return source?.toBatch(payload) ?? emptyBatch(payload.seq);
}

export function subscribeChanges(opts: {
  waitMs: number;
  filter?: (batch: ChangeBatch) => boolean;
  onBatch: (batch: ChangeBatch) => Promise<void> | void;
}): () => void {
  const subscriber: Subscriber = {
    ...opts,
    timer: null,
    trailing: null,
    running: false,
    pending: null,
    active: true,
  };
  subscribers.add(subscriber);
  ensureSourcesStarted();
  return () => {
    subscriber.active = false;
    subscribers.delete(subscriber);
    if (subscriber.timer) clearTimeout(subscriber.timer);
    subscriber.timer = null;
    subscriber.trailing = null;
    subscriber.pending = null;
  };
}
