import { computed, ref, unref, type Ref, type ComputedRef } from "vue";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";

/**
 * 从路径中提取根路径（去掉末尾的页码数字）
 * 例如：`all/1` → `all`，`plugin/konachan/5` → `plugin/konachan`
 */
function extractRootPath(path: string): string {
  if (!path) return "all";
  const segs = path.split("/").filter(Boolean);
  // 去掉末尾的页码数字段（纯数字）
  let i = segs.length - 1;
  while (i >= 0) {
    const seg = segs[i];
    if (/^\d+$/.test(seg)) {
      i--;
    } else {
      break;
    }
  }
  return segs.slice(0, i + 1).join("/") || "all";
}

/**
 * 从路径中提取页码（末尾数字段）
 */
function extractPageFromPath(path: string): number {
  if (!path) return 1;
  const segs = path.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const page = parseInt(seg, 10);
    if (!isNaN(page) && page > 0) {
      return page;
    }
  }
  return 1;
}

type UseProviderPathRouteOptions = {
  route: RouteLocationNormalizedLoaded;
  router: Router;
  defaultPath?: Ref<string> | ComputedRef<string> | string;
};

/**
 * Provider 路径路由 composable：管理基于 query.path 的路由状态
 */
export function useProviderPathRoute(options: UseProviderPathRouteOptions) {
  const currentPath = computed(() => {
    const queryPath = options.route.query.path as string;
    if (queryPath) return queryPath;
    const def = unref(options.defaultPath);
    return def || "all/1";
  });

  const providerRootPath = computed(() => {
    return extractRootPath(currentPath.value);
  });

  const currentPage = computed(() => {
    return extractPageFromPath(currentPath.value);
  });

  /**
   * 设置根路径和页码
   */
  async function setRootAndPage(rootPath: string, page: number = 1) {
    const path = `${rootPath}/${Math.max(1, page)}`;
    await options.router.replace({
      path: options.route.path,
      query: { path },
    });
  }

  /**
   * 导航到指定页码
   */
  async function navigateToPage(page: number) {
    await setRootAndPage(providerRootPath.value, page);
  }

  /**
   * 设置 provider 路径（直接替换 query.path）
   */
  async function setProviderPath(path: string) {
    await options.router.replace({
      path: options.route.path,
      query: { path: path || "all/1" },
    });
  }

  return {
    currentPath,
    providerRootPath,
    currentPage,
    setRootAndPage,
    navigateToPage,
    setProviderPath,
  };
}
