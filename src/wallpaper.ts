import { createApp } from "vue";
import WallpaperLayer from "./components/WallpaperLayer.vue";

// 创建独立的 Vue 应用，只渲染 WallpaperLayer 组件
const app = createApp(WallpaperLayer);

app.mount("#app");
