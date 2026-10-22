import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { albumImageCountQuery, normalizeAlbumRow, type Album } from "@/services/albums";
import {
  albumChangeKinds,
  albumEventAffectsDir,
  albumEventPaths,
  on,
  pathqlRequest$,
  useLookAll,
} from "@/services/kbEvents";

/** 只观察当前画册的结构快照与独立图片计数；不缓存全量画册。 */
export function useAlbumQuery(albumId: Ref<string | null>) {
  const album = ref<Album | null>(null);
  const ancestors = ref<Album[]>([]);
  const imageCount = ref(0);
  const descendantCount = ref(0);
  const self = () => (album.value?.id === albumId.value ? album.value?.ancestorPath : undefined);
  const sameChain = (name: string, payload: unknown, id: string | undefined) => {
    const path = self();
    if (!path) return !!albumId.value && id === albumId.value;
    const paths = albumEventPaths(name, payload);
    return paths === "wildcard" || paths.some((p) => p.startsWith(path) || path.startsWith(p));
  };
  const affectsCount = (name: string, payload: unknown) => {
    const path = self();
    return !!path && albumEventAffectsDir(name, payload, path);
  };

  const detail = useLookAll({
    queries: () => {
      if (!albumId.value) return null;
      const id = encodeURIComponent(albumId.value);
      return [
        { kind: "fetch", path: `albums://id_${id}` },
        { kind: "fetch", path: `albums://ancestors_${id}` },
        { kind: "entry", path: `albums://subtree_${id}` },
      ] as const;
    },
    refreshOn: [
      on(
        "album-changed",
        (p) =>
          p.albumId === albumId.value || (albumChangeKinds(p).structure && sameChain("album-changed", p, p.albumId)),
      ),
      on("album-added", (p) => sameChain("album-added", p, p.id)),
      on("album-deleted", (p) => sameChain("album-deleted", p, p.albumId)),
    ],
    onResult: ([rows, parents, subtree]) => {
      album.value = rows[0] ? normalizeAlbumRow(rows[0]) : null;
      ancestors.value = album.value ? parents.map(normalizeAlbumRow) : [];
      descendantCount.value = album.value ? (subtree.total ?? 0) : 0;
      if (!album.value) imageCount.value = 0;
    },
  });
  const count = useLookAll({
    queries: () =>
      album.value && album.value.id === albumId.value ? ([albumImageCountQuery(album.value)] as const) : null,
    refreshOn: [
      on(
        "album-images-change",
        (p) =>
          !!albumId.value &&
          (!!p.albumIds?.includes(albumId.value) || (!!self() && !!p.ancestorPath?.startsWith(self()!))),
      ),
      on("album-added", (p) => affectsCount("album-added", p)),
      on("album-deleted", (p) => affectsCount("album-deleted", p)),
      on("album-changed", (p) => albumChangeKinds(p).structure && affectsCount("album-changed", p)),
    ],
    onResult: ([total]) => {
      imageCount.value = total;
    },
  });
  const loading = computed(() => detail.loading.value || count.loading.value);

  // Promise 等待属于模型；post 等待本轮 A 落地、B 换 key 并发出请求后再检查，避免中间态提前完成。
  const waiters = new Set<() => void>();
  const finishWaiting = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  watch(
    loading,
    (pending) => {
      if (!pending) finishWaiting();
    },
    { flush: "post" },
  );
  onScopeDispose(finishWaiting);

  watch(
    count.key,
    (key) => {
      if (key) pathqlRequest$.next(["all", key]);
    },
    { immediate: true, flush: "sync" },
  );
  // 必须在观察方创建后请求，next 时同步置 loading，首屏不会被误判为画册已删除。
  watch(
    albumId,
    () => {
      finishWaiting();
      const key = detail.key();
      if (key) pathqlRequest$.next(["all", key]);
      else {
        album.value = null;
        ancestors.value = [];
        imageCount.value = 0;
        descendantCount.value = 0;
      }
    },
    { immediate: true, flush: "sync" },
  );

  function refresh(): Promise<void> {
    const key = detail.key();
    if (!key) return Promise.resolve();
    const done = new Promise<void>((resolve) => waiters.add(resolve));
    pathqlRequest$.next(["all", key]);
    const countKey = count.key();
    if (countKey) pathqlRequest$.next(["all", countKey]);
    return done;
  }

  return { album, ancestors, imageCount, descendantCount, loading, refresh };
}
