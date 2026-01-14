import { computed, ref, watch } from "vue";
import type {
  RouteLocationNormalizedLoaded,
  RouteParamsRaw,
  Router,
} from "vue-router";

type UseBigPageRouteOptions = {
  route: RouteLocationNormalizedLoaded;
  router: Router;
  baseRouteName: string;
  pagedRouteName: string;
  getBaseParams: () => RouteParamsRaw;
  getPagedParams: (page: number) => RouteParamsRaw;
  pageParamKey?: string; // default: "page"
  bigPageSize?: number; // default: 1000
  /** 是否把 currentPage 的修正值同步回 URL（例如非法 page / 缺省 page） */
  syncPageToUrl?: boolean; // default: true
};

function parsePageParam(v: unknown): number {
  const n =
    typeof v === "string"
      ? parseInt(v, 10)
      : Array.isArray(v) && typeof v[0] === "string"
      ? parseInt(v[0], 10)
      : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function useBigPageRoute(options: UseBigPageRouteOptions) {
  const pageParamKey = options.pageParamKey ?? "page";
  const bigPageSize = computed(() => options.bigPageSize ?? 1000);

  const currentPage = ref(1);

  const isOnTargetRoute = computed(() => {
    const name = options.route.name;
    if (!name) return false;
    const n = String(name);
    return n === options.baseRouteName || n === options.pagedRouteName;
  });

  const getRoutePage = () =>
    parsePageParam((options.route.params as any)?.[pageParamKey]);

  watch(
    () =>
      [
        options.route.name,
        (options.route.params as any)?.[pageParamKey],
      ] as const,
    ([, v]) => {
      // keep-alive 场景：组件可能在后台，但 useRoute() 仍会跟随全局路由变化。
      // 这里只在目标路由（base/paged）激活时才同步 page，避免污染其它页面。
      if (!isOnTargetRoute.value) return;
      currentPage.value = parsePageParam(v);
    },
    { immediate: true }
  );

  const replaceRouteForPage = async (page: number) => {
    const safe = Math.max(1, Math.floor(page || 1));
    if (safe === 1) {
      await options.router.replace({
        name: options.baseRouteName,
        params: options.getBaseParams(),
      });
    } else {
      await options.router.replace({
        name: options.pagedRouteName,
        params: options.getPagedParams(safe),
      });
    }
  };

  // 将 currentPage 的变化（可能来自代码自动纠正）同步回 URL（无 query）
  watch(
    () => currentPage.value,
    (p) => {
      if (options.syncPageToUrl === false) return;
      if (!isOnTargetRoute.value) return;
      const next = Math.max(1, Math.floor(p || 1));
      const cur = getRoutePage();
      if (cur === next) return;
      void replaceRouteForPage(next);
    }
  );

  const currentOffset = computed(
    () => (currentPage.value - 1) * bigPageSize.value
  );

  const jumpToPage = async (page: number) => {
    const safe = Math.max(1, Math.floor(page || 1));
    await replaceRouteForPage(safe);
  };

  return {
    BIG_PAGE_SIZE: bigPageSize,
    currentPage,
    currentOffset,
    jumpToPage,
    replaceRouteForPage,
  };
}
