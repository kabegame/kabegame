import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import {
  fetchAlbum,
  fetchAlbumAncestors,
  fetchAlbumCount,
  fetchDescendantCount,
  type Album,
} from "@/services/albums";
import { affectsAlbumDir, subscribeChanges } from "@/services/dataChangeHub";
import { GRID_REFRESH_WAIT_MS } from "@/services/liveQuery";

/** 只维护当前画册详情；不缓存全量画册或全量计数。 */
export function useAlbumQuery(albumId: Ref<string | null>) {
  const album = ref<Album | null>(null);
  const ancestors = ref<Album[]>([]);
  const imageCount = ref(0);
  const descendantCount = ref(0);
  const loading = ref(false);
  let token = 0;

  const parentPath = computed(() => {
    const current = album.value;
    if (!current) return null;
    return current.ancestorPath.replace(new RegExp(`${current.id}/$`), "");
  });

  async function refresh() {
    const id = albumId.value;
    const currentToken = ++token;
    if (!id) {
      album.value = null;
      ancestors.value = [];
      imageCount.value = 0;
      descendantCount.value = 0;
      return;
    }
    loading.value = true;
    try {
      const current = await fetchAlbum(id);
      if (currentToken !== token) return;
      album.value = current;
      if (!current) {
        ancestors.value = [];
        imageCount.value = 0;
        descendantCount.value = 0;
        return;
      }
      const [nextAncestors, nextImageCount, nextDescendantCount] = await Promise.all([
        fetchAlbumAncestors(id),
        fetchAlbumCount(current, ""),
        fetchDescendantCount(id),
      ]);
      if (currentToken !== token) return;
      ancestors.value = nextAncestors;
      imageCount.value = nextImageCount;
      descendantCount.value = nextDescendantCount;
    } finally {
      if (currentToken === token) loading.value = false;
    }
  }

  watch(albumId, () => void refresh(), { immediate: true });
  const unsubscribe = subscribeChanges({
    waitMs: GRID_REFRESH_WAIT_MS,
    filter: (batch) =>
      (!!albumId.value && batch.albumIds.has(albumId.value)) ||
      batch.albumStructure.size > 0 && affectsAlbumDir(batch, parentPath.value),
    onBatch: refresh,
  });
  onBeforeUnmount(unsubscribe);

  return { album, ancestors, imageCount, descendantCount, loading, refresh };
}
