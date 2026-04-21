import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "@kabegame/core/env";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: { path: "/gallery" },
  },
  {
    path: "/gallery",
    name: "Gallery",
    component: () => import("@/views/Gallery.vue"),
    meta: { title: "route.gallery" },
  },
  {
    path: "/plugin-browser",
    name: "PluginBrowser",
    component: () => import("@/views/PluginBrowser.vue"),
    meta: { title: "route.pluginBrowser" },
  },
  {
    path: "/albums",
    name: "Albums",
    component: () => import("@/views/Albums.vue"),
    meta: { title: "route.albums" },
  },
  {
    path: "/albums/:id",
    name: "AlbumDetail",
    component: () => import("@/views/AlbumDetail.vue"),
    meta: { title: "route.albumDetail" },
  },
  {
    path: "/tasks/:id",
    name: "TaskDetail",
    component: () => import("@/views/TaskDetail.vue"),
    meta: { title: "route.taskDetail" },
  },
  {
    path: "/failed-images",
    name: "FailedImages",
    component: () => import("@/views/FailedImages.vue"),
    meta: { title: "route.failedImages" },
  },
  {
    path: "/plugin-detail/:id",
    name: "PluginDetail",
    component: () => import("@/views/PluginDetail.vue"),
    meta: { title: "route.pluginDetail" },
  },
  {
    path: "/settings",
    name: "Settings",
    component: () => import("@/views/Settings.vue"),
    meta: { title: "route.settings" },
  },
  {
    path: "/help",
    name: "Help",
    component: () => import("@/views/Help.vue"),
    meta: { title: "route.help" },
  },
  {
    path: "/help/tips/:tipId",
    name: "HelpTip",
    component: () => import("@/views/Help.vue"),
    meta: { title: "route.help" },
  },
  {
    path: "/surf",
    name: "Surf",
    component: () => import("@/views/Surf.vue"),
    meta: { title: "route.surf" },
  },
  {
    path: "/surf/:host/images",
    name: "SurfImages",
    component: () => import("@/views/SurfImages.vue"),
    meta: { title: "route.surfImages" },
  },
  {
    path: "/auto-configs",
    name: "AutoConfigs",
    component: () => import("@/views/AutoConfigs.vue"),
    meta: { title: "route.autoConfigs" },
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

router.beforeEach((to, from, next) => {
  const titleKey = to.meta.title as string | undefined;
  if (titleKey && typeof titleKey === "string") {
    document.title = i18n.global.t(titleKey) as string;
  }

  // Why: <router-link to="/other"> 默认不带 query 会丢 super；仅跨路径透传，
  // 同路径（SuperModeToggle 的 setSuper 关闭、页内 query 更新）不干预，允许显式关闭。
  if (IS_WEB && from.path !== to.path && from.query.super === "1" && to.query.super !== "1") {
    return next({ ...to, query: { ...to.query, super: "1" } });
  }

  next();
});

export default router;
