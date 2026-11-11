import { computed, ref, shallowRef, watch } from "vue";
import { on, pathqlRequest$, usePathqlLooker } from "@/services/kbEvents";
import { COLOR_BUCKETS_PATH, normalizeColorBucketRows, type ColorBucket } from "@/services/colorBuckets";
import { logger } from "@/utils/logger";

/**
 * 色桶列表：`color_buckets://` 的观察方，色桶增删（`color-buckets-change`）时由核心窗口重读。
 * 列表是「按某个颜色排序该用哪个段」的依据（`colorSortFor` 用 `bucketHexes`）。
 *
 * `enabled` 为 false 时不观察、不请求（用不到颜色排序的页面不必读这张表），`loaded` 回到 false。
 * 同一个 key 的观察方共用一份数据：后来的观察方直接拿到已有的列表，只有还没人读过时才请求。
 */
export function useColorBuckets(enabled: () => boolean = () => true) {
  const buckets = shallowRef<ColorBucket[]>([]);
  /** 列表至少成功读到过一次；在此之前不能据它判断「某个颜色不是色桶」。 */
  const loaded = ref(false);

  const key = () => (enabled() ? COLOR_BUCKETS_PATH : null);

  const looker = usePathqlLooker({
    kind: "rows",
    key,
    refreshOn: [on("color-buckets-change")],
    onResult: ({ rows }) => {
      buckets.value = normalizeColorBucketRows(rows);
      loaded.value = true;
    },
    // 读取失败保留已有列表
    onError: (error) => logger.warn("读取色桶列表失败:", error),
  });

  // 观察方注册时会同步拿到该 key 最后可得的数据与最新请求的状态：已有数据或已有请求在途就不再请求。
  // 放在 usePathqlLooker 之后注册，保证先成为观察方。
  watch(
    key,
    (next) => {
      if (!next) {
        // 停止观察期间收不到增删事件，手里的列表可能过期：重新启用时要么从别的观察方拿到最新的，要么重读
        loaded.value = false;
        return;
      }
      if (!loaded.value && !looker.loading.value) pathqlRequest$.next(["rows", next]);
    },
    { immediate: true, flush: "sync" },
  );

  const bucketHexes = computed<ReadonlySet<string>>(() => new Set(buckets.value.map((bucket) => bucket.hex)));

  return { buckets, bucketHexes, loading: looker.loading, loaded };
}
