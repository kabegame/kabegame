import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";

const lastGalleryRoute = ref("/gallery");

/**
 * 路由高亮 composable
 * 根据当前路由路径计算应该高亮的菜单项
 */
export function useActiveRoute() {
  const route = useRoute();

  watch(
    () => route.fullPath,
    () => {
      if (route.path.startsWith("/gallery")) {
        const queryPath = route.query?.path as string | undefined;
        // task/* 路径为任务页专用，Gallery Tab 应指向主画廊而非任务视图
        if (queryPath?.startsWith("task/")) {
          lastGalleryRoute.value = route.path;
        } else {
          lastGalleryRoute.value = route.fullPath || route.path;
        }
      }
    },
    { immediate: true },
  );

  // 根据当前路由路径计算应该高亮的菜单项
  // 需要匹配基础路径，忽略 query 参数
  const activeRoute = computed(() => {
    const path = route.path;

    // 画廊：匹配 /gallery 开头的所有路径（包括 query 参数）
    if (path.startsWith("/gallery")) {
      return lastGalleryRoute.value || "/gallery";
    }

    // 画册：匹配 /albums 开头的所有路径（包括详情和 query 参数）
    if (path.startsWith("/albums")) {
      return "/albums";
    }

    // 收集源：匹配 /plugin-browser 和 /plugin-detail 开头的路径
    if (
      path.startsWith("/plugin-browser") ||
      path.startsWith("/plugin-detail")
    ) {
      return "/plugin-browser";
    }

    // 设置不是导航目的地：桌面端是弹窗，紧凑端的 /settings 路由页也不对应任何 tab，
    // 交给下面的兜底分支即可（返回自身，不会命中任何菜单项）。

    if (path.startsWith("/surf")) {
      return "/surf";
    }

    // 默认返回当前路径（用于其他未匹配的路由）
    return path;
  });

  return {
    activeRoute,
    galleryMenuRoute: computed(() => lastGalleryRoute.value || "/gallery"),
  };
}
