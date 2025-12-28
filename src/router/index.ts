import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

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

router.beforeEach((to, _from, next) => {
  document.title = `${to.meta.title || "Kabegami"} - 老婆收集器`;
  next();
});

export default router;
