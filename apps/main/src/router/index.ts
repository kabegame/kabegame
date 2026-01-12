import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { invoke } from "@tauri-apps/api/core";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: "/gallery/全部",
  },
  {
    path: "/gallery",
    redirect: "/gallery/全部",
  },
  {
    // 纯 path 驱动：providerPath 为可重复参数（可包含多个路径段）
    path: "/gallery/:providerPath(.*)*/page/:page(\\d+)",
    name: "GalleryPaged",
    component: () => import("@/views/Gallery.vue"),
    meta: { title: "画廊" },
  },
  {
    path: "/gallery/:providerPath(.*)*",
    name: "Gallery",
    component: () => import("@/views/Gallery.vue"),
    meta: { title: "画廊" },
  },
  {
    path: "/plugin-browser",
    name: "PluginBrowser",
    component: () => import("@/views/PluginBrowser.vue"),
    meta: { title: "源" },
  },
  {
    path: "/albums",
    name: "Albums",
    component: () => import("@/views/Albums.vue"),
    meta: { title: "画册" },
  },
  {
    path: "/albums/:id",
    name: "AlbumDetail",
    component: () => import("@/views/AlbumDetail.vue"),
    meta: { title: "画册" },
  },
  {
    path: "/albums/:id/page/:page(\\d+)",
    name: "AlbumDetailPaged",
    component: () => import("@/views/AlbumDetail.vue"),
    meta: { title: "画册" },
  },
  {
    path: "/tasks/:id",
    name: "TaskDetail",
    component: () => import("@/views/TaskDetail.vue"),
    meta: { title: "任务详情" },
  },
  {
    path: "/tasks/:id/page/:page(\\d+)",
    name: "TaskDetailPaged",
    component: () => import("@/views/TaskDetail.vue"),
    meta: { title: "任务详情" },
  },
  {
    path: "/plugin-detail/:id",
    name: "PluginDetail",
    component: () => import("@/views/PluginDetail.vue"),
    meta: { title: "源详情" },
  },
  {
    path: "/settings",
    name: "Settings",
    component: () => import("@/views/Settings.vue"),
    meta: { title: "设置" },
  },
  {
    path: "/plugins",
    redirect: "/plugin-browser",
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 保存当前路径的函数
const saveCurrentPath = async (path: string) => {
  try {
    const settings = await invoke<{ restoreLastTab: boolean }>("get_settings");
    if (settings.restoreLastTab) {
      // 保存所有路由路径（包括带参数的）
      await invoke("set_last_tab_path", { path });
    }
  } catch (error) {
    console.error("保存路径失败:", error);
  }
};

router.beforeEach((to, _from, next) => {
  document.title = `${to.meta.title || "Kabegame"} - 老婆收集器`;
  next();
});

// 保存当前路径（如果启用了恢复功能）
// 注意：不要阻塞导航（任务多时后端 invoke 可能较慢），因此放到 afterEach 并 fire-and-forget
router.afterEach((to, from) => {
  // 注意：必须使用 fullPath，否则 query（例如 Gallery 的 provider 路径/页码）不会被保存/恢复
  if (from.fullPath !== to.fullPath) {
    void saveCurrentPath(to.fullPath);
  }
});

// 应用启动时恢复上次的路径
router.isReady().then(async () => {
  try {
    const settings = await invoke<{
      restoreLastTab: boolean;
      lastTabPath: string | null;
    }>("get_settings");
    if (settings.restoreLastTab && settings.lastTabPath) {
      // 尝试导航到保存的路径
      await router.push(settings.lastTabPath).catch(() => {
        // 如果路由不存在或导航失败，回退到画廊
        return router.push("/gallery/全部");
      });
    }
  } catch (error) {
    console.error("恢复路径失败:", error);
    // 出错时回退到画廊
    router.push("/gallery/全部").catch(() => {});
  }
});

export default router;
