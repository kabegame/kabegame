<template>
  <el-tabs v-model="model" class="styled-tabs" :class="{ 'sticky': sticky }">
    <slot />
  </el-tabs>
</template>

<script setup lang="ts">
const model = defineModel<string>({ required: true });

withDefaults(defineProps<{
  sticky?: boolean;
}>(), {
  sticky: false,
});
</script>

<style scoped lang="scss">
.styled-tabs {
  margin-top: 20px;

  &.sticky {
    position: sticky;
    top: 64px;
    z-index: 99;
    background: var(--anime-bg);
    padding-top: 10px;
    margin-top: -10px;
  }

  :deep(.el-tabs__header) {
    margin-bottom: 20px;
  }

  :deep(.el-tabs__content) {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;

    &::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
  }

  :deep(.el-tab-pane) {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;

    &::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
  }

  :deep(.el-tabs__wrap) {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;

    &::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
  }

  :deep(.el-tabs__item) {
    color: var(--anime-text-muted);
    font-weight: 500;
    transition: all 0.3s ease;

    &:hover {
      color: var(--anime-primary);
    }

    &.is-active {
      color: var(--anime-primary);
      font-weight: 600;
    }
  }

  :deep(.el-tabs__active-bar) {
    background: linear-gradient(90deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
    height: 3px;
    border-radius: 2px;
  }
}
</style>

