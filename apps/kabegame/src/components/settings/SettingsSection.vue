<template>
  <section class="settings-section">
    <!-- 分区标题：中性正文色的小标题（不再用强调色） -->
    <h2 class="m-0 mb-2 p-0 text-[15px] font-600 leading-6 text-kb-fg">
      {{ title }}
    </h2>
    <div>
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    /** @deprecated 分组不再使用卡片背景，保留仅为兼容旧调用点 */
    transparent?: boolean;
  }>(),
  {
    transparent: false,
  },
);
</script>

<style scoped>
.settings-section + .settings-section {
  margin-top: 24px;
}
</style>
