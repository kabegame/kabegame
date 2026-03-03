import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import Gallery from "@/views/Gallery.vue";
import PluginBrowser from "@/views/PluginBrowser.vue";
import Albums from "@/views/Albums.vue";
import AlbumDetail from "@/views/AlbumDetail.vue";
import TaskDetail from "@/views/TaskDetail.vue";
import PluginDetail from "@/views/PluginDetail.vue";
import Settings from "@/views/Settings.vue";
import Help from "@/views/Help.vue";

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
    component: Gallery,
    meta: { title: "画廊" },
  },
  {
    path: "/gallery/:providerPath(.*)*",
    name: "Gallery",
    component: Gallery,
    meta: { title: "画廊" },
  },
  {
    path: "/plugin-browser",
    name: "PluginBrowser",
    component: PluginBrowser,
    meta: { title: "源" },
  },
  {
    path: "/albums",
    name: "Albums",
    component: Albums,
    meta: { title: "画册" },
  },
  {
    path: "/albums/:id",
    name: "AlbumDetail",
    component: AlbumDetail,
    meta: { title: "画册" },
  },
  {
    path: "/albums/:id/page/:page(\\d+)",
    name: "AlbumDetailPaged",
    component: AlbumDetail,
    meta: { title: "画册" },
  },
  {
    path: "/tasks/:id",
    name: "TaskDetail",
    component: TaskDetail,
    meta: { title: "任务详情" },
  },
  {
    path: "/tasks/:id/page/:page(\\d+)",
    name: "TaskDetailPaged",
    component: TaskDetail,
    meta: { title: "任务详情" },
  },
  {
    path: "/plugin-detail/:id",
    name: "PluginDetail",
    component: PluginDetail,
    meta: { title: "源详情" },
  },
  {
    path: "/settings",
    name: "Settings",
    component: Settings,
    meta: { title: "设置" },
  },
  {
    path: "/help",
    name: "Help",
    component: Help,
    meta: { title: "帮助" },
  },
  {
    path: "/help/tips/:tipId",
    name: "HelpTip",
    component: Help,
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

router.beforeEach((to, from, next) => {
  console.log("beforeEach", to, from);
  next();
});

export default router;
