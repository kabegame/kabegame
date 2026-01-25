import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

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
    path: "/help",
    name: "Help",
    component: () => import("@/views/Help.vue"),
    meta: { title: "帮助" },
  },
  {
    path: "/help/tips/:tipId",
    name: "HelpTip",
    component: () => import("@/views/Help.vue"),
    meta: { title: "帮助" },
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

export default router;
