import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { albumImageCountQuery, normalizeAlbumRow, type Album } from "@/services/albums";
import {
  albumChangeKinds,
  albumPatchTriggers,
  kbEvent$,
  moveAlbumPath,
  type AlbumMovedPayload,
  type AlbumImagesPayload,
  albumEventAffectsDir,
  albumEventPaths,
  on,
  pathqlRequest$,
  usePathqlLookAll,
} from "@/services/kbEvents";

/** 只观察当前画册的结构快照与独立图片计数；不缓存全量画册。 */
export function useAlbumQuery(albumId: Ref<string | null>) {
  const album = ref<Album | null>(null);
  const ancestors = ref<Album[]>([]);
  const imageCount = ref(0);
  const descendantCount = ref(0);
  const self = () => (album.value?.id === albumId.value ? album.value?.ancestorPath : undefined);
  const sameChainPath = (paths: string[] | "wildcard", id: string | undefined) => {
    const path = self();
    if (!path) return !!albumId.value && id === albumId.value;
    return paths === "wildcard" || paths.some((p) => p.startsWith(path) || path.startsWith(p));
  };
  const sameChain = (name: string, payload: unknown, id: string | undefined) =>
    sameChainPath(albumEventPaths(name, payload), id);
  const affectsCount = (name: string, payload: unknown) => {
    const path = self();
    return !!path && albumEventAffectsDir(name, payload, path);
  };

  // 补丁不携带位置；已持有行用自身路径定位，未知行保持保守刷新。
  const heldPath = (id: string) => [album.value, ...ancestors.value].find((a) => a?.id === id)?.ancestorPath;
  // 计数路径 album-tree/<id> 不带 hide/：只看自身或子孙的成员增删（隐藏画册事件只在当前画册就是隐藏画册时命中）
  const memberAffectsCount = (p: AlbumImagesPayload) =>
    !!albumId.value && (p.albumId === albumId.value || (!!self() && p.ancestorPath.startsWith(self()!)));

  const detail = usePathqlLookAll({
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
      ...albumPatchTriggers(
        (patch) =>
          patch.id === albumId.value ||
          (albumChangeKinds(patch).structure &&
            sameChainPath(heldPath(patch.id) ? [heldPath(patch.id)!] : "wildcard", patch.id)),
      ),
      on("albums-added", (p) => p.albums.some((a) => sameChain("albums-added", { albums: [a] }, a.id))),
      on("albums-deleted", (p) => p.albums.some((a) => sameChain("albums-deleted", { albums: [a] }, a.id))),
      on("album-moved", (p) => sameChain("album-moved", p, p.id)),
    ],
    onResult: ([rows, parents, subtree]) => {
      album.value = rows[0] ? normalizeAlbumRow(rows[0]) : null;
      ancestors.value = album.value ? parents.map(normalizeAlbumRow) : [];
      descendantCount.value = album.value ? (subtree.total ?? 0) : 0;
      if (!album.value) imageCount.value = 0;
    },
  });
  const count = usePathqlLookAll({
    queries: () =>
      album.value && album.value.id === albumId.value ? ([albumImageCountQuery(album.value)] as const) : null,
    refreshOn: [
      on("album-images-added", memberAffectsCount),
      on("album-images-deleted", memberAffectsCount),
      on("album-images-change", memberAffectsCount),
      on("albums-added", (p) => affectsCount("albums-added", p)),
      on(
        "albums-deleted",
        (p) =>
          !!self() &&
          p.albums.some((a) => self()!.startsWith(a.ancestorPath) || affectsCount("albums-deleted", { albums: [a] })),
      ),
      on("album-moved", (p) => affectsCount("album-moved", p)),
      ...albumPatchTriggers(
        (patch) =>
          albumChangeKinds(patch).structure &&
          !!self() &&
          (!heldPath(patch.id) || (heldPath(patch.id) !== self() && heldPath(patch.id)!.startsWith(self()!))),
      ),
    ],
    onResult: ([total]) => {
      imageCount.value = total;
    },
  });
  const moved = kbEvent$<AlbumMovedPayload>("album-moved").subscribe(({ payload }) => {
    if (album.value) album.value = moveAlbumPath(album.value, payload);
    ancestors.value = ancestors.value.map((a) => moveAlbumPath(a, payload));
  });
  onScopeDispose(() => moved.unsubscribe());
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
