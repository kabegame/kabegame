<template>
  <el-button circle @click="handleClick" :title="label">
    <el-icon>
      <component :is="icon" />
    </el-icon>
  </el-button>
</template>

<script setup lang="ts">
import { ElButton, ElIcon } from "element-plus";
import type { Component } from "vue";

const props = defineProps<{
  icon: Component;
  label: string;
  type?: string;
}>();

const emit = defineEmits<{
  action: [data: { type: string; [key: string]: any }];
}>();

const handleClick = () => {
  emit("action", { type: "click" });
};
</script>

<style scoped lang="scss">
.el-button {
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}
</style>