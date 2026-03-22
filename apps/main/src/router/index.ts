import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { i18n } from "@kabegame/i18n";
import Gallery from "@/views/Gallery.vue";
import PluginBrowser from "@/views/PluginBrowser.vue";
import Albums from "@/views/Albums.vue";
import AlbumDetail from "@/views/AlbumDetail.vue";
import TaskDetail from "@/views/TaskDetail.vue";
import PluginDetail from "@/views/PluginDetail.vue";
import Settings from "@/views/Settings.vue";
import Help from "@/views/Help.vue";
import Surf from "@/views/Surf.vue";
import SurfImages from "@/views/SurfImages.vue";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: { path: "/gallery" },
  },
  {
    path: "/gallery",
    name: "Gallery",
    component: Gallery,
    meta: { title: "route.gallery" },
  },
  {
    path: "/plugin-browser",
    name: "PluginBrowser",
    component: PluginBrowser,
    meta: { title: "route.pluginBrowser" },
  },
  {
    path: "/albums",
    name: "Albums",
    component: Albums,
    meta: { title: "route.albums" },
  },
  {
    path: "/albums/:id",
    name: "AlbumDetail",
    component: AlbumDetail,
    meta: { title: "route.albumDetail" },
  },
  {
    path: "/tasks/:id",
    name: "TaskDetail",
    component: TaskDetail,
    meta: { title: "route.taskDetail" },
  },
  {
    path: "/plugin-detail/:id",
    name: "PluginDetail",
    component: PluginDetail,
    meta: { title: "route.pluginDetail" },
  },
  {
    path: "/settings",
    name: "Settings",
    component: Settings,
    meta: { title: "route.settings" },
  },
  {
    path: "/help",
    name: "Help",
    component: Help,
    meta: { title: "route.help" },
  },
  {
    path: "/help/tips/:tipId",
    name: "HelpTip",
    component: Help,
    meta: { title: "route.help" },
  },
  {
    path: "/surf",
    name: "Surf",
    component: Surf,
    meta: { title: "route.surf" },
  },
  {
    path: "/surf/:id/images",
    name: "SurfImages",
    component: SurfImages,
    meta: { title: "route.surfImages" },
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
  next();
});

export default router;
