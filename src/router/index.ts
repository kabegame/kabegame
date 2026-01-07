import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { invoke } from "@tauri-apps/api/core";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: "/gallery",
  },
  {
    path: "/gallery",
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
    path: "/tasks/:id",
    name: "TaskDetail",
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
  if (from.path !== to.path) {
    void saveCurrentPath(to.path);
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
        return router.push("/gallery");
      });
    }
  } catch (error) {
    console.error("恢复路径失败:", error);
    // 出错时回退到画廊
    router.push("/gallery").catch(() => {});
  }
});

export default router;
