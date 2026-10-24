import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { albumImageCountQuery, normalizeAlbumRow, type Album } from "@/services/albums";
import {
  albumPatchTriggers,
  kbEvent$,
  moveAlbumPath,
  type AlbumMovedPayload,
  type AlbumImagesPayload,
  pathHasAlbum,
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
  const inChain = (id: string) => id === albumId.value || (!!self() && pathHasAlbum(self()!, id));
  // 路径尚未落地或事件缺路径时无法排除影响，保持保守刷新。
  const underSelf = (path: string) => !self() || !path || (path !== self() && path.startsWith(self()!));
  const inChainPath = (path: string) => !self() || !path || self()!.startsWith(path);
  const labelDir = () => album.value?.type === "label_dir";
  const label = () => album.value?.type === "label";
  const directChild = (path: string) => {
    if (!self() || !path) return true;
    const parts = path.split("/").filter(Boolean);
    return `/${parts.slice(0, -1).join("/")}/` === self();
  };
  const anyPath = (name: string, payload: unknown, test: (path: string) => boolean) => {
    const paths = albumEventPaths(name, payload);
    return paths === "wildcard" || paths.some(test);
  };
  // 计数不叠加 hide/：标签目录无成员计数，标签只看直接成员，其余看自身与子树。
  const memberAffectsCount = (p: AlbumImagesPayload) =>
    !labelDir() &&
    (p.albumId === albumId.value || (!label() && (!self() || !p.ancestorPath || p.ancestorPath.startsWith(self()!))));

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
      ...albumPatchTriggers((patch, kinds) => patch.id === albumId.value || (inChain(patch.id) && kinds.structure)),
      on("albums-added", (p) => anyPath("albums-added", p, underSelf)),
      on("albums-deleted", (p) => anyPath("albums-deleted", p, (path) => inChainPath(path) || underSelf(path))),
      on("album-moved", (p) => inChain(p.id) || underSelf(p.oldAncestorPath) || underSelf(p.newAncestorPath)),
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
      on("albums-added", (p) => labelDir() && anyPath("albums-added", p, directChild)),
      on("albums-deleted", (p) => !label() && anyPath("albums-deleted", p, labelDir() ? directChild : underSelf)),
      on("album-moved", (p) => {
        if (label()) return false;
        if (labelDir()) return anyPath("album-moved", p, directChild);
        if (inChain(p.id)) return false;
        if (!self() || !p.oldAncestorPath || !p.newAncestorPath) return true;
        return underSelf(p.oldAncestorPath) !== underSelf(p.newAncestorPath);
      }),
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
