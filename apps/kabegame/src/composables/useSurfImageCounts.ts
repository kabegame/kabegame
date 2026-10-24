import { computed, shallowReactive, watch } from "vue";
import { useSurfStore } from "@/stores/surf";
import { useGlobalPathRoute } from "@/stores/pathRoute";
import { isHiddenAlbumChange, on, pathqlAllKey, pathqlRequest$, usePathqlLookMany } from "@/services/kbEvents";
import { buildGallerySurfPath } from "@/utils/surfMediaCount";
import { withGalleryPrefix } from "@/utils/path";

/** 页内观察，每个站点的计数 key 独立注册与释放，离开页面即停止观察。 */
export function useSurfImageCounts() {
  const surfStore = useSurfStore();
  const globalRoute = useGlobalPathRoute();
  const recordsByKey = computed(
    () =>
      new Map(
        surfStore.records.map((record) => [
          pathqlAllKey([
            { kind: "count", path: withGalleryPrefix(buildGallerySurfPath(record.host, globalRoute.hide)) },
          ]),
          record,
        ]),
      ),
  );
  const keys = computed(() => [...recordsByKey.value.keys()]);
  // 按 host 保留最后可得的数：hide 切换换 key 时旧数先留着，新结果到达再覆盖，不闪 0
  const counts = shallowReactive(new Map<string, number>());

  usePathqlLookMany({
    kind: "all",
    keys: () => keys.value,
    refreshOn: (key) => [
      on("images-added", (p) => {
        const record = recordsByKey.value.get(key);
        return !!record && p.images.some((image) => image.surfRecordId === record.id);
      }),
      on("images-deleted"),
      on("images-change", (p) =>
        p.patches.some((patch) => Object.prototype.hasOwnProperty.call(patch, "surfRecordId")),
      ),
      on("image-changed", (p) => Object.prototype.hasOwnProperty.call(p.patch, "surfRecordId")),
      on("album-images-added", (p) => globalRoute.hide && isHiddenAlbumChange(p)),
      on("album-images-deleted", (p) => globalRoute.hide && isHiddenAlbumChange(p)),
      on("album-images-change", (p) => globalRoute.hide && isHiddenAlbumChange(p)),
    ],
    onResult: (key, { results }) => {
      const record = recordsByKey.value.get(key);
      if (record) counts.set(record.host, Number(results[0]) || 0);
    },
  });
  // 先由观察方同步注册，再请求新进入的 key；hide、首次加载与记录增删都走这一条用户操作通路。
  watch(
    keys,
    (next, previous = []) => {
      const before = new Set(previous);
      const hosts = new Set(surfStore.records.map((record) => record.host));
      for (const host of counts.keys()) if (!hosts.has(host)) counts.delete(host);
      for (const key of next) if (!before.has(key)) pathqlRequest$.next(["all", key]);
    },
    { immediate: true, flush: "sync" },
  );

  return {
    countOf: (host: string) => counts.get(host) ?? 0,
  };
}
