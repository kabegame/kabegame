import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";

const lastGalleryRoute = ref("/gallery/全部");

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
        lastGalleryRoute.value = route.fullPath || route.path;
      }
    },
    { immediate: true },
  );

  // 根据当前路由路径计算应该高亮的菜单项
  // 需要匹配基础路径，忽略分页等参数
  const activeRoute = computed(() => {
    const path = route.path;

    // 画廊：匹配 /gallery 开头的所有路径（包括分页）
    if (path.startsWith("/gallery")) {
      return lastGalleryRoute.value || "/gallery/全部";
    }

    // 画册：匹配 /albums 开头的所有路径（包括详情和分页）
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

    // 设置：精确匹配
    if (path === "/settings") {
      return "/settings";
    }

    // 帮助：匹配 /help 开头的所有路径（包括 /help/tips/:tipId）
    if (path.startsWith("/help")) {
      return "/help";
    }

    // 默认返回当前路径（用于其他未匹配的路由）
    return path;
  });

  return {
    activeRoute,
    galleryMenuRoute: computed(() => lastGalleryRoute.value || "/gallery/全部"),
  };
}
