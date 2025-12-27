<template>
  <el-menu
    :default-active="activeRoute"
    mode="horizontal"
    router
    class="nav-menu"
  >
    <el-menu-item index="/crawler">
      <el-icon><Link /></el-icon>
      <span>爬虫管理</span>
    </el-menu-item>
    <el-menu-item index="/plugins">
      <el-icon><Setting /></el-icon>
      <span>插件配置</span>
    </el-menu-item>
    <el-menu-item index="/gallery">
      <el-icon><Picture /></el-icon>
      <span>图片视图</span>
    </el-menu-item>
  </el-menu>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { Link, Setting, Picture } from "@element-plus/icons-vue";

const route = useRoute();
const activeRoute = computed(() => route.path);
</script>

<style scoped lang="scss">
.nav-menu {
  border-bottom: 1px solid var(--el-border-color);
}
</style>

